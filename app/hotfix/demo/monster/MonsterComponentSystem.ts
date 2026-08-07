import {
  GameConfigs,
  GameErrCode,
  CombatComponent,
  BuffComponent,
  AutoAttackPhase,
  MapAoiComponent,
  MapComponent,
  MonsterComponent,
  MonsterUnit,
  NativeData,
  NativeUnitRef,
  NumericComponent,
  NumericType,
  MoveSpeedMetersPerSecondToNumeric,
  PlayerUnit,
  PositionComponent,
  RpcError,
  SpatialMode,
  SkillComponent,
  TimeSystem,
  UnitComponent,
  type AutoAttackState,
  type DamageRequest,
  type DamageResult,
  type M2C_AttackMonster,
  type MonsterAreaConfigData,
  type MonsterConfigData,
  type MonsterRuntimeState,
  systemFor,
} from "#tiangz/model";
import { MonsterBehaviorTree } from "./MonsterBehaviorTree";

const MONSTER_AGGRO_RANGE_METERS = 12;
const DEMO_PLAYER_CONFIG_ID = 1;
const AUTO_ATTACK_FACING_HALF_ANGLE = Math.PI / 3;
const MONSTER_ID_MAX = 0xffff_ffff;
const monsterBehaviorTree = new MonsterBehaviorTree();

/**
 * 第一版怪物业务：固定刷点、主动索敌、仇恨追击、普通攻击、尸体生命周期和重生。
 * 怪物只作为AOI Subject，不会成为Observer，也不参与动态避障；死亡时停止逻辑但保留Unit和AOI身份，
 * 等待模板配置的复活时间后先清理尸体，再在原刷点创建新的Unit。
 *
 * Version-one monster rules: fixed slots, active acquisition, threat-based
 * chase, basic attacks, death, and respawn. Monsters are AOI Subjects only
 * and never participate in dynamic avoidance. Death retains a non-interactive
 * corpse Unit in AOI; after the template delay that corpse is removed and a
 * new Unit is created at the spawn point.
 */
@systemFor(MonsterComponent)
export class MonsterComponentSystem extends MonsterComponent {
  /** 读取本地图冷刷点，并在地图创建时生成初始怪物。 / Loads cold spawn points and creates initial monsters when the map is created. */
  protected override Awake(map: MapComponent, aoi: MapAoiComponent): void {
    this.map = map;
    this.aoi = aoi;
    const areas = GameConfigs.MonsterAreaConfig.GetAll()
      .filter((area) => area.mapConfigId === map.MapId)
      .sort((left, right) => left.id - right.id);
    for (const config of areas) {
      if (this.slots.has(config.id)) {
        throw new Error(`duplicate monster spawn slot: ${config.id}`);
      }
      const slot = {
        config,
        monster: null,
        respawnAtMs: 0,
      };
      this.slots.set(config.id, slot);
      if (config.initialSpawn) this.Spawn(slot);
    }
    this.DomainScene().logger.info("monster component ready", {
      mapId: map.MapId,
      spawnSlots: areas.length,
      initialMonsters: this.monsters.size,
    });
  }

  /** 10Hz推进玩家自动攻击；一个地图桶统一扫描，避免每个玩家一个Timer。 / Advances player auto-attacks at 10Hz from one map bucket instead of one Timer per player. */
  Update10Hz(): void {
    if (this.map.IsStopping) return;
    const now = TimeSystem.Instance.ServerNow;
    this.TickPlayerAutoAttacks(now);
  }

  /** 5Hz执行主动怪物AI；移动推进仍由Rust的20Hz地图更新负责。 / Runs active monster AI at 5Hz while Rust advances movement at 20Hz. */
  Update5Hz(): void {
    if (this.map.IsStopping) return;
    const now = TimeSystem.Instance.ServerNow;
    for (const slot of this.slots.values()) {
      const monster = slot.monster;
      if (!monster) continue;
      const native = monster.GetComponent(NativeUnitRef);
      if (native.alive === 0) continue;
      const config = slot.config.monsterConfigId_ref
        ?? GameConfigs.MonsterConfig.Get(slot.config.monsterConfigId);
      this.TickMonster(monster, config, now);
    }
  }

