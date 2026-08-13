import {
  type C2M_AcceptQuest,
  type M2C_AcceptQuest,
  MapProtocol,
  NpcComponent,
  PlayerUnit,
  QuestComponent,
  QuestStatus,
  unitRpcHandler,
  type UnitRpcHandler,
} from "#tiangz/model";

@unitRpcHandler(PlayerUnit, MapProtocol.AcceptQuest)
export class C2M_AcceptQuestHandler implements UnitRpcHandler<PlayerUnit, C2M_AcceptQuest, M2C_AcceptQuest> {
  handle(unit: PlayerUnit, request: C2M_AcceptQuest): M2C_AcceptQuest {
    unit.DomainScene().GetComponent(NpcComponent).ValidateQuestInteraction(
      unit,
      request.npcUnitId,
      request.questConfigId,
    );
    return { quest: toProtocolQuest(unit.GetComponent(QuestComponent).AcceptQuest(request.questConfigId)) };
  }
}

function toProtocolQuest(value: import("#tiangz/model").QuestState): M2C_AcceptQuest["quest"] {
  return {
    questConfigId: value.questConfigId,
    objectives: value.objectives.map((item) => ({ ...item })),
    status: value.status,
    revision: value.revision,
    readyToComplete: value.status === QuestStatus.ReadyToTurnIn,
  };
}
