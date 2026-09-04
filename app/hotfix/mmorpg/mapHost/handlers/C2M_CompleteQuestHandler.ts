import {
  type C2M_CompleteQuest,
  type M2C_CompleteQuest,
  MapComponent,
  MapProtocol,
  NpcComponent,
  PlayerUnit,
  QuestComponent,
  unitRpcHandler,
  type UnitRpcHandler,
} from "#tiangz/model";

@unitRpcHandler(PlayerUnit, MapProtocol.CompleteQuest)
export class C2M_CompleteQuestHandler implements UnitRpcHandler<PlayerUnit, C2M_CompleteQuest, M2C_CompleteQuest> {
  async handle(unit: PlayerUnit, request: C2M_CompleteQuest): Promise<M2C_CompleteQuest> {
    unit.DomainScene().GetComponent(NpcComponent).ValidateQuestTurnIn(
      unit,
      request.npcUnitId,
      request.questConfigId,
    );
    const result = await unit.GetComponent(QuestComponent).CompleteQuest(
      request.questConfigId,
      request.rewardChoiceId,
      request.npcUnitId,
    );
    const map = unit.DomainScene().GetComponent(MapComponent);
    for (const item of result.inventoryChanges) await map.PublishItemChanged(unit, item);
    if (result.gainedExperience > 0n) await map.PublishProgressionChanged(unit, result);
    return {
      questConfigId: result.questConfigId,
      rewardItems: [...result.rewardItems],
      baseInventoryItems: [...result.baseInventoryItems],
      inventoryItems: [...result.inventoryItems],
      inventoryChanges: [...result.inventoryChanges],
      selectedRewardChoiceId: result.selectedRewardChoiceId,
      gold: result.gold,
      gainedGold: result.gainedGold,
      level: result.level,
      experience: result.experience,
      gainedExperience: result.gainedExperience,
      leveledUp: result.leveledUp,
    };
  }
}
