import {
  GameErrCode,
  InteractableComponent,
  InteractableContentProfileComponent,
  InteractableEvents,
  InteractableUnit,
  NormalizeInteractableRuntimeContentPatch,
  ItemComponent,
  LootContentProfileComponent,
  M2C_UseInteractableCodec,
  MapAoiComponent,
  MapComponent,
  NativeUnitRef,
  PlayerPersistenceComponent,
  PositionComponent,
  QuestComponent,
  QuestObjectiveType,
  QuestStatus,
  RpcError,
  SkillComponent,
  SpatialMode,
  SpawnSelectionCandidateKind,
  SpawnSelectionComponent,
  UnitComponent,
  utf8Encode,
  type AwakeInteractableUnit,
  type InteractableContentDefinition,
  type InteractableContentSpawn,
  type InteractableRuntimeContentPatch,
  type ItemSnapshot,
  type M2C_UseInteractable,
  type PlayerUnit,
  type QuestSnapshot,
  type QuestState,
  type QuestTransferState,
  type SkillProficiencyState,
  type SkillTransferState,
  applyEntityExtensions,
  systemFor,
} from "#tiangz/model";
import { ResolveLootTableRows, type LootRollChannel } from "../loot/LootRoll";

const INTERACTABLE_RESPAWN_SWEEP_MS = 1_000;

/**
 * 可交互物体继续复用Unit、AOI、背包和任务事务；具体游戏协议只消费中立快照与Use入口。
 * Interactables reuse Unit, AOI, inventory, and quest transactions while game-specific
 * protocols consume only neutral snapshots and the Use entrypoint.
 */
@systemFor(InteractableComponent)
export class InteractableComponentSystem extends InteractableComponent {
  protected override Awake(map: MapComponent, aoi: MapAoiComponent): void {
    this.map = map;
    this.aoi = aoi;
    const content = this.DomainScene().GetComponent(InteractableContentProfileComponent);
    for (const spawn of content.GetSpawns()) {
      const definition = content.TryGetDefinition(spawn.interactableDefinitionId);
      if (!definition) {
        throw new Error(
          `interactable spawn ${spawn.id} references missing definition ${spawn.interactableDefinitionId}`,
        );
      }
      this.SpawnContentInteractable(definition, spawn, spawn.initialSpawn);
    }
    this.NewRepeatedTimer(INTERACTABLE_RESPAWN_SWEEP_MS, "RespawnAvailable");
    this.DomainScene().logger.info("interactable catalog ready", {
      mapId: map.MapId,
      interactableCount: this.interactables.size,
      contentOwner: content.ColdContentReplacementOwner,
    });
  }

  Get(interactableUnitId: number): InteractableUnit | undefined {
    return this.interactables.get(interactableUnitId);
  }

  ActivateSpawn(spawnId: number): void {
    const interactable = this.interactables.get(spawnId);
    if (!interactable) throw new Error(`interactable spawn not found: ${spawnId}`);
    this.respawnAtByUnitId.delete(spawnId);
    if (this.aoi.IsAttached(interactable)) return;
    const changes = this.aoi.Attach(interactable, 0, false, true);
    if (changes.length > 0) {
      void this.map.PublishVisibilityChanges(changes).catch((error) => {
        this.DomainScene().logger.error("interactable activation AOI publish failed", {
          error,
          interactableUnitId: spawnId,
        });
      });
    }
  }

  DeactivateSpawn(spawnId: number): void {
    const interactable = this.interactables.get(spawnId);
    if (!interactable) throw new Error(`interactable spawn not found: ${spawnId}`);
    this.respawnAtByUnitId.delete(spawnId);
    if (!this.aoi.IsAttached(interactable)) return;
    const changes = this.aoi.Detach(interactable);
    if (changes.length > 0) {
      void this.map.PublishVisibilityChanges(changes).catch((error) => {
        this.DomainScene().logger.error("interactable deactivation AOI publish failed", {
          error,
          interactableUnitId: spawnId,
        });
      });
    }
  }