  /** 1Hz清理到期尸体并创建新怪物；死亡到清理期间原Unit仍可承接表现事件。 / Removes expired corpses and creates replacement monsters at 1 Hz while retaining the dead Unit for visual events until cleanup. */
  Update1Hz(): void {
    if (this.map.IsStopping) return;
    const now = TimeSystem.Instance.ServerNow;
    for (const slot of this.slots.values()) {
      if (slot.monster && slot.respawnAtMs > 0 && now >= slot.respawnAtMs) {
        void this.Respawn(slot);
      }
    }
  }

  /** 玩家近战攻击一个怪物；伤害、距离和死亡都在同一地图入口完成。 / Resolves one player melee attack, including range, damage, and death on this map. */
  Attack(attacker: PlayerUnit, monsterId: number): M2C_AttackMonster {
    this.RequireMapUnit(attacker);
    const monster = this.monsters.get(monsterId);
    if (!monster) throw new RpcError(GameErrCode.MonsterNotFound, `monster not found: ${monsterId}`);
    const monsterNative = monster.GetComponent(NativeUnitRef);
    if (monsterNative.alive === 0) throw new RpcError(GameErrCode.MonsterDead, `monster is dead: ${monsterId}`);

    const attackerPosition = attacker.GetComponent(PositionComponent);
    const monsterPosition = monster.GetComponent(PositionComponent);
    const playerConfig = GameConfigs.PlayerConfig.Get(DEMO_PLAYER_CONFIG_ID);
    const attackRange = playerConfig.attackRange;
    if (distanceSquared(attackerPosition.x, attackerPosition.z, monsterPosition.x, monsterPosition.z)
      > attackRange * attackRange) {
      throw new RpcError(GameErrCode.MonsterTooFar, `monster is too far: ${monsterId}`);
    }

    const attackerNumeric = attacker.GetComponent(NumericComponent);
    const damage = attackerNumeric[NumericType.Attack] > 0n
      ? attackerNumeric[NumericType.Attack]
      : 0n;
    const result = this.ApplyPlayerDamage(attacker, monster, {
      amount: damage,
      sourceUnitId: attacker.UnitId,
    });
    return {
      monsterId,
      damage: Number(result.finalDamage),
      remainingHp: result.remainingHp,
      killed: result.killed,
    };
  }

  /** 技能和平A共享怪物受伤后的仇恨与死亡边界；调用者不得只改Combat后忘记移除死亡怪。 / Skills and auto-attacks share threat and death handling so callers cannot damage Combat and forget monster removal. */
  ApplyPlayerDamage(
    attacker: PlayerUnit,
    monster: MonsterUnit,
    request: DamageRequest,
  ): DamageResult {
    this.RequireMapUnit(attacker);
    if (this.monsters.get(monster.UnitId) !== monster) {
      throw new RpcError(GameErrCode.MonsterNotFound, `monster not found: ${monster.UnitId}`);
    }
    const result = monster.GetComponent(CombatComponent).ApplyDamage(request);
    this.AddThreat(monster, attacker, result.finalDamage);
    if (result.killed) this.Kill(monster);
    return result;
  }

  /**
   * 给怪物增加仇恨；普通攻击、技能和未来的治疗/嘲讽都应通过这个入口扩展。
   * 1点实际伤害默认产生1点仇恨；0伤害不产生仇恨。被动怪只会因为这里出现仇恨目标而行动，
   * 不允许在“受击事件”里另写一条直接追击分支。
   *
   * Adds threat to one monster. Basic attacks, skills, and future healing or
   * taunt rules should extend this entrypoint. One point of resolved damage
   * produces one point of threat by default; zero damage produces none.
   * Passive monsters act only when this table contains a target, never from a
   * separate "was hit" chase branch.
   */
  AddThreat(monster: MonsterUnit, source: PlayerUnit, amount: bigint): void {
    this.RequireMapUnit(source);
    if (!Number.isSafeInteger(monster.UnitId) || amount <= 0n) return;
    const state = this.runtime.get(monster.UnitId);
    if (!state) return;
    const previous = state.threatByUnitId.get(source.UnitId) ?? 0n;
    state.threatByUnitId.set(source.UnitId, previous + amount);
  }

