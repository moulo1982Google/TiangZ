import {
  ActionType,
  type ActionDefinition,
  type ActionExecutionContext,
  BuffComponent,
  CombatComponent,
  DamageSchool,
  type DamageSchoolValue,
  type DamageResult,
  ItemComponent,
  type ItemSnapshot,
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
  readonly grantedItem?: ItemSnapshot;
  readonly grantedItems?: readonly ItemSnapshot[];
}

export interface ActionBatchExecutionResult {
  readonly changed: boolean;
  readonly results: readonly ActionExecutionResult[];
  readonly grantedItems: readonly ItemSnapshot[];
}

/**
 * 把Luban的整数列表转换为运行时Action。参数在这里统一转成bigint，之后不再把数值当unknown流转。
 *
 * Converts a Luban integer list into a runtime Action. Parameters become
 * bigint here and are never passed around as unknown afterward.
 */
export function ActionFromConfig(type: number, parameters: readonly number[]): ActionDefinition {
  if (!Number.isSafeInteger(type) || type < ActionType.None || type > ActionType.GrantItem) {
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
 * 执行一个最小业务Action。它只操作调用方已经解析出的Target，不负责选目标、不负责Cast，也不负责网络广播。
 * 伤害和治疗继续走CombatComponent，Buff只通过AddBuff/RemoveBuff改变生命周期。
 *
 * Executes one minimal business Action. It only operates on the caller-resolved Target's
 * Components: no target selection, Cast logic, or network broadcast belongs
 * here. Damage and healing stay in CombatComponent; Buff lifetime changes go
 * through AddBuff/RemoveBuff.
 */
export function ExecuteAction(
  target: Unit<any[]>,
  action: ActionDefinition,
  context: ActionExecutionContext = {},
): ActionExecutionResult {
  switch (action.type) {
    case ActionType.None:
      requireParameterCount(action, 0);
      return { changed: false };
    case ActionType.ChangeNumeric:
      return executeChangeNumeric(target, action, context);
    case ActionType.AddBuff:
      requireParameterCount(action, 1);
      {
        const buff = target.GetComponent(BuffComponent).AddBuff(toConfigId(action.parameters[0]), {
          sourceUnitId: context.sourceUnitId,
          sourceAbilityId: context.sourceAbilityId,
        });
        return { changed: true, addedBuff: buff.PublicState(target.UnitId) };
      }
    case ActionType.RemoveBuff:
      if (action.parameters.length === 0 && context.sourceBuffInstanceId !== undefined) {
        return {
          changed: target.GetComponent(BuffComponent).RemoveBuff(
            context.sourceBuffInstanceId,
            context.reason ?? "action",
          ),
        };
      }
      requireParameterCount(action, 1);
      return {
        changed: target.GetComponent(BuffComponent).RemoveBuff(
          action.parameters[0],
          context.reason ?? "action",
        ),
      };
    case ActionType.DealDamage:
      requireParameterCount(action, 2);
      {
        const amount = action.parameters[0];
        if (amount < 0n) throw new Error(`DealDamage amount must be non-negative: ${amount}`);
        const result = target.GetComponent(CombatComponent).ApplyDamage({
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
    case ActionType.Heal:
      requireParameterCount(action, 1);
      {
        const amount = action.parameters[0];
        if (amount < 0n) throw new Error(`Heal amount must be non-negative: ${amount}`);
        const result = target.GetComponent(CombatComponent).ApplyHealing(amount);
        return {
          changed: result.restoredHealing > 0n,
          value: result.currentHp,
        };
      }
    case ActionType.GrantItem:
      requireParameterCount(action, 2);
      {
        const configId = toConfigId(action.parameters[0]);
        const count = toSafeNumber(action.parameters[1], "grant item count");
        if (count <= 0) throw new Error(`grant item count must be positive: ${count}`);
        const items = target.GetComponent(ItemComponent).GrantItem(configId, count);
        return {
          changed: true,
          grantedItem: items[0],
          grantedItems: items,
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
        const modifierId = target.GetComponent(CombatComponent).RegisterDamageAbsorber(amount, priority);
        return { changed: true, value: amount, damageAbsorberModifierId: modifierId };
      }
    default:
      return assertNever(action.type);
  }
}

/**
 * 在同一同步业务栈中预检并执行一组Action；不会在Action之间await。
 * 这是当前任务奖励的统一执行边界，但不提供失败回滚或DB事务语义；跨域持久化一致性留给DBProxy。
 *
 * Preflights and executes an Action batch in one synchronous business stack
 * with no await between actions. This is the current quest-reward execution
 * boundary, not rollback or a database transaction; cross-domain durability
 * belongs to DBProxy.
 */
export function ExecuteActionBatch(
  target: Unit<any[]>,
  actions: readonly ActionDefinition[],
  context: ActionExecutionContext = {},
): ActionBatchExecutionResult {
  for (const action of actions) validateActionShape(action);
  const results = actions.map((action) => ExecuteAction(target, action, context));
  const itemById = new Map<bigint, ItemSnapshot>();
  for (const result of results) {
    for (const item of result.grantedItems ?? []) itemById.set(item.itemId, item);
  }
  return {
    changed: results.some((result) => result.changed),
    results,
    grantedItems: [...itemById.values()].sort((left, right) => left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0),
  };
}

function executeChangeNumeric(
  target: Unit<any[]>,
  action: ActionDefinition,
  context: ActionExecutionContext,
): ActionExecutionResult {
  requireParameterCount(action, 2);
  const numericType = toNumericType(action.parameters[0]);
  const delta = action.parameters[1];
  if (numericType === NumericType.CurrentHp) {
    const combat = target.GetComponent(CombatComponent);
    if (delta > 0n) {
      const result = combat.ApplyHealing(delta);
      return { changed: result.restoredHealing > 0n, value: result.currentHp };
    }
    if (delta < 0n) {
      const result = combat.ApplyDamage({
        amount: -delta,
        sourceUnitId: context.sourceUnitId ?? target.UnitId,
        abilityId: context.sourceAbilityId,
      });
      return { changed: result.finalDamage > 0n, value: result.remainingHp };
    }
    return { changed: false, value: combat.GetParent().GetComponent(NumericComponent)[numericType] };
  }

  if (IsDerivedNumericType(numericType)) {
    throw new Error(`ChangeNumeric cannot write derived NumericType: ${numericType}`);
  }
  const numeric = target.GetComponent(NumericComponent);
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

function validateActionShape(action: ActionDefinition): void {
  switch (action.type) {
    case ActionType.None:
      requireParameterCount(action, 0);
      return;
    case ActionType.ChangeNumeric:
    case ActionType.DealDamage:
      requireParameterCount(action, 2);
      return;
    case ActionType.AddBuff:
    case ActionType.RemoveBuff:
    case ActionType.Heal:
      requireParameterCount(action, 1);
      return;
    case ActionType.GrantItem:
      requireParameterCount(action, 2);
      return;
    case ActionType.RegisterDamageAbsorber:
      if (action.parameters.length < 1 || action.parameters.length > 2) {
        throw new Error(`RegisterDamageAbsorber expects 1 or 2 parameters, received ${action.parameters.length}`);
      }
      return;
    default:
      return assertNever(action.type);
  }
}

function assertNever(value: number): never {
  throw new Error(`unhandled action type: ${String(value)}`);
}
