import {
  Component,
  EntryScene,
  Game,
  GlobalIdSystem,
  RpcError,
  SystemErrCode,
  UnitComponent,
  type CustomMetricSnapshot,
  type MaybePromise,
  TransferStagingRegistry,
} from "../../../core/public";
import { GameErrCode } from "../../game/protocol/GameErrCode";
import { GateMessages } from "../../../generated/model/server/demo/protocol/messageDescriptors";
import type {
  G2M_EnterMap,
  G2M_InitialSnapshot,
  G2M_TransferPlayer,
  M2G_EnterMap,
  M2G_InitialSnapshot,
  M2G_TransferPlayer,
  M2G_MapReady,
  M2M_AbortPlayerTransfer,
  M2M_AbortPlayerTransferResponse,
  M2M_CommitPlayerTransfer,
  M2M_CommitPlayerTransferResponse,
  M2M_PreparePlayerTransfer,
  M2M_PreparePlayerTransferResponse,
  M2MM_CreateAssignedDynamicMap,
  MM2M_CreateAssignedDynamicMap,
  DynamicMapAssignmentSnapshot,
  BuffTransferSnapshot,
  MapEntitySnapshot,
  MapHostEndpoint,
  MapInstanceSnapshot,
  PlayerTransferSnapshot,
  SkillTransferSnapshot,
} from "../../../generated/model/server/demo/protocol/messages";
import { MAP_ENTRY_ADMISSION_TIMEOUT_MS } from "../map/MapEntryAdmission";
import { MapTransferProtocol } from "../../../generated/model/server/demo/protocol/rpcs";
import { MapComponent } from "../map/MapComponent";
import { MapScene } from "../map/MapScene";
import { MapAoiComponent } from "../map/MapAoiComponent";
import { MonsterComponent } from "../monster/MonsterComponent";
import { NpcComponent } from "../npc/NpcComponent";
import { NpcShopComponent } from "../shop/NpcShopComponent";
import { PlayerTradeComponent } from "../trade/PlayerTradeComponent";
import { SkillMapComponent } from "../skill/SkillMapComponent";
import { PlayerUnit, type PlayerSnapshot } from "../map/PlayerUnit";
import { PlayerDirectoryComponent } from "./PlayerDirectoryComponent";
import { ItemComponent } from "../item/ItemComponent";
import { BuffComponent } from "../buff/BuffComponent";
import { SkillComponent, type SkillTransferState } from "../skill/SkillComponent";
import { QuestComponent } from "../quest/QuestComponent";
import type { PlayerRepository } from "../persistence/PlayerRepository";
import { PlayerPersistenceComponent } from "../persistence/PlayerPersistenceComponent";
import { ProgressionComponent } from "../progression/ProgressionComponent";
import { GameConfigs, QuestStatus } from "../../../generated/model/config";
import { LocationProxy } from "../location/LocationProxy";
import { UnitGateComponent } from "../map/UnitGateComponent";
import {
  StaticMapInstanceId,
  type MapInstanceDefinition,
} from "../map/MapInstance";
import {
  EntrySyncMode,
  IncludesNewObserverSnapshot,
  ParseEntrySyncMode,
} from "../map/EntrySyncMode";
import {
  MapHostEndpointFromScene,
  SceneConfigFromMapInstance,
} from "./MapHostEndpoint";

const monotonicNow = (): number => globalThis.performance?.now() ?? Date.now();

// 玩家跨MapHost快照的生成端与校验端必须引用同一版本，新增可传送Component时只修改这里。
// The producer and validator of player transfer snapshots must share one version;
// bump only this constant when a transferable Component changes the wire shape.
const PLAYER_TRANSFER_SCHEMA_VERSION = 9;

export class MapHostComponent extends Component<[repository: PlayerRepository]> {
  private readonly ownerGeneration = GlobalIdSystem.Instance.Next();
  private readonly maps = new Map<bigint, MapComponent>();
  private readonly dynamicAssignments = new Map<bigint, DynamicMapAssignmentSnapshot>();
  private readonly dynamicRequestIds = new Map<string, bigint>();
  private dynamicMapDisposedNotifier: DynamicMapDisposedNotifier | undefined;
  private repository!: PlayerRepository;
  private readonly incomingTransfers =
    new TransferStagingRegistry<PreparedIncomingPlayer>(1024);
  private location!: LocationProxy;
  private nextTransferSequence = 1;
  private readonly pendingSourceCleanup: Array<{
    source: PlayerUnit;
    map: MapComponent;
  }> = [];
  private sourceCleanupScheduled = false;
  private recoveringLocations = false;
  private locationOwnerClaimed = false;
  private locationOwnerClaim: Promise<void> | undefined;
  private readonly disposingMaps = new Set<bigint>();
  private readonly entryMetrics = {
    requests: 0,
    completed: 0,
    failures: 0,
    inFlight: 0,
    maxInFlight: 0,
    durationMs: 0,
    maxDurationMs: 0,
    idAllocations: 0,
    idAllocationMs: 0,
    maxIdAllocationMs: 0,
    playerCreates: 0,
    playerCreateMs: 0,
    maxPlayerCreateMs: 0,
    locationRegisters: 0,
    locationRegisterMs: 0,
    maxLocationRegisterMs: 0,
    mapReadySends: 0,
    mapReadySendMs: 0,
    maxMapReadySendMs: 0,
    locationResolves: 0,
    locationResolveMs: 0,
    maxLocationResolveMs: 0,
  };

  /** 定期回收源进程宕机遗留的Prepare，以及已完成事务的短期幂等记录。 / Periodically reclaims prepares orphaned by a crashed source and short-lived completed idempotency records. */
  protected override Awake(repository: PlayerRepository): void {
    this.repository = repository;
    this.location = new LocationProxy(this.owner.scenes);
    for (const mapConfigId of this.owner.self.staticMapIds ?? []) {
      this.CreateMap({
        mapConfigId,
        mapInstanceId: StaticMapInstanceId(mapConfigId),
        dynamic: false,
      });
    }
    this.NewRepeatedTimer(10_000, "SweepIncomingTransfers");
    this.NewRepeatedTimer(5_000, "RecoverOwnedLocations");
    this.NewOnceTimer(0, "RecoverOwnedLocations");
    this.NewRepeatedTimer(5_000, "RecoverHostedMapInstances");
    this.NewOnceTimer(0, "RecoverHostedMapInstances");
  }

