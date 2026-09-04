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
  /** 技能百分比消耗使用的基础资源，不含装备或临时上限修正。 / Base resource used by percentage skill costs, excluding equipment and temporary maximum modifiers. */
  PrimaryResourceBase: 5,
  /** 外部游戏包按成长曲线写入的主资源脉冲恢复量；Core不推导职业或属性公式。 / Primary-resource pulse amount written by an external game's progression curve; Core derives no class or attribute formula. */
  PrimaryResourcePulseAmount: 6,

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

  /** 入站伤害的通用千分比乘数，1000表示不变；具体游戏负责配置Base与Buff修饰。 / Generic incoming-damage permille multiplier where 1000 is unchanged; games own Base and Buff modifiers. */
  IncomingDamageMultiplier: 2002,
  IncomingDamageMultiplierBase: 2002 * 10 + 1,
  IncomingDamageMultiplierAdd: 2002 * 10 + 2,
  IncomingDamageMultiplierPct: 2002 * 10 + 3,

  /** 物理入站伤害的附加千分比乘数，会与通用乘数相乘。 / Additional physical incoming-damage permille multiplier composed with the generic multiplier. */
  PhysicalDamageMultiplier: 2003,
  PhysicalDamageMultiplierBase: 2003 * 10 + 1,
  PhysicalDamageMultiplierAdd: 2003 * 10 + 2,
  PhysicalDamageMultiplierPct: 2003 * 10 + 3,
} as const;

/** Stable explicit name for consumers that need the generic catalog without MMORPG extensions. / 需要通用目录而不含MMORPG扩展时使用的稳定名称。 */
export const BaseNumericType = NumericType;

export type NumericTypeValue = typeof NumericType[keyof typeof NumericType];
export const AllNumericTypes: readonly NumericTypeValue[] = Object.values(NumericType);

/** 1000..9999由Rust按Base/Add/Pct自动计算，业务不能直接写入。 / Rust derives 1000..9999 from Base/Add/Pct; business code must not write them directly. */
export function IsDerivedNumericType(type: number): boolean {
  return type >= 1_000 && type <= 9_999;
}
