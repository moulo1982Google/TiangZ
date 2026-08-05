import {
  clientMessageHandler,
  type ClientMessageHandler,
} from "../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_EntityState } from "../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { GameBootstrap3D } from "../GameBootstrap3D";
import { MapMessageScope3D } from "../MapMessageScope3D";

/** 3D演示独立接收alive字段变化；死亡隐藏表现，复活重新激活原节点。 / Keeps alive updates separate; death hides presentation and respawn reactivates the original node. */
@clientMessageHandler(MapMessageScope3D, ClientMessages.EntityState)
export class G2C_EntityStateHandler implements ClientMessageHandler<GameBootstrap3D, G2C_EntityState> {
  handle(world: GameBootstrap3D, message: G2C_EntityState): void {
    world.ApplyEntityState(message);
  }
}