  /** 收集每张托管地图的广播快照，不重置计数器。 / Collects one broadcast snapshot per hosted map without resetting counters. */
  BroadcastMetricSnapshots(): CustomMetricSnapshot[] {
    const transfers = this.incomingTransfers.Snapshot();
    return [
      ...[...this.maps.values()].map((map) => map.BroadcastMetricSnapshot()),
      {
        name: "map_transfer_staging",
        values: {
          prepared: transfers.prepared,
          committed: transfers.committed,
          aborted: transfers.aborted,
          total: transfers.total,
          capacity: transfers.capacity,
        },
      },
      {
        name: "map_entry",
        values: {
          requests_total: this.entryMetrics.requests,
          completed_total: this.entryMetrics.completed,
          failures_total: this.entryMetrics.failures,
          in_flight: this.entryMetrics.inFlight,
          max_in_flight: this.entryMetrics.maxInFlight,
          duration_ms_total: this.entryMetrics.durationMs,
          duration_ms_max: this.entryMetrics.maxDurationMs,
          id_allocations_total: this.entryMetrics.idAllocations,
          id_allocation_ms_total: this.entryMetrics.idAllocationMs,
          id_allocation_ms_max: this.entryMetrics.maxIdAllocationMs,
          player_creates_total: this.entryMetrics.playerCreates,
          player_create_ms_total: this.entryMetrics.playerCreateMs,
          player_create_ms_max: this.entryMetrics.maxPlayerCreateMs,
          location_registers_total: this.entryMetrics.locationRegisters,
          location_register_ms_total: this.entryMetrics.locationRegisterMs,
          location_register_ms_max: this.entryMetrics.maxLocationRegisterMs,
          map_ready_sends_total: this.entryMetrics.mapReadySends,
          map_ready_send_ms_total: this.entryMetrics.mapReadySendMs,
          map_ready_send_ms_max: this.entryMetrics.maxMapReadySendMs,
          location_resolves_total: this.entryMetrics.locationResolves,
          location_resolve_ms_total: this.entryMetrics.locationResolveMs,
          location_resolve_ms_max: this.entryMetrics.maxLocationResolveMs,
        },
        kinds: {
          requests_total: "counter",
          completed_total: "counter",
          failures_total: "counter",
          duration_ms_total: "counter",
          id_allocations_total: "counter",
          id_allocation_ms_total: "counter",
          player_creates_total: "counter",
          player_create_ms_total: "counter",
          location_registers_total: "counter",
          location_register_ms_total: "counter",
          map_ready_sends_total: "counter",
          map_ready_send_ms_total: "counter",
          location_resolves_total: "counter",
          location_resolve_ms_total: "counter",
        },
      },
    ];
  }

