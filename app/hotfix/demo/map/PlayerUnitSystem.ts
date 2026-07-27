import {
  type AwakePlayerUnit,
  type MatchPlayerGate,
  NativeData,
  NativeUnitRef,
  NumericComponent,
  PlayerPersistenceComponent,
  type PlayerSnapshot,
  PlayerUnit,
  PositionComponent,
  type RebindPlayerGate,
  type MovePlayer,
  UnitGateComponent,
  systemFor,
} from "#tiangz/model";

/** 承载 PlayerUnit 的可热更业务行为；该类不会创建实例或保存状态。 / Hosts hot-reloadable PlayerUnit behavior; this class is never instantiated and owns no state. */
@systemFor(PlayerUnit)
export class PlayerUnitSystem extends PlayerUnit {
  /** 初始化稳定身份；组件组合仍由 MapComponent 工厂负责。 / Initializes stable identity while MapComponent remains responsible for Component composition. */
  protected override Awake(request: AwakePlayerUnit): void {
    this.account = request.account;
    this.mapId = request.mapId;
  }

  /** 只持久化本玩家一次；重复断线或停机路径共享同一个保存 Promise。 / Persists this player once; repeated disconnect and stop paths share the same save Promise. */
  Offline(reason: string): Promise<void> {
    return this.GetComponent(PlayerPersistenceComponent).SaveOnOffline(reason);
  }

  /** 重连后替换 Gate 所有权，并停止旧 Session 遗留的移动。 / Replaces Gate ownership after reconnect and stops movement inherited from the stale session. */
  RebindGate(request: RebindPlayerGate): PlayerSnapshot {
    this.GetComponent(UnitGateComponent).bind(request.gateName, request.gateSessionId);
    NativeData.ResetMovement(this.GetComponent(NativeUnitRef).Handle);
    return this.Snapshot();
  }

  /** 将 Rust 权威状态与 TS 所有权元数据投影为只读传输对象。 / Projects Rust-authoritative state and TS ownership metadata into a read-only transfer object. */
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

  /** 校验断线消息，防止旧 Gate Session 移除已重新绑定的玩家。 / Guards disconnect messages so a stale Gate session cannot remove a rebound player. */
  MatchesGate(request: MatchPlayerGate): boolean {
    return this.GetComponent(UnitGateComponent).matches(request.gateName, request.gateSessionId);
  }

  /** 校验方向并写入 Rust 权威移动意图；不会在 Handler 内直接推进坐标或广播。 / Validates direction and writes Rust-authoritative movement intent without advancing or broadcasting inside the Handler. */
  Move(request: MovePlayer): boolean {
    validateMoveInput(request);
    return NativeData.SetMovementInput(
      this.GetComponent(NativeUnitRef).Handle,
      request.inputX,
      request.inputY,
      request.sequence,
    );
  }
}

/** 拒绝非离散方向输入，避免无效意图进入 Rust 权威状态。 / Rejects non-discrete directions before invalid intent reaches Rust-authoritative state. */
function validateMoveInput(request: MovePlayer): void {
  if (
    !Number.isInteger(request.inputX) ||
    !Number.isInteger(request.inputY) ||
    Math.abs(request.inputX) > 1 ||
    Math.abs(request.inputY) > 1
  ) {
    throw new Error(`invalid movement input: ${request.inputX},${request.inputY}`);
  }
}
