import {
  type AwakePlayerUnit,
  type FindNavigationPath,
  type NavigatePlayerTo,
  type NavigatePlayerInput,
  type MatchPlayerGate,
  NativeData,
  NativeUnitRef,
  NumericComponent,
  PlayerPersistenceComponent,
  type PlayerSnapshot,
  type M2G_TransferPlayer,
  GameConfigs,
  MapComponent,
  PlayerUnit,
  PositionComponent,
  SpatialMode,
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
    if (GameConfigs.MapConfig.Get(this.mapId).spatialMode !== SpatialMode.Grid2D) {
      throw new Error(
        `C2M_Move is a Grid2D input protocol and cannot drive NavMesh3D map ${this.mapId}`,
      );
    }
    validateMoveInput(request);
    return NativeData.SetMovementInput(
      this.GetComponent(NativeUnitRef).Handle,
      request.inputX,
      request.inputZ,
      request.sequence,
    );
  }

  /** 查询本地图NavMesh路径但不修改权威坐标；用于编辑器预览和移动协议上层决策。 / Queries this map's NavMesh without mutating authoritative position for previews and movement orchestration. */
  FindPath(request: FindNavigationPath): readonly { x: number; y: number; z: number }[] {
    validateNavigationPoint(request.startX, request.startY, request.startZ, "start");
    validateNavigationPoint(request.targetX, request.targetY, request.targetZ, "target");
    return this.DomainScene().GetComponent(MapComponent).FindPath(
      { x: request.startX, y: request.startY, z: request.startZ },
      { x: request.targetX, y: request.targetY, z: request.targetZ },
    );
  }

  /** 设置NavMesh3D权威移动目标；Rust持有路径并在固定Tick推进，返回路径仅供发起客户端预测。 / Sets an authoritative NavMesh target; Rust owns and advances the path while the returned path is only for initiating prediction. */
  NavigateTo(request: NavigatePlayerTo): {
    acknowledgedSequence: number;
    points: readonly { x: number; y: number; z: number }[];
  } {
    if (GameConfigs.MapConfig.Get(this.mapId).spatialMode !== SpatialMode.NavMesh3D) {
      throw new Error(`C2M_NavigateTo cannot drive Grid2D map ${this.mapId}`);
    }
    validateNavigationPoint(request.targetX, request.targetY, request.targetZ, "target");
    if (!Number.isSafeInteger(request.sequence) || request.sequence <= 0) {
      throw new Error(`invalid navigation sequence: ${request.sequence}`);
    }
    return NativeData.SetNavigationTarget(
      this.DomainScene().GetComponent(MapComponent).NativeMapKey,
      this.GetComponent(NativeUnitRef).Handle,
      { x: request.targetX, y: request.targetY, z: request.targetZ },
      request.sequence,
    );
  }

  /** 设置相对角色朝向的方向移动；Rust负责寻路、停止和权威推进，TS不保存按键状态。 / Sets facing-relative movement while Rust owns pathing, stopping, and authoritative advancement; TS stores no key state. */
  NavigateInput(request: NavigatePlayerInput): {
    acknowledgedSequence: number;
    points: readonly { x: number; y: number; z: number }[];
  } {
    if (GameConfigs.MapConfig.Get(this.mapId).spatialMode !== SpatialMode.NavMesh3D) {
      throw new Error(`C2M_NavigateInput cannot drive Grid2D map ${this.mapId}`);
    }
    if (
      !Number.isInteger(request.forward) ||
      !Number.isInteger(request.strafe) ||
      Math.abs(request.forward) > 1 ||
      Math.abs(request.strafe) > 1 ||
      !Number.isFinite(request.yaw) ||
      !Number.isSafeInteger(request.sequence) ||
      request.sequence <= 0
    ) {
      throw new Error("invalid NavMesh direction input");
    }
    return NativeData.SetNavigationInput(
      this.DomainScene().GetComponent(MapComponent).NativeMapKey,
      this.GetComponent(NativeUnitRef).Handle,
      request.forward,
      request.strafe,
      request.yaw,
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

/** 在请求进入Rust前拒绝NaN与Infinity，避免无效坐标污染跨语言边界。 / Rejects NaN and Infinity before invalid coordinates cross into Rust. */
function validateNavigationPoint(x: number, y: number, z: number, label: string): void {
  if (![x, y, z].every(Number.isFinite)) {
    throw new Error(`invalid ${label} navigation point: ${x},${y},${z}`);
  }
}
