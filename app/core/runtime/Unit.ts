import type { MaybePromise } from "../async";
import type { Logger } from "../logging/Logger";
import type { ActorContext } from "./contexts";
import {
  ACTOR_RUNTIME_ENTITY,
  Component,
  type ActorRuntimeEntity,
  invokeTimerCancelledMethod,
  invokeTimerMethod,
  OwnedEntity,
  type OwnedEntityAwakeArgs,
  type OwnedTimerOptions,
  Scene,
} from "./entities";
import { component, getActorOptions } from "./metadata";
import type {
  ActorAwakeArgs,
  ActorCtor,
} from "./types";
import type {
  TimerCancelledContext,
  TimerCancelReason,
  TimerId,
} from "./TimerSystem";

export type UnitCtor<T extends Unit<any[]> = Unit<any[]>> = new (...args: any[]) => T;
export type UnitAwakeArgs<T extends Unit<any[]>> =
  T extends Unit<infer TAwakeArgs> ? TAwakeArgs : never;

/**
 * 地图内统一Unit基类，默认只是由UnitComponent拥有的本地Entity。
 * 普通Unit没有Mailbox、Actor路由或网络地址；需要直接接收消息的类型必须继承
 * ActorUnit并显式声明@actor。
 *
 * Common map Unit base. A plain Unit is a local Entity owned by UnitComponent
 * and has no mailbox, Actor route, or network address. A directly addressable
 * Unit must extend ActorUnit and explicitly declare @actor.
 */
export abstract class Unit<
  TAwakeArgs extends unknown[] = [],
> extends OwnedEntity<TAwakeArgs> {
  get UnitId(): number {
    if (typeof this.Id !== "number") {
      throw new Error(`unit id must be a number: ${String(this.Id)}`);
    }
    return this.Id;
  }
}

/**
 * 显式拥有Actor mailbox的Unit。
 * 只有PlayerUnit这类需要InstanceId路由、跨await串行和Actor Timer的Unit才应继承；
 * 批量更新的怪物、NPC和场景物件应直接继承Unit。
 *
 * Unit with explicit Actor mailbox capability. Use it only for Units such as
 * PlayerUnit that need InstanceId routing, serialization across awaits, and
 * Actor timers. Batch-updated monsters, NPCs, and map objects extend Unit.
 */
export abstract class ActorUnit<
  TAwakeArgs extends unknown[] = [],
> extends Unit<TAwakeArgs> implements ActorRuntimeEntity<TAwakeArgs> {
  readonly [ACTOR_RUNTIME_ENTITY] = true as const;
  protected readonly ctx: ActorContext;

  constructor(ctx: ActorContext) {
    super();
    this.ctx = ctx;
  }

  get logger(): Logger {
    return this.ctx.logger;
  }

  /** 通过自身Mailbox调度一次性Timer。 / Schedules a one-shot Timer through this Unit's mailbox. */
  override NewOnceTimer<TArgs = undefined>(
    delayMs: number,
    methodName: string,
    args?: TArgs,
    options: OwnedTimerOptions = {},
  ): TimerId {
    return this.__newOnceTimer(
      delayMs,
      (actor) => invokeTimerMethod(actor, methodName, args),
      options.onCancelled
        ? (actor, context) => invokeTimerCancelledMethod(
            actor,
            options.onCancelled!,
            args,
            context,
          )
        : undefined,
    );
  }

  /** 仅供Component把稳定Core回调接入Unit mailbox。 / Lets Components route a stable Core callback through the Unit mailbox. */
  __newOnceTimer(
    delayMs: number,
    callback: (actor: ActorRuntimeEntity<any[]>) => MaybePromise<void>,
    onCancelled?: (
      actor: ActorRuntimeEntity<any[]>,
      context: TimerCancelledContext,
    ) => MaybePromise<void>,
  ): TimerId {
    return this.ctx.newOnceTimer(delayMs, callback, onCancelled);
  }

  /** 通过自身Mailbox调度重复Timer；销毁会取消后续回调。 / Schedules a repeated Timer through this Unit's mailbox and cancels it on disposal. */
  override NewRepeatedTimer<TArgs = undefined>(
    intervalMs: number,
    methodName: string,
    args?: TArgs,
    options: OwnedTimerOptions = {},
  ): TimerId {
    return this.__newRepeatedTimer(
      intervalMs,
      (actor) => invokeTimerMethod(actor, methodName, args),
      options.onCancelled
        ? (actor, context) => invokeTimerCancelledMethod(
            actor,
            options.onCancelled!,
            args,
            context,
          )
        : undefined,
    );
  }

  /** 仅供Component把稳定Core回调接入Unit mailbox。 / Lets Components route a stable Core callback through the Unit mailbox. */
  __newRepeatedTimer(
    intervalMs: number,
    callback: (actor: ActorRuntimeEntity<any[]>) => MaybePromise<void>,
    onCancelled?: (
      actor: ActorRuntimeEntity<any[]>,
      context: TimerCancelledContext,
    ) => MaybePromise<void>,
  ): TimerId {
    return this.ctx.newRepeatedTimer(intervalMs, callback, onCancelled);
  }

  /** 取消自身Actor Timer。 / Cancels one Actor Timer owned by this Unit. */
  override CancelTimer(
    timerId: TimerId,
    reason: TimerCancelReason = "manual",
  ): boolean {
    return this.ctx.cancelTimer(timerId, reason, true);
  }

  /** 仅供所有权清理选择是否通知取消方法。 / Internal ownership cleanup with explicit cancellation notification policy. */
  __cancelTimer(
    timerId: TimerId,
    reason: TimerCancelReason,
    notify: boolean,
  ): boolean {
    return this.ctx.cancelTimer(timerId, reason, notify);
  }

}

