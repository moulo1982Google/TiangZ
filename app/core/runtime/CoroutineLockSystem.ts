import type { MaybePromise } from "../async";
import { Singleton, SingletonRegistry } from "./Singleton";
import { TimerSystem, type TimerId } from "./TimerSystem";
import type { InstanceId } from "./IdSystem";
import type { Scene } from "./entities";

export type CoroutineLockDomain = string;
export type CoroutineLockKey = string | number | bigint;

export interface CoroutineLockOptions {
  /** 等待超时；0表示不启用超时，不建议用于外部请求链路。 / Wait timeout; zero disables it and is discouraged on external request paths. */
  readonly timeoutMs?: number;
  /** 调用方取消等待；已经持锁后不会强行中断业务回调。 / Cancels acquisition; it never forcibly interrupts a callback that already owns the lock. */
  readonly signal?: AbortSignal;
  /** 单个键允许的最大等待者数量。 / Maximum queued waiters for one key. */
  readonly maxQueueLength?: number;
}

interface Waiter {
  active: boolean;
  timerId?: TimerId;
  signal?: AbortSignal;
  abortListener?: () => void;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

interface LockQueue {
  locked: boolean;
  readonly waiters: Waiter[];
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_QUEUE_LENGTH = 1_024;

/**
 * Process内协程锁实现；公开API由SceneLockScope自动补充Scene身份。
 * 它只解决单V8内的防重入，不是分布式锁。跨Process业务必须先路由到唯一
 * Scene/Actor所有者，再在所有者内部使用本锁。
 *
 * Process-local coroutine lock implementation. SceneLockScope supplies the
 * Scene identity. This prevents re-entry inside one V8 and is not a distributed
 * lock; cross-Process work must first route to its unique Scene/Actor owner.
 */
export class CoroutineLockSystem extends Singleton {
  private readonly queues = new Map<InstanceId, Map<CoroutineLockDomain, Map<CoroutineLockKey, LockQueue>>>();
  private waitingCount = 0;
  private timeoutCount = 0;

  static get Instance(): CoroutineLockSystem {
    return SingletonRegistry.Get(CoroutineLockSystem);
  }

  /** 在指定Scene、领域和键下串行执行回调；异常与Promise拒绝都会自动释放锁。 / Runs a callback exclusively for one Scene/domain/key and always releases after errors or rejected Promises. */
  async RunExclusive<T>(
    sceneInstanceId: InstanceId,
    domain: CoroutineLockDomain,
    key: CoroutineLockKey,
    callback: () => MaybePromise<T>,
    options: CoroutineLockOptions = {},
  ): Promise<T> {
    requireLockIdentity(sceneInstanceId, domain, key);
    if (typeof callback !== "function") throw new Error("coroutine lock callback is required");
    const queue = this.getOrCreateQueue(sceneInstanceId, domain, key);
    await this.acquire(queue, sceneInstanceId, domain, key, options);
    try {
      return await callback();
    } finally {
      this.release(queue, sceneInstanceId, domain, key);
    }
  }

  /** Scene销毁时拒绝尚未取得锁的等待者；正在执行的回调由其正常finally释放。 / Rejects pending acquisitions when a Scene is destroyed; an active callback still releases through its own finally. */
  CancelScene(sceneInstanceId: InstanceId): void {
    const domains = this.queues.get(sceneInstanceId);
    if (!domains) return;
    this.queues.delete(sceneInstanceId);
    const error = new Error(`coroutine lock scene was destroyed: ${sceneInstanceId}`);
    for (const keys of domains.values()) {
      for (const queue of keys.values()) {
        for (const waiter of queue.waiters.splice(0)) this.rejectWaiter(waiter, error);
      }
    }
  }

  get WaitingCount(): number {
    return this.waitingCount;
  }

  get TimeoutCount(): number {
    return this.timeoutCount;
  }

  protected override OnDestroy(): void {
    for (const sceneInstanceId of [...this.queues.keys()]) this.CancelScene(sceneInstanceId);
  }

  private acquire(
    queue: LockQueue,
    sceneInstanceId: InstanceId,
    domain: CoroutineLockDomain,
    key: CoroutineLockKey,
    options: CoroutineLockOptions,
  ): Promise<void> {
    if (!queue.locked) {
      queue.locked = true;
      return Promise.resolve();
    }

    const maxQueueLength = options.maxQueueLength ?? DEFAULT_MAX_QUEUE_LENGTH;
    if (!Number.isInteger(maxQueueLength) || maxQueueLength <= 0) {
      return Promise.reject(new Error(`lock maxQueueLength must be positive: ${maxQueueLength}`));
    }
    if (queue.waiters.reduce((count, waiter) => count + Number(waiter.active), 0) >= maxQueueLength) {
      return Promise.reject(
        new Error(`coroutine lock queue is full: ${domain}/${String(key)}`),
      );
    }
    if (options.signal?.aborted) {
      return Promise.reject(options.signal.reason ?? new Error("coroutine lock wait aborted"));
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { active: true, resolve, reject };
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        reject(new Error(`lock timeoutMs must not be negative: ${timeoutMs}`));
        return;
      }
      if (timeoutMs > 0) {
        waiter.timerId = TimerSystem.Instance.NewOnceTimer(timeoutMs, () => {
          if (!waiter.active) return;
          waiter.active = false;
          this.waitingCount -= 1;
          this.timeoutCount += 1;
          this.cleanupWaiter(waiter);
          this.removeWaiter(queue, waiter, sceneInstanceId, domain, key);
          reject(
            new Error(
              `coroutine lock wait timed out: scene=${sceneInstanceId} domain=${domain} key=${String(key)}`,
            ),
          );
        });
      }
      if (options.signal) {
        waiter.signal = options.signal;
        waiter.abortListener = () => {
          if (!waiter.active) return;
          waiter.active = false;
          this.waitingCount -= 1;
          this.cleanupWaiter(waiter);
          this.removeWaiter(queue, waiter, sceneInstanceId, domain, key);
          reject(options.signal!.reason ?? new Error("coroutine lock wait aborted"));
        };
        options.signal.addEventListener("abort", waiter.abortListener, { once: true });
      }
      queue.waiters.push(waiter);
      this.waitingCount += 1;
    });
  }

