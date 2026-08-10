import {
  DbProxyClient,
  DbProxyErrorCode,
  DbProxyRemoteError,
  type DbProxySnapshotWrite,
} from "@tiangz/dbproxy-sdk";
import {
  HostDbProxyTransport,
  type MaybePromise,
  type ProcessConfig,
  utf8Decode,
  utf8Encode,
} from "../../../core/public";

export const CHARACTER_CATALOG_NAMESPACE = "character_catalog";
export const CHARACTER_CATALOG_SCHEMA = "tiangz.demo.character-catalog";
export const CHARACTER_CATALOG_SCHEMA_VERSION = 2;
const LEGACY_CHARACTER_CATALOG_SCHEMA_VERSION = 1;

const SAVE_ATTEMPTS = 3;
const BIGINT_MARKER = "$tiangzI64";

export interface CharacterRecord {
  readonly characterId: bigint;
  readonly name: string;
  readonly playerConfigId: number;
  readonly level: number;
}

export interface AccountCredential {
  readonly salt: string;
  readonly hash: string;
}

export interface CharacterCatalog {
  readonly account: string;
  readonly credential: AccountCredential;
  readonly characters: readonly CharacterRecord[];
}

export interface CharacterCatalogLoadResult {
  readonly data: CharacterCatalog;
  readonly revision: bigint;
}

export interface CharacterRepository {
  Load(account: string): MaybePromise<CharacterCatalogLoadResult | undefined>;
  Register(
    account: string,
    credential: AccountCredential,
    character: CharacterRecord,
  ): MaybePromise<CharacterCatalogLoadResult>;
  Create(account: string, character: CharacterRecord): MaybePromise<CharacterCatalogLoadResult>;
}

export class CharacterAccountAlreadyExistsError extends Error {
  constructor(readonly account: string) {
    super(`character account already exists: ${account}`);
    this.name = "CharacterAccountAlreadyExistsError";
  }
}

/**
 * 角色目录只保存登录身份到稳定角色ID的映射，不保存地图运行态。
 * Login负责创建和选择，MapHost负责读取同一个characterId对应的玩家快照。
 *
 * The catalog only maps an account to stable character IDs; it never owns map
 * runtime state. Login creates/selects records and MapHost loads the player
 * snapshot by the selected characterId.
 */
export class InMemoryCharacterRepository implements CharacterRepository {
  private readonly records = new Map<string, { data: CharacterCatalog; revision: bigint }>();

  Load(account: string): CharacterCatalogLoadResult | undefined {
    const record = this.records.get(account);
    if (!record) return undefined;
    return { data: cloneCatalog(record.data), revision: record.revision };
  }

  Register(
    account: string,
    credential: AccountCredential,
    character: CharacterRecord,
  ): CharacterCatalogLoadResult {
    validateAccount(account);
    validateCredential(credential);
    validateCharacter(character);
    const current = this.records.get(account);
    if (current && !isLegacyCredential(current.data.credential)) {
      throw new CharacterAccountAlreadyExistsError(account);
    }
    const data: CharacterCatalog = {
      account,
      credential: { ...credential },
      characters: current && current.data.characters.length > 0
        ? [...current.data.characters, { ...character }]
        : [{ ...character }],
    };
    const revision = (current?.revision ?? 0n) + 1n;
    this.records.set(account, { data: cloneCatalog(data), revision });
    return { data: cloneCatalog(data), revision };
  }

  Create(account: string, character: CharacterRecord): CharacterCatalogLoadResult {
    validateAccount(account);
    validateCharacter(character);
    const current = this.records.get(account);
    if (!current) throw new Error(`character account not found: ${account}`);
    const characters = current?.data.characters ?? [];
    if (characters.some((item) => item.characterId === character.characterId)) {
      throw new Error(`character already exists: ${character.characterId}`);
    }
    const data: CharacterCatalog = {
      account,
      credential: { ...current.data.credential },
      characters: [...characters, { ...character }],
    };
    const revision = (current?.revision ?? 0n) + 1n;
    this.records.set(account, { data: cloneCatalog(data), revision });
    return { data: cloneCatalog(data), revision };
  }
}

/** DBProxy实现：整个账号角色目录是一个版本化快照，DBProxy负责CAS与可靠提交。 / DBProxy-backed versioned character catalog. */
export class DbProxyCharacterRepository implements CharacterRepository {
  private readonly client: DbProxyClient;
  private readonly requestPrefix: string;
  private requestSequence = 0;

