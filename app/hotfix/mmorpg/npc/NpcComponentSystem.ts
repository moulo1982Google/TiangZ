import {
  GameConfigs,
  GameErrCode,
  MapAoiComponent,
  MapComponent,
  NativeData,
  NativeUnitRef,
  NpcComponent,
  NpcContentProfileComponent,
  NpcCombatBehaviorActionType,
  NpcCombatBehaviorTarget,
  NpcCombatBehaviorTrigger,
  NormalizeNpcRuntimeContentPatch,
  NpcContentInteractionActionTarget,
  NpcContentInteractionActionType,
  NpcEvents,
  NpcContentIdleActionTarget,
  NpcContentIdleActionType,
  NpcUnit,
  BuffComponent,
  CombatComponent,
  CombatStateComponent,
  PositionComponent,
  NumericComponent,
  NumericRegenerationComponent,
  NumericType,
  ItemComponent,
  MoveSpeedMetersPerSecondToNumeric,
  RpcError,
  SpatialMode,
  SummonComponent,
  SkillComponent,
  SkillMapComponent,
  PlayerContentProfileComponent,
  TimeSystem,
  UnitPresentationType,
  UnitComponent,
  STARTER_NPC_CONFIG_ID,
  STARTER_NPC_INTERACT_RANGE_METERS,
  STARTER_NPC_NAME,
  STARTER_NPC_QUEST_CONFIG_IDS,
  STARTER_NPC_UNIT_ID,
  STARTER_SHOP_NPC_CONFIG_ID,
  STARTER_SHOP_NPC_NAME,
  STARTER_SHOP_NPC_UNIT_ID,
  type AwakeNpcUnit,
  type NpcContentDefinition,
  type NpcCombatProfile,
  type NpcCombatBehaviorRule,
  type NpcCombatRuntimeState,
  type NpcContentInteractionAction,
  type NpcContentInteractionRule,
  type NpcContentInteractionTriggerValue,
  type NpcContentIdleAction,
  type NpcContentIdleSequence,
  type NpcContentSpawn,
  type NpcIdleSequenceRuntimeState,
  type NpcInteractionRuntimeState,
  type NpcContentWaypoint,
  type NpcRuntimeContentPatch,
  type NpcRouteState,
  PlayerUnit,
  type DamageRequest,
  type DamageResult,
  applyEntityExtensions,
  systemFor,
} from "#tiangz/model";
import { SelectContentSpawnLevel } from "../spawn/ContentSpawnLevel";

const STARTER_MAP_ID = 100;
const STARTER_NPC_X_OFFSET = 3;
const STARTER_SHOP_NPC_X_OFFSET = 8;
const NPC_CORPSE_LIFETIME_MS = 10_000;
const NPC_ARRIVAL_RANGE_METERS = 0.5;

/**
 * Starter第一版只在3D地图100创建一个固定任务使者。
 * 创建、投影、AOI和销毁都走地图现有Unit路径；NPC交互只负责同步校验，不负责任务状态。
 *
 * Starter v1 seeds one fixed quest giver on 3D map 100. Creation, projection,
 * AOI, and cleanup reuse the map Unit path; interaction only validates facts
 * and never owns quest state.
 */
@systemFor(NpcComponent)
export class NpcComponentSystem extends NpcComponent {
  protected override Awake(map: MapComponent, aoi: MapAoiComponent): void {
    this.map = map;
    this.aoi = aoi;
    const content = this.DomainScene().GetComponent(NpcContentProfileComponent);
    if (map.MapId === STARTER_MAP_ID && content.IncludesColdContent) {
      this.SpawnStarterNpc();
      this.SpawnShopNpc();
    }
    for (const spawn of content.GetSpawns()) {
      const definition = content.TryGetDefinition(spawn.npcDefinitionId);
      if (!definition) {
        throw new Error(`NPC spawn ${spawn.id} references missing definition ${spawn.npcDefinitionId}`);
      }
      this.contentSpawns.set(spawn.id, { definition, spawn });
      if (spawn.initialSpawn) this.SpawnContentNpc(definition, spawn);
    }
    this.DomainScene().logger.info("NPC catalog ready", {
      mapId: map.MapId,
      npcCount: this.npcs.size,
      contentOwner: content.ColdContentReplacementOwner,
    });
  }

  /** 返回本地图NPC；Handler不应跨MapScene查询这个索引。 / Returns a map-local NPC; handlers must not query across MapScenes. */
  Get(npcUnitId: number): NpcUnit | undefined {
    return this.npcs.get(npcUnitId);
  }

  /** 返回稳定数组快照；调用者不得把结果缓存到下一帧。 / Returns a stable array snapshot that callers must not retain across ticks. */
  GetAll(): readonly NpcUnit[] {
    return [...this.npcs.values()];
  }

  CanPlayerAttack(player: PlayerUnit, npc: NpcUnit): boolean {
    if (player.DomainScene() !== this.DomainScene() || npc.DomainScene() !== this.DomainScene()) {
      return false;
    }
    if (this.npcs.get(npc.UnitId) !== npc || npc.GetComponent(NativeUnitRef).alive === 0) {
      return false;
    }
    const profile = this.contentSpawns.get(npc.UnitId)?.definition.combatProfile;
    return profile?.attackablePlayerConfigIds.includes(player.PlayerConfigId) ?? false;
  }

  Attack(attacker: PlayerUnit, npc: NpcUnit): DamageResult {
    this.RequirePlayerAttackable(attacker, npc);
    const attackerPosition = attacker.GetComponent(PositionComponent);
    const npcPosition = npc.GetComponent(PositionComponent);
    const attackRange = attacker.GetComponent(CombatComponent).AutoAttackRangeMeters();
    if (distanceSquared(attackerPosition.x, attackerPosition.z, npcPosition.x, npcPosition.z)
      > attackRange * attackRange) {
      throw new RpcError(GameErrCode.MonsterTooFar, `NPC is too far: ${npc.UnitId}`);
    }
    const numeric = attacker.GetComponent(NumericComponent);
    return this.ApplyPlayerDamage(attacker, npc, {
      amount: numeric[NumericType.Attack] > 0n ? numeric[NumericType.Attack] : 0n,
      sourceUnitId: attacker.UnitId,
    });
  }

  ApplyPlayerDamage(
    attacker: PlayerUnit,
    npc: NpcUnit,
    request: DamageRequest,
  ): DamageResult {
    this.RequirePlayerAttackable(attacker, npc);
    return this.ResolveNpcDamage(attacker, npc, request);
  }

  ApplyUnitDamage(npc: NpcUnit, request: DamageRequest): DamageResult {
    const attacker = request.sourceUnitId
      ? this.units.Get<PlayerUnit>(request.sourceUnitId)
      : undefined;
    return this.ResolveNpcDamage(attacker, npc, request);
  }

  ApplyDamageToPlayer(
    npc: NpcUnit,
    target: PlayerUnit,
    request: DamageRequest,
  ): DamageResult {
    const state = this.combatStates.get(npc.UnitId);
    if (!state
      || this.npcs.get(npc.UnitId) !== npc
      || npc.GetComponent(NativeUnitRef).alive === 0
      || target.DomainScene() !== this.DomainScene()
      || this.units.Get<PlayerUnit>(target.UnitId) !== target
      || target.GetComponent(NativeUnitRef).alive === 0) {
      throw new RpcError(GameErrCode.SkillTargetInvalid, `NPC combat participants are invalid: ${npc.UnitId} -> ${target.UnitId}`);
    }
    this.AddThreat(npc, target, 1n);
    const result = this.map.ApplyDamageToPlayer(npc, target, request);
    if (!result.killed) return result;
    const now = TimeSystem.Instance.ServerNow;
    this.ClearNpcThreat(npc, state, now);
    return result;
  }

  private ResolveNpcDamage(
    attacker: PlayerUnit | undefined,
    npc: NpcUnit,
    request: DamageRequest,
  ): DamageResult {
    if (attacker) this.RequirePlayerAttackable(attacker, npc);
    const state = this.combatStates.get(npc.UnitId);
    if (!state || this.npcs.get(npc.UnitId) !== npc) {
      throw new RpcError(GameErrCode.SkillTargetInvalid, `NPC combat target not found: ${npc.UnitId}`);
    }
    if (state.returningToSpawn) {
      return npc.GetComponent(CombatComponent).ApplyDamage({ ...request, amount: 0n });
    }
    const result = npc.GetComponent(CombatComponent).ApplyDamage(request);
    this.PublishCombatDamage(npc, request.sourceUnitId ?? attacker?.UnitId ?? npc.UnitId, result, request.abilityId ?? 0);
    if (attacker && result.finalDamage > 0n) this.AddThreat(npc, attacker, result.finalDamage);
    if (result.killed) this.KillCombatNpc(npc, state);
    return result;
  }

  private RequirePlayerAttackable(player: PlayerUnit, npc: NpcUnit): void {
    if (!this.CanPlayerAttack(player, npc)) {
      throw new RpcError(
        GameErrCode.SkillTargetInvalid,
        `NPC ${npc.UnitId} is not attackable by player config ${player.PlayerConfigId}`,
      );
    }
  }

  ActivateSpawn(spawnId: number): void {
    const entry = this.contentSpawns.get(spawnId);
    if (!entry) throw new Error(`NPC spawn slot not found: ${spawnId}`);
    if (this.npcs.has(spawnId)) return;
    this.pendingRespawns.delete(spawnId);
    this.SpawnContentNpc(entry.definition, entry.spawn);
  }

  DeactivateSpawn(spawnId: number): void {
    if (!this.contentSpawns.has(spawnId)) throw new Error(`NPC spawn slot not found: ${spawnId}`);
    const npc = this.npcs.get(spawnId);
    this.pendingRespawns.delete(spawnId);
    if (npc) this.RemoveNpcEntity(npc, "NPC deactivation AOI publish failed");
  }

