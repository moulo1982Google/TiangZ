import {
  type AwakePlayerUnit,
  type DeadPlayerReleaseRequest,
  type FindNavigationPath,
  type NavigatePlayerTo,
  type NavigatePlayerInput,
  type MatchPlayerGate,
  DirectionalMovementProfileComponent,
  NativeData,
  NativeUnitRef,
  NumericComponent,
  NumericType,
  NUMERIC_MOVE_SPEED_SCALE,
  PlayerPersistenceComponent,
  type PlayerSnapshot,
  type M2G_TransferPlayer,
  type M2C_AttackMonster,
  type M2C_InspectLootMonster,
  type M2C_LootMonster,
  type M2C_ReleaseDeadPlayer,
  type M2C_RevivePlayer,
  type M2C_ToggleAutoAttack,
  type M2C_CastSkill,
  type AutoAttackState,
  CombatComponent,
  CombatStateComponent,
  CurrencyComponent,
  MonsterComponent,
  MonsterUnit,
  NpcComponent,
  NpcUnit,
  UnitComponent,
  GameErrCode,
  MapComponent,
  PlayerUnit,
  PositionComponent,
  RpcError,
  resolveFacingRelativeGridInput,
  SpatialMode,
  SkillComponent,
  TimeSystem,
  type SkillCastState,
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
    if (request.characterId <= 0n) throw new Error("player characterId must be positive");
    this.characterId = request.characterId;
    if (!Number.isSafeInteger(request.playerConfigId) || request.playerConfigId <= 0) {
      throw new Error("player playerConfigId must be positive");
    }
    this.playerConfigId = request.playerConfigId;
    this.mapId = request.mapId;
    this.mapInstanceId = request.mapInstanceId;
  }

  /** 返回Rust权威存活状态的业务只读投影；外部规则不得直接读取NativeUnitRef。 / Returns the business read-only projection of Rust-authoritative liveness so external rules never read NativeUnitRef directly. */
  IsAlive(): boolean {
    return this.GetComponent(NativeUnitRef).alive !== 0;
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
      characterId: this.characterId,
      mapId: this.mapId,
      mapInstanceId: this.mapInstanceId,
      unitId: this.UnitId,
      gateName: gate.gateName,
      gateEpoch: gate.gateEpoch,
      speedCellsPerSecond: native.speedCellsPerSecond,
      facing: native.facing,
      alive: native.alive !== 0,
      gold: this.GetComponent(CurrencyComponent).Gold,
      numerics: this.GetComponent(NumericComponent).Snapshot(),
      ...position,
    };
  }

  /** 校验最终下线命令来自玩家长期绑定的Gate实例。 / Verifies that final offline originates from the player's stable Gate instance. */
  MatchesGate(request: MatchPlayerGate): boolean {
    return this.GetComponent(UnitGateComponent).matches(request.gateName, request.gateEpoch);
  }

  /** 校验方向并写入 Rust 权威移动意图；不会在 Handler 内直接推进坐标或广播。 / Validates direction and writes Rust-authoritative movement intent without advancing or broadcasting inside the Handler. */
  Move(request: MovePlayer): boolean {
    const map = this.DomainScene().TryGetComponent(MapComponent);
    if (map && map.SpatialProfile.spatialMode !== SpatialMode.Grid2D) {
      throw new Error(
        `C2M_Move is a Grid2D input protocol and cannot drive NavMesh3D map ${this.mapId}`,
      );
    }
    validateMoveInput(request);
    if (request.inputX !== 0 || request.inputZ !== 0) {
      this.GetComponent(SkillComponent).InterruptByMovement();
    }
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
    if (this.DomainScene().GetComponent(MapComponent).SpatialProfile.spatialMode !== SpatialMode.NavMesh3D) {
      throw new Error(`C2M_NavigateTo cannot drive Grid2D map ${this.mapId}`);
    }
    validateNavigationPoint(request.targetX, request.targetY, request.targetZ, "target");
    if (!Number.isSafeInteger(request.sequence) || request.sequence <= 0) {
      throw new Error(`invalid navigation sequence: ${request.sequence}`);
    }
    this.GetComponent(SkillComponent).InterruptByMovement();
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
    if (request.forward !== 0 || request.strafe !== 0) {
      this.GetComponent(SkillComponent).InterruptByMovement();
    }
    const baseSpeedMetersPerSecond = Number(
      this.GetComponent(NumericComponent)[NumericType.MoveSpeed],
    ) / NUMERIC_MOVE_SPEED_SCALE;
    const position = this.GetComponent(PositionComponent);
    position.SpeedMetersPerSecond = this
      .GetComponent(DirectionalMovementProfileComponent)
      .ResolveSpeedMetersPerSecond(
        baseSpeedMetersPerSecond,
        request.forward,
        request.strafe,
      );
    const map = this.DomainScene().GetComponent(MapComponent);
    const externalSnapshots = map.SpatialProfile.externalMovementSnapshots;
    if (externalSnapshots) {
      if (!request.hasPositionSnapshot) {
        throw new Error(`map ${this.mapId} requires an external movement position snapshot`);
      }
      return applyExternalGridMovementSnapshot(
        this,
        request,
        externalSnapshots.maxDeltaMeters,
        map.SpatialProfile.cellSizeMeters,
      );
    }
    if (request.hasPositionSnapshot) {
      throw new Error(`map ${this.mapId} does not accept external movement position snapshots`);
    }
    if (map.SpatialProfile.spatialMode === SpatialMode.Grid2D) {
      const input = resolveFacingRelativeGridInput(request.forward, request.strafe, request.yaw);
      position.yaw = request.yaw;
      const native = this.GetComponent(NativeUnitRef);
      const accepted = NativeData.SetMovementInput(
        native.Handle,
        input.inputX,
        input.inputZ,
        request.sequence,
      );
      return {
        acknowledgedSequence: accepted ? request.sequence : native.sequence,
        points: [],
      };
    }
    return NativeData.SetNavigationInput(
      map.NativeMapKey,
      this.GetComponent(NativeUnitRef).Handle,
      request.forward,
      request.strafe,
      request.yaw,
      request.sequence,
    );
  }

  /**
   * 将死亡玩家移动到调用方选择且经过当前地图校验的恢复点；没有选择时使用地图默认点。
   * 该阶段保持死亡和零生命，墓地选择、尸体与幽灵规则仍属于外部玩法模块。
   *
   * Moves a dead player to a caller-selected, map-validated recovery point or
   * the map default. Death and zero health are preserved; game-specific
   * graveyard, corpse, and ghost rules stay outside this domain.
   */
  ReleaseDeadPlayer(request: DeadPlayerReleaseRequest = {}): M2C_ReleaseDeadPlayer {
    const native = this.GetComponent(NativeUnitRef);
    const numeric = this.GetComponent(NumericComponent);
    const position = this.GetComponent(PositionComponent);
    if (native.alive !== 0) return releaseSnapshot(false, position, numeric);
    prepareRecoveryTransition(this, "player-death-release");
    relocateToRecoveryPoint(this, request.recoveryPosition);
    return releaseSnapshot(true, position, numeric);
  }

  /** 在当前权威坐标复活；位置由死亡释放阶段或其他上层玩法提前决定。 / Revives at the current authoritative position selected by an earlier release or another gameplay layer. */
  RevivePlayer(): M2C_RevivePlayer {
    const native = this.GetComponent(NativeUnitRef);
    const numeric = this.GetComponent(NumericComponent);
    const position = this.GetComponent(PositionComponent);
    if (native.alive !== 0) return reviveSnapshot(false, position, numeric);

    prepareRecoveryTransition(this, "player-revive");

    numeric[NumericType.CurrentHp] = restoreHalf(numeric[NumericType.MaxHp]);
    numeric[NumericType.CurrentMp] = restoreHalf(numeric[NumericType.MaxMp]);
    native.alive = 1;
    return reviveSnapshot(true, position, numeric);
  }


  /** 业务只提供目标地图实例；静态地图与动态副本使用完全相同的传送调用。 / Business supplies only the target instance; static maps and dynamic dungeons share this exact transfer call. */
  TransferToMap(mapInstanceId: bigint): Promise<M2G_TransferPlayer> {
    const map = this.DomainScene().GetComponent(MapComponent);
    const interrupted = this.GetComponent(SkillComponent).Interrupt("map-transfer");
    if (interrupted) {
      this.DomainScene().Tasks.Spawn("publish-transfer-cast-interrupt", async () => {
        await map.PublishSkillCastState(this, interrupted);
      });
    }
    return map.TransferToMap(this, mapInstanceId);
  }

  /** 把攻击意图交给地图怪物模块；PlayerUnit不保存怪物集合或战斗状态。 / Delegates attack intent to the map monster module; PlayerUnit stores no monster collection or combat state. */
  AttackMonster(monsterId: number): M2C_AttackMonster {
    return this.DomainScene().GetComponent(MonsterComponent).Attack(this, monsterId);
  }

  /** 只查看当前玩家有资格领取的尸体行；不会创建ItemId或提交持久化事务。 / Inspects eligible corpse rows without creating ItemIds or committing persistence. */
  InspectLootMonster(monsterId: number): M2C_InspectLootMonster {
    return this.DomainScene().GetComponent(MonsterComponent).InspectLootMonster(this, monsterId);
  }

  /** 拾取尸体只把意图交给地图掉落模块；资格、数量、幂等和DBProxy提交都在那里完成。 / Delegates corpse loot so the map module owns eligibility, limits, idempotency, and DBProxy commit. */
  LootMonster(monsterId: number, operationId: string, dropId: number, lootAll: boolean): Promise<M2C_LootMonster> {
    return this.DomainScene().GetComponent(MonsterComponent).LootMonster(this, monsterId, operationId, dropId, lootAll);
  }

  /**
   * 只激活或取消玩家的平A意图；目标必须在当前地图且存活。
   * 10Hz战斗桶会再次校验范围和120度朝向，并从零开始推进读条。
   *
   * Toggles the player's auto-attack intent after validating a live target on
   * this map. The 10Hz combat bucket rechecks range and the 120-degree facing
   * cone, then starts every accepted swing from zero.
   */
  ToggleAutoAttack(targetUnitId: number, enabled: boolean): M2C_ToggleAutoAttack {
    const monsterComponent = this.DomainScene().GetComponent(MonsterComponent);
    if (enabled) {
      const target = this.DomainScene().GetComponent(UnitComponent).Get(targetUnitId);
      if (!target) {
        throw new RpcError(GameErrCode.MonsterNotFound, `combat target not found: ${targetUnitId}`);
      }
      if (target.GetComponent(NativeUnitRef).alive === 0) {
        throw new RpcError(GameErrCode.MonsterDead, `combat target is dead: ${targetUnitId}`);
      }
      const attackable = target instanceof MonsterUnit
        ? monsterComponent.CanPlayerAttack(this, target)
        : target instanceof NpcUnit
          ? this.DomainScene().GetComponent(NpcComponent).CanPlayerAttack(this, target)
          : false;
      if (!attackable) {
        throw new RpcError(
          GameErrCode.SkillTargetInvalid,
          `unit ${targetUnitId} is not attackable by player config ${this.PlayerConfigId}`,
        );
      }
    }
    const combat = this.GetComponent(CombatComponent);
    combat.SetAutoAttackInterval(readAttackIntervalMs(this.GetComponent(NumericComponent)));
    const state = combat.ToggleAutoAttack(targetUnitId, enabled);
    const map = this.DomainScene().GetComponent(MapComponent);
    this.DomainScene().Tasks.Spawn("publish-auto-attack-state", async () => {
      await map.PublishAutoAttackState(this, state);
    });
    return toAutoAttackResponse(state);
  }

  /** 提交一次权威施法；目标、距离、GCD和CD都由地图技能桶同步校验。 / Submits an authoritative cast validated synchronously by the map skill scheduler. */
  CastSkill(skillId: number, targetUnitId: number): M2C_CastSkill {
    return toCastSkillResponse(this.GetComponent(SkillComponent).Cast({ skillId, targetUnitId }));
  }
}

