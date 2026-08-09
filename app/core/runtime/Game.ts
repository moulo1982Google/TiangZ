import {
  Singleton,
  type SingletonCtor,
  SingletonRegistry,
} from "./Singleton";
import { TimeSystem } from "./TimeSystem";
import { TimerSystem } from "./TimerSystem";
import { UpdateSystem } from "./UpdateSystem";
import {
  GlobalIdSystem,
  InstanceIdSystem,
  type GlobalIdConfig,
} from "./IdSystem";
import { CoroutineLockSystem } from "./CoroutineLockSystem";

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

  /** 在模拟开始前配置固定步长；再次调用会重置累计时间。 / Configures fixed-step cadence before simulation; calling it again resets accumulated time. */
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

  /**
   * 依次更新时间、定时器和网络 mailbox，再执行有上限的固定逻辑帧。
   * 追帧上限防止进程卡顿后无限回放旧帧并饿死新到消息。
   *
   * Updates clocks/timers, pumps network mailboxes, then runs bounded fixed frames.
   * The catch-up cap prevents a stalled process from replaying old frames forever
   * while starving newly arrived messages.
   */
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

/** 按依赖顺序创建进程级时间、定时器、Update 和 Game 单例。 / Creates process time, timer, update, and game singletons in dependency order. */
export function InitializeGameSingletons(
  config: GameUpdateConfig = {},
  idConfig: GlobalIdConfig = {},
): void {
  if (SingletonRegistry.TryGet(Game)) {
    throw new Error("game runtime singletons are already initialized");
  }
  const added: SingletonCtor[] = [];
  const add = <T extends Singleton>(ctor: SingletonCtor<T>): T => {
    const instance = SingletonRegistry.Add(ctor);
    added.push(ctor);
    return instance;
  };

  try {
    add(TimeSystem).__update(monotonicNow(), Date.now());
    if (!SingletonRegistry.TryGet(InstanceIdSystem)) {
      add(InstanceIdSystem);
    }
    add(GlobalIdSystem).Configure(idConfig);
    add(TimerSystem);
    add(CoroutineLockSystem);
    add(UpdateSystem);
    add(Game).Configure(config);
  } catch (error) {
    for (const ctor of added.reverse()) SingletonRegistry.Remove(ctor);
    throw error;
  }
}

/** 返回单调时长时钟；不可作为墙钟时间戳持久化。 / Returns a monotonic duration clock; do not persist it as a wall-clock timestamp. */
export function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}
