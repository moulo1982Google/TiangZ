/**
 * 浜旈」浼犵粺MMORPG涓诲睘鎬у睘浜嶮MORPG缁勫悎灞傦細娓告垙鍙互鍒濆鍖栧拰淇敼瀹冧滑锛孋ore鍙簲鐢ㄩ€氱敤Base/Add/Pct绾﹀畾銆?
 * Five conventional MMORPG primary attributes belong to the MMORPG composition
 * layer: games may seed and modify them while Core applies only the generic
 * Base/Add/Pct Numeric convention.
 */
export const AttributeNumericType = {
  Strength: 1002,
  StrengthBase: 1002 * 10 + 1,
  StrengthAdd: 1002 * 10 + 2,
  StrengthPct: 1002 * 10 + 3,

  Agility: 1003,
  AgilityBase: 1003 * 10 + 1,
  AgilityAdd: 1003 * 10 + 2,
  AgilityPct: 1003 * 10 + 3,

  Stamina: 1004,
  StaminaBase: 1004 * 10 + 1,
  StaminaAdd: 1004 * 10 + 2,
  StaminaPct: 1004 * 10 + 3,

  Intellect: 1005,
  IntellectBase: 1005 * 10 + 1,
  IntellectAdd: 1005 * 10 + 2,
  IntellectPct: 1005 * 10 + 3,

  Spirit: 1006,
  SpiritBase: 1006 * 10 + 1,
  SpiritAdd: 1006 * 10 + 2,
  SpiritPct: 1006 * 10 + 3,
} as const;
