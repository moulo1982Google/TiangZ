import {
  type C2M_TriggerNpcInteraction,
  type M2C_TriggerNpcInteraction,
  MapProtocol,
  NpcComponent,
  NpcContentInteractionTrigger,
  PlayerUnit,
  unitRpcHandler,
  type UnitRpcHandler,
} from "#tiangz/model";

/**
 * 外部协议适配器提交一个已完成校验的NPC内容事实；Core只负责距离边界与表现队列。
 * An external protocol adapter submits one validated NPC content fact; Core
 * owns only the range boundary and presentation queue.
 */
@unitRpcHandler(PlayerUnit, MapProtocol.TriggerNpcInteraction)
export class C2M_TriggerNpcInteractionHandler
  implements UnitRpcHandler<PlayerUnit, C2M_TriggerNpcInteraction, M2C_TriggerNpcInteraction> {
  handle(unit: PlayerUnit, request: C2M_TriggerNpcInteraction): M2C_TriggerNpcInteraction {
    if (!isNpcInteractionTrigger(request.trigger)) {
      return { accepted: false };
    }
    unit.DomainScene().GetComponent(NpcComponent).ValidateContentInteraction(
      unit,
      request.npcUnitId,
    );
    unit.DomainScene().GetComponent(NpcComponent).TriggerInteraction(
      unit,
      request.npcUnitId,
      request.trigger,
      request.triggerValue,
    );
    return { accepted: true };
  }
}

function isNpcInteractionTrigger(
  value: number,
): value is (typeof NpcContentInteractionTrigger)[keyof typeof NpcContentInteractionTrigger] {
  return value === NpcContentInteractionTrigger.QuestAccepted
    || value === NpcContentInteractionTrigger.QuestRewarded
    || value === NpcContentInteractionTrigger.GossipSelected;
}
