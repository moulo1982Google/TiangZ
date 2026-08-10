import { Unit, lifecycle } from "../../../core/public";
import type { UnitNumericDelta } from "../../../generated/model/server/demo/protocol/messages";

export interface AwakeNpcUnit {
  readonly mapId: number;
  readonly mapInstanceId: bigint;
  readonly npcConfigId: number;
  readonly name: string;
  readonly questConfigIds: readonly number[];
}

export interface NpcSnapshot {
  readonly unitId: number;
  readonly npcConfigId: number;
  readonly name: string;
  readonly questConfigIds: readonly number[];
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
  protected questConfigIds: readonly number[] = [];

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

  get QuestConfigIds(): readonly number[] {
    return this.questConfigIds;
  }
}
