import {
  BuffComponent,
  type BeforeCastSkillEvent,
  GameErrCode,
  MapScene,
  SkillEvents,
  SystemErrCode,
  vetoEventHandler,
  type VetoSceneEventHandler,
} from "#tiangz/model";

/** 按技能声明的阻断Buff进行只读否决；BuffComponent仍保留结算时的最终冲突兜底。 / Read-only veto for a skill's declared blocking Buff; BuffComponent keeps the final conflict invariant during resolution. */
@vetoEventHandler(MapScene, SkillEvents.BeforeCast, {
  id: "skill.before-cast.required-absent-buff",
  order: 300,
})
export class BeforeCastRequiredAbsentBuffVeto implements VetoSceneEventHandler<
  MapScene,
  BeforeCastSkillEvent,
  number
> {
  Handle(_scene: MapScene, event: BeforeCastSkillEvent): number {
    const buffConfigId = event.definition.requiredAbsentBuffConfigId;
    return buffConfigId > 0 && event.target.GetComponent(BuffComponent).HasBuffConfig(buffConfigId)
      ? GameErrCode.SkillBlockedByBuff
      : SystemErrCode.Success;
  }
}
