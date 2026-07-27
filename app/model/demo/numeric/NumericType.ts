export const NumericType = {
  CurrentHp: 1,
  MaxHp: 2,
} as const;

export type NumericType =
  typeof NumericType[keyof typeof NumericType];

export const AllNumericTypes: readonly NumericType[] = Object.values(NumericType);
