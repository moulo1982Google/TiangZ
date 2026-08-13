import {
  type C2M_NavigateInput,
  type M2C_NavigateInput,
  MapProtocol,
  PlayerUnit,
  unitRpcHandler,
  type UnitRpcHandler,
} from "#tiangz/model";

@unitRpcHandler(PlayerUnit, MapProtocol.NavigateInput)
export class C2M_NavigateInputHandler implements UnitRpcHandler<
  PlayerUnit,
  C2M_NavigateInput,
  M2C_NavigateInput
> {
  /** 只把方向意图交给玩家业务；Handler不持有按键、路径或坐标。 / Delegates direction intent only; the handler owns no keys, path, or position. */
  handle(unit: PlayerUnit, request: C2M_NavigateInput): M2C_NavigateInput {
    return unit.NavigateInput(request);
  }
}
