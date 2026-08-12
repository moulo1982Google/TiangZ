import {
  MapProtocol,
  PlayerUnit,
  type C2M_InspectLootMonster,
  type M2C_InspectLootMonster,
  type UnitRpcHandler,
  unitRpcHandler,
} from "#tiangz/model";

/** 查看尸体只读取当前玩家可见掉落；真正领取仍必须走LootMonster事务。 / Inspecting only reads eligible rows; claiming still goes through the LootMonster transaction. */
@unitRpcHandler(PlayerUnit, MapProtocol.InspectLootMonster)
export class C2M_InspectLootMonsterHandler implements UnitRpcHandler<
  PlayerUnit,
  C2M_InspectLootMonster,
  M2C_InspectLootMonster
> {
  handle(unit: PlayerUnit, request: C2M_InspectLootMonster): M2C_InspectLootMonster {
    return unit.InspectLootMonster(request.monsterId);
  }
}
