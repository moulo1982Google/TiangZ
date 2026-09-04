import { utf8Decode, utf8Encode, type C2M_RepairItems, type ItemSnapshot } from "#tiangz/model";

const REPAIR_RECEIPT_VERSION = 1;

export interface NpcRepairReceipt {
  readonly version: typeof REPAIR_RECEIPT_VERSION;
  readonly npcUnitId: number;
  readonly requestedItemId: bigint;
  readonly baseGold: bigint;
  readonly gold: bigint;
  readonly cost: bigint;
  readonly baseItems: readonly ItemSnapshot[];
  readonly nextItems: readonly ItemSnapshot[];
  readonly items: readonly ItemSnapshot[];
}

/** 编码只含已提交值的修理回执，不保存 Entity 引用。 / Encodes only committed repair values and never Entity references. */
export function EncodeNpcRepairReceipt(receipt: NpcRepairReceipt): Uint8Array {
  return utf8Encode(JSON.stringify(receipt, (_key, value: unknown) => (
    typeof value === "bigint" ? { $bigint: value.toString() } : value
  )));
}

/** 严格解码 DBProxy 回执，损坏数据不能参与恢复。 / Strictly decodes a DBProxy receipt so malformed data never participates in recovery. */
export function DecodeNpcRepairReceipt(payload: Uint8Array): NpcRepairReceipt {
  const value: unknown = JSON.parse(utf8Decode(payload), (_key, entry: unknown) => {
    if (isRecord(entry) && Object.keys(entry).length === 1 && typeof entry.$bigint === "string") {
      return BigInt(entry.$bigint);
    }
    return entry;
  });
  if (!isRecord(value) || value.version !== REPAIR_RECEIPT_VERSION) {
    throw new Error("unsupported NPC repair transaction receipt");
  }
  const receipt = value as unknown as NpcRepairReceipt;
  if (
    !Number.isSafeInteger(receipt.npcUnitId) || receipt.npcUnitId <= 0 ||
    typeof receipt.requestedItemId !== "bigint" || receipt.requestedItemId < 0n ||
    typeof receipt.baseGold !== "bigint" || receipt.baseGold < 0n ||
    typeof receipt.gold !== "bigint" || receipt.gold < 0n ||
    typeof receipt.cost !== "bigint" || receipt.cost < 0n ||
    receipt.baseGold - receipt.gold !== receipt.cost ||
    !Array.isArray(receipt.baseItems) ||
    !Array.isArray(receipt.nextItems) ||
    !Array.isArray(receipt.items)
  ) {
    throw new Error("invalid NPC repair transaction receipt");
  }
  return receipt;
}

/** 防止同一个 operationId 被改造成另一笔修理请求。 / Prevents one operation ID from being reused for a different repair request. */
export function ValidateNpcRepairReceipt(
  receipt: NpcRepairReceipt,
  request: C2M_RepairItems,
): void {
  if (
    receipt.npcUnitId !== request.npcUnitId ||
    receipt.requestedItemId !== request.itemId
  ) {
    throw new Error("NPC repair operation conflicts with its original request");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
