import {
  MapProtocol,
  PlayerUnit,
  type C2M_LootMonster,
  type M2C_LootMonster,
  type UnitRpcHandler,
  unitRpcHandler,
} from "#tiangz/model";

/** 玩家只提交“拾取哪具尸体”；任务资格、掉落数量和持久化由地图掉落模块统一处理。 / The player submits only the corpse intent; the map loot module owns eligibility, quantity, and persistence. */
@unitRpcHandler(PlayerUnit, MapProtocol.LootMonster)
export class C2M_LootMonsterHandler implements UnitRpcHandler<
  PlayerUnit,
  C2M_LootMonster,
  M2C_LootMonster
> {
  handle(unit: PlayerUnit, request: C2M_LootMonster): Promise<M2C_LootMonster> {
    return unit.LootMonster(
      request.monsterId,
      request.operationId,
      request.dropId ?? 0,
      request.lootAll ?? false,
    );
  }
}
