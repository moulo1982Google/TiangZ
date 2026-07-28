import {
  Component,
  EntryScene,
  Game,
  RpcError,
  UnitComponent,
  type CustomMetricSnapshot,
} from "../../../core/public";
import { GameErrCode } from "../../game/protocol/GameErrCode";
import { GateMessages } from "../../../generated/model/server/demo/protocol/messageDescriptors";
import type {
  G2M_EnterMap,
  M2G_EnterMap,
  M2G_MapReady,
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

  /** 收集每张托管地图的广播快照，不重置计数器。 / Collects one broadcast snapshot per hosted map without resetting counters. */
  BroadcastMetricSnapshots(): CustomMetricSnapshot[] {
    return [...this.maps.values()].map((map) => map.BroadcastMetricSnapshot());
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
              return player.RebindGate({
                gateName: request.gateName,
                gateSessionId: request.gateSessionId,
              });
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
        const unitId = player.UnitId;
        const transfer = player.CaptureTransfer();
        // 先同步移除并立即恢复目标组件，再等待旧图广播，避免迁移快照跨越Hotfix切换点。
        // Detach and restore synchronously before awaiting the old-map broadcast,
        // so the transfer snapshot cannot cross a Hotfix generation switch.
        const leaveOldMap = player
          .DomainScene<MapScene>()
          .GetComponent(MapComponent)
          .RemovePlayerAndBroadcast(player);
        player = this.ensureMap(mapId).CreatePlayer(unitId, request, transfer);
        await leaveOldMap;
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
    if (!request.gateName || !request.gateSessionId) {
      throw new RpcError(
        GameErrCode.GateSessionRequired,
        "gate binding is required",
      );
    }
  }
}
