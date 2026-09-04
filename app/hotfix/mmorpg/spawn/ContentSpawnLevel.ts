/**
 * 在配置闭区间内按稳定刷点与成功创建代次选择等级；来源游戏负责提供区间和明确属性。
 * Selects a level from a configured inclusive range using a stable spawn and
 * successful creation generation; source games provide the range and stats.
 */
export function SelectContentSpawnLevel(
  minimumLevel: number,
  maximumLevel: number,
  spawnId: number,
  spawnGeneration: number,
): number {
  if (minimumLevel === maximumLevel) return minimumLevel;
  const width = maximumLevel - minimumLevel + 1;
  return minimumLevel + (levelSelectionSeed(spawnId, spawnGeneration) % width);
}

function levelSelectionSeed(spawnId: number, spawnGeneration: number): number {
  let value = Math.imul(spawnId, 0x9e37_79b1);
  value = Math.imul(value ^ spawnGeneration, 0x85eb_ca6b);
  return Math.imul(value ^ 0x4c45_564c, 0xc2b2_ae35) >>> 0;
}
