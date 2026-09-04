import {
  GameConfigs,
  GameErrCode,
  CombatComponent,
  CombatStateComponent,
  CurrencyComponent,
  BuffComponent,
  AutoAttackPhase,
  MapAoiComponent,
  MapComponent,
  MonsterComponent,
  MonsterContentProfileComponent,
  SpawnSelectionCandidateKind,
  SpawnSelectionComponent,
  MonsterContentBehaviorActionType,
  MonsterContentBehaviorTarget,
  MonsterContentBehaviorTrigger,
  MonsterContentIdleActionTarget,
  MonsterContentIdleActionType,
  MonsterContentWaypointActionType,
  MonsterSpawnProfileComponent,
  MonsterUnit,
  NpcComponent,
  NpcUnit,
  NativeData,
  NativeUnitRef,
  NumericComponent,
  NumericRegenerationComponent,
  NumericType,
  MoveSpeedMetersPerSecondToNumeric,
  PlayerUnit,
  PositionComponent,
  RpcError,
  SpatialMode,
  SystemErrCode,
  SkillComponent,
  SkillMapComponent,
  SummonComponent,
  TimeSystem,
  UnitComponent,
  type AutoAttackState,
  type DamageRequest,
  type DamageResult,
  type M2C_AttackMonster,
  type M2C_InspectLootMonster,
  type M2C_LootMonster,
  M2C_LootMonsterCodec,
  type MonsterContentDefinition,
  type MonsterContentSpawn,
  type MonsterCorpseState,
  type MonsterSpawnSlot,
  type MonsterRuntimeState,
  ItemComponent,
  PlayerPersistenceComponent,
  PlayerContentProfileComponent,
  QuestComponent,
  QuestContentProfileComponent,
  type QuestState,
  type QuestSnapshot,
  QuestStatus,
  QuestObjectiveType,
  type LootContainer,
  type LootDrop,
  LootContentProfileComponent,
  CanClaimRegularLoot,
  ToInventoryGrants,
  ToLootDropSnapshots,
  systemFor,
  QuestEvents,
  MonsterEvents,
  UnitPresentationType,
  applyEntityExtensions,
} from "#tiangz/model";
import { EvaluateMonsterBehavior } from "./MonsterBehaviorTree";
import {
  MonsterWanderPauseMs,
  SelectMonsterInitialWanderDelayMs,
  SelectMonsterWanderPauseMs,
  SelectMonsterWanderPoint,
  ShouldPauseMonsterWander,
} from "./MonsterAmbientMovement";
import {
  RollMonsterBehaviorPermille,
  SelectMonsterBehaviorDelayMs,
  SelectMonsterBehaviorText,
} from "./MonsterContentBehavior";
import { ResolveLootTableRows, type LootRollChannel } from "../loot/LootRoll";
import { SelectContentSpawnLevel } from "../spawn/ContentSpawnLevel";

const MONSTER_ACTIVE_ACQUIRE_RANGE_METERS = 12;
const DEMO_PLAYER_CONFIG_ID = 1;
const AUTO_ATTACK_FACING_HALF_ANGLE = Math.PI / 3;
const MONSTER_ID_MAX = 0xffff_ffff;
const MONSTER_GOLD_DROP_ID_BASE = 0xf000_0000;
const MONSTER_GOLD_DROP_ID_RANGE = 0x1000_0000;
const MONSTER_LOOT_RANGE_METERS = 4;
const CORPSE_WITH_LOOT_LIFETIME_MS = 5 * 60 * 1_000;
const EMPTY_CORPSE_LIFETIME_MS = 10 * 1_000;
const MONSTER_LEASH_RANGE_METERS = 30;
const MONSTER_SPAWN_ARRIVAL_RANGE_METERS = 0.5;
const LOOT_OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;

/**
 * 第一版怪物业务：固定刷点、主动索敌、仇恨追击、普通攻击、尸体生命周期和重生。
 * 怪物只作为AOI Subject，不会成为Observer，也不参与动态避障；死亡时停止逻辑并转入独立尸体集合，
 * 刷怪槽位按模板时间生成新Unit，不等待旧尸体掉落窗口结束。
 *
 * Version-one monster rules: fixed slots, active acquisition, threat-based
 * chase, basic attacks, death, and respawn. Monsters are AOI Subjects only
 * and never participate in dynamic avoidance. Death moves the Unit into an
 * independent corpse set for its loot window, while the spawn slot creates a
 * replacement after the configured respawn delay.
 */
@systemFor(MonsterComponent)
export class MonsterComponentSystem extends MonsterComponent {
  /** 读取本地图冷刷点，并在地图创建时生成初始怪物。 / Loads cold spawn points and creates initial monsters when the map is created. */
  protected override Awake(map: MapComponent, aoi: MapAoiComponent): void {
    this.map = map;
    this.aoi = aoi;
    const externalContent = this.DomainScene().GetComponent(MonsterContentProfileComponent);
    const areas = externalContent.IncludesColdContent
      ? GameConfigs.MonsterAreaConfig.GetAll()
        .filter((area) => area.mapConfigId === map.MapId)
        .sort((left, right) => left.id - right.id)
      : [];
    for (const area of areas) {
      const coldDefinition = area.monsterConfigId_ref
        ?? GameConfigs.MonsterConfig.Get(area.monsterConfigId);
      this.AddSpawnSlot(
        {
          id: area.id,
          monsterDefinitionId: coldDefinition.id,
          spawnX: area.spawnX,
          spawnY: area.spawnY,
          spawnZ: area.spawnZ,
          spawnYaw: area.spawnYaw,
          initialSpawn: area.initialSpawn,
          respawnSeconds: coldDefinition.respawnSeconds,
        },
        coldDefinition,
      );
    }
    for (const definition of externalContent.GetDefinitions()) {
      if (GameConfigs.MonsterConfig.TryGet(definition.id)) {
        throw new Error(`external monster definition conflicts with cold config: ${definition.id}`);
      }
    }
    for (const spawn of externalContent.GetSpawns()) {
      const definition = externalContent.TryGetDefinition(spawn.monsterDefinitionId);
      if (!definition) {
        throw new Error(
          `external monster spawn ${spawn.id} references missing definition ${spawn.monsterDefinitionId}`,
        );
      }
      this.AddSpawnSlot(spawn, definition);
    }
    this.DomainScene().logger.info("monster component ready", {
      mapId: map.MapId,
      spawnSlots: this.slots.size,
      coldSpawnSlots: areas.length,
      externalSpawnSlots: externalContent.SpawnCount,
      coldContentReplacementOwner: externalContent.ColdContentReplacementOwner,
      initialMonsters: this.monsters.size,
    });
  }

  private AddSpawnSlot(
    config: Readonly<MonsterContentSpawn>,
    definition: Readonly<MonsterContentDefinition>,
  ): void {
    if (this.slots.has(config.id)) {
      throw new Error(`duplicate monster spawn slot: ${config.id}`);
    }
    if (config.monsterDefinitionId !== definition.id) {
      throw new Error(
        `monster spawn ${config.id} definition mismatch: ${config.monsterDefinitionId} != ${definition.id}`,
      );
    }
    const slot = {
      config,
      definition,
      monster: null,
      respawnAtMs: 0,
      spawnGeneration: 0,
    };
    this.slots.set(config.id, slot);
    if (config.initialSpawn) this.SpawnMonster(slot);
  }

  ActivateSpawn(spawnId: number): void {
    const slot = this.slots.get(spawnId);
    if (!slot) throw new Error(`monster spawn slot not found: ${spawnId}`);
    if (slot.monster) return;
    slot.respawnAtMs = 0;
    this.SpawnMonster(slot);
  }

  TriggerContentSignal(source: PlayerUnit, monsterId: number, signalId: number): boolean {
    this.RequireMapUnit(source);
    if (!Number.isSafeInteger(signalId) || signalId <= 0) return false;
    const monster = this.monsters.get(monsterId);
    const state = this.runtime.get(monsterId);
    if (!monster || !state || !this.aoi.IsAttached(monster)) return false;
    if (!this.aoi.VisibleUnitIds(source.UnitId).includes(monsterId)) return false;
    this.TriggerMonsterBehavior(
      monster,
      source,
      state,
      MonsterContentBehaviorTrigger.ExternalSignal,
      TimeSystem.Instance.ServerNow,
      signalId,
    );
    return true;
  }

  DeactivateSpawn(spawnId: number): void {
    const slot = this.slots.get(spawnId);
    if (!slot) throw new Error(`monster spawn slot not found: ${spawnId}`);
    slot.respawnAtMs = 0;
    const live = slot.monster;
    if (live) {
      const state = this.runtime.get(live.UnitId);
      if (state) this.ClearThreat(live, state, TimeSystem.Instance.ServerNow);
      slot.monster = null;
      this.RemoveSpawnEntity(live, "monster deactivation AOI publish failed");
    }
    for (const corpse of [...this.corpses.values()]) {
      if (corpse.monster.AreaId !== spawnId) continue;
      this.corpses.delete(corpse.monster.UnitId);
      this.RemoveSpawnEntity(corpse.monster, "monster corpse deactivation AOI publish failed");
    }
  }

