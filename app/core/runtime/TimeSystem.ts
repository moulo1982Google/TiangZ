import { Singleton, SingletonRegistry } from "./Singleton";

export class TimeSystem extends Singleton {
  private initialized = false;
  private frameTime = 0;
  private serverNow = 0;
  private deltaTime = 0;
  private fixedTime = 0;
  private fixedDeltaTime = 0;
  private frameCount = 0;

  static get Instance(): TimeSystem {
    return SingletonRegistry.Get(TimeSystem);
  }

  get FrameTime(): number {
    return this.frameTime;
  }

  get ServerNow(): number {
    return this.serverNow;
  }

  /** 返回Unix秒时间戳；协议明确要求秒时才使用，内部计算仍使用毫秒。 / Returns Unix seconds only for protocols that explicitly require seconds; internal calculations stay in milliseconds. */
  get ServerNowSeconds(): number {
    return Math.floor(this.serverNow / 1_000);
  }

  get DeltaTime(): number {
    return this.deltaTime;
  }

  get FixedTime(): number {
    return this.fixedTime;
  }

  get FixedDeltaTime(): number {
    return this.fixedDeltaTime;
  }

  get FrameCount(): number {
    return this.frameCount;
  }

  /** 创建可持久化的墙钟截止时间；Buff、活动等恢复时保存该值，不保存TimerId。 / Creates a persistable wall-clock deadline for buffs and activities; persist this value rather than TimerId. */
  ServerDeadlineAfter(delayMs: number): number {
    requireNonNegativeDuration(delayMs);
    return this.serverNow + delayMs;
  }

  /** 返回墙钟截止时间剩余毫秒并截断为0。 / Returns remaining wall-clock milliseconds clamped to zero. */
  RemainingServerTime(deadlineMs: number): number {
    if (!Number.isFinite(deadlineMs) || deadlineMs < 0) {
      throw new Error(`server deadline must be a non-negative finite number: ${deadlineMs}`);
    }
    return Math.max(0, deadlineMs - this.serverNow);
  }

  /** 判断可持久化墙钟截止时间是否已经到达。 / Reports whether a persistable wall-clock deadline has been reached. */
  IsServerDeadlineReached(deadlineMs: number): boolean {
    return this.RemainingServerTime(deadlineMs) === 0;
  }

  __update(frameTime: number, serverNow: number): void {
    if (!Number.isFinite(frameTime) || frameTime < 0) {
      throw new Error(`frameTime must be a non-negative finite number: ${frameTime}`);
    }
    if (!Number.isFinite(serverNow) || serverNow < 0) {
      throw new Error(`serverNow must be a non-negative finite number: ${serverNow}`);
    }
    if (this.initialized && frameTime < this.frameTime) {
      throw new Error(`monotonic frameTime moved backwards: ${frameTime} < ${this.frameTime}`);
    }
    this.deltaTime = this.initialized ? Math.max(0, frameTime - this.frameTime) : 0;
    this.frameTime = frameTime;
    this.serverNow = serverNow;
    this.initialized = true;
  }

  __beginFixedUpdate(fixedTime: number, fixedDeltaTime: number): void {
    this.fixedTime = fixedTime;
    this.fixedDeltaTime = fixedDeltaTime;
    this.frameCount += 1;
  }
}

function requireNonNegativeDuration(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`duration must be a non-negative finite number: ${value}`);
  }
}
