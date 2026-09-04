import {
  MapScene,
  NpcComponent,
  NpcContentInteractionTrigger,
  QuestEvents,
  syncEventHandler,
  type QuestAcceptedEvent,
  type SyncSceneEventHandler,
} from "#tiangz/model";

/**
 * 将已提交的任务接取事实投影为内容拥有的 NPC 表现；任务持久化和回滚仍属于 QuestComponent。
 * Projects a committed quest-acceptance fact into content-owned NPC
 * presentations. The NPC component owns only delayed presentation state;
 * quest durability and rollback remain entirely inside QuestComponent.
 */
@syncEventHandler(MapScene, QuestEvents.Accepted, {
  id: "npc.interaction.quest-accepted",
  order: 100,
})
export class NpcQuestInteractionEventHandler
implements SyncSceneEventHandler<MapScene, QuestAcceptedEvent> {
  Handle(scene: MapScene, event: QuestAcceptedEvent): void {
    if (event.sourceUnitId <= 0) return;
    scene.GetComponent(NpcComponent).TriggerInteraction(
      event.player,
      event.sourceUnitId,
      NpcContentInteractionTrigger.QuestAccepted,
      event.quest.questConfigId,
    );
  }
}
