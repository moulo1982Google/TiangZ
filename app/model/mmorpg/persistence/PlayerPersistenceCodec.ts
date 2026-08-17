import type { ActionDefinition, ActionTypeValue } from "../action/ActionType";
import { utf8Decode, utf8Encode } from "../../../core/public";
import type {
  PersistedBuffState,
  PlayerDomainDataMap,
  PlayerDomainSaveData,
  PlayerInventorySaveData,
  PlayerPersistenceDomain,
  PlayerProgressionSaveData,
  PlayerQuestSaveData,
  PlayerRuntimeSaveData,
  PlayerSaveData,
  PlayerWalletSaveData,
} from "./PlayerRepository";

export const PLAYER_PERSISTENCE_SCHEMA = "tiangz.demo.player";
export const PLAYER_PERSISTENCE_SCHEMA_VERSION = 2;
export const PLAYER_DOMAIN_SCHEMA_VERSION = 1;

export const PLAYER_DOMAIN_SCHEMAS: Readonly<Record<PlayerPersistenceDomain, string>> = {
  inventory: "tiangz.demo.player.inventory",
  progression: "tiangz.demo.player.progression",
  quest: "tiangz.demo.player.quest",
  runtime: "tiangz.demo.player.runtime",
  wallet: "tiangz.demo.player.wallet",
};

const BIGINT_MARKER = "$tiangzI64";

/** 把聚合规划值投影为一个领域记录；不会保留其他领域字段。 / Projects aggregate planning values into one domain record without retaining fields owned by other domains. */
export function ProjectPlayerDomainData<TDomain extends PlayerPersistenceDomain>(
  data: PlayerSaveData,
  domain: TDomain,
): PlayerDomainDataMap[TDomain] {
  let projected: PlayerDomainSaveData;
  switch (domain) {
    case "inventory":
      projected = {
        account: data.player.account,
        characterId: data.player.characterId,
        items: data.items.map((item) => ({ ...item })),
        reason: data.reason,
      } satisfies PlayerInventorySaveData;
      break;
    case "progression":
      projected = {
        account: data.player.account,
        characterId: data.player.characterId,
        numerics: data.player.numerics.map((numeric) => ({ ...numeric })),
        reason: data.reason,
      } satisfies PlayerProgressionSaveData;
      break;
    case "quest":
      projected = {
        account: data.player.account,
        characterId: data.player.characterId,
        quests: {
          active: data.quests.active.map((quest) => ({
            ...quest,
            objectives: quest.objectives.map((objective) => ({ ...objective })),
          })),
          completedQuestConfigIds: [...data.quests.completedQuestConfigIds],
        },
        reason: data.reason,
      } satisfies PlayerQuestSaveData;
      break;
    case "runtime": {
      const { gold: _gold, numerics: _numerics, ...player } = data.player;
      projected = {
        player: { ...player },
        buffs: data.buffs.map((buff) => ({
          ...buff,
          addAction: cloneAction(buff.addAction),
          tickAction: cloneAction(buff.tickAction),
          removeAction: cloneAction(buff.removeAction),
        })),
        skill: {
          globalCooldownEndAtMs: data.skill.globalCooldownEndAtMs,
          cooldowns: data.skill.cooldowns.map((cooldown) => ({ ...cooldown })),
          itemCooldowns: data.skill.itemCooldowns.map((cooldown) => ({ ...cooldown })),
        },
        reason: data.reason,
      } satisfies PlayerRuntimeSaveData;
      break;
    }
    case "wallet":
      projected = {
        account: data.player.account,
        characterId: data.player.characterId,
        gold: data.player.gold,
        reason: data.reason,
      } satisfies PlayerWalletSaveData;
      break;
    }
  ValidatePlayerDomainData(domain, projected);
  return projected as PlayerDomainDataMap[TDomain];
}

