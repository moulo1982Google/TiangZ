import type { ProcessHost } from "./host";
import type {
  ActorCtor,
  ActorAwakeArgs,
  ActorId,
  ActorRef,
  SceneRef,
} from "./types";
import type { Actor } from "./entities";
import type {
  ChildEntity,
  ChildEntityAwakeArgs,
  ChildEntityCtor,
  Component,
} from "./entities";
import type { MaybePromise } from "../async";
import type { TimerId } from "./TimerSystem";
import { Logger } from "../logging/Logger";

export class SceneContext {
  readonly logger: Logger;

  constructor(
    private readonly host: ProcessHost,
    public readonly self: SceneRef,
  ) {
    this.logger = new Logger("scene", {
      category: "business",
      scene: self.sceneId,
      sceneType: self.sceneType,
    });
  }

  /** 在本 Scene 内创建并挂载 Actor。 / Creates and attaches an Actor inside this Scene. */
  spawnActor<T extends Actor<any[]>>(
    actorId: ActorId,
    ctor: ActorCtor<T>,
    ...awakeArgs: ActorAwakeArgs<T>
  ): T {
    return this.host.spawnActor(this.self.sceneId, actorId, ctor, ...awakeArgs);
  }

  /** 移除 Actor，并使其 InstanceId 路由失效。 / Removes an Actor and invalidates its InstanceId routing. */
  despawnActor(actorId: ActorId): boolean {
    return this.host.despawnActor(this.self.sceneId, actorId);
  }

  /** 创建挂在 Component 下、没有 mailbox 的本地子 Entity。 / Creates a local child Entity owned by a Component and without a mailbox. */
  spawnChild<T extends ChildEntity<any[]>>(
    parent: Component<any[]>,
    id: import("./types").EntityId,
    ctor: ChildEntityCtor<T>,
    ...awakeArgs: ChildEntityAwakeArgs<T>
  ): T {
    return this.host.spawnChild(
      this.self.sceneId,
      parent,
      id,
      ctor,
      ...awakeArgs,
    );
  }

  /** 销毁所属 Component 的本地子 Entity。 / Destroys a local child Entity owned by the Component. */
  despawnChild(
    parent: Component<any[]>,
    child: ChildEntity<any[]>,
  ): boolean {
    return this.host.despawnChild(this.self.sceneId, parent, child);
  }

  /** 解析当前上下文所属的 Scene Entity。 / Resolves this context's owning Scene Entity. */
  DomainScene<T extends import("./entities").Scene = import("./entities").Scene>(): T {
    return this.host.sceneById<T>(this.self.sceneId);
  }

  /** 按宿主时间休眠；游戏逻辑调度应使用 Entity 定时器。 / Sleeps on host time; gameplay scheduling should use Entity timers. */
  sleep(ms: number): Promise<void> {
    return hostSleep(ms);
  }

}

export class ActorContext {
  readonly logger: Logger;

  constructor(
    private readonly host: ProcessHost,
    public readonly self: ActorRef,
  ) {
    this.logger = new Logger("actor", {
      category: "business",
      scene: self.sceneId,
      sceneType: self.sceneType,
      actorId: self.actorId,
    });
  }

  /** 解析拥有当前 Actor 的 Scene。 / Resolves the Scene that owns this Actor. */
  DomainScene<T extends import("./entities").Scene = import("./entities").Scene>(): T {
    return this.host.sceneById<T>(this.self.sceneId);
  }

  /** 按宿主时间休眠，后续 continuation 不经过 Actor mailbox 串行化。 / Sleeps on host time and does not serialize the continuation through the Actor mailbox. */
  sleep(ms: number): Promise<void> {
    return hostSleep(ms);
  }

  /** 通过当前 Actor mailbox 调度一次性回调。 / Schedules a one-shot callback through this Actor's mailbox. */
  newOnceTimer(
    delayMs: number,
    callback: (actor: Actor<any[]>) => MaybePromise<void>,
  ): TimerId {
    return this.host.newActorOnceTimer(this.self.instanceId, delayMs, callback);
  }

  /** 通过当前 Actor mailbox 调度重复回调。 / Schedules repeated callbacks through this Actor's mailbox. */
  newRepeatedTimer(
    intervalMs: number,
    callback: (actor: Actor<any[]>) => MaybePromise<void>,
  ): TimerId {
    return this.host.newActorRepeatedTimer(this.self.instanceId, intervalMs, callback);
  }

  /** 取消由当前 Actor InstanceId 拥有的一个定时器。 / Cancels one timer owned by this Actor InstanceId. */
  removeTimer(timerId: TimerId): boolean {
    return this.host.removeActorTimer(this.self.instanceId, timerId);
  }

}

/** 优先使用 Rust 宿主 sleep op，仅在独立测试中回退。 / Uses the Rust host sleep op when available and falls back only in standalone tests. */
export function hostSleep(ms: number): Promise<void> {
  const sleep = (globalThis as unknown as { __hostSleep?: (ms: number) => Promise<void> })
    .__hostSleep;
  if (sleep) return sleep(ms);

  return new Promise((resolve) => setTimeout(resolve, ms));
}