function readAttackIntervalMs(numeric: NumericComponent): number {
  const value = Number(numeric[NumericType.AttackSpeed]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`AttackSpeed must be a positive integer in milliseconds: ${value}`);
  }
  return value;
}

function toAutoAttackResponse(state: AutoAttackState): M2C_ToggleAutoAttack {
  return {
    enabled: state.enabled,
    targetUnitId: state.targetUnitId,
    phase: state.phase,
    swingStartAtMs: BigInt(Math.max(0, Math.floor(state.swingStartAtMs))),
    swingIntervalMs: state.swingIntervalMs,
  };
}

function toCastSkillResponse(state: SkillCastState): M2C_CastSkill {
  return {
    phase: state.phase,
    castId: state.castId,
    skillId: state.skillId,
    targetUnitId: state.targetUnitId,
    startedAtMs: BigInt(Math.max(0, Math.floor(state.startedAtMs))),
    finishAtMs: BigInt(Math.max(0, Math.floor(state.finishAtMs))),
    globalCooldownEndAtMs: BigInt(Math.max(0, Math.floor(state.globalCooldownEndAtMs))),
    skillCooldownEndAtMs: BigInt(Math.max(0, Math.floor(state.skillCooldownEndAtMs))),
    interruptReason: state.interruptReason,
    channelTickIndex: state.channelTickIndex,
    channelTickCount: state.channelTickCount,
    queuedSkillId: state.queuedSkillId,
    queuedTargetUnitId: state.queuedTargetUnitId,
    queueDeadlineAtMs: BigInt(Math.max(0, Math.floor(state.queueDeadlineAtMs))),
  };
}

