import { actor, handler, Unit } from "../../core/runtime";
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
  lastMoveSequence: number;
}

export interface MovePlayer {
  inputX: number;
  inputY: number;
  sequence: number;
}

export interface PlayerMoveResult {
  accepted: boolean;
  snapshot: PlayerSnapshot;
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
    this.GetComponent(MovementComponent).reset();
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
      x: position.x,
      y: position.y,
      lastMoveSequence: this.GetComponent(MovementComponent).lastSequence,
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
  Move(request: MovePlayer): PlayerMoveResult {
    this.validateMoveInput(request);

    const seconds = this.GetComponent(MovementComponent).consumeStepSeconds(
      request.sequence,
      Date.now(),
    );
    if (seconds === undefined) {
      return { accepted: false, snapshot: this.Snapshot() };
    }

    this.GetComponent(PositionComponent).applyInput(
      request.inputX,
      request.inputY,
      seconds,
    );
    return { accepted: true, snapshot: this.Snapshot() };
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
