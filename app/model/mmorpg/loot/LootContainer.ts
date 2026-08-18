import type {
  ItemSnapshot,
  LootDropSnapshot,
  M2C_LootMonster,
} from "../../../generated/model/server/demo/protocol/messages";
import type { InventoryGrant } from "../item/ItemComponent";

/** 一行尸体掉落；questObjectiveId为0表示普通掉落，否则表示任务资格掉落。 / One corpse drop row; zero objective means regular loot, otherwise the row is quest-gated. */
export interface LootDrop {
  readonly dropId: number;
  readonly configId: number;
  readonly count: number;
  readonly gold: bigint;
  readonly questObjectiveId: number;
}

/**
 * 怪物尸体上的一次掉落容器；它属于地图和当前怪物Unit，不是可迁移的玩家Entity。
 * 静态掉落只保存配置ID与数量，真正拾取并提交成功时才创建永久ItemId。
 * 普通掉落属于首个造成有效伤害的账号并且只能领取一次，任务掉落按账号记录领取状态，
 * 避免路人抢走击杀者掉落，也避免“某人拾取后所有人都拿不到”任务掉落。
 *
 * One corpse-owned loot container. It belongs to the map and monster Unit, not
 * to a transferable player Entity. Static drops keep only config IDs and
 * counts until pickup commits. Regular drops are claim-once for the tagged
 * account while quest drops keep per-account claims, so one player's quest
 * cannot consume another player's eligible drop.
 */
export interface LootContainer {
  readonly monsterUnitId: number;
  readonly corpseGeneration: number;
  readonly lootOwnerAccount: string;
  readonly drops: readonly LootDrop[];
  readonly expiresAtMs: number;
  readonly reservedRegularDropIds: Set<number>;
  readonly reservedTaskDropIdsByAccount: Map<string, Set<number>>;
  readonly claimedRegularDropIds: Set<number>;
  readonly claimedTaskDropIdsByAccount: Map<string, Set<number>>;
  readonly inFlightOperations: Set<string>;
  readonly committedResponses: Map<string, M2C_LootMonster>;
}

/** 普通掉落只允许首个有效攻击者领取；任务掉落不调用此判断，而是按账号任务资格筛选。 / Regular loot is restricted to the first effective attacker; quest loot uses per-account quest eligibility instead. */
export function CanClaimRegularLoot(
  container: Pick<LootContainer, "lootOwnerAccount">,
  account: string,
): boolean {
  return account === container.lootOwnerAccount;
}

/** 把配置掉落转换成背包规划所需的纯数据，不提前生成ItemId。 / Converts config drops into inventory plans without allocating permanent ItemIds early. */
export function ToInventoryGrants(drops: readonly LootDrop[]): InventoryGrant[] {
  return drops
    .filter((drop) => drop.configId > 0 && drop.count > 0)
    .map((drop) => ({ configId: drop.configId, count: drop.count }));
}

/** 返回拾取后可安全发给客户端的道具快照副本。 / Copies item snapshots safe for client delivery after pickup. */
export function CopyLootItems(items: readonly ItemSnapshot[]): ItemSnapshot[] {
  return items.map((item) => ({ ...item }));
}

/** 将内部掉落行转换成客户端预览；不把任务资格、预留状态或永久ItemId泄露给客户端。 / Converts internal rows into client previews without exposing eligibility state, reservations, or permanent ItemIds. */
export function ToLootDropSnapshots(drops: readonly LootDrop[]): LootDropSnapshot[] {
  return drops.map((drop) => ({
    dropId: drop.dropId,
    itemConfigId: drop.configId,
    count: drop.count,
    gold: drop.gold,
  }));
}
