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
  SkillMapComponent,
  TimeSystem,
  UnitComponent,
  type AutoAttackState,
  type DamageRequest,
  type DamageResult,
  type M2C_AttackMonster,
  type M2C_InspectLootMonster,
  type M2C_LootMonster,
  M2C_LootMonsterCodec,
  type MonsterAreaConfigData,
  type MonsterConfigData,
  type MonsterSpawnSlot,
  type MonsterRuntimeState,
  ItemComponent,
  PlayerPersistenceComponent,
  QuestComponent,
  type QuestState,
  type QuestSnapshot,
  QuestStatus,
  QuestObjectiveType,
  type LootContainer,
  type LootDrop,
  ToInventoryGrants,
  ToLootDropSnapshots,
  systemFor,
  QuestEvents,
} from "#tiangz/model";
import { EvaluateMonsterBehavior } from "./MonsterBehaviorTree";

const MONSTER_ACTIVE_ACQUIRE_RANGE_METERS = 12;
const DEMO_PLAYER_CONFIG_ID = 1;
const AUTO_ATTACK_FACING_HALF_ANGLE = Math.PI / 3;
const MONSTER_ID_MAX = 0xffff_ffff;
const MONSTER_LOOT_RANGE_METERS = 4;
const CORPSE_WITH_LOOT_LIFETIME_MS = 5 * 60 * 1_000;
const EMPTY_CORPSE_LIFETIME_MS = 10 * 1_000;
const LOOT_OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;

