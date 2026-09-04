import { Unit, lifecycle } from "../../../core/public";
import type { UnitNumericDelta } from "../../../generated/model/server/demo/protocol/messages";

export interface AwakeSummonedUnit {
  readonly mapId: number;
  readonly mapInstanceId: bigint;
  readonly summonDefinitionId: number;
  readonly ownerUnitId: number;
  readonly ownerPersistentId: bigint;
  readonly ownershipSlot: number;
  readonly createdByAbilityId: number;
  readonly name: string;
  readonly modelId: string;
}

export interface SummonedUnitSnapshot {
  readonly unitId: number;
  readonly summonDefinitionId: number;
  readonly ownerUnitId: number;
  readonly ownerPersistentId: bigint;
  readonly ownershipSlot: number;
  readonly createdByAbilityId: number;
  readonly name: string;
  readonly modelId: string;
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
 * 玩家拥有的临时地图Unit；具体宠物种类、技能、外观和客户端字段由外置游戏模块解释。
 * A temporary map Unit owned by another map Unit. External game modules interpret pet
 * species, abilities, presentation, and client-specific fields.
 */
@lifecycle({ awake: true, destroy: true })
export class SummonedUnit extends Unit<[request: AwakeSummonedUnit]> {
  protected mapId = 0;
  protected mapInstanceId = 0n;
  protected summonDefinitionId = 0;
  protected ownerUnitId = 0;
  protected ownerPersistentId = 0n;
  protected ownershipSlot = 0;
  protected createdByAbilityId = 0;
  protected summonName = "";
  protected summonModelId = "";

  get MapId(): number { return this.mapId; }
  get MapInstanceId(): bigint { return this.mapInstanceId; }
  get SummonDefinitionId(): number { return this.summonDefinitionId; }
  get OwnerUnitId(): number { return this.ownerUnitId; }
  get OwnerPersistentId(): bigint { return this.ownerPersistentId; }
  get OwnershipSlot(): number { return this.ownershipSlot; }
  get CreatedByAbilityId(): number { return this.createdByAbilityId; }
}
