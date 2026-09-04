import { Component, component, lifecycle } from "../../../core/public";

export const ResourceFlowCombatMode = {
  Always: 0,
  OutOfCombat: 1,
  InCombat: 2,
} as const;

export type ResourceFlowCombatModeValue =
  (typeof ResourceFlowCombatMode)[keyof typeof ResourceFlowCombatMode];

export const ResourceFlowDirection = {
  Gain: 1,
  Drain: 2,
} as const;

export type ResourceFlowDirectionValue =
  (typeof ResourceFlowDirection)[keyof typeof ResourceFlowDirection];

/**
 * 中立的连续资源变化定义；按最大值在指定时长内完整恢复或耗尽，并由战斗条件决定是否运行。
 * Neutral continuous resource flow. It fills or drains one maximum over the
 * configured duration and runs only under its declared combat condition.
 */
export interface ResourceFlowDefinition {
  readonly id: number;
  readonly currentNumericType: number;
  readonly maximumNumericType: number;
  readonly direction: ResourceFlowDirectionValue;
  readonly combatMode: ResourceFlowCombatModeValue;
  readonly fullScaleDurationMs: number;
}

/**
 * 玩家战斗状态的运行时容器；它不保存实体引用，只保存当前仍然对玩家有仇恨的非玩家UnitId。
 * Combat state is a runtime container. It stores no Entity reference, only the
 * UnitIds of non-player units that still hold threat against this player.
 *
 * 这个组件不负责判断“谁应该产生仇恨”，也不负责伤害结算；地图战斗系统只通过
 * AddHostile/RemoveHostile维护来源，生命和法力恢复规则集中在对应的Hotfix System中。
 * It does not decide who creates threat or resolve damage. Map combat systems
 * update it through AddHostile/RemoveHostile, while the Hotfix System owns HP/MP regeneration.
 */
export interface CombatStateComponent {
  IsInCombat(): boolean;
  /** 登记一个仍对玩家保持仇恨的非玩家Unit。 / Registers a non-player Unit that still holds threat against this player. */
  AddHostile(unitId: number, nowMs: number): void;
  /** 移除一个非玩家仇恨来源。 / Removes one non-player threat source. */
  RemoveHostile(unitId: number, nowMs: number): void;
  /** 兼容旧怪物调用；新代码使用 AddHostile。 / Compatibility alias for existing monster callers; new code uses AddHostile. */
  AddMonster(monsterUnitId: number, nowMs: number): void;
  /** 兼容旧怪物调用；新代码使用 RemoveHostile。 / Compatibility alias for existing monster callers; new code uses RemoveHostile. */
  RemoveMonster(monsterUnitId: number, nowMs: number): void;
  Clear(nowMs: number): void;
  /** 由一个外置内容所有者原子替换本玩家的资源流；定义不包含职业或协议知识。 / Atomically replaces this player's flows for one external content owner without class or protocol knowledge. */
  ConfigureResourceFlows(ownerId: string, definitions: readonly ResourceFlowDefinition[]): void;
  TickResources(nowMs: number): void;
}

@component()
@lifecycle({ destroy: true })
export class CombatStateComponent extends Component {
  /** 当前仍然对玩家保持仇恨的非玩家Unit；集合为空才允许脱战回蓝。 / Non-player units still holding threat; only an empty set permits out-of-combat regeneration. */
  protected readonly hostileUnitIds = new Set<number>();
  /** 上次进入脱战或完成恢复结算的服务器时间。 / Server time of the last combat exit or resource regeneration settlement. */
  protected lastRegenAtMs = 0;
  protected resourceFlowOwner = "";
  protected resourceFlows: readonly Readonly<ResourceFlowDefinition>[] = Object.freeze([]);
  /** 按稳定定义ID保存不足一个数值点的整数余数。 / Integer remainder below one point, keyed by stable flow id. */
  protected readonly resourceFlowRemainders = new Map<number, bigint>();

  protected override OnDestroy(): void {
    this.hostileUnitIds.clear();
    this.lastRegenAtMs = 0;
    this.resourceFlowOwner = "";
    this.resourceFlows = Object.freeze([]);
    this.resourceFlowRemainders.clear();
  }
}