  constructor(
    processName: string,
    client = new DbProxyClient(new HostDbProxyTransport()),
  ) {
    this.client = client;
    this.requestPrefix = `${processName}:characters:${Date.now().toString(36)}`;
  }

  async Load(account: string): Promise<CharacterCatalogLoadResult | undefined> {
    validateAccount(account);
    const snapshot = await this.client.Load({
      namespace: CHARACTER_CATALOG_NAMESPACE,
      key: account,
    });
    if (!snapshot) return undefined;
    if (
      snapshot.schema !== CHARACTER_CATALOG_SCHEMA ||
      snapshot.schemaVersion !== CHARACTER_CATALOG_SCHEMA_VERSION &&
      snapshot.schemaVersion !== LEGACY_CHARACTER_CATALOG_SCHEMA_VERSION
    ) {
      throw new Error(
        `unsupported character catalog schema: ${snapshot.schema}@${snapshot.schemaVersion}`,
      );
    }
    const data = DecodeCharacterCatalog(snapshot.payload);
    if (data.account !== account) {
      throw new Error(`character catalog key mismatch: key=${account}, payload=${data.account}`);
    }
    return { data, revision: snapshot.revision };
  }

  async Register(
    account: string,
    credential: AccountCredential,
    character: CharacterRecord,
  ): Promise<CharacterCatalogLoadResult> {
    validateAccount(account);
    validateCredential(credential);
    validateCharacter(character);
    for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt += 1) {
      const current = await this.Load(account);
      if (current && !isLegacyCredential(current.data.credential)) {
        throw new CharacterAccountAlreadyExistsError(account);
      }
      const data: CharacterCatalog = {
        account,
        credential: { ...credential },
        characters: current && current.data.characters.length > 0
          ? [...current.data.characters, { ...character }]
          : [{ ...character }],
      };
      try {
        const result = await this.client.Save(this.buildWrite(data, current?.revision ?? 0n));
        return { data: cloneCatalog(data), revision: result.revision };
      } catch (error) {
        if (
          attempt === SAVE_ATTEMPTS ||
          !(error instanceof DbProxyRemoteError) ||
          error.code !== DbProxyErrorCode.RevisionConflict
        ) {
          throw error;
        }
      }
    }
    throw new Error("unreachable character catalog register retry state");
  }

  async Create(account: string, character: CharacterRecord): Promise<CharacterCatalogLoadResult> {
    validateAccount(account);
    validateCharacter(character);
    for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt += 1) {
      const current = await this.Load(account);
      if (current?.data.characters.some((item) => item.characterId === character.characterId)) {
        throw new Error(`character already exists: ${character.characterId}`);
      }
      if (!current) throw new Error(`character account not found: ${account}`);
      const data: CharacterCatalog = {
        account,
        credential: { ...current.data.credential },
        characters: [...(current?.data.characters ?? []), { ...character }],
      };
      try {
        const result = await this.client.Save(this.buildWrite(data, current?.revision ?? 0n));
        return { data: cloneCatalog(data), revision: result.revision };
      } catch (error) {
        if (
          attempt === SAVE_ATTEMPTS ||
          !(error instanceof DbProxyRemoteError) ||
          error.code !== DbProxyErrorCode.RevisionConflict
        ) {
          throw error;
        }
        // 另一个Login进程刚写入目录；重新Load后再尝试，不能覆盖新角色。
        // Another Login process won the CAS; reload before retrying so its character is preserved.
      }
    }
    throw new Error("unreachable character catalog create retry state");
  }

  private buildWrite(data: CharacterCatalog, expectedRevision: bigint): DbProxySnapshotWrite {
    this.requestSequence += 1;
    if (!Number.isSafeInteger(this.requestSequence)) {
      throw new Error("character catalog request sequence exhausted");
    }
    return {
      requestId: `${this.requestPrefix}:${this.requestSequence.toString(36)}`,
      record: { namespace: CHARACTER_CATALOG_NAMESPACE, key: data.account },
      schema: CHARACTER_CATALOG_SCHEMA,
      schemaVersion: CHARACTER_CATALOG_SCHEMA_VERSION,
      payload: EncodeCharacterCatalog(data),
      expectedRevision,
      updatedAtUnixMs: BigInt(Date.now()),
    };
  }
}

const inMemoryRepositories = new Map<string, InMemoryCharacterRepository>();