  GetAll(): readonly InteractableUnit[] {
    return [...this.interactables.values()];
  }

  ApplyDefinitionContentPatch(
    ownerId: string,
    definitionId: number,
    patch: InteractableRuntimeContentPatch,
  ): readonly InteractableUnit[] {
    if (!this.DomainScene().GetComponent(InteractableContentProfileComponent).TryGetDefinition(definitionId)) {
      throw new Error(`interactable definition not found for runtime content patch: ${definitionId}`);
    }
    const owner = requireContentPatchOwner(ownerId);
    const normalized = NormalizeInteractableRuntimeContentPatch(patch);
    const patches = this.definitionContentPatches.get(definitionId)
      ?? new Map<string, Readonly<InteractableRuntimeContentPatch>>();
    const previous = patches.get(owner);
    if (previous) {
      if (JSON.stringify(previous) === JSON.stringify(normalized)) return [];
      throw new Error(`interactable content patch ${owner} is already active on ${definitionId}`);
    }
    patches.set(owner, normalized);
    this.definitionContentPatches.set(definitionId, patches);
    const changed: InteractableUnit[] = [];
    try {
      for (const interactable of this.interactables.values()) {
        if (interactable.InteractableConfigId !== definitionId) continue;
        if (interactable.ApplyRuntimeContentPatch(definitionPatchOwner(definitionId, owner), normalized)) {
          changed.push(interactable);
        }
      }
    } catch (error) {
      for (const interactable of changed.reverse()) {
        interactable.RemoveRuntimeContentPatch(definitionPatchOwner(definitionId, owner));
      }
      patches.delete(owner);
      if (patches.size === 0) this.definitionContentPatches.delete(definitionId);
      throw error;
    }
    return Object.freeze(changed);
  }

  RemoveDefinitionContentPatch(ownerId: string, definitionId: number): readonly InteractableUnit[] {
    const owner = requireContentPatchOwner(ownerId);
    const patches = this.definitionContentPatches.get(definitionId);
    if (!patches?.delete(owner)) return [];
    if (patches.size === 0) this.definitionContentPatches.delete(definitionId);
    return Object.freeze([...this.interactables.values()].filter((interactable) => (
      interactable.InteractableConfigId === definitionId
      && interactable.RemoveRuntimeContentPatch(definitionPatchOwner(definitionId, owner))
    )));
  }

  ValidateQuestOffer(player: PlayerUnit, interactableUnitId: number, questConfigId: number): void {
    const interactable = this.RequireAvailable(player, interactableUnitId);
    if (!interactable.QuestStarterConfigIds.includes(questConfigId)) {
      throw new RpcError(
        GameErrCode.NpcQuestUnavailable,
        `interactable ${interactableUnitId} does not offer quest ${questConfigId}`,
      );
    }
  }

