import { Unit } from "../../core/public";
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

export class PlayerUnit extends Unit<[request: AwakePlayerUnit]> {
  private account = "";
  private mapId = 0;

  get Account(): string {
    return this.account;
  }

  get MapId(): number {
    return this.mapId;
  }

  /** 只持久化本玩家一次；重复断线或停机路径共享同一个保存 Promise。 / Persists this player once; repeated disconnect/stop paths share the same save Promise. */
  Offline(reason: string): Promise<void> {
    return this.GetComponent(PlayerPersistenceComponent).SaveOnOffline(reason);
  }

  /** 只初始化身份；游戏组件组合由工厂负责。 / Initializes identity only; the factory is responsible for composing gameplay components. */
  protected override Awake(request: AwakePlayerUnit): void {
    this.account = request.account;
    this.mapId = request.mapId;
  }

  /** 重连后替换 Gate 所有权，并停止旧 Session 遗留的移动。 / Replaces Gate ownership after reconnect and stops movement inherited from the stale session. */
  RebindGate(request: RebindPlayerGate): PlayerSnapshot {
    this.GetComponent(UnitGateComponent).bind(
      request.gateName,
      request.gateSessionId,
    );
    this.ResetMovement();
    return this.Snapshot();
  }

  /** 将 Rust 权威状态与 TS 所有权元数据投影为只读传输对象。 / Projects Rust-authoritative state plus TS ownership metadata into a read-only transfer object. */
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

  /** 校验断线消息，防止旧 Gate Session 移除已重新绑定的玩家。 / Guards disconnect messages so an old Gate session cannot remove a newly rebound player. */
  MatchesGate(request: MatchPlayerGate): boolean {
    return this.GetComponent(UnitGateComponent).matches(
      request.gateName,
      request.gateSessionId,
    );
  }

  /** 校验输入并更新 Rust 移动意图；本函数不会立即移动或广播。 / Validates input and updates Rust movement intent; it does not broadcast or move immediately. */
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
