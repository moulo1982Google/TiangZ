import {
  Component,
  LocationDirectory,
  RpcError,
  SystemErrCode,
  type CustomMetricSnapshot,
  type LocationMutationState,
  type LocationRecord,
} from "../../../core/public";
import type {
  L2S_CommitPlayerLocation,
  L2S_AllocatePlayerUnitId,
  L2S_LockPlayerLocation,
  L2S_RegisterPlayerLocation,
  L2S_RecoverPlayerLocations,
  L2S_RemovePlayerLocation,
  L2S_ResolvePlayerLocation,
  L2S_ResolvePlayerLocations,
  L2S_UnlockPlayerLocation,
  PlayerLocationSnapshot,
  PlayerLocationRecovery,
  MapHostEndpoint,
  S2L_CommitPlayerLocation,
  S2L_AllocatePlayerUnitId,
  S2L_LockPlayerLocation,
  S2L_RegisterPlayerLocation,
  S2L_RecoverPlayerLocations,
  S2L_RemovePlayerLocation,
  S2L_ResolvePlayerLocation,
  S2L_ResolvePlayerLocations,
  S2L_UnlockPlayerLocation,
} from "../../../generated/model/server/demo/protocol/messages";
import { MapInstanceDirectoryComponent } from "./MapInstanceDirectoryComponent";

interface PlayerLocationValue {
  readonly account: string;
  readonly characterId: bigint;
  readonly gateName: string;
  readonly mapHostName: string;
  readonly mapId: number;
  readonly mapInstanceId: bigint;
  readonly actorInstanceId: number;
}

/**
 * 维护一个区服内玩家Unit的权威运行时位置。
 * 该Component只保存路由元数据；禁止写入坐标、数值、道具、connectionId或业务快照。
 *
 * Maintains authoritative runtime locations for player Units in one realm.
 * It stores routing metadata only; positions, numerics, items, connection IDs,
 * and business snapshots must never be added here.
 */
export class LocationComponent extends Component {
  private readonly directory = new LocationDirectory<number, PlayerLocationValue>();
  private readonly unitIdByCharacterId = new Map<bigint, number>();
  private readonly reservedUnitIdByCharacterId = new Map<bigint, number>();
  private readonly unitIdsByAccount = new Map<string, Set<number>>();
  private readonly ownerGenerations = new Map<string, bigint>();
  private nextUnitId = 1000;
  private conflicts = 0;
  private resolves = 0;
  private mutations = 0;
  private mapInstances: MapInstanceDirectoryComponent | null = null;

  /** 绑定同LocationScene的地图实例目录，使玩家路由响应可携带动态MapHost地址。 / Binds the colocated map-instance directory so player routes carry dynamic MapHost endpoints. */
  BindMapInstances(mapInstances: MapInstanceDirectoryComponent): void {
    this.mapInstances = mapInstances;
  }

  /** Demo无账号数据库时集中分配运行时UnitId；分配键是稳定characterId。 / Allocates runtime UnitIds centrally while using stable characterId as the allocation key. */
  AllocateUnitId(request: S2L_AllocatePlayerUnitId): L2S_AllocatePlayerUnitId {
    if (!request.account) this.fail("account is required for UnitId allocation");
    if (request.characterId <= 0n) this.fail("characterId is required for UnitId allocation");
    const existing = this.unitIdByCharacterId.get(request.characterId) ??
      this.reservedUnitIdByCharacterId.get(request.characterId);
    if (existing !== undefined) {
      return response(request.rpcId, { unitId: existing, characterId: request.characterId });
    }
    while (this.directory.Resolve(this.nextUnitId)) this.nextUnitId += 1;
    const unitId = this.nextUnitId++;
    this.reservedUnitIdByCharacterId.set(request.characterId, unitId);
    return response(request.rpcId, { unitId, characterId: request.characterId });
  }

