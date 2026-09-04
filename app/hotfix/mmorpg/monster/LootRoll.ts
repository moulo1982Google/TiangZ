/** 兼容旧的内部导入路径；中立掉落掷骰实现归属于 MMORPG loot。 / Keeps the legacy internal import path while neutral loot rolling belongs to MMORPG loot. */
export {
  SelectGroupedLootRows,
  SelectIndependentLootRows,
  type GroupedLootRow,
  type IndependentLootRow,
} from "../loot/LootRoll";
