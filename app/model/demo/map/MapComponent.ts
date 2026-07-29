import {
  BroadcastHub,
  StateReplicationSystem,
  type BroadcastAudience,
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
  ItemSnapshot,
  KickPlayerTarget,
  MapEntitySnapshot,
  M2G_PlayerOffline,
  M2G_SecondEnterMap,
  PlayerTransferSnapshot,
} from "../../../generated/model/server/demo/protocol/messages";
import { SceneBroadcastTransport } from "../broadcast/SceneBroadcastTransport";
import type { PlayerDirectoryComponent } from "../mapHost/PlayerDirectoryComponent";
import { PlayerUnit, type PlayerSnapshot } from "./PlayerUnit";
import { MapScene } from "./MapScene";
import { PositionComponent } from "./PositionComponent";
import { UnitGateComponent } from "./UnitGateComponent";
import { NativeUnitRef } from "../../../generated/model/native/NativeUnitRef";
import { NativeData } from "../native/NativeData";
import { NumericComponent } from "../numeric/NumericComponent";
import { ItemComponent } from "../item/ItemComponent";
import { PlayerPersistenceComponent } from "../persistence/PlayerPersistenceComponent";
import type { PlayerRepository } from "../persistence/PlayerRepository";
import {
  GameConfigs,
  type MapConfig as MapConfigData,
} from "../../../generated/model/config";

const DEMO_PLAYER_CONFIG_ID = 1;

