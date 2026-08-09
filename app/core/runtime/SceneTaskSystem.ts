import { isPromiseLike, type MaybePromise } from "../async";
import type { Scene } from "./entities";
import {
  TimerSystem,
  type TimerId,
} from "./TimerSystem";

const MAX_SCENE_TASK_IN_FLIGHT = 256;
const SCENE_TASK_WARNING_MS = 10_000;

export type SpawnTaskId = number & { readonly __spawnTaskId: unique symbol };

/** TiangZ自带的轻量协作取消令牌，不依赖浏览器AbortController。 / Lightweight cooperative cancellation token independent of browser AbortController. */
export interface SceneTaskSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
}

export interface SpawnTaskContext {
  readonly id: SpawnTaskId;
  readonly signal: SceneTaskSignal;
}

export type SpawnTaskBody = (context: SpawnTaskContext) => MaybePromise<void>;

interface SpawnTaskRecord {
  readonly id: SpawnTaskId;
  readonly name: string;
  readonly signal: {
    aborted: boolean;
    reason: unknown;
  };
  readonly startedAt: number;
  warned: boolean;
}

/**
 * 管理一个Scene明确放弃等待结果的短异步任务。
 * 任务会进入Hotfix排空统计、统一记录失败，并在Scene销毁时收到轻量取消令牌；
 * JavaScript不能强制终止Promise，因此任务仍必须主动响应取消信号。
 *
 * Owns short asynchronous Scene tasks whose callers intentionally do not await
 * their result. Tasks participate in the Hotfix drain barrier, report failures,
 * and receive a lightweight cancellation token on Scene disposal. JavaScript cannot forcibly stop
 * a Promise, so task bodies must cooperate with cancellation.
 */
export class SceneTaskScope {
  private readonly tasks = new Map<SpawnTaskId, SpawnTaskRecord>();
  private nextId = 1;
  private maxInFlightCount = 0;
  private watchdogTimer: TimerId | undefined;
  private disposed = false;

  constructor(private readonly scene: Scene) {}

  get InFlightCount(): number {
    return this.tasks.size;
  }

  get MaxInFlightCount(): number {
    return this.maxInFlightCount;
  }

  /**
   * 启动一个不返回Promise给调用方的短后台任务。
   * 工厂在当前调用栈结束后的微任务中执行，所有异常由框架记录；不得用于否决检查、
   * 玩家有序状态修改、事务提交、精确调度或永久循环。
   *
   * Starts a short background task without returning its Promise to the caller.
   * The factory runs in a microtask and all failures are logged by the framework.
   * Do not use it for veto checks, ordered player mutations, transactions,
   * precise scheduling, or permanent loops.
   */
  Spawn(name: string, body: SpawnTaskBody): SpawnTaskId {
    this.requireAlive();
    const taskName = name.trim();
    if (!taskName) throw new Error("spawn task name must not be empty");
    if (typeof body !== "function") throw new Error("spawn task body must be a function");
    if (this.tasks.size >= MAX_SCENE_TASK_IN_FLIGHT) {
      throw new Error(
        `scene task capacity exceeded: ${String(this.scene.Id)} limit=${MAX_SCENE_TASK_IN_FLIGHT}`,
      );
    }

    const id = this.allocateId();
    const record: SpawnTaskRecord = {
      id,
      name: taskName,
      signal: { aborted: false, reason: undefined },
      startedAt: Date.now(),
      warned: false,
    };
    this.tasks.set(id, record);
    this.maxInFlightCount = Math.max(this.maxInFlightCount, this.tasks.size);
    this.scheduleWatchdog();

    void Promise.resolve()
      .then(() => {
        if (record.signal.aborted) return;
        const result = body({ id, signal: record.signal });
        return isPromiseLike(result) ? result : undefined;
      })
      .catch((error) => {
        this.scene.logger.error("spawned scene task failed", {
          taskId: id,
          taskName,
          cancelled: record.signal.aborted,
          cancelReason: record.signal.reason,
          error,
        });
      })
      .finally(() => {
        this.tasks.delete(id);
        if (this.tasks.size === 0 && this.watchdogTimer !== undefined) {
          TimerSystem.Instance.Cancel(this.watchdogTimer, "task-scope-idle", false);
          this.watchdogTimer = undefined;
        }
      });
    return id;
  }

  /** 请求任务协作取消；返回false表示任务已经结束或ID不属于该Scene。 / Requests cooperative cancellation and returns false when the task has finished or belongs elsewhere. */
  Cancel(id: SpawnTaskId, reason: unknown = "manual"): boolean {
    const record = this.tasks.get(id);
    if (!record || record.signal.aborted) return false;
    record.signal.aborted = true;
    record.signal.reason = reason;
    return true;
  }

  /** 仅供Scene生命周期释放所有任务；取消后仍跟踪Promise直到真正结束。 / Scene-lifecycle hook that aborts every task while retaining each Promise until it actually settles. */
  Dispose(reason: unknown = "scene-disposed"): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const record of this.tasks.values()) {
      if (!record.signal.aborted) {
        record.signal.aborted = true;
        record.signal.reason = reason;
      }
    }
  }

  private allocateId(): SpawnTaskId {
    for (let attempts = 0; attempts <= this.tasks.size; attempts += 1) {
      const value = this.nextId;
      this.nextId = this.nextId >= Number.MAX_SAFE_INTEGER ? 1 : this.nextId + 1;
      const id = value as SpawnTaskId;
      if (!this.tasks.has(id)) return id;
    }
    throw new Error("spawn task id space exhausted");
  }

  private scheduleWatchdog(): void {
    if (this.watchdogTimer !== undefined) return;
    const now = Date.now();
    let delayMs = Number.POSITIVE_INFINITY;
    for (const record of this.tasks.values()) {
      if (record.warned) continue;
      delayMs = Math.min(
        delayMs,
        Math.max(1, record.startedAt + SCENE_TASK_WARNING_MS - now),
      );
    }
    if (!Number.isFinite(delayMs)) return;
    this.watchdogTimer = TimerSystem.Instance.NewOnceTimer(delayMs, () => {
      this.watchdogTimer = undefined;
      const checkedAt = Date.now();
      for (const record of this.tasks.values()) {
        if (record.warned || checkedAt - record.startedAt < SCENE_TASK_WARNING_MS) continue;
        record.warned = true;
        this.scene.logger.warn("scene task exceeded short-task budget", {
          taskId: record.id,
          taskName: record.name,
          elapsedMs: Math.max(0, checkedAt - record.startedAt),
          cancelled: record.signal.aborted,
          cancelReason: record.signal.reason,
        });
      }
      this.scheduleWatchdog();
    });
  }

  private requireAlive(): void {
    if (this.disposed || this.scene.IsDisposed) {
      throw new Error(`cannot spawn task from disposed Scene: ${String(this.scene.Id)}`);
    }
  }
}
