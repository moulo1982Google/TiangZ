import {
  BroadcastHub,
  ClientBroadcast,
  ClientAudience,
  StateReplicationSystem,
  type BroadcastAudience,
  type EncodedAudienceBatch,
  type EncodedRouteFrame,
  Component,
  type CustomMetricSnapshot,
  type IFrameFlush,
  type Logger,
  type SceneMessageHelper,
  Game,
  TimeSystem,
  UnitComponent,
  component,
  type EntityTransferSnapshot,
  type ComponentCtor,
} from "../../../core/public";
import { ClientBroadcasts } from "../../../generated/model/server/demo/protocol/broadcastDescriptors";
import { GateMessages } from "../../../generated/model/server/demo/protocol/messageDescriptors";
import type {
  G2M_EnterMap,
  G2M_PlayerOffline,
  G2M_SecondEnterMap,
  G2M_TransferPlayer,
  ItemSnapshot,
  KickPlayerTarget,
  MapEntitySnapshot,
  M2G_PlayerOffline,
  M2G_SecondEnterMap,
  M2G_TransferPlayer,
  PlayerTransferSnapshot,
} from "../../../generated/model/server/demo/protocol/messages";
import { SceneBroadcastTransport } from "../broadcast/SceneBroadcastTransport";
import { MapClientRouteResolver } from "../broadcast/MapClientRouteResolver";
import type { PlayerDirectoryComponent } from "../mapHost/PlayerDirectoryComponent";
import { PlayerUnit, type PlayerSnapshot } from "./PlayerUnit";
import { MapScene } from "./MapScene";
import { PositionComponent } from "./PositionComponent";
import { UnitGateComponent } from "./UnitGateComponent";
import { NativeUnitRef } from "../../../generated/model/native/NativeUnitRef";
import { NativeData, type NativeAoiBatch } from "../native/NativeData";
import { NumericComponent } from "../numeric/NumericComponent";
import { ItemComponent } from "../item/ItemComponent";
import { PlayerPersistenceComponent } from "../persistence/PlayerPersistenceComponent";
import { LocationProxy } from "../location/LocationProxy";
import type { PlayerRepository } from "../persistence/PlayerRepository";
import {
  GameConfigs,
  SpatialMode,
  type MapConfig as MapConfigData,
} from "../../../generated/model/config";
import type { MapInstanceDefinition } from "./MapInstance";
import { MapAoiComponent, type AoiVisibilityDelta } from "./MapAoiComponent";

const DEMO_PLAYER_CONFIG_ID = 1;
const monotonicNow = (): number => globalThis.performance?.now() ?? Date.now();