  /** 发布完整创建后的Unit；相同Unit和地址的网络重试是幂等的。 / Publishes a fully created Unit; network retries with the same Unit and route are idempotent. */
  Register(request: S2L_RegisterPlayerLocation): L2S_RegisterPlayerLocation {
    validateRoute(request);
    this.requireOwnerGeneration(request.mapHostName, request.ownerGeneration);
    const byCharacter = this.unitIdByCharacterId.get(request.characterId);
    if (byCharacter !== undefined && byCharacter !== request.unitId) {
      this.fail(`character ${request.characterId} already belongs to unit ${byCharacter}`);
    }
    const reserved = this.reservedUnitIdByCharacterId.get(request.characterId);
    if (reserved !== undefined && reserved !== request.unitId) {
      this.fail(`character ${request.characterId} reserved unit ${reserved}`);
    }
    const existing = this.directory.Resolve(request.unitId);
    const value = valueOf(request);
    if (existing) {
      if (!sameValue(existing.value, value)) {
        this.fail(`unit ${request.unitId} already has another location`);
      }
      return response(request.rpcId, {
        location: this.toSnapshot(existing),
        created: false,
      });
    }
    const created = this.directory.Register(request.unitId, value);
    this.unitIdByCharacterId.set(request.characterId, request.unitId);
    this.reservedUnitIdByCharacterId.delete(request.characterId);
    this.addAccountIndex(request.account, request.unitId);
    this.mutations += 1;
    return response(request.rpcId, {
      location: this.toSnapshot(created),
      created: true,
    });
  }

  /** 按UnitId或account查询；两个条件同时提供时必须指向同一记录。 / Resolves by UnitId or account; when both are supplied they must identify the same record. */
  Resolve(request: S2L_ResolvePlayerLocation): L2S_ResolvePlayerLocation {
    this.resolves += 1;
    let unitId = request.unitId || undefined;
    const characterUnitId = request.characterId > 0n
      ? this.unitIdByCharacterId.get(request.characterId)
      : undefined;
    const accountUnitIds = request.account ? this.unitIdsByAccount.get(request.account) : undefined;
    const accountUnitId = accountUnitIds?.size === 1 ? [...accountUnitIds][0] : undefined;
    if (request.account && accountUnitIds && accountUnitIds.size > 1 && request.characterId <= 0n && unitId === undefined) {
      this.fail(`account ${request.account} has multiple characters; characterId is required`);
    }
    if (unitId !== undefined && characterUnitId !== undefined && unitId !== characterUnitId) {
      this.fail("location unit/account identity mismatch");
    }
    if (unitId !== undefined && accountUnitId !== undefined && request.characterId <= 0n && unitId !== accountUnitId) {
      this.fail("location unit/account identity mismatch");
    }
    unitId ??= characterUnitId ?? accountUnitId;
    const record = unitId === undefined ? undefined : this.directory.Resolve(unitId);
    return response(request.rpcId, {
      found: record !== undefined,
      location: record ? this.toSnapshot(record) : emptySnapshot(),
    });
  }

  /** 批量解析在线位置，输入重复UnitId只返回一次。 / Resolves active locations in a batch and returns each duplicate UnitId once. */
  ResolveMany(request: S2L_ResolvePlayerLocations): L2S_ResolvePlayerLocations {
    const locations: PlayerLocationSnapshot[] = [];
    const visited = new Set<number>();
    for (const unitId of request.unitIds) {
      if (visited.has(unitId)) continue;
      visited.add(unitId);
      this.resolves += 1;
      const record = this.directory.Resolve(unitId);
      if (record) locations.push(this.toSnapshot(record));
    }
    return response(request.rpcId, { locations });
  }

  /** 在迁移或下线前执行revision与Actor代次CAS并取得操作锁。 / Claims a move/removal lock after revision and Actor-generation CAS. */
  Lock(request: S2L_LockPlayerLocation): L2S_LockPlayerLocation {
    const record = this.require(request.unitId);
    if (record.value.actorInstanceId !== request.expectedActorInstanceId) {
      this.fail(`unit ${request.unitId} actor instance changed`);
    }
    const state = parseMutationState(request.state);
    try {
      const locked = this.directory.Lock(
        request.unitId,
        request.expectedRevision,
        request.operationId,
        state,
      );
      this.mutations += 1;
      return response(request.rpcId, { location: this.toSnapshot(locked) });
    } catch (error) {
      return this.rethrow(error);
    }
  }

