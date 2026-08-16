import {
  MapProtocol,
  NpcShopComponent,
  PlayerUnit,
  type C2M_OpenNpcShop,
  type M2C_OpenNpcShop,
  type UnitRpcHandler,
  unitRpcHandler,
} from "#tiangz/model";

/** 把打开商店请求交给地图级商店组件；Handler不读取价格，也不修改背包。 / Delegates shop opening to the map shop component; the Handler never reads prices or mutates inventory. */
@unitRpcHandler(PlayerUnit, MapProtocol.OpenNpcShop)
export class C2M_OpenNpcShopHandler implements UnitRpcHandler<PlayerUnit, C2M_OpenNpcShop, M2C_OpenNpcShop> {
  handle(unit: PlayerUnit, request: C2M_OpenNpcShop): M2C_OpenNpcShop {
    return unit.DomainScene().GetComponent(NpcShopComponent).Open(unit, request.npcUnitId);
  }
}