interface PendingPlayerEntry {
  readonly unit: PlayerUnit;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface EncodedRouteBroadcast {
  readonly frames: readonly EncodedRouteFrame[];
  readonly itemCount: number;
}

export interface PlayerTransferCoordinator {
  TransferPlayer(source: PlayerUnit, request: G2M_TransferPlayer): Promise<M2G_TransferPlayer>;
}

export interface MapLifecycleCoordinator {
  DisposeMap(mapInstanceId: bigint): boolean;
}

@component()
export class MapComponent extends Component<[
  definition: MapInstanceDefinition,
  scenes: SceneMessageHelper,
  players: PlayerDirectoryComponent,
  repository: PlayerRepository,
  transferCoordinator: PlayerTransferCoordinator,
  location: LocationProxy,
  lifecycle: MapLifecycleCoordinator,
  aoi: MapAoiComponent,
]> implements IFrameFlush {
  private mapId = 0;
  private mapInstanceId = 0n;
  private nativeMapKey = 0;
  private dynamic = false;
  private players!: PlayerDirectoryComponent;
  private serverTick = 0;
  private broadcast!: BroadcastHub;
  private clientBroadcast!: ClientBroadcast;
  private replication!: StateReplicationSystem;
  private repository!: PlayerRepository;
  private scenes!: SceneMessageHelper;
  private logger!: Logger;
  private config!: MapConfigData;
  private transferCoordinator!: PlayerTransferCoordinator;
  private location!: LocationProxy;
  private nextLocationOperation = 1;
  private lifecycle!: MapLifecycleCoordinator;
  private aoi!: MapAoiComponent;
  private spatialBarrier: Promise<void> | undefined;
  private readonly pendingPlayerEnterChanges: AoiVisibilityDelta[] = [];
  private readonly pendingSpatialChanges = new Map<string, {
    before: boolean;
    change: AoiVisibilityDelta;
  }>();
  private pendingSpatialMovement: EncodedRouteBroadcast | undefined;
  private readonly pendingPlayerEntries: PendingPlayerEntry[] = [];
  private readonly gateRouteIds = new Map<string, number>();
  private readonly gateNamesByRouteId = new Map<number, string>();
  private nextGateRouteId = 1;
  private playerEntryQueuePeak = 0;
  private playerEntriesAdmitted = 0;
  private playerEntryFailures = 0;
  private readonly pipelineMetrics = {
    movementAdvanceMs: 0,
    aoiRefreshMs: 0,
    movementEncodeMs: 0,
    audienceMapMs: 0,
    numericPeekMs: 0,
    statePeekMs: 0,
    updateCount: 0,
    audienceMapCount: 0,
    numericPeekCount: 0,
    statePeekCount: 0,
  };

  get MapId(): number {
    return this.mapId;
  }

  get MapInstanceId(): bigint {
    return this.mapInstanceId;
  }

  get IsDynamic(): boolean {
    return this.dynamic;
  }

  get PlayerCount(): number {
    return this.units.Count;
  }

  /** 业务广播唯一入口：只接受逻辑ClientAudience，不暴露Gate与内网路由。 / Sole business broadcast entrypoint accepting logical audiences without exposing Gate routes. */
  get Broadcast(): ClientBroadcast {
    return this.clientBroadcast;
  }

  /** 返回本地图AOI受众工厂；业务使用ObserversOf/VisibleSubjectsOf区分关系方向。 / Returns the map AOI audience factory with explicit observer/subject direction. */
  get Audience(): MapAoiComponent {
    return this.aoi;
  }

  /** 创建地图内 Unit 存储、广播传输和帧尾同步源。 / Creates map-local Unit storage, broadcast transport, and frame-end replication sources. */
  protected override Awake(
    definition: MapInstanceDefinition,
    scenes: SceneMessageHelper,
    players: PlayerDirectoryComponent,
    repository: PlayerRepository,
    transferCoordinator: PlayerTransferCoordinator,
    location: LocationProxy,
    lifecycle: MapLifecycleCoordinator,
    aoi: MapAoiComponent,
  ): void {
    this.mapId = definition.mapConfigId;
    this.mapInstanceId = definition.mapInstanceId;
    this.dynamic = definition.dynamic;
    this.nativeMapKey = this.DomainScene().InstanceId;
    this.config = GameConfigs.MapConfig.Get(this.mapId);
    if (this.config.spatialMode !== SpatialMode.Grid2D) {
      throw new Error(
        `map ${this.mapId} uses NavMesh3D, but the Phase 4 navigation runtime is not installed`,
      );
    }
    this.players = players;
    this.repository = repository;
    this.transferCoordinator = transferCoordinator;
    this.location = location;
    this.lifecycle = lifecycle;
    this.aoi = aoi;
    this.scenes = scenes;
    this.logger = this.DomainScene<MapScene>().logger.child({
      mapId: this.mapId,
      mapInstanceId: this.mapInstanceId.toString(),
    });
    this.broadcast = new BroadcastHub(new SceneBroadcastTransport(scenes), {
      onError: (name, error) => {
        this.logger.error("map broadcast failed", { broadcast: name, error });
      },
    });
    const clientRoutes = new MapClientRouteResolver(
      (unitId) => this.units.Get<PlayerUnit>(unitId)
        ?.GetComponent(UnitGateComponent).gateName,
      location,
    );
    this.clientBroadcast = new ClientBroadcast(this.broadcast, clientRoutes);
    this.replication = new StateReplicationSystem(
      this.broadcast,
      () => ({ key: `map:${this.mapInstanceId}:aoi`, routes: [] }),
      (sourceName, error) => {
        this.logger.error("map state replication failed", { sourceName, error });
      },
      () => this.spatialBarrier,
    );
    this.RegisterReplicationSources();
  }

  /**
   * 请求MapHost销毁本地图实例；只处理对象生命周期，不踢人、不保存、不选择回退地图。
   * 业务必须先处置仍在地图中的玩家，强制销毁会留下可观测警告。
   *
   * Requests MapHost disposal of this instance. It owns object lifecycle only,
   * never kicking, saving, or selecting fallback maps. Business code must deal
   * with resident players before disposal.
   */
  Dispose(): boolean {
    return this.lifecycle.DisposeMap(this.mapInstanceId);
  }

  /** 把Unit Handler的迁移请求交给MapHost协调器，保持Handler只做一层业务胶水。 / Delegates a Unit Handler migration request to the MapHost coordinator while keeping the Handler as one layer of glue. */
  TransferPlayer(unit: PlayerUnit, request: G2M_TransferPlayer): Promise<M2G_TransferPlayer> {
    this.requirePlayer(unit);
    return this.transferCoordinator.TransferPlayer(unit, request);
  }

  /**
   * 业务统一地图传送入口，只接收目标MapInstanceId；同V8、跨V8和跨Process由框架路由决定。
   * 调用者不应查询MapHost或拼装位置revision。
   *
   * Unified business transfer API accepting only a target MapInstanceId.
   * Runtime routing chooses local or remote execution; callers must not resolve
   * MapHosts or assemble location revisions themselves.
   */
  async TransferToMap(unit: PlayerUnit, targetMapInstanceId: bigint): Promise<M2G_TransferPlayer> {
    this.requirePlayer(unit);
    const located = await this.location.Resolve({ unitId: unit.UnitId, account: unit.Account });
    if (!located.found || located.location.actorInstanceId !== unit.InstanceId) {
      throw new Error(`cannot transfer non-authoritative unit ${unit.UnitId}@${unit.InstanceId}`);
    }
    return this.transferCoordinator.TransferPlayer(unit, {
      account: unit.Account,
      gateName: unit.GetComponent(UnitGateComponent).gateName,
      targetMapInstanceId,
      expectedLocationRevision: located.location.revision,
    });
  }

  /** 每次固定逻辑帧推进一次 Rust 权威 Cell 移动。 / Advances Rust-authoritative cell movement once per fixed game update. */
  Update(): void {
    this.PumpPlayerEntries();
    if (this.units.Count === 0) return;
    const fixedDeltaMs = TimeSystem.Instance.FixedDeltaTime;
    this.serverTick += 1;
    const moveDescriptor = ClientBroadcasts.EntityMove;
    let startedAt = monotonicNow();
    NativeData.AdvanceMapMovement(
      this.nativeMapKey,
      this.serverTick,
      fixedDeltaMs,
    );
    this.pipelineMetrics.movementAdvanceMs += monotonicNow() - startedAt;
    startedAt = monotonicNow();
    const visibility = this.pendingPlayerEnterChanges.splice(
      0,
      this.pendingPlayerEnterChanges.length,
    );
    visibility.push(...this.aoi.Refresh());
    this.pipelineMetrics.aoiRefreshMs += monotonicNow() - startedAt;
    startedAt = monotonicNow();
    const movement = NativeData.TakeMapMovementAoiRouteFrames(
      this.nativeMapKey,
      this.serverTick,
      moveDescriptor.message.msgcode,
      GateMessages.ClientBroadcastBatch.msgcode,
    );
    this.pipelineMetrics.movementEncodeMs += monotonicNow() - startedAt;
    this.pipelineMetrics.updateCount += 1;
    const routeBroadcast = this.ToRouteBroadcast(movement);
    if (visibility.length > 0 || this.spatialBarrier) {
      this.QueueSpatialAndMovement(visibility, routeBroadcast);
    } else if (routeBroadcast.frames.length > 0) {
      void this.broadcast.PublishEncodedLatestRouteFrames(
        `map:${this.mapInstanceId}:aoi`,
        moveDescriptor.name,
        routeBroadcast.frames,
        routeBroadcast.itemCount,
      ).catch((error) => {
        this.logger.error("map AOI movement publish failed", { error });
      });
    }
  }

  /** 所有游戏逻辑更新完成后，发布脏 Numeric 与 Unit 固定字段状态。 / Publishes dirty Numeric and fixed Unit state after all gameplay updates completed. */
  FrameFlush(): void {
    if (this.units.Count > 0) this.replication.FrameFlush();
  }

  /**
   * 以一次工厂操作组合 PlayerUnit 及其全部必需组件。
   * 玩家能力应在这里添加，而不是散落在 Handler 中，确保创建与重连得到相同 Entity 形状。
   *
   * Composes one PlayerUnit and every required Component as one factory action.
   * Add player capabilities here rather than inside handlers, so creation and
   * reconnect paths always produce the same Entity shape.
   */
  CreatePlayer(
    unitId: number,
    request: G2M_EnterMap,
    transfer?: EntityTransferSnapshot,
  ): PlayerUnit {
    const player = this.ComposePlayer(unitId, request, transfer);
    try {
      this.players.Add(player);
      return player;
    } catch (error) {
      this.units.Remove(unitId);
      throw error;
    }
  }

  /** 创建完整但尚未写入进程目录的迁移目标；调用方必须随后提交或丢弃。 / Creates a complete transfer target that is not yet published in the process directory; callers must commit or discard it next. */
  PrepareTransferredPlayer(
    unitId: number,
    request: G2M_EnterMap,
    transfer: EntityTransferSnapshot,
  ): PlayerUnit {
    return this.ComposePlayer(unitId, request, transfer);
  }

  /** 把可序列化跨进程快照恢复为目标地图候选Unit，不发布进程目录。 / Restores a portable cross-process snapshot into a target-map candidate without publishing the process directory. */
  PrepareRemoteTransferredPlayer(snapshot: PlayerTransferSnapshot): PlayerUnit {
    const transfer: EntityTransferSnapshot = {
      components: new Map<ComponentCtor, unknown>([
        [PositionComponent, {
          speedCellsPerSecond: snapshot.speedCellsPerSecond,
          facing: snapshot.facing,
          alive: snapshot.alive,
        }],
        [NumericComponent, snapshot.numerics],
        [ItemComponent, snapshot.items],
      ]),
    };
    return this.PrepareTransferredPlayer(
      snapshot.unitId,
      {
        account: snapshot.account,
        token: "cross-process-transfer",
        gateName: snapshot.gateName,
        mapInstanceId: snapshot.targetMapInstanceId,
        hasInitialSpawnOverride: false,
        initialSpawnX: 0,
        initialSpawnY: 0,
        initialSpawnZ: 0,
        initialSpawnYaw: 0,
      },
      transfer,
    );
  }

  /** 销毁提交前失败的候选Unit；不得用于已经发布到目录的玩家。 / Disposes a candidate Unit after a pre-commit failure; never use it for a player already published in the directory. */
  DiscardPreparedPlayer(unit: PlayerUnit): void {
    this.requirePlayer(unit);
    if (this.players.Get(unit.Account) === unit) {
      throw new Error(`cannot discard published player: ${unit.Account}`);
    }
    this.units.Remove(unit.UnitId);
  }

  /** 在目录提交后销毁源地图Unit；目录的InstanceId校验会保留新目标。 / Disposes the source-map Unit after directory commit; the directory InstanceId guard preserves the new target. */
  RemoveTransferredPlayer(unit: PlayerUnit): readonly AoiVisibilityDelta[] {
    this.requirePlayer(unit);
    return this.RemovePlayer(unit);
  }

  /** 广播已提交迁移的 AOI 离开关系；失败不撤销已经完成的数据所有权切换。 / Broadcasts committed AOI leave relations without reversing completed ownership on failure. */
  async PlayerLeft(changes: readonly AoiVisibilityDelta[]): Promise<void> {
    await this.PublishAoiChanges(changes);
  }

  private ComposePlayer(
    unitId: number,
    request: G2M_EnterMap,
    transfer?: EntityTransferSnapshot,
  ): PlayerUnit {
    const playerConfig = GameConfigs.PlayerConfig.Get(DEMO_PLAYER_CONFIG_ID);
    const player = this.units.Create(unitId, PlayerUnit, {
      account: request.account,
      mapId: this.mapId,
      mapInstanceId: this.mapInstanceId,
    });

    try {
      const native = player.AddComponent(NativeUnitRef, {
        id: unitId,
        instanceId: player.InstanceId,
        mapId: this.nativeMapKey,
        x: 0,
        y: 0,
      });
      const position = player.AddComponent(
        PositionComponent,
        native,
        this.config.widthCells,
        this.config.depthCells,
        this.config.cellSizeMeters,
      );
      position.SetGridWorldPosition(
        request.hasInitialSpawnOverride ? request.initialSpawnX : this.config.spawnX,
        request.hasInitialSpawnOverride ? request.initialSpawnY : this.config.spawnY,
        request.hasInitialSpawnOverride ? request.initialSpawnZ : this.config.spawnZ,
        request.hasInitialSpawnOverride ? request.initialSpawnYaw : this.config.spawnYaw,
      );
      position.SpeedCellsPerSecond = playerConfig.moveSpeed;
      player.AddComponent(NumericComponent);
      player.AddComponent(ItemComponent);
      player.AddComponent(PlayerPersistenceComponent, this.repository);
      player.AddComponent(UnitGateComponent, request.gateName);
      if (transfer) player.RestoreTransfer(transfer);
      return player;
    } catch (error) {
      this.units.Remove(unitId);
      throw error;
    }
  }

  /** 构造进入视野所需的全量快照；常规变化应使用脏数据增量同步。 / Builds a full enter-view snapshot; routine changes use dirty replication instead. */
  EntitySnapshots(observer: PlayerUnit): MapEntitySnapshot[] {
    this.requirePlayer(observer);
    return this.aoi
      .VisibleUnitIds(observer.UnitId)
      .map((unitId) => this.units.Get<PlayerUnit>(unitId))
      .filter((unit): unit is PlayerUnit => unit !== undefined)
      .map((unit) => toMapEntity(unit.Snapshot()));
  }

  /**
   * 新玩家完整组件图准备好后加入 AOI，并把对既有玩家的 Enter 通知留到下一逻辑帧合并。
   * 新玩家自己的初始视图由 EnterMap 响应提供，因此登录 RPC 不应等待下行广播。
   *
   * Attaches a fully composed player and defers notifications to existing players
   * until the next fixed tick. EnterMap already carries the new player's initial view,
   * so the login RPC must not wait for fan-out delivery.
   */
  PlayerEntered(unit: PlayerUnit): Promise<void> {
    this.requirePlayer(unit);
    if (this.pendingPlayerEntries.length >= this.config.entryQueueCapacity) {
      return Promise.reject(
        new Error(`map ${this.mapInstanceId} player-entry queue is full`),
      );
    }
    const promise = new Promise<void>((resolve, reject) => {
      this.pendingPlayerEntries.push({ unit, resolve, reject });
    });
    this.playerEntryQueuePeak = Math.max(
      this.playerEntryQueuePeak,
      this.pendingPlayerEntries.length,
    );
    return promise;
  }

  /** 立即发送不可逆背包事件；这里禁止使用 latest 合并。 / Sends an irreversible inventory event immediately; latest coalescing is forbidden here. */
  async PublishItemChanged(unit: PlayerUnit, item: ItemSnapshot): Promise<void> {
    this.requirePlayer(unit);
    await this.clientBroadcast.Publish(
      ClientAudience.Self(unit.UnitId),
      ClientBroadcasts.ItemChanged,
      { item },
      this.serverTick,
    );
  }

  /** 将广播计数投影为进程自定义指标格式。 / Projects broadcast counters into the process custom-metrics format. */
  BroadcastMetricSnapshot(): CustomMetricSnapshot {
    const metrics = this.broadcast.Snapshot();
    return {
      name: "map_broadcast",
      values: {
        map_id: this.mapId,
        in_flight: metrics.inFlight,
        in_flight_units: metrics.inFlightItems,
        pending_units: metrics.pendingItems,
        max_pending_units: metrics.maxPendingItems,
        max_in_flight_units: metrics.maxInFlightItems,
        queued_frames_total: metrics.queuedItems,
        coalesced_frames_total: metrics.coalescedItems,
        sent_frames_total: metrics.sentItems,
        broadcasts_started_total: metrics.broadcastsStarted,
        broadcasts_completed_total: metrics.broadcastsCompleted,
        broadcast_failures_total: metrics.broadcastFailures,
        last_duration_ms: metrics.lastDurationMs,
        max_duration_ms: metrics.maxDurationMs,
        total_duration_ms: metrics.totalDurationMs,
        last_queue_wait_ms: metrics.lastQueueWaitMs,
        max_queue_wait_ms: metrics.maxQueueWaitMs,
        total_queue_wait_ms: metrics.totalQueueWaitMs,
        last_dispatch_ms: metrics.lastDispatchMs,
        max_dispatch_ms: metrics.maxDispatchMs,
        total_dispatch_ms: metrics.totalDispatchMs,
        movement_advance_ms_total: this.pipelineMetrics.movementAdvanceMs,
        aoi_refresh_ms_total: this.pipelineMetrics.aoiRefreshMs,
        movement_encode_ms_total: this.pipelineMetrics.movementEncodeMs,
        audience_map_ms_total: this.pipelineMetrics.audienceMapMs,
        numeric_peek_ms_total: this.pipelineMetrics.numericPeekMs,
        state_peek_ms_total: this.pipelineMetrics.statePeekMs,
        update_count_total: this.pipelineMetrics.updateCount,
        audience_map_count_total: this.pipelineMetrics.audienceMapCount,
        numeric_peek_count_total: this.pipelineMetrics.numericPeekCount,
        state_peek_count_total: this.pipelineMetrics.statePeekCount,
        player_entry_queue: this.pendingPlayerEntries.length,
        player_entry_queue_peak: this.playerEntryQueuePeak,
        player_entries_admitted_total: this.playerEntriesAdmitted,
        player_entry_failures_total: this.playerEntryFailures,
      },
      kinds: {
        queued_frames_total: "counter",
        coalesced_frames_total: "counter",
        sent_frames_total: "counter",
        broadcasts_started_total: "counter",
        broadcasts_completed_total: "counter",
        broadcast_failures_total: "counter",
        total_duration_ms: "counter",
        total_queue_wait_ms: "counter",
        total_dispatch_ms: "counter",
        movement_advance_ms_total: "counter",
        aoi_refresh_ms_total: "counter",
        movement_encode_ms_total: "counter",
        audience_map_ms_total: "counter",
        numeric_peek_ms_total: "counter",
        state_peek_ms_total: "counter",
        update_count_total: "counter",
        audience_map_count_total: "counter",
        numeric_peek_count_total: "counter",
        state_peek_count_total: "counter",
        player_entries_admitted_total: "counter",
        player_entry_failures_total: "counter",
      },
    };
  }

  /**
   * 为断线重连连接生成权威全量视图；不创建Unit、不广播AOI进入，也不改绑Gate。
   * 同时清除旧连接遗留的移动输入，避免玩家在宽限期内持续行走。
   *
   * Builds the authoritative full view for a reconnected client without
   * creating a Unit, broadcasting AOI entry, or rebinding Gate ownership. It
   * also clears movement inherited from the stale connection.
   */
  SecondEnterMap(
    unit: PlayerUnit,
    message: G2M_SecondEnterMap,
  ): M2G_SecondEnterMap {
    this.requirePlayer(unit);
    if (
      unit.UnitId !== message.unitId ||
      unit.Account !== message.account ||
      unit.MapId !== message.mapId ||
      !unit.MatchesGate({ gateName: message.gateName })
    ) {
      throw new Error(`second-enter identity mismatch: ${message.account}#${message.unitId}`);
    }

    const snapshot = unit.SecondEnterMap();
    return {
      rpcId: message.rpcId,
      error: 0,
      message: "",
      account: snapshot.account,
      mapId: snapshot.mapId,
      unitId: snapshot.unitId,
      x: snapshot.x,
      y: snapshot.y,
      z: snapshot.z,
      entities: this.EntitySnapshots(unit),
      fixedUpdateMs: Game.Instance.FixedUpdateMs,
      items: unit.GetComponent(ItemComponent).Snapshot(),
      mapInstanceId: snapshot.mapInstanceId,
    };
  }

  /** Gate确认重连宽限期结束后，持久化并移除玩家，再广播AOI离开。 / Persists and removes a player after Gate confirms reconnect grace expiry, then broadcasts AOI leave. */
  async PlayerOffline(
    unit: PlayerUnit,
    message: G2M_PlayerOffline,
  ): Promise<M2G_PlayerOffline> {
    this.requirePlayer(unit);
    if (
      unit.UnitId !== message.unitId ||
      unit.Account !== message.account ||
      unit.MapId !== message.mapId ||
      !unit.MatchesGate({ gateName: message.gateName })
    ) {
      this.logger.warn("ignored mismatched player offline", {
        account: message.account,
        unitId: message.unitId,
        actorId: unit.InstanceId,
      });
      return {
        rpcId: message.rpcId,
        error: 0,
        message: "",
        unitId: message.unitId,
        removed: false,
      };
    }

    await this.OfflinePlayerAndBroadcast(unit, message.reason || "client-timeout");
    this.logger.info("player left map after Gate timeout", {
      account: message.account,
      unitId: message.unitId,
      reason: message.reason,
    });
    return {
      rpcId: message.rpcId,
      error: 0,
      message: "",
      unitId: message.unitId,
      removed: true,
    };
  }

  /** 持久化成功后移除 Unit，并发布离开通知。 / Removes one Unit and publishes leave after persistence has already succeeded. */
  async RemovePlayerAndBroadcast(unit: PlayerUnit): Promise<void> {
    this.requirePlayer(unit);
    const changes = this.RemovePlayer(unit);
    await this.PlayerLeft(changes);
  }

  /** 停机时保存全部玩家、请求各 Gate 关闭连接，随后移除 Unit。 / Saves all players, asks their Gates to close, then removes Units during shutdown. */
  async KickAllPlayers(reason: string): Promise<void> {
    const players = this.units.GetAll(PlayerUnit);
    if (players.length === 0) return;
    const logger = this.logger;

    const byGate = new Map<string, KickPlayerTarget[]>();
    for (const player of players) {
      const gate = player.GetComponent(UnitGateComponent);
      const targets = byGate.get(gate.gateName) ?? [];
      targets.push({ unitId: player.UnitId });
      byGate.set(gate.gateName, targets);
    }
    for (const [gateName, targets] of byGate) {
      try {
        void this.scenes.send(
          this.scenes.byName(gateName),
          GateMessages.KickPlayers,
          { players: targets, reason },
        ).catch((error) => {
          logger.error("failed to notify gate to kick players", {
            gateName,
            playerCount: targets.length,
            error,
          });
        });
      } catch (error) {
        logger.error("failed to notify gate to kick players", {
          gateName,
          playerCount: targets.length,
          error,
        });
      }
    }

    const results = await Promise.allSettled(
      players.map((player) => this.OfflinePlayerAndBroadcast(player, reason)),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    logger.info("map players stopped", {
      playerCount: players.length,
      saveFailures: failures.length,
      reason,
    });
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `map ${this.mapId} failed to save ${failures.length} player(s)`,
      );
    }
  }

