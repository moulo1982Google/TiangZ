import { Unit, actor, lifecycle } from "../../../core/public";
import type { UnitNumericDelta } from "../../../generated/model/server/demo/protocol/messages";

export interface AwakePlayerUnit {
  account: string;
  mapId: number;
  mapInstanceId: bigint;
}

export interface MatchPlayerGate {
  gateName: string;
}

export interface PlayerSnapshot {
  account: string;
  mapId: number;
  mapInstanceId: bigint;
  unitId: number;
  gateName: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  cellX: number;
  cellZ: number;
  speedCellsPerSecond: number;
  facing: number;
  alive: boolean;
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

/** 玩家权威业务跨await保持串行；Gate连接和无状态入口不继承这个边界。 / Keeps authoritative player work serialized across awaits without imposing this boundary on Gate sessions or stateless entry scenes. */
@actor({ mailbox: "ordered" })
@lifecycle({ awake: true })
export class PlayerUnit extends Unit<[request: AwakePlayerUnit]> {
  protected account = "";
  protected mapId = 0;
  protected mapInstanceId = 0n;

  get Account(): string {
    return this.account;
  }

  get MapId(): number {
    return this.mapId;
  }

  get MapInstanceId(): bigint {
    return this.mapInstanceId;
  }

}
