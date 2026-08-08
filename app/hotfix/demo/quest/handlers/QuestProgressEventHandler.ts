import {
  MapComponent,
  MapScene,
  QuestComponent,
  QuestEvents,
  type QuestProgressEvent,
  syncEventHandler,
  type SyncSceneEventHandler,
} from "#tiangz/model";

/**
 * 把击杀、用道具和进图等领域事实统一投影为任务进度；发布失败不回滚已提交进度。
 * 监听器无实例状态且使用稳定ID，因此Hotfix切换不会把旧闭包挂在玩家身上。
 *
 * Projects kill, item-use, and map-entry facts into quest progress. Delivery
 * failure never rolls back committed progress. The stateless stable-ID handler
 * leaves no old-generation closure attached to players across hot reload.
 */
@syncEventHandler(MapScene, QuestEvents.Progress, { id: "quest.progress.apply" })
export class QuestProgressEventHandler implements SyncSceneEventHandler<MapScene, QuestProgressEvent> {
  Handle(scene: MapScene, event: QuestProgressEvent): void {
    const changed = event.player.GetComponent(QuestComponent).ApplyProgress(event);
    if (changed.length === 0) return;
    scene.Tasks.Spawn("publish-quest-progress", async () => {
      await scene.GetComponent(MapComponent).PublishQuestProgress(event.player, changed);
    });
  }
}