  private async OfflinePlayerAndBroadcast(
    unit: PlayerUnit,
    reason: string,
  ): Promise<void> {
    this.requirePlayer(unit);
    const located = await this.location.Resolve({ unitId: unit.UnitId, account: "" });
    if (!located.found || located.location.actorInstanceId !== unit.InstanceId) {
      throw new Error(`cannot offline non-authoritative unit ${unit.UnitId}@${unit.InstanceId}`);
    }
    const operationId = `offline:${unit.UnitId}:${unit.InstanceId}:${this.nextLocationOperation++}`;
    await this.location.Lock({
      unitId: unit.UnitId,
      expectedRevision: located.location.revision,
      expectedActorInstanceId: unit.InstanceId,
      operationId,
      state: "removing",
    });
    try {
      await unit.Offline(reason);
    } catch (error) {
      await this.location.Unlock({ unitId: unit.UnitId, operationId }).catch(() => undefined);
      throw error;
    }
    const unitId = unit.UnitId;
    await this.location.Remove({ unitId, operationId });
    const changes = this.RemovePlayer(unit);
    await this.PublishAoiChanges(changes);
  }

  private RemovePlayer(unit: PlayerUnit): readonly AoiVisibilityDelta[] {
    const changes = this.aoi.Detach(unit);
    this.players.Remove(unit);
    this.units.Remove(unit.UnitId);
    return changes;
  }