  /**
   * 协调全部托管地图优雅下线：保存玩家、清理所有Unit，再交给ProcessHost销毁Scene。
   * / Coordinates graceful shutdown: save players, clear every Unit, then let ProcessHost dispose Scenes.
   */
  async Shutdown(reason: string): Promise<void> {
    const results = await Promise.allSettled(
      [...this.maps.values()].map((map) => map.Shutdown(reason)),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `failed to stop ${failures.length} map(s) cleanly`,
      );
    }
  }

  /** 选择或创建地图、处理重连改绑，并返回小型进入响应；初始视野由客户端就绪确认后单独下发。 / Selects/creates a map and returns a small entry response; the initial view is sent after client readiness. */
  async enterMap(request: G2M_EnterMap): Promise<M2G_EnterMap> {
    const startedAt = monotonicNow();
    this.entryMetrics.requests += 1;
    this.entryMetrics.inFlight += 1;
    this.entryMetrics.maxInFlight = Math.max(
      this.entryMetrics.maxInFlight,
      this.entryMetrics.inFlight,
    );
    try {
      const response = await this.EnterMapCore(request);
      this.entryMetrics.completed += 1;
      return response;
    } catch (error) {
      this.entryMetrics.failures += 1;
      throw error;
    } finally {
      this.entryMetrics.inFlight -= 1;
      const elapsedMs = monotonicNow() - startedAt;
      this.entryMetrics.durationMs += elapsedMs;
      this.entryMetrics.maxDurationMs = Math.max(this.entryMetrics.maxDurationMs, elapsedMs);
    }
  }

  /** 执行进图事务主体；外层方法统一维护成功、失败和在途指标。 / Executes the entry transaction while the wrapper owns outcome and in-flight metrics. */
  private async EnterMapCore(request: G2M_EnterMap): Promise<M2G_EnterMap> {
    await this.EnsureLocationOwner();
    this.validateEnterMap(request);
    const entrySyncMode = ParseEntrySyncMode(request.entrySyncMode);

    const map = this.requireMap(request.mapInstanceId);
    const mapId = map.MapId;
    let player: PlayerUnit | undefined;
    let snapshot: PlayerSnapshot;
    let isNewPlayer = false;
    let entryEntities: readonly MapEntitySnapshot[] | undefined;

    for (;;) {
      player = this.players.Get(request.characterId);
      if (player?.MapInstanceId === request.mapInstanceId) {
        const reconnectingPlayer = player;
        try {
          snapshot = await this.owner.RunLocalActorMailbox(
            reconnectingPlayer,
            () => {
              if (!reconnectingPlayer.MatchesGate({ gateName: request.gateName })) {
                throw new Error(`player Gate mismatch: ${request.account}`);
              }
              return reconnectingPlayer.SecondEnterMap();
            },
          );
          break;
        } catch (error) {
          // 断线下线与重进可能交叠。仅当目录已确认旧实例消失时重试，
          // 其他业务异常必须原样抛出，不能被误判成一次普通重连。
          if (this.players.Get(request.characterId) === player) throw error;
          continue;
        }
      }

      if (player) {
        throw new RpcError(
          SystemErrCode.LocationConflict,
          "existing player must transfer through the Unit Actor route",
        );
      } else {
        let stageStartedAt = monotonicNow();
        const allocated = await this.location.AllocateUnitId({
          account: request.account,
          characterId: request.characterId,
        });
        let stageElapsedMs = monotonicNow() - stageStartedAt;
        this.entryMetrics.idAllocations += 1;
        this.entryMetrics.idAllocationMs += stageElapsedMs;
        this.entryMetrics.maxIdAllocationMs = Math.max(
          this.entryMetrics.maxIdAllocationMs,
          stageElapsedMs,
        );
        const loaded = await this.repository.Load(request.characterId);
        stageStartedAt = monotonicNow();
        player = map.CreatePlayer(allocated.unitId, request, loaded);
        stageElapsedMs = monotonicNow() - stageStartedAt;
        this.entryMetrics.playerCreates += 1;
        this.entryMetrics.playerCreateMs += stageElapsedMs;
        this.entryMetrics.maxPlayerCreateMs = Math.max(
          this.entryMetrics.maxPlayerCreateMs,
          stageElapsedMs,
        );
        try {
          stageStartedAt = monotonicNow();
          try {
            await this.location.Register({
              unitId: player.UnitId,
              account: player.Account,
              characterId: player.CharacterId,
              gateName: request.gateName,
              mapHostName: this.owner.self.name,
              mapId,
              mapInstanceId: map.MapInstanceId,
              actorInstanceId: player.InstanceId,
              ownerGeneration: this.ownerGeneration,
            });
          } finally {
            stageElapsedMs = monotonicNow() - stageStartedAt;
            this.entryMetrics.locationRegisters += 1;
            this.entryMetrics.locationRegisterMs += stageElapsedMs;
            this.entryMetrics.maxLocationRegisterMs = Math.max(
              this.entryMetrics.maxLocationRegisterMs,
              stageElapsedMs,
            );
          }
        } catch (error) {
          map.RemoveTransferredPlayer(player);
          throw error;
        }
      }
      snapshot = player.Snapshot();
      isNewPlayer = true;
      break;
    }

    const playerMap = this.mapOf(player);
    if (isNewPlayer) {
      entryEntities = await playerMap.PlayerEntered(player, entrySyncMode);
      if (IncludesNewObserverSnapshot(entrySyncMode)) {
        playerMap.StageInitialSnapshot(player, entryEntities);
      }
    }

    this.owner.logger.info("player entered map", {
      account: snapshot.account,
      mapId: snapshot.mapId,
      unitId: snapshot.unitId,
      actorId: player.InstanceId,
    });

    const mapReady: M2G_MapReady = {
      account: snapshot.account,
      characterId: snapshot.characterId,
      mapId: snapshot.mapId,
      unitId: snapshot.unitId,
      x: snapshot.x,
      y: snapshot.y,
      z: snapshot.z,
    };
    let stageStartedAt = monotonicNow();
    try {
      await this.owner.scenes.send(
        this.owner.scenes.byName(snapshot.gateName),
        GateMessages.MapReady,
        mapReady,
      );
    } finally {
      const elapsedMs = monotonicNow() - stageStartedAt;
      this.entryMetrics.mapReadySends += 1;
      this.entryMetrics.mapReadySendMs += elapsedMs;
      this.entryMetrics.maxMapReadySendMs = Math.max(
        this.entryMetrics.maxMapReadySendMs,
        elapsedMs,
      );
    }

    stageStartedAt = monotonicNow();
    let located;
    try {
      located = await this.location.Resolve({
        unitId: player.UnitId,
        account: "",
        characterId: player.CharacterId,
      });
    } finally {
      const elapsedMs = monotonicNow() - stageStartedAt;
      this.entryMetrics.locationResolves += 1;
      this.entryMetrics.locationResolveMs += elapsedMs;
      this.entryMetrics.maxLocationResolveMs = Math.max(
        this.entryMetrics.maxLocationResolveMs,
        elapsedMs,
      );
    }
    if (!located.found || located.location.actorInstanceId !== player.InstanceId) {
      throw new RpcError(
        GameErrCode.MapNotFound,
        `player location was not published: ${player.UnitId}`,
      );
    }

    return {
      account: snapshot.account,
      characterId: snapshot.characterId,
      mapId: snapshot.mapId,
      unitId: snapshot.unitId,
      actorInstanceId: player.InstanceId,
      fixedUpdateMs: Game.Instance.FixedUpdateMs,
      x: snapshot.x,
      y: snapshot.y,
      z: snapshot.z,
      entities: isNewPlayer
        ? []
        : IncludesNewObserverSnapshot(entrySyncMode)
          ? playerMap.EntitySnapshots(player)
          : [],
      items: player.GetComponent(ItemComponent).Snapshot(),
      quests: player.GetComponent(QuestComponent).Snapshot().map(toProtocolQuest),
      completedQuestConfigIds: player.GetComponent(QuestComponent).CompletedQuestConfigIds(),
      gold: snapshot.gold,
      starterDungeonCooldownEndAtMs: player.GetComponent(ProgressionComponent).StarterDungeonCooldownEndAtMs,
      mapInstanceId: located.location.mapInstanceId,
      locationRevision: located.location.revision,
    };
  }

  /**
   * 客户端显式确认监听器就绪后发送初始AOI快照；快照从EnterMap RPC解耦，避免大响应堵塞Map到Gate队列。
   * 请求必须命中当前权威Player；发送失败时保留快照供客户端重试，成功后立即释放引用。
   *
   * Sends the initial AOI snapshot only after an explicit client-ready handshake.
   * The snapshot stays available after a failed delivery and is released after success.
   */
  async PublishInitialSnapshot(request: G2M_InitialSnapshot): Promise<M2G_InitialSnapshot> {
    const player = this.players.Get(request.characterId);
    if (!player || player.UnitId !== request.unitId || player.Account !== request.account) {
      throw new RpcError(GameErrCode.MapNotFound, `initial snapshot player not found: ${request.account}`);
    }
    const map = this.mapOf(player);
    await map.PublishInitialSnapshot(player);
    return {
      rpcId: request.rpcId,
      error: 0,
      message: "",
      demoDoorClosed: map.DemoDoorClosed,
    };
  }

  /**
   * 从源PlayerUnit mailbox协调地图迁移；业务调用不区分同进程和跨进程。
   * Location Commit是全局权威提交点，提交后只允许重试通知和源对象清理。
   *
   * Coordinates map migration from the source PlayerUnit mailbox without
   * exposing local/remote transport to business code. Location Commit is the
   * global authority point; after it, only notifications and cleanup may retry.
   */
  async TransferPlayer(
    source: PlayerUnit,
    request: G2M_TransferPlayer,
  ): Promise<M2G_TransferPlayer> {
    await this.EnsureLocationOwner();
    if (
      source.Account !== request.account ||
      source.CharacterId !== request.characterId ||
      !source.MatchesGate({ gateName: request.gateName })
    ) {
      throw new RpcError(GameErrCode.GateSessionRequired, "player transfer identity mismatch");
    }
    const resolved = await this.location.ResolveMapInstance({
      mapInstanceId: request.targetMapInstanceId,
    });
    if (!resolved.found) {
      throw new RpcError(
        GameErrCode.MapNotFound,
        `map instance not found: ${request.targetMapInstanceId}`,
      );
    }
    if (request.targetMapInstanceId === source.MapInstanceId) {
      return this.TransferResponse(
        request.rpcId,
        source,
        this.mapOf(source),
        request.expectedLocationRevision,
      );
    }
    const operationId = `${this.owner.self.name}:${source.UnitId}:${source.InstanceId}:${this.nextTransferSequence++}`;
    await this.location.Lock({
      unitId: source.UnitId,
      expectedRevision: request.expectedLocationRevision,
      expectedActorInstanceId: source.InstanceId,
      operationId,
      state: "moving",
    });

    if (resolved.instance.mapHostName === this.owner.self.name) {
      return await this.TransferLocal(source, request, resolved.instance, operationId);
    }
    return await this.TransferRemote(source, request, resolved.instance, operationId);
  }

  /** 仅供同一MapHost内已经解析出的PlayerUnit进入真实Actor邮箱；跨进程定位仍必须经过Location。 / Enters the real Actor mailbox for an already-resolved PlayerUnit on this MapHost; cross-process lookup must still use Location. */
  RunPlayerMailbox<TResult>(
    player: PlayerUnit,
    body: (current: PlayerUnit) => MaybePromise<TResult>,
  ): MaybePromise<TResult> {
    return this.owner.RunLocalActorMailbox(player, body);
  }

  private async TransferLocal(
    source: PlayerUnit,
    request: G2M_TransferPlayer,
    targetInstance: MapInstanceSnapshot,
    operationId: string,
  ): Promise<M2G_TransferPlayer> {
    const sourceMap = this.mapOf(source);
    const targetMap = this.requireMap(targetInstance.mapInstanceId);
    let target: PlayerUnit | undefined;
    let directoryReplaced = false;
    let locationCommitted = false;
    try {
      target = targetMap.PrepareTransferredPlayer(
        source.UnitId,
        {
          account: source.Account,
          characterId: source.CharacterId,
          token: "map-transfer",
          gateName: request.gateName,
          mapInstanceId: targetInstance.mapInstanceId,
          hasInitialSpawnOverride: false,
          initialSpawnX: 0,
          initialSpawnY: 0,
          initialSpawnZ: 0,
          initialSpawnYaw: 0,
          entrySyncMode: EntrySyncMode.Full,
        },
        source.CaptureTransfer(),
      );
      if (!this.players.Replace(source, target)) {
        throw new Error(`player changed during map transfer: ${source.Account}`);
      }
      directoryReplaced = true;
      const committed = await this.location.Commit({
        unitId: source.UnitId,
        operationId,
        gateName: request.gateName,
        mapHostName: this.owner.self.name,
        mapId: targetInstance.mapConfigId,
        mapInstanceId: targetInstance.mapInstanceId,
        actorInstanceId: target.InstanceId,
        characterId: target.CharacterId,
        ownerGeneration: this.ownerGeneration,
      });
      locationCommitted = true;
      const snapshot = target.Snapshot();
      let entryEntities: readonly MapEntitySnapshot[] | undefined;
      try {
        entryEntities = await targetMap.PlayerEntered(target);
      } catch (error) {
        // Location提交后目标Actor已经权威，AOI通知失败只能记录并由后续全量同步修复。
        // Once Location commits, the target Actor is authoritative; an AOI
        // notification failure is logged and repaired by a later full snapshot.
        this.owner.logger.error("failed to broadcast locally transferred player enter", {
          unitId: target.UnitId,
          mapId: target.MapId,
          error,
        });
      }
      this.ScheduleSourceCleanup(sourceMap, source);
      return this.TransferResponse(
        request.rpcId,
        target,
        targetMap,
        committed.location.revision,
        entryEntities,
      );
    } catch (error) {
      if (!locationCommitted) {
        if (target && directoryReplaced) this.players.Replace(target, source);
        if (target) targetMap.DiscardPreparedPlayer(target);
        await this.location.Unlock({ unitId: source.UnitId, operationId }).catch(() => undefined);
      }
      throw error;
    }
  }

  private async TransferRemote(
    source: PlayerUnit,
    request: G2M_TransferPlayer,
    targetInstance: MapInstanceSnapshot,
    operationId: string,
  ): Promise<M2G_TransferPlayer> {
    const sourceMap = this.mapOf(source);
    const targetScene = SceneConfigFromMapInstance(targetInstance);
    let targetCommitted = false;
    try {
      const transfer = this.CreateTransferSnapshot(
        source,
        targetInstance,
        operationId,
      );
      await this.owner.scenes.call(
        targetScene,
        MapTransferProtocol.Prepare,
        { snapshot: transfer },
      );
      const target = await this.owner.scenes.call(
        targetScene,
        MapTransferProtocol.Commit,
        { transferId: operationId },
        { timeoutMs: MAP_ENTRY_ADMISSION_TIMEOUT_MS },
      );
      targetCommitted = true;
      const committed = await this.location.Commit({
        unitId: source.UnitId,
        operationId,
        gateName: request.gateName,
        mapHostName: target.mapHostName,
        mapId: target.mapId,
        mapInstanceId: target.mapInstanceId,
        actorInstanceId: target.actorInstanceId,
        characterId: source.CharacterId,
        ownerGeneration: target.ownerGeneration,
      });
      this.ScheduleSourceCleanup(sourceMap, source);
      return {
        rpcId: request.rpcId,
        error: 0,
        message: "",
        account: source.Account,
        characterId: source.CharacterId,
        mapHostName: target.mapHostName,
        mapId: target.mapId,
        mapInstanceId: target.mapInstanceId,
        unitId: target.unitId,
        actorInstanceId: target.actorInstanceId,
        locationRevision: committed.location.revision,
        x: target.x,
        y: target.y,
        z: target.z,
        entities: target.entities,
        fixedUpdateMs: target.fixedUpdateMs,
        items: target.items,
        quests: target.quests,
        completedQuestConfigIds: target.completedQuestConfigIds,
        gold: target.gold,
        starterDungeonCooldownEndAtMs: source.GetComponent(ProgressionComponent).StarterDungeonCooldownEndAtMs,
        mapHost: targetInstance.mapHost,
      };
    } catch (error) {
      if (!targetCommitted) {
        await this.owner.scenes.call(
          targetScene,
          MapTransferProtocol.Abort,
          { transferId: operationId },
        ).catch(() => undefined);
        await this.location.Unlock({ unitId: source.UnitId, operationId }).catch(() => undefined);
      } else {
        this.owner.logger.error("remote transfer requires recovery after target commit", {
          operationId,
          unitId: source.UnitId,
          targetMapHost: targetInstance.mapHostName,
          error,
        });
        throw new RpcError(
          SystemErrCode.LocationUnavailable,
          `remote transfer outcome is uncertain: ${operationId}`,
        );
      }
      throw error;
    }
  }

  private TransferResponse(
    rpcId: number | undefined,
    player: PlayerUnit,
    map: MapComponent,
    revision: bigint,
    entryEntities?: readonly MapEntitySnapshot[],
  ): M2G_TransferPlayer {
    const snapshot = player.Snapshot();
    return {
      rpcId,
      error: 0,
      message: "",
      account: snapshot.account,
      characterId: snapshot.characterId,
      mapHostName: this.owner.self.name,
      mapId: snapshot.mapId,
      mapInstanceId: snapshot.mapInstanceId,
      unitId: snapshot.unitId,
      actorInstanceId: player.InstanceId,
      locationRevision: revision,
      x: snapshot.x,
      y: snapshot.y,
      z: snapshot.z,
      entities: entryEntities ?? map.EntitySnapshots(player),
      fixedUpdateMs: Game.Instance.FixedUpdateMs,
      items: player.GetComponent(ItemComponent).Snapshot(),
      quests: player.GetComponent(QuestComponent).Snapshot().map(toProtocolQuest),
      completedQuestConfigIds: player.GetComponent(QuestComponent).CompletedQuestConfigIds(),
      gold: snapshot.gold,
      starterDungeonCooldownEndAtMs: player.GetComponent(ProgressionComponent).StarterDungeonCooldownEndAtMs,
      mapHost: this.EndpointSnapshot(),
    };
  }

  /**
   * Unit Handler返回后再销毁源Actor，避免在其mailbox回调尚未完成时破坏运行时校验。
   * 这里允许Location已指向目标Actor；新消息会进入目标，旧Actor只等待下一次Tick清理。
   *
   * Defers source disposal until the Unit Handler returns, preserving mailbox
   * runtime invariants. Location already targets the new Actor, while the old
   * instance survives only until the next timer turn.
   */
  private ScheduleSourceCleanup(map: MapComponent, source: PlayerUnit): void {
    this.pendingSourceCleanup.push({ source, map });
    if (this.sourceCleanupScheduled) return;
    this.sourceCleanupScheduled = true;
    this.NewOnceTimer(0, "FlushTransferredSources");
  }

  protected FlushTransferredSources(): void {
    this.sourceCleanupScheduled = false;
    for (const { source, map } of this.pendingSourceCleanup.splice(0)) {
      try {
        const changes = map.RemoveTransferredPlayer(source);
        void map.PlayerLeft(changes).catch((error) => {
          this.owner.logger.error("failed to broadcast transferred source leave", {
            unitId: source.UnitId,
            error,
          });
        });
      } catch (error) {
        this.owner.logger.error("failed to clean transferred source actor", {
          unitId: source.UnitId,
          actorInstanceId: source.InstanceId,
          error,
        });
      }
    }
  }

  /** 在目标进程构造不可见玩家；重复请求复用同一候选，尚不改变玩家目录。 / Builds an unpublished player on the target process; retries reuse the same candidate without changing the player directory. */
  PrepareIncomingTransfer(
    request: M2M_PreparePlayerTransfer,
  ): M2M_PreparePlayerTransferResponse {
    if (!this.locationOwnerClaimed) {
      throw new RpcError(SystemErrCode.LocationUnavailable, "MapHost location ownership is recovering");
    }
    const snapshot = request.snapshot;
    this.ValidateTransferSnapshot(snapshot);
    const result = this.incomingTransfers.Prepare(
      snapshot.transferId,
      JSON.stringify(snapshot, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value
      ),
      () => {
        const map = this.requireMap(snapshot.targetMapInstanceId);
        return {
          map,
          player: map.PrepareRemoteTransferredPlayer(snapshot),
        };
      },
      ({ map, player }) => map.DiscardPreparedPlayer(player),
    );
    return {
      rpcId: request.rpcId,
      error: 0,
      message: "",
      transferId: snapshot.transferId,
      stage: result.stage,
      actorInstanceId: result.target.player.InstanceId,
    };
  }

  /** 原子发布已准备玩家并返回目标Actor位置；广播失败只记录日志，不撤销提交。 / Atomically publishes a prepared player and returns its target Actor location; broadcast failure is logged without undoing the commit. */
  async CommitIncomingTransfer(
    request: M2M_CommitPlayerTransfer,
  ): Promise<M2M_CommitPlayerTransferResponse> {
    await this.EnsureLocationOwner();
    const committed = this.incomingTransfers.Commit(
      request.transferId,
      ({ player }) => {
        const snapshot = player.Snapshot();
        this.players.Add(player);
        return snapshot;
      },
    );
    let entryEntities: readonly MapEntitySnapshot[] | undefined;
    if (committed.newlyCommitted) {
      try {
        entryEntities = await committed.target.map.PlayerEntered(committed.target.player);
      } catch (error) {
        this.owner.logger.error("failed to broadcast incoming transferred player", {
          transferId: request.transferId,
          unitId: committed.result.unitId,
          mapId: committed.result.mapId,
          error,
        });
      }
    }
    return {
      rpcId: request.rpcId,
      error: 0,
      message: "",
      transferId: request.transferId,
      newlyCommitted: committed.newlyCommitted,
      mapId: committed.result.mapId,
      unitId: committed.result.unitId,
      actorInstanceId: committed.target.player.InstanceId,
      characterId: committed.result.characterId,
      x: committed.result.x,
      y: committed.result.y,
      z: committed.result.z,
      entities: entryEntities ?? committed.target.map.EntitySnapshots(committed.target.player),
      fixedUpdateMs: Game.Instance.FixedUpdateMs,
      items: committed.target.player.GetComponent(ItemComponent).Snapshot(),
      quests: committed.target.player.GetComponent(QuestComponent).Snapshot().map(toProtocolQuest),
      completedQuestConfigIds: committed.target.player.GetComponent(QuestComponent).CompletedQuestConfigIds(),
      gold: committed.target.player.Snapshot().gold,
      mapHostName: this.owner.self.name,
      mapInstanceId: committed.result.mapInstanceId,
      ownerGeneration: this.ownerGeneration,
    };
  }

  /** 中止尚未提交的跨进程迁移；已提交事务拒绝回滚。 / Aborts an uncommitted cross-process migration; committed transactions cannot be rolled back. */
  AbortIncomingTransfer(
    request: M2M_AbortPlayerTransfer,
  ): M2M_AbortPlayerTransferResponse {
    return {
      rpcId: request.rpcId,
      error: 0,
      message: "",
      transferId: request.transferId,
      newlyAborted: this.incomingTransfers.Abort(request.transferId),
    };
  }

  /** 从源Unit生成不含运行时引用的跨进程快照；transferId必须由源侧事务协调器保证唯一。 / Builds a cross-process snapshot without runtime references; the source coordinator must provide a unique transferId. */
  CreateTransferSnapshot(
    player: PlayerUnit,
    targetInstance: MapInstanceSnapshot,
    transferId: string,
  ): PlayerTransferSnapshot {
    const snapshot = player.Snapshot();
    const revisions = player.GetComponent(PlayerPersistenceComponent).Revisions;
    return {
      schemaVersion: PLAYER_TRANSFER_SCHEMA_VERSION,
      transferId,
      unitId: snapshot.unitId,
      account: snapshot.account,
      characterId: snapshot.characterId,
      sourceMapId: snapshot.mapId,
      targetMapId: targetInstance.mapConfigId,
      gateName: snapshot.gateName,
      sourceMapInstanceId: snapshot.mapInstanceId,
      speedCellsPerSecond: snapshot.speedCellsPerSecond,
      facing: snapshot.facing,
      alive: snapshot.alive,
      numerics: snapshot.numerics,
      items: player.GetComponent(ItemComponent).Snapshot(),
      buffs: player.GetComponent(BuffComponent).CaptureTransfer().map(toProtocolBuffTransfer),
      skill: toProtocolSkillTransfer(player.GetComponent(SkillComponent).CaptureTransfer()),
      quests: player.GetComponent(QuestComponent).Snapshot().map(toProtocolQuest),
      completedQuestConfigIds: player.GetComponent(QuestComponent).CompletedQuestConfigIds(),
      gold: snapshot.gold,
      targetMapInstanceId: targetInstance.mapInstanceId,
      persistenceRevision: 0n,
       inventoryRevision: revisions.inventory,
       progressionRevision: revisions.progression,
       questRevision: revisions.quest,
       runtimeRevision: revisions.runtime,
      walletRevision: revisions.wallet,
      starterDungeon: {
        cooldownEndAtMs: player.GetComponent(ProgressionComponent).StarterDungeonCooldownEndAtMs,
        operationId: player.GetComponent(ProgressionComponent).CaptureTransfer().starterDungeonOperationId,
      },
    };
  }

  /** Timer入口：Prepare保留30秒，完成态保留60秒用于网络重试幂等。 / Timer entrypoint: keeps prepares for 30 seconds and completed records for 60 seconds of retry idempotency. */
  protected SweepIncomingTransfers(): void {
    const removed = this.incomingTransfers.SweepExpired(30_000, 60_000);
    if (removed > 0) {
      this.owner.logger.info("expired map transfers reclaimed", { removed });
    }
  }

  /**
   * 周期性向Location重报本MapHost实际持有的Unit，正常运行时请求是幂等读写。
   * 这是Location内存进程重启恢复，不是跨机器租约或死亡节点接管机制。
   *
   * Periodically re-publishes Units actually owned by this MapHost. Calls are
   * idempotent during normal operation. This recovers an in-memory Location
   * process restart; it is not a lease or dead-node failover mechanism.
   */
  protected async RecoverOwnedLocations(): Promise<void> {
    if (this.recoveringLocations) return;
    this.recoveringLocations = true;
    try {
      const recovered = await this.PublishOwnedLocations();
      if (recovered.recovered > 0) {
        this.owner.logger.info("player locations recovered", {
          recovered: recovered.recovered,
          unchanged: recovered.unchanged,
        });
      }
    } catch (error) {
      this.owner.logger.warn("player location recovery failed", { error });
    } finally {
      this.recoveringLocations = false;
    }
  }

  /** 进图和迁移在发布当前MapHost代次前不得创建权威Player。 / Entry and transfer cannot create authoritative players before publishing this MapHost generation. */
  private async EnsureLocationOwner(): Promise<void> {
    if (this.locationOwnerClaimed) return;
    if (!this.locationOwnerClaim) {
      this.locationOwnerClaim = this.PublishOwnedLocations()
        .then(() => undefined)
        .finally(() => {
          this.locationOwnerClaim = undefined;
        });
    }
    await this.locationOwnerClaim;
  }

  private async PublishOwnedLocations() {
    const recovered = await this.location.RecoverOwner({
      ownerName: this.owner.self.name,
      ownerGeneration: this.ownerGeneration,
      locations: this.players.GetAll().map((player) => ({
        unitId: player.UnitId,
        account: player.Account,
        characterId: player.CharacterId,
        gateName: player.GetComponent(UnitGateComponent).gateName,
        mapHostName: this.owner.self.name,
        mapId: player.MapId,
        mapInstanceId: player.MapInstanceId,
        actorInstanceId: player.InstanceId,
      })),
    });
    this.locationOwnerClaimed = true;
    if (recovered.ownerReplaced) {
      this.owner.logger.warn("MapHost location ownership replaced stale generation", {
        ownerGeneration: this.ownerGeneration.toString(),
        removedStale: recovered.removedStale,
      });
    }
    return recovered;
  }

  /**
   * 把实际已创建的地图实例幂等注册到Location；Location重启后也由该重报恢复。
   * 配置副本中的knownScenes不再复制静态地图归属。
   *
   * Idempotently publishes maps actually created by this host and recovers the
   * directory after a Location restart. Route copies in knownScenes do not
   * duplicate static-map ownership.
   */
  protected async RecoverHostedMapInstances(): Promise<void> {
    for (const map of this.maps.values()) {
      if (this.disposingMaps.has(map.MapInstanceId)) continue;
      try {
        await this.location.RegisterMapInstance({
          instance: {
            mapInstanceId: map.MapInstanceId,
            mapConfigId: map.MapId,
            mapHostName: this.owner.self.name,
            dynamic: map.IsDynamic,
            mapHost: this.EndpointSnapshot(),
          },
        });
      } catch (error) {
        this.owner.logger.warn("map instance route recovery failed", {
          mapId: map.MapId,
          mapInstanceId: map.MapInstanceId.toString(),
          error,
        });
      }
    }
  }

  /**
   * 按MapManager预分配的实例号创建动态地图。同一requestId或MapInstanceId的重试必须保持定义一致；
   * Location响应不确定时保留本地实例，下一次重试继续注册而不会创建第二张地图。
   *
   * Creates a dynamic map with the ID assigned by MapManager. Retries by request
   * or instance ID must keep the same definition. An uncertain Location response
   * keeps the local instance so the next retry registers it instead of duplicating it.
   */
  async CreateAssignedDynamicMap(
    request: MM2M_CreateAssignedDynamicMap,
  ): Promise<M2MM_CreateAssignedDynamicMap> {
    const requestId = request.requestId.trim();
    if (!requestId) {
      throw new RpcError(GameErrCode.DynamicMapRequestRequired, "dynamic map requestId is required");
    }
    const assignedInstanceId = this.dynamicRequestIds.get(requestId);
    if (assignedInstanceId !== undefined && assignedInstanceId !== request.mapInstanceId) {
      throw new RpcError(
        GameErrCode.DynamicMapRequestConflict,
        `dynamic map requestId already uses another instance: ${requestId}`,
      );
    }
    const existingAssignment = this.dynamicAssignments.get(request.mapInstanceId);
    if (
      existingAssignment &&
      (existingAssignment.requestId !== requestId ||
        existingAssignment.mapConfigId !== request.mapConfigId)
    ) {
      throw new RpcError(
        GameErrCode.DynamicMapRequestConflict,
        `dynamic map instance assignment conflicts: ${request.mapInstanceId}`,
      );
    }

    this.CreateMap({
      mapConfigId: request.mapConfigId,
      mapInstanceId: request.mapInstanceId,
      dynamic: true,
    });
    const assignment: DynamicMapAssignmentSnapshot = existingAssignment ?? {
      requestId,
      mapConfigId: request.mapConfigId,
      mapInstanceId: request.mapInstanceId,
    };
    this.dynamicAssignments.set(request.mapInstanceId, assignment);
    this.dynamicRequestIds.set(requestId, request.mapInstanceId);

    const registered = await this.location.RegisterMapInstance({
      instance: {
        mapInstanceId: request.mapInstanceId,
        mapConfigId: request.mapConfigId,
        mapHostName: this.owner.self.name,
        dynamic: true,
        mapHost: this.EndpointSnapshot(),
      },
    });
    return {
      rpcId: request.rpcId,
      error: 0,
      message: "",
      instance: registered.instance,
    };
  }

  /** 返回供MapManager恢复幂等状态的只读副本。 / Returns copies of assignments used by MapManager to recover idempotency state. */
  DynamicAssignments(): DynamicMapAssignmentSnapshot[] {
    return [...this.dynamicAssignments.values()].map((assignment) => ({ ...assignment }));
  }

  /**
   * 安装动态地图销毁通知出口；MapHostRegistration负责可靠投递到MapManager。
   * MapHost本身不持有通知重试状态，避免把服务发现逻辑混进地图生命周期。
   *
   * Installs the dynamic-map disposal notification sink. MapHostRegistration
   * owns reliable delivery to MapManager; MapHost does not retain retry state,
   * keeping service-discovery concerns out of map lifecycle code.
   */
  SetDynamicMapDisposedNotifier(notifier: DynamicMapDisposedNotifier): void {
    if (this.dynamicMapDisposedNotifier && this.dynamicMapDisposedNotifier !== notifier) {
      throw new Error("dynamic map disposed notifier is already installed");
    }
    this.dynamicMapDisposedNotifier = notifier;
  }

  /** 汇总低频调度负载，不暴露玩家或地图内部状态。 / Summarizes low-frequency placement load without exposing map internals. */
  LoadSnapshot(): { staticMapCount: number; dynamicMapCount: number; playerCount: number } {
    let staticMapCount = 0;
    let dynamicMapCount = 0;
    let playerCount = 0;
    for (const map of this.maps.values()) {
      if (map.IsDynamic) dynamicMapCount += 1;
      else staticMapCount += 1;
      playerCount += map.PlayerCount;
    }
    return { staticMapCount, dynamicMapCount, playerCount };
  }

  /** 返回可由Manager和Location传播的本MapHost内网地址。 / Returns this MapHost's inner endpoint for Manager and Location routing. */
  EndpointSnapshot(): MapHostEndpoint {
    return MapHostEndpointFromScene(this.owner.self);
  }

  /** 静态和动态地图共享唯一创建入口；同一实例的幂等重试必须保持定义一致。 / Static and dynamic maps share one creation path; retries for an existing ID must use the same definition. */
  CreateMap(definition: MapInstanceDefinition): MapComponent {
    const existing = this.maps.get(definition.mapInstanceId);
    if (existing) {
      if (existing.MapId !== definition.mapConfigId || existing.IsDynamic !== definition.dynamic) {
        throw new Error(`map instance definition conflicts: ${definition.mapInstanceId}`);
      }
      return existing;
    }
    if (!GameConfigs.MapConfig.TryGet(definition.mapConfigId)) {
      throw new RpcError(
        GameErrCode.MapNotFound,
        `map config not found: ${definition.mapConfigId}`,
      );
    }

    const localSceneId = `map:${definition.mapInstanceId}`;
    const scene = this.owner.SpawnChildScene(localSceneId, MapScene);
    try {
      scene.AddComponent(UnitComponent);
      const aoi = scene.AddComponent(MapAoiComponent, definition);
      const map = scene.AddComponent(
        MapComponent,
        definition,
        this.owner.scenes,
        this.players,
        this.repository,
        this,
        this.location,
        this,
        aoi,
      );
      const npc = scene.AddComponent(NpcComponent, map, aoi);
      scene.AddComponent(NpcShopComponent, npc);
      scene.AddComponent(PlayerTradeComponent);
      scene.AddComponent(MonsterComponent, map, aoi);
      scene.AddComponent(SkillMapComponent, map);
      this.maps.set(definition.mapInstanceId, map);
      return map;
    } catch (error) {
      this.owner.DespawnChildScene(localSceneId);
      throw error;
    }
  }

  /**
   * 统一销毁空地图的完整Scene/Component树；动态地图本地销毁成功后排队通知MapManager。
   * 静态地图不会进入动态分配表，因此不会发送销毁通知。
   *
   * Disposes an empty map Scene and Component tree through the common lifecycle.
   * A dynamic map queues a MapManager notification only after local disposal
   * succeeds. Static maps are not in the dynamic assignment table and send none.
   */
  async DisposeMap(mapInstanceId: bigint): Promise<boolean> {
    const map = this.maps.get(mapInstanceId);
    if (!map) return false;
    if (!map.IsDynamic) {
      throw new RpcError(GameErrCode.StaticMapCannotDispose, "static map cannot be disposed");
    }
    if (map.PlayerCount > 0) {
      throw new Error(
        `map ${mapInstanceId} still has ${map.PlayerCount} player(s); business must transfer them first`,
      );
    }
    // 动态地图也可能仍有怪物；先按Map/AOI生命周期清理，再让ProcessHost销毁Scene。
    // A dynamic map may still contain monsters; clear it through the Map/AOI lifecycle first.
    map.PrepareForDespawn("map-disposed");
    const assignment = map.IsDynamic ? this.dynamicAssignments.get(mapInstanceId) : undefined;
    const disposed = this.owner.DespawnChildScene(`map:${mapInstanceId}`);
    if (!disposed) return false;
    this.maps.delete(mapInstanceId);
    if (assignment) {
      this.dynamicAssignments.delete(mapInstanceId);
      this.dynamicRequestIds.delete(assignment.requestId);
    }
    this.disposingMaps.delete(mapInstanceId);
    if (assignment) this.dynamicMapDisposedNotifier?.({ ...assignment });
    return true;
  }

  /** 在异步删除Location路由前阻止周期重报；失败时调用CancelMapDisposal恢复。 / Prevents periodic route recovery before asynchronous route removal; call CancelMapDisposal on failure. */
  BeginMapDisposal(mapInstanceId: bigint): void {
    const map = this.requireMap(mapInstanceId);
    if (!map.IsDynamic) {
      throw new RpcError(GameErrCode.StaticMapCannotDispose, "static map cannot be disposed");
    }
    if (map.PlayerCount > 0) {
      throw new RpcError(
        GameErrCode.DynamicMapNotEmpty,
        `dynamic map ${mapInstanceId} still has players`,
      );
    }
    this.disposingMaps.add(mapInstanceId);
  }

  /** 取消尚未提交的地图销毁，使路由恢复任务可以再次发布实例。 / Cancels an uncommitted map disposal so route recovery may publish it again. */
  CancelMapDisposal(mapInstanceId: bigint): void {
    this.disposingMaps.delete(mapInstanceId);
  }

  /** 返回本MapHost已托管的地图，不会隐式创建。 / Returns a hosted map without implicitly creating it. */
  GetMap(mapInstanceId: bigint): MapComponent | undefined {
    return this.maps.get(mapInstanceId);
  }

  private requireMap(mapInstanceId: bigint): MapComponent {
    const map = this.maps.get(mapInstanceId);
    if (!map) {
      throw new RpcError(GameErrCode.MapNotFound, `map instance is not hosted here: ${mapInstanceId}`);
    }
    return map;
  }

  private mapOf(unit: PlayerUnit): MapComponent {
    const map = unit.DomainScene<MapScene>().GetComponent(MapComponent);
    if (map !== this.maps.get(unit.MapInstanceId)) {
      throw new Error(
        `unit ${unit.UnitId}@${unit.InstanceId} has invalid map instance ${unit.MapInstanceId}`,
      );
    }
    return map;
  }

  private get players(): PlayerDirectoryComponent {
    return this.owner.GetComponent(PlayerDirectoryComponent);
  }

  private get owner(): EntryScene {
    return this.GetParent<EntryScene>();
  }

  private validateEnterMap(request: G2M_EnterMap): void {
    if (!request.account) {
      throw new RpcError(GameErrCode.AccountRequired, "account is required");
    }
    if (!request.token) {
      throw new RpcError(GameErrCode.TokenRequired, "token is required");
    }
    if (!request.gateName || request.characterId <= 0n) {
      throw new RpcError(
        GameErrCode.GateSessionRequired,
        "gate binding and character identity are required",
      );
    }
  }

  private ValidateTransferSnapshot(snapshot: PlayerTransferSnapshot): void {
    if (snapshot.schemaVersion !== PLAYER_TRANSFER_SCHEMA_VERSION) {
      throw new Error(`unsupported player transfer schema: ${snapshot.schemaVersion}`);
    }
    if (!snapshot.transferId || !snapshot.account || !snapshot.gateName || snapshot.characterId <= 0n) {
      throw new Error("incomplete player transfer identity");
    }
    if (snapshot.starterDungeon.cooldownEndAtMs < 0n) {
      throw new Error("invalid Starter dungeon cooldown in transfer snapshot");
    }
    if (!GameConfigs.MapConfig.TryGet(snapshot.targetMapId)) {
      throw new RpcError(
        GameErrCode.MapNotFound,
        `map config not found: ${snapshot.targetMapId}`,
      );
    }
  }

  protected override OnDestroy(): void {
    this.incomingTransfers.Dispose();
  }
}

