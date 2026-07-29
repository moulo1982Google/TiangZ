import {
  type M2M_PreparePlayerTransfer,
  type M2M_PreparePlayerTransferResponse,
  MapHostComponent,
  MapHostScene,
  MapTransferProtocol,
  rpcHandler,
  type SceneRpcHandler,
} from "#tiangz/model";

@rpcHandler(MapHostScene, MapTransferProtocol.Prepare)
export class M2M_PreparePlayerTransferHandler implements SceneRpcHandler<
  MapHostScene,
  M2M_PreparePlayerTransfer,
  M2M_PreparePlayerTransferResponse
> {
  /** 在目标MapHost创建不可见候选，网络重试不会重复创建Unit。 / Creates an unpublished candidate on the target MapHost without duplicating Units during network retries. */
  handle(
    scene: MapHostScene,
    request: M2M_PreparePlayerTransfer,
  ): M2M_PreparePlayerTransferResponse {
    return scene.GetComponent(MapHostComponent).PrepareIncomingTransfer(request);
  }
}
