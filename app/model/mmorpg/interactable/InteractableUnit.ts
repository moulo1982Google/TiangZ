import { Unit, lifecycle } from "../../../core/public";
import type { InteractableRuntimeContentPatch } from "./InteractableContentProfileComponent";

export interface AwakeInteractableUnit {
  readonly mapId: number;
  readonly mapInstanceId: bigint;
  readonly interactableConfigId: number;
  readonly name: string;
  readonly presentationModelId: string;
  /** 是否允许权威交互；为 false 时实体仍参与位置和 AOI 表现。/ Whether authoritative interaction is allowed; false keeps the entity in position and AOI presentation. */
  readonly interactionEnabled: boolean;
  readonly interactionActionId?: number;
  readonly useRangeMeters: number;
  readonly respawnDelayMs: number;
  readonly lootTableId?: number;
  /** 交互时可推进的中立任务目标配置。 / Neutral quest target config emitted by this interaction. */
  readonly questObjectiveTargetConfigId?: number;
  readonly proficiencyId?: number;
  readonly requiredProficiencyRank?: number;
  readonly proficiencyGain?: number;
  readonly rewards: readonly Readonly<{ itemConfigId: number; count: number }>[];
  readonly questStarterConfigIds?: readonly number[];
}

export interface InteractableSnapshot {
  readonly unitId: number;
  readonly interactableConfigId: number;
  readonly name: string;
  readonly presentationModelId: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly cellX: number;
  readonly cellZ: number;
  readonly speedCellsPerSecond: number;
  readonly facing: number;
  readonly alive: boolean;
  readonly questStarterConfigIds: readonly number[];
  readonly runtimeProfileRevision: number;
}

/** 地图中的可交互物体复用普通Unit、位置和AOI生命周期。 / Map interactables reuse ordinary Unit, position, and AOI lifecycle. */
@lifecycle({ awake: true, destroy: true })
export class InteractableUnit extends Unit<[request: AwakeInteractableUnit]> {
  protected mapId = 0;
  protected mapInstanceId = 0n;
  protected interactableConfigId = 0;
  protected name = "";
  protected presentationModelId = "";
  protected interactionEnabled = true;
  protected interactionActionId = 0;
  protected useRangeMeters = 0;
  protected respawnDelayMs = 0;
  protected lootTableId = 0;
  protected questObjectiveTargetConfigId = 0;
  protected proficiencyId = 0;
  protected requiredProficiencyRank = 0;
  protected proficiencyGain = 0;
  protected rewards: readonly Readonly<{ itemConfigId: number; count: number }>[] = [];
  protected baseQuestStarterConfigIds: readonly number[] = [];
  protected questStarterConfigIds: readonly number[] = [];
  protected runtimeProfileRevision = 1;
  protected readonly runtimeContentPatches = new Map<string, Readonly<InteractableRuntimeContentPatch>>();

  get MapId(): number { return this.mapId; }
  get MapInstanceId(): bigint { return this.mapInstanceId; }
  get InteractableConfigId(): number { return this.interactableConfigId; }
  get Name(): string { return this.name; }
  get PresentationModelId(): string { return this.presentationModelId; }
  get InteractionEnabled(): boolean { return this.interactionEnabled; }
  get InteractionActionId(): number { return this.interactionActionId; }
  get UseRangeMeters(): number { return this.useRangeMeters; }
  get RespawnDelayMs(): number { return this.respawnDelayMs; }
  get LootTableId(): number { return this.lootTableId; }
  get QuestObjectiveTargetConfigId(): number { return this.questObjectiveTargetConfigId; }
  get ProficiencyId(): number { return this.proficiencyId; }
  get RequiredProficiencyRank(): number { return this.requiredProficiencyRank; }
  get ProficiencyGain(): number { return this.proficiencyGain; }
  get Rewards(): readonly Readonly<{ itemConfigId: number; count: number }>[] { return this.rewards; }
  get QuestStarterConfigIds(): readonly number[] { return this.questStarterConfigIds; }
  get RuntimeProfileRevision(): number { return this.runtimeProfileRevision; }
}

export interface InteractableUnit {
  ApplyRuntimeContentPatch(ownerId: string, patch: InteractableRuntimeContentPatch): boolean;
  RemoveRuntimeContentPatch(ownerId: string): boolean;
}
