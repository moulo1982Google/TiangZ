import {
  Component,
  EntryScene,
  Game,
  RpcError,
  SystemErrCode,
  UnitComponent,
  type CustomMetricSnapshot,
  TransferStagingRegistry,
} from "../../../core/public";
import { GameErrCode } from "../../game/protocol/GameErrCode";
import { GateMessages } from "../../../generated/model/server/demo/protocol/messageDescriptors";
import type {
  G2M_EnterMap,
  G2M_TransferPlayer,
  M2G_EnterMap,
  M2G_TransferPlayer,
  M2G_MapReady,
  M2M_AbortPlayerTransfer,
  M2M_AbortPlayerTransferResponse,
  M2M_CommitPlayerTransfer,
  M2M_CommitPlayerTransferResponse,
  M2M_PreparePlayerTransfer,
  M2M_PreparePlayerTransferResponse,
  PlayerTransferSnapshot,
} from "../../../generated/model/server/demo/protocol/messages";
import { MapTransferProtocol } from "../../../generated/model/server/demo/protocol/rpcs";
import { MapComponent } from "../map/MapComponent";
import { MapScene } from "../map/MapScene";
import { PlayerUnit, type PlayerSnapshot } from "../map/PlayerUnit";
import { PlayerDirectoryComponent } from "./PlayerDirectoryComponent";
import { ItemComponent } from "../item/ItemComponent";
import { InMemoryPlayerRepository } from "../persistence/PlayerRepository";
import { GameConfigs } from "../../../generated/model/config";
import { LocationProxy } from "../location/LocationProxy";
import { UnitGateComponent } from "../map/UnitGateComponent";

export class MapHostComponent extends Component {
  private readonly maps = new Map<number, MapComponent>();
  private readonly repository = new InMemoryPlayerRepository();
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

