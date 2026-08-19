import {
  clientMessageHandler,
  type ClientMessageHandler,
} from "../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_CombatResult } from "../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { GameBootstrap3D } from "../GameBootstrap3D";
import { MapMessageScope3D } from "../MapMessageScope3D";

/** 只处理受击者/攻击者收到的精确战斗结果；旁观者继续消费1Hz AOI Numeric。 / Handles exact combat results for participants; bystanders keep consuming 1 Hz AOI Numeric. */
@clientMessageHandler(MapMessageScope3D, ClientMessages.CombatResult)
export class G2C_CombatResultHandler implements ClientMessageHandler<GameBootstrap3D, G2C_CombatResult> {
  handle(world: GameBootstrap3D, message: G2C_CombatResult): void {
    world.ApplyCombatResult(message);
  }
}
