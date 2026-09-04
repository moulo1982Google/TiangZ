import {
  IsDerivedNumericType,
  NumericComponent,
  type SkillDefinition,
} from "#tiangz/model";

export interface ResolvedSkillResourceCost {
  readonly currentNumericType: number;
  readonly amount: bigint;
  readonly available: bigint;
}

/**
 * 只读计算一次施法的全部资源成本；任一资源不足时调用方不得提交冷却或部分扣除。
 * Resolves every resource cost without mutation so one insufficient resource
 * cannot leave a partial debit or committed cooldown behind.
 */
export function PlanSkillResourceCosts(
  numeric: NumericComponent,
  definition: SkillDefinition,
): readonly ResolvedSkillResourceCost[] {
  return Object.freeze((definition.resourceCosts ?? []).map((cost) => {
    if (IsDerivedNumericType(cost.currentNumericType)) {
      throw new Error(`skill ${definition.id} cannot consume derived NumericType ${cost.currentNumericType}`);
    }
    const basis = cost.basisNumericType === undefined
      ? 0n
      : nonNegative(numeric[cost.basisNumericType], `skill ${definition.id} resource basis`);
    const proportional = basis * BigInt(cost.basisPermille ?? 0) / 1_000n;
    const amount = cost.fixedAmount + proportional;
    if (amount <= 0n) throw new Error(`skill ${definition.id} resolved a non-positive resource cost`);
    return Object.freeze({
      currentNumericType: cost.currentNumericType,
      amount,
      available: nonNegative(
        numeric[cost.currentNumericType],
        `skill ${definition.id} current resource`,
      ),
    });
  }));
}

/** 同步提交已校验成本；施法入口保证计划与提交之间没有await。 / Commits a validated plan synchronously; the cast entrypoint contains no await between planning and commit. */
export function CommitSkillResourceCosts(
  numeric: NumericComponent,
  costs: readonly ResolvedSkillResourceCost[],
): void {
  for (const cost of costs) {
    const current = numeric[cost.currentNumericType];
    if (current < cost.amount) {
      throw new Error(`resource ${cost.currentNumericType} changed before skill cost commit`);
    }
  }
  for (const cost of costs) {
    numeric[cost.currentNumericType] = numeric[cost.currentNumericType] - cost.amount;
  }
}

function nonNegative(value: bigint, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n) {
    throw new Error(`${label} must be a non-negative bigint: ${String(value)}`);
  }
  return value;
}
