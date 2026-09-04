/** 一档由内容模块预计算的中立战斗数值；Core不解释来源成长公式。 / One neutral combat-stat row precomputed by content; Core does not interpret source growth formulas. */
export interface ContentCombatLevelStats {
  readonly level: number;
  readonly maxHp: number;
  readonly maxMp: number;
  readonly attackDamage: number;
}

/** 校验、排序并冻结完整等级区间；部分曲线会在登记期失败。 / Validates, sorts, and freezes a complete level range; partial curves fail during registration. */
export function FreezeContentCombatLevelStats(
  rows: readonly ContentCombatLevelStats[] | undefined,
  minimumLevel: number | undefined,
  maximumLevel: number | undefined,
  owner: string,
): readonly Readonly<ContentCombatLevelStats>[] {
  if (rows === undefined) return Object.freeze([]);
  if (!Array.isArray(rows)) throw new Error(`${owner} combat stats by level must be an array`);
  // Luban represents an omitted list as []; non-empty curves remain strict and complete.
  // Luban 将未配置列表规范化为 []；非空曲线仍必须完整覆盖等级区间。
  if (rows.length === 0) return Object.freeze([]);
  if (minimumLevel === undefined || maximumLevel === undefined) {
    throw new Error(`${owner} combat stats by level require a level range`);
  }
  const result = rows.map((row) => {
    if (!row || typeof row !== "object") throw new Error(`${owner} combat level row must be an object`);
    requirePositiveInteger(row.level, `${owner} combat level`);
    requirePositiveInteger(row.maxHp, `${owner} combat level ${row.level} max hp`);
    requireNonNegativeInteger(row.maxMp, `${owner} combat level ${row.level} max mp`);
    requirePositiveInteger(row.attackDamage, `${owner} combat level ${row.level} attack damage`);
    if (row.level < minimumLevel || row.level > maximumLevel) {
      throw new Error(`${owner} combat level ${row.level} is outside ${minimumLevel}..${maximumLevel}`);
    }
    return Object.freeze({
      level: row.level,
      maxHp: row.maxHp,
      maxMp: row.maxMp,
      attackDamage: row.attackDamage,
    });
  }).sort((left, right) => left.level - right.level);
  if (result.length !== maximumLevel - minimumLevel + 1) {
    throw new Error(`${owner} combat stats by level must cover ${minimumLevel}..${maximumLevel}`);
  }
  for (let index = 0; index < result.length; index += 1) {
    const expectedLevel = minimumLevel + index;
    if (result[index]?.level !== expectedLevel) {
      throw new Error(`${owner} combat stats by level are missing or duplicate at ${expectedLevel}`);
    }
  }
  return Object.freeze(result);
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function requireNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
}