  ApplyDefinitionContentPatch(
    ownerId: string,
    npcDefinitionId: number,
    patch: NpcRuntimeContentPatch,
  ): readonly NpcUnit[] {
    const content = this.DomainScene().GetComponent(NpcContentProfileComponent);
    if (!content.TryGetDefinition(npcDefinitionId)) {
      throw new Error(`NPC definition not found for runtime content patch: ${npcDefinitionId}`);
    }
    const normalized = NormalizeNpcRuntimeContentPatch(patch);
    return this.ApplyContentPatch(
      this.definitionContentPatches,
      npcDefinitionId,
      ownerId,
      normalized,
      [...this.npcs.values()].filter((npc) => npc.NpcConfigId === npcDefinitionId),
      definitionPatchOwner(npcDefinitionId, ownerId),
    );
  }

  RemoveDefinitionContentPatch(ownerId: string, npcDefinitionId: number): readonly NpcUnit[] {
    return this.RemoveContentPatch(
      this.definitionContentPatches,
      npcDefinitionId,
      ownerId,
      [...this.npcs.values()].filter((npc) => npc.NpcConfigId === npcDefinitionId),
      definitionPatchOwner(npcDefinitionId, ownerId),
    );
  }

  ApplySpawnContentPatch(
    ownerId: string,
    spawnId: number,
    patch: NpcRuntimeContentPatch,
  ): readonly NpcUnit[] {
    if (!this.contentSpawns.has(spawnId)) {
      throw new Error(`NPC spawn slot not found for runtime content patch: ${spawnId}`);
    }
    const normalized = NormalizeNpcRuntimeContentPatch(patch);
    const npc = this.npcs.get(spawnId);
    return this.ApplyContentPatch(
      this.spawnContentPatches,
      spawnId,
      ownerId,
      normalized,
      npc ? [npc] : [],
      spawnPatchOwner(spawnId, ownerId),
    );
  }

  RemoveSpawnContentPatch(ownerId: string, spawnId: number): readonly NpcUnit[] {
    const npc = this.npcs.get(spawnId);
    return this.RemoveContentPatch(
      this.spawnContentPatches,
      spawnId,
      ownerId,
      npc ? [npc] : [],
      spawnPatchOwner(spawnId, ownerId),
    );
  }

  /** 已提交的任务/对话事实进入内容规则队列；规则只追加客户端表现，不参与原子事务。 / Queues content rules after a committed quest or dialogue fact; rules only append client presentation and never join the atomic transaction. */
  TriggerInteraction(
    player: PlayerUnit,
    npcUnitId: number,
    trigger: NpcContentInteractionTriggerValue,
    triggerValue: number,
  ): void {
    const npc = this.npcs.get(npcUnitId);
    if (!npc
      || npc.DomainScene() !== player.DomainScene()
      || npc.GetComponent(NativeUnitRef).alive === 0) return;
    if (!Number.isSafeInteger(triggerValue) || triggerValue < 0) return;
    const rules = this.interactionDefinitions.get(npcUnitId) ?? [];
    const sequence = (this.interactionSequences.get(npcUnitId) ?? 0) + 1;
    this.interactionSequences.set(npcUnitId, sequence);
    for (const rule of rules) {
      if (rule.trigger !== trigger) continue;
      if (rule.triggerValue !== undefined && rule.triggerValue !== 0 && rule.triggerValue !== triggerValue) {
        continue;
      }
      if (
        rule.chancePermille < 1_000
        && rollNpcInteractionPermille(npcUnitId, rule.id, sequence) >= rule.chancePermille
      ) continue;
      const pending = this.interactionStates.get(npcUnitId) ?? [];
      pending.push({
        sourceUnitId: npcUnitId,
        playerUnitId: player.UnitId,
        rule,
        startedAtMs: TimeSystem.Instance.ServerNow,
        executionSequence: sequence,
        nextActionIndex: 0,
      });
      this.interactionStates.set(npcUnitId, pending);
    }
  }

  /**
   * 只推进内容声明的 NPC 路线；路线是 Core 的中立能力，源 waypoint 动作与事件语义仍留在外部游戏模块。
   * Advances only content-declared NPC routes.  The route is a neutral Core
   * capability: source waypoint actions and event semantics remain in the
   * external game module, while movement uses the same native path as players
   * and monsters.
   */
  Update5Hz(): void {
    if (this.map.IsStopping) return;
    const now = TimeSystem.Instance.ServerNow;
    for (const [unitId, state] of this.combatStates) {
      const npc = this.npcs.get(unitId);
      if (!npc || npc.GetComponent(NativeUnitRef).alive === 0) continue;
      this.TickNpcCombat(npc, state, now);
    }
    for (const [unitId, route] of this.routes) {
      const npc = this.npcs.get(unitId);
      if (!npc) {
        this.routes.delete(unitId);
        continue;
      }
      if (npc.GetComponent(NativeUnitRef).alive === 0) {
        route.navigationTarget = null;
        NativeData.ResetMovement(npc.GetComponent(NativeUnitRef).Handle);
        continue;
      }
      const combat = this.combatStates.get(unitId);
      if (combat && (combat.returningToSpawn || combat.threatByUnitId.size > 0)) continue;
      this.TickNpcRoute(npc, route, now);
    }
    for (const [unitId, sequences] of this.idleSequenceStates) {
      const npc = this.npcs.get(unitId);
      if (!npc) {
        this.idleSequenceStates.delete(unitId);
        continue;
      }
      if (npc.GetComponent(NativeUnitRef).alive === 0) continue;
      const combat = this.combatStates.get(unitId);
      if (combat && (combat.returningToSpawn || combat.threatByUnitId.size > 0)) continue;
      this.TickNpcIdleSequences(
        npc,
        this.idleSequenceDefinitions.get(unitId) ?? [],
        sequences,
        now,
      );
    }
    this.TickNpcInteractions(now);
  }

  /** 清理短暂尸体并按稳定刷点时间重建战斗 NPC。 / Cleans short-lived corpses and recreates combat NPCs at their stable slot deadline. */
  Update1Hz(): void {
    if (this.map.IsStopping) return;
    const now = TimeSystem.Instance.ServerNow;
    for (const [unitId, state] of [...this.combatStates]) {
      if (state.corpseExpiresAtMs <= 0 || now < state.corpseExpiresAtMs) continue;
      const npc = this.npcs.get(unitId);
      if (!npc) continue;
      const respawnAtMs = state.respawnAtMs;
      this.RemoveNpcEntity(npc, "NPC corpse AOI leave failed");
      if (respawnAtMs > 0) this.pendingRespawns.set(state.spawnId, respawnAtMs);
    }
    for (const [spawnId, respawnAtMs] of [...this.pendingRespawns]) {
      if (now < respawnAtMs) continue;
      const entry = this.contentSpawns.get(spawnId);
      if (!entry) {
        this.pendingRespawns.delete(spawnId);
        continue;
      }
      this.pendingRespawns.delete(spawnId);
      this.SpawnContentNpc(entry.definition, entry.spawn);
    }
  }

  /**
   * 验证“玩家已经找到这个NPC并且可以接这个任务”。必须在PlayerUnit有序mailbox内调用，
   * 这样多个Enter/Accept并发不会绕过任务状态检查；实际Accept仍交给QuestComponent。
   *
   * Validates that the player found this NPC and that the NPC offers the quest.
   * Call it inside the ordered PlayerUnit mailbox so concurrent requests cannot
   * bypass quest-state checks; QuestComponent still owns the actual acceptance.
   */
  ValidateQuestOffer(player: PlayerUnit, npcUnitId: number, questConfigId: number): void {
    this.ValidateQuestRelation(player, npcUnitId, questConfigId, "offer");
  }

  /** 校验任务只能交给声明为交付方的 NPC。 / Validates that a quest is turned in only to a declared quest ender. */
  ValidateQuestTurnIn(player: PlayerUnit, npcUnitId: number, questConfigId: number): void {
    this.ValidateQuestRelation(player, npcUnitId, questConfigId, "turn-in");
  }

  /**
   * 校验外部适配器提交的NPC内容事实来源；事实只追加已声明的表现规则。
   * Validates the NPC source for an external content fact; the fact only
   * appends declared presentation rules after this boundary.
   */
  ValidateContentInteraction(player: PlayerUnit, npcUnitId: number): NpcUnit {
    const npc = this.npcs.get(npcUnitId);
    if (!npc || npc.GetComponent(NativeUnitRef).alive === 0 || !this.aoi.IsAttached(npc)) {
      throw new RpcError(GameErrCode.NpcNotFound, `npc not found: ${npcUnitId}`);
    }
    if (npc.DomainScene() !== player.DomainScene()) {
      throw new RpcError(GameErrCode.NpcNotFound, `npc is not in player's map: ${npcUnitId}`);
    }
    const playerPosition = player.GetComponent(PositionComponent);
    const npcPosition = npc.GetComponent(PositionComponent);
    const dx = playerPosition.x - npcPosition.x;
    const dz = playerPosition.z - npcPosition.z;
    if (dx * dx + dz * dz > STARTER_NPC_INTERACT_RANGE_METERS ** 2) {
      throw new RpcError(
        GameErrCode.NpcTooFar,
        `npc ${npcUnitId} is too far from player: ${Math.sqrt(dx * dx + dz * dz).toFixed(2)}m`,
      );
    }
    return npc;
  }

