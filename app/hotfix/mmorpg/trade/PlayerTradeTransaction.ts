import {
  GameConfigs,
  GlobalIdSystem,
  type ItemSnapshot,
  type PlayerTradeOfferState,
  utf8Decode,
  utf8Encode,
} from "#tiangz/model";

const TRADE_RECEIPT_VERSION = 1;

export interface PlayerTradeParticipantPlan {
  readonly characterId: bigint;
  readonly baseGold: bigint;
  readonly gold: bigint;
  readonly baseItems: readonly ItemSnapshot[];
  readonly nextItems: readonly ItemSnapshot[];
}

export interface PlayerTradeReceipt {
  readonly version: typeof TRADE_RECEIPT_VERSION;
  readonly tradeId: string;
  readonly requester: PlayerTradeParticipantPlan;
  readonly target: PlayerTradeParticipantPlan;
}

interface TransferChunk {
  readonly source: ItemSnapshot;
  readonly count: number;
  readonly reusableItemId: boolean;
}

/**
 * 在纯值快照上同时规划两边金币和Item所有权变化；整个函数不修改Entity，也不访问DBProxy。
 * 完整计划会进入多记录事务回执，ACK丢失时禁止重新分配ItemId。
 *
 * Plans both currency and Item ownership changes on value snapshots without
 * mutating Entities or accessing DBProxy. The complete plan is stored in the
 * multi-record receipt so lost ACK recovery never allocates different ItemIds.
 */
export function PlanPlayerTrade(
  tradeId: string,
  requesterCharacterId: bigint,
  requesterGold: bigint,
  requesterItems: readonly ItemSnapshot[],
  requesterOffer: PlayerTradeOfferState,
  targetCharacterId: bigint,
  targetGold: bigint,
  targetItems: readonly ItemSnapshot[],
  targetOffer: PlayerTradeOfferState,
): PlayerTradeReceipt {
  requireTradeId(tradeId);
  requireDistinctCharacters(requesterCharacterId, targetCharacterId);
  requireGoldOffer(requesterOffer.gold, requesterGold);
  requireGoldOffer(targetOffer.gold, targetGold);

  const requesterRemoved = removeOfferedItems(requesterItems, requesterOffer);
  const targetRemoved = removeOfferedItems(targetItems, targetOffer);
  const requesterNext = receiveItems(requesterRemoved.items, targetRemoved.transfers);
  const targetNext = receiveItems(targetRemoved.items, requesterRemoved.transfers);
  return {
    version: TRADE_RECEIPT_VERSION,
    tradeId,
    requester: {
      characterId: requesterCharacterId,
      baseGold: requesterGold,
      gold: requesterGold - requesterOffer.gold + targetOffer.gold,
      baseItems: sortItems(requesterItems),
      nextItems: requesterNext,
    },
    target: {
      characterId: targetCharacterId,
      baseGold: targetGold,
      gold: targetGold - targetOffer.gold + requesterOffer.gold,
      baseItems: sortItems(targetItems),
      nextItems: targetNext,
    },
  };
}

export function EncodePlayerTradeReceipt(receipt: PlayerTradeReceipt): Uint8Array {
  return utf8Encode(JSON.stringify(receipt, (_key, value: unknown) => (
    typeof value === "bigint" ? { $bigint: value.toString() } : value
  )));
}

/** 解码并校验DBProxy保存的交易回执；坏回执必须终止恢复，不能根据当前背包猜测结果。 / Decodes and validates a DBProxy trade receipt; malformed receipts abort recovery instead of inferring a result from current inventories. */
export function DecodePlayerTradeReceipt(payload: Uint8Array): PlayerTradeReceipt {
  const value: unknown = JSON.parse(utf8Decode(payload), (_key, entry: unknown) => {
    if (isRecord(entry) && Object.keys(entry).length === 1 && typeof entry.$bigint === "string") {
      return BigInt(entry.$bigint);
    }
    return entry;
  });
  if (!isRecord(value) || value.version !== TRADE_RECEIPT_VERSION || typeof value.tradeId !== "string") {
    throw new Error("unsupported player trade transaction receipt");
  }
  const receipt = value as unknown as PlayerTradeReceipt;
  validateParticipant(receipt.requester, "requester");
  validateParticipant(receipt.target, "target");
  requireDistinctCharacters(receipt.requester.characterId, receipt.target.characterId);
  return receipt;
}

