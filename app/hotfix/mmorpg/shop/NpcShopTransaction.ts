import type {
  C2M_BuyNpcShopItem,
  C2M_SellItem,
  ItemSnapshot,
} from "#tiangz/model";
import { utf8Decode, utf8Encode } from "#tiangz/model";

const SHOP_RECEIPT_VERSION = 1;

export interface NpcShopBuyReceipt {
  readonly version: typeof SHOP_RECEIPT_VERSION;
  readonly kind: "buy";
  readonly npcUnitId: number;
  readonly itemConfigId: number;
  readonly count: number;
  readonly baseGold: bigint;
  readonly gold: bigint;
  readonly items: readonly ItemSnapshot[];
}

export interface NpcShopSellReceipt {
  readonly version: typeof SHOP_RECEIPT_VERSION;
  readonly kind: "sell";
  readonly npcUnitId: number;
  readonly itemId: bigint;
  readonly itemConfigId: number;
  readonly count: number;
  readonly baseGold: bigint;
  readonly gold: bigint;
  readonly item: ItemSnapshot;
}

export type NpcShopReceipt = NpcShopBuyReceipt | NpcShopSellReceipt;

/**
 * 商店事务回执只保存“已经提交的结果”，不保存Entity引用或数据库细节。
 * The shop receipt stores only the committed result; it never contains Entity references or database details.
 */
export function EncodeNpcShopReceipt(receipt: NpcShopReceipt): Uint8Array {
  return utf8Encode(JSON.stringify(receipt, (_key, value: unknown) => (
    typeof value === "bigint" ? { $bigint: value.toString() } : value
  )));
}

/** 解码并校验DBProxy返回的商店回执；坏回执必须让事务失败，不能猜测恢复。 / Decodes a DBProxy shop receipt and rejects malformed data instead of guessing recovery. */
export function DecodeNpcShopReceipt(payload: Uint8Array): NpcShopReceipt {
  const value: unknown = JSON.parse(utf8Decode(payload), (_key, entry: unknown) => {
    if (isRecord(entry) && Object.keys(entry).length === 1 && typeof entry.$bigint === "string") {
      return BigInt(entry.$bigint);
    }
    return entry;
  });
  if (!isRecord(value) || value.version !== SHOP_RECEIPT_VERSION) {
    throw new Error("unsupported NPC shop transaction receipt");
  }
  if (value.kind === "buy") {
    const receipt = value as unknown as NpcShopBuyReceipt;
    if (
      !isPositiveSafeInteger(receipt.npcUnitId) ||
      !isPositiveSafeInteger(receipt.itemConfigId) ||
      !isPositiveSafeInteger(receipt.count) ||
      typeof receipt.baseGold !== "bigint" || receipt.baseGold < 0n ||
      typeof receipt.gold !== "bigint" || receipt.gold < 0n ||
      !Array.isArray(receipt.items)
    ) {
      throw new Error("invalid NPC shop buy receipt");
    }
    return receipt;
  }
  if (value.kind === "sell") {
    const receipt = value as unknown as NpcShopSellReceipt;
    if (
      !isPositiveSafeInteger(receipt.npcUnitId) ||
      typeof receipt.itemId !== "bigint" || receipt.itemId <= 0n ||
      !isPositiveSafeInteger(receipt.itemConfigId) ||
      !isPositiveSafeInteger(receipt.count) ||
      typeof receipt.baseGold !== "bigint" || receipt.baseGold < 0n ||
      typeof receipt.gold !== "bigint" || receipt.gold < 0n ||
      !isRecord(receipt.item)
    ) {
      throw new Error("invalid NPC shop sell receipt");
    }
    return receipt;
  }
  throw new Error("unknown NPC shop transaction kind");
}

export function ValidateNpcShopReceipt(
  receipt: NpcShopReceipt,
  request: C2M_BuyNpcShopItem | C2M_SellItem,
): void {
  if (receipt.npcUnitId !== request.npcUnitId) {
    throw new Error(`NPC shop operation conflicts with NPC ${request.npcUnitId}`);
  }
  if (receipt.kind === "buy") {
    if (
      !isBuyRequest(request) ||
      receipt.itemConfigId !== request.itemConfigId ||
      receipt.count !== request.count
    ) {
      throw new Error("NPC shop buy operation conflicts with its original request");
    }
    return;
  }
  if (
    !isSellRequest(request) ||
    receipt.itemId !== request.itemId ||
    receipt.count !== request.count
  ) {
    throw new Error("NPC shop sell operation conflicts with its original request");
  }
}

function isBuyRequest(
  request: C2M_BuyNpcShopItem | C2M_SellItem,
): request is C2M_BuyNpcShopItem {
  return "itemConfigId" in request;
}

function isSellRequest(
  request: C2M_BuyNpcShopItem | C2M_SellItem,
): request is C2M_SellItem {
  return "itemId" in request;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