  /** 统一校验 NPC 身份、关系和距离，避免发布与交付入口产生不同空间规则。 / Shares identity, relation, and range checks between offer and turn-in entry points. */
  private ValidateQuestRelation(
    player: PlayerUnit,
    npcUnitId: number,
    questConfigId: number,
    relation: "offer" | "turn-in",
  ): void {
    const npc = this.npcs.get(npcUnitId);
    if (!npc || npc.GetComponent(NativeUnitRef).alive === 0 || !this.aoi.IsAttached(npc)) {
      throw new RpcError(GameErrCode.NpcNotFound, `npc not found: ${npcUnitId}`);
    }
    if (npc.DomainScene() !== player.DomainScene()) {
      throw new RpcError(GameErrCode.NpcNotFound, `npc is not in player's map: ${npcUnitId}`);
    }
    const questConfigIds = relation === "offer"
      ? npc.QuestStarterConfigIds
      : npc.QuestEnderConfigIds;
    if (!questConfigIds.includes(questConfigId)) {
      throw new RpcError(
        GameErrCode.NpcQuestUnavailable,
        relation === "offer"
          ? `npc ${npcUnitId} does not offer quest ${questConfigId}`
          : `npc ${npcUnitId} does not accept quest ${questConfigId} for turn-in`,
      );
    }
    const playerPosition = player.GetComponent(PositionComponent);
    const npcPosition = npc.GetComponent(PositionComponent);
    const dx = playerPosition.x - npcPosition.x;
    const dz = playerPosition.z - npcPosition.z;
    if (dx * dx + dz * dz > STARTER_NPC_INTERACT_RANGE_METERS ** 2) {
      throw new RpcError(
        GameErrCode.NpcTooFar,
        `npc ${npcUnitId} is too far from player: ${Math.sqrt(dx * dx + dz * dz).toFixed(2)}m`,
      );
    }
  }

  /**
   * 校验玩家只能在同一Map、AOI已挂载且距离足够近时打开商店。
   * Validates that a player may open a shop only when the NPC is in the same
   * Map, attached to AOI, and within interaction range.
   */
  ValidateShopInteraction(player: PlayerUnit, npcUnitId: number): NpcUnit {
    const npc = this.npcs.get(npcUnitId);
    if (!npc || npc.GetComponent(NativeUnitRef).alive === 0 || !npc.ShopEnabled || !this.aoi.IsAttached(npc)) {
      throw new RpcError(GameErrCode.NpcShopUnavailable, `shop NPC is unavailable: ${npcUnitId}`);
    }
    if (npc.DomainScene() !== player.DomainScene()) {
      throw new RpcError(GameErrCode.NpcShopUnavailable, `shop NPC is not in player's map: ${npcUnitId}`);
    }
    const playerPosition = player.GetComponent(PositionComponent);
    const npcPosition = npc.GetComponent(PositionComponent);
    const dx = playerPosition.x - npcPosition.x;
    const dz = playerPosition.z - npcPosition.z;
    if (dx * dx + dz * dz > STARTER_NPC_INTERACT_RANGE_METERS ** 2) {
      throw new RpcError(
        GameErrCode.NpcTooFar,
        `shop NPC ${npcUnitId} is too far from player: ${Math.sqrt(dx * dx + dz * dz).toFixed(2)}m`,
      );
    }
    return npc;
  }

  ValidateTrainerInteraction(player: PlayerUnit, npcUnitId: number): NpcUnit {
    const npc = this.npcs.get(npcUnitId);
    if (!npc || npc.GetComponent(NativeUnitRef).alive === 0 || npc.TrainerId <= 0 || !this.aoi.IsAttached(npc)) {
      throw new RpcError(
        GameErrCode.NpcTrainerUnavailable,
        `trainer NPC is unavailable: ${npcUnitId}`,
      );
    }
    if (npc.DomainScene() !== player.DomainScene()) {
      throw new RpcError(
        GameErrCode.NpcTrainerUnavailable,
        `trainer NPC is not in player's map: ${npcUnitId}`,
      );
    }
    const playerPosition = player.GetComponent(PositionComponent);
    const npcPosition = npc.GetComponent(PositionComponent);
    const dx = playerPosition.x - npcPosition.x;
    const dz = playerPosition.z - npcPosition.z;
    if (dx * dx + dz * dz > STARTER_NPC_INTERACT_RANGE_METERS ** 2) {
      throw new RpcError(
        GameErrCode.NpcTooFar,
        `trainer NPC ${npcUnitId} is too far from player: ${Math.sqrt(dx * dx + dz * dz).toFixed(2)}m`,
      );
    }
    return npc;
  }

  /** 只允许玩家在同地图、近距离且 NPC 明确提供修理时进入事务。 / Admits a repair transaction only for a nearby same-map NPC that explicitly exposes repair. */
  ValidateRepairInteraction(player: PlayerUnit, npcUnitId: number): NpcUnit {
    const npc = this.npcs.get(npcUnitId);
    if (!npc || npc.GetComponent(NativeUnitRef).alive === 0 || !npc.RepairEnabled || !this.aoi.IsAttached(npc)) {
      throw new RpcError(
        GameErrCode.NpcRepairUnavailable,
        `repair NPC is unavailable: ${npcUnitId}`,
      );
    }
    if (npc.DomainScene() !== player.DomainScene()) {
      throw new RpcError(
        GameErrCode.NpcRepairUnavailable,
        `repair NPC is not in player's map: ${npcUnitId}`,
      );
    }
    const playerPosition = player.GetComponent(PositionComponent);
    const npcPosition = npc.GetComponent(PositionComponent);
    const dx = playerPosition.x - npcPosition.x;
    const dz = playerPosition.z - npcPosition.z;
    if (dx * dx + dz * dz > STARTER_NPC_INTERACT_RANGE_METERS ** 2) {
      throw new RpcError(
        GameErrCode.NpcTooFar,
        `repair NPC ${npcUnitId} is too far from player: ${Math.sqrt(dx * dx + dz * dz).toFixed(2)}m`,
      );
    }
    return npc;
  }

  /** 创建固定任务使者；它是Subject，不是Observer，也不拥有Player或Quest状态。 / Creates the fixed quest giver as a Subject, never an Observer or owner of player/quest state. */
  private SpawnStarterNpc(): void {
    this.SpawnNpc({
      unitId: STARTER_NPC_UNIT_ID,
      configId: STARTER_NPC_CONFIG_ID,
      name: STARTER_NPC_NAME,
      questStarterConfigIds: STARTER_NPC_QUEST_CONFIG_IDS,
      questEnderConfigIds: STARTER_NPC_QUEST_CONFIG_IDS,
      shopItemConfigIds: [],
      trainerId: 0,
      shopEnabled: false,
      repairEnabled: false,
      conversationEnabled: true,
      trainingEnabled: false,
      recoveryEnabled: false,
      xOffset: STARTER_NPC_X_OFFSET,
    });
  }

  /** 创建杂货商，商品和价格由ItemConfig驱动。 / Creates the grocer; its catalog and prices come from ItemConfig. */
  private SpawnShopNpc(): void {
    this.SpawnNpc({
      unitId: STARTER_SHOP_NPC_UNIT_ID,
      configId: STARTER_SHOP_NPC_CONFIG_ID,
      name: STARTER_SHOP_NPC_NAME,
      questStarterConfigIds: [],
      questEnderConfigIds: [],
      shopItemConfigIds: [1001, 1003],
      trainerId: 0,
      shopEnabled: true,
      repairEnabled: false,
      conversationEnabled: true,
      trainingEnabled: false,
      recoveryEnabled: false,
      xOffset: STARTER_SHOP_NPC_X_OFFSET,
    });
  }

  /** 外置资料只描述稳定定义和刷点；现有NpcComponent仍统一创建Unit并接管AOI。 / External data describes stable definitions and slots while this component still creates Units and owns AOI attachment. */
  private SpawnContentNpc(
    definition: Readonly<NpcContentDefinition>,
    spawn: Readonly<NpcContentSpawn>,
  ): void {
    const spawnGeneration = this.spawnGenerations.get(spawn.id) ?? 0;
    const contentLevel = definition.minimumLevel === undefined
      ? undefined
      : SelectContentSpawnLevel(
        definition.minimumLevel,
        definition.maximumLevel ?? definition.minimumLevel,
        spawn.id,
        spawnGeneration,
      );
    this.SpawnNpc({
      unitId: spawn.id,
      configId: definition.id,
      name: definition.name,
      presentationModelId: definition.presentationModelId,
      presentationLoadoutId: spawn.presentationLoadoutId ?? definition.presentationLoadoutId,
      presentationStateId: spawn.presentationStateId ?? definition.presentationStateId,
      initialBuffDefinitionIds: spawn.initialBuffDefinitionIds ?? definition.initialBuffDefinitionIds,
      questStarterConfigIds: definition.questStarterConfigIds,
      questEnderConfigIds: definition.questEnderConfigIds,
      shopItemConfigIds: definition.shopItemConfigIds,
      trainerId: definition.trainerId,
      shopEnabled: definition.shopEnabled,
      repairEnabled: definition.repairEnabled ?? false,
      conversationEnabled: definition.conversationEnabled ?? false,
      trainingEnabled: definition.trainingEnabled ?? definition.trainerId > 0,
      recoveryEnabled: definition.recoveryEnabled ?? false,
      contentLevel,
      combatProfile: definition.combatProfile,
      respawnSeconds: spawn.respawnSeconds ?? 0,
      waypoints: spawn.waypoints,
      interactionRules: spawn.interactionRules,
      idleSequences: spawn.idleSequences,
      position: {
        x: spawn.spawnX,
        y: spawn.spawnY,
        z: spawn.spawnZ,
        yaw: spawn.spawnYaw,
      },
    });
    this.spawnGenerations.set(spawn.id, spawnGeneration + 1);
  }