  /**
   * 先规划背包与收集任务，再通过同一持久化事务提交；成功前物体保持可见，成功后同步离开AOI。
   * Plans inventory and collect-quest changes before one persistence commit. The object stays
   * visible until durable success, then leaves AOI synchronously and respawns from a map timer.
   */
  async Use(
    player: PlayerUnit,
    interactableUnitId: number,
    clientOperationId: string,
  ): Promise<M2C_UseInteractable> {
    const candidate = this.interactables.get(interactableUnitId);
    if (candidate?.InteractionEnabled === false) {
      throw new RpcError(
        GameErrCode.InteractableUnavailable,
        `interactable is presentation-only: ${interactableUnitId}`,
      );
    }
    const operationId = interactableOperationId(
      player.CharacterId,
      interactableUnitId,
      clientOperationId,
    );
    const persistence = player.GetComponent(PlayerPersistenceComponent);
    const domains = interactableTransactionDomains(candidate);
    const existing = await persistence.LoadTransaction(operationId, domains);
    if (existing) {
      const durable = decodeUseResponse(existing.result, interactableUnitId);
      applyDurableProficiencies(player, durable.proficiencies);
      this.ApplyRecoveredAvailability(interactableUnitId, durable.respawnAtMs);
      return cloneUseResponse(durable);
    }

    const interactable = this.RequireAvailable(player, interactableUnitId);
    if (interactable.InteractionActionId > 0) {
      this.DomainScene().Events.Publish(InteractableEvents.ActionRequested, {
        interactable,
        player,
        actionId: interactable.InteractionActionId,
        nowMs: Date.now(),
      });
      return {
        interactableUnitId,
        items: [],
        quests: [],
        respawnAtMs: 0n,
        proficiencies: [],
      };
    }
    if (this.inFlightUnitIds.has(interactableUnitId)) {
      throw new RpcError(
        GameErrCode.InteractableUnavailable,
        `interactable operation is already running: ${interactableUnitId}`,
      );
    }
    this.inFlightUnitIds.add(interactableUnitId);
    try {
      const quest = player.GetComponent(QuestComponent);
      const fixedQuestGrants = interactable.Rewards
        .map((reward) => ({
          configId: reward.itemConfigId,
          count: Math.min(
            reward.count,
            quest.RemainingProgress(QuestObjectiveType.CollectItem, reward.itemConfigId),
          ),
        }))
        .filter((reward) => reward.count > 0);
      const rolledGrants = this.RollLootGrants(interactable, operationId, quest);
      const grants = mergeItemGrants([...fixedQuestGrants, ...rolledGrants]);
      const questProgress = planQuestProgress(
        player,
        quest,
        grants,
        interactable.QuestObjectiveTargetConfigId,
      );
      if (grants.length === 0 && questProgress.length === 0 && !(interactable.LootTableId > 0)) {
        throw new RpcError(
          GameErrCode.InteractableRewardUnavailable,
          `player has no active objective for interactable ${interactableUnitId}`,
        );
      }

      const inventory = player.GetComponent(ItemComponent);
      const inventoryPlan = inventory.PlanGrantItems(grants);
      const proficiencyPlan = planProficiencyGain(player, interactable);
      const baseData = persistence.Capture("interactable-use", {
        items: inventoryPlan.nextItems,
        ...(proficiencyPlan ? { skill: proficiencyPlan.nextState } : {}),
      });
      const data = {
        ...baseData,
        quests: mergeQuestProgress(baseData.quests, questProgress),
      };
      const respawnAtMs = Date.now() + interactable.RespawnDelayMs;
      const response: M2C_UseInteractable = {
        interactableUnitId,
        items: inventoryPlan.affectedItems.map((item) => ({ ...item })),
        quests: questProgress.map(toProtocolQuest),
        respawnAtMs: BigInt(respawnAtMs),
        proficiencies: proficiencyPlan ? [{ ...proficiencyPlan.proficiency }] : [],
      };
      const encodedResponse = M2C_UseInteractableCodec.encode(response);
      let committed: { result: Uint8Array };
      try {
        committed = await persistence.ApplyTransaction(
          operationId,
          domains,
          data,
          encodedResponse,
        );
      } catch (error) {
        const receipt = await persistence.LoadTransaction(operationId, domains);
        if (!receipt) throw error;
        committed = receipt;
      }

      const durable = decodeUseResponse(committed.result, interactableUnitId);
      if (bytesEqual(committed.result, encodedResponse)) {
        inventory.CommitGrantPlan(inventoryPlan);
        quest.ApplyCommittedProgress(questProgress);
      } else {
        inventory.ApplyCommittedGrantItems(durable.items);
        quest.ApplyCommittedProgress(fromProtocolQuests(durable.quests));
      }
      applyDurableProficiencies(player, durable.proficiencies);
      const changes = this.MakeUnavailable(interactable, Number(durable.respawnAtMs));
      for (const item of durable.items) await this.map.PublishItemChanged(player, item);
      if (durable.quests.length > 0) {
        await this.map.PublishQuestProgress(player, fromProtocolQuests(durable.quests));
      }
      if (changes.length > 0) await this.map.PublishVisibilityChanges(changes);
      this.DomainScene().logger.info("interactable reward committed", {
        playerCharacterId: player.CharacterId.toString(),
        interactableUnitId,
        itemConfigIds: durable.items.map((item) => item.configId),
        respawnAtMs: durable.respawnAtMs.toString(),
      });
      return cloneUseResponse(durable);
    } finally {
      this.inFlightUnitIds.delete(interactableUnitId);
    }
  }

