import { defineSyncEvent } from "../../../core/public";
import type { PlayerUnit } from "../map/PlayerUnit";
import type { InteractableUnit } from "./InteractableUnit";

/**
 * 通过校验的可交互物请求所属游戏模块执行不透明、非持久化的世界动作。
 * Core 负责可用性与距离校验，但不解释动作编号的领域含义。
 *
 * A validated interactable asks its owning game module to execute an opaque,
 * non-durable world action. Core owns availability and range validation but
 * deliberately assigns no meaning to the action identifier.
 */
export interface InteractableActionRequestedEvent {
  readonly interactable: InteractableUnit;
  readonly player: PlayerUnit;
  readonly actionId: number;
  readonly nowMs: number;
}

export const InteractableEvents = {
  ActionRequested: defineSyncEvent<InteractableActionRequestedEvent>(
    "Interactable.ActionRequested",
  ),
} as const;