/** 编码一条领域记录；DBProxy仍只看见不透明Payload。 / Encodes one domain record while DBProxy continues to see opaque payload bytes. */
export function EncodePlayerDomainData(
  domain: PlayerPersistenceDomain,
  data: PlayerDomainSaveData,
): Uint8Array {
  ValidatePlayerDomainData(domain, data);
  return encodeJsonEnvelope(PLAYER_DOMAIN_SCHEMA_VERSION, data);
}

/** 解码并校验指定领域，禁止把错误RecordKey下的Payload拼进玩家。 / Decodes and validates one domain so payloads under the wrong record key cannot enter a player. */
export function DecodePlayerDomainData<TDomain extends PlayerPersistenceDomain>(
  domain: TDomain,
  payload: Uint8Array,
): PlayerDomainDataMap[TDomain] {
  const envelope = decodeJsonEnvelope(payload, `${domain} player persistence payload`);
  if (envelope.version !== PLAYER_DOMAIN_SCHEMA_VERSION) {
    throw new Error(`unsupported player ${domain} persistence version: ${String(envelope.version)}`);
  }
  ValidatePlayerDomainData(domain, envelope.data);
  return envelope.data as unknown as PlayerDomainDataMap[TDomain];
}

export function ClonePlayerDomainData<TDomain extends PlayerPersistenceDomain>(
  domain: TDomain,
  data: PlayerDomainSaveData,
): PlayerDomainDataMap[TDomain] {
  return DecodePlayerDomainData(domain, EncodePlayerDomainData(domain, data));
}

/**
 * 把业务快照编码为有版本的UTF-8 JSON。bigint使用显式标签，禁止经number中转。
 * 此格式只属于Demo玩家Repository；DBProxy只把它当作不透明字节。
 *
 * Encodes the business snapshot as versioned UTF-8 JSON. Bigints use explicit
 * tags and never pass through number. This format belongs to the demo player
 * Repository; DBProxy treats it as opaque bytes.
 */
export function EncodePlayerSaveData(data: PlayerSaveData): Uint8Array {
  ValidatePlayerSaveData(data);
  const json = JSON.stringify(
    { version: PLAYER_PERSISTENCE_SCHEMA_VERSION, data },
    (_key, value: unknown) => typeof value === "bigint"
      ? { [BIGINT_MARKER]: value.toString() }
      : value,
  );
  return utf8Encode(json);
}

/** 解码并完整校验外部存储快照；不能把未知JSON直接交给Entity恢复。 / Decodes and fully validates an external snapshot before Entity restoration. */
export function DecodePlayerSaveData(payload: Uint8Array): PlayerSaveData {
  let decoded: unknown;
  try {
    decoded = JSON.parse(utf8Decode(payload), (_key, value: unknown) => reviveBigInt(value));
  } catch (error) {
    throw new Error(`invalid player persistence payload: ${String(error)}`);
  }
  const envelope = requireRecord(decoded, "payload");
  if (envelope.version !== 1 && envelope.version !== PLAYER_PERSISTENCE_SCHEMA_VERSION) {
    throw new Error(`unsupported player persistence version: ${String(envelope.version)}`);
  }
  const data = envelope.version === 1
    ? MigrateV1PlayerSaveData(envelope.data)
    : envelope.data;
  ValidatePlayerSaveData(data);
  return data as unknown as PlayerSaveData;
}

/** 经序列化边界生成深拷贝，确保Repository不会保留Entity导出的可变数组。 / Deep-copies through the serialization boundary so a Repository never retains mutable Entity arrays. */
export function ClonePlayerSaveData(data: PlayerSaveData): PlayerSaveData {
  return DecodePlayerSaveData(EncodePlayerSaveData(data));
}