  /** 单个地图定时桶恢复到期物体，不为每个刷点创建独立Timer。 / One map timer bucket restores due objects without per-spawn timers. */
  RespawnAvailable(): void {
    const now = Date.now();
    for (const [unitId, respawnAtMs] of [...this.respawnAtByUnitId]) {
      if (respawnAtMs > now || this.inFlightUnitIds.has(unitId)) continue;
      const interactable = this.interactables.get(unitId);
      this.respawnAtByUnitId.delete(unitId);
      if (!interactable || this.aoi.IsAttached(interactable)) continue;
      const changes = this.aoi.Attach(interactable, 0, false, true);
      if (changes.length > 0) {
        void this.map.PublishVisibilityChanges(changes).catch((error) => {
          this.DomainScene().logger.error("interactable respawn AOI publish failed", {
            error,
            interactableUnitId: unitId,
          });
        });
      }
    }
  }

  private RequireAvailable(player: PlayerUnit, interactableUnitId: number): InteractableUnit {
    const interactable = this.interactables.get(interactableUnitId);
    if (!interactable || interactable.DomainScene() !== player.DomainScene()) {
      throw new RpcError(
        GameErrCode.InteractableNotFound,
        `interactable not found: ${interactableUnitId}`,
      );
    }
    if (interactable.InteractionEnabled === false) {
      throw new RpcError(
        GameErrCode.InteractableUnavailable,
        `interactable is presentation-only: ${interactableUnitId}`,
      );
    }
    if (!this.aoi.IsAttached(interactable) || this.respawnAtByUnitId.has(interactableUnitId)) {
      throw new RpcError(
        GameErrCode.InteractableUnavailable,
        `interactable is unavailable: ${interactableUnitId}`,
      );
    }
    const playerPosition = player.GetComponent(PositionComponent);
    const objectPosition = interactable.GetComponent(PositionComponent);
    const dx = playerPosition.x - objectPosition.x;
    const dy = playerPosition.y - objectPosition.y;
    const dz = playerPosition.z - objectPosition.z;
    const distanceSquared = dx * dx + dy * dy + dz * dz;
    if (distanceSquared > interactable.UseRangeMeters ** 2) {
      throw new RpcError(
        GameErrCode.InteractableTooFar,
        `interactable ${interactableUnitId} is too far from player: ${Math.sqrt(distanceSquared).toFixed(2)}m`,
      );
    }
    if (
      interactable.ProficiencyId > 0 &&
      player.GetComponent(SkillComponent).ProficiencyRank(interactable.ProficiencyId) <
        interactable.RequiredProficiencyRank
    ) {
      throw new RpcError(
        GameErrCode.InteractableRequirementNotMet,
        `interactable ${interactableUnitId} requires proficiency ${interactable.ProficiencyId} rank ${interactable.RequiredProficiencyRank}`,
      );
    }
    return interactable;
  }

