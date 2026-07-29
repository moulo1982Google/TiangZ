import {
  type M2M_CommitPlayerTransfer,
  type M2M_CommitPlayerTransferResponse,
  MapHostComponent,
  MapHostScene,
  MapTransferProtocol,
  rpcHandler,
  type SceneRpcHandler,
} from "#tiangz/model";

@rpcHandler(MapHostScene, MapTransferProtocol.Commit)
export class M2M_CommitPlayerTransferHandler implements SceneRpcHandler<
  MapHostScene,
  M2M_CommitPlayerTransfer,
  M2M_CommitPlayerTransferResponse
> {
  /** 发布目标Unit并返回新Actor位置；同一transferId只提交一次。 / Publishes the target Unit and returns its new Actor location, committing each transferId only once. */
  handle(
    scene: MapHostScene,
    request: M2M_CommitPlayerTransfer,
  ): Promise<M2M_CommitPlayerTransferResponse> {
    return scene.GetComponent(MapHostComponent).CommitIncomingTransfer(request);
  }
}
