import { clientMessageHandler, type ClientMessageHandler } from "../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_SkillCastState } from "../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { GameBootstrap3D } from "../GameBootstrap3D";
import { MapMessageScope3D } from "../MapMessageScope3D";

/** 施法状态独立于移动消息；读条完成、打断和冷却都由服务器状态驱动。 / Keeps cast state independent from movement; completion, interruption, and cooldowns are server-driven. */
@clientMessageHandler(MapMessageScope3D, ClientMessages.SkillCastState)
export class G2C_SkillCastStateHandler implements ClientMessageHandler<GameBootstrap3D, G2C_SkillCastState> {
  handle(world: GameBootstrap3D, message: G2C_SkillCastState): void {
    world.ApplySkillCastState(message);
  }
}