  private RegisterReplicationSources(): void {
    const numeric = ClientBroadcasts.EntityNumeric;
    this.replication.Add({
      name: numeric.name,
      Peek: () => {
        const startedAt = monotonicNow();
        const delta = NativeData.PeekMapNumericAoiDelta(
          this.nativeMapKey,
          this.serverTick,
          numeric.message.msgcode,
        );
        this.pipelineMetrics.numericPeekMs += monotonicNow() - startedAt;
        this.pipelineMetrics.numericPeekCount += 1;
        return {
          itemCount: delta.itemCount,
          batches: this.ToAudienceBatches(delta.batches),
          audienceKey: `map:${this.mapInstanceId}:aoi`,
          Ack: () => NativeData.AckMapNumericDelta(this.nativeMapKey, delta.revision),
        };
      },
    });

    const state = ClientBroadcasts.EntityState;
    this.replication.Add({
      name: state.name,
      Peek: () => {
        const startedAt = monotonicNow();
        const delta = NativeData.PeekMapUnitAoiDelta(
          this.nativeMapKey,
          this.serverTick,
          state.message.msgcode,
        );
        this.pipelineMetrics.statePeekMs += monotonicNow() - startedAt;
        this.pipelineMetrics.statePeekCount += 1;
        return {
          itemCount: delta.itemCount,
          batches: this.ToAudienceBatches(delta.batches),
          audienceKey: `map:${this.mapInstanceId}:aoi`,
          Ack: () => NativeData.AckMapUnitDelta(this.nativeMapKey, delta.revision),
        };
      },
    });
  }

