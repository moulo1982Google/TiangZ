import { Unit, lifecycle } from "../../../core/public";
import type { UnitNumericDelta } from "../../../generated/model/server/demo/protocol/messages";

export interface AwakePlayerUnit {
  account: string;
  mapId: number;
}

export interface MatchPlayerGate {
  gateName: string;
}

export interface PlayerSnapshot {
  account: string;
  mapId: number;
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

  get Account(): string {
    return this.account;
  }

  get MapId(): number {
    return this.mapId;
  }

}
