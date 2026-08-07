import {
  ActionType,
  type ActionDefinition,
  type ActionExecutionContext,
  BuffComponent,
  CombatComponent,
  DamageSchool,
  type DamageSchoolValue,
  type DamageResult,
  IsDerivedNumericType,
  NumericComponent,
  NumericType,
  type BuffPublicState,
  type Unit,
} from "#tiangz/model";

export interface ActionExecutionResult {
  readonly changed: boolean;
  readonly value?: bigint;
  readonly addedBuff?: BuffPublicState;
  readonly damageAbsorberModifierId?: number;
  readonly damage?: DamageResult;
}

/**
 * 把Luban的整数列表转换为运行时Action。参数在这里统一转成bigint，之后不再把数值当unknown流转。
 *
 * Converts a Luban integer list into a runtime Action. Parameters become
 * bigint here and are never passed around as unknown afterward.
 */
export function ActionFromConfig(type: number, parameters: readonly number[]): ActionDefinition {
  if (!Number.isSafeInteger(type) || type < ActionType.None || type > ActionType.RegisterDamageAbsorber) {
    throw new Error(`unsupported action type: ${type}`);
  }
  if (!parameters.every(Number.isSafeInteger)) {
    throw new Error(`action parameters must be safe integers: ${parameters.join(",")}`);
  }
  return {
    type: type as ActionDefinition["type"],
    parameters: parameters.map((value) => BigInt(value)),
  };
}

/**
 * 执行一个最小业务Action。它只操作Owner的组件，不负责选目标、不负责Cast，也不负责网络广播。
 * 伤害和治疗继续走CombatComponent，Buff只通过AddBuff/RemoveBuff改变生命周期。
 *
 * Executes one minimal business Action. It only operates on the Owner's
 * Components: no target selection, Cast logic, or network broadcast belongs
 * here. Damage and healing stay in CombatComponent; Buff lifetime changes go
 * through AddBuff/RemoveBuff.
 */
export function ExecuteAction(
  owner: Unit<any[]>,
  action: ActionDefinition,
  context: ActionExecutionContext = {},
): ActionExecutionResult {
  switch (action.type) {
    case ActionType.None:
      requireParameterCount(action, 0);
      return { changed: false };
    case ActionType.ChangeNumeric:
      return executeChangeNumeric(owner, action, context);
    case ActionType.AddBuff:
      requireParameterCount(action, 1);
      {
        const buff = owner.GetComponent(BuffComponent).AddBuff(toConfigId(action.parameters[0]), {
          sourceUnitId: context.sourceUnitId,
          sourceAbilityId: context.sourceAbilityId,
        });
        return { changed: true, addedBuff: buff.PublicState(owner.UnitId) };
      }
    case ActionType.RemoveBuff:
      if (action.parameters.length === 0 && context.sourceBuffInstanceId !== undefined) {
        return {
          changed: owner.GetComponent(BuffComponent).RemoveBuff(
            context.sourceBuffInstanceId,
            context.reason ?? "action",
          ),
        };
      }
      requireParameterCount(action, 1);
      return {
        changed: owner.GetComponent(BuffComponent).RemoveBuff(
          action.parameters[0],
          context.reason ?? "action",
        ),
      };
    case ActionType.DealDamage:
      requireParameterCount(action, 2);
      {
        const amount = action.parameters[0];
        if (amount < 0n) throw new Error(`DealDamage amount must be non-negative: ${amount}`);
        const result = owner.GetComponent(CombatComponent).ApplyDamage({
          amount,
          sourceUnitId: context.sourceUnitId,
          abilityId: context.sourceAbilityId,
          damageSchool: toDamageSchool(action.parameters[1]),
        });
        return {
          changed: result.finalDamage > 0n || result.absorbedDamage > 0n,
          value: result.remainingHp,
          damage: result,
        };
      }
    case ActionType.RegisterDamageAbsorber:
      if (action.parameters.length < 1 || action.parameters.length > 2) {
        throw new Error(`RegisterDamageAbsorber expects 1 or 2 parameters, received ${action.parameters.length}`);
      }
      {
        const configuredAmount = action.parameters[0];
        const amount = context.damageAbsorberAmountOverride ?? configuredAmount;
        const priority = action.parameters.length === 2 ? toSafeNumber(action.parameters[1], "absorber priority") : 0;
        if (amount <= 0n) throw new Error(`damage absorber amount must be positive: ${amount}`);
        const modifierId = owner.GetComponent(CombatComponent).RegisterDamageAbsorber(amount, priority);
        return { changed: true, value: amount, damageAbsorberModifierId: modifierId };
      }
    default:
      return assertNever(action.type);
  }
}

function executeChangeNumeric(
  owner: Unit<any[]>,
  action: ActionDefinition,
  context: ActionExecutionContext,
): ActionExecutionResult {
  requireParameterCount(action, 2);
  const numericType = toNumericType(action.parameters[0]);
  const delta = action.parameters[1];
  if (numericType === NumericType.CurrentHp) {
    const combat = owner.GetComponent(CombatComponent);
    if (delta > 0n) {
      const result = combat.ApplyHealing(delta);
      return { changed: result.restoredHealing > 0n, value: result.currentHp };
    }
    if (delta < 0n) {
      const result = combat.ApplyDamage({
        amount: -delta,
        sourceUnitId: context.sourceUnitId ?? owner.UnitId,
        abilityId: context.sourceAbilityId,
      });
      return { changed: result.finalDamage > 0n, value: result.remainingHp };
    }
    return { changed: false, value: combat.GetParent().GetComponent(NumericComponent)[numericType] };
  }

  if (IsDerivedNumericType(numericType)) {
    throw new Error(`ChangeNumeric cannot write derived NumericType: ${numericType}`);
  }
  const numeric = owner.GetComponent(NumericComponent);
  const next = numeric[numericType] + delta;
  numeric[numericType] = next;
  return { changed: delta !== 0n, value: next };
}

function toDamageSchool(value: bigint): DamageSchoolValue {
  const school = toSafeNumber(value, "damage school");
  if (!Object.values(DamageSchool).includes(school as DamageSchoolValue)) {
    throw new Error(`unsupported damage school: ${school}`);
  }
  return school as DamageSchoolValue;
}

function toSafeNumber(value: bigint, name: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${name} must be a non-negative safe integer: ${value}`);
  }
  return Number(value);
}

function toConfigId(value: bigint): number {
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`action config id must be a positive safe integer: ${value}`);
  }
  return Number(value);
}

function toNumericType(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`numeric type must be a non-negative safe integer: ${value}`);
  }
  return Number(value);
}

function requireParameterCount(action: ActionDefinition, count: number): void {
  if (action.parameters.length !== count) {
    throw new Error(
      `action ${action.type} expects ${count} parameters, received ${action.parameters.length}`,
    );
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled action type: ${String(value)}`);
}
