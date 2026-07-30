import { Unit, lifecycle } from "../../../core/public";
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
  cellX: number;
  cellY: number;
  speedCellsPerSecond: number;
  facing: number;
  alive: boolean;
  numerics: readonly UnitNumericDelta[];
}

export interface MovePlayer {
  inputX: number;
  inputY: number;
  sequence: number;
}

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