  protected override OnDestroy(): void {
    const error = new Error(`map ${this.mapInstanceId} disposed before player entry`);
    for (const pending of this.pendingPlayerEntries.splice(0)) pending.reject(error);
    this.broadcast.Dispose();
  }

  /**
   * 每个固定 Tick 只提交少量玩家进入 AOI，避免批量登录把 Attach、全量快照和下行扇出
   * 同时压到一个地图线程。这里只启动同步 Attach；异步广播仍由帧尾统一投递。
   *
   * Admits only a small number of players into AOI per fixed tick so login bursts
   * cannot concentrate attach, snapshot, and fan-out work on one map thread. This
   * method performs synchronous attachment only; frame-end delivery remains async.
   */
  private PumpPlayerEntries(): void {
    for (let admitted = 0; admitted < this.config.entryPlayersPerTick; admitted += 1) {
      const pending = this.pendingPlayerEntries.shift();
      if (!pending) return;
      try {
        this.requirePlayer(pending.unit);
        const gateName = pending.unit.GetComponent(UnitGateComponent).gateName;
        this.pendingPlayerEnterChanges.push(
          ...this.aoi.Attach(pending.unit, this.RouteIdForGate(gateName)),
        );
        this.playerEntriesAdmitted += 1;
        pending.resolve();
      } catch (error) {
        this.playerEntryFailures += 1;
        pending.reject(error);
      }
    }
  }