function prepareRecoveryTransition(player: PlayerUnit, interruptReason: string): void {
  const native = player.GetComponent(NativeUnitRef);
  NativeData.ResetMovement(native.Handle);
  player.GetComponent(CombatStateComponent).Clear(TimeSystem.Instance.ServerNow);
  player.GetComponent(CombatComponent).ToggleAutoAttack(0, false);
  player.GetComponent(SkillComponent).Interrupt(interruptReason);
}

function relocateToRecoveryPoint(
  player: PlayerUnit,
  requested: DeadPlayerReleaseRequest["recoveryPosition"],
): void {
  const position = player.GetComponent(PositionComponent);
  const map = player.DomainScene().GetComponent(MapComponent);
  const spatial = map.SpatialProfile;
  const recovery = requested ?? {
    x: spatial.spawnX,
    y: spatial.spawnY,
    z: spatial.spawnZ,
    yaw: spatial.spawnYaw,
  };
  if (![recovery.x, recovery.y, recovery.z, recovery.yaw].every(Number.isFinite)) {
    throw new Error("death recovery position must contain finite x/y/z/yaw");
  }

  if (spatial.spatialMode === SpatialMode.Grid2D) {
    position.SetGridWorldPosition(
      recovery.x,
      recovery.y,
      recovery.z,
      recovery.yaw,
    );
    return;
  }
  const projected = map.ProjectPosition({
    x: recovery.x,
    y: recovery.y,
    z: recovery.z,
  });
  if (!projected) throw new Error("map recovery point is outside NavMesh");
  position.SetNavMeshWorldPosition(projected.x, projected.y, projected.z, recovery.yaw);
}