  /** 将moving记录切换到新Actor；提交成功后旧Actor不得再恢复权威。 / Switches a moving record to the new Actor; the old Actor can never regain authority after commit. */
  Commit(request: S2L_CommitPlayerLocation): L2S_CommitPlayerLocation {
    this.requireOwnerGeneration(request.mapHostName, request.ownerGeneration);
    validateRoute(request);
    const current = this.require(request.unitId);
    const value: PlayerLocationValue = {
      account: current.value.account,
      gateName: request.gateName,
      mapHostName: request.mapHostName,
      mapId: request.mapId,
      mapInstanceId: request.mapInstanceId,
      actorInstanceId: request.actorInstanceId,
      characterId: request.characterId,
    };
    try {
      const committed = this.directory.Commit(request.unitId, request.operationId, value);
      this.mutations += 1;
      return response(request.rpcId, { location: this.toSnapshot(committed) });
    } catch (error) {
      return this.rethrow(error);
    }
  }

  /** 放弃尚未提交的位置变更并继续使用旧Actor。 / Aborts an uncommitted location mutation and resumes the old Actor. */
  Unlock(request: S2L_UnlockPlayerLocation): L2S_UnlockPlayerLocation {
    try {
      const unlocked = this.directory.Unlock(request.unitId, request.operationId);
      this.mutations += 1;
      return response(request.rpcId, { location: this.toSnapshot(unlocked) });
    } catch (error) {
      return this.rethrow(error);
    }
  }

  /** 只删除由同一removing操作锁住的位置，并同步清理account索引。 / Removes only a record locked by the same removing operation and clears its account index. */
  Remove(request: S2L_RemovePlayerLocation): L2S_RemovePlayerLocation {
    try {
      const removed = this.directory.Remove(request.unitId, request.operationId);
      this.unitIdByCharacterId.delete(removed.value.characterId);
      this.removeAccountIndex(removed.value.account, request.unitId);
      this.mutations += 1;
      return response(request.rpcId, { removed: true });
    } catch (error) {
      return this.rethrow(error);
    }
  }

