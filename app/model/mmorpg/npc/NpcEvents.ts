import { defineSyncEvent } from "../../../core/public";
import type { PlayerUnit } from "../map/PlayerUnit";
import type {
  NpcCombatBehaviorAction,
  NpcContentIdleAction,
  NpcContentInteractionAction,
} from "./NpcContentProfileComponent";
import type { NpcUnit } from "./NpcUnit";

/** NPC交互请求所属游戏模块执行不透明能力。 / An NPC interaction asks the owning game module to execute an opaque ability. */
export interface NpcInteractionActionRequestedEvent {
  readonly npc: NpcUnit;
  readonly target?: PlayerUnit;
  readonly action: NpcContentInteractionAction;
  readonly nowMs: number;
}

/** NPC绋冲畾鍒风偣璇锋眰鍙戝竷缁欐父鎴忔ā鍧楋紱Core涓嶈В閲婂叿浣撴硶鏈崗璁€?/ An NPC idle sequence asks the owning game module to execute an opaque ability. Core does not interpret spell protocol details. */
export interface NpcIdleActionRequestedEvent {
  readonly npc: NpcUnit;
  readonly target?: NpcUnit;
  readonly action: NpcContentIdleAction;
  readonly nowMs: number;
}

/** 中立战斗规则请求所属模块执行一个不透明能力。 / A neutral combat rule asks the owning module to execute an opaque ability. */
export interface NpcCombatActionRequestedEvent {
  readonly npc: NpcUnit;
  readonly target?: PlayerUnit;
  readonly action: NpcCombatBehaviorAction;
  readonly nowMs: number;
}

/** Core只发布请求；适配器决定是否以及如何编码。 / Core only publishes the request; adapters decide whether and how to encode it. */
export const NpcEvents = {
  InteractionActionRequested: defineSyncEvent<NpcInteractionActionRequestedEvent>(
    "Npc.InteractionActionRequested",
  ),
  IdleActionRequested: defineSyncEvent<NpcIdleActionRequestedEvent>(
    "Npc.IdleActionRequested",
  ),
  CombatActionRequested: defineSyncEvent<NpcCombatActionRequestedEvent>(
    "Npc.CombatActionRequested",
  ),
} as const;