function releaseSnapshot(
  released: boolean,
  position: PositionComponent,
  numeric: NumericComponent,
): M2C_ReleaseDeadPlayer {
  return {
    released,
    x: position.x,
    y: position.y,
    z: position.z,
    yaw: position.yaw,
    health: numeric[NumericType.CurrentHp],
    maxHealth: numeric[NumericType.MaxHp],
    mana: numeric[NumericType.CurrentMp],
    maxMana: numeric[NumericType.MaxMp],
  };
}

function reviveSnapshot(
  revived: boolean,
  position: PositionComponent,
  numeric: NumericComponent,
): M2C_RevivePlayer {
  return {
    revived,
    x: position.x,
    y: position.y,
    z: position.z,
    yaw: position.yaw,
    health: numeric[NumericType.CurrentHp],
    maxHealth: numeric[NumericType.MaxHp],
    mana: numeric[NumericType.CurrentMp],
    maxMana: numeric[NumericType.MaxMp],
  };
}

/**
 * 把外部网关的碰撞后位置量化到当前Grid，并在进入Rust前限制单次位移；具体协议和坐标原点留在网关。
 * Quantizes a gateway's collision-resolved position to the current Grid and
 * bounds each accepted delta before Rust; protocol and world origin remain in the gateway.
 */
function applyExternalGridMovementSnapshot(
  player: PlayerUnit,
  request: NavigatePlayerInput,
  maxDeltaMeters: number,
  cellSizeMeters: number,
): { acknowledgedSequence: number; points: readonly { x: number; y: number; z: number }[] } {
  const x = request.positionX;
  const y = request.positionY;
  const z = request.positionZ;
  if (![x, y, z].every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error("external movement position snapshot must contain finite x/y/z");
  }
  const position = player.GetComponent(PositionComponent);
  const cellX = Math.round(x! / cellSizeMeters);
  const cellZ = Math.round(z! / cellSizeMeters);
  if (!position.CanOccupy(cellX, cellZ)) {
    throw new Error(`external movement position snapshot is outside map: ${x},${y},${z}`);
  }
  const projectedX = cellX * cellSizeMeters;
  const projectedZ = cellZ * cellSizeMeters;
  const deltaMeters = Math.hypot(projectedX - position.x, y! - position.y, projectedZ - position.z);
  if (deltaMeters > maxDeltaMeters) {
    throw new Error(
      `external movement position snapshot delta ${deltaMeters.toFixed(3)} exceeds ${maxDeltaMeters}`,
    );
  }
  const native = player.GetComponent(NativeUnitRef);
  const accepted = NativeData.ApplyGridMovementSnapshot(
    native.Handle,
    cellX,
    y!,
    cellZ,
    request.yaw,
    request.forward !== 0 || request.strafe !== 0,
    request.sequence,
  );
  return {
    acknowledgedSequence: accepted ? request.sequence : native.sequence,
    points: [],
  };
}

/** 50%向上取整，保证正上限资源不会恢复成0。 / Restores half rounded up so a positive maximum never revives at zero. */
function restoreHalf(maximum: bigint): bigint {
  return maximum <= 0n ? 0n : (maximum + 1n) / 2n;
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