function removeOfferedItems(
  baseItems: readonly ItemSnapshot[],
  offer: PlayerTradeOfferState,
): { readonly items: readonly ItemSnapshot[]; readonly transfers: readonly TransferChunk[] } {
  if (offer.items.length > 16) throw new Error("player trade supports at most 16 offered item stacks");
  const working = new Map(sortItems(baseItems).map((item) => [item.itemId, { ...item }]));
  const transfers: TransferChunk[] = [];
  const seen = new Set<bigint>();
  for (const offered of [...offer.items].sort((left, right) => compareBigInt(left.itemId, right.itemId))) {
    if (seen.has(offered.itemId)) throw new Error(`duplicate offered item: ${offered.itemId}`);
    seen.add(offered.itemId);
    requirePositiveCount(offered.count);
    const current = working.get(offered.itemId);
    if (!current || current.configId !== offered.itemConfigId) {
      throw new Error(`offered item does not match inventory: ${offered.itemId}`);
    }
    const config = GameConfigs.ItemConfig.Get(current.configId);
    if (config.sellPrice <= 0) throw new Error(`item is not tradable: ${current.configId}`);
    if (offered.count > current.count) {
      throw new Error(`offered item count exceeds inventory: ${offered.itemId}`);
    }
    const remaining = current.count - offered.count;
    if (remaining === 0) working.delete(current.itemId);
    else working.set(current.itemId, { ...current, count: remaining, version: current.version + 1 });
    transfers.push({
      source: current,
      count: offered.count,
      reusableItemId: remaining === 0,
    });
  }
  return { items: sortItems([...working.values()]), transfers };
}

function receiveItems(
  baseItems: readonly ItemSnapshot[],
  transfers: readonly TransferChunk[],
): readonly ItemSnapshot[] {
  const working = new Map(sortItems(baseItems).map((item) => [item.itemId, { ...item }]));
  for (const transfer of transfers) {
    const config = GameConfigs.ItemConfig.Get(transfer.source.configId);
    let remaining = transfer.count;
    const stacks = [...working.values()]
      .filter((item) => (
        item.configId === transfer.source.configId &&
        item.quality === transfer.source.quality &&
        item.level === transfer.source.level &&
        item.count < config.maxStack
      ))
      .sort(compareItems);
    for (const stack of stacks) {
      if (remaining === 0) break;
      const amount = Math.min(config.maxStack - stack.count, remaining);
      if (amount <= 0) continue;
      remaining -= amount;
      working.set(stack.itemId, {
        ...stack,
        count: stack.count + amount,
        version: stack.version + 1,
      });
    }
    if (remaining === 0) continue;
    const itemId = transfer.reusableItemId
      ? transfer.source.itemId
      : GlobalIdSystem.Instance.Next();
    if (working.has(itemId)) throw new Error(`traded item id already exists in target inventory: ${itemId}`);
    working.set(itemId, {
      itemId,
      configId: transfer.source.configId,
      count: remaining,
      quality: transfer.source.quality,
      level: transfer.source.level,
      version: transfer.reusableItemId ? transfer.source.version + 1 : 1,
    });
  }
  return sortItems([...working.values()]);
}

function validateParticipant(value: PlayerTradeParticipantPlan, label: string): void {
  if (
    typeof value !== "object" || value === null ||
    typeof value.characterId !== "bigint" || value.characterId <= 0n ||
    typeof value.baseGold !== "bigint" || value.baseGold < 0n ||
    typeof value.gold !== "bigint" || value.gold < 0n ||
    !Array.isArray(value.baseItems) || !Array.isArray(value.nextItems)
  ) {
    throw new Error(`invalid player trade ${label} receipt`);
  }
  for (const item of [...value.baseItems, ...value.nextItems]) validateItem(item);
}

function validateItem(item: ItemSnapshot): void {
  if (
    typeof item.itemId !== "bigint" || item.itemId <= 0n ||
    !Number.isSafeInteger(item.configId) || item.configId <= 0 ||
    !Number.isSafeInteger(item.count) || item.count <= 0 ||
    !Number.isSafeInteger(item.version) || item.version <= 0
  ) {
    throw new Error("invalid item in player trade receipt");
  }
}

function requireTradeId(tradeId: string): void {
  if (!/^trade:[1-9][0-9]{0,39}$/.test(tradeId)) throw new Error(`invalid player trade id: ${tradeId}`);
}

function requireDistinctCharacters(left: bigint, right: bigint): void {
  if (left <= 0n || right <= 0n || left === right) throw new Error("player trade requires two distinct characters");
}

function requireGoldOffer(offered: bigint, available: bigint): void {
  if (offered < 0n || offered > available) throw new Error(`invalid player trade gold offer: ${offered}/${available}`);
}

function requirePositiveCount(count: number): void {
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error(`invalid player trade item count: ${count}`);
}

function sortItems(items: readonly ItemSnapshot[]): ItemSnapshot[] {
  return items.map((item) => ({ ...item })).sort(compareItems);
}

function compareItems(left: ItemSnapshot, right: ItemSnapshot): number {
  return compareBigInt(left.itemId, right.itemId);
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
