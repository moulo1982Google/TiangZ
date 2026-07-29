import {
  Component,
  CommitPreparedTransfer,
  EntryScene,
  Game,
  RpcError,
  UnitComponent,
  type CustomMetricSnapshot,
  TransferStagingRegistry,
} from "../../../core/public";
import { GameErrCode } from "../../game/protocol/GameErrCode";
import { GateMessages } from "../../../generated/model/server/demo/protocol/messageDescriptors";
import type {
  G2M_EnterMap,
  M2G_EnterMap,
  M2G_MapReady,
  M2M_AbortPlayerTransfer,
  M2M_AbortPlayerTransferResponse,
  M2M_CommitPlayerTransfer,
  M2M_CommitPlayerTransferResponse,
  M2M_PreparePlayerTransfer,
  M2M_PreparePlayerTransferResponse,
  PlayerTransferSnapshot,
} from "../../../generated/model/server/demo/protocol/messages";
import { MapComponent } from "../map/MapComponent";
import { MapScene } from "../map/MapScene";
import { PlayerUnit, type PlayerSnapshot } from "../map/PlayerUnit";
import { PlayerDirectoryComponent } from "./PlayerDirectoryComponent";
import { ItemComponent } from "../item/ItemComponent";
import { InMemoryPlayerRepository } from "../persistence/PlayerRepository";
import { GameConfigs } from "../../../generated/model/config";

export class MapHostComponent extends Component {
  private readonly maps = new Map<number, MapComponent>();
  private readonly repository = new InMemoryPlayerRepository();
  private nextUnitId = 1000;
  private readonly incomingTransfers =
    new TransferStagingRegistry<PreparedIncomingPlayer>(1024);

  /** 定期回收源进程宕机遗留的Prepare，以及已完成事务的短期幂等记录。 / Periodically reclaims prepares orphaned by a crashed source and short-lived completed idempotency records. */
  protected override Awake(): void {
    this.NewRepeatedTimer(10_000, "SweepIncomingTransfers");
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
        const source = player;
        const sourceMap = source.DomainScene<MapScene>().GetComponent(MapComponent);
        const targetMap = this.ensureMap(mapId);
        player = CommitPreparedTransfer({
          Capture: () => source.CaptureTransfer(),
          Prepare: (transfer) =>
            targetMap.PrepareTransferredPlayer(source.UnitId, request, transfer),
          Commit: (target) => {
            if (!this.players.Replace(source, target)) {
              throw new Error(`player changed during map transfer: ${source.Account}`);
            }
          },
          Rollback: (target) => targetMap.DiscardPreparedPlayer(target),
        });

        // 目录替换是提交点；之后只做源对象清理和通知，外部通知失败不能让权威状态倒退。
        // Directory replacement is the commit point. Source cleanup and external
        // notifications follow it and must not roll authoritative state backward.
        try {
          sourceMap.RemoveTransferredPlayer(source);
        } catch (error) {
          this.owner.logger.error("failed to dispose transferred source player", {
            account: source.Account,
            unitId: source.UnitId,
            fromMapId: source.MapId,
            toMapId: mapId,
            error,
          });
        }
        void sourceMap.PlayerLeft(source.UnitId).catch((error) => {
          this.owner.logger.error("failed to broadcast transferred player leave", {
            account: source.Account,
            unitId: source.UnitId,
            fromMapId: source.MapId,
            error,
          });
        });
      } else {
        player = this.ensureMap(mapId).CreatePlayer(this.nextUnitId++, request);
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
    };
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
