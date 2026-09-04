import { ActorUnit, actor, lifecycle } from "../../../core/public";
import type { UnitNumericDelta } from "../../../generated/model/server/demo/protocol/messages";
import type { M2C_CastSkill } from "../../../generated/model/server/demo/protocol/messages";
import type {
  M2C_InspectLootMonster,
  M2C_LootMonster,
  M2C_ReleaseDeadPlayer,
  M2C_RevivePlayer,
} from "../../../generated/model/server/demo/protocol/messages";

export interface AwakePlayerUnit {
  account: string;
  characterId: bigint;
  playerConfigId: number;
  mapId: number;
  mapInstanceId: bigint;
}

export interface MatchPlayerGate {
  gateName: string;
  gateEpoch?: bigint;
}

export interface PlayerSnapshot {
  account: string;
  characterId: bigint;
  mapId: number;
  mapInstanceId: bigint;
  unitId: number;
  gateName: string;
  gateEpoch: bigint;
  x: number;
  y: number;
  z: number;
  yaw: number;
  cellX: number;
  cellZ: number;
  speedCellsPerSecond: number;
  facing: number;
  alive: boolean;
  gold: bigint;
  numerics: readonly UnitNumericDelta[];
}

export interface MovePlayer {
  inputX: number;
  inputZ: number;
  sequence: number;
}

export interface FindNavigationPath {
  startX: number;
  startY: number;
  startZ: number;
  targetX: number;
  targetY: number;
  targetZ: number;
}

export interface NavigatePlayerTo {
  targetX: number;
  targetY: number;
  targetZ: number;
  sequence: number;
}

export interface NavigatePlayerInput {
  forward: number;
  strafe: number;
  yaw: number;
  sequence: number;
  hasPositionSnapshot?: boolean;
  positionX?: number;
  positionY?: number;
  positionZ?: number;
}

/** 外部玩法选择的同地图死亡恢复点；MMORPG层只负责有限值、地图边界和导航投影校验。 */
export interface DeadPlayerReleaseRequest {
  readonly recoveryPosition?: Readonly<{
    x: number;
    y: number;
    z: number;
    yaw: number;
  }>;
}

export interface PlayerUnit {
  CastSkill(skillId: number, targetUnitId: number): M2C_CastSkill;
  InspectLootMonster(monsterId: number): M2C_InspectLootMonster;
  LootMonster(monsterId: number, operationId: string, dropId: number, lootAll: boolean): Promise<M2C_LootMonster>;
  ReleaseDeadPlayer(request?: DeadPlayerReleaseRequest): M2C_ReleaseDeadPlayer;
  RevivePlayer(): M2C_RevivePlayer;
}

/** 玩家权威业务跨await保持串行；Gate连接和无状态入口不继承这个边界。 / Keeps authoritative player work serialized across awaits without imposing this boundary on Gate sessions or stateless entry scenes. */
@actor({ mailbox: "ordered" })
@lifecycle({ awake: true })
export class PlayerUnit extends ActorUnit<[request: AwakePlayerUnit]> {
  protected account = "";
  protected characterId = 0n;
  protected playerConfigId = 0;
  protected mapId = 0;
  protected mapInstanceId = 0n;

  get Account(): string {
    return this.account;
  }

  get CharacterId(): bigint {
    return this.characterId;
  }

  get PlayerConfigId(): number {
    return this.playerConfigId;
  }

  get MapId(): number {
    return this.mapId;
  }

  get MapInstanceId(): bigint {
    return this.mapInstanceId;
  }

}
