import {
  CurrencyComponent,
  GameErrCode,
  ItemComponent,
  MapComponent,
  NpcRepairComponent,
  PlayerPersistenceComponent,
  RpcError,
  systemFor,
  utf8Encode,
  type C2M_RepairItems,
  type InventoryRepairPlan,
  type ItemSnapshot,
  type M2C_RepairItems,
  type PlayerUnit,
} from "#tiangz/model";
import {
  DecodeNpcRepairReceipt,
  EncodeNpcRepairReceipt,
  ValidateNpcRepairReceipt,
  type NpcRepairReceipt,
} from "./NpcRepairTransaction";
import { attachInventoryRecovery } from "../item/InventoryRecovery";

const REPAIR_OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;

/** 编排 NPC、背包、金币与 DBProxy；不拥有任何具体游戏的槽位或价格表。 / Orchestrates NPC, inventory, currency, and DBProxy without owning game-specific slots or price tables. */
@systemFor(NpcRepairComponent)
export class NpcRepairComponentSystem extends NpcRepairComponent {
  protected override Awake(npc: import("#tiangz/model").NpcComponent): void {
    this.npc = npc;
  }

  async Repair(player: PlayerUnit, request: C2M_RepairItems): Promise<M2C_RepairItems> {
    this.npc.ValidateRepairInteraction(player, request.npcUnitId);
    validateOperationId(request.operationId);
    const operationId = repairOperationId(player.Account, request.operationId);
    const persistence = player.GetComponent(PlayerPersistenceComponent);
    if (persistence.IsTransactionUncertain(operationId)) {
      const recovered = await this.tryRecover(player, request, operationId);
      if (recovered) return recovered;
    }

    let plan: InventoryRepairPlan;
    try {
      plan = player.GetComponent(ItemComponent).PlanRepairItems(request.itemId);
    } catch (error) {
      throw attachInventoryRecovery(player, error);
    }
    const currency = player.GetComponent(CurrencyComponent);
    const baseGold = currency.Gold;
    if (plan.cost > baseGold) {
      throw new RpcError(GameErrCode.GoldNotEnough, `repair costs ${plan.cost}, available ${baseGold}`);
    }
    if (plan.affectedItems.length === 0) {
      // A successful first attempt leaves the item at full durability. Resolve a replay from
      // the durable receipt before classifying that resulting state as a fresh no-op.
      const recovered = await this.tryRecover(player, request, operationId);
      if (recovered) return recovered;
      return { cost: 0n, gold: baseGold, items: [] };
    }

    const gold = baseGold - plan.cost;
    const receipt: NpcRepairReceipt = {
      version: 1,
      npcUnitId: request.npcUnitId,
      requestedItemId: request.itemId,
      baseGold,
      gold,
      cost: plan.cost,
      baseItems: plan.baseItems,
      nextItems: plan.nextItems,
      items: plan.affectedItems,
    };
    const data = persistence.Capture("npc-repair", { items: plan.nextItems, gold });
    const encoded = EncodeNpcRepairReceipt(receipt);
    let committed;
    try {
      committed = await persistence.ApplyTransaction(
        operationId,
        ["inventory", "wallet"],
        data,
        encoded,
      );
    } catch (error) {
      const recovered = await this.tryRecover(player, request, operationId);
      if (recovered) return recovered;
      throw error;
    }
    const durable = DecodeNpcRepairReceipt(committed.result);
    ValidateNpcRepairReceipt(durable, request);
    const items = committed.disposition === "applied" && sameBytes(committed.result, encoded)
      ? player.GetComponent(ItemComponent).CommitRepairPlan(plan)
      : this.applyReceipt(player, durable);
    currency.ApplyCommittedGold(durable.gold, durable.baseGold);
    await this.publishItemChanges(player, items);
    return { cost: durable.cost, gold: durable.gold, items };
  }

  private async tryRecover(
    player: PlayerUnit,
    request: C2M_RepairItems,
    operationId: string,
  ): Promise<M2C_RepairItems | undefined> {
    const committed = await player.GetComponent(PlayerPersistenceComponent)
      .LoadTransaction(operationId, ["inventory", "wallet"]);
    if (!committed) return undefined;
    const durable = DecodeNpcRepairReceipt(committed.result);
    ValidateNpcRepairReceipt(durable, request);
    const items = this.applyReceipt(player, durable);
    player.GetComponent(CurrencyComponent).ApplyCommittedGold(durable.gold, durable.baseGold);
    await this.publishItemChanges(player, items);
    return { cost: durable.cost, gold: durable.gold, items };
  }

  private applyReceipt(player: PlayerUnit, receipt: NpcRepairReceipt): readonly ItemSnapshot[] {
    const inventory = player.GetComponent(ItemComponent);
    const next = inventory.ApplyCommittedInventoryReplace({
      baseItems: receipt.baseItems,
      nextItems: receipt.nextItems,
    });
    const byId = new Map(next.map((item) => [item.itemId, item]));
    return receipt.items.map((item) => {
      const current = byId.get(item.itemId);
      if (!current) throw new Error(`repaired item is absent after recovery: ${item.itemId}`);
      return current;
    });
  }

  private async publishItemChanges(
    player: PlayerUnit,
    items: readonly ItemSnapshot[],
  ): Promise<void> {
    const map = player.DomainScene().GetComponent(MapComponent);
    for (const item of items) await map.PublishItemChanged(player, item);
  }
}

function validateOperationId(value: string): void {
  if (!REPAIR_OPERATION_ID_PATTERN.test(value)) {
    throw new RpcError(GameErrCode.InvalidOperationId, "repair operationId is invalid");
  }
}

function repairOperationId(account: string, clientOperationId: string): string {
  const operationId = `repair:${account}:${clientOperationId}`;
  if (utf8Encode(operationId).byteLength > 256) {
    throw new RpcError(GameErrCode.InvalidOperationId, "repair operationId exceeds DBProxy limit");
  }
  return operationId;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
