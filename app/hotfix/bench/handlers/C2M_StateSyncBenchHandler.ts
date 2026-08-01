import {
  C2M_StateSyncBench,
  ItemComponent,
  MapComponent,
  type M2C_StateSyncBench,
  NumericComponent,
  NumericType,
  PlayerUnit,
  PositionComponent,
  StateSyncBenchProtocol,
  unitRpcHandler,
  type UnitRpcHandler,
} from "#tiangz/model";

const NUMERIC_MODE = 1;
const PLAYER_INFO_MODE = 2;
const ITEM_MODE = 3;

@unitRpcHandler(PlayerUnit, StateSyncBenchProtocol.Trigger)
export class C2M_StateSyncBenchHandler implements UnitRpcHandler<
  PlayerUnit,
  C2M_StateSyncBench,
  M2C_StateSyncBench
> {
  /** 通过正常业务 API 验证 Numeric、固定字段和即时事件同步。 / Exercises Numeric, fixed-field, and immediate-event replication through normal business APIs. */
  async handle(
    unit: PlayerUnit,
    request: C2M_StateSyncBench,
  ): Promise<M2C_StateSyncBench> {
    switch (request.mode) {
      case NUMERIC_MODE: {
        const numeric = unit.GetComponent(NumericComponent);
        numeric[NumericType.CurrentHp] += 1n;
        break;
      }
      case PLAYER_INFO_MODE: {
        const position = unit.GetComponent(PositionComponent);
        position.SpeedCellsPerSecond = request.sequence % 2 === 0 ? 10 : 11;
        break;
      }
      case ITEM_MODE: {
        const inventory = unit.GetComponent(ItemComponent);
        const itemId = inventory.Snapshot()[0]?.itemId;
        if (itemId === undefined) throw new Error("state sync benchmark item is missing");
        const item = inventory.AddItem(itemId, 1);
        await unit.DomainScene().GetComponent(MapComponent).PublishItemChanged(unit, item);
        break;
      }
      default:
        throw new Error(`unsupported state sync benchmark mode: ${request.mode}`);
    }
    return { mode: request.mode, sequence: request.sequence };
  }
}
