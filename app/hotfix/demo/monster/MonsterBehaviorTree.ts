export type MonsterBehaviorAction = "idle" | "hold" | "chase" | "attack";

export interface MonsterBehaviorContext {
  readonly mayAggro: boolean;
  readonly hasTarget: boolean;
  readonly inAttackRange: boolean;
  readonly canAttack: boolean;
}

/**
 * 怪物模块专用的无状态决策：只要上游按规则选出了目标，就攻击或追击，否则待机。
 * 目标可能来自主动索敌，也可能来自仇恨表；决策函数不关心“为何选中”，避免被动怪被受击事件直接绑死。
 *
 * This small decision function is private to the monster module: once the
 * caller has selected a target, it attacks or chases; otherwise it stays idle.
 * The target may come from active acquisition or threat, so it does not
 * hard-code a "was hit" reaction and is intentionally not a general AI framework.
 */
export function EvaluateMonsterBehavior(context: MonsterBehaviorContext): MonsterBehaviorAction {
  if (!context.mayAggro || !context.hasTarget) return "idle";
  if (!context.inAttackRange) return "chase";
  return context.canAttack ? "attack" : "hold";
}
