import type { MaybePromise } from "../async";
import { Singleton, SingletonRegistry } from "./Singleton";
import { TimeSystem } from "./TimeSystem";
import { CoreLogger } from "../logging/Logger";

export type TimerId = number;
export type TimerCallback = () => MaybePromise<void>;

interface TimerEntry {
  id: TimerId;
  dueTime: number;
  intervalMs: number;
  callback: TimerCallback;
}

export class TimerSystem extends Singleton {
  private readonly timers = new Map<TimerId, TimerEntry>();
  private readonly heap: TimerEntry[] = [];
  private nextTimerId = 1;

  static get Instance(): TimerSystem {
    return SingletonRegistry.Get(TimerSystem);
  }

  /** Adds a one-shot game-time timer; zero delay means the next timer update, not reentrant execution. */
  NewOnceTimer(delayMs: number, callback: TimerCallback): TimerId {
    return this.add(delayMs, 0, callback);
  }

  /** Adds a fixed-interval game timer and skips missed repetitions instead of producing a callback storm. */
  NewRepeatedTimer(intervalMs: number, callback: TimerCallback): TimerId {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error(`timer interval must be greater than 0: ${intervalMs}`);
    }
    return this.add(intervalMs, intervalMs, callback);
  }

  /** Cancels a timer lazily; stale heap entries are ignored when they reach the root. */
  Remove(timerId: TimerId): boolean {
    return this.timers.delete(timerId);
  }

  /** Returns a Promise completed by game time; do not use it for wall-clock I/O deadlines. */
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

  private add(delayMs: number, intervalMs: number, callback: TimerCallback): TimerId {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new Error(`timer delay must not be negative: ${delayMs}`);
    }
    if (typeof callback !== "function") throw new Error("timer callback must be a function");

    const timer: TimerEntry = {
      id: this.allocateTimerId(),
      dueTime: TimeSystem.Instance.FrameTime + delayMs,
      intervalMs,
      callback,
    };
    this.timers.set(timer.id, timer);
    this.push(timer);
    return timer.id;
  }

  private allocateTimerId(): TimerId {
    for (let attempts = 0; attempts < 0xffff_ffff; attempts += 1) {
      const id = this.nextTimerId;
      this.nextTimerId = (this.nextTimerId % 0xffff_ffff) + 1;
      if (!this.timers.has(id)) return id;
    }
    throw new Error("timer id space is exhausted");
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
