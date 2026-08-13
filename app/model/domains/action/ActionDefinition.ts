/**
 * 通用原子效果定义；它只描述“做什么”和参数，不选择目标、不拥有施法时间线。
 * Generated game configuration may map its enum to `type`, but the domain
 * contract intentionally uses a number so it is not coupled to one game's tables.
 */
export interface ActionDefinition {
  readonly type: number;
  readonly parameters: readonly bigint[];
}

/**
 * Action执行来源的稳定元数据；不得放入Entity、Cast、Promise或闭包。
 * Stable source metadata for Action execution; never store Entity, Cast,
 * Promise, or closure references here.
 */
export interface ActionExecutionContext {
  readonly sourceBuffInstanceId?: bigint;
  readonly sourceUnitId?: number;
  readonly sourceAbilityId?: number;
  readonly damageAbsorberAmountOverride?: bigint;
  readonly reason?: string;
}