  private SpawnNpc(requestData: {
    unitId: number;
    configId: number;
    name: string;
    presentationModelId?: string;
    presentationLoadoutId?: string;
    presentationStateId?: number;
    questStarterConfigIds: readonly number[];
    questEnderConfigIds: readonly number[];
    shopItemConfigIds: readonly number[];
    trainerId: number;
    shopEnabled: boolean;
    repairEnabled: boolean;
    conversationEnabled: boolean;
    trainingEnabled: boolean;
    recoveryEnabled: boolean;
    contentLevel?: number;
    waypoints?: readonly NpcContentWaypoint[];
    interactionRules?: readonly NpcContentInteractionRule[];
    idleSequences?: readonly NpcContentIdleSequence[];
    initialBuffDefinitionIds?: readonly number[];
    combatProfile?: Readonly<NpcCombatProfile>;
    respawnSeconds?: number;
    xOffset?: number;
    position?: Readonly<{ x: number; y: number; z: number; yaw: number }>;
  }): void {
    const spatial = this.map.SpatialProfile;
    const spawn = requestData.position ?? {
      x: spatial.spawnX + (requestData.xOffset ?? 0),
      y: spatial.spawnY,
      z: spatial.spawnZ,
      yaw: spatial.spawnYaw,
    };
    const projected = spatial.spatialMode === SpatialMode.NavMesh3D
      ? this.map.ProjectPosition(spawn)
      : spawn;
    if (!projected) throw new Error(`starter NPC spawn outside NavMesh: ${spawn.x},${spawn.y},${spawn.z}`);

    const request: AwakeNpcUnit = {
      mapId: this.map.MapId,
      mapInstanceId: this.map.MapInstanceId,
      npcConfigId: requestData.configId,
      name: requestData.name,
      presentationModelId: requestData.presentationModelId,
      presentationLoadoutId: requestData.presentationLoadoutId,
      presentationStateId: requestData.presentationStateId,
      questStarterConfigIds: requestData.questStarterConfigIds,
      questEnderConfigIds: requestData.questEnderConfigIds,
      shopItemConfigIds: requestData.shopItemConfigIds,
      trainerId: requestData.trainerId,
      shopEnabled: requestData.shopEnabled,
      repairEnabled: requestData.repairEnabled,
      conversationEnabled: requestData.conversationEnabled,
      trainingEnabled: requestData.trainingEnabled,
      recoveryEnabled: requestData.recoveryEnabled,
    };
    const npc = this.units.Create(requestData.unitId, NpcUnit, request);
    try {
      const native = npc.AddComponent(NativeUnitRef, {
        id: npc.UnitId,
        instanceId: npc.InstanceId,
        mapId: this.map.NativeMapKey,
        x: 0,
        y: 0,
        z: 0,
      });
      const position = npc.AddComponent(
        PositionComponent,
        native,
        spatial.widthCells,
        spatial.depthCells,
        spatial.cellSizeMeters,
      );
      if (spatial.spatialMode === SpatialMode.Grid2D) {
        position.SetGridWorldPosition(projected.x, projected.y, projected.z, spawn.yaw);
      } else {
        position.SetNavMeshWorldPosition(projected.x, projected.y, projected.z, spawn.yaw);
      }
      position.SpeedMetersPerSecond = 0.01;
      const buffs = npc.AddComponent(BuffComponent);
      for (const buffDefinitionId of requestData.initialBuffDefinitionIds ?? []) {
        // Apply before AOI attachment so initial snapshots carry static
        // content auras without a second, map-specific bootstrap protocol.
        buffs.ApplyBuff(buffDefinitionId);
      }
      const levelStats = requestData.combatProfile?.combatStatsByLevel?.find(
        (row) => row.level === requestData.contentLevel,
      );
      const combatMaxHp = levelStats?.maxHp ?? requestData.combatProfile?.maxHp ?? 0;
      const combatMaxMp = levelStats?.maxMp ?? requestData.combatProfile?.maxMp ?? 0;
      const combatAttackDamage = levelStats?.attackDamage
        ?? requestData.combatProfile?.attackDamage
        ?? 0;
      if (requestData.combatProfile) {
        const profile = requestData.combatProfile;
        npc.AddComponent(NumericComponent, {
          ...(requestData.contentLevel === undefined
            ? {}
            : { [NumericType.Level]: BigInt(requestData.contentLevel) }),
          [NumericType.CurrentHp]: BigInt(combatMaxHp),
          [NumericType.CurrentMp]: BigInt(combatMaxMp),
          [NumericType.MaxHpBase]: BigInt(combatMaxHp),
          [NumericType.MaxMpBase]: BigInt(combatMaxMp),
          [NumericType.AttackBase]: BigInt(combatAttackDamage),
          [NumericType.AttackSpeedAdd]: BigInt(profile.attackIntervalMs),
          [NumericType.MoveSpeedBase]: MoveSpeedMetersPerSecondToNumeric(profile.moveSpeed),
        });
        if (profile.resourceRegenAmount !== undefined) {
          npc.AddComponent(NumericRegenerationComponent, {
            currentNumericType: NumericType.CurrentMp,
            maximumNumericType: NumericType.MaxMp,
            amount: BigInt(profile.resourceRegenAmount),
            intervalMs: profile.resourceRegenIntervalMs!,
            delayAfterDecreaseMs: profile.resourceRegenDelayAfterSpendMs!,
          });
        }
        const combat = npc.AddComponent(CombatComponent);
        combat.SetAutoAttackRangeMeters(profile.attackRange);
        combat.SetAutoAttackInterval(profile.attackIntervalMs);
        npc.AddComponent(SkillComponent);
        position.SpeedMetersPerSecond = profile.moveSpeed;
      } else if (requestData.contentLevel !== undefined) {
        npc.AddComponent(NumericComponent, {
          [NumericType.Level]: BigInt(requestData.contentLevel),
          [NumericType.MoveSpeedBase]: MoveSpeedMetersPerSecondToNumeric(
            position.SpeedMetersPerSecond,
          ),
        });
      }
      for (const [ownerId, patch] of this.definitionContentPatches.get(requestData.configId) ?? []) {
        npc.ApplyRuntimeContentPatch(definitionPatchOwner(requestData.configId, ownerId), patch);
      }
      for (const [ownerId, patch] of this.spawnContentPatches.get(requestData.unitId) ?? []) {
        npc.ApplyRuntimeContentPatch(spawnPatchOwner(requestData.unitId, ownerId), patch);
      }
      // 模块组件必须在索引和AOI发布前完成同步装配；失败沿用本工厂的整Entity回滚。
      // Module components attach synchronously before indexing or AOI publication;
      // a failure follows this factory's existing whole-Entity rollback path.
      applyEntityExtensions(npc);
      this.npcs.set(npc.UnitId, npc);
      if (requestData.combatProfile) {
        this.combatStates.set(npc.UnitId, {
          spawnId: requestData.unitId,
          targetUnitId: 0,
          threatByUnitId: new Map(),
          nextAttackAtMs: 0,
          navigationSequence: 0,
          navigationTarget: null,
          returningToSpawn: false,
          corpseExpiresAtMs: 0,
          respawnAtMs: requestData.respawnSeconds && requestData.respawnSeconds > 0
            ? 0
            : -1,
          engagementSequence: 0,
          behaviorState: 0,
          combatMovementEnabled: true,
          fleeing: false,
          fleeDistanceMeters: 0,
          triggeredBehaviorRuleIds: new Set(),
          behaviorRuleNextAtMs: new Map(),
          behaviorRuleExecutionSequences: new Map(),
        });
      }
      if (requestData.waypoints && requestData.waypoints.length > 0) {
        this.routes.set(npc.UnitId, {
          waypoints: requestData.waypoints,
          nextWaypointIndex: 0,
          pauseUntilMs: 0,
          navigationSequence: 0,
          navigationTarget: null,
        });
      }
      if (requestData.interactionRules && requestData.interactionRules.length > 0) {
        this.interactionDefinitions.set(npc.UnitId, requestData.interactionRules);
        this.interactionStates.set(npc.UnitId, []);
        this.interactionSequences.set(npc.UnitId, 0);
      }
      if (requestData.idleSequences && requestData.idleSequences.length > 0) {
        this.idleSequenceDefinitions.set(npc.UnitId, requestData.idleSequences);
        this.idleSequenceStates.set(npc.UnitId, new Map());
      }
      const changes = this.aoi.Attach(npc, 0, false, true);
      if (changes.length > 0) {
        void this.map.PublishVisibilityChanges(changes).catch((error) => {
          this.DomainScene().logger.error("starter NPC AOI publish failed", { error });
        });
      }
    } catch (error) {
      this.routes.delete(npc.UnitId);
      this.interactionDefinitions.delete(npc.UnitId);
      this.interactionStates.delete(npc.UnitId);
      this.interactionSequences.delete(npc.UnitId);
      this.idleSequenceDefinitions.delete(npc.UnitId);
      this.idleSequenceStates.delete(npc.UnitId);
      this.combatStates.delete(npc.UnitId);
      this.units.Remove(npc.UnitId);
      throw error;
    }
  }