@component()
export class UnitComponent extends Component {
  private readonly units = new Map<number, Unit<any[]>>();

  /**
   * 以统一API创建Unit；@actor + ActorUnit走Actor路由，普通Unit走本地Entity所有权。
   * 两种路径都会在Awake成功后进入同一个UnitId索引，失败时完整回滚。
   *
   * Creates a Unit through one API. @actor + ActorUnit uses Actor routing while
   * a plain Unit uses local Entity ownership. Both enter the same UnitId index
   * only after successful Awake and roll back completely on failure.
   */
  Create<T extends Unit<any[]>>(
    unitId: number,
    ctor: UnitCtor<T>,
    ...awakeArgs: UnitAwakeArgs<T>
  ): T {
    if (!Number.isSafeInteger(unitId) || unitId <= 0) {
      throw new Error(`invalid unit id: ${unitId}`);
    }
    if (this.units.has(unitId)) {
      throw new Error(`unit already exists: ${unitId}`);
    }

    const actorOptions = getActorOptions(ctor);
    const isActorUnit = ctor.prototype instanceof ActorUnit;
    if (actorOptions && !isActorUnit) {
      throw new Error(`@actor Unit must extend ActorUnit: ${ctor.name}`);
    }
    if (!actorOptions && isActorUnit) {
      throw new Error(`ActorUnit must declare @actor: ${ctor.name}`);
    }

    const scene = this.DomainScene<Scene>();
    const unit = actorOptions
      ? scene.SpawnActor(
          unitId,
          ctor as unknown as ActorCtor<T & ActorRuntimeEntity<any[]>>,
          ...(awakeArgs as unknown as ActorAwakeArgs<T & ActorRuntimeEntity<any[]>>),
        ) as T
      : scene.__spawnOwned(
          this,
          unitId,
          ctor as unknown as new () => T,
          ...(awakeArgs as unknown as OwnedEntityAwakeArgs<T>),
        );
    try {
      return this.Add(unit);
    } catch (error) {
      if (actorOptions) scene.DespawnActor(unitId);
      else scene.__despawnOwned(this, unit);
      throw error;
    }
  }

  /** 索引已创建的Unit；该Unit必须属于同一个DomainScene。 / Indexes an already created Unit that belongs to the same DomainScene. */
  Add<T extends Unit<any[]>>(unit: T): T {
    if (unit.DomainScene() !== this.DomainScene()) {
      throw new Error(`unit ${unit.UnitId} belongs to another domain scene`);
    }
    if (this.units.has(unit.UnitId)) {
      throw new Error(`unit already exists: ${unit.UnitId}`);
    }
    this.units.set(unit.UnitId, unit);
    unit.__setParent(this);
    return unit;
  }

  /** 按业务UnitId返回Unit，不执行Actor路由或目录查询。 / Returns a Unit by business UnitId without Actor routing or directory lookup. */
  Get<T extends Unit<any[]> = Unit<any[]>>(unitId: number): T | undefined {
    return this.units.get(unitId) as T | undefined;
  }

  /** 获取当前Unit的稳定数组快照，可按运行时类过滤。 / Takes a stable Unit snapshot, optionally filtered by runtime class. */
  GetAll<T extends Unit<any[]> = Unit<any[]>>(
    ctor?: abstract new (...args: any[]) => T,
  ): readonly T[] {
    const values = [...this.units.values()];
    return (ctor
      ? values.filter((unit): unit is T => unit instanceof ctor)
      : values) as T[];
  }

  /** 从统一索引及其真实所有权路径移除Unit。Actor路由和本地Entity都立即失效。 / Removes a Unit from the shared index and its actual ownership path, invalidating Actor routing or local Entity identity immediately. */
  Remove(unitId: number): Unit<any[]> | undefined {
    const unit = this.units.get(unitId);
    if (!unit) return undefined;

    this.units.delete(unitId);
    if (unit instanceof ActorUnit) {
      this.DomainScene<Scene>().DespawnActor(unitId);
    } else {
      this.DomainScene<Scene>().__despawnOwned(this, unit);
    }
    return unit;
  }

  /** 仅供ProcessHost在Actor Unit销毁时同步移除UnitId索引。 / Lets ProcessHost remove the UnitId index when an Actor Unit is despawned. */
  __detach(unitId: number): void {
    this.units.delete(unitId);
  }

  get Count(): number {
    return this.units.size;
  }

  protected override OnDestroy(): void {
    for (const unitId of [...this.units.keys()]) this.Remove(unitId);
    this.units.clear();
  }
}
