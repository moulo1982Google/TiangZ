import { actor, handler, Unit } from "../../core/runtime";
import { NativeUnitRef } from "../../generated/model/native/NativeUnitRef";
import type { MovementFrame } from "../movement";
import { MovementComponent } from "./MovementComponent";
import { PositionComponent } from "./PositionComponent";
import { UnitGateComponent } from "./UnitGateComponent";

export const PlayerUnitHandlers = {
  RebindGate: "Player.RebindGate",
  Snapshot: "Player.Snapshot",
  MatchesGate: "Player.MatchesGate",
  Move: "Player.Move",
} as const;

export interface AwakePlayerUnit {
  account: string;
  token: string;
  mapId: number;
}

export interface RebindPlayerGate {
  token: string;
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
}

export interface MovePlayer {
  inputX: number;
  inputY: number;
  sequence: number;
}

@actor({ mailbox: "ordered" })
export class PlayerUnit extends Unit<[request: AwakePlayerUnit]> {
  private account = "";
  private token = "";
  private mapId = 0;

  get Account(): string {
    return this.account;
  }

  get MapId(): number {
    return this.mapId;
  }

  protected override Awake(request: AwakePlayerUnit): void {
    this.account = request.account;
    this.token = request.token;
    this.mapId = request.mapId;
  }

  @handler(PlayerUnitHandlers.RebindGate)
  RebindGate(request: RebindPlayerGate): PlayerSnapshot {
    this.token = request.token;
    this.GetComponent(UnitGateComponent).bind(
      request.gateName,
      request.gateSessionId,
    );
    this.ResetMovement();
    return this.Snapshot();
  }

  @handler(PlayerUnitHandlers.Snapshot)
  Snapshot(): PlayerSnapshot {
    const position = this.GetComponent(PositionComponent).snapshot();
    const gate = this.GetComponent(UnitGateComponent);
    return {
      account: this.account,
      mapId: this.mapId,
      unitId: this.UnitId,
      gateName: gate.gateName,
      gateSessionId: gate.gateSessionId,
      ...position,
    };
  }

  @handler(PlayerUnitHandlers.MatchesGate)
  MatchesGate(request: MatchPlayerGate): boolean {
    return this.GetComponent(UnitGateComponent).matches(
      request.gateName,
      request.gateSessionId,
    );
  }

  @handler(PlayerUnitHandlers.Move)
  Move(request: MovePlayer): boolean {
    this.validateMoveInput(request);
    const native = this.TryGetComponent(NativeUnitRef);
    return native
      ? native.SetMovementInput(request.inputX, request.inputY, request.sequence)
      : this.GetComponent(MovementComponent).SetInput(
          request.inputX,
          request.inputY,
          request.sequence,
        );
  }

  UpdateMovement(serverTick: number, fixedUpdateMs: number): MovementFrame | undefined {
    const state = this.GetComponent(MovementComponent).UpdateStep(
      serverTick,
      fixedUpdateMs,
    );
    return state ? { unitId: this.UnitId, ...state } : undefined;
  }

  private ResetMovement(): void {
    const native = this.TryGetComponent(NativeUnitRef);
    if (native) {
      native.ResetMovement();
    } else {
      this.GetComponent(MovementComponent).Reset();
    }
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
