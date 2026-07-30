import {
  type AwakePlayerUnit,
  type MatchPlayerGate,
  NativeData,
  NativeUnitRef,
  NumericComponent,
  PlayerPersistenceComponent,
  type PlayerSnapshot,
  type M2G_TransferPlayer,
  MapComponent,
  PlayerUnit,
  PositionComponent,
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
    this.mapInstanceId = request.mapInstanceId;
  }

  /** 只持久化本玩家一次；重复断线或停机路径共享同一个保存 Promise。 / Persists this player once; repeated disconnect and stop paths share the same save Promise. */
  Offline(reason: string): Promise<void> {
    return this.GetComponent(PlayerPersistenceComponent).SaveOnOffline(reason);
  }

  /** 重连时停止旧连接遗留的移动输入并返回权威快照；不会改变Gate归属。 / Stops stale movement on reconnect and returns an authoritative snapshot without changing Gate ownership. */
  SecondEnterMap(): PlayerSnapshot {
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
      mapInstanceId: this.mapInstanceId,
      unitId: this.UnitId,
      gateName: gate.gateName,
      speedCellsPerSecond: native.speedCellsPerSecond,
      facing: native.facing,
      alive: native.alive !== 0,
      numerics: this.GetComponent(NumericComponent).Snapshot(),
      ...position,
    };
  }

  /** 校验最终下线命令来自玩家长期绑定的Gate实例。 / Verifies that final offline originates from the player's stable Gate instance. */
  MatchesGate(request: MatchPlayerGate): boolean {
    return this.GetComponent(UnitGateComponent).matches(request.gateName);
  }

  /** 校验方向并写入 Rust 权威移动意图；不会在 Handler 内直接推进坐标或广播。 / Validates direction and writes Rust-authoritative movement intent without advancing or broadcasting inside the Handler. */
  Move(request: MovePlayer): boolean {
    validateMoveInput(request);
    return NativeData.SetMovementInput(
      this.GetComponent(NativeUnitRef).Handle,
      request.inputX,
      request.inputZ,
      request.sequence,
    );
  }

  /** 业务只提供目标地图实例；静态地图与动态副本使用完全相同的传送调用。 / Business supplies only the target instance; static maps and dynamic dungeons share this exact transfer call. */
  TransferToMap(mapInstanceId: bigint): Promise<M2G_TransferPlayer> {
    return this.DomainScene().GetComponent(MapComponent).TransferToMap(this, mapInstanceId);
  }
}

/** 拒绝非离散方向输入，避免无效意图进入 Rust 权威状态。 / Rejects non-discrete directions before invalid intent reaches Rust-authoritative state. */
function validateMoveInput(request: MovePlayer): void {
  if (
    !Number.isInteger(request.inputX) ||
    !Number.isInteger(request.inputZ) ||
    Math.abs(request.inputX) > 1 ||
    Math.abs(request.inputZ) > 1
  ) {
    throw new Error(`invalid movement input: ${request.inputX},${request.inputZ}`);
  }
}
