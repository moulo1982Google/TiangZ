import {
  ActionType,
  BuffConflictPolicy,
  BuffComponent,
  CombatComponent,
  GameConfigs,
  GameErrCode,
  GlobalIdSystem,
  ItemComponent,
  type InventoryConsumePlan,
  type ItemCooldownPlan,
  type ItemSnapshot,
  type M2C_UseItem,
  NumericType,
  PlayerPersistenceComponent,
  RpcError,
  type PlayerSaveData,
  type PlayerUnit,
  SkillComponent,
  TimeSystem,
  type BuffTransferState,
  type HealingPlan,
  utf8Decode,
  utf8Encode,
} from "#tiangz/model";
import { ActionFromConfig } from "../action/ActionExecutor";

const RECEIPT_VERSION = 1;

type ItemUseEffectPlan =
  | { readonly kind: "heal"; readonly healing: HealingPlan }
  | { readonly kind: "buff"; readonly buff: BuffTransferState };

export interface ItemUseTransactionReceipt {
  readonly version: typeof RECEIPT_VERSION;
  readonly itemConfigId: number;
  readonly consumedItem: ItemSnapshot;
  readonly cooldown: ItemCooldownPlan;
  readonly effect: ItemUseEffectPlan;
}

export interface ItemUseTransactionPlan {
  readonly inventory: InventoryConsumePlan;
  readonly receipt: ItemUseTransactionReceipt;
  readonly data: PlayerSaveData;
}

export interface ItemUseCommitResult {
  readonly response: M2C_UseItem;
  readonly inventoryChanged: boolean;
}

/**
 * 规划当前演示支持的事务道具：Inventory、冷却和临时效果都只生成纯数据。
 * Heal与无AddAction的Stack Buff是首批支持范围；其他Action必须先补对应Planner。
 * Plans supported transactional demo items using pure values only. Heal and
 * Stack Buffs without AddAction are the initial supported set; every other
 * Action requires an explicit planner before becoming transactional.
 */
export function PlanItemUseTransaction(
  unit: PlayerUnit,
  itemId: bigint,
  itemConfigId: number,
): ItemUseTransactionPlan {
  const inventory = unit.GetComponent(ItemComponent);
  const inventoryPlan = inventory.PlanConsumeItem(itemId);
  const itemConfig = GameConfigs.ItemConfig.Get(itemConfigId);
  const cooldown = unit.GetComponent(SkillComponent).PlanItemCooldown(
    itemConfig.id,
    itemConfig.cooldownMs,
    itemConfig.globalCooldownMs,
  );
  if (!cooldown.result.accepted) {
    throw new RpcError(
      GameErrCode.ItemCooldown,
      `item ${itemConfig.id} ready at ${cooldown.result.readyAtMs}`,
    );
  }

  const persistence = unit.GetComponent(PlayerPersistenceComponent);
  const base = persistence.Capture(`item-use:${itemConfig.id}`);
  const action = itemConfig.useEffect === 1
    ? ActionFromConfig(ActionType.AddBuff, itemConfig.useParams)
    : ActionFromConfig(itemConfig.useParams[0], itemConfig.useParams.slice(1));

  let effect: ItemUseEffectPlan;
  let numerics = base.player.numerics;
  let buffs = base.buffs;
  if (action.type === ActionType.Heal) {
    if (action.parameters.length !== 1) throw new Error("transactional Heal expects one parameter");
    const healing = unit.GetComponent(CombatComponent).PlanHealing(action.parameters[0]);
    numerics = base.player.numerics.map((entry) => entry.numericType === NumericType.CurrentHp
      ? { numericType: entry.numericType, value: healing.nextCurrentHp }
      : entry);
    effect = { kind: "heal", healing };
  } else if (action.type === ActionType.AddBuff) {
    if (action.parameters.length !== 1) throw new Error("transactional AddBuff expects one parameter");
    const buffConfigId = toConfigId(action.parameters[0]);
    const buffConfig = GameConfigs.BuffConfig.Get(buffConfigId);
    if (
      buffConfig.conflictPolicy !== BuffConflictPolicy.Stack ||
      buffConfig.addActionType !== ActionType.None
    ) {
      throw new Error(
        `transactional item Buff must use Stack policy and no AddAction: ${buffConfigId}`,
      );
    }
    const now = TimeSystem.Instance.ServerNow;
    const durationMs = buffConfig.durationSeconds * 1_000;
    const buff: BuffTransferState = {
      buffInstanceId: GlobalIdSystem.Instance.Next(),
      configId: buffConfigId,
      stacks: 1,
      appliedAtMs: now,
      expireAtMs: durationMs > 0 ? now + durationMs : 0,
      tickIntervalMs: buffConfig.tickIntervalMs,
      nextTickAtMs: buffConfig.tickIntervalMs > 0 ? now + buffConfig.tickIntervalMs : 0,
      revision: 1,
      sourceUnitId: unit.UnitId,
      sourceAbilityId: 0,
      conflictPriority: buffConfig.conflictPriority,
      damageAbsorberRemaining: 0n,
    };
    const { sourceUnitId: _sourceUnitId, ...persistedBuff } = buff;
    buffs = [...base.buffs, { ...persistedBuff, source: "self" as const }];
    effect = { kind: "buff", buff };
  } else {
    throw new Error(`unsupported transactional item Action: ${action.type}`);
  }

  const receipt: ItemUseTransactionReceipt = {
    version: RECEIPT_VERSION,
    itemConfigId,
    consumedItem: { ...inventoryPlan.consumedItem },
    cooldown,
    effect,
  };
  const data = persistence.Capture(`item-use:${itemConfig.id}`, {
    numerics,
    items: inventoryPlan.nextItems,
    buffs,
    skill: cooldown.nextState,
  });
  return { inventory: inventoryPlan, receipt, data };
}