  /** 把 Rust 接收者 ID 外壳映射为 Gate 路由；protobuf frame 仍保持零解码。 / Maps Rust recipient ids to Gate routes while keeping protobuf frames undecoded. */
  private ToAudienceBatches(
    batches: readonly NativeAoiBatch[],
  ): readonly EncodedAudienceBatch[] {
    const startedAt = monotonicNow();
    const result = batches
      .map((batch, index) => ({
        audience: this.AudienceForRecipients(
          batch.recipientIds,
          `map:${this.mapInstanceId}:aoi:${index}`,
        ),
        frame: batch.frame,
        itemCount: batch.itemCount,
      }))
      .filter((batch) => batch.audience.routes.length > 0);
    this.pipelineMetrics.audienceMapMs += monotonicNow() - startedAt;
    this.pipelineMetrics.audienceMapCount += 1;
    return result;
  }

  /** 把 Rust 的紧凑 routeId 外壳映射为 Scene 名称；不再逐玩家查询组件或重编码协议。 / Maps compact Rust route ids to Scene names without per-player component lookup or protocol re-encoding. */
  private ToRouteBroadcast(
    movement: ReturnType<typeof NativeData.TakeMapMovementAoiRouteFrames>,
  ): EncodedRouteBroadcast {
    const frames = movement.routeFrames.map((item) => {
      const route = this.gateNamesByRouteId.get(item.routeId);
      if (!route) throw new Error(`unknown AOI delivery route id: ${item.routeId}`);
      return { route, frame: item.frame };
    });
    return { frames, itemCount: movement.itemCount };
  }

