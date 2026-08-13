import type { ItemSnapshot, M2C_UseItem } from "../../../generated/model/server/demo/protocol/messages";
import type {
  InventoryConsumePlan as GenericInventoryConsumePlan,
  InventoryGrant as GenericInventoryGrant,
  InventoryGrantPlan as GenericInventoryGrantPlan,
  ItemState,
} from "../../domains/item/ItemTypes";

/** MMORPG使用通用背包计划，但把结果投影成当前协议的ItemSnapshot。 / MMORPG uses generic inventory plans and projects results to protocol ItemSnapshot. */
export { ItemComponent } from "../../domains/item/ItemComponent";
export type InventoryGrant = GenericInventoryGrant;
export type InventoryGrantPlan = GenericInventoryGrantPlan<ItemSnapshot>;
export type InventoryConsumePlan = GenericInventoryConsumePlan<ItemSnapshot>;

export interface InventoryGrantResult {
  readonly items: readonly ItemSnapshot[];
}

export type ItemView = import("../../domains/item/Item").ItemView;
export type AwakeItem = import("../../domains/item/Item").AwakeItem;
export type ItemStateForDomain = ItemState;

/** 业务层扩展的协议提交入口仍留在MMORPG适配器，不污染通用ItemComponent。 / Protocol transaction entrypoints remain in the MMORPG adapter and do not pollute the reusable ItemComponent. */
export interface ItemComponentProtocolSurface {
  UseItemTransactional(itemId: bigint, clientOperationId: string): Promise<M2C_UseItem>;
}