/**
 * 第一版怪物业务：固定刷点、主动索敌、仇恨追击、普通攻击、尸体生命周期和重生。
 * 怪物只作为AOI Subject，不会成为Observer，也不参与动态避障；死亡时停止逻辑但保留Unit和AOI身份，
 * 等待模板配置的复活时间后先清理尸体，再在原刷点创建新的Unit。
 *
 * Version-one monster rules: fixed slots, active acquisition, threat-based
 * chase, basic attacks, death, and respawn. Monsters are AOI Subjects only
 * and never participate in dynamic avoidance. Death retains a non-interactive
 * corpse Unit in AOI for its loot window; after cleanup and the configured
 * respawn delay, a new Unit is created at the spawn point.
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
        corpseExpiresAtMs: 0,
        corpseCleanupInFlight: false,
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

  /** 1Hz清理尸体或到期刷怪；死亡到清理期间原Unit仍可承接表现事件。 / Cleans corpses or creates due replacements at 1 Hz while retaining the dead Unit for visual events until cleanup. */
  Update1Hz(): void {
    if (this.map.IsStopping) return;
    const now = TimeSystem.Instance.ServerNow;
    for (const slot of this.slots.values()) {
      if (
        slot.monster &&
        !slot.corpseCleanupInFlight &&
        slot.corpseExpiresAtMs > 0 &&
        now >= slot.corpseExpiresAtMs
      ) {
        this.BeginCorpseCleanup(slot, "window-expired");
      } else if (
        !slot.monster &&
        !slot.corpseCleanupInFlight &&
        slot.respawnAtMs > 0 &&
        now >= slot.respawnAtMs
      ) {
        this.Spawn(slot);
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

  /**
   * 拾取尸体的完整事务边界：先同步锁定掉落行，再规划背包和任务快照，最后一次提交Player事务。
   * 未接任务的任务掉落不会进入计划；任务已经达到需求数量时，该行仍留在尸体上，等待其他有资格的玩家。
   *
   * Resolves corpse loot as one transaction: reserve rows synchronously,
   * plan inventory and quest snapshots, then commit one Player transaction.
   * Quest-gated rows are invisible to players without the quest, and stay on
   * the corpse after this player has already reached the required count.
   */
  InspectLootMonster(player: PlayerUnit, monsterId: number): M2C_InspectLootMonster {
    const { container } = this.RequireLootContainer(player, monsterId);
    return {
      monsterId,
      drops: ToLootDropSnapshots(this.SelectLootDrops(container, player, 0, true)),
    };
  }

  async LootMonster(
    player: PlayerUnit,
    monsterId: number,
    operationId: string,
    dropId: number,
    lootAll: boolean,
  ): Promise<M2C_LootMonster> {
    this.RequireMapUnit(player);
    if (!LOOT_OPERATION_ID_PATTERN.test(operationId)) {
      throw new RpcError(GameErrCode.LootNotAvailable, "invalid loot operation id");
    }
    const scopedOperationId = `loot:${player.Account}:${operationId}`;
    const persistence = player.GetComponent(PlayerPersistenceComponent);
    let container: LootContainer;
    try {
      ({ container } = this.RequireLootContainer(player, monsterId));
    } catch (error) {
      // 尸体可能已经因“全部普通掉落领取完成”而离开AOI；此时只允许用同一
      // operationId读取已提交回执，不能重新计算掉落，也不能把未知请求伪装成成功。
      // The corpse may already have left AOI after all global drops were claimed.
      // Only the same operationId may recover a durable receipt; never recalculate loot.
      const receipt = await persistence.LoadTransaction(scopedOperationId);
      if (!receipt) throw error;
      return cloneLootResponse(decodeLootResponse(receipt.result, monsterId));
    }
    const committed = container.committedResponses.get(scopedOperationId);
    if (committed) {
      this.TryRemoveLootedCorpse(monsterId, container);
      return cloneLootResponse(committed);
    }
    if (container.inFlightOperations.has(scopedOperationId)) {
      throw new RpcError(GameErrCode.LootAlreadyClaimed, `loot operation is already running: ${operationId}`);
    }

    // drop_id=0 keeps old clients working as “全部领取”；新客户端普通点击只传一个drop_id。
    // drop_id=0 preserves legacy “loot all” behavior; current clients send one row for a normal click.
    const selected = this.SelectLootDrops(container, player, dropId, lootAll || dropId === 0);
    if (selected.length === 0) {
      throw new RpcError(GameErrCode.LootNotAvailable, `no eligible loot remains: ${monsterId}`);
    }
    const quest = player.GetComponent(QuestComponent);
    const questProgress = this.PlanLootQuestProgress(player, selected);
    const inventory = player.GetComponent(ItemComponent);
    const inventoryPlan = inventory.PlanGrantItems(ToInventoryGrants(selected));
    const baseData = persistence.Capture("monster-loot", { items: inventoryPlan.nextItems });
    const data = {
      ...baseData,
      quests: mergeQuestProgress(baseData.quests, questProgress),
    };
    this.ReserveLoot(container, player.Account, scopedOperationId, selected);
    let durableCommitted = false;
    try {
      const response: M2C_LootMonster = {
        monsterId,
        items: inventoryPlan.affectedItems.map((item) => ({ ...item })),
        quests: questProgress.map(toProtocolQuest),
        remainingDrops: ToLootDropSnapshots(this.SelectLootDrops(container, player, 0, true)),
      };
      const encodedResponse = M2C_LootMonsterCodec.encode(response);
      let committedResult: { result: Uint8Array };
      try {
        committedResult = await persistence.ApplyTransaction(scopedOperationId, data, encodedResponse);
      } catch (error) {
        const receipt = await persistence.LoadTransaction(scopedOperationId);
        if (!receipt) throw error;
        committedResult = receipt;
      }
      // DBProxy一旦返回提交结果，掉落行就不能再释放；本地提交或推送失败时也必须保留回执供重试读取。
      // Once DBProxy returns a committed result, loot rows must stay claimed; cache the receipt before local apply or publish.
      durableCommitted = true;
      const durable = decodeLootResponse(committedResult.result, monsterId);
      this.CommitLoot(container, player.Account, scopedOperationId, selected);
      container.committedResponses.set(scopedOperationId, cloneLootResponse(durable));
      if (bytesEqual(committedResult.result, encodedResponse)) {
        inventory.CommitGrantPlan(inventoryPlan);
        quest.ApplyCommittedProgress(questProgress);
      } else {
        inventory.ApplyCommittedGrantItems(durable.items);
        quest.ApplyCommittedProgress(fromProtocolQuest(durable.quests));
      }
      await this.PublishLootResult(player, durable);
      this.TryRemoveLootedCorpse(monsterId, container);
      return cloneLootResponse(durable);
    } catch (error) {
      // DBProxy已经确认后不能释放保留行，否则另一个玩家可能再次领取同一份普通掉落。
      // Once DBProxy confirms, reservations must stay claimed; releasing them could duplicate a regular drop.
      if (!durableCommitted && !container.committedResponses.has(scopedOperationId)) {
        this.ReleaseLoot(container, player.Account, scopedOperationId, selected);
      }
      throw error;
    } finally {
      container.inFlightOperations.delete(scopedOperationId);
    }
  }

  /** 校验尸体存在、死亡且在交互距离内；查看与领取必须共享这条规则。 / Validates corpse existence, death, and range for both inspect and claim. */
  private RequireLootContainer(player: PlayerUnit, monsterId: number): { container: LootContainer; monster: MonsterUnit } {
    this.RequireMapUnit(player);
    const container = this.lootContainers.get(monsterId);
    const monster = this.monsters.get(monsterId);
    if (!container || !monster || TimeSystem.Instance.ServerNow >= container.expiresAtMs) {
      throw new RpcError(GameErrCode.LootNotAvailable, `loot is not available: ${monsterId}`);
    }
    if (monster.GetComponent(NativeUnitRef).alive !== 0) {
      throw new RpcError(GameErrCode.LootNotAvailable, `monster is still alive: ${monsterId}`);
    }
    const playerPosition = player.GetComponent(PositionComponent);
    const monsterPosition = monster.GetComponent(PositionComponent);
    if (distanceSquared(playerPosition.x, playerPosition.z, monsterPosition.x, monsterPosition.z)
      > MONSTER_LOOT_RANGE_METERS * MONSTER_LOOT_RANGE_METERS) {
      throw new RpcError(GameErrCode.LootTooFar, `loot is too far: ${monsterId}`);
    }
    return { container, monster };
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
    if (result.killed) {
      this.Kill(monster);
      this.DomainScene().Events.Publish(QuestEvents.Progress, {
        player: attacker,
        objectiveType: QuestObjectiveType.KillMonster,
        targetConfigId: monster.MonsterConfigId,
        count: 1,
      });
    }
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
    this.lootContainers.clear();
    this.slots.clear();
  }

  private Spawn(slot: MonsterSpawnSlot): void {
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
      slot.corpseExpiresAtMs = 0;
      slot.corpseCleanupInFlight = false;
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

  /** 清理前先发布旧尸体Leave，再按重生时间创建新Unit；不能让Enter抢在Leave之前。 / Publishes the corpse Leave before creating a replacement Unit; Enter must not overtake Leave. */
  private async Respawn(slot: MonsterSpawnSlot): Promise<void> {
    const corpse = slot.monster;
    if (!corpse || corpse.GetComponent(NativeUnitRef).alive !== 0) {
      slot.corpseCleanupInFlight = false;
      return;
    }
    try {
      slot.corpseExpiresAtMs = 0;
      slot.monster = null;
      this.monsters.delete(corpse.UnitId);
      this.runtime.delete(corpse.UnitId);
      this.lootContainers.delete(corpse.UnitId);
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
      if (!this.map.IsStopping && TimeSystem.Instance.ServerNow >= slot.respawnAtMs) this.Spawn(slot);
    } finally {
      slot.corpseCleanupInFlight = false;
    }
  }

  /** 启动唯一的尸体清理任务，防止1Hz扫描与拾取完成同时重复Remove同一Unit。 / Starts the single corpse cleanup task so the 1 Hz scan and loot completion cannot remove one Unit twice. */
  private BeginCorpseCleanup(slot: MonsterSpawnSlot, reason: string): void {
    if (slot.corpseCleanupInFlight || !slot.monster) return;
    slot.corpseCleanupInFlight = true;
    slot.corpseExpiresAtMs = TimeSystem.Instance.ServerNow;
    void this.Respawn(slot).catch((error) => {
      slot.corpseCleanupInFlight = false;
      this.DomainScene().logger.error("monster corpse cleanup failed", {
        areaId: slot.config.id,
        reason,
        error,
      });
    });
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
    const action = EvaluateMonsterBehavior({
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
    const result = target.GetComponent(CombatComponent).ApplyDamage({
      amount: damage,
      sourceUnitId: monster.UnitId,
    });
    if (result.requestedDamage > 0n && !result.killed && result.absorbedDamage === 0n) {
      // 本次没有护盾吸收时才产生施法惩罚；Combat已经给出结果，这里不查询BuffComponent。
      // Only an unabsorbed hit causes cast pushback/reduction; Combat already
      // produced the result, so this path never queries BuffComponent.
      this.DomainScene().GetComponent(SkillMapComponent).HandleDamageDuringCast(target);
    }
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
    const drops = this.RollLootDrops(monster, config);
    const corpseLifetimeMs = drops.length > 0
      ? CORPSE_WITH_LOOT_LIFETIME_MS
      : EMPTY_CORPSE_LIFETIME_MS;
    const corpseExpiresAtMs = now + corpseLifetimeMs;
    // respawn_seconds is the earliest re-spawn delay; a corpse with loot must
    // remain visible until its loot window closes, even when the template uses
    // a shorter respawn delay.
    // respawn_seconds表示最短重生等待；有掉落的尸体必须先保留完整拾取窗口，不能被更短的重生配置提前删除。
    slot.respawnAtMs = now + config.respawnSeconds * 1_000;
    slot.corpseExpiresAtMs = corpseExpiresAtMs;
    this.CreateLootContainer(monster, drops, corpseExpiresAtMs);
    const native = monster.GetComponent(NativeUnitRef);
    native.alive = 0;
    NativeData.ResetMovement(native.Handle);

    // 死亡Unit在复活等待期内就是尸体：保留AOI身份给命中、倒地、Buff清理和未来掉落表现使用，
    // 但删除AI运行态并依靠alive=0拒绝新的攻击。到期后Respawn先Leave并销毁，再创建新UnitId。
    // The dead Unit remains as a corpse for impact, death, Buff cleanup, and future loot visuals.
    // Runtime AI is removed and alive=0 rejects new attacks; Respawn later publishes Leave before creating a new UnitId.
    this.runtime.delete(monster.UnitId);
  }

  /** 根据冷掉落表创建尸体容器；任务行先落在尸体上，是否能拿由拾取者的任务状态决定。 / Creates a corpse container from cold drop rows; quest rows stay on the corpse and eligibility is checked at pickup time. */
  private RollLootDrops(monster: MonsterUnit, config: MonsterConfigData): LootDrop[] {
    if (config.dropTableId <= 0) return [];
    const drops = GameConfigs.DropTableConfig.GetAll()
      .filter((drop) => drop.dropTableId === config.dropTableId)
      .filter((drop) => drop.chancePermille > deterministicDropRoll(monster.UnitId, monster.InstanceId, drop.id))
      .map((drop): LootDrop => ({
        dropId: drop.id,
        configId: drop.itemConfigId,
        count: deterministicDropCount(drop.minCount, drop.maxCount, monster.UnitId, drop.id),
        questObjectiveId: drop.questObjectiveId,
      }));
    return drops;
  }

  /** 创建尸体容器；空掉落尸体不需要容器，但仍会按10秒尸体窗口等待清理。 / Creates a corpse container; an empty corpse needs no container but still follows the ten-second corpse window. */
  private CreateLootContainer(monster: MonsterUnit, drops: readonly LootDrop[], expiresAtMs: number): void {
    if (drops.length === 0) return;
    this.lootContainers.set(monster.UnitId, {
      monsterUnitId: monster.UnitId,
      corpseGeneration: monster.InstanceId,
      drops,
      expiresAtMs,
      reservedGlobalDropIds: new Set(),
      reservedTaskDropIdsByAccount: new Map(),
      claimedGlobalDropIds: new Set(),
      claimedTaskDropIdsByAccount: new Map(),
      inFlightOperations: new Set(),
      committedResponses: new Map(),
    });
  }

  /**
   * 只有所有掉落都是全局掉落且已经全部领取，才能立即清理尸体。
   * 任务掉落按账号保留，服务端不能因为一个玩家领取完成就删除其他玩家未来仍有资格领取的任务行。
   *
   * A corpse can disappear immediately only when every drop is global and all
   * global rows are claimed. Quest rows remain personal and therefore keep the
   * corpse alive until the five-minute loot window expires.
   */
  private CanRemoveLootedCorpse(container: LootContainer): boolean {
    for (const drop of container.drops) {
      if (drop.questObjectiveId !== 0) return false;
      if (container.reservedGlobalDropIds.has(drop.dropId) || !container.claimedGlobalDropIds.has(drop.dropId)) {
        return false;
      }
    }
    return true;
  }

  /** 全部可共享掉落领取完成后立即移除尸体；任务掉落仍按五分钟窗口保留。 / Removes a corpse immediately after all globally shareable rows are claimed; quest rows keep the five-minute window. */
  private TryRemoveLootedCorpse(monsterId: number, container: LootContainer): void {
    if (!this.CanRemoveLootedCorpse(container)) return;
    const slot = this.slots.get(monsterId);
    if (!slot || slot.monster?.UnitId !== monsterId) return;
    this.BeginCorpseCleanup(slot, "loot-complete");
  }

  /** 选择当前玩家有资格且尚未被预留的掉落；任务目标已完成时跳过该行而不是删掉尸体内容。 / Selects eligible, unreserved rows and leaves completed quest rows on the corpse. */
  private SelectLootDrops(
    container: LootContainer,
    player: PlayerUnit,
    requestedDropId = 0,
    lootAll = true,
  ): LootDrop[] {
    const quest = player.GetComponent(QuestComponent);
    const taskReserved = container.reservedTaskDropIdsByAccount.get(player.Account);
    const taskClaimed = container.claimedTaskDropIdsByAccount.get(player.Account);
    const selected: LootDrop[] = [];
    for (const drop of container.drops) {
      if (!lootAll && requestedDropId !== drop.dropId) continue;
      if (drop.questObjectiveId === 0) {
        if (container.claimedGlobalDropIds.has(drop.dropId) || container.reservedGlobalDropIds.has(drop.dropId)) continue;
        selected.push(drop);
        continue;
      }
      if (taskClaimed?.has(drop.dropId) || taskReserved?.has(drop.dropId)) continue;
      const objective = GameConfigs.QuestObjectiveConfig.Get(drop.questObjectiveId);
      const remaining = quest.RemainingProgress(objective.objectiveType, objective.targetConfigId);
      if (remaining <= 0) continue;
      selected.push({ ...drop, count: Math.min(drop.count, remaining) });
    }
    return selected;
  }

  /** 把一次拾取中的多个任务掉落合并为任务事实，避免同一物品重复触发多次状态更新。 / Merges task drops into one quest fact so one pickup does not emit repeated state updates. */
  private PlanLootQuestProgress(player: PlayerUnit, drops: readonly LootDrop[]): readonly QuestState[] {
    const counts = new Map<number, number>();
    for (const drop of drops) {
      if (drop.questObjectiveId === 0) continue;
      const objective = GameConfigs.QuestObjectiveConfig.Get(drop.questObjectiveId);
      counts.set(objective.targetConfigId, (counts.get(objective.targetConfigId) ?? 0) + drop.count);
    }
    const quest = player.GetComponent(QuestComponent);
    const planned = new Map<number, QuestState>();
    for (const [targetConfigId, count] of counts) {
      for (const state of quest.PlanProgress({
        player,
        objectiveType: QuestObjectiveType.CollectItem,
        targetConfigId,
        count,
      })) {
        planned.set(state.questConfigId, state);
      }
    }
    return [...planned.values()].sort((left, right) => left.questConfigId - right.questConfigId);
  }

  /** 在跨DBProxy await前同步预留行，阻止不同玩家并发重复领取同一普通掉落。 / Reserves rows before the DBProxy await to prevent cross-player duplicate claims. */
  private ReserveLoot(container: LootContainer, account: string, operationId: string, drops: readonly LootDrop[]): void {
    container.inFlightOperations.add(operationId);
    const taskRows = new Set<number>();
    for (const drop of drops) {
      if (drop.questObjectiveId === 0) container.reservedGlobalDropIds.add(drop.dropId);
      else taskRows.add(drop.dropId);
    }
    if (taskRows.size > 0) {
      const rows = container.reservedTaskDropIdsByAccount.get(account) ?? new Set<number>();
      for (const dropId of taskRows) rows.add(dropId);
      container.reservedTaskDropIdsByAccount.set(account, rows);
    }
  }

  /** DBProxy确认后把预留移动为已领取；普通行全局生效，任务行只对当前账号生效。 / Moves reservations to committed claims after DBProxy confirmation. */
  private CommitLoot(container: LootContainer, account: string, operationId: string, drops: readonly LootDrop[]): void {
    for (const drop of drops) {
      if (drop.questObjectiveId === 0) {
        container.reservedGlobalDropIds.delete(drop.dropId);
        container.claimedGlobalDropIds.add(drop.dropId);
      }
    }
    const reserved = container.reservedTaskDropIdsByAccount.get(account);
    const claimed = container.claimedTaskDropIdsByAccount.get(account) ?? new Set<number>();
    for (const drop of drops) {
      if (drop.questObjectiveId === 0) continue;
      reserved?.delete(drop.dropId);
      claimed.add(drop.dropId);
    }
    if (reserved && reserved.size === 0) container.reservedTaskDropIdsByAccount.delete(account);
    if (claimed.size > 0) container.claimedTaskDropIdsByAccount.set(account, claimed);
    container.inFlightOperations.delete(operationId);
  }

  /** 事务失败且没有持久化回执时释放预留；已确认事务永远不走这里。 / Releases reservations only when no durable transaction receipt exists. */
  private ReleaseLoot(container: LootContainer, account: string, operationId: string, drops: readonly LootDrop[]): void {
    for (const drop of drops) {
      if (drop.questObjectiveId === 0) container.reservedGlobalDropIds.delete(drop.dropId);
    }
    const reserved = container.reservedTaskDropIdsByAccount.get(account);
    for (const drop of drops) {
      if (drop.questObjectiveId !== 0) reserved?.delete(drop.dropId);
    }
    if (reserved && reserved.size === 0) container.reservedTaskDropIdsByAccount.delete(account);
    container.inFlightOperations.delete(operationId);
  }

  /** 私有掉落结果同时刷新背包和任务栏；广播失败不回滚已经提交的事务。 / Publishes private inventory and quest results without rolling back a committed transaction on delivery failure. */
  private async PublishLootResult(player: PlayerUnit, response: M2C_LootMonster): Promise<void> {
    for (const item of response.items) await this.map.PublishItemChanged(player, item);
    if (response.quests.length > 0) {
      await this.map.PublishQuestProgress(player, fromProtocolQuest(response.quests));
    }
  }

  /**
   * 先按仇恨最高者选目标；没有仇恨时，只有主动怪才会在主动索敌范围内寻找最近玩家。
   * 已有仇恨不再受主动索敌距离限制，否则远程技能虽然产生仇恨，怪物仍会错误地保持待机。
   *
   * Selects the highest-threat target first. Without threat, only an active
   * monster may acquire the nearest player inside the active-acquisition
   * range. Existing threat is not filtered by that range; otherwise a ranged
   * hit could create threat while leaving the monster incorrectly idle.
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
      : this.FindNearestPlayer(monster, MONSTER_ACTIVE_ACQUIRE_RANGE_METERS);
  }

  /** 选择本地图存活玩家中的最高仇恨目标；同仇恨时取距离近者，再以UnitId稳定打破平局。 / Selects the highest-threat living player on this map, then nearest distance and UnitId for deterministic ties. */
  private FindHighestThreatPlayer(monster: MonsterUnit, state: MonsterRuntimeState): PlayerUnit | undefined {
    const monsterPosition = monster.GetComponent(PositionComponent);
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

function deterministicDropRoll(monsterId: number, corpseGeneration: number, dropId: number): number {
  let value = Math.imul(monsterId, 0x9e3779b1);
  value = Math.imul(value ^ corpseGeneration, 0x85ebca6b);
  value = Math.imul(value ^ dropId, 0xc2b2ae35) >>> 0;
  return value % 1000;
}

function deterministicDropCount(minCount: number, maxCount: number, monsterId: number, dropId: number): number {
  if (minCount === maxCount) return minCount;
  const width = maxCount - minCount + 1;
  return minCount + (deterministicDropRoll(monsterId, 0, dropId) % width);
}

function mergeQuestProgress(
  base: { readonly active: readonly QuestState[]; readonly completedQuestConfigIds: readonly number[] },
  changed: readonly QuestState[],
): { active: QuestState[]; completedQuestConfigIds: number[] } {
  const states = new Map(base.active.map((quest) => [quest.questConfigId, quest]));
  for (const quest of changed) states.set(quest.questConfigId, quest);
  return {
    active: [...states.values()].sort((left, right) => left.questConfigId - right.questConfigId),
    completedQuestConfigIds: [...base.completedQuestConfigIds],
  };
}

function toProtocolQuest(value: QuestState): QuestSnapshot {
  return {
    questConfigId: value.questConfigId,
    objectives: value.objectives.map((objective) => ({ ...objective })),
    readyToComplete: value.status === QuestStatus.ReadyToTurnIn,
    status: value.status,
    revision: value.revision,
  };
}

function fromProtocolQuest(values: readonly QuestSnapshot[]): QuestState[] {
  return values.map((value) => ({
    questConfigId: value.questConfigId,
    objectives: value.objectives.map((objective) => ({ ...objective })),
    readyToComplete: value.readyToComplete,
    status: value.status,
    revision: value.revision,
  }));
}

function cloneLootResponse(value: M2C_LootMonster): M2C_LootMonster {
  return {
    monsterId: value.monsterId,
    items: value.items.map((item) => ({ ...item })),
    quests: value.quests.map((quest) => ({
      questConfigId: quest.questConfigId,
      objectives: quest.objectives.map((objective) => ({ ...objective })),
      readyToComplete: quest.readyToComplete,
      status: quest.status,
      revision: quest.revision,
    })),
    remainingDrops: value.remainingDrops.map((drop) => ({ ...drop })),
  };
}

function decodeLootResponse(payload: Uint8Array, monsterId: number): M2C_LootMonster {
  const value = M2C_LootMonsterCodec.decode(payload);
  if (
    value.monsterId !== monsterId
    || !Array.isArray(value.items)
    || !Array.isArray(value.quests)
    || !Array.isArray(value.remainingDrops)
  ) {
    throw new Error(`loot receipt mismatch: ${value.monsterId} != ${monsterId}`);
  }
  return cloneLootResponse(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
