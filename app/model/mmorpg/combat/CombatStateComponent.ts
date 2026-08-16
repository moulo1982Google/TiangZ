import { Component, component, lifecycle } from "../../../core/public";

/**
 * 玩家战斗状态的运行时容器；它不保存怪物引用，只保存当前仍然对玩家有仇恨的UnitId。
 * Combat state is a runtime container. It stores no Entity reference, only the
 * UnitIds of monsters that still hold threat against this player.
 *
 * 这个组件不负责判断“谁应该产生仇恨”，也不负责伤害结算；地图战斗系统只通过
 * AddMonster/RemoveMonster维护来源，生命和法力恢复规则集中在对应的Hotfix System中。
 * It does not decide who creates threat or resolve damage. Map combat systems
 * update it through AddMonster/RemoveMonster, while the Hotfix System owns HP/MP regeneration.
 */
export interface CombatStateComponent {
  IsInCombat(): boolean;
  AddMonster(monsterUnitId: number, nowMs: number): void;
  RemoveMonster(monsterUnitId: number, nowMs: number): void;
  Clear(nowMs: number): void;
  TickResources(nowMs: number): void;
}

@component()
@lifecycle({ destroy: true })
export class CombatStateComponent extends Component {
  /** 当前仍然对玩家保持仇恨的怪物；集合为空才允许脱战回蓝。 / Monsters still holding threat; only an empty set permits out-of-combat regeneration. */
  protected readonly monsterUnitIds = new Set<number>();
  /** 上次进入脱战或完成恢复结算的服务器时间。 / Server time of the last combat exit or resource regeneration settlement. */
  protected lastRegenAtMs = 0;
  /** 用整数分子保存HP恢复不足一个数值点的余数，避免浮点误差。 / Integer numerator remainder for HP regeneration. */
  protected hpRegenRemainder = 0n;
  /** 用整数分子保存MP恢复不足一个数值点的余数，避免浮点误差。 / Integer numerator remainder for MP regeneration. */
  protected manaRegenRemainder = 0n;

  protected override OnDestroy(): void {
    this.monsterUnitIds.clear();
    this.lastRegenAtMs = 0;
    this.hpRegenRemainder = 0n;
    this.manaRegenRemainder = 0n;
  }
}