@component()
export class MapComponent extends Component<[
  mapId: number,
  scenes: SceneMessageHelper,
  players: PlayerDirectoryComponent,
  repository: PlayerRepository,
]> implements IFrameFlush {
  private mapId = 0;
  private players!: PlayerDirectoryComponent;
  private serverTick = 0;
  private broadcast!: BroadcastHub;
  private replication!: StateReplicationSystem;
  private repository!: PlayerRepository;
  private scenes!: SceneMessageHelper;
  private logger!: Logger;
  private config!: MapConfigData;

  get MapId(): number {
    return this.mapId;
  }

  /** 创建地图内 Unit 存储、广播传输和帧尾同步源。 / Creates map-local Unit storage, broadcast transport, and frame-end replication sources. */
  protected override Awake(
    mapId: number,
    scenes: SceneMessageHelper,
    players: PlayerDirectoryComponent,
    repository: PlayerRepository,
  ): void {
    this.mapId = mapId;
    this.config = GameConfigs.MapConfig.Get(mapId);
    NativeData.ConfigureMap(mapId, this.config.widthCells, this.config.heightCells);
    this.players = players;
    this.repository = repository;
    this.scenes = scenes;
    this.logger = this.DomainScene<MapScene>().logger.child({ mapId });
    this.broadcast = new BroadcastHub(new SceneBroadcastTransport(scenes), {
      onError: (name, error) => {
        this.logger.error("map broadcast failed", { broadcast: name, error });
      },
    });
    this.replication = new StateReplicationSystem(
      this.broadcast,
      () => this.BroadcastAudience(),
    );
    this.RegisterReplicationSources();
  }

  /** 每次固定逻辑帧推进一次 Rust 权威 Cell 移动。 / Advances Rust-authoritative cell movement once per fixed game update. */
  Update(): void {
    if (this.units.Count === 0) return;
    const fixedDeltaMs = TimeSystem.Instance.FixedDeltaTime;
    this.serverTick += 1;
    const moveDescriptor = ClientBroadcasts.EntityMove;
    const encoded = NativeData.UpdateMapMovement(
      this.mapId,
      this.serverTick,
      fixedDeltaMs,
      moveDescriptor.message.msgcode,
    );
    if (encoded.itemCount === 0) return;

    const audience = this.BroadcastAudience();
    void this.broadcast.PublishEncodedLatestSnapshot(
      audience,
      moveDescriptor.name,
      encoded.frame,
      encoded.itemCount,
    ).catch(() => undefined);
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
        mapId: snapshot.targetMapId,
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
  RemoveTransferredPlayer(unit: PlayerUnit): void {
    this.requirePlayer(unit);
    this.RemovePlayer(unit);
  }

  /** 广播已提交迁移的源地图离开事件；失败不撤销已经完成的数据所有权切换。 / Broadcasts the source-map leave event after commit; failure does not reverse the completed ownership switch. */
  async PlayerLeft(unitId: number): Promise<void> {
    await this.broadcast.Publish(
      this.BroadcastAudience(),
      ClientBroadcasts.EntityLeave,
      { unitId },
      this.serverTick,
    );
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
    });

    try {
      const native = player.AddComponent(NativeUnitRef, {
        id: unitId,
        instanceId: player.InstanceId,
        mapId: this.mapId,
        x: 0,
        y: 0,
      });
      const position = player.AddComponent(
        PositionComponent,
        native,
        this.config.widthCells,
        this.config.heightCells,
      );
      position.SetCell(this.config.spawnCellX, this.config.spawnCellY);
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
  EntitySnapshots(): MapEntitySnapshot[] {
    return this.PlayerSnapshots().map(toMapEntity);
  }

  /** 新玩家完整组件图准备好后，广播其进入视野。 / Broadcasts a newly visible player after its complete Component graph is ready. */
  async PlayerEntered(snapshot: PlayerSnapshot): Promise<void> {
    await this.broadcast.Publish(
      this.BroadcastAudience(snapshot.unitId),
      ClientBroadcasts.EntityEnter,
      { entity: toMapEntity(snapshot) },
      this.serverTick,
    );
  }

  /** 立即发送不可逆背包事件；这里禁止使用 latest 合并。 / Sends an irreversible inventory event immediately; latest coalescing is forbidden here. */
  async PublishItemChanged(unit: PlayerUnit, item: ItemSnapshot): Promise<void> {
    this.requirePlayer(unit);
    await this.broadcast.Publish(
      this.PlayerAudience(unit),
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
      entities: this.EntitySnapshots(),
      fixedUpdateMs: Game.Instance.FixedUpdateMs,
      items: unit.GetComponent(ItemComponent).Snapshot(),
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
    const unitId = unit.UnitId;
    this.RemovePlayer(unit);

    await this.PlayerLeft(unitId);
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
      players.map((player) => player.Offline(reason)),
    );
    for (const player of players) this.RemovePlayer(player);
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
    let saveError: unknown;
    try {
      await unit.Offline(reason);
    } catch (error) {
      saveError = error;
    }
    const unitId = unit.UnitId;
    this.RemovePlayer(unit);
    await this.broadcast.Publish(
      this.BroadcastAudience(),
      ClientBroadcasts.EntityLeave,
      { unitId },
      this.serverTick,
    );
    if (saveError !== undefined) throw saveError;
  }

  private RemovePlayer(unit: PlayerUnit): void {
    this.players.Remove(unit);
    this.units.Remove(unit.UnitId);
  }

  private PlayerSnapshots(): PlayerSnapshot[] {
    return this.units.GetAll(PlayerUnit).map((unit) => unit.Snapshot());
  }

  private RegisterReplicationSources(): void {
    const numeric = ClientBroadcasts.EntityNumeric;
    this.replication.Add({
      name: numeric.name,
      Peek: () => {
        const delta = NativeData.PeekMapNumericDelta(
          this.mapId,
          this.serverTick,
          numeric.message.msgcode,
        );
        return {
          ...delta,
          Ack: () => NativeData.AckMapNumericDelta(this.mapId, delta.revision),
        };
      },
    });

    const state = ClientBroadcasts.EntityState;
    this.replication.Add({
      name: state.name,
      Peek: () => {
        const delta = NativeData.PeekMapUnitDelta(
          this.mapId,
          this.serverTick,
          state.message.msgcode,
        );
        return {
          ...delta,
          Ack: () => NativeData.AckMapUnitDelta(this.mapId, delta.revision),
        };
      },
    });
  }

  protected override OnDestroy(): void {
    this.broadcast.Dispose();
    NativeData.UnconfigureMap(this.mapId);
  }

  private BroadcastAudience(excludeUnitId?: number): BroadcastAudience {
    const routes = this.units
      .GetAll(PlayerUnit)
      .filter((unit) => unit.UnitId !== excludeUnitId)
      .map((unit) => {
        const gate = unit.GetComponent(UnitGateComponent);
        return { route: gate.gateName, recipientId: unit.UnitId };
      });
    return { key: `map:${this.mapId}`, routes };
  }

  private PlayerAudience(unit: PlayerUnit): BroadcastAudience {
    const gate = unit.GetComponent(UnitGateComponent);
    return {
      key: `player:${unit.UnitId}`,
      routes: [{ route: gate.gateName, recipientId: unit.UnitId }],
    };
  }

  private requirePlayer(unit: PlayerUnit): void {
    if (
      unit.MapId !== this.mapId ||
      unit.DomainScene() !== this.DomainScene() ||
      this.units.Get(unit.UnitId) !== unit
    ) {
      throw new Error(
        `unit ${unit.UnitId}@${unit.InstanceId} does not belong to map ${this.mapId}`,
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
    heading: 0,
    state: new Uint8Array(0),
    cellX: snapshot.cellX,
    cellY: snapshot.cellY,
    numerics: snapshot.numerics,
    speedCellsPerSecond: snapshot.speedCellsPerSecond,
    facing: snapshot.facing,
    alive: snapshot.alive,
  };
}
