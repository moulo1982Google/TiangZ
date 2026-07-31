import {
  type G2M_InitialSnapshot,
  type M2G_InitialSnapshot,
  MapHostComponent,
  MapHostScene,
  MapProtocol,
  rpcHandler,
  type SceneRpcHandler,
} from "#tiangz/model";

@rpcHandler(MapHostScene, MapProtocol.InitialSnapshot)
export class G2M_InitialSnapshotHandler implements SceneRpcHandler<
  MapHostScene,
  G2M_InitialSnapshot,
  M2G_InitialSnapshot
> {
  /** 请求MapHost向已就绪客户端发送初始AOI快照。 / Requests initial AOI delivery to a ready client. */
  handle(
    scene: MapHostScene,
    request: G2M_InitialSnapshot,
  ): Promise<M2G_InitialSnapshot> {
    return scene.GetComponent(MapHostComponent).PublishInitialSnapshot(request);
  }
}
