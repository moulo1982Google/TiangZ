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
  /** 回显序列号用于全链路延迟测量，不修改玩家状态。 / Echoes a sequence for full-chain latency measurement without mutating player state. */
  handle(_unit: PlayerUnit, request: C2M_MapProbe): M2C_MapProbe {
    return { sequence: request.sequence };
  }
}
