import {
  unitRpcHandler,
  type UnitRpcHandler,
} from "../../core/public";
import type {
  C2M_StateSyncBench,
  M2C_StateSyncBench,
} from "../../generated/model/server/bench/protocol/messages";
import { StateSyncBenchProtocol } from "../../generated/model/server/bench/protocol/rpcs";
import { ItemComponent } from "../../demo/item/ItemComponent";
import { MapComponent } from "../../demo/map/MapComponent";
import { PlayerUnit } from "../../demo/map/PlayerUnit";
import { PositionComponent } from "../../demo/map/PositionComponent";
import { NumericComponent } from "../../demo/numeric/NumericComponent";
import { NumericType } from "../../demo/numeric/NumericType";

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
        numeric[NumericType.CurrentHp] += 1;
        break;
      }
      case PLAYER_INFO_MODE: {
        const position = unit.GetComponent(PositionComponent);
        position.SpeedCellsPerSecond = request.sequence % 2 === 0 ? 10 : 11;
        break;
      }
      case ITEM_MODE: {
        const item = unit.GetComponent(ItemComponent).AddItem(1, 1);
        await unit.DomainScene().GetComponent(MapComponent).PublishItemChanged(unit, item);
        break;
      }
      default:
        throw new Error(`unsupported state sync benchmark mode: ${request.mode}`);
    }
    return { mode: request.mode, sequence: request.sequence };
  }
}
