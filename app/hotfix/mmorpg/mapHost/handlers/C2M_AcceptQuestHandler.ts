import {
  type C2M_AcceptQuest,
  type M2C_AcceptQuest,
  MapProtocol,
  InteractableComponent,
  NpcComponent,
  PlayerUnit,
  QuestComponent,
  QuestStatus,
  unitRpcHandler,
  type UnitRpcHandler,
} from "#tiangz/model";

@unitRpcHandler(PlayerUnit, MapProtocol.AcceptQuest)
export class C2M_AcceptQuestHandler implements UnitRpcHandler<PlayerUnit, C2M_AcceptQuest, M2C_AcceptQuest> {
  async handle(unit: PlayerUnit, request: C2M_AcceptQuest): Promise<M2C_AcceptQuest> {
    const npcs = unit.DomainScene().GetComponent(NpcComponent);
    if (npcs.Get(request.npcUnitId)) {
      npcs.ValidateQuestOffer(unit, request.npcUnitId, request.questConfigId);
    } else {
      unit.DomainScene().GetComponent(InteractableComponent).ValidateQuestOffer(
        unit,
        request.npcUnitId,
        request.questConfigId,
      );
    }
    const result = await unit.GetComponent(QuestComponent).AcceptQuestDurable(
      request.questConfigId,
      request.npcUnitId,
    );
    return {
      quest: toProtocolQuest(result.quest),
      inventoryChanges: result.inventoryChanges.map((item) => ({ ...item })),
      inventoryItems: result.inventoryItems.map((item) => ({ ...item })),
      baseInventoryItems: result.baseInventoryItems.map((item) => ({ ...item })),
    };
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