  /** 推进脱战NPC的定时中立表现；序列状态不进入Unit快照或协议。 / Advances timed neutral presentations for idle NPCs; sequence state never enters Unit snapshots or protocol. */
  private TickNpcIdleSequences(
    npc: NpcUnit,
    sequenceDefinitions: readonly NpcContentIdleSequence[],
    sequences: Map<number, NpcIdleSequenceRuntimeState>,
    now: number,
  ): void {
    for (const sequence of sequenceDefinitions) {
      let runtime = sequences.get(sequence.id);
      if (!runtime) {
        runtime = {
          nextTriggerAtMs: now + selectNpcIdleDelayMs(
            npc.UnitId,
            sequence.id,
            0,
            sequence.initialDelayMinMs,
            sequence.initialDelayMaxMs,
          ),
          activeSinceMs: -1,
          nextActionIndex: 0,
          executionSequence: 0,
        };
        sequences.set(sequence.id, runtime);
      }
      const combatState = this.combatStates.get(npc.UnitId);
      if (combatState) {
        this.TriggerNpcCombatBehavior(
          npc,
          undefined,
          combatState,
          NpcCombatBehaviorTrigger.Reset,
        );
      }
      if (runtime.activeSinceMs < 0 && now >= runtime.nextTriggerAtMs) {
        runtime.executionSequence += 1;
        runtime.nextTriggerAtMs = now + selectNpcIdleDelayMs(
          npc.UnitId,
          sequence.id,
          runtime.executionSequence,
          sequence.repeatDelayMinMs,
          sequence.repeatDelayMaxMs,
        );
        runtime.nextActionIndex = 0;
        if (sequence.chancePermille < 1_000
          && rollNpcIdlePermille(npc.UnitId, sequence.id, runtime.executionSequence) >= sequence.chancePermille) {
          continue;
        }
        runtime.activeSinceMs = now;
      }
      if (runtime.activeSinceMs < 0) continue;
      while (runtime.nextActionIndex < sequence.actions.length) {
        const action = sequence.actions[runtime.nextActionIndex];
        const actionDelayMs = selectNpcIdleDelayMs(
          npc.UnitId,
          action.id,
          runtime.executionSequence,
          action.delayMs,
          action.delayMaxMs ?? action.delayMs,
        );
        if (runtime.activeSinceMs + actionDelayMs > now) break;
        runtime.nextActionIndex += 1;
        if (action.chancePermille < 1_000
          && rollNpcIdlePermille(npc.UnitId, action.id, runtime.executionSequence) >= action.chancePermille) {
          continue;
        }
        this.ExecuteNpcIdleAction(npc, action, runtime.executionSequence);
      }
      if (runtime.nextActionIndex >= sequence.actions.length) runtime.activeSinceMs = -1;
    }
  }

  /** 解析同一内容包的稳定NPC刷点并发布表情。 / Resolves a stable NPC spawn from the same content package and publishes its emote. */
  private ExecuteNpcIdleAction(
    source: NpcUnit,
    action: NpcContentIdleAction,
    executionSequence: number,
  ): void {
    const actor = action.target === NpcContentIdleActionTarget.StableSpawn
      ? this.npcs.get(action.targetSpawnId ?? 0)
      : source;
    if (!actor) return;
    if (action.type === NpcContentIdleActionType.Emote) {
      const presentationId = selectNpcPresentationId(
        source.UnitId,
        action,
        executionSequence,
      );
      if (presentationId <= 0) return;
      void this.map.PublishUnitPresentation(actor, {
        type: UnitPresentationType.Emote,
        targetUnitId: 0,
        presentationId,
        text: "",
      }).catch((error) => {
        this.DomainScene().logger.error("npc idle presentation publish failed", {
          unitId: actor.UnitId,
          presentationId,
          error,
        });
      });
      return;
    }
    if (action.type === NpcContentIdleActionType.EmoteState) {
      const presentationId = action.presentationId ?? 0;
      actor.SetPresentationState(presentationId);
      void this.map.PublishUnitPresentation(actor, {
        type: UnitPresentationType.EmoteState,
        targetUnitId: 0,
        presentationId,
        text: "",
      }).catch((error) => {
        this.DomainScene().logger.error("npc idle emote state publish failed", {
          unitId: actor.UnitId,
          presentationId,
          error,
        });
      });
      return;
    }
    if (action.type === NpcContentIdleActionType.Say) {
      const choices = action.textChoices ?? [];
      if (choices.length === 0) return;
      const text = choices[npcIdleHash(
        source.UnitId,
        action.id,
        executionSequence,
      ) % choices.length];
      if (!text) return;
      void this.map.PublishUnitPresentation(actor, {
        type: UnitPresentationType.Say,
        targetUnitId: 0,
        presentationId: 0,
        text,
      }).catch((error) => {
        this.DomainScene().logger.error("npc idle speech publish failed", {
          unitId: actor.UnitId,
          error,
        });
      });
      return;
    }
    if (action.type === NpcContentIdleActionType.ExecuteAbility) {
      this.DomainScene().Events.Publish(NpcEvents.IdleActionRequested, {
        npc: source,
        target: actor,
        action,
        nowMs: TimeSystem.Instance.ServerNow,
      });
    }
  }

  /** 推进已触发的NPC交互表现；事实提交与表现发布解耦，跨帧延迟不会阻塞玩家mailbox。 / Advances triggered NPC interaction presentations; committed facts stay separate and delayed presentation never blocks the player mailbox. */
  private TickNpcInteractions(now: number): void {
    for (const [sourceUnitId, pending] of this.interactionStates) {
      const source = this.npcs.get(sourceUnitId);
      if (!source) {
        this.interactionStates.delete(sourceUnitId);
        this.interactionDefinitions.delete(sourceUnitId);
        this.interactionSequences.delete(sourceUnitId);
        continue;
      }
      const remaining: NpcInteractionRuntimeState[] = [];
      for (const state of pending) {
        while (state.nextActionIndex < state.rule.actions.length) {
          const action = state.rule.actions[state.nextActionIndex];
          const actionDelayMs = selectNpcInteractionDelayMs(
            state.sourceUnitId,
            state.rule.id,
            action.id,
            state.executionSequence,
            action.delayMs,
            action.delayMaxMs ?? action.delayMs,
          );
          if (state.startedAtMs + actionDelayMs > now) break;
          const actionIndex = state.nextActionIndex;
          state.nextActionIndex += 1;
          if (
            action.chancePermille < 1_000
            && rollNpcInteractionPermille(
              state.sourceUnitId,
              action.id,
              state.executionSequence + actionIndex,
            ) >= action.chancePermille
          ) continue;
          this.ExecuteNpcInteractionAction(source, state, action, actionIndex);
        }
        if (state.nextActionIndex < state.rule.actions.length) remaining.push(state);
      }
      if (remaining.length > 0) this.interactionStates.set(sourceUnitId, remaining);
      else this.interactionStates.delete(sourceUnitId);
    }
  }

  /** 发布一条内容声明的中立表现；目标玩家失联时安全丢弃，不修改任何权威状态。 / Publishes one content-declared neutral presentation; drops it safely if the target player left without mutating authority. */
  private ExecuteNpcInteractionAction(
    source: NpcUnit,
    state: NpcInteractionRuntimeState,
    action: NpcContentInteractionAction,
    actionIndex: number,
  ): void {
    const target = action.target === NpcContentInteractionActionTarget.Player
      ? this.units.Get<PlayerUnit>(state.playerUnitId)
      : undefined;
    if (action.target === NpcContentInteractionActionTarget.Player && !target) return;
    if (action.type === NpcContentInteractionActionType.Emote) {
      const presentationId = selectNpcInteractionPresentationId(
        source.UnitId,
        action,
        state.executionSequence + actionIndex,
      );
      if (presentationId <= 0) return;
      this.PublishNpcPresentation(source, {
        type: UnitPresentationType.Emote,
        targetUnitId: target?.UnitId ?? 0,
        presentationId,
        text: "",
      });
      return;
    }
    if (action.type === NpcContentInteractionActionType.Say) {
      const choices = action.textChoices ?? [];
      const text = choices.length === 0
        ? ""
        : choices[npcInteractionHash(source.UnitId, state.rule.id, state.executionSequence + actionIndex) % choices.length];
      if (!text) return;
      this.PublishNpcPresentation(source, {
        type: UnitPresentationType.Say,
        targetUnitId: target?.UnitId ?? 0,
        presentationId: 0,
        text,
      });
      return;
    }
    if (action.type === NpcContentInteractionActionType.ExecuteAbility) {
      this.DomainScene().Events.Publish(NpcEvents.InteractionActionRequested, {
        npc: source,
        ...(target ? { target } : {}),
        action,
        nowMs: TimeSystem.Instance.ServerNow,
      });
    }
  }

  private PublishNpcPresentation(
    source: NpcUnit,
    presentation: import("#tiangz/model").UnitPresentation,
  ): void {
    void this.map.PublishUnitPresentation(source, presentation).catch((error) => {
      this.DomainScene().logger.error("npc interaction presentation publish failed", {
        unitId: source.UnitId,
        presentationType: presentation.type,
        error,
      });
    });
  }

  private TickNpcRoute(npc: NpcUnit, route: NpcRouteState, now: number): void {
    const waypoint = route.waypoints[route.nextWaypointIndex % route.waypoints.length];
    if (!waypoint) return;
    const native = npc.GetComponent(NativeUnitRef);
    const position = npc.GetComponent(PositionComponent);
    if (now < route.pauseUntilMs) {
      NativeData.ResetMovement(native.Handle);
      return;
    }
    if (distanceSquared(position.x, position.z, waypoint.x, waypoint.z) <= 0.25) {
      NativeData.ResetMovement(native.Handle);
      position.y = waypoint.y;
      if (waypoint.yaw !== undefined) position.yaw = waypoint.yaw;
      route.nextWaypointIndex = (route.nextWaypointIndex + 1) % route.waypoints.length;
      route.pauseUntilMs = now + waypoint.delayMs;
      route.navigationTarget = null;
      return;
    }
    position.SpeedMetersPerSecond = waypoint.moveSpeed ?? 1;
    const target = { x: waypoint.x, y: waypoint.y, z: waypoint.z };
    if (route.navigationTarget && distanceSquared(
      route.navigationTarget.x,
      route.navigationTarget.z,
      target.x,
      target.z,
    ) <= 0.25 && Math.abs(route.navigationTarget.y - target.y) <= 0.5) {
      return;
    }
    route.navigationSequence = route.navigationSequence >= 0xffff_fffe
      ? 1
      : route.navigationSequence + 1;
    if (this.map.SpatialProfile.spatialMode === SpatialMode.Grid2D) {
      const cellSize = this.map.SpatialProfile.cellSizeMeters;
      NativeData.SetGridMovementTarget(
        native.Handle,
        Math.round(target.x / cellSize),
        Math.round(target.z / cellSize),
        route.navigationSequence,
      );
      route.navigationTarget = target;
      return;
    }
    NativeData.SetNavigationTarget(
      this.map.NativeMapKey,
      native.Handle,
      target,
      route.navigationSequence,
    );
    route.navigationTarget = target;
  }