  /** 为地图实例内稳定不变的 Gate 名称分配紧凑 routeId。玩家换 Gate 必须先离开并重新 Attach。 / Assigns a compact route id to a stable Gate name; changing Gate requires detach and reattach. */
  private RouteIdForGate(gateName: string): number {
    const existing = this.gateRouteIds.get(gateName);
    if (existing !== undefined) return existing;
    if (this.nextGateRouteId > 0xffff_ffff) throw new Error("AOI delivery route id exhausted");
    const routeId = this.nextGateRouteId;
    this.nextGateRouteId += 1;
    this.gateRouteIds.set(gateName, routeId);
    this.gateNamesByRouteId.set(routeId, gateName);
    return routeId;
  }

  /**
   * 合并在途期间产生的空间变化并只保留最新移动；同一可见关系先 Enter/Leave，后发状态。
   * 这里只维持一个排空 Promise，禁止按 Tick 追加 Promise 链。
   *
   * Coalesces spatial transitions produced while delivery is in flight and keeps
   * only the latest movement. A relation is published before its state, and only
   * one drain promise exists instead of an unbounded per-tick promise chain.
   */
  private QueueSpatialAndMovement(
    visibility: readonly AoiVisibilityDelta[],
    movement: EncodedRouteBroadcast,
  ): void {
    for (const change of visibility) {
      const key = `${change.observerId}:${change.subjectId}`;
      const existing = this.pendingSpatialChanges.get(key);
      if (!existing) {
        this.pendingSpatialChanges.set(key, { before: !change.visible, change });
        continue;
      }
      existing.change = change;
      if (existing.before === change.visible) this.pendingSpatialChanges.delete(key);
    }
    if (movement.frames.length > 0) this.pendingSpatialMovement = movement;
    if (this.spatialBarrier) return;

    const drain = this.DrainSpatialBroadcasts();
    const barrier = drain.catch((error) => {
      this.logger.error("map AOI movement publish failed", { error });
    });
    this.spatialBarrier = barrier;
    void barrier.then(() => {
      if (this.spatialBarrier === barrier) this.spatialBarrier = undefined;
    });
  }

