import {
  type G2M_TransferPlayer,
  type M2G_TransferPlayer,
  MapComponent,
  MapProtocol,
  PlayerUnit,
  unitRpcHandler,
  type UnitRpcHandler,
} from "#tiangz/model";

@unitRpcHandler(PlayerUnit, MapProtocol.TransferPlayer)
export class G2M_TransferPlayerHandler implements UnitRpcHandler<
  PlayerUnit,
  G2M_TransferPlayer,
  M2G_TransferPlayer
> {
  /** 从源Unit mailbox进入统一迁移协调器，避免Gate区分本地或远程MapHost。 / Enters the unified migration coordinator from the source Unit mailbox so Gate never branches on local versus remote hosting. */
  handle(unit: PlayerUnit, request: G2M_TransferPlayer): Promise<M2G_TransferPlayer> {
    return unit.DomainScene().GetComponent(MapComponent).TransferPlayer(unit, request);
  }
}
