import { Singleton, SingletonRegistry } from "../runtime/Singleton";
import { hasSealedGameModule } from "../modules/GameModuleSystem";

const DATA_PACK_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** 在任何Scene创建前由宿主校验并装入的游戏中立数据信封。 / A host-validated, game-neutral data envelope installed before any Scene is created. */
export interface RuntimeDataPackInput {
  readonly formatVersion: number;
  readonly id: string;
  readonly ownerModuleId: string;
  readonly contentHash: string;
  readonly source: string;
  readonly fileHash?: string;
  readonly payload: unknown;
}

/** 单个数据包的不可变运行视图；payload schema仍由所属游戏模块拥有。 / Immutable runtime view of one data pack; its game module owns the payload schema. */
export interface RuntimeDataPack<TPayload = unknown> {
  readonly formatVersion: 1;
  readonly id: string;
  readonly ownerModuleId: string;
  readonly contentHash: string;
  readonly source: string;
  readonly fileHash?: string;
  readonly payload: TPayload;
}

/** Process局部的不可变目录；模块可以读取自己的包，但不能修改目录。 / Process-local immutable catalog; modules may read their packs but cannot mutate the catalog. */
export class RuntimeDataPackRegistry extends Singleton {
  private readonly packsById = new Map<string, RuntimeDataPack>();
  private orderedPacks: readonly RuntimeDataPack[] = Object.freeze([]);
  private installed = false;

  static get Instance(): RuntimeDataPackRegistry {
    return SingletonRegistry.Get(RuntimeDataPackRegistry);
  }

  get Count(): number {
    return this.orderedPacks.length;
  }

  List(ownerModuleId?: string): readonly RuntimeDataPack[] {
    if (ownerModuleId === undefined) return this.orderedPacks;
    return Object.freeze(this.orderedPacks.filter((pack) => pack.ownerModuleId === ownerModuleId));
  }

  Get<TPayload = unknown>(id: string): RuntimeDataPack<TPayload> {
    const pack = this.TryGet<TPayload>(id);
    if (!pack) throw new Error(`runtime data pack not found: ${id}`);
    return pack;
  }

  TryGet<TPayload = unknown>(id: string): RuntimeDataPack<TPayload> | undefined {
    return this.packsById.get(id) as RuntimeDataPack<TPayload> | undefined;
  }

  /** Core启动钩子；Process构造后业务代码不能添加数据包。 / Core bootstrap hook; business code cannot add packs after process construction. */
  __install(inputs: readonly RuntimeDataPackInput[]): void {
    if (this.installed) throw new Error("runtime data pack registry is already installed");
    const packs = inputs.map(validateAndFreezePack).sort((left, right) => left.id.localeCompare(right.id));
    for (const pack of packs) {
      if (this.packsById.has(pack.id)) {
        throw new Error(`duplicate runtime data pack id: ${pack.id}`);
      }
      this.packsById.set(pack.id, pack);
    }
    this.orderedPacks = Object.freeze(packs);
    this.installed = true;
  }

  protected override OnDestroy(): void {
    this.packsById.clear();
    this.orderedPacks = Object.freeze([]);
    this.installed = false;
  }
}

/** 仅供内部Process启动使用的入口。 / Internal process-bootstrap entrypoint. */
export function InitializeRuntimeDataPacks(inputs: readonly RuntimeDataPackInput[] = []): void {
  SingletonRegistry.Add(RuntimeDataPackRegistry).__install(inputs);
}

function validateAndFreezePack(input: RuntimeDataPackInput): RuntimeDataPack {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("runtime data pack must be an object");
  }
  if (input.formatVersion !== 1) {
    throw new Error(`unsupported runtime data pack formatVersion: ${String(input.formatVersion)}`);
  }
  if (!DATA_PACK_ID.test(input.id)) throw new Error(`invalid runtime data pack id: ${String(input.id)}`);
  if (!DATA_PACK_ID.test(input.ownerModuleId)) {
    throw new Error(`invalid runtime data pack ownerModuleId: ${String(input.ownerModuleId)}`);
  }
  if (!hasSealedGameModule(input.ownerModuleId)) {
    throw new Error(`runtime data pack owner module is not installed: ${input.ownerModuleId}`);
  }
  if (!input.id.startsWith(`${input.ownerModuleId}.`)) {
    throw new Error(`runtime data pack id must use its owner module namespace: ${input.id}`);
  }
  if (!SHA256.test(input.contentHash)) {
    throw new Error(`invalid runtime data pack contentHash: ${input.id}`);
  }
  if (input.fileHash !== undefined && !SHA256.test(input.fileHash)) {
    throw new Error(`invalid runtime data pack fileHash: ${input.id}`);
  }
  if (typeof input.source !== "string" || input.source.trim().length === 0) {
    throw new Error(`runtime data pack source must not be empty: ${input.id}`);
  }
  validateAndDeepFreezeJson(input.payload, input.id);
  return Object.freeze({
    formatVersion: 1,
    id: input.id,
    ownerModuleId: input.ownerModuleId,
    contentHash: input.contentHash,
    source: input.source,
    ...(input.fileHash === undefined ? {} : { fileHash: input.fileHash }),
    payload: input.payload,
  });
}

function validateAndDeepFreezeJson(root: unknown, packId: string): void {
  const visited = new WeakSet<object>();
  const objects: object[] = [];
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number" && Number.isFinite(value)) continue;
    if (typeof value !== "object") invalidPayload(packId);
    const object = value as object;
    if (visited.has(object)) invalidPayload(packId);
    visited.add(object);
    objects.push(object);
    if (Array.isArray(object)) {
      const keys = Reflect.ownKeys(object);
      if (keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)))) {
        invalidPayload(packId);
      }
      for (let index = 0; index < object.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(object, index)) invalidPayload(packId);
        pending.push(object[index]);
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) invalidPayload(packId);
    for (const key of Reflect.ownKeys(object)) {
      if (typeof key !== "string") invalidPayload(packId);
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) invalidPayload(packId);
      pending.push(descriptor.value);
    }
  }
  for (let index = objects.length - 1; index >= 0; index -= 1) Object.freeze(objects[index]);
}

function invalidPayload(packId: string): never {
  throw new Error(`runtime data pack payload must contain JSON values only: ${packId}`);
}