  private SpawnContentInteractable(
    definition: Readonly<InteractableContentDefinition>,
    spawn: Readonly<InteractableContentSpawn>,
    attach: boolean,
  ): void {
    const spatial = this.map.SpatialProfile;
    const requested = {
      x: spawn.spawnX,
      y: spawn.spawnY,
      z: spawn.spawnZ,
      yaw: spawn.spawnYaw,
    };
    const projected = spatial.spatialMode === SpatialMode.NavMesh3D
      ? this.map.ProjectPosition(requested)
      : requested;
    if (!projected) {
      throw new Error(
        `interactable spawn outside NavMesh: ${requested.x},${requested.y},${requested.z}`,
      );
    }
    const request: AwakeInteractableUnit = {
      mapId: this.map.MapId,
      mapInstanceId: this.map.MapInstanceId,
      interactableConfigId: definition.id,
      name: definition.name,
      presentationModelId: definition.presentationModelId,
      interactionEnabled: definition.interactionEnabled ?? true,
      interactionActionId: definition.interactionActionId,
      useRangeMeters: definition.useRangeMeters,
      respawnDelayMs: definition.respawnDelayMs,
      lootTableId: definition.lootTableId,
      questObjectiveTargetConfigId: definition.questObjectiveTargetConfigId,
      proficiencyId: definition.proficiencyId,
      requiredProficiencyRank: definition.requiredProficiencyRank,
      proficiencyGain: definition.proficiencyGain,
      rewards: definition.rewards,
      questStarterConfigIds: definition.questStarterConfigIds ?? [],
    };
    const interactable = this.units.Create(spawn.id, InteractableUnit, request);
    try {
      const native = interactable.AddComponent(NativeUnitRef, {
        id: interactable.UnitId,
        instanceId: interactable.InstanceId,
        mapId: this.map.NativeMapKey,
        x: 0,
        y: 0,
        z: 0,
      });
      const position = interactable.AddComponent(
        PositionComponent,
        native,
        spatial.widthCells,
        spatial.depthCells,
        spatial.cellSizeMeters,
      );
      if (spatial.spatialMode === SpatialMode.Grid2D) {
        position.SetGridWorldPosition(projected.x, projected.y, projected.z, requested.yaw);
      } else {
        position.SetNavMeshWorldPosition(projected.x, projected.y, projected.z, requested.yaw);
      }
      position.SpeedMetersPerSecond = 0.01;
      for (const [ownerId, patch] of this.definitionContentPatches.get(definition.id) ?? []) {
        interactable.ApplyRuntimeContentPatch(definitionPatchOwner(definition.id, ownerId), patch);
      }
      // 模块组件必须在索引和AOI发布前完成同步装配；失败沿用本工厂的整Entity回滚。
      // Module components attach synchronously before indexing or AOI publication;
      // a failure follows this factory's existing whole-Entity rollback path.
      applyEntityExtensions(interactable);
      this.interactables.set(interactable.UnitId, interactable);
      if (attach) {
        const changes = this.aoi.Attach(interactable, 0, false, true);
        if (changes.length > 0) {
          void this.map.PublishVisibilityChanges(changes).catch((error) => {
            this.DomainScene().logger.error("interactable AOI publish failed", { error });
          });
        }
      }
    } catch (error) {
      this.units.Remove(interactable.UnitId);
      throw error;
    }
  }

  /** 对普通表行执行确定性独立/分组判定；任务表行仍按活动收集目标限制数量。 / Rolls ordinary independent/grouped rows deterministically while quest rows remain capped by active collect objectives. */
  private RollLootGrants(
    interactable: InteractableUnit,
    operationId: string,
    quest: QuestComponent,
  ): readonly Readonly<{ configId: number; count: number }>[] {
    if (!(interactable.LootTableId > 0)) return [];
    const content = this.DomainScene().GetComponent(LootContentProfileComponent);
    const rows = [...content.GetRows(interactable.LootTableId)]
      .sort((left, right) => left.id - right.id);
    const ordinaryRows = rows.filter((row) => row.questObjectiveId === 0);
    const selected = ResolveLootTableRows(
      ordinaryRows,
      (dropTableId) => content.GetRows(dropTableId),
      (row, channel) => deterministicInteractableLootValue(
        operationId,
        interactableLootDrawId(row.id, channel),
        1_000,
      ),
    );
    const questRows = rows.filter((row) => row.questObjectiveId !== 0 && row.itemConfigId > 0)
      .filter((row) => (
        row.chancePermille > deterministicInteractableLootValue(operationId, row.id, 1_000)
      ));
    return [...selected, ...questRows]
      .map((row) => {
        const count = deterministicInteractableLootRange(
          operationId,
          row.id,
          row.minCount,
          row.maxCount,
        );
        return {
          configId: row.itemConfigId,
          count: row.questObjectiveId === 0
            ? count
            : Math.min(
              count,
              quest.RemainingProgress(QuestObjectiveType.CollectItem, row.itemConfigId),
            ),
        };
      })
      .filter((grant) => grant.count > 0);
  }