  /** 地图销毁时释放怪物Unit，不向玩家发送额外业务事件。 / Releases monster Units during map disposal without inventing another business event. */
  protected override OnDestroy(): void {
    for (const monster of this.monsters.values()) {
      try {
        this.aoi.Detach(monster);
      } catch {
        // AOI may already be released while a failed map teardown is unwinding.
      }
      this.units.Remove(monster.UnitId);
    }
    this.monsters.clear();
    this.runtime.clear();
    this.slots.clear();
  }

  private Spawn(slot: { config: MonsterAreaConfigData; monster: MonsterUnit | null; respawnAtMs: number }): void {
    if (slot.monster) return;
    const config = slot.config.monsterConfigId_ref ?? GameConfigs.MonsterConfig.Get(slot.config.monsterConfigId);
    const unitId = this.AllocateUnitId();
    const monster = this.units.Create(unitId, MonsterUnit, {
      mapId: this.map.MapId,
      mapInstanceId: this.map.MapInstanceId,
      areaId: slot.config.id,
      monsterConfigId: config.id,
    });
    try {
      const native = monster.AddComponent(NativeUnitRef, {
        id: unitId,
        instanceId: monster.InstanceId,
        mapId: this.map.NativeMapKey,
        x: 0,
        y: 0,
      });
      const position = monster.AddComponent(
        PositionComponent,
        native,
        this.mapConfig.widthCells,
        this.mapConfig.depthCells,
        this.mapConfig.cellSizeMeters,
      );
      this.SetSpawnPosition(position, slot, config);
      monster.AddComponent(NumericComponent, {
        [NumericType.CurrentHp]: BigInt(config.maxHp),
        [NumericType.CurrentMp]: BigInt(config.maxMp),
        [NumericType.MaxHpBase]: BigInt(config.maxHp),
        [NumericType.MaxMpBase]: BigInt(config.maxMp),
        [NumericType.AttackBase]: BigInt(config.attackDamage),
        [NumericType.AttackSpeedAdd]: BigInt(config.attackIntervalMs),
        [NumericType.MoveSpeedBase]: MoveSpeedMetersPerSecondToNumeric(config.moveSpeed),
      });
      // 伤害入口属于每个可受击Unit；MonsterComponent不直接改目标Numeric。
      // Every damageable Unit owns the combat entrypoint; MonsterComponent never edits target Numeric directly.
      monster.AddComponent(CombatComponent);
      monster.AddComponent(BuffComponent);
      monster.AddComponent(SkillComponent);
      slot.monster = monster;
      slot.respawnAtMs = 0;
      this.monsters.set(unitId, monster);
      this.runtime.set(unitId, {
        targetUnitId: 0,
        threatByUnitId: new Map(),
        nextThinkAtMs: 0,
        nextAttackAtMs: 0,
        navigationSequence: 0,
      });
      const changes = this.aoi.Attach(monster, 0, false, true);
      if (changes.length > 0) {
        void this.map.PublishVisibilityChanges(changes).catch((error) => {
          this.DomainScene().logger.error("monster AOI publish failed", { error });
        });
      }
    } catch (error) {
      this.units.Remove(unitId);
      throw error;
    }
  }

