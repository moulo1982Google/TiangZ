import { defineVetoEvent, SystemErrCode } from "../../../core/public";
import type { ItemConfig } from "../../../generated/model/config";
import type { PlayerUnit } from "../map/PlayerUnit";
import type { ItemView } from "./Item";

/**
 * 道具真正扣除前的只读检查上下文。
 * Veto监听器只能读取这些对象并返回错误码，不得扣道具、加Buff、改Numeric或启动异步任务。
 *
 * Read-only validation context before an item is consumed. Veto listeners may
 * inspect these objects and return an error code, but must not consume items,
 * add Buffs, mutate Numerics, or start asynchronous work.
 */
export interface BeforeUseItemEvent {
  readonly unit: PlayerUnit;
  readonly item: ItemView;
  readonly config: ItemConfig;
}

export const ItemEvents = {
  /** 所有检查返回Success后，调用方才可以执行不可逆的道具消耗和Action。 / The caller may perform irreversible consumption and Actions only after every check returns Success. */
  BeforeUse: defineVetoEvent<BeforeUseItemEvent, number>(
    "Item.BeforeUse",
    SystemErrCode.Success,
  ),
} as const;