/** Login的唯一Repository选择点；无DBProxy时同一Process内的Login实例共享目录。 / Sole Login repository factory. */
export function CreateCharacterRepository(process: ProcessConfig): CharacterRepository {
  if (process.persistence?.dbProxy) return new DbProxyCharacterRepository(process.name);
  let repository = inMemoryRepositories.get(process.name);
  if (!repository) {
    repository = new InMemoryCharacterRepository();
    inMemoryRepositories.set(process.name, repository);
  }
  return repository;
}

export function EncodeCharacterCatalog(data: CharacterCatalog): Uint8Array {
  validateCatalog(data);
  return utf8Encode(JSON.stringify(
    { version: CHARACTER_CATALOG_SCHEMA_VERSION, data },
    (_key, value: unknown) => typeof value === "bigint"
      ? { [BIGINT_MARKER]: value.toString() }
      : value,
  ));
}

export function DecodeCharacterCatalog(payload: Uint8Array): CharacterCatalog {
  let value: unknown;
  try {
    value = JSON.parse(utf8Decode(payload), (_key, item: unknown) => {
      if (!isRecord(item) || Object.keys(item).length !== 1 || !(BIGINT_MARKER in item)) return item;
      const encoded = item[BIGINT_MARKER];
      if (typeof encoded !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(encoded)) {
        throw new TypeError("invalid tagged character id");
      }
      return BigInt(encoded);
    });
  } catch (error) {
    throw new Error(`invalid character catalog payload: ${String(error)}`);
  }
  const envelope = requireRecord(value, "character catalog payload");
  if (
    envelope.version !== CHARACTER_CATALOG_SCHEMA_VERSION &&
    envelope.version !== LEGACY_CHARACTER_CATALOG_SCHEMA_VERSION
  ) {
    throw new Error(`unsupported character catalog version: ${String(envelope.version)}`);
  }
  const rawData = requireRecord(envelope.data, "character catalog data");
  const data = envelope.version === LEGACY_CHARACTER_CATALOG_SCHEMA_VERSION
    ? { ...rawData, credential: { salt: "", hash: "" } }
    : rawData;
  validateCatalog(data);
  return cloneCatalog(data);
}

function cloneCatalog(data: CharacterCatalog): CharacterCatalog {
  return {
    account: data.account,
    credential: { ...data.credential },
    characters: data.characters.map((character) => ({ ...character })),
  };
}

function validateCatalog(value: unknown): asserts value is CharacterCatalog {
  const data = requireRecord(value, "character catalog");
  validateAccount(data.account);
  validateCredential(data.credential);
  if (!Array.isArray(data.characters)) throw new TypeError("character catalog characters must be an array");
  const ids = new Set<bigint>();
  for (const value of data.characters) {
    const character = requireRecord(value, "character catalog character");
    validateCharacter(character);
    if (!ids.add(character.characterId)) throw new Error(`duplicate character id: ${character.characterId}`);
  }
}

function validateCredential(value: unknown): asserts value is AccountCredential {
  const credential = requireRecord(value, "account credential");
  if (typeof credential.salt !== "string" || typeof credential.hash !== "string") {
    throw new TypeError("account credential salt/hash must be strings");
  }
  const typedCredential = credential as AccountCredential;
  if (isLegacyCredential(typedCredential)) return;
  if (!/^[0-9a-f]{32}$/.test(credential.salt) || !/^[0-9a-f]{64}$/.test(credential.hash)) {
    throw new TypeError("account credential must contain a 16-byte salt and SHA-256 hash");
  }
}

function isLegacyCredential(credential: AccountCredential): boolean {
  return credential.salt.length === 0 && credential.hash.length === 0;
}

function validateCharacter(value: unknown): asserts value is CharacterRecord {
  const character = requireRecord(value, "character");
  if (typeof character.characterId !== "bigint" || character.characterId <= 0n) {
    throw new TypeError("character.characterId must be a positive bigint");
  }
  if (typeof character.name !== "string" || character.name.trim().length === 0 || character.name.length > 32) {
    throw new TypeError("character.name must be 1-32 characters");
  }
  if (!Number.isSafeInteger(character.playerConfigId) || character.playerConfigId <= 0) {
    throw new TypeError("character.playerConfigId must be a positive integer");
  }
  if (!Number.isSafeInteger(character.level) || character.level <= 0) {
    throw new TypeError("character.level must be a positive integer");
  }
}

function validateAccount(account: unknown): asserts account is string {
  if (typeof account !== "string" || account.trim().length === 0) {
    throw new TypeError("character catalog account is required");
  }
}

function requireRecord(value: unknown, name: string): Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, any>;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
