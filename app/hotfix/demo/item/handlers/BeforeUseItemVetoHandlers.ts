import {
  type BeforeUseItemEvent,
  GameErrCode,
  ItemEvents,
  MapScene,
  SystemErrCode,
  vetoEventHandler,
  type VetoSceneEventHandler,
} from "#tiangz/model";

/** 玩家死亡规则独立否决道具使用；以后死亡模块改变表示方式时只修改这个监听器。 / Independently vetoes item use for dead players so future death-state changes remain local to this listener. */
@vetoEventHandler(MapScene, ItemEvents.BeforeUse, {
  id: "item.before-use.player-alive",
  order: 100,
})
export class BeforeUseItemPlayerAliveVeto implements VetoSceneEventHandler<
  MapScene,
  BeforeUseItemEvent,
  number
> {
  Handle(_scene: MapScene, event: BeforeUseItemEvent): number {
    return !event.unit.IsAlive()
      ? GameErrCode.PlayerDead
      : SystemErrCode.Success;
  }
}

/** 道具配置规则独立否决不可使用的物品；不在RPC Handler中写死所有Item类型。 / Independently vetoes unusable item configs without hard-coding every item type in the RPC Handler. */
@vetoEventHandler(MapScene, ItemEvents.BeforeUse, {
  id: "item.before-use.config-usable",
  order: 200,
})
export class BeforeUseItemConfigVeto implements VetoSceneEventHandler<
  MapScene,
  BeforeUseItemEvent,
  number
> {
  Handle(_scene: MapScene, event: BeforeUseItemEvent): number {
    return event.config.useEffect === 0
      ? GameErrCode.ItemNotUsable
      : SystemErrCode.Success;
  }
}

/** 背包数量规则在真正扣除前提供明确错误；ItemComponent仍保留最终不变量校验。 / Reports quantity rejection before consumption while ItemComponent retains the final invariant check. */
@vetoEventHandler(MapScene, ItemEvents.BeforeUse, {
  id: "item.before-use.stack-not-empty",
  order: 300,
})
export class BeforeUseItemCountVeto implements VetoSceneEventHandler<
  MapScene,
  BeforeUseItemEvent,
  number
> {
  Handle(_scene: MapScene, event: BeforeUseItemEvent): number {
    return event.item.count <= 0
      ? GameErrCode.ItemNotEnough
      : SystemErrCode.Success;
  }
}
