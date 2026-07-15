import {
  actorRpcHandler,
  type ActorRpcHandler,
} from "../../../core/process/actorHandlers";
import type {
  C2M_MapProbe,
  M2C_MapProbe,
} from "../../../generated/model/server/demo/protocol/messages";
import { MapProtocol } from "../../../generated/model/server/demo/protocol/rpcs";
import { PlayerUnit } from "../../map/PlayerUnit";

@actorRpcHandler(PlayerUnit, MapProtocol.Probe)
export class C2M_MapProbeHandler implements ActorRpcHandler<
  PlayerUnit,
  C2M_MapProbe,
  M2C_MapProbe
> {
  handle(_unit: PlayerUnit, request: C2M_MapProbe): M2C_MapProbe {
    return { sequence: request.sequence };
  }
}
