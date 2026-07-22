import { Singleton, SingletonRegistry } from "./Singleton";
import { TimeSystem } from "./TimeSystem";
import { TimerSystem } from "./TimerSystem";
import { UpdateSystem } from "./UpdateSystem";

// 默认游戏逻辑帧为 20Hz。Runtime Pump 仍由网络事件即时唤醒，两者不是同一个频率。
export const DEFAULT_FIXED_UPDATE_MS = 50;
const FRAME_TIME_EPSILON_MS = 1e-6;

export interface GameUpdateConfig {
  fixedUpdateMs?: number;
  maxCatchUpSteps?: number;
}

export class Game extends Singleton {
  private fixedUpdateMs = DEFAULT_FIXED_UPDATE_MS;
  private maxCatchUpSteps = 2;
  private nextFixedUpdateAt = 0;
  private skippedFixedUpdates = 0;

  static get Instance(): Game {
    return SingletonRegistry.Get(Game);
  }

  Configure(config: GameUpdateConfig = {}): void {
    const fixedUpdateMs = config.fixedUpdateMs ?? DEFAULT_FIXED_UPDATE_MS;
    const maxCatchUpSteps = config.maxCatchUpSteps ?? 2;
    if (!Number.isFinite(fixedUpdateMs) || fixedUpdateMs <= 0) {
      throw new Error(`game fixedUpdateMs must be greater than 0: ${fixedUpdateMs}`);
    }
    if (!Number.isInteger(maxCatchUpSteps) || maxCatchUpSteps <= 0) {
      throw new Error(`game maxCatchUpSteps must be a positive integer: ${maxCatchUpSteps}`);
    }
    this.fixedUpdateMs = fixedUpdateMs;
    this.maxCatchUpSteps = maxCatchUpSteps;
    this.nextFixedUpdateAt = TimeSystem.Instance.FrameTime + fixedUpdateMs;
  }

  Update(frameTime: number, serverNow: number, pumpMessages: () => void): void {
    const time = TimeSystem.Instance;
    time.__update(frameTime, serverNow);
    TimerSystem.Instance.__update(frameTime);
    pumpMessages();
    this.updateFixedFrames(frameTime, time);
  }

  get FixedUpdateMs(): number {
    return this.fixedUpdateMs;
  }

  get SkippedFixedUpdates(): number {
    return this.skippedFixedUpdates;
  }

  private updateFixedFrames(now: number, time: TimeSystem): void {
    if (now + FRAME_TIME_EPSILON_MS < this.nextFixedUpdateAt) return;

    const dueSteps = Math.floor(
      (now - this.nextFixedUpdateAt + FRAME_TIME_EPSILON_MS) / this.fixedUpdateMs,
    ) + 1;
    const runSteps = Math.min(dueSteps, this.maxCatchUpSteps);
    for (let step = 0; step < runSteps; step += 1) {
      time.__beginFixedUpdate(this.nextFixedUpdateAt, this.fixedUpdateMs);
      UpdateSystem.Instance.__update();
      this.nextFixedUpdateAt += this.fixedUpdateMs;
    }

    const skipped = dueSteps - runSteps;
    if (skipped > 0) {
      this.skippedFixedUpdates += skipped;
      this.nextFixedUpdateAt += skipped * this.fixedUpdateMs;
    }
  }
}

export function InitializeGameSingletons(config: GameUpdateConfig = {}): void {
  if (SingletonRegistry.TryGet(Game)) {
    throw new Error("game runtime singletons are already initialized");
  }
  SingletonRegistry.Add(TimeSystem).__update(monotonicNow(), Date.now());
  SingletonRegistry.Add(TimerSystem);
  SingletonRegistry.Add(UpdateSystem);
  SingletonRegistry.Add(Game).Configure(config);
}

export function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}
