/**
 * 不依赖地图的基础Numeric编号。空间单位、移动速度和Position同步不属于这里。
 * Base Numeric ids independent from maps. Spatial units, move speed, and
 * Position synchronization do not belong in this module.
 */
export const NumericType = {
  CurrentHp: 1,
  CurrentMp: 2,
  Level: 3,
  Experience: 4,

  MaxHp: 1000,
  MaxHpBase: 1000 * 10 + 1,
  MaxHpAdd: 1000 * 10 + 2,
  MaxHpPct: 1000 * 10 + 3,

  MaxMp: 1001,
  MaxMpBase: 1001 * 10 + 1,
  MaxMpAdd: 1001 * 10 + 2,
  MaxMpPct: 1001 * 10 + 3,

  Attack: 2000,
  AttackBase: 2000 * 10 + 1,
  AttackAdd: 2000 * 10 + 2,
  AttackPct: 2000 * 10 + 3,

  AttackSpeed: 2001,
  AttackSpeedBase: 2001 * 10 + 1,
  AttackSpeedAdd: 2001 * 10 + 2,
  AttackSpeedPct: 2001 * 10 + 3,
} as const;

/** Stable explicit name for consumers that need the generic catalog without MMORPG extensions. / 需要通用目录而不含MMORPG扩展时使用的稳定名称。 */
export const BaseNumericType = NumericType;

export type NumericTypeValue = typeof NumericType[keyof typeof NumericType];
export const AllNumericTypes: readonly NumericTypeValue[] = Object.values(NumericType);

/** 1000..9999由Rust按Base/Add/Pct自动计算，业务不能直接写入。 / Rust derives 1000..9999 from Base/Add/Pct; business code must not write them directly. */
export function IsDerivedNumericType(type: number): boolean {
  return type >= 1_000 && type <= 9_999;
}
