import {
  type C2M_Move,
  MapMessages,
  PlayerUnit,
  unitMessageHandler,
  type UnitMessageHandler,
} from "#tiangz/model";

@unitMessageHandler(PlayerUnit, MapMessages.Move)
export class C2M_MoveHandler implements UnitMessageHandler<
  PlayerUnit,
  C2M_Move
> {
  /**
   * 只把开始、停止或转向意图写入PlayerUnit。Rust在固定Update推进权威位置，并按AOI直接生成Gate批帧；
   * Handler不得手工查询观察者、构造EntityMove，或等待一次广播完成。
   *
   * Writes start, stop, or turn intent only. Rust advances authoritative position during fixed
   * updates and emits AOI-routed Gate batches; this handler must not query observers, construct
   * EntityMove, or await a broadcast.
   */
  handle(unit: PlayerUnit, message: C2M_Move): void {
    unit.Move(message);
  }
}
