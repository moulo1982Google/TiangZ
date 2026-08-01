export const NumericType = {
  CurrentHp: 1,
  MaxHp: 1_000,
  MaxHpBase: 10_001,
  MaxHpAdd: 10_002,
  MaxHpPct: 10_003,
} as const;

export type NumericType =
  typeof NumericType[keyof typeof NumericType];

export const AllNumericTypes: readonly NumericType[] = Object.values(NumericType);

/** 1000..9999是Rust自动重算、禁止直接赋值的派生结果编号。 / 1000..9999 are Rust-recomputed derived result ids that reject direct assignment. */
export function IsDerivedNumericType(type: number): boolean {
  return type >= 1_000 && type <= 9_999;
}
