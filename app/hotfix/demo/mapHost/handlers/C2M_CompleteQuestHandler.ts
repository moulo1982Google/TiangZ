import {
  type C2M_CompleteQuest,
  type M2C_CompleteQuest,
  MapComponent,
  MapProtocol,
  PlayerUnit,
  QuestComponent,
  unitRpcHandler,
  type UnitRpcHandler,
} from "#tiangz/model";

@unitRpcHandler(PlayerUnit, MapProtocol.CompleteQuest)
export class C2M_CompleteQuestHandler implements UnitRpcHandler<PlayerUnit, C2M_CompleteQuest, M2C_CompleteQuest> {
  async handle(unit: PlayerUnit, request: C2M_CompleteQuest): Promise<M2C_CompleteQuest> {
    const result = await unit.GetComponent(QuestComponent).CompleteQuest(request.questConfigId);
    const map = unit.DomainScene().GetComponent(MapComponent);
    for (const item of result.rewardItems) await map.PublishItemChanged(unit, item);
    return { questConfigId: result.questConfigId, rewardItems: [...result.rewardItems] };
  }
}
