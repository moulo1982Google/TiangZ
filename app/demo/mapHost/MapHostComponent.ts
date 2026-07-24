import { RpcError } from "../../core/protocol/RpcError";
import { EntryScene } from "../../core/process/types";
import type { CustomMetricSnapshot } from "../../core/process/types";
import {
  Component,
  Game,
  UnitComponent,
} from "../../core/runtime";
import { GameErrCode } from "../../game/protocol/GameErrCode";
import { GateMessages } from "../../generated/model/server/demo/protocol/messageDescriptors";
import type {
  G2M_EnterMap,
  M2G_EnterMap,
  M2G_MapReady,
} from "../../generated/model/server/demo/protocol/messages";
import { MapComponent } from "../map/MapComponent";
import { MapScene } from "../map/MapScene";
import { PlayerUnit, type PlayerSnapshot } from "../map/PlayerUnit";
import { PlayerDirectoryComponent } from "./PlayerDirectoryComponent";
import { ItemComponent } from "../item/ItemComponent";

export class MapHostComponent extends Component {
  private readonly maps = new Map<number, MapComponent>();
  private nextUnitId = 1000;

  BroadcastMetricSnapshots(): CustomMetricSnapshot[] {
    return [...this.maps.values()].map((map) => map.BroadcastMetricSnapshot());
  }

  async enterMap(request: G2M_EnterMap): Promise<M2G_EnterMap> {
    this.validateEnterMap(request);

    const mapId = request.mapId || 1;
    let player = this.players.Get(request.account);
    let snapshot: PlayerSnapshot;
    let isNewPlayer = false;

    if (player?.MapId === mapId) {
      snapshot = await this.owner.processHost.runActorMailbox(
        player.InstanceId,
        (actor) => {
          if (actor !== player) throw new Error("player instance changed");
          return player.RebindGate({
            token: request.token,
            gateName: request.gateName,
            gateSessionId: request.gateSessionId,
          });
        },
      );
    } else {
      if (player) {
        await player
          .DomainScene<MapScene>()
          .GetComponent(MapComponent)
          .RemovePlayerAndBroadcast(player);
      }
      player = this.ensureMap(mapId).CreatePlayer(this.nextUnitId++, request);
      snapshot = player.Snapshot();
      isNewPlayer = true;
    }

    const map = this.mapOf(player);
    if (isNewPlayer) {
      await map.PlayerEntered(snapshot);
    }

    console.log(
      `[${this.owner.self.name}] ${snapshot.account} enter map ${snapshot.mapId} unit ${snapshot.unitId}@${player.InstanceId}`,
    );

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