  /** 推进战斗型 NPC 的索敌、仇恨追击、攻击和脱战回归。 / Advances acquisition, threat chase, attacks, and evade return for combat-capable NPCs. */
  private TickNpcCombat(npc: NpcUnit, state: NpcCombatRuntimeState, now: number): void {
    const entry = this.contentSpawns.get(state.spawnId);
    const profile = entry?.definition.combatProfile;
    if (!entry || !profile) return;
    npc.TryGetComponent(NumericRegenerationComponent)?.Tick(now);
    const position = npc.GetComponent(PositionComponent);
    const home = {
      x: entry.spawn.spawnX,
      y: entry.spawn.spawnY,
      z: entry.spawn.spawnZ,
    };
    if (state.returningToSpawn) {
      if (distanceSquared(position.x, position.z, home.x, home.z)
        <= NPC_ARRIVAL_RANGE_METERS * NPC_ARRIVAL_RANGE_METERS) {
        this.StopNpcMovement(npc, state);
        position.y = home.y;
        state.returningToSpawn = false;
        state.nextAttackAtMs = 0;
        const numeric = npc.GetComponent(NumericComponent);
        numeric[NumericType.CurrentHp] = numeric[NumericType.MaxHp];
        numeric[NumericType.CurrentMp] = numeric[NumericType.MaxMp];
        npc.TryGetComponent(NumericRegenerationComponent)?.ResetSchedule();
        this.ResetNpcCombatBehavior(npc, state, now);
        return;
      }
      position.SpeedMetersPerSecond = profile.moveSpeed;
      this.MoveNpcToward(npc, state, home);
      return;
    }

    const wasEngaged = state.targetUnitId !== 0 || state.threatByUnitId.size > 0;
    let target = this.FindHighestThreatPlayer(npc, state);
    if (!target && !wasEngaged) {
      target = this.FindNearestEligiblePlayer(
        npc,
        profile.acquireRangeMeters,
        profile.aggressivePlayerConfigIds,
      );
      if (target) this.AddThreat(npc, target, 1n);
    }
    if (!target && wasEngaged) {
      this.BeginNpcReturn(npc, state, now);
      return;
    }
    if (!target) return;
    state.targetUnitId = target.UnitId;
    const homeDistanceSquared = distanceSquared(position.x, position.z, home.x, home.z);
    if (homeDistanceSquared > profile.leashRangeMeters * profile.leashRangeMeters) {
      this.BeginNpcReturn(npc, state, now);
      return;
    }
    const targetPosition = target.GetComponent(PositionComponent);
    const targetDistanceSquared = distanceSquared(
      position.x,
      position.z,
      targetPosition.x,
      targetPosition.z,
    );
    this.TickNpcCombatBehavior(npc, target, state, targetDistanceSquared, now);
    if (state.fleeing) {
      position.SpeedMetersPerSecond = profile.moveSpeed;
      this.MoveNpcAwayFromTarget(npc, target, state, home, profile.leashRangeMeters);
      return;
    }
    if (targetDistanceSquared > profile.attackRange * profile.attackRange) {
      if (!state.combatMovementEnabled) {
        this.StopNpcMovement(npc, state);
        return;
      }
      position.SpeedMetersPerSecond = profile.moveSpeed;
      this.MoveNpcToward(npc, state, targetPosition);
      return;
    }
    this.StopNpcMovement(npc, state);
    if (now < state.nextAttackAtMs) return;
    this.AttackPlayerFromNpc(npc, target);
    state.nextAttackAtMs = now + profile.attackIntervalMs;
  }

  private AddThreat(npc: NpcUnit, player: PlayerUnit, amount: bigint): void {
    if (amount <= 0n || player.GetComponent(NativeUnitRef).alive === 0) return;
    const state = this.combatStates.get(npc.UnitId);
    if (!state || state.returningToSpawn || npc.GetComponent(NativeUnitRef).alive === 0) return;
    const beginsEngagement = state.threatByUnitId.size === 0;
    state.threatByUnitId.set(
      player.UnitId,
      (state.threatByUnitId.get(player.UnitId) ?? 0n) + amount,
    );
    state.targetUnitId = player.UnitId;
    player.GetComponent(CombatStateComponent).AddHostile(npc.UnitId, TimeSystem.Instance.ServerNow);
    if (beginsEngagement) {
      state.engagementSequence += 1;
      state.triggeredBehaviorRuleIds.clear();
      state.behaviorRuleNextAtMs.clear();
      state.behaviorRuleExecutionSequences.clear();
      state.fleeing = false;
      state.fleeDistanceMeters = 0;
      this.TriggerNpcCombatBehavior(
        npc,
        player,
        state,
        NpcCombatBehaviorTrigger.Engage,
      );
    }
  }

  private FindHighestThreatPlayer(
    npc: NpcUnit,
    state: NpcCombatRuntimeState,
  ): PlayerUnit | undefined {
    const position = npc.GetComponent(PositionComponent);
    let selected: PlayerUnit | undefined;
    let selectedThreat = 0n;
    let selectedDistanceSquared = Number.POSITIVE_INFINITY;
    for (const [unitId, threat] of [...state.threatByUnitId]) {
      const player = this.units.Get<PlayerUnit>(unitId);
      if (!player || player.GetComponent(NativeUnitRef).alive === 0) {
        player?.GetComponent(CombatStateComponent).RemoveHostile(npc.UnitId, TimeSystem.Instance.ServerNow);
        state.threatByUnitId.delete(unitId);
        continue;
      }
      const playerPosition = player.GetComponent(PositionComponent);
      const candidateDistance = distanceSquared(
        position.x,
        position.z,
        playerPosition.x,
        playerPosition.z,
      );
      if (!selected
        || threat > selectedThreat
        || (threat === selectedThreat && (
          candidateDistance < selectedDistanceSquared
          || (candidateDistance === selectedDistanceSquared && player.UnitId < selected.UnitId)
        ))) {
        selected = player;
        selectedThreat = threat;
        selectedDistanceSquared = candidateDistance;
      }
    }
    return selected;
  }

  private FindNearestEligiblePlayer(
    npc: NpcUnit,
    rangeMeters: number,
    playerConfigIds: readonly number[],
  ): PlayerUnit | undefined {
    if (playerConfigIds.length === 0) return undefined;
    const position = npc.GetComponent(PositionComponent);
    let selected: PlayerUnit | undefined;
    let selectedDistance = rangeMeters * rangeMeters;
    for (const player of this.units.GetAll(PlayerUnit)) {
      if (player.GetComponent(NativeUnitRef).alive === 0
        || !playerConfigIds.includes(player.PlayerConfigId)) continue;
      const playerPosition = player.GetComponent(PositionComponent);
      const candidateDistance = distanceSquared(
        position.x,
        position.z,
        playerPosition.x,
        playerPosition.z,
      );
      if (candidateDistance > selectedDistance) continue;
      if (!selected || candidateDistance < selectedDistance || player.UnitId < selected.UnitId) {
        selected = player;
        selectedDistance = candidateDistance;
      }
    }
    return selected;
  }

  /** 按稳定规则编号顺序求值全部连续战斗事实。 / Evaluates all continuous combat facts in stable rule-id order. */
  private TickNpcCombatBehavior(
    npc: NpcUnit,
    target: PlayerUnit,
    state: NpcCombatRuntimeState,
    targetDistanceSquared: number,
    nowMs: number,
  ): void {
    const rules = this.NpcCombatBehaviorRules(state);
    for (const rule of rules) {
      if (rule.trigger === NpcCombatBehaviorTrigger.Reset
        || rule.trigger === NpcCombatBehaviorTrigger.Engage) continue;
      if (!this.NpcBehaviorStateMatches(state, rule)) continue;
      if (rule.oncePerEngagement && state.triggeredBehaviorRuleIds.has(rule.id)) continue;
      let matches = false;
      if (rule.trigger === NpcCombatBehaviorTrigger.CombatInterval) {
        let nextAtMs = state.behaviorRuleNextAtMs.get(rule.id);
        if (nextAtMs === undefined) {
          nextAtMs = nowMs + selectNpcCombatDelayMs(
            npc.UnitId,
            rule.id,
            0,
            rule.initialDelayMinMs ?? 0,
            rule.initialDelayMaxMs ?? 0,
          );
          state.behaviorRuleNextAtMs.set(rule.id, nextAtMs);
        }
        matches = nowMs >= nextAtMs;
      } else if (rule.trigger === NpcCombatBehaviorTrigger.HealthRange) {
        const numeric = npc.GetComponent(NumericComponent);
        matches = numericPermille(
          numeric[NumericType.CurrentHp],
          numeric[NumericType.MaxHp],
        ) >= (rule.minValuePermille ?? 0)
          && numericPermille(
            numeric[NumericType.CurrentHp],
            numeric[NumericType.MaxHp],
          ) <= (rule.maxValuePermille ?? 1_000);
      } else if (rule.trigger === NpcCombatBehaviorTrigger.ResourceRange) {
        const numeric = npc.GetComponent(NumericComponent);
        const value = numericPermille(
          numeric[NumericType.CurrentMp],
          numeric[NumericType.MaxMp],
        );
        matches = value >= (rule.minValuePermille ?? 0)
          && value <= (rule.maxValuePermille ?? 1_000);
      } else if (rule.trigger === NpcCombatBehaviorTrigger.TargetDistanceRange) {
        const distance = Math.sqrt(targetDistanceSquared);
        matches = distance >= (rule.minDistanceMeters ?? 0)
          && distance <= (rule.maxDistanceMeters ?? Number.POSITIVE_INFINITY);
      }
      if (!matches) continue;
      const nextAtMs = state.behaviorRuleNextAtMs.get(rule.id) ?? 0;
      if (rule.trigger !== NpcCombatBehaviorTrigger.CombatInterval && nowMs < nextAtMs) continue;
      this.ExecuteNpcCombatBehaviorRule(npc, target, state, rule, nowMs);
    }
  }