  /** 把新怪物放回固定刷点；创建流程统一负责空间校验和组件初始化。 / Places a new monster at its fixed spawn; the creation path owns spatial validation and component initialization. */
  private SetSpawnPosition(
    position: PositionComponent,
    slot: { config: MonsterAreaConfigData },
    config: MonsterConfigData,
  ): void {
    if (this.mapConfig.spatialMode === SpatialMode.Grid2D) {
      position.SetGridWorldPosition(
        slot.config.spawnX,
        slot.config.spawnY,
        slot.config.spawnZ,
        slot.config.spawnYaw,
      );
    } else {
      const projected = this.map.ProjectPosition({
        x: slot.config.spawnX,
        y: slot.config.spawnY,
        z: slot.config.spawnZ,
      });
      if (!projected) throw new Error(`monster spawn outside NavMesh: ${slot.config.id}`);
      position.SetNavMeshWorldPosition(projected.x, projected.y, projected.z, slot.config.spawnYaw);
    }
    position.SpeedMetersPerSecond = config.moveSpeed;
  }

  /** 到期后先发布旧尸体Leave，再创建新Unit；不能把死亡Unit原地复活或让Enter抢在Leave之前。 / Publishes the corpse Leave before creating a new Unit; never resurrects the dead identity or lets Enter overtake Leave. */
  private async Respawn(slot: { config: MonsterAreaConfigData; monster: MonsterUnit | null; respawnAtMs: number }): Promise<void> {
    const corpse = slot.monster;
    if (!corpse || corpse.GetComponent(NativeUnitRef).alive !== 0) return;
    slot.respawnAtMs = 0;
    slot.monster = null;
    this.monsters.delete(corpse.UnitId);
    this.runtime.delete(corpse.UnitId);
    const changes = this.aoi.IsAttached(corpse) ? this.aoi.Detach(corpse) : [];
    this.units.Remove(corpse.UnitId);
    if (changes.length > 0) {
      try {
        await this.map.PublishVisibilityChanges(changes);
      } catch (error) {
        this.DomainScene().logger.error("monster corpse AOI leave failed", {
          unitId: corpse.UnitId,
          areaId: corpse.AreaId,
          error,
        });
      }
    }
    if (!this.map.IsStopping) this.Spawn(slot);
  }

  private TickMonster(monster: MonsterUnit, config: MonsterConfigData, now: number): void {
    const state = this.runtime.get(monster.UnitId);
    if (!state || now < state.nextThinkAtMs) return;
    state.nextThinkAtMs = now + 250;
    const target = this.FindMonsterTarget(monster, config, state);
    const monsterPosition = monster.GetComponent(PositionComponent);
    const targetPosition = target?.GetComponent(PositionComponent);
    const distance = targetPosition
      ? Math.sqrt(distanceSquared(
        monsterPosition.x,
        monsterPosition.z,
        targetPosition.x,
        targetPosition.z,
      ))
      : Number.POSITIVE_INFINITY;
    const attackRange = config.attackRange;
    const action = monsterBehaviorTree.Evaluate({
      // A target may come from active acquisition or from the threat table.
      // 目标可能来自主动索敌，也可能来自仇恨表。
      mayAggro: target !== undefined,
      hasTarget: target !== undefined,
      inAttackRange: distance <= attackRange,
      canAttack: now >= state.nextAttackAtMs,
    });
    state.targetUnitId = target?.UnitId ?? 0;
    const native = monster.GetComponent(NativeUnitRef);
    switch (action) {
      case "attack":
        NativeData.ResetMovement(native.Handle);
        this.AttackPlayer(monster, target!);
        state.nextAttackAtMs = now + this.readAttackIntervalMs(monster);
        return;
      case "hold":
      case "idle":
        NativeData.ResetMovement(native.Handle);
        return;
      case "chase":
        state.navigationSequence += 1;
        if (this.mapConfig.spatialMode === SpatialMode.Grid2D) {
          NativeData.SetMovementInput(
            native.Handle,
            Math.sign(targetPosition!.x - monsterPosition.x),
            Math.sign(targetPosition!.z - monsterPosition.z),
            state.navigationSequence,
          );
        } else {
          NativeData.SetNavigationTarget(
            this.map.NativeMapKey,
            native.Handle,
            { x: targetPosition!.x, y: targetPosition!.y, z: targetPosition!.z },
            state.navigationSequence,
          );
        }
        return;
    }
  }

