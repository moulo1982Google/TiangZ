import {
  type C2M_TriggerMonsterSignal,
  type M2C_TriggerMonsterSignal,
  MapProtocol,
  MonsterComponent,
  PlayerUnit,
  unitRpcHandler,
  type UnitRpcHandler,
} from "#tiangz/model";

/**
 * 外部协议适配器只提交已解码的不透明内容信号；Core负责Unit身份、AOI可见性和有序分发。
 * An external protocol adapter submits only a decoded opaque content signal;
 * Core owns Unit identity, AOI visibility, and ordered dispatch.
 */
@unitRpcHandler(PlayerUnit, MapProtocol.TriggerMonsterSignal)
export class C2M_TriggerMonsterSignalHandler
  implements UnitRpcHandler<PlayerUnit, C2M_TriggerMonsterSignal, M2C_TriggerMonsterSignal> {
  handle(unit: PlayerUnit, request: C2M_TriggerMonsterSignal): M2C_TriggerMonsterSignal {
    return {
      accepted: unit.DomainScene().GetComponent(MonsterComponent).TriggerContentSignal(
        unit,
        request.monsterUnitId,
        request.signalId,
      ),
    };
  }
}
