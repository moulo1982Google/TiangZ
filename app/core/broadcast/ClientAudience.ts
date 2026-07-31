/**
 * 客户端逻辑受众，只保存去重且有序的 UnitId，不暴露 Gate、连接或物理路由。
 * `key`描述受众的稳定业务身份；成员变化不能改变同一受众的key，否则latest频道无法正确覆盖。
 *
 * A logical client audience containing sorted unique UnitIds without exposing
 * Gates, connections, or physical routes. The key identifies the stable
 * business audience and must not change merely because membership changes.
 */
export class ClientAudience {
  static readonly Empty = new ClientAudience("empty", Object.freeze([]));

  private constructor(
    readonly key: string,
    private readonly ids: readonly number[],
  ) {}

  /** 创建只包含一个玩家的稳定受众。 / Creates a stable audience containing one player. */
  static Self(unitId: number): ClientAudience {
    validateUnitId(unitId);
    return new ClientAudience(`unit:${unitId}`, Object.freeze([unitId]));
  }

  /**
   * 从业务成员ID创建受众。调用方提供稳定语义key，例如`party:42`，不能拼接当前成员列表。
   * Creates an audience from business member IDs. The key must identify the
   * stable scope, such as `party:42`, rather than encode current membership.
   */
  static ForUnits(key: string, unitIds: Iterable<number>): ClientAudience {
    validateKey(key);
    const ids = [...unitIds];
    for (const unitId of ids) validateUnitId(unitId);
    ids.sort(numberOrder);
    return new ClientAudience(key, Object.freeze(uniqueSorted(ids)));
  }

  /** 合并多个逻辑受众并线性去重；物理路由在发送时统一解析。 / Unions logical audiences with linear deduplication. */
  static Union(...audiences: readonly ClientAudience[]): ClientAudience {
    const active = audiences.filter((audience) => !audience.IsEmpty);
    if (active.length === 0) return ClientAudience.Empty;
    if (active.length === 1) return active[0];
    const keys = active.map((audience) => audience.key).sort();
    let ids = active[0].ids;
    for (let index = 1; index < active.length; index += 1) {
      ids = unionSorted(ids, active[index].ids);
    }
    return new ClientAudience(`union(${keys.join("|")})`, Object.freeze([...ids]));
  }

  /** 返回同时属于两个受众的玩家。 / Returns players present in both audiences. */
  static Intersect(left: ClientAudience, right: ClientAudience): ClientAudience {
    if (left.IsEmpty || right.IsEmpty) return ClientAudience.Empty;
    return new ClientAudience(
      `intersect(${left.key}|${right.key})`,
      Object.freeze(intersectSorted(left.ids, right.ids)),
    );
  }

  /** 从source中排除excluded；用于“AOI中除自己/队伍外”的明确权限分组。 / Excludes one audience from another for explicit permission groups. */
  static Except(source: ClientAudience, excluded: ClientAudience): ClientAudience {
    if (source.IsEmpty || excluded.IsEmpty) return source;
    return new ClientAudience(
      `except(${source.key}|${excluded.key})`,
      Object.freeze(exceptSorted(source.ids, excluded.ids)),
    );
  }

  get UnitIds(): readonly number[] {
    return this.ids;
  }

  get Count(): number {
    return this.ids.length;
  }

  get IsEmpty(): boolean {
    return this.ids.length === 0;
  }
}

function validateKey(key: string): void {
  if (!key || key.includes("\0")) throw new Error("client audience key is invalid");
}

function validateUnitId(unitId: number): void {
  if (!Number.isSafeInteger(unitId) || unitId <= 0 || unitId > 0xffff_ffff) {
    throw new Error(`invalid client audience UnitId: ${unitId}`);
  }
}

function uniqueSorted(values: readonly number[]): number[] {
  const result: number[] = [];
  for (const value of values) {
    if (result.at(-1) !== value) result.push(value);
  }
  return result;
}

function unionSorted(left: readonly number[], right: readonly number[]): number[] {
  const result: number[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    const leftValue = left[leftIndex];
    const rightValue = right[rightIndex];
    if (rightIndex >= right.length || (leftIndex < left.length && leftValue < rightValue)) {
      result.push(leftValue);
      leftIndex += 1;
    } else if (leftIndex >= left.length || rightValue < leftValue) {
      result.push(rightValue);
      rightIndex += 1;
    } else {
      result.push(leftValue);
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  return result;
}

function intersectSorted(left: readonly number[], right: readonly number[]): number[] {
  const result: number[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftValue = left[leftIndex];
    const rightValue = right[rightIndex];
    if (leftValue < rightValue) leftIndex += 1;
    else if (rightValue < leftValue) rightIndex += 1;
    else {
      result.push(leftValue);
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  return result;
}

function exceptSorted(source: readonly number[], excluded: readonly number[]): number[] {
  const result: number[] = [];
  let excludedIndex = 0;
  for (const unitId of source) {
    while (excludedIndex < excluded.length && excluded[excludedIndex] < unitId) excludedIndex += 1;
    if (excluded[excludedIndex] !== unitId) result.push(unitId);
  }
  return result;
}

function numberOrder(left: number, right: number): number {
  return left - right;
}