  /** 怪物伤害也从自身Numeric.Attack读取；配置只负责初始化，战斗不再绕过数值系统。 / Reads monster Numeric.Attack for damage so config initializes combat without bypassing Numeric during combat. */
  private AttackPlayer(monster: MonsterUnit, target: PlayerUnit): void {
    const monsterNumeric = monster.GetComponent(NumericComponent);
    const damage = monsterNumeric[NumericType.Attack] > 0n
      ? monsterNumeric[NumericType.Attack]
      : 0n;
    target.GetComponent(CombatComponent).ApplyDamage({
      amount: damage,
      sourceUnitId: monster.UnitId,
    });
  }

  /**
   * 处理所有玩家的自动攻击状态：目标失效时关闭，条件不满足时重置读条，
   * 条件满足且无读条时从零开始，读条完成后结算一次伤害并开始下一轮。
   * 目标朝向使用服务端Yaw，前方有效扇形固定为120度。
   *
   * Processes every player's auto-attack state: invalid targets disable the
   * intent, invalid range/facing resets the swing, a valid waiting state starts
   * from zero, and a completed swing deals damage before starting the next one.
   * Facing uses server yaw with a fixed 120-degree forward cone.
   */
  private TickPlayerAutoAttacks(now: number): void {
    for (const player of this.units.GetAll(PlayerUnit)) {
      const combat = player.GetComponent(CombatComponent);
      if (player.GetComponent(NativeUnitRef).alive === 0) {
        // 玩家死亡后不能继续保留攻击意图；显式推送关闭状态，避免客户端读条停在最后一帧。
        // A dead player cannot keep attack intent; publish an explicit stop so the client
        // does not leave the progress bar frozen at its last frame.
        const state = combat.AutoAttackState();
        if (state.enabled || state.phase !== AutoAttackPhase.Inactive) {
          this.PublishAutoAttackState(player, combat.ToggleAutoAttack(0, false));
        }
        continue;
      }
      const previousState = combat.AutoAttackState();
      const state = combat.SetAutoAttackInterval(
        readAttackIntervalMs(player.GetComponent(NumericComponent)),
      );
      if (state.swingIntervalMs !== previousState.swingIntervalMs) {
        this.PublishAutoAttackState(player, state);
      }
      if (player.GetComponent(SkillComponent).IsCasting()) {
        if (state.phase !== AutoAttackPhase.Waiting || state.swingStartAtMs !== 0) {
          this.PublishAutoAttackState(player, combat.ResetAutoAttackSwing());
        }
        continue;
      }
      if (!state.enabled) continue;

      const monster = this.monsters.get(state.targetUnitId);
      if (!monster || monster.GetComponent(NativeUnitRef).alive === 0) {
        const stopped = combat.ToggleAutoAttack(0, false);
        this.PublishAutoAttackState(player, stopped);
        continue;
      }

      if (!this.CanAutoAttack(player, monster)) {
        if (state.phase !== AutoAttackPhase.Waiting || state.swingStartAtMs !== 0) {
          this.PublishAutoAttackState(player, combat.ResetAutoAttackSwing());
        }
        continue;
      }

      if (state.phase !== AutoAttackPhase.Swinging || state.swingStartAtMs === 0) {
        this.PublishAutoAttackState(player, combat.BeginAutoAttackSwing(now));
        continue;
      }
      if (now - state.swingStartAtMs < state.swingIntervalMs) continue;

      // 同一10Hz桶内再次校验，防止读条完成瞬间目标已离开攻击条件。 / Recheck at completion so a target that moved away is not hit by a stale swing.
      if (!this.CanAutoAttack(player, monster)) {
        this.PublishAutoAttackState(player, combat.ResetAutoAttackSwing());
        continue;
      }
      const result = this.Attack(player, monster.UnitId);
      const nextState = result.killed
        ? combat.ToggleAutoAttack(0, false)
        : combat.BeginAutoAttackSwing(now);
      this.PublishAutoAttackState(player, nextState);
    }
  }