export function ValidatePlayerSaveData(value: unknown): asserts value is PlayerSaveData {
  const data = requireRecord(value, "playerSaveData");
  const player = requireRecord(data.player, "playerSaveData.player");
  requireText(player.account, "player.account");
  requirePositiveBigInt(player.characterId, "player.characterId");
  requireNonNegativeBigInt(player.gold, "player.gold");
  requirePositiveInteger(player.mapId, "player.mapId");
  requirePositiveBigInt(player.mapInstanceId, "player.mapInstanceId");
  requireFinite(player.x, "player.x");
  requireFinite(player.y, "player.y");
  requireFinite(player.z, "player.z");
  requireFinite(player.yaw, "player.yaw");
  requireInteger(player.cellX, "player.cellX");
  requireInteger(player.cellZ, "player.cellZ");
  requirePositiveFinite(player.speedCellsPerSecond, "player.speedCellsPerSecond");
  requireInteger(player.facing, "player.facing");
  requireBoolean(player.alive, "player.alive");
  requireArray(player.numerics, "player.numerics").forEach((entry, index) => {
    const numeric = requireRecord(entry, `player.numerics[${index}]`);
    requirePositiveInteger(numeric.numericType, `player.numerics[${index}].numericType`);
    requireBigInt(numeric.value, `player.numerics[${index}].value`);
  });

  requireArray(data.items, "items").forEach((entry, index) => {
    const item = requireRecord(entry, `items[${index}]`);
    requirePositiveBigInt(item.itemId, `items[${index}].itemId`);
    requirePositiveInteger(item.configId, `items[${index}].configId`);
    requireNonNegativeInteger(item.count, `items[${index}].count`);
    requireNonNegativeInteger(item.quality, `items[${index}].quality`);
    requireNonNegativeInteger(item.level, `items[${index}].level`);
    requireNonNegativeInteger(item.version, `items[${index}].version`);
  });

  requireArray(data.buffs, "buffs").forEach((entry, index) =>
    validateBuff(entry, `buffs[${index}]`)
  );
  validateSkill(data.skill);
  validateQuests(data.quests);
  requireText(data.reason, "reason");
}

export function ValidatePlayerDomainData(
  domain: PlayerPersistenceDomain,
  value: unknown,
): asserts value is PlayerDomainSaveData {
  const data = requireRecord(value, `player.${domain}`);
  if (domain === "runtime") {
    const runtime = data as unknown as PlayerRuntimeSaveData;
    const player = requireRecord(runtime.player, "player.runtime.player");
    validatePlayerIdentity(player, "player.runtime.player");
    requirePositiveInteger(player.mapId, "player.runtime.player.mapId");
    requirePositiveBigInt(player.mapInstanceId, "player.runtime.player.mapInstanceId");
    requireFinite(player.x, "player.runtime.player.x");
    requireFinite(player.y, "player.runtime.player.y");
    requireFinite(player.z, "player.runtime.player.z");
    requireFinite(player.yaw, "player.runtime.player.yaw");
    requireInteger(player.cellX, "player.runtime.player.cellX");
    requireInteger(player.cellZ, "player.runtime.player.cellZ");
    requirePositiveFinite(player.speedCellsPerSecond, "player.runtime.player.speedCellsPerSecond");
    requireInteger(player.facing, "player.runtime.player.facing");
    requireBoolean(player.alive, "player.runtime.player.alive");
    requireArray(runtime.buffs, "player.runtime.buffs").forEach((buff, index) =>
      validateBuff(buff, `player.runtime.buffs[${index}]`)
    );
    validateSkill(runtime.skill);
    requireText(runtime.reason, "player.runtime.reason");
    return;
  }

  validatePlayerIdentity(data, `player.${domain}`);
  requireText(data.reason, `player.${domain}.reason`);
  if (domain === "inventory") {
    const inventory = data as unknown as PlayerInventorySaveData;
    requireArray(inventory.items, "player.inventory.items").forEach((entry, index) => {
      const item = requireRecord(entry, `player.inventory.items[${index}]`);
      requirePositiveBigInt(item.itemId, `player.inventory.items[${index}].itemId`);
      requirePositiveInteger(item.configId, `player.inventory.items[${index}].configId`);
      requireNonNegativeInteger(item.count, `player.inventory.items[${index}].count`);
      requireNonNegativeInteger(item.quality, `player.inventory.items[${index}].quality`);
      requireNonNegativeInteger(item.level, `player.inventory.items[${index}].level`);
      requireNonNegativeInteger(item.version, `player.inventory.items[${index}].version`);
    });
    return;
  }

  if (domain === "wallet") {
    const wallet = data as unknown as PlayerWalletSaveData;
    requireNonNegativeBigInt(wallet.gold, "player.wallet.gold");
    return;
  }

  if (domain === "progression") {
    const progression = data as unknown as PlayerProgressionSaveData;
    requireArray(progression.numerics, "player.progression.numerics").forEach((entry, index) => {
      const numeric = requireRecord(entry, `player.progression.numerics[${index}]`);
      requirePositiveInteger(numeric.numericType, `player.progression.numerics[${index}].numericType`);
      requireBigInt(numeric.value, `player.progression.numerics[${index}].value`);
    });
    return;
  }

  const quest = data as unknown as PlayerQuestSaveData;
  validateQuests(quest.quests);
}