function toProtocolSkillTransfer(value: SkillTransferState): SkillTransferSnapshot {
  return {
    globalCooldownEndAtMs: BigInt(Math.max(0, Math.floor(value.globalCooldownEndAtMs))),
    cooldowns: value.cooldowns.map((cooldown) => ({
      skillId: cooldown.skillId,
      cooldownEndAtMs: BigInt(Math.max(0, Math.floor(cooldown.cooldownEndAtMs))),
    })),
    itemCooldowns: value.itemCooldowns.map((cooldown) => ({
      itemConfigId: cooldown.itemConfigId,
      cooldownEndAtMs: BigInt(Math.max(0, Math.floor(cooldown.cooldownEndAtMs))),
    })),
  };
}

function toProtocolQuest(value: import("../quest/Quest").QuestState): import("../../../generated/model/server/demo/protocol/messages").QuestSnapshot {
  return {
    questConfigId: value.questConfigId,
    objectives: value.objectives.map((item) => ({ ...item })),
    revision: value.revision,
    status: value.status,
    readyToComplete: value.status === QuestStatus.ReadyToTurnIn,
  };
}

interface PreparedIncomingPlayer {
  readonly map: MapComponent;
  readonly player: PlayerUnit;
}

export type DynamicMapDisposedNotifier = (
  assignment: DynamicMapAssignmentSnapshot,
) => void;

function toProtocolBuffTransfer(
  value: import("../buff/Buff").BuffTransferState,
): BuffTransferSnapshot {
  return {
    buffInstanceId: value.buffInstanceId,
    buffConfigId: value.configId,
    stacks: value.stacks,
    appliedAtMs: BigInt(Math.max(0, Math.floor(value.appliedAtMs))),
    expireTimeMs: BigInt(Math.max(0, Math.floor(value.expireAtMs))),
    tickIntervalMs: value.tickIntervalMs,
    nextTickAtMs: BigInt(Math.max(0, Math.floor(value.nextTickAtMs))),
    revision: value.revision,
    sourceUnitId: value.sourceUnitId,
    sourceAbilityId: value.sourceAbilityId,
    conflictPriority: value.conflictPriority,
    damageAbsorberRemaining: value.damageAbsorberRemaining,
    addActionType: value.addAction?.type ?? 0,
    addActionParams: value.addAction?.parameters ?? [],
    tickActionType: value.tickAction?.type ?? 0,
    tickActionParams: value.tickAction?.parameters ?? [],
    removeActionType: value.removeAction?.type ?? 0,
    removeActionParams: value.removeAction?.parameters ?? [],
  };
}
