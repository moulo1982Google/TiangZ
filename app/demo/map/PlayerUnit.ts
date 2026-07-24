import { actor, Unit } from "../../core/runtime";
import { NativeUnitRef } from "../../generated/model/native/NativeUnitRef";
import { NativeData } from "../native/NativeData";
import { PositionComponent } from "./PositionComponent";
import { UnitGateComponent } from "./UnitGateComponent";
import { NumericComponent } from "../numeric/NumericComponent";
import type { UnitNumericDelta } from "../../generated/model/server/demo/protocol/messages";
import { PlayerPersistenceComponent } from "../persistence/PlayerPersistenceComponent";

export interface AwakePlayerUnit {
  account: string;
  mapId: number;
}

export interface RebindPlayerGate {
  gateName: string;
  gateSessionId: string;
}

export interface MatchPlayerGate {
  gateName: string;
  gateSessionId: string;
}

export interface PlayerSnapshot {
  account: string;
  mapId: number;
  unitId: number;
  gateName: string;
  gateSessionId: string;
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

@actor({ mailbox: "ordered" })
export class PlayerUnit extends Unit<[request: AwakePlayerUnit]> {
  private account = "";
  private mapId = 0;

  get Account(): string {
    return this.account;
  }

  get MapId(): number {
    return this.mapId;
  }

  Offline(reason: string): Promise<void> {
    return this.GetComponent(PlayerPersistenceComponent).SaveOnOffline(reason);
  }

  protected override Awake(request: AwakePlayerUnit): void {
    this.account = request.account;
    this.mapId = request.mapId;
  }

  RebindGate(request: RebindPlayerGate): PlayerSnapshot {
    this.GetComponent(UnitGateComponent).bind(
      request.gateName,
      request.gateSessionId,
    );
    this.ResetMovement();
    return this.Snapshot();
  }

  Snapshot(): PlayerSnapshot {
    const position = this.GetComponent(PositionComponent).snapshot();
    const gate = this.GetComponent(UnitGateComponent);
    const native = this.GetComponent(NativeUnitRef);
    return {
      account: this.account,
      mapId: this.mapId,
      unitId: this.UnitId,
      gateName: gate.gateName,
      gateSessionId: gate.gateSessionId,
      speedCellsPerSecond: native.speedCellsPerSecond,
      facing: native.facing,
      alive: native.alive !== 0,
      numerics: this.GetComponent(NumericComponent).Snapshot(),
      ...position,
    };
  }

  MatchesGate(request: MatchPlayerGate): boolean {
    return this.GetComponent(UnitGateComponent).matches(
      request.gateName,
      request.gateSessionId,
    );
  }

  Move(request: MovePlayer): boolean {
    this.validateMoveInput(request);
    return NativeData.SetMovementInput(
      this.GetComponent(NativeUnitRef).Handle,
      request.inputX,
      request.inputY,
      request.sequence,
    );
  }

  private ResetMovement(): void {
    NativeData.ResetMovement(this.GetComponent(NativeUnitRef).Handle);
  }

  private validateMoveInput(request: MovePlayer): void {
    if (
      !Number.isInteger(request.inputX) ||
      !Number.isInteger(request.inputY) ||
      Math.abs(request.inputX) > 1 ||
      Math.abs(request.inputY) > 1
    ) {
      throw new Error(
        `invalid movement input: ${request.inputX},${request.inputY}`,
      );
    }
  }
}