/**
 * v1没有金币字段，按“旧快照余额为0”迁移聚合快照；这不代表旧economy RecordKey继续兼容。
 * V1 aggregate snapshots start at zero balance; the old economy RecordKey is not a supported domain key.
 */
function MigrateV1PlayerSaveData(value: unknown): PlayerSaveData {
  const data = requireRecord(value, "playerSaveData");
  const player = requireRecord(data.player, "playerSaveData.player");
  return {
    ...data,
    player: {
      ...player,
      gold: player.gold ?? 0n,
    },
  } as PlayerSaveData;
}

function validateBuff(value: unknown, name: string): asserts value is PersistedBuffState {
  const buff = requireRecord(value, name);
  requirePositiveBigInt(buff.buffInstanceId, `${name}.buffInstanceId`);
  requirePositiveInteger(buff.configId, `${name}.configId`);
  requirePositiveInteger(buff.stacks, `${name}.stacks`);
  requireNonNegativeInteger(buff.appliedAtMs, `${name}.appliedAtMs`);
  requireNonNegativeInteger(buff.expireAtMs, `${name}.expireAtMs`);
  requireNonNegativeInteger(buff.tickIntervalMs, `${name}.tickIntervalMs`);
  requireNonNegativeInteger(buff.nextTickAtMs, `${name}.nextTickAtMs`);
  requireNonNegativeInteger(buff.revision, `${name}.revision`);
  requireNonNegativeInteger(buff.sourceAbilityId, `${name}.sourceAbilityId`);
  requireInteger(buff.conflictPriority, `${name}.conflictPriority`);
  requireBigInt(buff.damageAbsorberRemaining, `${name}.damageAbsorberRemaining`);
  if (buff.source !== "self" && buff.source !== "detached") {
    throw new TypeError(`${name}.source must be self or detached`);
  }
  validateOptionalAction(buff.addAction, `${name}.addAction`);
  validateOptionalAction(buff.tickAction, `${name}.tickAction`);
  validateOptionalAction(buff.removeAction, `${name}.removeAction`);
}

function validateSkill(value: unknown): void {
  const skill = requireRecord(value, "skill");
  requireNonNegativeInteger(skill.globalCooldownEndAtMs, "skill.globalCooldownEndAtMs");
  requireArray(skill.cooldowns, "skill.cooldowns").forEach((entry, index) => {
    const cooldown = requireRecord(entry, `skill.cooldowns[${index}]`);
    requirePositiveInteger(cooldown.skillId, `skill.cooldowns[${index}].skillId`);
    requireNonNegativeInteger(cooldown.cooldownEndAtMs, `skill.cooldowns[${index}].cooldownEndAtMs`);
  });
  requireArray(skill.itemCooldowns, "skill.itemCooldowns").forEach((entry, index) => {
    const cooldown = requireRecord(entry, `skill.itemCooldowns[${index}]`);
    requirePositiveInteger(cooldown.itemConfigId, `skill.itemCooldowns[${index}].itemConfigId`);
    requireNonNegativeInteger(cooldown.cooldownEndAtMs, `skill.itemCooldowns[${index}].cooldownEndAtMs`);
  });
}