  private async DrainSpatialBroadcasts(): Promise<void> {
    while (this.pendingSpatialChanges.size > 0 || this.pendingSpatialMovement) {
      if (this.pendingSpatialChanges.size > 0) {
        const changes = [...this.pendingSpatialChanges.values()].map((item) => item.change);
        this.pendingSpatialChanges.clear();
        await this.PublishAoiChanges(changes);
        // 新的可见变化可能在 await 期间到达；先处理它们，旧移动可以直接被较新帧覆盖。
        // Visibility may arrive while awaiting delivery. Publish it first; newer
        // movement already supersedes the local stale frame.
        if (this.pendingSpatialChanges.size > 0) continue;
      }

      const movement = this.pendingSpatialMovement;
      this.pendingSpatialMovement = undefined;
      if (movement) {
        await this.broadcast.PublishEncodedLatestRouteFrames(
          `map:${this.mapInstanceId}:aoi`,
          ClientBroadcasts.EntityMove.name,
          movement.frames,
          movement.itemCount,
        );
      }
    }
  }

  /** 按相同受众批量发布不可覆盖的进入/离开事件。 / Batches non-coalescible enter/leave events by identical audience. */
  private async PublishAoiChanges(
    changes: readonly AoiVisibilityDelta[],
  ): Promise<void> {
    const groups = new Map<string, {
      visible: boolean;
      subjectId: number;
      observerIds: number[];
    }>();
    for (const change of changes) {
      const key = `${Number(change.visible)}:${change.subjectId}`;
      const group = groups.get(key) ?? {
        visible: change.visible,
        subjectId: change.subjectId,
        observerIds: [],
      };
      group.observerIds.push(change.observerId);
      groups.set(key, group);
    }

    const batches = new Map<string, {
      observerIds: number[];
      enters: MapEntitySnapshot[];
      leaves: number[];
    }>();
    for (const group of groups.values()) {
      group.observerIds.sort((left, right) => left - right);
      const audienceKey = group.observerIds.join(",");
      const batch = batches.get(audienceKey) ?? {
        observerIds: group.observerIds,
        enters: [],
        leaves: [],
      };
      if (group.visible) {
        const subject = this.units.Get<PlayerUnit>(group.subjectId);
        if (!subject) {
          this.logger.warn("AOI enter subject disappeared before publish", {
            subjectId: group.subjectId,
          });
          continue;
        }
        batch.enters.push(toMapEntity(subject.Snapshot()));
      } else {
        batch.leaves.push(group.subjectId);
      }
      batches.set(audienceKey, batch);
    }

    const deliveries: Promise<void>[] = [];
    let batchIndex = 0;
    for (const batch of batches.values()) {
      const audience = this.AudienceForRecipients(
        batch.observerIds,
        `map:${this.mapInstanceId}:aoi:delta:${batchIndex}`,
      );
      batchIndex += 1;
      if (audience.routes.length === 0) continue;
      deliveries.push(this.broadcast.Publish(
        audience,
        ClientBroadcasts.AoiDelta,
        { serverTick: this.serverTick, enters: batch.enters, leaves: batch.leaves },
        this.serverTick,
      ));
    }
    await Promise.all(deliveries);
  }

  private AudienceForRecipients(
    recipientIds: readonly number[],
    key: string,
  ): BroadcastAudience {
    const routes = recipientIds.flatMap((unitId) => {
      const unit = this.units.Get<PlayerUnit>(unitId);
      if (!unit) return [];
      const gate = unit.GetComponent(UnitGateComponent);
      return [{ route: gate.gateName, recipientId: unitId }];
    });
    return { key, routes };
  }

  private requirePlayer(unit: PlayerUnit): void {
    if (
      unit.MapInstanceId !== this.mapInstanceId ||
      unit.DomainScene() !== this.DomainScene() ||
      this.units.Get(unit.UnitId) !== unit
    ) {
      throw new Error(
        `unit ${unit.UnitId}@${unit.InstanceId} does not belong to map instance ${this.mapInstanceId}`,
      );
    }
  }

  private get units(): UnitComponent {
    return this.DomainScene().GetComponent(UnitComponent);
  }
}

function toMapEntity(snapshot: PlayerSnapshot): MapEntitySnapshot {
  return {
    unitId: snapshot.unitId,
    account: snapshot.account,
    x: snapshot.x,
    y: snapshot.y,
    z: snapshot.z,
    yaw: snapshot.yaw,
    state: new Uint8Array(0),
    cellX: snapshot.cellX,
    cellZ: snapshot.cellZ,
    numerics: snapshot.numerics,
    buffs: [],
    speedCellsPerSecond: snapshot.speedCellsPerSecond,
    facing: snapshot.facing,
    alive: snapshot.alive,
  };
}