  private RemoveSpawnEntity(monster: MonsterUnit, failureMessage: string): void {
    this.monsters.delete(monster.UnitId);
    this.runtime.delete(monster.UnitId);
    this.lootContainers.delete(monster.UnitId);
    const summonChanges = this.DomainScene()
      .TryGetComponent(SummonComponent)
      ?.OwnerLeaving(monster) ?? [];
    const changes = [
      ...summonChanges,
      ...(this.aoi.IsAttached(monster) ? this.aoi.Detach(monster) : []),
    ];
    this.units.Remove(monster.UnitId);
    if (changes.length > 0) {
      void this.map.PublishVisibilityChanges(changes).catch((error) => {
        this.DomainScene().logger.error(failureMessage, {
          error,
          unitId: monster.UnitId,
          areaId: monster.AreaId,
        });
      });
    }
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
      const config = slot.definition;
      this.TickMonster(monster, config, slot.config, now);
    }
  }

  /** 1Hz独立清理到期尸体和刷新到期槽位；两条时间线不相互阻塞。 / Independently cleans expired corpses and respawns due slots at 1 Hz. */
  Update1Hz(): void {
    if (this.map.IsStopping) return;
    const now = TimeSystem.Instance.ServerNow;
    for (const corpse of this.corpses.values()) {
      if (!corpse.corpseCleanupInFlight && now >= corpse.corpseExpiresAtMs) {
        this.BeginCorpseCleanup(corpse, "window-expired");
      }
    }
    for (const slot of this.slots.values()) {
      if (!slot.monster && slot.respawnAtMs > 0 && now >= slot.respawnAtMs) {
        this.SpawnMonster(slot);
      }
    }
  }

  CanPlayerAttack(player: PlayerUnit, monster: MonsterUnit): boolean {
    this.RequireMapUnit(player);
    this.RequireMapUnit(monster);
    if (this.monsters.get(monster.UnitId) !== monster) return false;
    const definition = this.slots.get(monster.AreaId)?.definition;
    if (!definition) return false;
    const eligible = definition.attackablePlayerConfigIds;
    return eligible === undefined || eligible.includes(player.PlayerConfigId);
  }

  /** 玩家近战攻击一个怪物；伤害、距离和死亡都在同一地图入口完成。 / Resolves one player melee attack, including range, damage, and death on this map. */
  Attack(attacker: PlayerUnit, monsterId: number): M2C_AttackMonster {
    this.RequireMapUnit(attacker);
    const monster = this.monsters.get(monsterId);
    if (!monster) throw new RpcError(GameErrCode.MonsterNotFound, `monster not found: ${monsterId}`);
    const monsterNative = monster.GetComponent(NativeUnitRef);
    if (monsterNative.alive === 0) throw new RpcError(GameErrCode.MonsterDead, `monster is dead: ${monsterId}`);
    this.RequirePlayerAttackable(attacker, monster);

    const attackerPosition = attacker.GetComponent(PositionComponent);
    const monsterPosition = monster.GetComponent(PositionComponent);
    const attackRange = attacker.GetComponent(CombatComponent).AutoAttackRangeMeters();
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
      damage: result.finalDamage,
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
    const eligibleDrops = this.SelectLootDrops(container, player, 0, true);
    this.DomainScene().logger.info("loot inspect resolved", {
      monsterId,
      playerAccount: player.Account,
      playerCharacterId: player.CharacterId.toString(),
      lootOwnerAccount: container.lootOwnerAccount,
      corpseDropIds: container.drops.map((drop) => ({
        dropId: drop.dropId,
        itemConfigId: drop.configId,
        count: drop.count,
        gold: drop.gold.toString(),
        questObjectiveId: drop.questObjectiveId,
      })),
      eligibleDropIds: eligibleDrops.map((drop) => drop.dropId),
      eligibleQuestObjectiveIds: eligibleDrops.map((drop) => drop.questObjectiveId),
      claimedRegularDropIds: [...container.claimedRegularDropIds],
      reservedRegularDropIds: [...container.reservedRegularDropIds],
    });
    return {
      monsterId,
      drops: ToLootDropSnapshots(eligibleDrops),
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
      // 尸体可能已经因“归属账号的全部普通掉落领取完成”而离开AOI；此时只允许用同一
      // operationId读取已提交回执，不能重新计算掉落，也不能把未知请求伪装成成功。
      // The corpse may already have left AOI after the tagged account claimed all regular drops.
      // Only the same operationId may recover a durable receipt; never recalculate loot.
      const receipt = await persistence.LoadTransaction(scopedOperationId, ["inventory", "quest", "wallet"])
        ?? await persistence.LoadTransaction(scopedOperationId, ["inventory", "quest"]);
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
      this.DomainScene().logger.warn("loot pickup resolved no eligible drops", {
        monsterId,
        playerAccount: player.Account,
        playerCharacterId: player.CharacterId.toString(),
        lootOwnerAccount: container.lootOwnerAccount,
        requestedDropId: dropId,
        lootAll: lootAll || dropId === 0,
        corpseDropIds: container.drops.map((drop) => drop.dropId),
        claimedRegularDropIds: [...container.claimedRegularDropIds],
        reservedRegularDropIds: [...container.reservedRegularDropIds],
        claimedTaskDropIds: [...(container.claimedTaskDropIdsByAccount.get(player.Account) ?? [])],
        reservedTaskDropIds: [...(container.reservedTaskDropIdsByAccount.get(player.Account) ?? [])],
      });
      throw new RpcError(
        GameErrCode.LootNotAvailable,
        `当前账号没有可拾取掉落：普通掉落可能已被领取，任务掉落需要先接取对应任务（${monsterId}）`,
      );
    }
    const quest = player.GetComponent(QuestComponent);
    const questProgress = this.PlanLootQuestProgress(player, selected);
    const inventory = player.GetComponent(ItemComponent);
    const inventoryPlan = inventory.PlanGrantItems(ToInventoryGrants(selected));
    const currency = player.GetComponent(CurrencyComponent);
    const baseGold = currency.Gold;
    const gainedGold = selected.reduce((total, drop) => total + drop.gold, 0n);
    const nextGold = baseGold + gainedGold;
    const baseData = persistence.Capture("monster-loot", {
      items: inventoryPlan.nextItems,
      gold: nextGold,
    });
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
        gold: nextGold,
        gainedGold,
      };
      const encodedResponse = M2C_LootMonsterCodec.encode(response);
      let committedResult: { result: Uint8Array };
      try {
        committedResult = await persistence.ApplyTransaction(
          scopedOperationId,
          gainedGold > 0n ? ["inventory", "quest", "wallet"] : ["inventory", "quest"],
          data,
          encodedResponse,
        );
      } catch (error) {
        const receipt = await persistence.LoadTransaction(
          scopedOperationId,
          gainedGold > 0n ? ["inventory", "quest", "wallet"] : ["inventory", "quest"],
        );
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
      currency.ApplyCommittedGold(durable.gold, baseGold);
      const committedInventory = inventory.Snapshot();
      this.DomainScene().logger.info("monster loot committed to authoritative inventory", {
        monsterId,
        playerAccount: player.Account,
        playerCharacterId: player.CharacterId.toString(),
        playerUnitId: player.UnitId,
        grantedItems: durable.items.map((item) => ({
          itemId: item.itemId.toString(),
          configId: item.configId,
          count: item.count,
          version: item.version,
        })),
        inventoryStacks: committedInventory.length,
        inventoryCount: committedInventory.reduce((total, item) => total + item.count, 0),
        inventoryConfigIds: committedInventory.map((item) => item.configId),
        gainedGold: durable.gainedGold.toString(),
        gold: durable.gold.toString(),
      });
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
    this.RequirePlayerAttackable(attacker, monster);
    return this.ResolveMonsterDamage(attacker, monster, request);
  }

  private RequirePlayerAttackable(player: PlayerUnit, monster: MonsterUnit): void {
    if (!this.CanPlayerAttack(player, monster)) {
      throw new RpcError(
        GameErrCode.SkillTargetInvalid,
        `monster ${monster.UnitId} is not attackable by player config ${player.PlayerConfigId}`,
      );
    }
  }

  /**
   * Buff Tick等延迟伤害不能直接写Combat，否则怪物虽然会变成0血，却不会释放刷怪槽、创建尸体或推进任务。
   * 来源玩家仍在本地图时保留仇恨、归属和任务语义；来源已经离开时也必须完成死亡与刷新。
   *
   * Delayed damage such as Buff ticks must not write Combat directly: doing so
   * reaches zero health without releasing the spawn slot, creating a corpse, or
   * advancing quests. A source player still on this map keeps threat, ownership,
   * and quest semantics; an absent source still completes death and respawn.
   */
  ApplyUnitDamage(monster: MonsterUnit, request: DamageRequest): DamageResult {
    const sourceUnitId = request.sourceUnitId ?? 0;
    const attacker = sourceUnitId > 0 ? this.units.Get<PlayerUnit>(sourceUnitId) : undefined;
    return this.ResolveMonsterDamage(attacker, monster, request);
  }

  private ResolveMonsterDamage(
    attacker: PlayerUnit | undefined,
    monster: MonsterUnit,
    request: DamageRequest,
  ): DamageResult {
    if (attacker) this.RequireMapUnit(attacker);
    if (this.monsters.get(monster.UnitId) !== monster) {
      throw new RpcError(GameErrCode.MonsterNotFound, `monster not found: ${monster.UnitId}`);
    }
    const state = this.runtime.get(monster.UnitId);
    if (state?.returningToSpawn) {
      // 回归中的怪物处于Evade窗口：伤害不结算、仇恨不重建，直到它抵达刷点并完成重置。
      // A returning monster is in its evade window: ignore damage and do not
      // rebuild threat until it reaches the spawn and completes the reset.
      return monster.GetComponent(CombatComponent).ApplyDamage({
        ...request,
        amount: 0n,
      });
    }
    const result = monster.GetComponent(CombatComponent).ApplyDamage(request);
    this.PublishCombatDamage(
      monster,
      request.sourceUnitId ?? attacker?.UnitId ?? monster.UnitId,
      result,
      request.abilityId ?? 0,
    );
    if (attacker) this.AddThreat(monster, attacker, result.finalDamage);
    if (!result.killed && result.finalDamage > 0n && state) {
      this.TriggerMonsterBehavior(
        monster,
        this.FindHighestThreatPlayer(monster, state) ?? attacker,
        state,
        MonsterContentBehaviorTrigger.HealthRange,
      );
    }
    if (result.killed) {
      // 死亡SmartAI必须在实体转入尸体集合前执行；此时攻击者仍是本次事件的中立目标。
      // Death SmartAI runs before the entity enters the corpse set, while the
      // attacker is still available as the neutral combat target.
      if (state) {
        this.TriggerMonsterBehavior(
          monster,
          attacker,
          state,
          MonsterContentBehaviorTrigger.Death,
        );
      }
      this.Kill(monster, attacker?.Account ?? "");
      if (attacker) {
        this.DomainScene().Events.Publish(QuestEvents.Progress, {
          player: attacker,
          objectiveType: QuestObjectiveType.KillMonster,
          targetConfigId: monster.MonsterConfigId,
          count: 1,
        });
        this.DomainScene().Events.Publish(MonsterEvents.Killed, { player: attacker, monster });
      }
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
    if (!state || state.returningToSpawn) return;
    this.MarkCombatThreat(monster, source, state, amount, TimeSystem.Instance.ServerNow);
    if (state.lootOwnerAccount === null) state.lootOwnerAccount = source.Account;
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
    this.corpses.clear();
    this.lootContainers.clear();
    this.slots.clear();
  }

  private SpawnMonster(slot: MonsterSpawnSlot): void {
    if (slot.monster) return;
    const config = slot.definition;
    const level = SelectContentSpawnLevel(
      config.minimumLevel ?? 1,
      config.maximumLevel ?? config.minimumLevel ?? 1,
      slot.config.id,
      slot.spawnGeneration,
    );
    const levelStats = config.combatStatsByLevel?.find((row) => row.level === level);
    const maxHp = levelStats?.maxHp ?? config.maxHp;
    const maxMp = levelStats?.maxMp ?? config.maxMp;
    const attackDamage = levelStats?.attackDamage ?? config.attackDamage;
    const unitId = this.AllocateUnitId();
    const monster = this.units.Create(unitId, MonsterUnit, {
      mapId: this.map.MapId,
      mapInstanceId: this.map.MapInstanceId,
      areaId: slot.config.id,
      monsterConfigId: config.id,
      name: config.name,
      modelId: config.modelId,
      presentationStateId: slot.config.presentationStateId ?? config.presentationStateId,
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
        this.map.SpatialProfile.widthCells,
        this.map.SpatialProfile.depthCells,
        this.map.SpatialProfile.cellSizeMeters,
      );
      const spawnProfile = monster.AddComponent(MonsterSpawnProfileComponent);
      spawnProfile.Initialize({
        x: slot.config.spawnX,
        y: slot.config.spawnY,
        z: slot.config.spawnZ,
        yaw: slot.config.spawnYaw,
      });
      monster.AddComponent(NumericComponent, {
        [NumericType.CurrentHp]: BigInt(maxHp),
        [NumericType.CurrentMp]: BigInt(maxMp),
        [NumericType.Level]: BigInt(level),
        [NumericType.MaxHpBase]: BigInt(maxHp),
        [NumericType.MaxMpBase]: BigInt(maxMp),
        [NumericType.AttackBase]: BigInt(attackDamage),
        [NumericType.AttackSpeedAdd]: BigInt(config.attackIntervalMs),
        [NumericType.MoveSpeedBase]: MoveSpeedMetersPerSecondToNumeric(config.moveSpeed),
      });
      if (config.resourceRegenAmount !== undefined) {
        monster.AddComponent(NumericRegenerationComponent, {
          currentNumericType: NumericType.CurrentMp,
          maximumNumericType: NumericType.MaxMp,
          amount: BigInt(config.resourceRegenAmount),
          intervalMs: config.resourceRegenIntervalMs!,
          delayAfterDecreaseMs: config.resourceRegenDelayAfterSpendMs!,
        });
      }
      // 伤害入口属于每个可受击Unit；MonsterComponent不直接改目标Numeric。
      // Every damageable Unit owns the combat entrypoint; MonsterComponent never edits target Numeric directly.
      monster.AddComponent(CombatComponent);
      const buffs = monster.AddComponent(BuffComponent);
      for (const buffDefinitionId of slot.config.initialBuffDefinitionIds
        ?? config.initialBuffDefinitionIds
        ?? []) {
        // Static content auras are applied before AOI attachment so late
        // observers receive them in the initial snapshot, while the generic
        // BuffComponent remains the sole lifecycle owner.
        buffs.ApplyBuff(buffDefinitionId);
      }
      monster.AddComponent(SkillComponent);
      applyEntityExtensions(monster);
      const initialMoveSpeed = slot.config.waypoints?.[0]?.moveSpeed
        ?? slot.config.wanderMoveSpeed
        ?? config.moveSpeed;
      this.SetSpawnPosition(position, spawnProfile.Point, initialMoveSpeed);
      slot.monster = monster;
      slot.respawnAtMs = 0;
      this.monsters.set(unitId, monster);
      const runtimeState: MonsterRuntimeState = {
        targetUnitId: 0,
        threatByUnitId: new Map(),
        lootOwnerAccount: null,
        nextThinkAtMs: 0,
        nextAttackAtMs: 0,
        navigationSequence: 0,
        navigationTarget: null,
        behaviorEncounterSequence: 0,
        triggeredBehaviorRuleIds: new Set(),
        behaviorBuffStates: new Map(),
        behaviorRuleNextAtMs: new Map(),
        behaviorRuleExecutionSequences: new Map(),
        idleSequenceStates: new Map(),
        ambientWaypointIndex: 0,
        ambientWaypointActiveIndex: -1,
        ambientWaypointArrivedAtMs: 0,
        ambientWaypointActionIndex: 0,
        ambientWaypointArrivalSequence: 0,
        ambientWaypointWanderRadius: 0,
        ambientWaypointWanderPauseUntilMs: 0,
        ambientPauseUntilMs: this.InitialMonsterWanderPauseUntilMs(slot.config),
        ambientWanderSequence: 0,
        ambientWanderLegsSincePause: 0,
        ambientTarget: null,
        combatReturnPoint: null,
        returningToSpawn: false,
      };
      this.runtime.set(unitId, runtimeState);
      const changes = this.aoi.Attach(monster, 0, false, true);
      slot.spawnGeneration += 1;
      const visibilityPublished = changes.length > 0
        ? this.map.PublishVisibilityChanges(changes).catch((error) => {
          this.DomainScene().logger.error("monster AOI publish failed", { error });
        })
        : Promise.resolve();
      void visibilityPublished.finally(() => {
        // 出生表现必须排在向观察者建立Unit身份的AOI Enter之后；身份守卫也避免延迟续体作用于已移除实例。
        // Spawn presentations must follow the AOI Enter that gives observers
        // this Unit identity; identity guards also reject removed instances.
        if (this.monsters.get(unitId) !== monster || this.runtime.get(unitId) !== runtimeState) return;
        this.TriggerMonsterBehavior(
          monster,
          undefined,
          runtimeState,
          MonsterContentBehaviorTrigger.Spawned,
        );
      }).catch((error) => {
        this.DomainScene().logger.error("monster spawned behavior failed", {
          unitId,
          areaId: monster.AreaId,
          error,
        });
      });
    } catch (error) {
      this.units.Remove(unitId);
      throw error;
    }
  }

  /** 把新怪物放回固定刷点；创建流程统一负责空间校验和组件初始化。 / Places a new monster at its fixed spawn; the creation path owns spatial validation and component initialization. */
  private SetSpawnPosition(
    position: PositionComponent,
    spawn: { readonly x: number; readonly y: number; readonly z: number; readonly yaw: number },
    initialMoveSpeed: number,
  ): void {
    if (this.map.SpatialProfile.spatialMode === SpatialMode.Grid2D) {
      position.SetGridWorldPosition(
        spawn.x,
        spawn.y,
        spawn.z,
        spawn.yaw,
      );
    } else {
      const projected = this.map.ProjectPosition({
        x: spawn.x,
        y: spawn.y,
        z: spawn.z,
      });
      if (!projected) throw new Error(`monster spawn outside NavMesh: ${spawn.x},${spawn.y},${spawn.z}`);
      position.SetNavMeshWorldPosition(projected.x, projected.y, projected.z, spawn.yaw);
    }
    position.SpeedMetersPerSecond = initialMoveSpeed;
  }

  /** 为配置了随机游走的刷点生成首次移动错峰；固定点和路径点不受影响。 / Builds the first-move stagger for configured random wanderers; stationary and waypoint spawns are unaffected. */
  private InitialMonsterWanderPauseUntilMs(spawn: Readonly<MonsterContentSpawn>): number {
    const schedule = spawn.wanderSchedule;
    if (!schedule || (spawn.wanderRadius ?? 0) <= 0 || (spawn.waypoints?.length ?? 0) > 0) {
      return 0;
    }
    return TimeSystem.Instance.ServerNow + SelectMonsterInitialWanderDelayMs(
      spawn.id,
      schedule.initialDelayMinMs,
      schedule.initialDelayMaxMs,
    );
  }

  /** 清理一具独立尸体并发布AOI Leave；此函数不操作已独立刷新的槽位。 / Removes one independent corpse and publishes its AOI Leave without touching the respawn slot. */
  private async RemoveCorpse(state: MonsterCorpseState): Promise<void> {
    const corpse = state.monster;
    if (this.corpses.get(corpse.UnitId) !== state || corpse.GetComponent(NativeUnitRef).alive !== 0) {
      state.corpseCleanupInFlight = false;
      return;
    }
    try {
      this.corpses.delete(corpse.UnitId);
      this.monsters.delete(corpse.UnitId);
      this.runtime.delete(corpse.UnitId);
      this.lootContainers.delete(corpse.UnitId);
      const summonChanges = this.DomainScene()
        .TryGetComponent(SummonComponent)
        ?.OwnerLeaving(corpse) ?? [];
      const changes = [
        ...summonChanges,
        ...(this.aoi.IsAttached(corpse) ? this.aoi.Detach(corpse) : []),
      ];
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
    } finally {
      state.corpseCleanupInFlight = false;
    }
  }

  /** 启动唯一的尸体清理任务，防止1Hz扫描与拾取完成同时重复Remove同一Unit。 / Starts the single corpse cleanup task so the 1 Hz scan and loot completion cannot remove one Unit twice. */
  private BeginCorpseCleanup(state: MonsterCorpseState, reason: string): void {
    if (state.corpseCleanupInFlight || this.corpses.get(state.monster.UnitId) !== state) return;
    state.corpseCleanupInFlight = true;
    state.corpseExpiresAtMs = TimeSystem.Instance.ServerNow;
    void this.RemoveCorpse(state).catch((error) => {
      state.corpseCleanupInFlight = false;
      this.DomainScene().logger.error("monster corpse cleanup failed", {
        unitId: state.monster.UnitId,
        areaId: state.monster.AreaId,
        reason,
        error,
      });
    });
  }

  private TickMonster(
    monster: MonsterUnit,
    config: MonsterContentDefinition,
    spawnConfig: Readonly<MonsterContentSpawn>,
    now: number,
  ): void {
    const state = this.runtime.get(monster.UnitId);
    if (!state || now < state.nextThinkAtMs) return;
    state.nextThinkAtMs = now + 250;
    monster.TryGetComponent(NumericRegenerationComponent)?.Tick(now);

    const behaviorVetoReason = this.DomainScene().Events.Check(
      MonsterEvents.BeforeBehavior,
      { monster, nowMs: now },
    );
    if (behaviorVetoReason !== SystemErrCode.Success) {
      // Core只兑现“本Tick不行动”的中立契约；为何阻止由外置游戏模块解释。
      // Core only enforces the neutral "skip this tick" contract; the external
      // game module owns the meaning of the veto reason.
      this.StopMonsterMovement(monster, state);
      return;
    }

    const monsterPosition = monster.GetComponent(PositionComponent);
    const spawn = monster.GetComponent(MonsterSpawnProfileComponent).Point;
    const returnPoint = state.combatReturnPoint ?? spawn;
    const returnDistance = Math.sqrt(distanceSquared(
      monsterPosition.x,
      monsterPosition.z,
      returnPoint.x,
      returnPoint.z,
    ));
    if (state.returningToSpawn) {
      if (returnDistance <= MONSTER_SPAWN_ARRIVAL_RANGE_METERS) {
        this.FinishMonsterReturn(monster, state, now, returnPoint);
        return;
      }
      this.SetMonsterMoveSpeed(monsterPosition, config.moveSpeed);
      this.MoveMonsterToward(monster, {
        x: returnPoint.x,
        y: returnPoint.y,
        z: returnPoint.z,
      }, state);
      return;
    }

    const wasEngaged = state.targetUnitId !== 0 || state.threatByUnitId.size > 0;
    const target = this.FindMonsterTarget(monster, config, state);
    if (target) this.BeginMonsterEngagement(monster, target, state);
    // AuraState is polled at the same authoritative 5 Hz boundary as movement;
    // matched rules schedule their own source-declared repeat interval. The
    // content contract carries only opaque Buff ids and ability requests.
    const auraRequestedEvade = this.TriggerMonsterBehavior(
      monster,
      target,
      state,
      MonsterContentBehaviorTrigger.AuraState,
      now,
    );
    if (auraRequestedEvade) return;
    if (target && this.TriggerMonsterBehavior(
      monster,
      target,
      state,
      MonsterContentBehaviorTrigger.CombatInterval,
      now,
    )) return;
    if (target && this.TriggerMonsterBehavior(
      monster,
      target,
      state,
      MonsterContentBehaviorTrigger.HealthRange,
      now,
    )) return;
    const engagementPoint = state.combatReturnPoint ?? spawn;
    const engagementDistance = Math.sqrt(distanceSquared(
      monsterPosition.x,
      monsterPosition.z,
      engagementPoint.x,
      engagementPoint.z,
    ));
    const hasAmbientMovement = (spawnConfig.waypoints?.length ?? 0) > 0
      || (spawnConfig.wanderRadius ?? 0) > 0;
    const mustReturn = (
      (wasEngaged && target === undefined) ||
      (target !== undefined && engagementDistance > MONSTER_LEASH_RANGE_METERS) ||
      (
        target === undefined
        && !hasAmbientMovement
        && engagementDistance > MONSTER_SPAWN_ARRIVAL_RANGE_METERS
      )
    );
    if (mustReturn) {
      // 回归不是瞬移：先原子清仇恨和玩家战斗来源，再由同一移动接口回到固定刷点。
      // A leash return is not a teleport: atomically clear threat and player
      // combat sources, then use the normal movement path to reach the spawn.
      this.ClearThreat(monster, state, now);
      if (engagementDistance <= MONSTER_SPAWN_ARRIVAL_RANGE_METERS) {
        this.FinishMonsterReturn(monster, state, now, engagementPoint);
        return;
      }
      state.returningToSpawn = true;
      this.SetMonsterMoveSpeed(monsterPosition, config.moveSpeed);
      this.MoveMonsterToward(monster, {
        x: engagementPoint.x,
        y: engagementPoint.y,
        z: engagementPoint.z,
      }, state);
      return;
    }

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
    if (target) this.SetMonsterMoveSpeed(monsterPosition, config.moveSpeed);
    switch (action) {
      case "attack":
        this.StopMonsterMovement(monster, state);
        this.AttackPlayer(monster, target!);
        state.nextAttackAtMs = now + this.readAttackIntervalMs(monster);
        return;
      case "hold":
        this.StopMonsterMovement(monster, state);
        return;
      case "idle":
        this.TickMonsterAmbientMovement(monster, config, spawnConfig, state, now);
        return;
      case "chase":
        this.MoveMonsterToward(monster, targetPosition!, state);
        return;
    }
  }

  /** 战斗空闲时运行循环路径或有界随机游走。 / Runs a repeating waypoint route or bounded random wandering while combat is idle. */
  private TickMonsterAmbientMovement(
    monster: MonsterUnit,
    config: MonsterContentDefinition,
    spawn: Readonly<MonsterContentSpawn>,
    state: MonsterRuntimeState,
    now: number,
  ): void {
    this.TickMonsterIdleSequences(monster, spawn, state, now);
    const position = monster.GetComponent(PositionComponent);
    const waypoints = spawn.waypoints ?? [];
    if (waypoints.length > 0) {
      if (state.ambientWaypointActiveIndex >= 0) {
        const activeWaypoint = waypoints[state.ambientWaypointActiveIndex];
        if (!activeWaypoint) {
          this.ClearActiveWaypoint(state);
        } else {
          this.TickMonsterWaypointActions(monster, spawn, activeWaypoint, state, now);
          // RestartRoute clears the active waypoint and deliberately falls
          // through so navigation to the first route point starts this tick.
          if (state.ambientWaypointActiveIndex >= 0) {
            if (now < state.ambientPauseUntilMs) {
              if (state.ambientWaypointWanderRadius > 0) {
                this.TickMonsterWaypointWander(
                  monster,
                  config,
                  spawn,
                  activeWaypoint,
                  state,
                  now,
                );
              } else {
                this.StopMonsterMovement(monster, state);
              }
              return;
            }
            this.ClearActiveWaypoint(state);
          }
        }
      }
      const waypointIndex = state.ambientWaypointIndex % waypoints.length;
      const waypoint = waypoints[waypointIndex];
      if (this.HasMonsterArrived(position, waypoint)) {
        this.StopMonsterMovement(monster, state);
        position.y = waypoint.y;
        if (waypoint.yaw !== undefined) position.yaw = waypoint.yaw;
        state.ambientWaypointIndex = (waypointIndex + 1) % waypoints.length;
        state.ambientWaypointActiveIndex = waypointIndex;
        state.ambientWaypointArrivedAtMs = now;
        state.ambientWaypointActionIndex = 0;
        state.ambientWaypointArrivalSequence += 1;
        state.ambientWaypointWanderRadius = 0;
        state.ambientWaypointWanderPauseUntilMs = 0;
        state.ambientTarget = null;
        state.ambientPauseUntilMs = now + waypoint.delayMs;
        this.TickMonsterWaypointActions(monster, spawn, waypoint, state, now);
        return;
      }
      this.SetMonsterMoveSpeed(position, waypoint.moveSpeed ?? config.moveSpeed);
      this.MoveMonsterToward(monster, waypoint, state);
      return;
    }

    if (now < state.ambientPauseUntilMs) {
      this.StopMonsterMovement(monster, state);
      return;
    }
    const wanderRadius = spawn.wanderRadius ?? 0;
    if (wanderRadius <= 0) {
      this.StopMonsterMovement(monster, state);
      return;
    }
    if (state.ambientTarget && this.HasMonsterArrived(position, state.ambientTarget)) {
      this.StopMonsterMovement(monster, state);
      position.y = state.ambientTarget.y;
      state.ambientTarget = null;
      state.ambientWanderLegsSincePause += 1;
      const schedule = spawn.wanderSchedule;
      if (
        schedule === undefined
        || ShouldPauseMonsterWander(
          spawn.id,
          state.ambientWanderSequence,
          state.ambientWanderLegsSincePause,
          schedule.firstLegPauseChancePermille,
          schedule.additionalLegPauseChancePermille,
        )
      ) {
        state.ambientPauseUntilMs = now + (schedule === undefined
          ? MonsterWanderPauseMs(spawn.id, state.ambientWanderSequence)
          : SelectMonsterWanderPauseMs(
            spawn.id,
            state.ambientWanderSequence,
            schedule.pauseMinMs,
            schedule.pauseMaxMs,
          ));
        state.ambientWanderLegsSincePause = 0;
        return;
      }
    }
    if (!state.ambientTarget) {
      state.ambientTarget = this.SelectMonsterWanderTarget(monster, spawn, state);
      if (!state.ambientTarget) {
        this.StopMonsterMovement(monster, state);
        state.ambientPauseUntilMs = now + 4_000;
        return;
      }
    }
    this.SetMonsterMoveSpeed(position, spawn.wanderMoveSpeed ?? config.moveSpeed);
    this.MoveMonsterToward(monster, state.ambientTarget, state);
  }

  /** 执行挂在已到达路径点上的延迟、源中立动作。 / Executes delayed, source-neutral actions attached to the reached waypoint. */
  private TickMonsterWaypointActions(
    monster: MonsterUnit,
    spawn: Readonly<MonsterContentSpawn>,
    waypoint: NonNullable<MonsterContentSpawn["waypoints"]>[number],
    state: MonsterRuntimeState,
    now: number,
  ): void {
    const actions = waypoint.actions ?? [];
    while (state.ambientWaypointActionIndex < actions.length) {
      const action = actions[state.ambientWaypointActionIndex];
      if (state.ambientWaypointArrivedAtMs + action.delayMs > now) return;
      state.ambientWaypointActionIndex += 1;
      if (
        action.chancePermille < 1_000
        && RollMonsterBehaviorPermille(
          spawn.id,
          action.id,
          state.ambientWaypointArrivalSequence,
        ) >= action.chancePermille
      ) continue;
      if (action.type === MonsterContentWaypointActionType.SetEmoteState) {
        const presentationId = action.presentationId ?? 0;
        monster.SetPresentationState(presentationId);
        this.PublishMonsterPresentation(monster, {
          type: UnitPresentationType.EmoteState,
          targetUnitId: 0,
          presentationId,
          text: "",
        });
        continue;
      }
      if (action.type === MonsterContentWaypointActionType.SetModel) {
        const modelId = action.modelId ?? "";
        if (!modelId) continue;
        monster.SetPresentationModel(modelId);
        this.PublishMonsterPresentation(monster, {
          type: UnitPresentationType.Model,
          targetUnitId: 0,
          presentationId: 0,
          text: modelId,
        });
        continue;
      }
      if (action.type === MonsterContentWaypointActionType.BeginWander) {
        state.ambientWaypointWanderRadius = action.wanderRadius ?? 0;
        state.ambientWaypointWanderPauseUntilMs = 0;
        state.ambientTarget = null;
        continue;
      }
      if (action.type === MonsterContentWaypointActionType.RestartRoute) {
        state.ambientWaypointIndex = 0;
        this.ClearActiveWaypoint(state);
        this.StopMonsterMovement(monster, state);
        return;
      }
    }
  }

  /** 在路径恢复前围绕已到达路径点执行临时有界游走。 / Runs temporary bounded wandering around a reached waypoint until the route resumes. */
  private TickMonsterWaypointWander(
    monster: MonsterUnit,
    config: MonsterContentDefinition,
    spawn: Readonly<MonsterContentSpawn>,
    waypoint: NonNullable<MonsterContentSpawn["waypoints"]>[number],
    state: MonsterRuntimeState,
    now: number,
  ): void {
    if (now < state.ambientWaypointWanderPauseUntilMs) {
      this.StopMonsterMovement(monster, state);
      return;
    }
    const position = monster.GetComponent(PositionComponent);
    if (state.ambientTarget && this.HasMonsterArrived(position, state.ambientTarget)) {
      this.StopMonsterMovement(monster, state);
      position.y = state.ambientTarget.y;
      state.ambientTarget = null;
      state.ambientWaypointWanderPauseUntilMs = now + MonsterWanderPauseMs(
        spawn.id,
        state.ambientWanderSequence,
      );
      return;
    }
    if (!state.ambientTarget) {
      state.ambientTarget = this.SelectMonsterWanderTarget(
        monster,
        spawn,
        state,
        waypoint,
        state.ambientWaypointWanderRadius,
      );
      if (!state.ambientTarget) {
        this.StopMonsterMovement(monster, state);
        state.ambientWaypointWanderPauseUntilMs = now + 4_000;
        return;
      }
    }
    this.SetMonsterMoveSpeed(position, config.moveSpeed);
    this.MoveMonsterToward(monster, state.ambientTarget, state);
  }

  private ClearActiveWaypoint(state: MonsterRuntimeState): void {
    state.ambientWaypointActiveIndex = -1;
    state.ambientWaypointArrivedAtMs = 0;
    state.ambientWaypointActionIndex = 0;
    state.ambientWaypointWanderRadius = 0;
    state.ambientWaypointWanderPauseUntilMs = 0;
    state.ambientPauseUntilMs = 0;
    state.ambientWanderLegsSincePause = 0;
    state.ambientTarget = null;
    state.navigationTarget = null;
  }

  /** 选择有界目标并应用当前地图的空间投影策略。 / Selects a bounded target and applies the current map's spatial projection policy. */
  private SelectMonsterWanderTarget(
    monster: MonsterUnit,
    spawn: Readonly<MonsterContentSpawn>,
    state: MonsterRuntimeState,
    center?: { readonly x: number; readonly y: number; readonly z: number },
    radiusOverride?: number,
  ): { readonly x: number; readonly y: number; readonly z: number } | null {
    const radius = radiusOverride ?? spawn.wanderRadius ?? 0;
    const position = monster.GetComponent(PositionComponent);
    const origin = {
      x: center?.x ?? spawn.spawnX,
      y: position.y,
      z: center?.z ?? spawn.spawnZ,
    };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      state.ambientWanderSequence += 1;
      const candidate = SelectMonsterWanderPoint(
        origin,
        radius,
        spawn.id,
        state.ambientWanderSequence,
      );
      if (this.map.SpatialProfile.spatialMode === SpatialMode.Grid2D) {
        const cellSize = this.map.SpatialProfile.cellSizeMeters;
        const cellX = Math.round(candidate.x / cellSize);
        const cellZ = Math.round(candidate.z / cellSize);
        if (!position.CanOccupy(cellX, cellZ)) continue;
        const projected = {
          x: cellX * cellSize,
          y: candidate.y,
          z: cellZ * cellSize,
        };
        if (
          distanceSquared(projected.x, projected.z, origin.x, origin.z)
            > radius * radius + 1e-6
          || this.HasMonsterArrived(position, projected)
        ) continue;
        return projected;
      }
      const projected = this.map.ProjectPosition(candidate);
      if (
        !projected
        || distanceSquared(projected.x, projected.z, origin.x, origin.z)
          > radius * radius + 1e-6
        || this.HasMonsterArrived(position, projected)
      ) continue;
      return projected;
    }
    return null;
  }

  private HasMonsterArrived(
    position: PositionComponent,
    target: { readonly x: number; readonly z: number },
  ): boolean {
    return distanceSquared(position.x, position.z, target.x, target.z)
      <= MONSTER_SPAWN_ARRIVAL_RANGE_METERS * MONSTER_SPAWN_ARRIVAL_RANGE_METERS;
  }

  private SetMonsterMoveSpeed(position: PositionComponent, moveSpeed: number): void {
    if (Math.abs(position.SpeedMetersPerSecond - moveSpeed) <= 1e-6) return;
    position.SpeedMetersPerSecond = moveSpeed;
  }

  /** 记录巡逻/游走被打断的位置，使脱战能够自然恢复。 / Captures where patrol or wandering was interrupted so evade resumes naturally. */
  private BeginMonsterEngagement(
    monster: MonsterUnit,
    target: PlayerUnit,
    state: MonsterRuntimeState,
  ): void {
    if (state.combatReturnPoint) return;
    const position = monster.GetComponent(PositionComponent);
    state.combatReturnPoint = { x: position.x, y: position.y, z: position.z };
    // 战斗从此刻接管移动；立即停止旧的巡逻/游走输入，避免高速怪在下一次5Hz判定前穿过近战目标。
    // Combat owns movement from this point onward. Stop the previous patrol or
    // wander input immediately so a fast monster cannot cross a melee target
    // before the next 5 Hz behavior decision.
    this.StopMonsterMovement(monster, state);
    this.ClearActiveWaypoint(state);
    state.idleSequenceStates.clear();
    state.triggeredBehaviorRuleIds.clear();
    state.behaviorEncounterSequence += 1;
    this.TriggerMonsterBehavior(monster, target, state, MonsterContentBehaviorTrigger.Engage);
  }

  /** 推进仅在脱战空闲阶段运行的定时表现序列。 / Advances timed presentation sequences that run only while the monster is idle out of combat. */
  private TickMonsterIdleSequences(
    monster: MonsterUnit,
    spawn: Readonly<MonsterContentSpawn>,
    state: MonsterRuntimeState,
    now: number,
  ): void {
    for (const sequence of spawn.idleSequences ?? []) {
      let runtime = state.idleSequenceStates.get(sequence.id);
      if (!runtime) {
        runtime = {
          nextTriggerAtMs: now + SelectMonsterBehaviorDelayMs(
            spawn.id,
            sequence.id,
            0,
            sequence.initialDelayMinMs,
            sequence.initialDelayMaxMs,
          ),
          activeSinceMs: -1,
          nextActionIndex: 0,
          executionSequence: 0,
        };
        state.idleSequenceStates.set(sequence.id, runtime);
      }
      if (runtime.activeSinceMs < 0 && now >= runtime.nextTriggerAtMs) {
        runtime.executionSequence += 1;
        runtime.nextTriggerAtMs = now + SelectMonsterBehaviorDelayMs(
          spawn.id,
          sequence.id,
          runtime.executionSequence,
          sequence.repeatDelayMinMs,
          sequence.repeatDelayMaxMs,
        );
        runtime.nextActionIndex = 0;
        if (
          sequence.chancePermille < 1_000
          && RollMonsterBehaviorPermille(
            spawn.id,
            sequence.id,
            runtime.executionSequence,
          ) >= sequence.chancePermille
        ) continue;
        runtime.activeSinceMs = now;
      }
      if (runtime.activeSinceMs < 0) continue;
      while (runtime.nextActionIndex < sequence.actions.length) {
        const action = sequence.actions[runtime.nextActionIndex];
        if (runtime.activeSinceMs + action.delayMs > now) break;
        runtime.nextActionIndex += 1;
        if (
          action.chancePermille < 1_000
          && RollMonsterBehaviorPermille(
            spawn.id,
            action.id,
            runtime.executionSequence,
          ) >= action.chancePermille
        ) continue;
        this.ExecuteMonsterIdleAction(monster, action, runtime.executionSequence);
      }
      if (runtime.nextActionIndex >= sequence.actions.length) runtime.activeSinceMs = -1;
    }
  }

  /** 解析稳定刷点执行者并发布一次中立表现。 / Resolves a stable-spawn actor and publishes one neutral presentation. */
  private ExecuteMonsterIdleAction(
    source: MonsterUnit,
    action: import("#tiangz/model").MonsterContentIdleAction,
    executionSequence = 0,
  ): void {
    const actor = action.target === MonsterContentIdleActionTarget.StableSpawn
      ? this.slots.get(action.targetSpawnId ?? 0)?.monster
      : source;
    if (!actor) return;
    if (action.type === MonsterContentIdleActionType.Emote) {
      this.PublishMonsterPresentation(actor, {
        type: UnitPresentationType.Emote,
        targetUnitId: 0,
        presentationId: action.presentationId ?? 0,
        text: "",
      });
      return;
    }
    if (action.type === MonsterContentIdleActionType.Say) {
      const choices = action.textChoices ?? [];
      if (choices.length === 0) return;
      const index = RollMonsterBehaviorPermille(
        source.AreaId,
        action.id,
        executionSequence,
      ) % choices.length;
      this.PublishMonsterPresentation(actor, {
        type: UnitPresentationType.Say,
        targetUnitId: 0,
        presentationId: 0,
        text: choices[index] ?? "",
      });
    }
  }

  /** 在一个运行时触发边界执行模块持有、源引擎中立的规则。 / Executes module-owned, source-engine-neutral rules at one runtime trigger boundary. */
  private TriggerMonsterBehavior(
    monster: MonsterUnit,
    target: PlayerUnit | undefined,
    state: MonsterRuntimeState,
    trigger: import("#tiangz/model").MonsterContentBehaviorTriggerValue,
    nowMs: number = TimeSystem.Instance.ServerNow,
    signalId = 0,
  ): boolean {
    const slot = this.slots.get(monster.AreaId);
    if (!slot) return false;
    // Per-spawn rules are an explicit script replacement. If absent, inherit
    // the entry/template rules, matching source engines with GUID overrides.
    const rules = slot.config.behaviorRules !== undefined
      ? slot.config.behaviorRules
      : (slot.definition.behaviorRules ?? []);
    let requestedEvade = false;
    if (trigger === MonsterContentBehaviorTrigger.AuraState) {
      const observedBuffIds = new Set(
        rules
          .filter((rule) => rule.trigger === MonsterContentBehaviorTrigger.AuraState)
          .map((rule) => rule.requiredBuffDefinitionId ?? 0)
          .filter((buffId) => buffId > 0),
      );
      const buffs = monster.GetComponent(BuffComponent);
      for (const buffId of observedBuffIds) {
        const present = buffs.HasBuffConfig(buffId);
        state.behaviorBuffStates.set(buffId, present);
      }
    }
    for (const rule of rules) {
      if (rule.trigger !== trigger) continue;
      if (trigger === MonsterContentBehaviorTrigger.ExternalSignal) {
        if (rule.requiredSignalId !== signalId) continue;
        const nextAtMs = state.behaviorRuleNextAtMs.get(rule.id) ?? nowMs;
        if (nowMs < nextAtMs) continue;
      }
      if (trigger === MonsterContentBehaviorTrigger.CombatInterval) {
        if (!target) continue;
        let nextAtMs = state.behaviorRuleNextAtMs.get(rule.id);
        if (nextAtMs === undefined) {
          nextAtMs = nowMs + SelectMonsterBehaviorDelayMs(
            slot.config.id,
            rule.id,
            0,
            rule.initialDelayMinMs ?? 0,
            rule.initialDelayMaxMs ?? 0,
          );
          state.behaviorRuleNextAtMs.set(rule.id, nextAtMs);
        }
        if (nowMs < nextAtMs) continue;
      }
      if (trigger === MonsterContentBehaviorTrigger.AuraState) {
        const buffId = rule.requiredBuffDefinitionId ?? 0;
        if (state.behaviorBuffStates.get(buffId) !== rule.requiredBuffPresent) continue;
        const nextAtMs = state.behaviorRuleNextAtMs.get(rule.id) ?? nowMs;
        if (nowMs < nextAtMs) continue;
      }
      if (trigger === MonsterContentBehaviorTrigger.HealthRange) {
        const repeatable = rule.repeatDelayMinMs !== undefined;
        if (!repeatable && state.triggeredBehaviorRuleIds.has(rule.id)) continue;
        if (repeatable) {
          const nextAtMs = state.behaviorRuleNextAtMs.get(rule.id) ?? nowMs;
          if (nowMs < nextAtMs) continue;
        }
        const numeric = monster.GetComponent(NumericComponent);
        const maximum = numeric[NumericType.MaxHp];
        const healthPermille = maximum > 0n
          ? Number(numeric[NumericType.CurrentHp] * 1_000n / maximum)
          : 0;
        if (
          healthPermille < (rule.minHealthPermille ?? 0)
          || healthPermille > (rule.maxHealthPermille ?? 1_000)
        ) continue;
        // Omitting a repeat interval makes the rule encounter-scoped. Supplying
        // one keeps it eligible while health remains inside the declared range.
        // A failed chance roll still consumes this evaluation window.
        if (!repeatable) state.triggeredBehaviorRuleIds.add(rule.id);
      }
      const chanceSequence = trigger === MonsterContentBehaviorTrigger.ExternalSignal
        ? (state.behaviorRuleExecutionSequences.get(rule.id) ?? 0)
        : state.behaviorEncounterSequence;
      const chanceRejected = (
        rule.chancePermille < 1_000
        && RollMonsterBehaviorPermille(
          slot.config.id,
          rule.id,
          chanceSequence,
        ) >= rule.chancePermille
      );
      if (!chanceRejected) rule.actions.forEach((action, actionIndex) => {
        const actionTarget = action.target === MonsterContentBehaviorTarget.Self
          ? monster
          : target;
        if (
          action.requiredAbsentBuffDefinitionId !== undefined
          && actionTarget?.TryGetComponent(BuffComponent)?.HasBuffConfig(
            action.requiredAbsentBuffDefinitionId,
          ) === true
        ) return;
        const targetUnitId = action.target === MonsterContentBehaviorTarget.CombatTarget
          ? (target?.UnitId ?? 0)
          : 0;
        if (action.type === MonsterContentBehaviorActionType.Say) {
          const text = SelectMonsterBehaviorText(
            action,
            slot.config.id,
            rule.id,
            chanceSequence,
            actionIndex,
          );
          if (text) this.PublishMonsterPresentation(monster, {
            type: UnitPresentationType.Say,
            targetUnitId,
            presentationId: 0,
            text,
          });
          return;
        }
        if (action.type === MonsterContentBehaviorActionType.Emote) {
          this.PublishMonsterPresentation(monster, {
            type: UnitPresentationType.Emote,
            targetUnitId,
            presentationId: action.presentationId ?? 0,
            text: "",
          });
          return;
        }
        if (action.type === MonsterContentBehaviorActionType.ApplyBuff) {
          const buffTarget = actionTarget;
          if (!buffTarget) return;
          buffTarget.GetComponent(BuffComponent).ApplyBuff(action.buffDefinitionId ?? 0, {
            sourceUnitId: monster.UnitId,
            sourceAbilityId: action.sourceAbilityId ?? 0,
          });
          return;
        }
        if (action.type === MonsterContentBehaviorActionType.ExecuteAbility) {
          this.DomainScene().Events.Publish(MonsterEvents.BehaviorActionRequested, {
            monster,
            ...(target ? { target } : {}),
            action,
            nowMs,
          });
          return;
        }
        if (action.type === MonsterContentBehaviorActionType.Evade) {
          this.BeginMonsterEvade(monster, state, nowMs);
          requestedEvade = true;
        }
      });
      if (
        trigger === MonsterContentBehaviorTrigger.AuraState
        || trigger === MonsterContentBehaviorTrigger.CombatInterval
        || trigger === MonsterContentBehaviorTrigger.ExternalSignal
        || (
          trigger === MonsterContentBehaviorTrigger.HealthRange
          && rule.repeatDelayMinMs !== undefined
        )
      ) {
        const executionSequence = (state.behaviorRuleExecutionSequences.get(rule.id) ?? 0) + 1;
        state.behaviorRuleExecutionSequences.set(rule.id, executionSequence);
        const repeatMinMs = rule.repeatDelayMinMs ?? 0;
        const repeatMaxMs = rule.repeatDelayMaxMs ?? repeatMinMs;
        state.behaviorRuleNextAtMs.set(
          rule.id,
          nowMs + SelectMonsterBehaviorDelayMs(
            slot.config.id,
            rule.id,
            executionSequence,
            repeatMinMs,
            repeatMaxMs,
          ),
        );
      }
    }
    return requestedEvade;
  }

  /** 执行SmartAI Evade动作背后的中立重置/回归语义。 / Executes the neutral reset/return semantics behind SmartAI's Evade action. */
  private BeginMonsterEvade(monster: MonsterUnit, state: MonsterRuntimeState, nowMs: number): void {
    this.ClearThreat(monster, state, nowMs);
    state.behaviorBuffStates.clear();
    state.behaviorRuleNextAtMs.clear();
    state.behaviorRuleExecutionSequences.clear();
    const position = monster.GetComponent(PositionComponent);
    const spawn = monster.GetComponent(MonsterSpawnProfileComponent).Point;
    state.combatReturnPoint = { x: spawn.x, y: spawn.y, z: spawn.z };
    if (distanceSquared(position.x, position.z, spawn.x, spawn.z)
      <= MONSTER_SPAWN_ARRIVAL_RANGE_METERS * MONSTER_SPAWN_ARRIVAL_RANGE_METERS) {
      state.returningToSpawn = false;
      state.combatReturnPoint = null;
      this.StopMonsterMovement(monster, state);
      return;
    }
    state.returningToSpawn = true;
    this.StopMonsterMovement(monster, state);
  }

  private PublishMonsterPresentation(
    monster: MonsterUnit,
    presentation: import("#tiangz/model").UnitPresentation,
  ): void {
    void this.map.PublishUnitPresentation(monster, presentation).catch((error) => {
      this.DomainScene().logger.error("monster presentation publish failed", {
        unitId: monster.UnitId,
        areaId: monster.AreaId,
        presentationType: presentation.type,
        error,
      });
    });
  }

  /** 统一处理追击和回归刷点，避免两套移动语义导致回归时速度或导航模式不一致。 / Uses one path for chasing and returning so speed and spatial mode stay consistent. */
  private MoveMonsterToward(
    monster: MonsterUnit,
    target: { readonly x: number; readonly y: number; readonly z: number },
    state: MonsterRuntimeState,
  ): void {
    const native = monster.GetComponent(NativeUnitRef);
    const previousTarget = state.navigationTarget;
    if (previousTarget && distanceSquared(
      previousTarget.x,
      previousTarget.z,
      target.x,
      target.z,
    ) <= 0.25 && Math.abs(previousTarget.y - target.y) <= 0.5) {
      return;
    }
    state.navigationSequence += 1;
    if (this.map.SpatialProfile.spatialMode === SpatialMode.Grid2D) {
      const cellSize = this.map.SpatialProfile.cellSizeMeters;
      NativeData.SetGridMovementTarget(
        native.Handle,
        Math.round(target.x / cellSize),
        Math.round(target.z / cellSize),
        state.navigationSequence,
      );
    } else {
      NativeData.SetNavigationTarget(
        this.map.NativeMapKey,
        native.Handle,
        { x: target.x, y: target.y, z: target.z },
        state.navigationSequence,
      );
    }
    state.navigationTarget = { x: target.x, y: target.y, z: target.z };
  }

  /** 停止当前导航并清除去重游标；下一次移动即使目标相同也会重新提交。 / Stops navigation and clears the deduplication cursor so the next move is submitted even when its target is unchanged. */
  private StopMonsterMovement(monster: MonsterUnit, state: MonsterRuntimeState): void {
    state.navigationTarget = null;
    NativeData.ResetMovement(monster.GetComponent(NativeUnitRef).Handle);
  }

  /** 完成Evade回归：再次清理途中产生的旧引用、停止移动并恢复本次遭遇的生命值。 / Completes an evade return by clearing stale combat references again, stopping movement, and restoring encounter health. */
  private FinishMonsterReturn(
    monster: MonsterUnit,
    state: MonsterRuntimeState,
    now: number,
    returnPoint: { readonly x: number; readonly y: number; readonly z: number },
  ): void {
    this.ClearThreat(monster, state, now);
    state.returningToSpawn = false;
    state.nextAttackAtMs = 0;
    state.behaviorBuffStates.clear();
    state.behaviorRuleNextAtMs.clear();
    state.behaviorRuleExecutionSequences.clear();
    this.StopMonsterMovement(monster, state);
    monster.GetComponent(PositionComponent).y = returnPoint.y;
    state.combatReturnPoint = null;
    const numeric = monster.GetComponent(NumericComponent);
    numeric[NumericType.CurrentHp] = numeric[NumericType.MaxHp];
    numeric[NumericType.CurrentMp] = numeric[NumericType.MaxMp];
    monster.TryGetComponent(NumericRegenerationComponent)?.ResetSchedule();
  }

  /** 怪物伤害也从自身Numeric.Attack读取；配置只负责初始化，战斗不再绕过数值系统。 / Reads monster Numeric.Attack for damage so config initializes combat without bypassing Numeric during combat. */
  private AttackPlayer(monster: MonsterUnit, target: PlayerUnit): void {
    const state = this.runtime.get(monster.UnitId);
    if (state) {
      // 主动怪仅靠索敌获得目标时也算进入战斗，但不能把怪物攻击误记为掉落归属。
      // An actively acquired target is in combat too, but a monster hit must
      // never become the account that owns the monster's loot.
      this.MarkCombatThreat(monster, target, state, 1n, TimeSystem.Instance.ServerNow);
    }
    const monsterNumeric = monster.GetComponent(NumericComponent);
    const damage = monsterNumeric[NumericType.Attack] > 0n
      ? monsterNumeric[NumericType.Attack]
      : 0n;
    this.map.ApplyDamageToPlayer(monster, target, {
      amount: damage,
      canBePrevented: true,
    });
  }

  /**
   * 处理所有玩家的自动攻击状态：目标失效时关闭，激活后持续推进武器计时，
   * 计时到点但距离或朝向暂时无效时保持就绪，并在后续10Hz帧重试；成功命中后才开始下一轮。
   * 这样移动目标不会让整轮武器计时反复归零。目标朝向使用服务端Yaw，前方有效扇形固定为120度。
   *
   * Processes every player's auto-attack state: invalid targets disable the
   * intent, an active weapon timer keeps advancing, and a ready swing whose
   * range/facing window is temporarily invalid remains ready for a later 10 Hz
   * retry. Only a successful hit starts the next full interval. Facing uses
   * server yaw with a fixed 120-degree forward cone.
   */
  private TickPlayerAutoAttacks(now: number): void {
    for (const player of this.units.GetAll(PlayerUnit)) {
      player.GetComponent(CombatStateComponent).TickResources(now);
      const combat = player.GetComponent(CombatComponent);
      if (player.GetComponent(NativeUnitRef).alive === 0) {
        // 玩家死亡后不能继续保留攻击意图；显式推送关闭状态，避免客户端读条停在最后一帧。
        // A dead player cannot keep attack intent; publish an explicit stop so the client
        // does not leave the progress bar frozen at its last frame.
        const state = combat.AutoAttackState();
        if (state.enabled || state.phase !== AutoAttackPhase.Inactive) {
          this.PublishAutoAttackState(player, combat.ToggleAutoAttack(0, false));
        }
        player.GetComponent(CombatStateComponent).Clear(now);
        continue;
      }
      player.TryGetComponent(NumericRegenerationComponent)?.Tick(now);
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

      const monsterTarget = this.monsters.get(state.targetUnitId);
      const npcTarget = monsterTarget
        ? undefined
        : this.DomainScene().TryGetComponent(NpcComponent)?.Get(state.targetUnitId);
      const target = monsterTarget ?? npcTarget;
      if (!target || target.GetComponent(NativeUnitRef).alive === 0) {
        const stopped = combat.ToggleAutoAttack(0, false);
        this.PublishAutoAttackState(player, stopped);
        continue;
      }

      if (state.phase !== AutoAttackPhase.Swinging || state.swingStartAtMs === 0) {
        this.PublishAutoAttackState(player, combat.BeginAutoAttackSwing(now));
        continue;
      }
      if (now - state.swingStartAtMs < state.swingIntervalMs) continue;

      // 到点后按10Hz重试距离与朝向；失败不重置整把武器的间隔，成功命中后才开启下一轮。 / Retry range and facing at 10 Hz once ready; a failed window does not restart the full weapon interval, while a hit does.
      if (!this.CanAutoAttack(player, target)) {
        continue;
      }
      const result = monsterTarget
        ? this.Attack(player, monsterTarget.UnitId)
        : this.DomainScene().GetComponent(NpcComponent).Attack(player, npcTarget!);
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
  private CanAutoAttack(attacker: PlayerUnit, target: MonsterUnit | NpcUnit): boolean {
    if (target instanceof MonsterUnit) {
      if (this.runtime.get(target.UnitId)?.returningToSpawn) return false;
      if (!this.CanPlayerAttack(attacker, target)) return false;
    } else if (!this.DomainScene().GetComponent(NpcComponent).CanPlayerAttack(attacker, target)) {
      return false;
    }
    const attackerPosition = attacker.GetComponent(PositionComponent);
    const targetPosition = target.GetComponent(PositionComponent);
    const attackRange = attacker.GetComponent(CombatComponent).AutoAttackRangeMeters();
    if (distanceSquared(attackerPosition.x, attackerPosition.z, targetPosition.x, targetPosition.z)
      > attackRange * attackRange) {
      return false;
    }
    const targetAngle = Math.atan2(
      targetPosition.x - attackerPosition.x,
      targetPosition.z - attackerPosition.z,
    );
    const angleDelta = normalizeRadians(targetAngle - attackerPosition.yaw);
    return Math.abs(angleDelta) <= AUTO_ATTACK_FACING_HALF_ANGLE;
  }

  /** 异步发布状态但不阻塞10Hz战斗桶；广播失败只记录，不回滚已经结算的伤害。 / Publishes without blocking the 10Hz bucket; failures are logged and never roll back resolved damage. */
  private PublishCombatDamage(
    target: MonsterUnit | NpcUnit | PlayerUnit,
    sourceUnitId: number,
    result: DamageResult,
    abilityId = 0,
  ): void {
    void this.map.PublishCombatDamage(target, sourceUnitId, result, abilityId).catch((error) => {
      this.DomainScene().logger.error("private combat damage publish failed", {
        sourceUnitId,
        targetUnitId: target.UnitId,
        abilityId,
        error,
      });
    });
  }

  /** 异步发布状态但不阻塞10Hz战斗桶；广播失败只记录，不回滚已经结算的伤害。 / Publishes without blocking the 10Hz bucket; failures are logged and never roll back resolved damage. */
  private PublishAutoAttackState(player: PlayerUnit, state: AutoAttackState): void {
    void this.map.PublishAutoAttackState(player, state).catch((error) => {
      this.DomainScene().logger.error("auto attack state publish failed", { error });
    });
  }

  private Kill(monster: MonsterUnit, fallbackLootOwnerAccount: string): void {
    const slot = this.slots.get(monster.AreaId);
    if (!slot || slot.monster !== monster) return;
    const now = TimeSystem.Instance.ServerNow;
    const config = slot.definition;
    const state = this.runtime.get(monster.UnitId);
    const lootOwnerAccount = state?.lootOwnerAccount ?? fallbackLootOwnerAccount;
    if (state) this.ClearThreat(monster, state, now);
    const drops = this.RollLootDrops(monster, config);
    const corpseLifetimeMs = drops.length > 0
      ? CORPSE_WITH_LOOT_LIFETIME_MS
      : EMPTY_CORPSE_LIFETIME_MS;
    const corpseExpiresAtMs = now + corpseLifetimeMs;
    // Respawn and corpse expiration are independent: the slot becomes free now,
    // while the dead Unit stays addressable for loot and visual state.
    // 重生与尸体过期互相独立：槽位立即释放，死亡Unit继续承载拾取和表现。
    slot.monster = null;
    const respawnAtMs = now + slot.config.respawnSeconds * 1_000;
    const selection = this.SpawnSelection();
    if (
      selection?.Owns(SpawnSelectionCandidateKind.Monster, slot.config.id)
      && selection.Release(SpawnSelectionCandidateKind.Monster, slot.config.id, respawnAtMs)
    ) {
      slot.respawnAtMs = 0;
    } else {
      slot.respawnAtMs = respawnAtMs;
    }
    this.corpses.set(monster.UnitId, {
      monster,
      corpseExpiresAtMs,
      corpseCleanupInFlight: false,
    });
    this.CreateLootContainer(monster, drops, corpseExpiresAtMs, lootOwnerAccount);
    this.DomainScene().logger.info("monster loot container created", {
      monsterId: monster.UnitId,
      monsterConfigId: monster.MonsterConfigId,
      lootOwnerAccount,
      dropIds: drops.map((drop) => ({
        dropId: drop.dropId,
        itemConfigId: drop.configId,
        count: drop.count,
        questObjectiveId: drop.questObjectiveId,
      })),
    });
    const native = monster.GetComponent(NativeUnitRef);
    native.alive = 0;
    if (state) state.navigationTarget = null;
    NativeData.ResetMovement(native.Handle);

    // 死亡Unit在复活等待期内就是尸体：保留AOI身份给命中、倒地、Buff清理和未来掉落表现使用，
    // 但删除AI运行态并依靠alive=0拒绝新的攻击。到期后Respawn先Leave并销毁，再创建新UnitId。
    // The dead Unit remains as a corpse for impact, death, Buff cleanup, and future loot visuals.
    // Runtime AI is removed and alive=0 rejects new attacks; Respawn later publishes Leave before creating a new UnitId.
    this.runtime.delete(monster.UnitId);
  }

  /** 根据冷掉落表创建尸体容器；任务行先落在尸体上，是否能拿由拾取者的任务状态决定。 / Creates a corpse container from cold drop rows; quest rows stay on the corpse and eligibility is checked at pickup time. */
  private RollLootDrops(monster: MonsterUnit, config: MonsterContentDefinition): LootDrop[] {
    const drops: LootDrop[] = [];
    if (config.dropTableId > 0) {
      const content = this.DomainScene().GetComponent(LootContentProfileComponent);
      const rowsForTable = (dropTableId: number) => [
        ...(content.IncludesColdContent
          ? GameConfigs.DropTableConfig.GetAll().filter(
            (drop) => drop.dropTableId === dropTableId,
          )
          : []),
        ...content.GetRows(dropTableId),
      ].sort((left, right) => left.id - right.id);
      const rows = rowsForTable(config.dropTableId);
      const ordinaryRows = rows.filter((drop) => drop.questObjectiveId === 0);
      const taskRows = rows.filter((drop) => drop.questObjectiveId !== 0);
      const selectedOrdinaryRows = ResolveLootTableRows(
        ordinaryRows,
        rowsForTable,
        (drop, channel) => deterministicDropRoll(
          monster.UnitId,
          monster.InstanceId,
          lootRollDrawId(drop.id, channel),
        ),
      );
      for (const drop of selectedOrdinaryRows) drops.push(this.ToLootDrop(drop, monster));
      for (const drop of taskRows) {
        if (drop.chancePermille <= deterministicDropRoll(monster.UnitId, monster.InstanceId, drop.id)) continue;
        drops.push(this.ToLootDrop(drop, monster));
      }
    }
    const minGold = config.minGold ?? 0;
    const maxGold = config.maxGold ?? 0;
    if (maxGold > 0) {
      const dropId = monsterGoldDropId(config.id);
      const gold = deterministicDropRange(
        minGold,
        maxGold,
        monster.UnitId,
        monster.InstanceId,
        dropId,
      );
      if (gold > 0) {
        drops.push({
          dropId,
          configId: 0,
          count: 0,
          gold: BigInt(gold),
          questObjectiveId: 0,
        });
      }
    }
    return drops;
  }

  private SpawnSelection(): SpawnSelectionComponent | undefined {
    const scene = this.DomainScene();
    if (typeof scene.TryGetComponent !== "function") return undefined;
    return scene.TryGetComponent(SpawnSelectionComponent);
  }

  /** 将配置行转换为尸体行；普通行和任务行都已先按各自概率独立判定。 / Converts a config row to a corpse row after independent probability checks for regular and quest rows. */
  private ToLootDrop(drop: {
    readonly id: number;
    readonly itemConfigId: number;
    readonly minCount: number;
    readonly maxCount: number;
    readonly questObjectiveId: number;
    readonly gold: number;
  }, monster: MonsterUnit): LootDrop {
    return {
      dropId: drop.id,
      configId: drop.itemConfigId,
      count: deterministicDropCount(drop.minCount, drop.maxCount, monster.UnitId, drop.id),
      gold: BigInt(drop.gold),
      questObjectiveId: drop.questObjectiveId,
    };
  }

  /** 创建尸体容器；空掉落尸体不需要容器，但仍会按10秒尸体窗口等待清理。 / Creates a corpse container; an empty corpse needs no container but still follows the ten-second corpse window. */
  private CreateLootContainer(
    monster: MonsterUnit,
    drops: readonly LootDrop[],
    expiresAtMs: number,
    lootOwnerAccount: string,
  ): void {
    if (drops.length === 0) return;
    this.lootContainers.set(monster.UnitId, {
      monsterUnitId: monster.UnitId,
      corpseGeneration: monster.InstanceId,
      lootOwnerAccount,
      drops,
      expiresAtMs,
      reservedRegularDropIds: new Set(),
      reservedTaskDropIdsByAccount: new Map(),
      claimedRegularDropIds: new Set(),
      claimedTaskDropIdsByAccount: new Map(),
      inFlightOperations: new Set(),
      committedResponses: new Map(),
    });
  }

  /**
   * 只有归属账号的所有普通掉落都已领取完成，且尸体上没有任务掉落，才能立即清理尸体。
   * 任务掉落按账号保留，服务端不能因为一个玩家领取完成就删除其他玩家未来仍有资格领取的任务行。
   *
   * A corpse can disappear immediately only when the tagged account has claimed
   * every regular row and no quest row remains. Quest rows remain personal and
   * therefore keep the corpse alive until the five-minute loot window expires.
   */
  private CanRemoveLootedCorpse(container: LootContainer): boolean {
    for (const drop of container.drops) {
      if (drop.questObjectiveId !== 0) return false;
      if (container.reservedRegularDropIds.has(drop.dropId) || !container.claimedRegularDropIds.has(drop.dropId)) {
        return false;
      }
    }
    return true;
  }

  /** 归属账号的普通掉落领取完成后立即移除尸体；任务掉落仍按五分钟窗口保留。 / Removes a corpse after the tagged account claims all regular rows; quest rows keep the five-minute window. */
  private TryRemoveLootedCorpse(monsterId: number, container: LootContainer): void {
    if (!this.CanRemoveLootedCorpse(container)) return;
    const corpse = this.corpses.get(monsterId);
    if (!corpse) return;
    this.BeginCorpseCleanup(corpse, "loot-complete");
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
        if (!CanClaimRegularLoot(container, player.Account)) continue;
        if (container.claimedRegularDropIds.has(drop.dropId) || container.reservedRegularDropIds.has(drop.dropId)) continue;
        selected.push(drop);
        continue;
      }
      if (taskClaimed?.has(drop.dropId) || taskReserved?.has(drop.dropId)) continue;
      const objective = this.RequireQuestObjective(drop.questObjectiveId);
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
      const objective = this.RequireQuestObjective(drop.questObjectiveId);
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

  private RequireQuestObjective(
    objectiveId: number,
  ): Readonly<import("#tiangz/model").QuestContentObjectiveDefinition> {
    const content = this.DomainScene().GetComponent(QuestContentProfileComponent);
    const external = content.TryGetObjective(objectiveId);
    if (external) return external;
    if (!content.IncludesColdContent) {
      throw new Error(`quest objective definition not found: ${objectiveId}`);
    }
    const cold = GameConfigs.QuestObjectiveConfig.TryGet(objectiveId);
    if (!cold) throw new Error(`quest objective definition not found: ${objectiveId}`);
    return cold;
  }

  /** 在跨DBProxy await前同步预留行，阻止归属账号并发重复领取同一普通掉落。 / Reserves rows before the DBProxy await to prevent the tagged account from claiming one regular row twice. */
  private ReserveLoot(container: LootContainer, account: string, operationId: string, drops: readonly LootDrop[]): void {
    container.inFlightOperations.add(operationId);
    const taskRows = new Set<number>();
    for (const drop of drops) {
      if (drop.questObjectiveId === 0) container.reservedRegularDropIds.add(drop.dropId);
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
        container.reservedRegularDropIds.delete(drop.dropId);
        container.claimedRegularDropIds.add(drop.dropId);
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
      if (drop.questObjectiveId === 0) container.reservedRegularDropIds.delete(drop.dropId);
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
    config: MonsterContentDefinition,
    state: MonsterRuntimeState,
  ): PlayerUnit | undefined {
    const wasEngaged = state.targetUnitId !== 0 || state.threatByUnitId.size > 0;
    const threatTarget = this.FindHighestThreatPlayer(monster, state);
    if (threatTarget) return threatTarget;
    if (state.targetUnitId !== 0) {
      const currentTarget = this.units.Get<PlayerUnit>(state.targetUnitId);
      if (currentTarget && currentTarget.GetComponent(NativeUnitRef).alive !== 0) return currentTarget;
    }
    // 旧目标消失或全部仇恨目标失效时，必须让调用者先进入Evade回归；不能在同一帧
    // 把附近另一名玩家当成新的主动索敌目标，否则怪物会逐个换目标而永不归位。
    // If the old target disappeared or every threat target became invalid,
    // let the caller enter evade before active acquisition runs again.
    if (wasEngaged) return undefined;
    return config.attackMode === 0
      ? undefined
      : this.FindNearestPlayer(
        monster,
        MONSTER_ACTIVE_ACQUIRE_RANGE_METERS,
        config.aggressivePlayerConfigIds,
      );
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
        player?.GetComponent(CombatStateComponent).RemoveMonster(monster.UnitId, TimeSystem.Instance.ServerNow);
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

  /** 清理怪物的所有仇恨来源；死亡和回归必须经过这里，保证玩家能离开战斗状态。 / Clears all threat sources so death and leash return also end player combat. */
  private ClearThreat(monster: MonsterUnit, state: MonsterRuntimeState, now: number): void {
    for (const unitId of state.threatByUnitId.keys()) {
      this.units.Get<PlayerUnit>(unitId)?.GetComponent(CombatStateComponent).RemoveMonster(monster.UnitId, now);
    }
    state.threatByUnitId.clear();
    state.targetUnitId = 0;
    state.lootOwnerAccount = null;
  }

  /** 只登记战斗来源，不决定普通掉落归属；玩家伤害入口另行设置lootOwnerAccount。 / Records combat without choosing loot ownership; player damage sets lootOwnerAccount separately. */
  private MarkCombatThreat(
    monster: MonsterUnit,
    source: PlayerUnit,
    state: MonsterRuntimeState,
    amount: bigint,
    now: number,
  ): void {
    if (amount <= 0n) return;
    this.BeginMonsterEngagement(monster, source, state);
    const previous = state.threatByUnitId.get(source.UnitId) ?? 0n;
    state.threatByUnitId.set(source.UnitId, previous + amount);
    source.GetComponent(CombatStateComponent).AddMonster(monster.UnitId, now);
  }

  private FindNearestPlayer(
    monster: MonsterUnit,
    maxDistance: number,
    eligiblePlayerConfigIds?: readonly number[],
  ): PlayerUnit | undefined {
    const position = monster.GetComponent(PositionComponent);
    const maxDistanceSquared = maxDistance * maxDistance;
    let nearest: PlayerUnit | undefined;
    let nearestDistanceSquared = maxDistanceSquared;
    for (const player of this.units.GetAll(PlayerUnit)) {
      if (player.GetComponent(NativeUnitRef).alive === 0) continue;
      if (
        eligiblePlayerConfigIds !== undefined
        && !eligiblePlayerConfigIds.includes(player.PlayerConfigId)
      ) continue;
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

  private get mapConfig() {
    return this.map.SpatialProfile;
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
  return deterministicDropSeed(monsterId, corpseGeneration, dropId) % 1000;
}

function lootRollDrawId(rowId: number, channel: LootRollChannel): number {
  if (channel === "group-gate") return (rowId ^ 0x6d2b_79f5) >>> 0;
  if (channel === "group-equal-selection") return (rowId ^ 0xb529_7a4d) >>> 0;
  return rowId;
}

function deterministicDropCount(minCount: number, maxCount: number, monsterId: number, dropId: number): number {
  if (minCount === maxCount) return minCount;
  const width = maxCount - minCount + 1;
  return minCount + (deterministicDropRoll(monsterId, 0, dropId) % width);
}

function deterministicDropRange(
  minValue: number,
  maxValue: number,
  monsterId: number,
  corpseGeneration: number,
  dropId: number,
): number {
  if (minValue === maxValue) return minValue;
  const width = maxValue - minValue + 1;
  return minValue + (deterministicDropSeed(monsterId, corpseGeneration, dropId) % width);
}

function deterministicDropSeed(monsterId: number, corpseGeneration: number, dropId: number): number {
  let value = Math.imul(monsterId, 0x9e3779b1);
  value = Math.imul(value ^ corpseGeneration, 0x85ebca6b);
  return Math.imul(value ^ dropId, 0xc2b2ae35) >>> 0;
}

function monsterGoldDropId(monsterConfigId: number): number {
  return MONSTER_GOLD_DROP_ID_BASE + (monsterConfigId % MONSTER_GOLD_DROP_ID_RANGE);
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
    gold: value.gold,
    gainedGold: value.gainedGold,
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