  private TriggerNpcCombatBehavior(
    npc: NpcUnit,
    target: PlayerUnit | undefined,
    state: NpcCombatRuntimeState,
    trigger: import("#tiangz/model").NpcCombatBehaviorTriggerValue,
    nowMs: number = TimeSystem.Instance.ServerNow,
  ): void {
    for (const rule of this.NpcCombatBehaviorRules(state)) {
      if (rule.trigger !== trigger || !this.NpcBehaviorStateMatches(state, rule)) continue;
      if (rule.oncePerEngagement && state.triggeredBehaviorRuleIds.has(rule.id)) continue;
      this.ExecuteNpcCombatBehaviorRule(npc, target, state, rule, nowMs);
    }
  }

  private ExecuteNpcCombatBehaviorRule(
    npc: NpcUnit,
    target: PlayerUnit | undefined,
    state: NpcCombatRuntimeState,
    rule: Readonly<NpcCombatBehaviorRule>,
    nowMs: number,
  ): void {
    const executionSequence = state.behaviorRuleExecutionSequences.get(rule.id) ?? 0;
    if (rule.oncePerEngagement) state.triggeredBehaviorRuleIds.add(rule.id);
    const chanceRejected = rule.chancePermille < 1_000
      && rollNpcCombatPermille(
        npc.UnitId,
        rule.id,
        state.engagementSequence + executionSequence,
      ) >= rule.chancePermille;
    if (!chanceRejected) {
      for (const action of rule.actions) {
        if (action.type === NpcCombatBehaviorActionType.ExecuteAbility) {
          this.DomainScene().Events.Publish(NpcEvents.CombatActionRequested, {
            npc,
            ...(target ? { target } : {}),
            action,
            nowMs,
          });
          continue;
        }
        if (action.type === NpcCombatBehaviorActionType.SetCombatMovement) {
          state.combatMovementEnabled = action.enabled ?? false;
          if (!state.combatMovementEnabled) this.StopNpcMovement(npc, state);
          continue;
        }
        if (action.type === NpcCombatBehaviorActionType.SetState) {
          state.behaviorState = action.state ?? 0;
          continue;
        }
        if (action.type === NpcCombatBehaviorActionType.ChangeState) {
          state.behaviorState = Math.max(0, Math.min(30, state.behaviorState + (action.stateDelta ?? 0)));
          continue;
        }
        if (action.type === NpcCombatBehaviorActionType.Flee) {
          state.fleeing = true;
          state.combatMovementEnabled = true;
          state.fleeDistanceMeters = action.fleeDistanceMeters ?? 8;
        }
      }
    }
    const nextSequence = executionSequence + 1;
    state.behaviorRuleExecutionSequences.set(rule.id, nextSequence);
    const repeatMinMs = rule.repeatDelayMinMs ?? 0;
    const repeatMaxMs = rule.repeatDelayMaxMs ?? repeatMinMs;
    if (rule.trigger === NpcCombatBehaviorTrigger.CombatInterval
      || rule.repeatDelayMinMs !== undefined) {
      state.behaviorRuleNextAtMs.set(
        rule.id,
        nowMs + selectNpcCombatDelayMs(
          npc.UnitId,
          rule.id,
          nextSequence,
          repeatMinMs,
          repeatMaxMs,
        ),
      );
    }
  }

  private NpcCombatBehaviorRules(
    state: NpcCombatRuntimeState,
  ): readonly Readonly<NpcCombatBehaviorRule>[] {
    const entry = this.contentSpawns.get(state.spawnId);
    if (!entry) return [];
    return entry.spawn.combatBehaviorRules !== undefined
      ? entry.spawn.combatBehaviorRules
      : (entry.definition.combatProfile?.behaviorRules ?? []);
  }

  private NpcBehaviorStateMatches(
    state: NpcCombatRuntimeState,
    rule: Readonly<NpcCombatBehaviorRule>,
  ): boolean {
    const mask = rule.requiredStateMask ?? 0;
    return mask === 0 || (mask & (1 << state.behaviorState)) !== 0;
  }

  private ResetNpcCombatBehavior(
    npc: NpcUnit,
    state: NpcCombatRuntimeState,
    nowMs: number,
  ): void {
    state.behaviorState = 0;
    state.combatMovementEnabled = true;
    state.fleeing = false;
    state.fleeDistanceMeters = 0;
    state.triggeredBehaviorRuleIds.clear();
    state.behaviorRuleNextAtMs.clear();
    state.behaviorRuleExecutionSequences.clear();
    this.TriggerNpcCombatBehavior(npc, undefined, state, NpcCombatBehaviorTrigger.Reset, nowMs);
  }

  private MoveNpcAwayFromTarget(
    npc: NpcUnit,
    target: PlayerUnit,
    state: NpcCombatRuntimeState,
    home: Readonly<{ x: number; y: number; z: number }>,
    leashRangeMeters: number,
  ): void {
    if (state.navigationTarget) return;
    const position = npc.GetComponent(PositionComponent);
    const targetPosition = target.GetComponent(PositionComponent);
    let dx = position.x - targetPosition.x;
    let dz = position.z - targetPosition.z;
    const length = Math.hypot(dx, dz);
    if (length <= 0.001) {
      dx = Math.cos(position.yaw);
      dz = Math.sin(position.yaw);
    } else {
      dx /= length;
      dz /= length;
    }
    let desiredX = position.x + dx * state.fleeDistanceMeters;
    let desiredZ = position.z + dz * state.fleeDistanceMeters;
    const homeDx = desiredX - home.x;
    const homeDz = desiredZ - home.z;
    const homeDistance = Math.hypot(homeDx, homeDz);
    const maximum = Math.max(0.5, leashRangeMeters - 0.5);
    if (homeDistance > maximum) {
      desiredX = home.x + homeDx / homeDistance * maximum;
      desiredZ = home.z + homeDz / homeDistance * maximum;
    }
    this.MoveNpcToward(npc, state, { x: desiredX, y: position.y, z: desiredZ });
  }

  private BeginNpcReturn(npc: NpcUnit, state: NpcCombatRuntimeState, now: number): void {
    this.ClearNpcThreat(npc, state, now);
    state.returningToSpawn = true;
    state.nextAttackAtMs = 0;
    this.StopNpcMovement(npc, state);
  }

  private ClearNpcThreat(npc: NpcUnit, state: NpcCombatRuntimeState, now: number): void {
    for (const unitId of state.threatByUnitId.keys()) {
      this.units.Get<PlayerUnit>(unitId)?.GetComponent(CombatStateComponent)
        .RemoveHostile(npc.UnitId, now);
    }
    state.threatByUnitId.clear();
    state.targetUnitId = 0;
  }

  private MoveNpcToward(
    npc: NpcUnit,
    state: NpcCombatRuntimeState,
    target: Readonly<{ x: number; y: number; z: number }>,
  ): void {
    const previous = state.navigationTarget;
    if (previous
      && distanceSquared(previous.x, previous.z, target.x, target.z) <= 0.25
      && Math.abs(previous.y - target.y) <= 0.5) return;
    state.navigationSequence = state.navigationSequence >= 0xffff_fffe
      ? 1
      : state.navigationSequence + 1;
    const native = npc.GetComponent(NativeUnitRef);
    if (this.map.SpatialProfile.spatialMode === SpatialMode.Grid2D) {
      const cellSize = this.map.SpatialProfile.cellSizeMeters;
      NativeData.SetGridMovementTarget(
        native.Handle,
        Math.round(target.x / cellSize),
        Math.round(target.z / cellSize),
        state.navigationSequence,
      );
    } else {
      NativeData.SetNavigationTarget(this.map.NativeMapKey, native.Handle, target, state.navigationSequence);
    }
    state.navigationTarget = { x: target.x, y: target.y, z: target.z };
  }

  private StopNpcMovement(npc: NpcUnit, state: NpcCombatRuntimeState): void {
    state.navigationTarget = null;
    NativeData.ResetMovement(npc.GetComponent(NativeUnitRef).Handle);
  }

  private AttackPlayerFromNpc(
    npc: NpcUnit,
    target: PlayerUnit,
  ): void {
    const numeric = npc.GetComponent(NumericComponent);
    this.ApplyDamageToPlayer(npc, target, {
      amount: numeric[NumericType.Attack] > 0n ? numeric[NumericType.Attack] : 0n,
      canBePrevented: true,
    });
  }

  private KillCombatNpc(npc: NpcUnit, state: NpcCombatRuntimeState): void {
    const now = TimeSystem.Instance.ServerNow;
    const entry = this.contentSpawns.get(state.spawnId);
    this.ClearNpcThreat(npc, state, now);
    this.StopNpcMovement(npc, state);
    state.returningToSpawn = false;
    state.corpseExpiresAtMs = now + NPC_CORPSE_LIFETIME_MS;
    const respawnSeconds = entry?.spawn.respawnSeconds ?? 0;
    state.respawnAtMs = respawnSeconds > 0 ? now + respawnSeconds * 1_000 : 0;
    this.interactionStates.delete(npc.UnitId);
  }