  /**
   * Location进程重启后，由仍持有权威Unit的MapHost批量重建目录。
   * 恢复不会覆盖已存在的不同记录，也不会把moving/removing事务强行改回active。
   *
   * Rebuilds the directory from authoritative Units still owned by one MapHost
   * after a Location restart. Recovery never overwrites a conflicting record
   * or forces an in-flight moving/removing transaction back to active.
   */
  RecoverOwner(request: S2L_RecoverPlayerLocations): L2S_RecoverPlayerLocations {
    if (!request.ownerName) this.fail("location recovery owner is required");
    if (request.ownerGeneration <= 0n) this.fail("location recovery generation is required");

    const activeGeneration = this.ownerGenerations.get(request.ownerName);
    if (activeGeneration !== undefined && request.ownerGeneration < activeGeneration) {
      this.fail(`stale location recovery generation for ${request.ownerName}`);
    }
    const ownerReplaced = activeGeneration !== undefined && request.ownerGeneration > activeGeneration;

    const pending: PlayerLocationRecovery[] = [];
    const unitIds = new Set<number>();
    const characterIds = new Set<bigint>();
    let unchanged = 0;

    // 先完整校验，再写入，避免一个坏条目造成半批恢复。
    // Validate the whole batch before mutation so one bad entry cannot cause a partial restore.
    for (const location of request.locations) {
      validateRoute(location);
      if (!location.account) this.fail("location recovery account is required");
      if (location.mapHostName !== request.ownerName) {
        this.fail(`location recovery owner mismatch: ${location.mapHostName}`);
      }
      if (!unitIds.add(location.unitId)) {
        this.fail(`duplicate recovery unit: ${location.unitId}`);
      }
      if (!characterIds.add(location.characterId)) {
        this.fail(`duplicate recovery character: ${location.characterId}`);
      }

      const characterUnitId = this.unitIdByCharacterId.get(location.characterId);
      const characterRecord = characterUnitId === undefined
        ? undefined
        : this.directory.Resolve(characterUnitId);
      const characterBelongsToReplacedOwner = ownerReplaced &&
        characterRecord?.value.mapHostName === request.ownerName;
      if (characterUnitId !== undefined && characterUnitId !== location.unitId && !characterBelongsToReplacedOwner) {
        this.fail(`character ${location.characterId} already belongs to unit ${characterUnitId}`);
      }
      const existing = this.directory.Resolve(location.unitId);
      const value = valueOf(location);
      if (!existing || (ownerReplaced && existing.value.mapHostName === request.ownerName)) {
        pending.push(location);
      } else if (sameValue(existing.value, value)) {
        unchanged += 1;
      } else {
        this.fail(`unit ${location.unitId} recovery conflicts with current location`);
      }
    }

    const removedStale = ownerReplaced ? this.removeOwnerLocations(request.ownerName) : 0;
    this.ownerGenerations.set(request.ownerName, request.ownerGeneration);
    for (const location of pending) {
      this.directory.Register(location.unitId, valueOf(location));
      this.unitIdByCharacterId.set(location.characterId, location.unitId);
      this.reservedUnitIdByCharacterId.delete(location.characterId);
      this.addAccountIndex(location.account, location.unitId);
    }
    this.mutations += pending.length;
    return response(request.rpcId, {
      recovered: pending.length,
      unchanged,
      removedStale,
      ownerReplaced,
    });
  }

  /** 导出低基数运行指标；不暴露账号或UnitId标签。 / Exports low-cardinality runtime metrics without account or UnitId labels. */
  Metrics(): CustomMetricSnapshot {
    let moving = 0;
    let removing = 0;
    for (const record of this.directory.Snapshot()) {
      if (record.state === "moving") moving += 1;
      if (record.state === "removing") removing += 1;
    }
    return {
      name: "location_directory",
      values: {
        entries: this.directory.Count,
        moving,
        removing,
        resolves_total: this.resolves,
        mutations_total: this.mutations,
        conflicts_total: this.conflicts,
      },
      kinds: {
        resolves_total: "counter",
        mutations_total: "counter",
        conflicts_total: "counter",
      },
    };
  }

  protected override OnDestroy(): void {
    this.unitIdByCharacterId.clear();
    this.reservedUnitIdByCharacterId.clear();
    this.unitIdsByAccount.clear();
    this.ownerGenerations.clear();
  }

  /** 代次切换只清除旧Actor路由，不接管任何玩家业务状态。 / A generation takeover removes stale Actor routes only and never owns player business state. */
  private removeOwnerLocations(ownerName: string): number {
    let removed = 0;
    for (const record of this.directory.Snapshot()) {
      if (record.value.mapHostName !== ownerName) continue;
      this.directory.DeleteForOwnerTakeover(record.key);
      this.unitIdByCharacterId.delete(record.value.characterId);
      this.removeAccountIndex(record.value.account, record.key);
      removed += 1;
    }
    this.mutations += removed;
    return removed;
  }

  private requireOwnerGeneration(ownerName: string, generation: bigint): void {
    const active = this.ownerGenerations.get(ownerName);
    if (active === undefined || generation !== active) {
      this.fail(`MapHost generation is not active: ${ownerName}`);
    }
  }

  private require(unitId: number): LocationRecord<number, PlayerLocationValue> {
    const record = this.directory.Resolve(unitId);
    if (!record) throw new RpcError(SystemErrCode.ActorLocationNotFound, `location not found: ${unitId}`);
    return record;
  }

