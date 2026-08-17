import {
  CurrencyComponent,
  GameConfigs,
  GameErrCode,
  ItemComponent,
  MapComponent,
  NpcComponent,
  NpcShopComponent,
  PlayerPersistenceComponent,
  type C2M_BuyNpcShopItem,
  type C2M_SellItem,
  type ItemSnapshot,
  type M2C_BuyNpcShopItem,
  type M2C_OpenNpcShop,
  type M2C_SellItem,
  RpcError,
  systemFor,
  utf8Encode,
} from "#tiangz/model";
import {
  DecodeNpcShopReceipt,
  EncodeNpcShopReceipt,
  ValidateNpcShopReceipt,
  type NpcShopBuyReceipt,
  type NpcShopSellReceipt,
} from "./NpcShopTransaction";
import { attachInventoryRecovery } from "../item/InventoryRecovery";

// Starter商店出售一红一蓝；大型生命药水仍可由怪物掉落，避免把掉落表和商店目录绑死。
// The starter shop sells one health potion and one mana potion; the large health
// potion remains a monster drop so the loot table and shop catalog stay separate.
const SHOP_ITEM_CONFIG_IDS = [1001, 1003] as const;
const SHOP_OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const MAX_SHOP_COUNT = 99;

/**
 * NPC商店只负责业务规则和事务编排；金币、Item Entity和持久化仍归玩家组件所有。
 * The NPC shop owns rules and transaction orchestration; currency, Item Entities,
 * and persistence remain owned by the PlayerUnit components.
 */
@systemFor(NpcShopComponent)
export class NpcShopComponentSystem extends NpcShopComponent {
  protected override Awake(npc: NpcComponent): void {
    this.npc = npc;
  }

  /** 商店只持有Npc索引，不创建独立资源；地图销毁时由Component生命周期释放。 / The shop only holds an NPC index and owns no separate resource; map teardown releases it through Component lifecycle. */
  protected override OnDestroy(): void {}

  Open(player: import("#tiangz/model").PlayerUnit, npcUnitId: number): M2C_OpenNpcShop {
    this.npc.ValidateShopInteraction(player, npcUnitId);
    const inventory = player.GetComponent(ItemComponent).Snapshot();
    const items = SHOP_ITEM_CONFIG_IDS.map((itemConfigId) => {
      const config = GameConfigs.ItemConfig.Get(itemConfigId);
      return {
        itemConfigId,
        buyPrice: BigInt(config.buyPrice),
        sellPrice: BigInt(config.sellPrice),
      };
    });
    this.DomainScene().logger.info("NPC shop opened with authoritative inventory", {
      playerAccount: player.Account,
      playerCharacterId: player.CharacterId.toString(),
      playerUnitId: player.UnitId,
      npcUnitId,
      inventoryStacks: inventory.length,
      inventoryCount: inventory.reduce((total, item) => total + item.count, 0),
      inventoryConfigIds: inventory.map((item) => item.configId),
    });
    return {
      npcUnitId,
      items,
      gold: player.GetComponent(CurrencyComponent).Gold,
      inventory: {
        items: inventory,
      },
    };
  }

