export const NumericType = {
  CurrentHp: 1,
  CurrentMp: 2,

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

  MoveSpeed: 3000,
  MoveSpeedBase: 3000 * 10 + 1,
  MoveSpeedAdd: 3000 * 10 + 2,
  MoveSpeedPct: 3000 * 10 + 3,
} as const;

/** MoveSpeed在Numeric中使用毫米/秒保存，避免i64承担小数；配置表仍填写米/秒。 / Numeric stores MoveSpeed as millimeters per second so i64 does not carry decimals; config still uses meters per second. */
export const NUMERIC_MOVE_SPEED_SCALE = 1_000;

export type NumericType =
  typeof NumericType[keyof typeof NumericType];

export const AllNumericTypes: readonly NumericType[] = Object.values(NumericType);

/** 1000..9999是Rust自动重算、禁止直接赋值的派生结果编号。 / 1000..9999 are Rust-recomputed derived result ids that reject direct assignment. */
export function IsDerivedNumericType(type: number): boolean {
  return type >= 1_000 && type <= 9_999;
}

/** 把配置表的米/秒转换为Numeric使用的毫米/秒整数。 / Converts config meters per second into the integer millimeters-per-second value used by Numeric. */
export function MoveSpeedMetersPerSecondToNumeric(value: number): bigint {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`MoveSpeed must be a positive finite number: ${value}`);
  }
  return BigInt(Math.max(1, Math.round(value * NUMERIC_MOVE_SPEED_SCALE)));
}
