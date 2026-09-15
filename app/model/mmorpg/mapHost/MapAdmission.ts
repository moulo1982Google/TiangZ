import { RpcError } from "../../../core/public";
import { GameErrCode } from "../../game/protocol/GameErrCode";

export interface MapHostingCapacity {
  readonly maxMaps: number;
  readonly maxPlayers: number;
  readonly mapConfigIds: readonly number[];
}

export interface PublicMapPolicy {
  readonly mapConfigId: number;
  readonly maxPlayers: number;
  readonly minChannels: number;
  readonly idleTimeoutMs: number;
}

export interface HostedPublicChannel {
  readonly channelId: number;
  readonly maxPlayers: number;
  readonly reservations: Map<bigint, number>;
}

/** 规范化并复制私有名单；未提供与空名单具有不同语义。 / Copies a validated private roster; omission differs from an empty roster. */
export function NormalizePrivateRoster(roster?: { readonly characterIds: readonly bigint[] }): { characterIds: bigint[] } | undefined {
  if (!roster) return undefined;
  const ids = roster.characterIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 40
    || ids.some(id => typeof id !== "bigint" || id <= 0n || id > 0xffff_ffff_ffff_ffffn)
    || new Set(ids).size !== ids.length) throw new Error("invalid private map roster");
  return { characterIds: [...ids].sort((a, b) => a < b ? -1 : a > b ? 1 : 0) };
}

/** 比较名单集合，忽略输入顺序，区分公共和私有。 / Compares membership sets, preserving public/private distinction. */
export function SamePrivateRoster(left?: { readonly characterIds: readonly bigint[] }, right?: { readonly characterIds: readonly bigint[] }): boolean {
  return NormalizePrivateRoster(left)?.characterIds.join(",") === NormalizePrivateRoster(right)?.characterIds.join(",");
}

/** 宿主拥有的准入账本；准备中的玩家同样由占用快照计数。 / Host-owned admission ledger; prepared players count as occupied seats. */
export class MapAdmission {
  private capacity: MapHostingCapacity = { maxMaps: 0, maxPlayers: 0, mapConfigIds: [] };
  private configured = false;
  readonly PrivateMaps = new Map<bigint, { readonly allowed: ReadonlySet<bigint>; readonly reservations: Map<bigint, number> }>();
  readonly Channels = new Map<bigint, HostedPublicChannel>();