  private MakeUnavailable(
    interactable: InteractableUnit,
    respawnAtMs: number,
  ): ReturnType<MapAoiComponent["Detach"]> {
    const changes = this.aoi.IsAttached(interactable) ? this.aoi.Detach(interactable) : [];
    const selection = this.SpawnSelection();
    if (
      selection?.Owns(SpawnSelectionCandidateKind.Interactable, interactable.UnitId)
      && selection.Release(
        SpawnSelectionCandidateKind.Interactable,
        interactable.UnitId,
        respawnAtMs,
      )
    ) {
      this.respawnAtByUnitId.delete(interactable.UnitId);
    } else {
      this.respawnAtByUnitId.set(interactable.UnitId, respawnAtMs);
    }
    return changes;
  }

  private SpawnSelection(): SpawnSelectionComponent | undefined {
    const scene = this.DomainScene();
    if (typeof scene.TryGetComponent !== "function") return undefined;
    return scene.TryGetComponent(SpawnSelectionComponent);
  }

  private ApplyRecoveredAvailability(interactableUnitId: number, respawnAtMs: bigint): void {
    if (respawnAtMs <= BigInt(Date.now())) return;
    const interactable = this.interactables.get(interactableUnitId);
    if (!interactable) return;
    const changes = this.MakeUnavailable(interactable, Number(respawnAtMs));
    if (changes.length > 0) {
      void this.map.PublishVisibilityChanges(changes).catch((error) => {
        this.DomainScene().logger.error("recovered interactable AOI publish failed", {
          error,
          interactableUnitId,
        });
      });
    }
  }

  protected override OnDestroy(): void {
    for (const interactable of this.interactables.values()) {
      try {
        if (this.aoi.IsAttached(interactable)) this.aoi.Detach(interactable);
      } catch {
        // AOI可能已在异常清理中释放；继续清除Unit所有权。 / AOI may already be gone during failed teardown; continue Unit cleanup.
      }
      this.units.Remove(interactable.UnitId);
    }
    this.interactables.clear();
    this.respawnAtByUnitId.clear();
    this.inFlightUnitIds.clear();
    this.definitionContentPatches.clear();
  }

  private get units(): UnitComponent {
    return this.DomainScene().GetComponent(UnitComponent);
  }
}

function requireContentPatchOwner(ownerId: string): string {
  const owner = ownerId?.trim();
  if (!owner || owner.length > 120) {
    throw new Error("interactable content patch owner must be 1..120 characters");
  }
  return owner;
}

function definitionPatchOwner(definitionId: number, ownerId: string): string {
  return `definition:${definitionId}:${requireContentPatchOwner(ownerId)}`;
}

