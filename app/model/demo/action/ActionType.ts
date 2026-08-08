import { ActionType } from "../../../generated/model/config";

/**
 * 业务效果的最小分类。Action不选择目标、不处理施法时间线，也不负责网络广播；
 * 道具、Buff和技能都通过同一执行入口复用这些原子效果。
 *
 * Minimal business-effect kinds. Actions never choose targets, own cast
 * timelines, or publish network messages. Items, Buffs, and skills all reuse
 * the same execution entrypoint for these atomic effects.
 */
export { ActionType };
export type ActionTypeValue = ActionType;

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

/** Action执行时的来源信息；Buff Tick和技能结算共享，禁止把Entity或Cast引用放入上下文。 / Shared source metadata for Buff ticks and skill resolution; Entity and Cast references are forbidden. */
export interface ActionExecutionContext {
  readonly sourceBuffInstanceId?: bigint;
  readonly sourceUnitId?: number;
  readonly sourceAbilityId?: number;
  readonly damageAbsorberAmountOverride?: bigint;
  readonly reason?: string;
}
