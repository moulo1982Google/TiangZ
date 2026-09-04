/** 圆形环境游走区域中的确定性点。 / A deterministic point in a circular ambient-wander area. */
export interface MonsterAmbientPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * 不使用进程全局随机状态来选择可复现的伪随机目标；刷点在测试与重启间行为一致，连续序列仍覆盖整个游走圆盘。
 * Selects a repeatable pseudo-random destination without process-global random state; a spawn stays consistent across tests and restarts while successive sequences cover the whole wander disc.
 */
export function SelectMonsterWanderPoint(
  origin: MonsterAmbientPoint,
  radius: number,
  spawnId: number,
  sequence: number,
): MonsterAmbientPoint {
  if (!Number.isFinite(radius) || radius < 0) {
    throw new Error(`monster wander radius must not be negative: ${radius}`);
  }
  if (!Number.isSafeInteger(spawnId) || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error(`invalid monster wander seed: ${spawnId}/${sequence}`);
  }
  if (radius === 0) return { ...origin };
  const angleUnit = unitHash(spawnId, sequence, 0x9e37_79b9);
  const distanceUnit = unitHash(spawnId, sequence, 0x85eb_ca6b);
  const angle = angleUnit * Math.PI * 2;
  // sqrt distributes points uniformly by area; the inner floor avoids repeatedly
  // quantizing short-radius wanderers back onto their spawn cell.
  const distance = radius * (0.35 + 0.65 * Math.sqrt(distanceUnit));
  return {
    x: origin.x + Math.sin(angle) * distance,
    y: origin.y,
    z: origin.z + Math.cos(angle) * distance,
  };
}

/** 随机游走到达后的确定性4至10秒空闲窗口。 / Deterministic four-to-ten-second idle window after a random-wander arrival. */
export function MonsterWanderPauseMs(spawnId: number, sequence: number): number {
  return 4_000 + Math.floor(unitHash(spawnId, sequence, 0xc2b2_ae35) * 6_001);
}

/** 在配置区间内选择可复现的首次游走错峰。 / Selects a repeatable initial wander stagger inside the configured range. */
export function SelectMonsterInitialWanderDelayMs(
  spawnId: number,
  minimumMs: number,
  maximumMs: number,
): number {
  return selectIntegerRange(spawnId, 0, 0x27d4_eb2f, minimumMs, maximumMs);
}

/** 在配置区间内选择可复现的到达后停顿。 / Selects a repeatable post-arrival pause inside the configured range. */
export function SelectMonsterWanderPauseMs(
  spawnId: number,
  sequence: number,
  minimumMs: number,
  maximumMs: number,
): number {
  return selectIntegerRange(spawnId, sequence, 0xc2b2_ae35, minimumMs, maximumMs);
}

/** 按连续路段数递增概率决定本次是否停顿。 / Decides whether to pause with probability increasing by consecutive leg count. */
export function ShouldPauseMonsterWander(
  spawnId: number,
  sequence: number,
  legsSincePause: number,
  firstLegChancePermille: number,
  additionalLegChancePermille: number,
): boolean {
  if (!Number.isSafeInteger(legsSincePause) || legsSincePause <= 0) {
    throw new Error(`monster wander leg count must be positive: ${legsSincePause}`);
  }
  const threshold = Math.min(
    1_000,
    firstLegChancePermille + (legsSincePause - 1) * additionalLegChancePermille,
  );
  return Math.floor(unitHash(spawnId, sequence, 0x1656_67b1) * 1_000) < threshold;
}

function selectIntegerRange(
  spawnId: number,
  sequence: number,
  salt: number,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(minimum)
    || !Number.isSafeInteger(maximum)
    || minimum < 0
    || maximum < minimum
  ) {
    throw new Error(`invalid monster wander time range: ${minimum}..${maximum}`);
  }
  if (minimum === maximum) return minimum;
  return minimum + Math.floor(unitHash(spawnId, sequence, salt) * (maximum - minimum + 1));
}

function unitHash(spawnId: number, sequence: number, salt: number): number {
  let value = (spawnId ^ Math.imul(sequence + 1, salt)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb_352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846c_a68b) >>> 0;
  value ^= value >>> 16;
  return (value >>> 0) / 0x1_0000_0000;
}
