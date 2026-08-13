import {
  type M2M_AbortPlayerTransfer,
  type M2M_AbortPlayerTransferResponse,
  MapHostComponent,
  MapHostScene,
  MapTransferProtocol,
  rpcHandler,
  type SceneRpcHandler,
} from "#tiangz/model";

@rpcHandler(MapHostScene, MapTransferProtocol.Abort)
export class M2M_AbortPlayerTransferHandler implements SceneRpcHandler<
  MapHostScene,
  M2M_AbortPlayerTransfer,
  M2M_AbortPlayerTransferResponse
> {
  /** 销毁未提交候选；已提交事务不会因迟到的Abort倒退。 / Disposes an uncommitted candidate while refusing to roll back a committed transfer after a late Abort. */
  handle(
    scene: MapHostScene,
    request: M2M_AbortPlayerTransfer,
  ): M2M_AbortPlayerTransferResponse {
    return scene.GetComponent(MapHostComponent).AbortIncomingTransfer(request);
  }
}
