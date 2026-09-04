import {
  MapScene,
  NpcComponent,
  NpcContentInteractionTrigger,
  QuestEvents,
  syncEventHandler,
  type QuestRewardedEvent,
  type SyncSceneEventHandler,
} from "#tiangz/model";

/**
 * 将已提交的任务奖励投影为内容拥有的 NPC 表现规则；奖励效果和任务状态仍属于 QuestComponent。
 * Projects a committed quest reward into content-owned NPC presentation
 * rules. Reward effects and quest state remain inside QuestComponent; this
 * handler only forwards the stable source NPC and quest id.
 */
@syncEventHandler(MapScene, QuestEvents.Rewarded, {
  id: "npc.interaction.quest-rewarded",
  order: 100,
})
export class NpcQuestRewardInteractionEventHandler
implements SyncSceneEventHandler<MapScene, QuestRewardedEvent> {
  Handle(scene: MapScene, event: QuestRewardedEvent): void {
    if (event.sourceUnitId <= 0) return;
    scene.GetComponent(NpcComponent).TriggerInteraction(
      event.player,
      event.sourceUnitId,
      NpcContentInteractionTrigger.QuestRewarded,
      event.questConfigId,
    );
  }
}
