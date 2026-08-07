import { clientMessageHandler, type ClientMessageHandler } from "../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_SkillProjectile } from "../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { GameBootstrap3D } from "../GameBootstrap3D";
import { MapMessageScope3D } from "../MapMessageScope3D";

/** 弹道Handler只转发表现事件，不在客户端决定命中。 / Forwards projectile visuals without deciding impact on the client. */
@clientMessageHandler(MapMessageScope3D, ClientMessages.SkillProjectile)
export class G2C_SkillProjectileHandler implements ClientMessageHandler<GameBootstrap3D, G2C_SkillProjectile> {
  handle(world: GameBootstrap3D, message: G2C_SkillProjectile): void {
    world.ApplySkillProjectile(message);
  }
}