  async Buy(
    player: import("#tiangz/model").PlayerUnit,
    request: C2M_BuyNpcShopItem,
  ): Promise<M2C_BuyNpcShopItem> {
    this.npc.ValidateShopInteraction(player, request.npcUnitId);
    validateOperationId(request.operationId);
    requireShopCount(request.count);
    const operationId = shopOperationId(player.Account, "buy", request.operationId);
    const persistence = player.GetComponent(PlayerPersistenceComponent);

    if (persistence.IsTransactionUncertain(operationId)) {
      const recovered = await this.tryRecoverBuy(player, request, operationId);
      if (recovered) return recovered;
    }

    const config = this.getBuyConfig(request.itemConfigId);
    const totalGold = BigInt(config.buyPrice) * BigInt(request.count);
    const currency = player.GetComponent(CurrencyComponent);
    const baseGold = currency.Gold;
    if (baseGold < totalGold) {
      throw new RpcError(GameErrCode.GoldNotEnough, `gold is not enough: need ${totalGold}`);
    }
    const inventory = player.GetComponent(ItemComponent);
    let inventoryPlan: ReturnType<ItemComponent["PlanGrantItems"]>;
    try {
      inventoryPlan = inventory.PlanGrantItems([{
        configId: request.itemConfigId,
        count: request.count,
      }]);
    } catch (error) {
      throw attachInventoryRecovery(player, error);
    }
    const gold = baseGold - totalGold;
    const receipt: NpcShopBuyReceipt = {
      version: 1,
      kind: "buy",
      npcUnitId: request.npcUnitId,
      itemConfigId: request.itemConfigId,
      count: request.count,
      baseGold,
      gold,
      items: inventoryPlan.affectedItems,
    };
    const data = persistence.Capture("npc-shop-buy", {
      items: inventoryPlan.nextItems,
      gold,
    });
    const encoded = EncodeNpcShopReceipt(receipt);

    let committed;
    try {
      committed = await persistence.ApplyTransaction(operationId, data, encoded);
    } catch (error) {
      const recovered = await this.tryRecoverBuy(player, request, operationId);
      if (recovered) return recovered;
      throw error;
    }
    const durable = DecodeNpcShopReceipt(committed.result);
    ValidateNpcShopReceipt(durable, request);
    if (durable.kind !== "buy") throw new Error("NPC shop buy returned a sell receipt");
    const items = committed.disposition === "applied" && sameBytes(committed.result, encoded)
      ? inventory.CommitGrantPlan(inventoryPlan)
      : inventory.ApplyCommittedGrantItems(durable.items);
    currency.ApplyCommittedGold(durable.gold, durable.baseGold);
    await this.publishItemChanges(player, items);
    return {
      itemConfigId: durable.itemConfigId,
      count: durable.count,
      items,
      gold: durable.gold,
    };
  }

  async Sell(
    player: import("#tiangz/model").PlayerUnit,
    request: C2M_SellItem,
  ): Promise<M2C_SellItem> {
    this.npc.ValidateShopInteraction(player, request.npcUnitId);
    validateOperationId(request.operationId);
    requireShopCount(request.count);
    const operationId = shopOperationId(player.Account, "sell", request.operationId);
    const persistence = player.GetComponent(PlayerPersistenceComponent);

    if (persistence.IsTransactionUncertain(operationId)) {
      const recovered = await this.tryRecoverSell(player, request, operationId);
      if (recovered) return recovered;
    }

    const inventory = player.GetComponent(ItemComponent);
    const current = inventory.GetItem(request.itemId);
    if (!current) {
      throw attachInventoryRecovery(
        player,
        new RpcError(GameErrCode.ItemNotFound, `item not found: ${request.itemId}`),
      );
    }
    const config = GameConfigs.ItemConfig.Get(current.configId);
    const sellPrice = BigInt(config.sellPrice);
    if (sellPrice <= 0n) {
      throw new RpcError(GameErrCode.ItemNotSellable, `item is not sellable: ${current.configId}`);
    }
    if (current.count < request.count) {
      throw attachInventoryRecovery(
        player,
        new RpcError(GameErrCode.ItemNotEnough, `item ${request.itemId} is not enough`),
      );
    }
    const inventoryPlan = inventory.PlanConsumeItem(request.itemId, request.count);
    const currency = player.GetComponent(CurrencyComponent);
    const baseGold = currency.Gold;
    const gold = baseGold + sellPrice * BigInt(request.count);
    const receipt: NpcShopSellReceipt = {
      version: 1,
      kind: "sell",
      npcUnitId: request.npcUnitId,
      itemId: request.itemId,
      itemConfigId: current.configId,
      count: request.count,
      baseGold,
      gold,
      item: inventoryPlan.consumedItem,
    };
    const data = persistence.Capture("npc-shop-sell", {
      items: inventoryPlan.nextItems,
      gold,
    });
    const encoded = EncodeNpcShopReceipt(receipt);

    let committed;
    try {
      committed = await persistence.ApplyTransaction(operationId, data, encoded);
    } catch (error) {
      const recovered = await this.tryRecoverSell(player, request, operationId);
      if (recovered) return recovered;
      throw error;
    }
    const durable = DecodeNpcShopReceipt(committed.result);
    ValidateNpcShopReceipt(durable, request);
    if (durable.kind !== "sell") throw new Error("NPC shop sell returned a buy receipt");
    const item = committed.disposition === "applied" && sameBytes(committed.result, encoded)
      ? inventory.CommitConsumePlan(inventoryPlan)
      : inventory.ApplyCommittedConsumeItem(durable.item);
    currency.ApplyCommittedGold(durable.gold, durable.baseGold);
    await this.publishItemChanges(player, [item]);
    return {
      itemConfigId: durable.itemConfigId,
      count: durable.count,
      gold: durable.gold,
      item,
    };
  }

