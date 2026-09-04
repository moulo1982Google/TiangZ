import { Unit, lifecycle } from "../../../core/public";
import type { UnitNumericDelta } from "../../../generated/model/server/demo/protocol/messages";
import type { NpcRuntimeContentPatch } from "./NpcContentProfileComponent";

export interface AwakeNpcUnit {
  readonly mapId: number;
  readonly mapInstanceId: bigint;
  readonly npcConfigId: number;
  readonly name: string;
  readonly presentationModelId?: string;
  readonly presentationLoadoutId?: string;
  /** Optional persistent presentation state selected by the content adapter. / 由内容适配器选择的可选持久表现状态。 */
  readonly presentationStateId?: number;
  readonly questStarterConfigIds: readonly number[];
  readonly questEnderConfigIds: readonly number[];
  readonly shopItemConfigIds: readonly number[];
  readonly trainerId: number;
  readonly shopEnabled: boolean;
  readonly repairEnabled: boolean;
  readonly conversationEnabled?: boolean;
  readonly trainingEnabled?: boolean;
  readonly recoveryEnabled?: boolean;
}

export interface NpcSnapshot {
  readonly unitId: number;
  readonly npcConfigId: number;
  readonly name: string;
  readonly questConfigIds: readonly number[];
  readonly shopEnabled: boolean;
  readonly questStarterConfigIds: readonly number[];
  readonly questEnderConfigIds: readonly number[];
  readonly shopItemConfigIds: readonly number[];
  readonly trainerId: number;
  readonly questEnabled: boolean;
  readonly conversationEnabled: boolean;
  readonly trainingEnabled: boolean;
  readonly repairEnabled: boolean;
  readonly recoveryEnabled: boolean;
  readonly presentationModelId: string;
  readonly presentationStateId: number;
  readonly presentationLoadoutId: string;
  readonly extensionCapabilities: readonly string[];
  readonly runtimeProfileRevision: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly cellX: number;
  readonly cellZ: number;
  readonly speedCellsPerSecond: number;
  readonly facing: number;
  readonly alive: boolean;
  readonly numerics: readonly UnitNumericDelta[];
}

/**
 * 地图中的NPC也是普通Unit；它没有玩家账号、Gate和Observer身份。
 * Starter第一版只放一个任务使者，后续NPC配置与对话系统仍可沿用这个边界扩展。
 *
 * An NPC is a regular map Unit without an account, Gate, or Observer role.
 * Starter v1 seeds one quest giver; future NPC configs and dialogue can reuse
 * this boundary without changing the map or AOI contract.
 */
@lifecycle({ awake: true, destroy: true })
export class NpcUnit extends Unit<[request: AwakeNpcUnit]> {
  protected mapId = 0;
  protected mapInstanceId = 0n;
  protected npcConfigId = 0;
  protected name = "";
  protected questStarterConfigIds: readonly number[] = [];
  protected questEnderConfigIds: readonly number[] = [];
  protected shopItemConfigIds: readonly number[] = [];
  protected trainerId = 0;
  protected shopEnabled = false;
  protected repairEnabled = false;
  protected questEnabled = false;
  protected conversationEnabled = false;
  protected trainingEnabled = false;
  protected recoveryEnabled = false;
  protected presentationModelId = "";
  protected npcPresentationStateId = 0;
  protected presentationLoadoutId = "";
  protected extensionCapabilities: readonly string[] = [];
  protected runtimeProfileRevision = 1;
  protected readonly runtimeContentPatches = new Map<string, Readonly<NpcRuntimeContentPatch>>();
  protected baseQuestStarterConfigIds: readonly number[] = [];
  protected baseQuestEnderConfigIds: readonly number[] = [];
  protected baseShopItemConfigIds: readonly number[] = [];
  protected baseShopEnabled = false;
  protected baseRepairEnabled = false;
  protected basePresentationModelId = "";
  protected basePresentationLoadoutId = "";
  protected baseConversationEnabled = false;
  protected baseTrainingEnabled = false;
  protected baseRecoveryEnabled = false;

  get MapId(): number {
    return this.mapId;
  }

  get MapInstanceId(): bigint {
    return this.mapInstanceId;
  }

  get NpcConfigId(): number {
    return this.npcConfigId;
  }

  get Name(): string {
    return this.name;
  }

  get QuestStarterConfigIds(): readonly number[] {
    return this.questStarterConfigIds;
  }

  get QuestEnderConfigIds(): readonly number[] {
    return this.questEnderConfigIds;
  }

  get ShopEnabled(): boolean {
    return this.shopEnabled;
  }

  get ShopItemConfigIds(): readonly number[] {
    return this.shopItemConfigIds;
  }

  get TrainerId(): number {
    return this.trainerId;
  }

  get RepairEnabled(): boolean {
    return this.repairEnabled;
  }

  get QuestEnabled(): boolean { return this.questEnabled; }
  get ConversationEnabled(): boolean { return this.conversationEnabled; }
  get TrainingEnabled(): boolean { return this.trainingEnabled; }
  get RecoveryEnabled(): boolean { return this.recoveryEnabled; }
  get PresentationModelId(): string { return this.presentationModelId; }
  get PresentationStateId(): number { return this.npcPresentationStateId; }
  get PresentationLoadoutId(): string { return this.presentationLoadoutId; }
  get ExtensionCapabilities(): readonly string[] { return this.extensionCapabilities; }
  get RuntimeProfileRevision(): number { return this.runtimeProfileRevision; }
}

export interface NpcUnit {
  /** 幂等应用一个由调用方稳定键拥有的内容增量。 / Idempotently applies a content delta owned by a caller-stable key. */
  ApplyRuntimeContentPatch(ownerId: string, patch: NpcRuntimeContentPatch): boolean;
  /** 移除一个内容增量并恢复其余增量与基础资料合成后的状态。 / Removes one delta and restores the state composed from the base profile and remaining deltas. */
  RemoveRuntimeContentPatch(ownerId: string): boolean;
}