  /** 启动期冻结宿主上限；零表示尚未配置容量限制。 / Freezes startup capacity; zero means no configured limit. */
  Configure(value: MapHostingCapacity): void {
    if (this.configured) throw new Error("map hosting capacity already configured");
    for (const count of [value.maxMaps, value.maxPlayers]) {
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid map hosting capacity");
    }
    if (value.mapConfigIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error("invalid hosted map config");
    this.capacity = { ...value, mapConfigIds: [...value.mapConfigIds] };
    this.configured = true;
  }

  /** 返回只读配置副本，供注册和心跳使用。 / Returns a configuration copy for registration and heartbeat. */
  Capacity(): MapHostingCapacity { return { ...this.capacity, mapConfigIds: [...this.capacity.mapConfigIds] }; }

  /** 未启用容量限制的旧地图不扫描所有宿主角色。 / Legacy maps without capacity limits avoid scanning all host characters. */
  RequiresAdmission(instanceId: bigint): boolean {
    return this.capacity.maxPlayers > 0 || this.Channels.has(instanceId) || this.PrivateMaps.has(instanceId);
  }

  /** 创建前检查宿主实例预算及地图类型；重试已有实例应在调用前返回。 / Checks instance budget and template eligibility before creating a new instance. */
  RequireCreation(mapConfigId: number, mapCount: number): void {
    if ((this.capacity.maxMaps > 0 && mapCount >= this.capacity.maxMaps)
      || (this.capacity.mapConfigIds.length > 0 && !this.capacity.mapConfigIds.includes(mapConfigId))) {
      throw new RpcError(GameErrCode.MapHostCapacity, "MapHost has no capacity for this map");
    }
  }

  /** 安装公共分线规则；同实例重试必须保持定义一致。 / Installs a public channel definition and rejects conflicting retries. */
  AddChannel(instanceId: bigint, channelId: number, maxPlayers: number): void {
    if (!Number.isSafeInteger(channelId) || channelId <= 0 || !Number.isSafeInteger(maxPlayers) || maxPlayers <= 0) {
      throw new Error("invalid public channel definition");
    }
    if (this.PrivateMaps.has(instanceId)) throw new Error("private map cannot become a public channel");
    const existing = this.Channels.get(instanceId);
    if (existing && (existing.channelId !== channelId || existing.maxPlayers !== maxPlayers)) throw new Error("public channel conflict");
    if (!existing) this.Channels.set(instanceId, { channelId, maxPlayers, reservations: new Map() });
  }

  /** 一次预留整份名单；容量不足时不安装任何席位，重试不续期。 / Reserves a full roster atomically; insufficient capacity installs nothing and retries never renew. */
  AddPrivate(instanceId: bigint, roster: { readonly characterIds: readonly bigint[] }, occupants: ReadonlyMap<bigint, ReadonlySet<bigint>>, now = Date.now()): void {
    const ids = NormalizePrivateRoster(roster)!.characterIds;
    if (this.Channels.has(instanceId)) throw new Error("public channel cannot have a private roster");
    const existing = this.PrivateMaps.get(instanceId);
    if (existing) {
      if (ids.length !== existing.allowed.size || ids.some(id => !existing.allowed.has(id))) throw new Error("private roster conflict");
      return;
    }
    this.Sweep(occupants, now);
    const occupied = this.Occupied(occupants);
    for (const id of ids) occupied.add(id);
    if (this.capacity.maxPlayers > 0 && occupied.size > this.capacity.maxPlayers) {
      throw new RpcError(GameErrCode.MapHostCapacity, "MapHost cannot reserve the complete private roster");
    }
    this.PrivateMaps.set(instanceId, { allowed: new Set(ids), reservations: new Map(ids.filter(id => !occupants.get(instanceId)?.has(id)).map(id => [id, now + 30_000])) });
  }

  /** 空实例回收也必须等待私有席位过期。 / Empty instance disposal must also wait for private reservations to expire. */
  ReservedCount(instanceId: bigint, occupants: ReadonlyMap<bigint, ReadonlySet<bigint>>, now = Date.now()): number {
    this.Sweep(occupants, now);
    return (this.Channels.get(instanceId)?.reservations.size ?? 0) + (this.PrivateMaps.get(instanceId)?.reservations.size ?? 0);
  }

  /** 清理超时预留；已创建玩家占用实体席位，不再重复计数。 / Expires reservations and replaces reservations with actual entity occupancy. */
  Sweep(occupants: ReadonlyMap<bigint, ReadonlySet<bigint>>, now = Date.now()): void {
    for (const [id, channel] of [...this.Channels, ...this.PrivateMaps]) {
      for (const [characterId, expires] of channel.reservations) {
        if (expires <= now || occupants.get(id)?.has(characterId)) channel.reservations.delete(characterId);
      }
    }
  }

  /** 原子预留一个角色席位；重试复用截止时间，不延长过期请求。 / Atomically reserves a character seat; retries retain the original deadline. */
  Reserve(instanceId: bigint, characterId: bigint, occupants: ReadonlyMap<bigint, ReadonlySet<bigint>>, now = Date.now()): number {
    if (characterId <= 0n) throw new Error("character identity is required");
    this.Sweep(occupants, now);
    const channel = this.Channels.get(instanceId);
    if (!channel) throw new Error("not a public channel");
    if (occupants.get(instanceId)?.has(characterId)) return now + 30_000;
    const existing = channel.reservations.get(characterId);
    if (existing) return existing;
    if ((occupants.get(instanceId)?.size ?? 0) + channel.reservations.size >= channel.maxPlayers) return 0;
    if (!this.HasHostSeat(characterId, occupants)) return 0;
    const expires = now + 30_000;
    channel.reservations.set(characterId, expires);
    return expires;
  }

  /** 在同步玩家工厂内消费席位，覆盖首次进入、同宿主及跨宿主迁移。 / Consumes admission synchronously inside all player creation and transfer paths. */
  Admit(instanceId: bigint, characterId: bigint, occupants: ReadonlyMap<bigint, ReadonlySet<bigint>>, now = Date.now()): void {
    this.Sweep(occupants, now);
    const privateMap = this.PrivateMaps.get(instanceId);
    if (privateMap && !privateMap.allowed.has(characterId)) throw new RpcError(GameErrCode.MapAdmissionExpired, "character is not in the private map roster");
    const channel = this.Channels.get(instanceId);
    if (channel && (!channel.reservations.has(characterId)
      || (occupants.get(instanceId)?.size ?? 0) >= channel.maxPlayers)) {
      throw new RpcError(GameErrCode.MapAdmissionExpired, "public map reservation missing, expired, or full");
    }
    if (!this.HasHostSeat(characterId, occupants)) throw new RpcError(GameErrCode.MapHostCapacity, "MapHost player capacity reached");
    channel?.reservations.delete(characterId);
    privateMap?.reservations.delete(characterId);
  }

  /** 汇总唯一角色数，源和目标同时存在的同进程迁移只计一个角色。 / Counts unique characters so a local transfer does not consume a second host seat. */
  Occupied(occupants: ReadonlyMap<bigint, ReadonlySet<bigint>>): Set<bigint> {
    const characters = new Set<bigint>();
    for (const values of occupants.values()) for (const id of values) characters.add(id);
    for (const channel of [...this.Channels.values(), ...this.PrivateMaps.values()]) for (const id of channel.reservations.keys()) characters.add(id);
    return characters;
  }

  /** 检查角色是否已有宿主席位，或宿主仍可接纳新角色。 / Checks existing character occupancy or room for a new host occupant. */
  private HasHostSeat(characterId: bigint, occupants: ReadonlyMap<bigint, ReadonlySet<bigint>>): boolean {
    const occupied = this.Occupied(occupants);
    return this.capacity.maxPlayers === 0 || occupied.has(characterId) || occupied.size < this.capacity.maxPlayers;
  }
}
