import {
  clientMessageHandler,
  type ClientMessageHandler,
} from "../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_BuffRemoved } from "../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { GameBootstrap3D } from "../GameBootstrap3D";
import { MapMessageScope3D } from "../MapMessageScope3D";

/** 只有服务端移除事件才能删除Buff图标，避免本地到期计算提前清理。 / Only the server removal event deletes the icon; local expiry never removes it early. */
@clientMessageHandler(MapMessageScope3D, ClientMessages.BuffRemoved)
export class G2C_BuffRemovedHandler implements ClientMessageHandler<GameBootstrap3D, G2C_BuffRemoved> {
  handle(world: GameBootstrap3D, message: G2C_BuffRemoved): void {
    world.ApplyBuffRemoved(message);
  }
}