  private async tryRecoverBuy(
    player: import("#tiangz/model").PlayerUnit,
    request: C2M_BuyNpcShopItem,
    operationId: string,
  ): Promise<M2C_BuyNpcShopItem | undefined> {
    const receipt = await player.GetComponent(PlayerPersistenceComponent).LoadTransaction(operationId);
    if (!receipt) return undefined;
    const durable = DecodeNpcShopReceipt(receipt.result);
    ValidateNpcShopReceipt(durable, request);
    if (durable.kind !== "buy") throw new Error("NPC shop recovery returned a sell receipt");
    const inventory = player.GetComponent(ItemComponent);
    const items = inventory.ApplyCommittedGrantItems(durable.items);
    player.GetComponent(CurrencyComponent).ApplyCommittedGold(durable.gold, durable.baseGold);
    await this.publishItemChanges(player, items);
    return {
      itemConfigId: durable.itemConfigId,
      count: durable.count,
      items,
      gold: durable.gold,
    };
  }

  private async tryRecoverSell(
    player: import("#tiangz/model").PlayerUnit,
    request: C2M_SellItem,
    operationId: string,
  ): Promise<M2C_SellItem | undefined> {
    const receipt = await player.GetComponent(PlayerPersistenceComponent).LoadTransaction(operationId);
    if (!receipt) return undefined;
    const durable = DecodeNpcShopReceipt(receipt.result);
    ValidateNpcShopReceipt(durable, request);
    if (durable.kind !== "sell") throw new Error("NPC shop recovery returned a buy receipt");
    const item = player.GetComponent(ItemComponent).ApplyCommittedConsumeItem(durable.item);
    player.GetComponent(CurrencyComponent).ApplyCommittedGold(durable.gold, durable.baseGold);
    await this.publishItemChanges(player, [item]);
    return {
      itemConfigId: durable.itemConfigId,
      count: durable.count,
      gold: durable.gold,
      item,
    };
  }

  private async publishItemChanges(
    player: import("#tiangz/model").PlayerUnit,
    items: readonly ItemSnapshot[],
  ): Promise<void> {
    const map = player.DomainScene().GetComponent(MapComponent);
    for (const item of items) await map.PublishItemChanged(player, item);
  }

  private getBuyConfig(itemConfigId: number): import("#tiangz/model").ItemConfigData {
    if (!(SHOP_ITEM_CONFIG_IDS as readonly number[]).includes(itemConfigId)) {
      throw new RpcError(GameErrCode.ShopItemUnavailable, `item is not sold by starter shop: ${itemConfigId}`);
    }
    const config = GameConfigs.ItemConfig.Get(itemConfigId);
    if (config.buyPrice <= 0) {
      throw new RpcError(GameErrCode.ShopItemUnavailable, `item has no buy price: ${itemConfigId}`);
    }
    return config;
  }
}

function validateOperationId(operationId: string): void {
  if (!SHOP_OPERATION_ID_PATTERN.test(operationId)) {
    throw new RpcError(GameErrCode.InvalidOperationId, "shop operationId is invalid");
  }
}

function requireShopCount(count: number): void {
  if (!Number.isSafeInteger(count) || count <= 0 || count > MAX_SHOP_COUNT) {
    throw new RpcError(GameErrCode.InvalidShopCount, `shop count must be 1-${MAX_SHOP_COUNT}`);
  }
}

function shopOperationId(account: string, kind: "buy" | "sell", clientOperationId: string): string {
  const operationId = `npc-shop:${kind}:${account}:${clientOperationId}`;
  if (utf8Encode(operationId).byteLength > 256) {
    throw new RpcError(GameErrCode.InvalidOperationId, "shop operationId exceeds DBProxy limit");
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