/**
 * DBProxy提交后同步应用计划；fresh路径严格校验base，recovery路径只前进未应用状态并拒绝回退后续变化。
 * Applies a plan synchronously after DBProxy commits. Fresh commits require
 * the exact base state, while recovery only advances missing state and never
 * rolls back later gameplay.
 */
export function ApplyItemUseTransaction(
  unit: PlayerUnit,
  receipt: ItemUseTransactionReceipt,
  inventoryPlan?: InventoryConsumePlan,
): ItemUseCommitResult {
  const inventory = unit.GetComponent(ItemComponent);
  const beforeItem = inventory.GetItem(receipt.consumedItem.itemId);
  const before = beforeItem?.version ?? 0;
  const alreadyRemoved = !beforeItem && receipt.consumedItem.count === 0;
  if (inventoryPlan) inventory.CommitConsumePlan(inventoryPlan);
  else inventory.ApplyCommittedConsumeItem(receipt.consumedItem);
  // 最后一件道具首次提交会从“存在”变成“已移除”；重复回执看到缺失Item时不能再次推进任务或广播。
  // The first commit removes the final item; a replay that sees it missing
  // must not advance quests or publish another inventory change.
  const inventoryChanged = !alreadyRemoved && before < receipt.consumedItem.version;

  const skill = unit.GetComponent(SkillComponent);
  if (inventoryPlan) skill.CommitItemCooldownPlan(receipt.cooldown);
  else skill.ApplyCommittedItemCooldown(receipt.cooldown);

  if (receipt.effect.kind === "heal") {
    const combat = unit.GetComponent(CombatComponent);
    if (inventoryPlan) combat.CommitHealingPlan(receipt.effect.healing);
    else combat.ApplyCommittedHealing(receipt.effect.healing);
  } else {
    unit.GetComponent(BuffComponent).ApplyCommittedBuff(receipt.effect.buff);
  }
  return { response: ResponseFromItemUseReceipt(unit, receipt), inventoryChanged };
}

/** 把事务回执转换为客户端原始响应；重复请求返回同一Item/Buff实例和冷却截止时间。 / Converts a receipt to the original client response with stable Item, Buff, and cooldown deadlines. */
export function ResponseFromItemUseReceipt(
  unit: PlayerUnit,
  receipt: ItemUseTransactionReceipt,
): M2C_UseItem {
  const response = {
    item: { ...receipt.consumedItem },
    globalCooldownEndAtMs: BigInt(Math.max(0, Math.floor(receipt.cooldown.result.globalCooldownEndAtMs))),
    itemCooldownEndAtMs: BigInt(Math.max(0, Math.floor(receipt.cooldown.result.itemCooldownEndAtMs))),
  };
  if (receipt.effect.kind === "buff") {
    const buff = receipt.effect.buff;
    return {
      ...response,
      buff: {
        unitId: unit.UnitId,
        buffInstanceId: buff.buffInstanceId,
        buffConfigId: buff.configId,
        stacks: buff.stacks,
        expireTimeMs: BigInt(Math.max(0, Math.floor(buff.expireAtMs))),
        revision: buff.revision,
      },
    };
  }
  return response;
}

/** 使用带bigint标记的稳定JSON保存业务回执；该字节串只属于TiangZ，不泄漏到DBProxy领域。 / Encodes the business receipt as stable tagged JSON owned by TiangZ, never by DBProxy. */
export function EncodeItemUseReceipt(receipt: ItemUseTransactionReceipt): Uint8Array {
  return utf8Encode(JSON.stringify(receipt, (_key, value: unknown) => (
    typeof value === "bigint" ? { $bigint: value.toString() } : value
  )));
}

/** 解码并校验DBProxy原样返回的业务回执。 / Decodes and validates the opaque business receipt returned by DBProxy. */
export function DecodeItemUseReceipt(payload: Uint8Array): ItemUseTransactionReceipt {
  const value: unknown = JSON.parse(utf8Decode(payload), (_key, entry: unknown) => {
    if (isRecord(entry) && Object.keys(entry).length === 1 && typeof entry.$bigint === "string") {
      return BigInt(entry.$bigint);
    }
    return entry;
  });
  if (!isRecord(value) || value.version !== RECEIPT_VERSION) {
    throw new Error("unsupported item-use transaction receipt");
  }
  const receipt = value as unknown as ItemUseTransactionReceipt;
  if (
    !Number.isSafeInteger(receipt.itemConfigId) || receipt.itemConfigId <= 0 ||
    typeof receipt.consumedItem?.itemId !== "bigint" ||
    receipt.consumedItem.itemId <= 0n ||
    !receipt.cooldown?.result?.accepted ||
    (receipt.effect?.kind !== "heal" && receipt.effect?.kind !== "buff")
  ) {
    throw new Error("invalid item-use transaction receipt");
  }
  return receipt;
}

function toConfigId(value: bigint): number {
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`item Buff config id must be a positive safe integer: ${value}`);
  }
  return Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
