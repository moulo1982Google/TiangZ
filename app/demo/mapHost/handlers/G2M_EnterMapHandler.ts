import {
  rpcHandler,
  type SceneRpcHandler,
} from "../../../core/process/sceneHandlers";
import type {
  G2M_EnterMap,
  M2G_EnterMap,
} from "../../../generated/model/server/demo/protocol/messages";
import { MapProtocol } from "../../../generated/model/server/demo/protocol/rpcs";
import { MapHostScene } from "../../scenes/MapHostScene";
import { MapHostComponent } from "../MapHostComponent";

@rpcHandler(MapHostScene, MapProtocol.EnterMap)
export class G2M_EnterMapHandler implements SceneRpcHandler<
  MapHostScene,
  G2M_EnterMap,
  M2G_EnterMap
> {
  handle(scene: MapHostScene, request: G2M_EnterMap): Promise<M2G_EnterMap> {
    return scene.GetComponent(MapHostComponent).enterMap(request);
  }
}
