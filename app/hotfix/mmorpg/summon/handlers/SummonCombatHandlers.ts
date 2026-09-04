import {
  CombatEvents,
  MapScene,
  MonsterUnit,
  PlayerUnit,
  SummonComponent,
  UnitComponent,
  syncEventHandler,
  type DamageResolvedEvent,
  type SyncSceneEventHandler,
} from "#tiangz/model";

/** 已提交的所有者伤害驱动可选协战；处理器只设置中立目标，不复制伤害。 / Committed owner damage drives optional assist targeting without duplicating damage. */
@syncEventHandler(MapScene, CombatEvents.DamageResolved, {
  id: "tiangz.mmorpg.summon.owner-assist",
  order: 100,
})
class SummonOwnerAssistHandler
implements SyncSceneEventHandler<MapScene, DamageResolvedEvent> {
  Handle(scene: MapScene, event: DamageResolvedEvent): void {
    if (event.result.finalDamage <= 0n || !(event.target instanceof MonsterUnit)) return;
    const sourceUnitId = event.request.sourceUnitId ?? 0;
    const owner = sourceUnitId > 0
      ? scene.GetComponent(UnitComponent).Get<PlayerUnit>(sourceUnitId)
      : undefined;
    if (!owner) return;
    scene.TryGetComponent(SummonComponent)?.AssistOwnerAgainst(owner, event.target);
  }
}

export {};
