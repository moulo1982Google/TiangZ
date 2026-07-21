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

  __update(frameTime: number, serverNow: number): void {
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