  private toSnapshot(
    record: LocationRecord<number, PlayerLocationValue>,
  ): PlayerLocationSnapshot {
    const mapHost = this.mapInstances?.Get(record.value.mapInstanceId)?.mapHost ?? emptyEndpoint();
    return toSnapshot(record, mapHost);
  }

  private fail(message: string): never {
    this.conflicts += 1;
    throw new RpcError(SystemErrCode.LocationConflict, message);
  }

  private addAccountIndex(account: string, unitId: number): void {
    let unitIds = this.unitIdsByAccount.get(account);
    if (!unitIds) {
      unitIds = new Set<number>();
      this.unitIdsByAccount.set(account, unitIds);
    }
    unitIds.add(unitId);
  }

  private removeAccountIndex(account: string, unitId: number): void {
    const unitIds = this.unitIdsByAccount.get(account);
    if (!unitIds) return;
    unitIds.delete(unitId);
    if (unitIds.size === 0) this.unitIdsByAccount.delete(account);
  }

  private rethrow(error: unknown): never {
    if (error instanceof RpcError) throw error;
    this.fail(error instanceof Error ? error.message : String(error));
  }
}

function valueOf(request: S2L_RegisterPlayerLocation | PlayerLocationRecovery): PlayerLocationValue {
  return {
    account: request.account,
    characterId: request.characterId,
    gateName: request.gateName,
    mapHostName: request.mapHostName,
    mapId: request.mapId,
    mapInstanceId: request.mapInstanceId,
    actorInstanceId: request.actorInstanceId,
  };
}

function toSnapshot(
  record: LocationRecord<number, PlayerLocationValue>,
  mapHost: MapHostEndpoint,
): PlayerLocationSnapshot {
  return {
    unitId: record.key,
    account: record.value.account,
    characterId: record.value.characterId,
    gateName: record.value.gateName,
    mapHostName: record.value.mapHostName,
    mapId: record.value.mapId,
    mapInstanceId: record.value.mapInstanceId,
    actorInstanceId: record.value.actorInstanceId,
    revision: record.revision,
    state: record.state,
    mapHost,
  };
}

function sameValue(left: PlayerLocationValue, right: PlayerLocationValue): boolean {
    return left.account === right.account &&
    left.characterId === right.characterId &&
    left.gateName === right.gateName &&
    left.mapHostName === right.mapHostName &&
    left.mapId === right.mapId &&
    left.mapInstanceId === right.mapInstanceId &&
    left.actorInstanceId === right.actorInstanceId;
}

function emptySnapshot(): PlayerLocationSnapshot {
  return {
    unitId: 0,
    account: "",
    characterId: 0n,
    gateName: "",
    mapHostName: "",
    mapId: 0,
    mapInstanceId: 0n,
    actorInstanceId: 0,
    revision: 0n,
    state: "",
    mapHost: emptyEndpoint(),
  };
}

function emptyEndpoint(): MapHostEndpoint {
  return { name: "", ip: "", port: 0, protocol: "", audience: "" };
}

function validateRoute(request: {
  unitId: number;
  gateName: string;
  mapHostName: string;
  mapId: number;
  mapInstanceId: bigint;
  actorInstanceId: number;
  characterId: bigint;
}): void {
  if (request.unitId <= 0 || request.characterId <= 0n || request.mapId <= 0 || request.mapInstanceId <= 0n || request.actorInstanceId <= 0) {
    throw new RpcError(SystemErrCode.LocationConflict, "location route contains invalid IDs");
  }
  if (!request.gateName || !request.mapHostName) {
    throw new RpcError(SystemErrCode.LocationConflict, "location route is incomplete");
  }
}

function parseMutationState(value: string): LocationMutationState {
  if (value === "moving" || value === "removing") return value;
  throw new RpcError(SystemErrCode.LocationConflict, `invalid location mutation state: ${value}`);
}

function response<T extends object>(rpcId: number | undefined, value: T): T & {
  rpcId?: number;
  error: number;
  message: string;
} {
  return { rpcId, error: 0, message: "", ...value };
}