  private PublishCombatDamage(
    target: NpcUnit | PlayerUnit,
    sourceUnitId: number,
    result: DamageResult,
    abilityId = 0,
  ): void {
    void this.map.PublishCombatDamage(target, sourceUnitId, result, abilityId).catch((error) => {
      this.DomainScene().logger.error("NPC combat damage publish failed", {
        sourceUnitId,
        targetUnitId: target.UnitId,
        abilityId,
        error,
      });
    });
  }

  private RemoveNpcEntity(npc: NpcUnit, failureMessage: string): void {
    const state = this.combatStates.get(npc.UnitId);
    if (state) this.ClearNpcThreat(npc, state, TimeSystem.Instance.ServerNow);
    this.routes.delete(npc.UnitId);
    this.interactionDefinitions.delete(npc.UnitId);
    this.interactionStates.delete(npc.UnitId);
    this.interactionSequences.delete(npc.UnitId);
    this.idleSequenceDefinitions.delete(npc.UnitId);
    this.idleSequenceStates.delete(npc.UnitId);
    this.combatStates.delete(npc.UnitId);
    NativeData.ResetMovement(npc.GetComponent(NativeUnitRef).Handle);
    const changes = [
      ...(this.DomainScene().TryGetComponent(SummonComponent)?.OwnerLeaving(npc) ?? []),
      ...(this.aoi.IsAttached(npc) ? this.aoi.Detach(npc) : []),
    ];
    this.npcs.delete(npc.UnitId);
    this.units.Remove(npc.UnitId);
    if (changes.length > 0) {
      void this.map.PublishVisibilityChanges(changes).catch((error) => {
        this.DomainScene().logger.error(failureMessage, { unitId: npc.UnitId, error });
      });
    }
  }

  protected override OnDestroy(): void {
    // NPC由UnitComponent拥有；地图组件销毁时先脱离AOI，再释放Unit和Native句柄。
    // UnitComponent owns NPCs; map teardown detaches AOI before releasing each Unit and Native handle.
    for (const npc of this.npcs.values()) {
      try {
        this.DomainScene().TryGetComponent(SummonComponent)?.OwnerLeaving(npc);
        if (this.aoi.IsAttached(npc)) this.aoi.Detach(npc);
      } catch {
        // AOI可能已经在异常清理中释放；这里仍继续释放Unit索引。
        // AOI may already be released during failed teardown; continue clearing the Unit index.
      }
      this.units.Remove(npc.UnitId);
    }
    this.npcs.clear();
    this.contentSpawns.clear();
    this.routes.clear();
    this.interactionDefinitions.clear();
    this.interactionStates.clear();
    this.interactionSequences.clear();
    this.idleSequenceDefinitions.clear();
    this.idleSequenceStates.clear();
    this.combatStates.clear();
    this.pendingRespawns.clear();
    this.spawnGenerations.clear();
    this.definitionContentPatches.clear();
    this.spawnContentPatches.clear();
  }

  private ApplyContentPatch(
    catalog: Map<number, Map<string, Readonly<NpcRuntimeContentPatch>>>,
    targetId: number,
    ownerId: string,
    patch: Readonly<NpcRuntimeContentPatch>,
    targets: readonly NpcUnit[],
    unitOwnerId: string,
  ): readonly NpcUnit[] {
    const owner = requireContentPatchOwner(ownerId);
    const patches = catalog.get(targetId) ?? new Map<string, Readonly<NpcRuntimeContentPatch>>();
    const previous = patches.get(owner);
    if (previous) {
      if (JSON.stringify(previous) === JSON.stringify(patch)) return [];
      throw new Error(`NPC content patch ${owner} is already active on target ${targetId}`);
    }
    patches.set(owner, patch);
    catalog.set(targetId, patches);
    const changed: NpcUnit[] = [];
    try {
      for (const npc of targets) {
        if (npc.ApplyRuntimeContentPatch(unitOwnerId, patch)) changed.push(npc);
      }
    } catch (error) {
      for (const npc of changed.reverse()) npc.RemoveRuntimeContentPatch(unitOwnerId);
      patches.delete(owner);
      if (patches.size === 0) catalog.delete(targetId);
      throw error;
    }
    return Object.freeze(changed);
  }

  private RemoveContentPatch(
    catalog: Map<number, Map<string, Readonly<NpcRuntimeContentPatch>>>,
    targetId: number,
    ownerId: string,
    targets: readonly NpcUnit[],
    unitOwnerId: string,
  ): readonly NpcUnit[] {
    const owner = requireContentPatchOwner(ownerId);
    const patches = catalog.get(targetId);
    if (!patches?.delete(owner)) return [];
    if (patches.size === 0) catalog.delete(targetId);
    const changed = targets.filter((npc) => npc.RemoveRuntimeContentPatch(unitOwnerId));
    return Object.freeze(changed);
  }

  private get units(): UnitComponent {
    return this.DomainScene().GetComponent(UnitComponent);
  }
}

function requireContentPatchOwner(ownerId: string): string {
  const owner = ownerId?.trim();
  if (!owner || owner.length > 120) throw new Error("NPC content patch owner must be 1..120 characters");
  return owner;
}

function definitionPatchOwner(definitionId: number, ownerId: string): string {
  return `definition:${definitionId}:${requireContentPatchOwner(ownerId)}`;
}

function spawnPatchOwner(spawnId: number, ownerId: string): string {
  return `spawn:${spawnId}:${requireContentPatchOwner(ownerId)}`;
}

function distanceSquared(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

function selectNpcIdleDelayMs(
  unitId: number,
  sequenceId: number,
  executionSequence: number,
  minimum: number,
  maximum: number,
): number {
  if (minimum >= maximum) return minimum;
  return minimum + (npcIdleHash(unitId, sequenceId, executionSequence) % (maximum - minimum + 1));
}

function rollNpcIdlePermille(unitId: number, sequenceId: number, executionSequence: number): number {
  return npcIdleHash(unitId, sequenceId, executionSequence) % 1_000;
}

function selectNpcInteractionDelayMs(
  sourceUnitId: number,
  ruleId: number,
  actionId: number,
  executionSequence: number,
  minimum: number,
  maximum: number,
): number {
  if (minimum >= maximum) return minimum;
  return minimum + (
    npcInteractionHash(sourceUnitId, ruleId, actionId, executionSequence)
    % (maximum - minimum + 1)
  );
}

function rollNpcInteractionPermille(
  sourceUnitId: number,
  ruleId: number,
  executionSequence: number,
): number {
  return npcInteractionHash(sourceUnitId, ruleId, executionSequence) % 1_000;
}

function selectNpcCombatDelayMs(
  unitId: number,
  ruleId: number,
  executionSequence: number,
  minimum: number,
  maximum: number,
): number {
  if (minimum >= maximum) return minimum;
  return minimum + (
    npcCombatHash(unitId, ruleId, executionSequence) % (maximum - minimum + 1)
  );
}

function rollNpcCombatPermille(unitId: number, ruleId: number, sequence: number): number {
  return npcCombatHash(unitId, ruleId, sequence) % 1_000;
}

function npcCombatHash(unitId: number, ruleId: number, sequence: number): number {
  let value = (unitId ^ Math.imul(ruleId, 0x45d9f3b) ^ Math.imul(sequence + 1, 0x27d4eb2d)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d) >>> 0;
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}

function numericPermille(current: bigint, maximum: bigint): number {
  if (maximum <= 0n) return 0;
  const bounded = current < 0n ? 0n : current > maximum ? maximum : current;
  return Number(bounded * 1_000n / maximum);
}

function selectNpcInteractionPresentationId(
  sourceUnitId: number,
  action: NpcContentInteractionAction,
  executionSequence: number,
): number {
  const candidates = action.presentationIds
    ?? (action.presentationId === undefined ? [] : [action.presentationId]);
  if (candidates.length === 0) return 0;
  return candidates[
    npcInteractionHash(sourceUnitId, action.id, executionSequence) % candidates.length
  ] ?? 0;
}

function selectNpcPresentationId(
  unitId: number,
  action: NpcContentIdleAction,
  executionSequence: number,
): number {
  const candidates = action.presentationIds
    ?? (action.presentationId === undefined ? [] : [action.presentationId]);
  if (candidates.length === 0) return 0;
  return candidates[npcIdleHash(unitId, action.id, executionSequence) % candidates.length] ?? 0;
}

function npcIdleHash(unitId: number, sequenceId: number, executionSequence: number): number {
  let hash = 0x811c9dc5;
  for (const value of [unitId, sequenceId, executionSequence]) {
    hash = Math.imul(hash ^ (value & 0xff), 0x01000193);
    hash = Math.imul(hash ^ ((value >>> 8) & 0xff), 0x01000193);
    hash = Math.imul(hash ^ ((value >>> 16) & 0xff), 0x01000193);
    hash = Math.imul(hash ^ ((value >>> 24) & 0xff), 0x01000193);
  }
  return hash >>> 0;
}

function npcInteractionHash(...values: number[]): number {
  let hash = 0x811c9dc5;
  for (const value of values) {
    hash = Math.imul(hash ^ (value & 0xff), 0x01000193);
    hash = Math.imul(hash ^ ((value >>> 8) & 0xff), 0x01000193);
    hash = Math.imul(hash ^ ((value >>> 16) & 0xff), 0x01000193);
    hash = Math.imul(hash ^ ((value >>> 24) & 0xff), 0x01000193);
  }
  return hash >>> 0;
}
