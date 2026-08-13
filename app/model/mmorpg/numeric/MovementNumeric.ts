/**
 * 移动速度和米/秒换算是MMORPG空间适配，不是通用Numeric字段。
 * MoveSpeed and meters-per-second conversion belong to the MMORPG spatial adapter,
 * not to the reusable Numeric field catalog.
 */
export const MovementNumericType = {
  MoveSpeed: 3000,
  MoveSpeedBase: 3000 * 10 + 1,
  MoveSpeedAdd: 3000 * 10 + 2,
  MoveSpeedPct: 3000 * 10 + 3,
} as const;

export const NUMERIC_MOVE_SPEED_SCALE = 1_000;

export function MoveSpeedMetersPerSecondToNumeric(value: number): bigint {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`MoveSpeed must be a positive finite number: ${value}`);
  }
  return BigInt(Math.max(1, Math.round(value * NUMERIC_MOVE_SPEED_SCALE)));
}