  private release(
    queue: LockQueue,
    sceneInstanceId: InstanceId,
    domain: CoroutineLockDomain,
    key: CoroutineLockKey,
  ): void {
    while (queue.waiters.length > 0) {
      const waiter = queue.waiters.shift()!;
      if (!waiter.active) continue;
      waiter.active = false;
      this.waitingCount -= 1;
      this.cleanupWaiter(waiter);
      waiter.resolve();
      return;
    }
    queue.locked = false;
    this.deleteQueue(sceneInstanceId, domain, key, queue);
  }

  private rejectWaiter(waiter: Waiter, error: Error): void {
    if (!waiter.active) return;
    waiter.active = false;
    this.waitingCount -= 1;
    this.cleanupWaiter(waiter);
    waiter.reject(error);
  }

  private cleanupWaiter(waiter: Waiter): void {
    if (waiter.timerId !== undefined) {
      TimerSystem.Instance.Remove(waiter.timerId);
      waiter.timerId = undefined;
    }
    if (waiter.signal && waiter.abortListener) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
      waiter.abortListener = undefined;
      waiter.signal = undefined;
    }
  }

  /** 超时或取消时立即移除失效节点，避免长持锁期间队列被无效等待者撑大。 / Removes timed-out or aborted nodes immediately so a long-held lock cannot retain stale waiters. */
  private removeWaiter(
    queue: LockQueue,
    waiter: Waiter,
    sceneInstanceId: InstanceId,
    domain: CoroutineLockDomain,
    key: CoroutineLockKey,
  ): void {
    const index = queue.waiters.indexOf(waiter);
    if (index >= 0) queue.waiters.splice(index, 1);
    if (!queue.locked && queue.waiters.length === 0) {
      this.deleteQueue(sceneInstanceId, domain, key, queue);
    }
  }

  private getOrCreateQueue(
    sceneInstanceId: InstanceId,
    domain: CoroutineLockDomain,
    key: CoroutineLockKey,
  ): LockQueue {
    let domains = this.queues.get(sceneInstanceId);
    if (!domains) this.queues.set(sceneInstanceId, domains = new Map());
    let keys = domains.get(domain);
    if (!keys) domains.set(domain, keys = new Map());
    let queue = keys.get(key);
    if (!queue) keys.set(key, queue = { locked: false, waiters: [] });
    return queue;
  }

  private deleteQueue(
    sceneInstanceId: InstanceId,
    domain: CoroutineLockDomain,
    key: CoroutineLockKey,
    expected: LockQueue,
  ): void {
    const domains = this.queues.get(sceneInstanceId);
    const keys = domains?.get(domain);
    if (keys?.get(key) !== expected) return;
    keys.delete(key);
    if (keys.size === 0) domains!.delete(domain);
    if (domains!.size === 0) this.queues.delete(sceneInstanceId);
  }
}

/** Scene业务使用的轻量门面，自动把Scene InstanceId加入锁键。 / Lightweight Scene facade that automatically includes the Scene InstanceId in every lock key. */
export class SceneLockScope {
  constructor(private readonly scene: Scene) {}

  RunExclusive<T>(
    domain: CoroutineLockDomain,
    key: CoroutineLockKey,
    callback: () => MaybePromise<T>,
    options: CoroutineLockOptions = {},
  ): Promise<T> {
    if (this.scene.IsDisposed) {
      return Promise.reject(new Error(`cannot acquire coroutine lock from disposed Scene: ${String(this.scene.Id)}`));
    }
    return CoroutineLockSystem.Instance.RunExclusive(
      this.scene.InstanceId,
      domain,
      key,
      callback,
      options,
    );
  }
}

function requireLockIdentity(
  sceneInstanceId: InstanceId,
  domain: CoroutineLockDomain,
  key: CoroutineLockKey,
): void {
  if (!Number.isSafeInteger(sceneInstanceId) || sceneInstanceId <= 0) {
    throw new Error(`invalid coroutine lock scene InstanceId: ${sceneInstanceId}`);
  }
  if (!domain.trim()) throw new Error("coroutine lock domain must not be empty");
  if (typeof key === "number" && (!Number.isSafeInteger(key) || !Number.isFinite(key))) {
    throw new Error(`invalid numeric coroutine lock key: ${key}`);
  }
  if (typeof key === "string" && key.length === 0) {
    throw new Error("coroutine lock string key must not be empty");
  }
}
