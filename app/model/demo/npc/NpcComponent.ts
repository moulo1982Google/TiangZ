import { Component, component, lifecycle } from "../../../core/public";
import type { MapAoiComponent } from "../map/MapAoiComponent";
import type { MapComponent } from "../map/MapComponent";
import type { PlayerUnit } from "../map/PlayerUnit";
import { NpcUnit } from "./NpcUnit";

export const STARTER_NPC_UNIT_ID = 0x4000_0001;
export const STARTER_NPC_CONFIG_ID = 9001;
export const STARTER_NPC_NAME = "任务使者";
export const STARTER_NPC_QUEST_CONFIG_IDS = [5001, 5002, 5003, 5004, 5005] as const;
export const STARTER_NPC_INTERACT_RANGE_METERS = 5;

export interface NpcComponent {
  Get(npcUnitId: number): NpcUnit | undefined;
  GetAll(): readonly NpcUnit[];
  /** 在PlayerUnit有序mailbox内调用，校验NPC归属、任务提供关系和距离。 / Call inside the PlayerUnit ordered mailbox to validate ownership, quest offering, and distance. */
  ValidateQuestInteraction(player: PlayerUnit, npcUnitId: number, questConfigId: number): void;
}

/**
 * 地图级NPC索引与交互边界。NPC仍由MapScene的UnitComponent统一拥有，
 * 这里只保存NPC业务索引，不复制一份AOI或玩家状态。
 *
 * Map-level NPC index and interaction boundary. NPCs remain owned by the
 * MapScene UnitComponent; this component stores only NPC business indexes and
 * never duplicates AOI or player state.
 */
@component()
@lifecycle({ awake: true, destroy: true })
export class NpcComponent extends Component<[
  map: MapComponent,
  aoi: MapAoiComponent,
]> {
  protected map!: MapComponent;
  protected aoi!: MapAoiComponent;
  protected readonly npcs = new Map<number, NpcUnit>();
}
