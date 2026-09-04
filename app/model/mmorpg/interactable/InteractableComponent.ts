import { Component, component, lifecycle } from "../../../core/public";
import type { M2C_UseInteractable } from "../../../generated/model/server/demo/protocol/messages";
import type { MapAoiComponent } from "../map/MapAoiComponent";
import type { MapComponent } from "../map/MapComponent";
import type { PlayerUnit } from "../map/PlayerUnit";
import { InteractableUnit } from "./InteractableUnit";
import type { InteractableRuntimeContentPatch } from "./InteractableContentProfileComponent";

export interface InteractableComponent {
  /** 激活一个已登记但当前不可见的稳定刷点。 / Activates a registered stable spawn that is currently unavailable. */
  ActivateSpawn(spawnId: number): void;
  /** 撤销一个已登记刷点并清除普通重生计时。 / Deactivates a registered spawn and clears its normal respawn timer. */
  DeactivateSpawn(spawnId: number): void;
  ApplyDefinitionContentPatch(ownerId: string, definitionId: number, patch: InteractableRuntimeContentPatch): readonly InteractableUnit[];
  RemoveDefinitionContentPatch(ownerId: string, definitionId: number): readonly InteractableUnit[];
  /** 校验附近可交互物当前确实提供该任务。 / Validates that a nearby interactable currently offers the quest. */
  ValidateQuestOffer(player: PlayerUnit, interactableUnitId: number, questConfigId: number): void;
  Get(interactableUnitId: number): InteractableUnit | undefined;
  GetAll(): readonly InteractableUnit[];
  /** 在PlayerUnit有序mailbox中原子发放奖励并推进收集任务。 / Atomically grants rewards and advances collect quests inside the ordered PlayerUnit mailbox. */
  Use(player: PlayerUnit, interactableUnitId: number, clientOperationId: string): Promise<M2C_UseInteractable>;
}

/** 地图级可交互物体索引、可用状态和重生所有者。 / Map-level owner of interactable indexes, availability, and respawn. */
@component()
@lifecycle({ awake: true, destroy: true })
export class InteractableComponent extends Component<[map: MapComponent, aoi: MapAoiComponent]> {
  protected map!: MapComponent;
  protected aoi!: MapAoiComponent;
  protected readonly interactables = new Map<number, InteractableUnit>();
  protected readonly respawnAtByUnitId = new Map<number, number>();
  protected readonly inFlightUnitIds = new Set<number>();
  protected readonly definitionContentPatches = new Map<number, Map<string, Readonly<InteractableRuntimeContentPatch>>>();
}