function validateQuests(value: unknown): void {
  const quests = requireRecord(value, "quests");
  requireArray(quests.active, "quests.active").forEach((entry, index) => {
    const quest = requireRecord(entry, `quests.active[${index}]`);
    requirePositiveInteger(quest.questConfigId, `quests.active[${index}].questConfigId`);
    requireNonNegativeInteger(quest.status, `quests.active[${index}].status`);
    requireNonNegativeInteger(quest.revision, `quests.active[${index}].revision`);
    requireArray(quest.objectives, `quests.active[${index}].objectives`).forEach(
      (objectiveValue, objectiveIndex) => {
        const objective = requireRecord(
          objectiveValue,
          `quests.active[${index}].objectives[${objectiveIndex}]`,
        );
        requirePositiveInteger(objective.objectiveId, "questObjective.objectiveId");
        requireNonNegativeInteger(objective.current, "questObjective.current");
        requirePositiveInteger(objective.required, "questObjective.required");
      },
    );
  });
  requireArray(
    quests.completedQuestConfigIds,
    "quests.completedQuestConfigIds",
  ).forEach((id, index) =>
    requirePositiveInteger(id, `quests.completedQuestConfigIds[${index}]`)
  );
}

function validateOptionalAction(value: unknown, name: string): void {
  if (value === undefined) return;
  const action = requireRecord(value, name);
  requirePositiveInteger(action.type, `${name}.type`);
  requireArray(action.parameters, `${name}.parameters`).forEach((parameter, index) =>
    requireBigInt(parameter, `${name}.parameters[${index}]`)
  );
  void (action.type as ActionTypeValue);
  void (action as unknown as ActionDefinition);
}

function validatePlayerIdentity(value: Record<string, unknown>, name: string): void {
  requireText(value.account, `${name}.account`);
  requirePositiveBigInt(value.characterId, `${name}.characterId`);
}

function cloneAction(action: ActionDefinition | undefined): ActionDefinition | undefined {
  return action ? { type: action.type, parameters: [...action.parameters] } : undefined;
}

function encodeJsonEnvelope(version: number, data: unknown): Uint8Array {
  return utf8Encode(JSON.stringify(
    { version, data },
    (_key, value: unknown) => typeof value === "bigint"
      ? { [BIGINT_MARKER]: value.toString() }
      : value,
  ));
}

function decodeJsonEnvelope(payload: Uint8Array, name: string): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(utf8Decode(payload), (_key, value: unknown) => reviveBigInt(value));
  } catch (error) {
    throw new Error(`invalid ${name}: ${String(error)}`);
  }
  return requireRecord(decoded, name);
}

function reviveBigInt(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== BIGINT_MARKER) return value;
  const encoded = value[BIGINT_MARKER];
  if (typeof encoded !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(encoded)) {
    throw new TypeError("invalid tagged bigint");
  }
  return BigInt(encoded);
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireArray(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value;
}

function requireText(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function requireBoolean(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean`);
}

function requireFinite(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be finite`);
  }
}

function requirePositiveFinite(value: unknown, name: string): asserts value is number {
  requireFinite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
}

function requireInteger(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a safe integer`);
  }
}

function requireNonNegativeInteger(value: unknown, name: string): asserts value is number {
  requireInteger(value, name);
  if (value < 0) throw new RangeError(`${name} must be non-negative`);
}

function requirePositiveInteger(value: unknown, name: string): asserts value is number {
  requireInteger(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
}

function requireBigInt(value: unknown, name: string): asserts value is bigint {
  if (typeof value !== "bigint") throw new TypeError(`${name} must be bigint`);
}

function requirePositiveBigInt(value: unknown, name: string): asserts value is bigint {
  requireBigInt(value, name);
  if (value <= 0n) throw new RangeError(`${name} must be positive`);
}

function requireNonNegativeBigInt(value: unknown, name: string): asserts value is bigint {
  requireBigInt(value, name);
  if (value < 0n) throw new RangeError(`${name} must be non-negative`);
}
