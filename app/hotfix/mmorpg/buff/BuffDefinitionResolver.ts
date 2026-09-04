import {
  ActionType,
  BuffDefinitionProfileComponent,
  GameConfigs,
  type BuffDefinition,
  type Unit,
} from "#tiangz/model";
import { ActionFromConfig } from "../action/ActionExecutor";

const NONE_ACTION = Object.freeze({
  type: ActionType.None,
  parameters: Object.freeze([] as bigint[]),
});

/**
 * 先读取 Unit 所在地图的模块资料，再回退到 TiangZ 冷配置；同 ID 冲突会显式失败。
 * Resolves map-owned module data first, then cold TiangZ data, while rejecting ID collisions.
 */
export function RequireBuffDefinition(
  owner: Unit<any[]>,
  buffDefinitionId: number,
): Readonly<BuffDefinition> {
  if (!Number.isSafeInteger(buffDefinitionId) || buffDefinitionId <= 0) {
    throw new Error(`invalid buff definition id: ${buffDefinitionId}`);
  }
  const external = owner.DomainScene()
    .TryGetComponent(BuffDefinitionProfileComponent)
    ?.TryGet(buffDefinitionId);
  const cold = GameConfigs.BuffConfig.TryGet(buffDefinitionId);
  if (external && cold) {
    throw new Error(`external buff definition cannot override cold config: ${buffDefinitionId}`);
  }
  if (external) return external;
  if (!cold) throw new Error(`buff definition not found: ${buffDefinitionId}`);
  return Object.freeze({
    id: cold.id,
    name: cold.name,
    description: cold.description,
    durationMs: cold.durationSeconds * 1_000,
    tickIntervalMs: cold.tickIntervalMs,
    stackGroup: cold.stackGroup,
    stackScope: cold.stackScope,
    conflictPolicy: cold.conflictPolicy,
    conflictPriority: cold.conflictPriority,
    refreshSource: cold.refreshSource,
    refreshTickPolicy: cold.refreshTickPolicy,
    refreshRuntimeState: cold.refreshRuntimeState,
    effectTags: Object.freeze([]),
    addAction: cold.addActionType === ActionType.None
      ? NONE_ACTION
      : freezeConfigAction(cold.addActionType, cold.addActionParams),
    tickAction: cold.tickActionType === ActionType.None
      ? NONE_ACTION
      : freezeConfigAction(cold.tickActionType, cold.tickActionParams),
    removeAction: cold.removeActionType === ActionType.None
      ? NONE_ACTION
      : freezeConfigAction(cold.removeActionType, cold.removeActionParams),
  });
}

function freezeConfigAction(type: number, parameters: readonly number[]) {
  const action = ActionFromConfig(type, parameters);
  return Object.freeze({ type: action.type, parameters: Object.freeze([...action.parameters]) });
}