  /** 定期回收源进程宕机遗留的Prepare，以及已完成事务的短期幂等记录。 / Periodically reclaims prepares orphaned by a crashed source and short-lived completed idempotency records. */
  protected override Awake(): void {
    this.location = new LocationProxy(this.owner.scenes);
    this.NewRepeatedTimer(10_000, "SweepIncomingTransfers");
    this.NewRepeatedTimer(5_000, "RecoverOwnedLocations");
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
    ];
  }

  /** 协调全部托管地图优雅下线，并等待所有保存完成。 / Coordinates graceful offline for every hosted map and waits for all saves. */
  async KickAllPlayers(reason: string): Promise<void> {
    const results = await Promise.allSettled(
      [...this.maps.values()].map((map) => map.KickAllPlayers(reason)),
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

  /** 选择或创建地图、处理重连改绑，并返回权威进入快照。 / Selects/creates a map, rebinds reconnects, and returns the authoritative entry snapshot. */
  async enterMap(request: G2M_EnterMap): Promise<M2G_EnterMap> {
    this.validateEnterMap(request);

    const mapId = request.mapId || GameConfigs.PlayerConfig.Get(1).initialMapId;
    if (!GameConfigs.MapConfig.TryGet(mapId)) {
      throw new RpcError(GameErrCode.MapNotFound, `map config not found: ${mapId}`);
    }
    let player: PlayerUnit | undefined;
    let snapshot: PlayerSnapshot;
    let isNewPlayer = false;

    for (;;) {
      player = this.players.Get(request.account);
      if (player?.MapId === mapId) {
        try {
          snapshot = await this.owner.processHost.runActorMailbox(
            player.InstanceId,
            (actor) => {
              if (actor !== player) throw new Error("player instance changed");
              if (!player.MatchesGate({ gateName: request.gateName })) {
                throw new Error(`player Gate mismatch: ${request.account}`);
              }
              return player.SecondEnterMap();
            },
          );
          break;
        } catch (error) {
          // 断线下线与重进可能交叠。仅当目录已确认旧实例消失时重试，
          // 其他业务异常必须原样抛出，不能被误判成一次普通重连。
          if (this.players.Get(request.account) === player) throw error;
          continue;
        }
      }

      if (player) {
        throw new RpcError(
          SystemErrCode.LocationConflict,
          "existing player must transfer through the Unit Actor route",
        );
      } else {
        const allocated = await this.location.AllocateUnitId({ account: request.account });
        player = this.ensureMap(mapId).CreatePlayer(allocated.unitId, request);
        try {
          await this.location.Register({
            unitId: player.UnitId,
            account: player.Account,
            gateName: request.gateName,
            mapHostName: this.owner.self.name,
            mapId,
            mapInstanceId: BigInt(mapId),
            actorInstanceId: player.InstanceId,
          });
        } catch (error) {
          this.ensureMap(mapId).RemoveTransferredPlayer(player);
          throw error;
        }
      }
      snapshot = player.Snapshot();
      isNewPlayer = true;
      break;
    }

    const map = this.mapOf(player);
    if (isNewPlayer) {
      await map.PlayerEntered(snapshot);
    }

    this.owner.logger.info("player entered map", {
      account: snapshot.account,
      mapId: snapshot.mapId,
      unitId: snapshot.unitId,
      actorId: player.InstanceId,
    });

    const mapReady: M2G_MapReady = {
      account: snapshot.account,
      mapId: snapshot.mapId,
      unitId: snapshot.unitId,
      x: snapshot.x,
      y: snapshot.y,
    };
    await this.owner.scenes.send(
      this.owner.scenes.byName(snapshot.gateName),
      GateMessages.MapReady,
      mapReady,
    );

    const located = await this.location.Resolve({ unitId: player.UnitId, account: "" });
    if (!located.found || located.location.actorInstanceId !== player.InstanceId) {
      throw new RpcError(
        GameErrCode.MapNotFound,
        `player location was not published: ${player.UnitId}`,
      );
    }

    return {
      account: snapshot.account,
      mapId: snapshot.mapId,
      unitId: snapshot.unitId,
      actorInstanceId: player.InstanceId,
      fixedUpdateMs: Game.Instance.FixedUpdateMs,
      x: snapshot.x,
      y: snapshot.y,
      entities: map.EntitySnapshots(),
      items: player.GetComponent(ItemComponent).Snapshot(),
      mapInstanceId: located.location.mapInstanceId,
      locationRevision: located.location.revision,
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
    if (
      source.Account !== request.account ||
      !source.MatchesGate({ gateName: request.gateName })
    ) {
      throw new RpcError(GameErrCode.GateSessionRequired, "player transfer identity mismatch");
    }
    if (!GameConfigs.MapConfig.TryGet(request.targetMapId)) {
      throw new RpcError(GameErrCode.MapNotFound, `map config not found: ${request.targetMapId}`);
    }
    const operationId = `${this.owner.self.name}:${source.UnitId}:${source.InstanceId}:${this.nextTransferSequence++}`;
    await this.location.Lock({
      unitId: source.UnitId,
      expectedRevision: request.expectedLocationRevision,
      expectedActorInstanceId: source.InstanceId,
      operationId,
      state: "moving",
    });

    if (request.targetMapHostName === this.owner.self.name) {
      return await this.TransferLocal(source, request, operationId);
    }
    return await this.TransferRemote(source, request, operationId);
  }

  private async TransferLocal(
    source: PlayerUnit,
    request: G2M_TransferPlayer,
    operationId: string,
  ): Promise<M2G_TransferPlayer> {
    const sourceMap = this.mapOf(source);
    const targetMap = this.ensureMap(request.targetMapId);
    let target: PlayerUnit | undefined;
    let directoryReplaced = false;
    let locationCommitted = false;
    try {
      target = targetMap.PrepareTransferredPlayer(
        source.UnitId,
        {
          account: source.Account,
          token: "map-transfer",
          gateName: request.gateName,
          mapId: request.targetMapId,
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
        mapId: request.targetMapId,
        mapInstanceId: BigInt(request.targetMapId),
        actorInstanceId: target.InstanceId,
      });
      locationCommitted = true;
      const snapshot = target.Snapshot();
      try {
        await targetMap.PlayerEntered(snapshot);
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
      return this.TransferResponse(request.rpcId, target, targetMap, committed.location.revision);
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
    operationId: string,
  ): Promise<M2G_TransferPlayer> {
    const sourceMap = this.mapOf(source);
    const targetScene = this.owner.scenes.byName(request.targetMapHostName);
    let targetCommitted = false;
    try {
      const transfer = this.CreateTransferSnapshot(
        source,
        request.targetMapId,
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
      });
      this.ScheduleSourceCleanup(sourceMap, source);
      return {
        rpcId: request.rpcId,
        error: 0,
        message: "",
        account: source.Account,
        mapHostName: target.mapHostName,
        mapId: target.mapId,
        mapInstanceId: target.mapInstanceId,
        unitId: target.unitId,
        actorInstanceId: target.actorInstanceId,
        locationRevision: committed.location.revision,
        x: target.x,
        y: target.y,
        entities: target.entities,
        fixedUpdateMs: target.fixedUpdateMs,
        items: target.items,
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
          targetMapHost: request.targetMapHostName,
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
  ): M2G_TransferPlayer {
    const snapshot = player.Snapshot();
    return {
      rpcId,
      error: 0,
      message: "",
      account: snapshot.account,
      mapHostName: this.owner.self.name,
      mapId: snapshot.mapId,
      mapInstanceId: BigInt(snapshot.mapId),
      unitId: snapshot.unitId,
      actorInstanceId: player.InstanceId,
      locationRevision: revision,
      x: snapshot.x,
      y: snapshot.y,
      entities: map.EntitySnapshots(),
      fixedUpdateMs: Game.Instance.FixedUpdateMs,
      items: player.GetComponent(ItemComponent).Snapshot(),
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
        map.RemoveTransferredPlayer(source);
        void map.PlayerLeft(source.UnitId).catch((error) => {
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
    const snapshot = request.snapshot;
    this.ValidateTransferSnapshot(snapshot);
    const result = this.incomingTransfers.Prepare(
      snapshot.transferId,
      JSON.stringify(snapshot),
      () => {
        const map = this.ensureMap(snapshot.targetMapId);
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
    const committed = this.incomingTransfers.Commit(
      request.transferId,
      ({ player }) => {
        const snapshot = player.Snapshot();
        this.players.Add(player);
        return snapshot;
      },
    );
    if (committed.newlyCommitted) {
      try {
        await committed.target.map.PlayerEntered(committed.result);
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
      x: committed.result.x,
      y: committed.result.y,
      entities: committed.target.map.EntitySnapshots(),
      fixedUpdateMs: Game.Instance.FixedUpdateMs,
      items: committed.target.player.GetComponent(ItemComponent).Snapshot(),
      mapHostName: this.owner.self.name,
      mapInstanceId: BigInt(committed.result.mapId),
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
    targetMapId: number,
    transferId: string,
  ): PlayerTransferSnapshot {
    const snapshot = player.Snapshot();
    return {
      schemaVersion: 1,
      transferId,
      unitId: snapshot.unitId,
      account: snapshot.account,
      sourceMapId: snapshot.mapId,
      targetMapId,
      gateName: snapshot.gateName,
      speedCellsPerSecond: snapshot.speedCellsPerSecond,
      facing: snapshot.facing,
      alive: snapshot.alive,
      numerics: snapshot.numerics,
      items: player.GetComponent(ItemComponent).Snapshot(),
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
      const locations = this.players.GetAll().map((player) => ({
        unitId: player.UnitId,
        account: player.Account,
        gateName: player.GetComponent(UnitGateComponent).gateName,
        mapHostName: this.owner.self.name,
        mapId: player.MapId,
        mapInstanceId: BigInt(player.MapId),
        actorInstanceId: player.InstanceId,
      }));
      const recovered = await this.location.RecoverOwner({
        ownerName: this.owner.self.name,
        locations,
      });
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

  private ensureMap(mapId: number): MapComponent {
    const existing = this.maps.get(mapId);
    if (existing) return existing;

    const sceneId = this.owner.childSceneId(`map:${mapId}`);
    const scene = this.owner.processHost.spawnScene(sceneId, MapScene);
    scene.AddComponent(UnitComponent);
    const map = scene.AddComponent(
      MapComponent,
      mapId,
      this.owner.scenes,
      this.players,
      this.repository,
      this,
      this.location,
    );
    this.maps.set(mapId, map);
    return map;
  }

  private mapOf(unit: PlayerUnit): MapComponent {
    const map = unit.DomainScene<MapScene>().GetComponent(MapComponent);
    if (map !== this.maps.get(unit.MapId)) {
      throw new Error(
        `unit ${unit.UnitId}@${unit.InstanceId} has invalid map ${unit.MapId}`,
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
    if (!request.gateName) {
      throw new RpcError(
        GameErrCode.GateSessionRequired,
        "gate binding is required",
      );
    }
  }

  private ValidateTransferSnapshot(snapshot: PlayerTransferSnapshot): void {
    if (snapshot.schemaVersion !== 1) {
      throw new Error(`unsupported player transfer schema: ${snapshot.schemaVersion}`);
    }
    if (!snapshot.transferId || !snapshot.account || !snapshot.gateName) {
      throw new Error("incomplete player transfer identity");
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

interface PreparedIncomingPlayer {
  readonly map: MapComponent;
  readonly player: PlayerUnit;
}