function planQuestProgress(
  player: PlayerUnit,
  quest: QuestComponent,
  grants: readonly Readonly<{ configId: number; count: number }>[],
  interactableTargetConfigId = 0,
): readonly QuestState[] {
  // QuestComponent.PlanProgress plans one event against the current Entity
  // snapshot.  An interaction may emit both item grants and a neutral
  // UseInteractable fact, so merge each event's objective deltas before the
  // transaction is committed; otherwise a later event could overwrite a
  // different objective advanced by an earlier event.
  const baseline = new Map(quest.Snapshot().map((state) => [state.questConfigId, state]));
  const planned = new Map<number, QuestState>();
  const revisionBumps = new Map<number, number>();
  const apply = (event: {
    readonly objectiveType: number;
    readonly targetConfigId: number;
    readonly count: number;
  }): void => {
    for (const state of quest.PlanProgress({ player, ...event })) {
      const previous = planned.get(state.questConfigId)
        ?? baseline.get(state.questConfigId)
        ?? state;
      let changed = false;
      const objectives = previous.objectives.map((objective) => {
        const incoming = state.objectives.find((value) => value.objectiveId === objective.objectiveId);
        if (!incoming || incoming.current <= objective.current) return { ...objective };
        changed = true;
        return { ...objective, current: incoming.current };
      });
      if (!changed) continue;
      const baseRevision = baseline.get(state.questConfigId)?.revision ?? previous.revision;
      const revision = (revisionBumps.get(state.questConfigId) ?? 0) + 1;
      revisionBumps.set(state.questConfigId, revision);
      planned.set(state.questConfigId, {
        ...previous,
        objectives,
        status: objectives.every((objective) => objective.current >= objective.required)
          ? QuestStatus.ReadyToTurnIn
          : QuestStatus.InProgress,
        revision: baseRevision + revision,
      });
    }
  };
  for (const grant of grants) {
    apply({
      objectiveType: QuestObjectiveType.CollectItem,
      targetConfigId: grant.configId,
      count: grant.count,
    });
  }
  if (interactableTargetConfigId > 0) {
    apply({
      objectiveType: QuestObjectiveType.UseInteractable,
      targetConfigId: interactableTargetConfigId,
      count: 1,
    });
  }
  return [...planned.values()].sort((left, right) => left.questConfigId - right.questConfigId);
}

function mergeQuestProgress(
  current: QuestTransferState,
  changed: readonly QuestState[],
): QuestTransferState {
  const active = new Map(current.active.map((quest) => [quest.questConfigId, quest]));
  for (const quest of changed) active.set(quest.questConfigId, quest);
  return {
    active: [...active.values()].sort((left, right) => left.questConfigId - right.questConfigId),
    completedQuestConfigIds: [...current.completedQuestConfigIds],
  };
}

function toProtocolQuest(value: QuestState): QuestSnapshot {
  return {
    questConfigId: value.questConfigId,
    objectives: value.objectives.map((objective) => ({ ...objective })),
    revision: value.revision,
    readyToComplete: value.status === QuestStatus.ReadyToTurnIn,
    status: value.status,
  };
}

function fromProtocolQuests(values: readonly QuestSnapshot[]): QuestState[] {
  return values.map((value) => ({
    questConfigId: value.questConfigId,
    objectives: value.objectives.map((objective) => ({ ...objective })),
    revision: value.revision,
    status: value.status || (
      value.readyToComplete ? QuestStatus.ReadyToTurnIn : QuestStatus.InProgress
    ),
  }));
}

function interactableOperationId(
  characterId: bigint,
  interactableUnitId: number,
  clientOperationId: string,
): string {
  const client = clientOperationId?.trim();
  if (!client || client.length > 128) {
    throw new RpcError(GameErrCode.InvalidOperationId, "interactable operation id is invalid");
  }
  const operationId = `interactable:${characterId}:${interactableUnitId}:${client}`;
  if (utf8Encode(operationId).byteLength > 256) {
    throw new RpcError(
      GameErrCode.InvalidOperationId,
      "interactable operation id exceeds DBProxy limit",
    );
  }
  return operationId;
}

function decodeUseResponse(payload: Uint8Array, expectedUnitId: number): M2C_UseInteractable {
  const response = M2C_UseInteractableCodec.decode(payload);
  if (response.interactableUnitId !== expectedUnitId) {
    throw new Error(
      `interactable receipt mismatch: expected ${expectedUnitId}, got ${response.interactableUnitId}`,
    );
  }
  return cloneUseResponse(response);
}

function cloneUseResponse(value: M2C_UseInteractable): M2C_UseInteractable {
  return {
    interactableUnitId: value.interactableUnitId,
    items: value.items.map(cloneItem),
    quests: value.quests.map((quest) => ({
      ...quest,
      objectives: quest.objectives.map((objective) => ({ ...objective })),
    })),
    respawnAtMs: value.respawnAtMs,
    proficiencies: value.proficiencies.map((proficiency) => ({ ...proficiency })),
  };
}

