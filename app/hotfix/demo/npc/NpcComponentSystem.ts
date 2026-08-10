import {
  GameConfigs,
  GameErrCode,
  MapAoiComponent,
  MapComponent,
  NativeUnitRef,
  NpcComponent,
  NpcUnit,
  PositionComponent,
  RpcError,
  SpatialMode,
  UnitComponent,
  STARTER_NPC_CONFIG_ID,
  STARTER_NPC_INTERACT_RANGE_METERS,
  STARTER_NPC_NAME,
  STARTER_NPC_QUEST_CONFIG_IDS,
  STARTER_NPC_UNIT_ID,
  type AwakeNpcUnit,
  type PlayerUnit,
  systemFor,
} from "#tiangz/model";

const STARTER_MAP_ID = 100;
const STARTER_NPC_X_OFFSET = 3;

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
    if (map.MapId !== STARTER_MAP_ID) return;
    if (this.npcs.has(STARTER_NPC_UNIT_ID)) {
      throw new Error(`starter NPC already exists: ${STARTER_NPC_UNIT_ID}`);
    }
    this.SpawnStarterNpc();
    this.DomainScene().logger.info("starter NPC ready", {
      mapId: map.MapId,
      npcUnitId: STARTER_NPC_UNIT_ID,
      questConfigIds: [...STARTER_NPC_QUEST_CONFIG_IDS],
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

  /**
   * 验证“玩家已经找到这个NPC并且可以接这个任务”。必须在PlayerUnit有序mailbox内调用，
   * 这样多个Enter/Accept并发不会绕过任务状态检查；实际Accept仍交给QuestComponent。
   *
   * Validates that the player found this NPC and that the NPC offers the quest.
   * Call it inside the ordered PlayerUnit mailbox so concurrent requests cannot
   * bypass quest-state checks; QuestComponent still owns the actual acceptance.
   */
  ValidateQuestInteraction(player: PlayerUnit, npcUnitId: number, questConfigId: number): void {
    const npc = this.npcs.get(npcUnitId);
    if (!npc || !this.aoi.IsAttached(npc)) {
      throw new RpcError(GameErrCode.NpcNotFound, `npc not found: ${npcUnitId}`);
    }
    if (npc.DomainScene() !== player.DomainScene()) {
      throw new RpcError(GameErrCode.NpcNotFound, `npc is not in player's map: ${npcUnitId}`);
    }
    if (!npc.QuestConfigIds.includes(questConfigId)) {
      throw new RpcError(
        GameErrCode.NpcQuestUnavailable,
        `npc ${npcUnitId} does not offer quest ${questConfigId}`,
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

  /** 创建固定任务使者；它是Subject，不是Observer，也不拥有Player或Quest状态。 / Creates the fixed quest giver as a Subject, never an Observer or owner of player/quest state. */
  private SpawnStarterNpc(): void {
    const config = GameConfigs.MapConfig.Get(this.map.MapId);
    const spawn = {
      x: config.spawnX + STARTER_NPC_X_OFFSET,
      y: config.spawnY,
      z: config.spawnZ,
    };
    const projected = config.spatialMode === SpatialMode.NavMesh3D
      ? this.map.ProjectPosition(spawn)
      : spawn;
    if (!projected) throw new Error(`starter NPC spawn outside NavMesh: ${spawn.x},${spawn.y},${spawn.z}`);

    const request: AwakeNpcUnit = {
      mapId: this.map.MapId,
      mapInstanceId: this.map.MapInstanceId,
      npcConfigId: STARTER_NPC_CONFIG_ID,
      name: STARTER_NPC_NAME,
      questConfigIds: STARTER_NPC_QUEST_CONFIG_IDS,
    };
    const npc = this.units.Create(STARTER_NPC_UNIT_ID, NpcUnit, request);
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
        config.widthCells,
        config.depthCells,
        config.cellSizeMeters,
      );
      position.SetNavMeshWorldPosition(projected.x, projected.y, projected.z, 0);
      position.SpeedMetersPerSecond = 0.01;
      this.npcs.set(npc.UnitId, npc);
      const changes = this.aoi.Attach(npc, 0, false, true);
      if (changes.length > 0) {
        void this.map.PublishVisibilityChanges(changes).catch((error) => {
          this.DomainScene().logger.error("starter NPC AOI publish failed", { error });
        });
      }
    } catch (error) {
      this.units.Remove(npc.UnitId);
      throw error;
    }
  }

  protected override OnDestroy(): void {
    // NPC由UnitComponent拥有；地图组件销毁时先脱离AOI，再释放Unit和Native句柄。
    // UnitComponent owns NPCs; map teardown detaches AOI before releasing each Unit and Native handle.
    for (const npc of this.npcs.values()) {
      try {
        if (this.aoi.IsAttached(npc)) this.aoi.Detach(npc);
      } catch {
        // AOI可能已经在异常清理中释放；这里仍继续释放Unit索引。
        // AOI may already be released during failed teardown; continue clearing the Unit index.
      }
      this.units.Remove(npc.UnitId);
    }
    this.npcs.clear();
  }

  private get units(): UnitComponent {
    return this.DomainScene().GetComponent(UnitComponent);
  }
}
