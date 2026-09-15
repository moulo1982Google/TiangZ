import { MapHostScene, MapHostComponent, MapManagerScene, MapManagerComponent, MapScene, MapComponent,
  PlayerUnit, UnitActionComponent, entityExtensionHandler, systemFor, utf8Decode, utf8Encode,
  type EntityExtensionHandler } from "#tiangz/model";
import { PublicMapTestAction } from "#tiangz/module";

@entityExtensionHandler(MapManagerScene, { id: "org.tiangz.fixture.public-manager" })
class ManagerPolicy implements EntityExtensionHandler<MapManagerScene> {
  Attach(scene: MapManagerScene): void {
    scene.GetComponent(MapManagerComponent).ConfigurePublicMaps([
      { mapConfigId: 2, maxPlayers: 2, minChannels: 1, idleTimeoutMs: 30_000 },
    ]);
  }
}

@entityExtensionHandler(MapHostScene, { id: "org.tiangz.fixture.public-host" })
class HostPolicy implements EntityExtensionHandler<MapHostScene> {
  Attach(scene: MapHostScene): void {
    scene.GetComponent(MapHostComponent).ConfigureCapacity({ maxMaps: scene.self.name === "public_host_a" ? 3 : 2,
      maxPlayers: 20, mapConfigIds: [1, 2] });
  }
}

@entityExtensionHandler(PlayerUnit, { id: "org.tiangz.fixture.public-player" })
class PlayerActions implements EntityExtensionHandler<PlayerUnit> {
  Attach(player: PlayerUnit): void {
    const actions = player.TryGetComponent(UnitActionComponent) ?? player.AddComponent(UnitActionComponent);
    actions.Register("fixture.publicmaps", player.AddComponent(PublicMapTestAction));
  }
}

@systemFor(PublicMapTestAction)
class PublicMapTestActionSystem extends PublicMapTestAction {
  override async InvokeUnitAction(action: string, version: number, payload: Uint8Array): Promise<Uint8Array> {
    if (version !== 1) throw new Error("unsupported fixture version");
    const player = this.GetParent<PlayerUnit>();
    const scene = player.DomainScene<MapScene>();
    const api = scene.GetComponent(MapComponent).PublicMaps;
    const args = JSON.parse(utf8Decode(payload));
    let result: unknown;
    if (action === "direct") result = await scene.GetComponent(MapComponent).TransferToMap(player, BigInt(args.instance));
    else if (action === "list") result = await api.List(2);
    else if (action === "where") result = { instance: player.MapInstanceId, map: player.MapId };
    else throw new Error("unknown fixture action");
    return utf8Encode(JSON.stringify(result, (_key, value) => typeof value === "bigint" ? value.toString() : value));
  }
}
