import { clientMessageHandler, type ClientMessageHandler } from "../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_SkillImpact } from "../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { GameBootstrap3D } from "../GameBootstrap3D";
import { MapMessageScope3D } from "../MapMessageScope3D";

/** 命中Handler只触发表现；Numeric与Buff仍由各自状态消息维护。 / Triggers impact visuals while Numeric and Buff use their own replication streams. */
@clientMessageHandler(MapMessageScope3D, ClientMessages.SkillImpact)
export class G2C_SkillImpactHandler implements ClientMessageHandler<GameBootstrap3D, G2C_SkillImpact> {
  handle(world: GameBootstrap3D, message: G2C_SkillImpact): void {
    world.ApplySkillImpact(message);
  }
}
