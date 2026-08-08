import { clientMessageHandler, type ClientMessageHandler } from "../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_QuestProgress } from "../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { GameBootstrap3D } from "../GameBootstrap3D";
import { MapMessageScope3D } from "../MapMessageScope3D";

/** 任务推送独立于场景构造注册，避免GameBootstrap继续堆积socket.on。 / Keeps quest pushes out of scene constructor subscriptions. */
@clientMessageHandler(MapMessageScope3D, ClientMessages.QuestProgress)
export class G2C_QuestProgressHandler implements ClientMessageHandler<GameBootstrap3D, G2C_QuestProgress> {
  handle(world: GameBootstrap3D, message: G2C_QuestProgress): void { world.ApplyQuestProgress(message); }
}
