/**
 * 业务效果的最小分类。Action不是技能系统；道具和Buff可以直接执行它，Cast留到后续阶段。
 *
 * Minimal business-effect kinds. Action is not the skill system: items and
 * Buffs can execute it directly, while Cast is intentionally deferred.
 */
export const ActionType = {
  None: 0,
  ChangeNumeric: 1,
  AddBuff: 2,
  RemoveBuff: 3,
} as const;

export type ActionTypeValue = (typeof ActionType)[keyof typeof ActionType];

/**
 * 配置和运行时都使用同一种参数形状；数值统一为bigint，避免i64在TS边界丢精度。
 *
 * Config and runtime share one parameter shape. Values stay bigint so i64
 * values never lose precision at the TypeScript boundary.
 */
export interface ActionDefinition {
  readonly type: ActionTypeValue;
  readonly parameters: readonly bigint[];
}

/** Action执行时的来源信息；当前只保留Buff来源，未来Cast可复用。 / Source metadata for execution; Buff uses it now and Cast can reuse it later. */
export interface ActionExecutionContext {
  readonly sourceBuffInstanceId?: bigint;
  readonly reason?: string;
}