  /** AttackSpeed是每次攻击的毫秒间隔；异常值直接拒绝，避免战斗桶变成零间隔循环。 / AttackSpeed is the milliseconds per swing; invalid values are rejected so the combat bucket cannot become a zero-interval loop. */
  private readAttackIntervalMs(monster: MonsterUnit): number {
    return readAttackIntervalMs(monster.GetComponent(NumericComponent));
  }

  /** 校验近战距离和前方±60度；不做寻路和转身，朝向由移动/客户端输入决定。 / Validates melee range and a ±60-degree forward cone without pathing or forced turning. */
  private CanAutoAttack(attacker: PlayerUnit, monster: MonsterUnit): boolean {
    const attackerPosition = attacker.GetComponent(PositionComponent);
    const monsterPosition = monster.GetComponent(PositionComponent);
    const attackRange = GameConfigs.PlayerConfig.Get(DEMO_PLAYER_CONFIG_ID).attackRange;
    if (distanceSquared(attackerPosition.x, attackerPosition.z, monsterPosition.x, monsterPosition.z)
      > attackRange * attackRange) {
      return false;
    }
    const targetAngle = Math.atan2(
      monsterPosition.x - attackerPosition.x,
      monsterPosition.z - attackerPosition.z,
    );
    const angleDelta = normalizeRadians(targetAngle - attackerPosition.yaw);
    return Math.abs(angleDelta) <= AUTO_ATTACK_FACING_HALF_ANGLE;
  }

  /** 异步发布状态但不阻塞10Hz战斗桶；广播失败只记录，不回滚已经结算的伤害。 / Publishes without blocking the 10Hz bucket; failures are logged and never roll back resolved damage. */
  private PublishAutoAttackState(player: PlayerUnit, state: AutoAttackState): void {
    void this.map.PublishAutoAttackState(player, state).catch((error) => {
      this.DomainScene().logger.error("auto attack state publish failed", { error });
    });
  }

  private Kill(monster: MonsterUnit): void {
    const slot = this.slots.get(monster.AreaId);
    if (!slot || slot.monster !== monster) return;
    const now = TimeSystem.Instance.ServerNow;
    const config = slot.config.monsterConfigId_ref
      ?? GameConfigs.MonsterConfig.Get(slot.config.monsterConfigId);
    slot.respawnAtMs = now + config.respawnSeconds * 1_000;
    const native = monster.GetComponent(NativeUnitRef);
    native.alive = 0;
    NativeData.ResetMovement(native.Handle);

    // 死亡Unit在复活等待期内就是尸体：保留AOI身份给命中、倒地、Buff清理和未来掉落表现使用，
    // 但删除AI运行态并依靠alive=0拒绝新的攻击。到期后Respawn先Leave并销毁，再创建新UnitId。
    // The dead Unit remains as a corpse for impact, death, Buff cleanup, and future loot visuals.
    // Runtime AI is removed and alive=0 rejects new attacks; Respawn later publishes Leave before creating a new UnitId.
    this.runtime.delete(monster.UnitId);
  }

  /**
   * 先按仇恨最高者选目标；没有仇恨时，只有主动怪才会自动寻找最近玩家。
   * 仇恨目标必须仍然存活且在追击范围内；超出范围后保留数值，重新进入范围仍可继续成为目标。
   *
   * Selects the highest-threat target first. Without threat, only an active
   * monster may acquire the nearest player automatically. A threat entry must
   * still point to a living player inside chase range; its value is retained
   * after leaving range so re-entry can restore the target.
   */
  private FindMonsterTarget(
    monster: MonsterUnit,
    config: MonsterConfigData,
    state: MonsterRuntimeState,
  ): PlayerUnit | undefined {
    const threatTarget = this.FindHighestThreatPlayer(monster, state);
    if (threatTarget) return threatTarget;
    return config.attackMode === 0
      ? undefined
      : this.FindNearestPlayer(monster, MONSTER_AGGRO_RANGE_METERS);
  }

