import type { MaybePromise } from "../async";
import { Singleton, SingletonRegistry } from "./Singleton";
import { TimeSystem } from "./TimeSystem";
import { CoreLogger } from "../logging/Logger";
import {
  InstanceIdSystem,
  type TimerId,
} from "./IdSystem";

export type TimerCallback = () => MaybePromise<void>;
export type { TimerId } from "./IdSystem";

export type TimerCancelReason =
  | "manual"
  | "replaced"
  | "owner-disposed"
  | "process-stopped"
  | (string & {});

export interface TimerCancelledContext {
  readonly timerId: TimerId;
  readonly reason: TimerCancelReason;
  readonly cancelledAt: number;
}

export interface TimerOptions {
  readonly onCancelled?: (context: TimerCancelledContext) => MaybePromise<void>;
}

interface TimerEntry {
  id: TimerId;
  dueTime: number;
  intervalMs: number;
  callback: TimerCallback;
  onCancelled?: (context: TimerCancelledContext) => MaybePromise<void>;
}

export class TimerSystem extends Singleton {
  private readonly timers = new Map<TimerId, TimerEntry>();
  private readonly heap: TimerEntry[] = [];

  static get Instance(): TimerSystem {
    return SingletonRegistry.Get(TimerSystem);
  }

  /**
   * 返回当前服务器Unix毫秒时间；适合协议时间戳、活动截止时间和日志，不用于驱动游戏Tick。
   * Returns the current server Unix time in milliseconds for protocol timestamps,
   * persisted deadlines, and logs; do not use it to drive game ticks.
   */
  static ServerTime(): number {
    return TimeSystem.Instance.ServerNow;
  }

  /** 添加一次性游戏时间定时器；零延迟表示下一次定时器 Update，不会重入执行。 / Adds a one-shot game-time timer; zero delay means the next timer update, not reentrant execution. */
  NewOnceTimer(
    delayMs: number,
    callback: TimerCallback,
    options: TimerOptions = {},
  ): TimerId {
    return this.add(delayMs, 0, callback, options);
  }

  /** 添加固定间隔游戏定时器；跳过错过的重复次数，避免回调风暴。 / Adds a fixed-interval game timer and skips missed repetitions instead of producing a callback storm. */
  NewRepeatedTimer(
    intervalMs: number,
    callback: TimerCallback,
    options: TimerOptions = {},
  ): TimerId {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error(`timer interval must be greater than 0: ${intervalMs}`);
    }
    return this.add(intervalMs, intervalMs, callback, options);
  }

  /**
   * 立即把活动Timer标记为取消，并至多投递一次取消通知。
   * 对Actor所有者而言，通知仍需经过其mailbox；立即指状态切换不等待原到期时间。
   *
   * Immediately marks an active timer as cancelled and emits at most one
   * cancellation notification. Actor-owned notifications still enter the
   * mailbox; immediate refers to state transition rather than bypassing order.
   */
  Cancel(
    timerId: TimerId,
    reason: TimerCancelReason = "manual",
    notify = true,
  ): boolean {
    const timer = this.timers.get(timerId);
    if (!timer) return false;
    this.timers.delete(timerId);
    if (notify && timer.onCancelled) {
      this.invokeCancellation(timer, reason);
    }
    return true;
  }

  /** 返回按游戏时间完成的 Promise；不可用于墙钟 I/O 超时。 / Returns a Promise completed by game time; do not use it for wall-clock I/O deadlines. */
  WaitAsync(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.NewOnceTimer(delayMs, resolve);
    });
  }

  get Count(): number {
    return this.timers.size;
  }

  __update(now: number): void {
    while (this.heap.length > 0) {
      const timer = this.heap[0];
      if (timer.dueTime > now) break;
      this.pop();
      if (this.timers.get(timer.id) !== timer) continue;

      if (timer.intervalMs === 0) {
        this.timers.delete(timer.id);
      }
      this.invoke(timer);

      if (timer.intervalMs > 0 && this.timers.get(timer.id) === timer) {
        const missed = Math.floor(Math.max(0, now - timer.dueTime) / timer.intervalMs);
        timer.dueTime += (missed + 1) * timer.intervalMs;
        this.push(timer);
      }
    }
  }

  protected override OnDestroy(): void {
    this.timers.clear();
    this.heap.length = 0;
  }

  private add(
    delayMs: number,
    intervalMs: number,
    callback: TimerCallback,
    options: TimerOptions,
  ): TimerId {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new Error(`timer delay must not be negative: ${delayMs}`);
    }
    if (typeof callback !== "function") throw new Error("timer callback must be a function");

    const timer: TimerEntry = {
      id: InstanceIdSystem.Instance.NextTimerId(),
      dueTime: TimeSystem.Instance.FrameTime + delayMs,
      intervalMs,
      callback,
      onCancelled: options.onCancelled,
    };
    this.timers.set(timer.id, timer);
    this.push(timer);
    return timer.id;
  }

  private invoke(timer: TimerEntry): void {
    try {
      const result = timer.callback();
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch((error) => {
          CoreLogger.error("async timer failed", { timerId: timer.id, error });
        });
      }
    } catch (error) {
      CoreLogger.error("timer failed", { timerId: timer.id, error });
    }
  }

  private invokeCancellation(timer: TimerEntry, reason: TimerCancelReason): void {
    try {
      const result = timer.onCancelled?.({
        timerId: timer.id,
        reason,
        cancelledAt: TimeSystem.Instance.FrameTime,
      });
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch((error) => {
          CoreLogger.error("async timer cancellation failed", {
            timerId: timer.id,
            reason,
            error,
          });
        });
      }
    } catch (error) {
      CoreLogger.error("timer cancellation failed", {
        timerId: timer.id,
        reason,
        error,
      });
    }
  }

  private push(timer: TimerEntry): void {
    let index = this.heap.length;
    this.heap.push(timer);
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (this.heap[parent].dueTime <= timer.dueTime) break;
      this.heap[index] = this.heap[parent];
      index = parent;
    }
    this.heap[index] = timer;
  }

  private pop(): TimerEntry | undefined {
    const first = this.heap[0];
    const last = this.heap.pop();
    if (!first || !last || this.heap.length === 0) return first;

    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.heap.length) break;
      const right = left + 1;
      const child = right < this.heap.length && this.heap[right].dueTime < this.heap[left].dueTime
        ? right
        : left;
      if (this.heap[child].dueTime >= last.dueTime) break;
      this.heap[index] = this.heap[child];
      index = child;
    }
    this.heap[index] = last;
    return first;
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}
