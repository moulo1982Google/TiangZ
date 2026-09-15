import { MapHostComponent, MapHostScene, PublicMapHostProtocol, rpcHandler,
  type SceneRpcHandler, type MM2M_ReservePublicMap, type M2MM_ReservePublicMap } from "#tiangz/model";

@rpcHandler(MapHostScene, PublicMapHostProtocol.Reserve)
export class ReservePublicMapHandler implements SceneRpcHandler<MapHostScene, MM2M_ReservePublicMap, M2MM_ReservePublicMap> {
  /** 目标宿主确认实际可用席位，返回有界有效期。 / Confirms an actual target-host seat with a bounded expiry. */
  handle(scene: MapHostScene, request: MM2M_ReservePublicMap): M2MM_ReservePublicMap {
    const host = scene.GetComponent(MapHostComponent);
    const expiresAtMs = host.ReservePublicMap(request.mapInstanceId, request.characterId);
    return { rpcId: request.rpcId, accepted: expiresAtMs > 0, expiresAtMs: BigInt(expiresAtMs), hostOccupied: host.LoadSnapshot().playerCount };
  }
}