function interactableTransactionDomains(
  interactable: InteractableUnit | undefined,
): readonly ("inventory" | "quest" | "runtime")[] {
  return (interactable?.ProficiencyGain ?? 0) > 0
    ? ["inventory", "quest", "runtime"]
    : ["inventory", "quest"];
}

function planProficiencyGain(
  player: PlayerUnit,
  interactable: InteractableUnit,
): Readonly<{
  nextState: SkillTransferState;
  proficiency: SkillProficiencyState;
}> | undefined {
  if (!(interactable.ProficiencyId > 0) || !(interactable.ProficiencyGain > 0)) return undefined;
  const skill = player.GetComponent(SkillComponent);
  const current = skill.Proficiency(interactable.ProficiencyId);
  if (!current) {
    throw new RpcError(
      GameErrCode.InteractableRequirementNotMet,
      `player does not own proficiency ${interactable.ProficiencyId}`,
    );
  }
  const proficiency = {
    proficiencyId: current.proficiencyId,
    rank: Math.min(current.maximumRank, current.rank + interactable.ProficiencyGain),
    maximumRank: current.maximumRank,
  };
  const transfer = skill.CaptureTransfer();
  const proficiencies = new Map(
    (transfer.proficiencies ?? []).map((entry) => [entry.proficiencyId, { ...entry }]),
  );
  proficiencies.set(proficiency.proficiencyId, proficiency);
  return Object.freeze({
    nextState: {
      ...transfer,
      proficiencies: [...proficiencies.values()]
        .sort((left, right) => left.proficiencyId - right.proficiencyId),
    },
    proficiency: Object.freeze({ ...proficiency }),
  });
}

function applyDurableProficiencies(
  player: PlayerUnit,
  proficiencies: readonly SkillProficiencyState[],
): void {
  if (proficiencies.length === 0) return;
  const skill = player.GetComponent(SkillComponent);
  for (const proficiency of proficiencies) {
    skill.ApplyCommittedProficiency(
      proficiency.proficiencyId,
      proficiency.rank,
      proficiency.maximumRank,
    );
  }
}

function cloneItem(value: ItemSnapshot): ItemSnapshot {
  return { ...value };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function mergeItemGrants(
  grants: readonly Readonly<{ configId: number; count: number }>[],
): readonly Readonly<{ configId: number; count: number }>[] {
  const counts = new Map<number, number>();
  for (const grant of grants) {
    const count = (counts.get(grant.configId) ?? 0) + grant.count;
    if (!Number.isSafeInteger(count)) throw new Error(`interactable item ${grant.configId} count overflow`);
    counts.set(grant.configId, count);
  }
  return [...counts]
    .sort(([left], [right]) => left - right)
    .map(([configId, count]) => Object.freeze({ configId, count }));
}

function deterministicInteractableLootRange(
  operationId: string,
  rowId: number,
  minimum: number,
  maximum: number,
): number {
  if (minimum === maximum) return minimum;
  return minimum + deterministicInteractableLootValue(
    operationId,
    rowId ^ 0x7f4a_7c15,
    maximum - minimum + 1,
  );
}

function deterministicInteractableLootValue(
  operationId: string,
  rowId: number,
  modulus: number,
): number {
  let value = Math.imul(rowId, 0x9e37_79b1) >>> 0;
  for (let index = 0; index < operationId.length; index += 1) {
    value = Math.imul(value ^ operationId.charCodeAt(index), 0x0100_0193) >>> 0;
  }
  return value % modulus;
}

function interactableLootDrawId(rowId: number, channel: LootRollChannel): number {
  if (channel === "group-gate") return (rowId ^ 0x6d2b_79f5) >>> 0;
  if (channel === "group-equal-selection") return (rowId ^ 0xb529_7a4d) >>> 0;
  return rowId;
}
