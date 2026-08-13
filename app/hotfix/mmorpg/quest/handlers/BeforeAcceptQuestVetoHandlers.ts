import {
  type BeforeAcceptQuestEvent,
  GameErrCode,
  MapScene,
  NumericComponent,
  NumericType,
  QuestEvents,
  SystemErrCode,
  vetoEventHandler,
  type VetoSceneEventHandler,
} from "#tiangz/model";

/** 前置任务只读取完成事实；QuestComponent仍在提交前重复校验最终不变量。 / Prerequisites read only completed facts; QuestComponent repeats the final invariant before commit. */
@vetoEventHandler(MapScene, QuestEvents.BeforeAccept, {
  id: "quest.before-accept.prerequisites",
  order: 100,
})
export class BeforeAcceptQuestPrerequisiteVeto implements VetoSceneEventHandler<MapScene, BeforeAcceptQuestEvent, number> {
  Handle(_scene: MapScene, event: BeforeAcceptQuestEvent): number {
    return event.config.requiredQuestIds.every((id) => event.quests.HasCompletedQuest(id))
      ? SystemErrCode.Success
      : GameErrCode.QuestPrerequisiteNotMet;
  }
}

/** 等级条件读取普通Numeric；不得在否决链中补等级、自动完成前置任务或产生其他副作用。 / The level condition reads Numeric only and must not mutate level, auto-complete prerequisites, or create side effects. */
@vetoEventHandler(MapScene, QuestEvents.BeforeAccept, {
  id: "quest.before-accept.minimum-level",
  order: 200,
})
export class BeforeAcceptQuestMinimumLevelVeto implements VetoSceneEventHandler<MapScene, BeforeAcceptQuestEvent, number> {
  Handle(_scene: MapScene, event: BeforeAcceptQuestEvent): number {
    return event.player.GetComponent(NumericComponent)[NumericType.Level] >= BigInt(event.config.minimumLevel)
      ? SystemErrCode.Success
      : GameErrCode.QuestLevelTooLow;
  }
}
