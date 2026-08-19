import { NumericType } from "./NumericType";

/**
 * AOI观察者需要的公开数值。未列出的Numeric默认只同步给Owner，避免MP、经验、攻击等
 * 私有或战斗计算字段随着AOI关系扇出。
 *
 * Public Numeric values visible to AOI observers. Unlisted values are owner-only by default so
 * private resources and combat-calculation fields cannot fan out through AOI accidentally.
 */
export const AoiVisibleNumericTypes: readonly number[] = [
  NumericType.CurrentHp,
  NumericType.Level,
  NumericType.MaxHp,
];

/**
 * 高频公开战斗值保留服务端精度，但客户端只需要最新状态；20Hz地图下每4 Tick发布一次即5Hz。
 * Public combat values retain full server precision but only their latest client state matters;
 * one publication every four ticks is 5 Hz on the 20 Hz map loop.
 */
export const AoiCombatNumericTypes: readonly number[] = [NumericType.CurrentHp];
export const AoiCombatNumericPublishIntervalTicks = 4;

/** 等级和上限只在真实变化时立即发布，不参与恢复频率限制。 / Level and maxima publish immediately on real changes and are not recovery-throttled. */
export const AoiStaticNumericTypes: readonly number[] = [
  NumericType.Level,
  NumericType.MaxHp,
];

export const enum NumericReplicationSelection {
  ExcludeListedTypes = 0,
  IncludeListedTypes = 1,
}

const aoiVisibleNumericTypeSet = new Set(AoiVisibleNumericTypes);

/** 构造进入AOI时的公开Numeric投影；Owner全量快照不应调用本函数。 / Builds the public AOI Numeric projection; owner snapshots must retain the full set. */
export function AoiVisibleNumericValues<T extends { readonly numericType: number }>(
  values: readonly T[],
): T[] {
  return values.filter((value) => aoiVisibleNumericTypeSet.has(value.numericType));
}