  /** 选择范围内仇恨最高的存活玩家；同仇恨时取距离近者，再以UnitId稳定打破平局。 / Selects the living in-range player with highest threat, then nearest distance and UnitId for deterministic ties. */
  private FindHighestThreatPlayer(monster: MonsterUnit, state: MonsterRuntimeState): PlayerUnit | undefined {
    const monsterPosition = monster.GetComponent(PositionComponent);
    const maxDistanceSquared = MONSTER_AGGRO_RANGE_METERS * MONSTER_AGGRO_RANGE_METERS;
    let selected: PlayerUnit | undefined;
    let selectedThreat = 0n;
    let selectedDistanceSquared = Number.POSITIVE_INFINITY;
    for (const [unitId, threat] of state.threatByUnitId) {
      const player = this.units.Get<PlayerUnit>(unitId);
      if (!player || player.GetComponent(NativeUnitRef).alive === 0) {
        state.threatByUnitId.delete(unitId);
        continue;
      }
      const playerPosition = player.GetComponent(PositionComponent);
      const distanceSquaredValue = distanceSquared(
        monsterPosition.x,
        monsterPosition.z,
        playerPosition.x,
        playerPosition.z,
      );
      if (distanceSquaredValue > maxDistanceSquared) continue;
      if (
        selected === undefined ||
        threat > selectedThreat ||
        (threat === selectedThreat && (
          distanceSquaredValue < selectedDistanceSquared ||
          (distanceSquaredValue === selectedDistanceSquared && unitId < selected.UnitId)
        ))
      ) {
        selected = player;
        selectedThreat = threat;
        selectedDistanceSquared = distanceSquaredValue;
      }
    }
    return selected;
  }

  private FindNearestPlayer(monster: MonsterUnit, maxDistance: number): PlayerUnit | undefined {
    const position = monster.GetComponent(PositionComponent);
    const maxDistanceSquared = maxDistance * maxDistance;
    let nearest: PlayerUnit | undefined;
    let nearestDistanceSquared = maxDistanceSquared;
    for (const player of this.units.GetAll(PlayerUnit)) {
      if (player.GetComponent(NativeUnitRef).alive === 0) continue;
      const playerPosition = player.GetComponent(PositionComponent);
      const distanceSquaredValue = distanceSquared(
        position.x,
        position.z,
        playerPosition.x,
        playerPosition.z,
      );
      if (distanceSquaredValue < nearestDistanceSquared) {
        nearest = player;
        nearestDistanceSquared = distanceSquaredValue;
      }
    }
    return nearest;
  }

  private AllocateUnitId(): number {
    while (this.nextMonsterUnitId <= MONSTER_ID_MAX && this.units.Get(this.nextMonsterUnitId)) {
      this.nextMonsterUnitId += 1;
    }
    if (this.nextMonsterUnitId > MONSTER_ID_MAX) throw new Error("monster UnitId range exhausted");
    const unitId = this.nextMonsterUnitId;
    this.nextMonsterUnitId += 1;
    return unitId;
  }

  private get units(): UnitComponent {
    return this.DomainScene().GetComponent(UnitComponent);
  }

  private get mapConfig(): ReturnType<typeof GameConfigs.MapConfig.Get> {
    return GameConfigs.MapConfig.Get(this.map.MapId);
  }
}

function distanceSquared(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

/** 读取最终AttackSpeed毫秒值，拒绝零或非整数避免战斗循环失控。 / Reads the final AttackSpeed interval and rejects zero or non-integers that could destabilize the combat loop. */
function readAttackIntervalMs(numeric: NumericComponent): number {
  const value = Number(numeric[NumericType.AttackSpeed]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`AttackSpeed must be a positive integer in milliseconds: ${value}`);
  }
  return value;
}

function normalizeRadians(value: number): number {
  const fullTurn = Math.PI * 2;
  return ((value + Math.PI) % fullTurn + fullTurn) % fullTurn - Math.PI;
}
