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

interface PlayerLocationValue {
  readonly account: string;
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
  private readonly unitIdByAccount = new Map<string, number>();
  private readonly reservedUnitIdByAccount = new Map<string, number>();
  private nextUnitId = 1000;
  private conflicts = 0;
  private resolves = 0;
  private mutations = 0;

  /** Demo无账号数据库时集中分配稳定UnitId；正式数据库接入后该入口由持久化ID替代。 / Centrally allocates Demo UnitIds until the account database becomes the persistent ID authority. */
  AllocateUnitId(request: S2L_AllocatePlayerUnitId): L2S_AllocatePlayerUnitId {
    if (!request.account) this.fail("account is required for UnitId allocation");
    const existing = this.unitIdByAccount.get(request.account) ??
      this.reservedUnitIdByAccount.get(request.account);
    if (existing !== undefined) return response(request.rpcId, { unitId: existing });
    while (this.directory.Resolve(this.nextUnitId)) this.nextUnitId += 1;
    const unitId = this.nextUnitId++;
    this.reservedUnitIdByAccount.set(request.account, unitId);
    return response(request.rpcId, { unitId });
  }

  /** 发布完整创建后的Unit；相同Unit和地址的网络重试是幂等的。 / Publishes a fully created Unit; network retries with the same Unit and route are idempotent. */
  Register(request: S2L_RegisterPlayerLocation): L2S_RegisterPlayerLocation {
    validateRoute(request);
    const byAccount = this.unitIdByAccount.get(request.account);
    if (byAccount !== undefined && byAccount !== request.unitId) {
      this.fail(`account ${request.account} already belongs to unit ${byAccount}`);
    }
    const reserved = this.reservedUnitIdByAccount.get(request.account);
    if (reserved !== undefined && reserved !== request.unitId) {
      this.fail(`account ${request.account} reserved unit ${reserved}`);
    }
    const existing = this.directory.Resolve(request.unitId);
    const value = valueOf(request);
    if (existing) {
      if (!sameValue(existing.value, value)) {
        this.fail(`unit ${request.unitId} already has another location`);
      }
      return response(request.rpcId, {
        location: toSnapshot(existing),
        created: false,
      });
    }
    const created = this.directory.Register(request.unitId, value);
    this.unitIdByAccount.set(request.account, request.unitId);
    this.reservedUnitIdByAccount.delete(request.account);
    this.mutations += 1;
    return response(request.rpcId, {
      location: toSnapshot(created),
      created: true,
    });
  }

  /** 按UnitId或account查询；两个条件同时提供时必须指向同一记录。 / Resolves by UnitId or account; when both are supplied they must identify the same record. */
  Resolve(request: S2L_ResolvePlayerLocation): L2S_ResolvePlayerLocation {
    this.resolves += 1;
    let unitId = request.unitId || undefined;
    const accountUnitId = request.account
      ? this.unitIdByAccount.get(request.account)
      : undefined;
    if (unitId !== undefined && accountUnitId !== undefined && unitId !== accountUnitId) {
      this.fail("location unit/account identity mismatch");
    }
    unitId ??= accountUnitId;
    const record = unitId === undefined ? undefined : this.directory.Resolve(unitId);
    return response(request.rpcId, {
      found: record !== undefined,
      location: record ? toSnapshot(record) : emptySnapshot(),
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
      if (record) locations.push(toSnapshot(record));
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
      return response(request.rpcId, { location: toSnapshot(locked) });
    } catch (error) {
      return this.rethrow(error);
    }
  }

  /** 将moving记录切换到新Actor；提交成功后旧Actor不得再恢复权威。 / Switches a moving record to the new Actor; the old Actor can never regain authority after commit. */
  Commit(request: S2L_CommitPlayerLocation): L2S_CommitPlayerLocation {
    validateRoute(request);
    const current = this.require(request.unitId);
    const value: PlayerLocationValue = {
      account: current.value.account,
      gateName: request.gateName,
      mapHostName: request.mapHostName,
      mapId: request.mapId,
      mapInstanceId: request.mapInstanceId,
      actorInstanceId: request.actorInstanceId,
    };
    try {
      const committed = this.directory.Commit(request.unitId, request.operationId, value);
      this.mutations += 1;
      return response(request.rpcId, { location: toSnapshot(committed) });
    } catch (error) {
      return this.rethrow(error);
    }
  }

  /** 放弃尚未提交的位置变更并继续使用旧Actor。 / Aborts an uncommitted location mutation and resumes the old Actor. */
  Unlock(request: S2L_UnlockPlayerLocation): L2S_UnlockPlayerLocation {
    try {
      const unlocked = this.directory.Unlock(request.unitId, request.operationId);
      this.mutations += 1;
      return response(request.rpcId, { location: toSnapshot(unlocked) });
    } catch (error) {
      return this.rethrow(error);
    }
  }

  /** 只删除由同一removing操作锁住的位置，并同步清理account索引。 / Removes only a record locked by the same removing operation and clears its account index. */
  Remove(request: S2L_RemovePlayerLocation): L2S_RemovePlayerLocation {
    try {
      const removed = this.directory.Remove(request.unitId, request.operationId);
      if (this.unitIdByAccount.get(removed.value.account) === request.unitId) {
        this.unitIdByAccount.delete(removed.value.account);
      }
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

    const pending: PlayerLocationRecovery[] = [];
    const unitIds = new Set<number>();
    const accounts = new Set<string>();
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
      if (!accounts.add(location.account)) {
        this.fail(`duplicate recovery account: ${location.account}`);
      }

      const accountUnitId = this.unitIdByAccount.get(location.account);
      if (accountUnitId !== undefined && accountUnitId !== location.unitId) {
        this.fail(`account ${location.account} already belongs to unit ${accountUnitId}`);
      }
      const existing = this.directory.Resolve(location.unitId);
      const value = valueOf(location);
      if (!existing) {
        pending.push(location);
      } else if (sameValue(existing.value, value)) {
        unchanged += 1;
      } else {
        this.fail(`unit ${location.unitId} recovery conflicts with current location`);
      }
    }

    for (const location of pending) {
      this.directory.Register(location.unitId, valueOf(location));
      this.unitIdByAccount.set(location.account, location.unitId);
      this.reservedUnitIdByAccount.delete(location.account);
    }
    this.mutations += pending.length;
    return response(request.rpcId, {
      recovered: pending.length,
      unchanged,
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
    this.unitIdByAccount.clear();
    this.reservedUnitIdByAccount.clear();
  }

  private require(unitId: number): LocationRecord<number, PlayerLocationValue> {
    const record = this.directory.Resolve(unitId);
    if (!record) throw new RpcError(SystemErrCode.ActorLocationNotFound, `location not found: ${unitId}`);
    return record;
  }

  private fail(message: string): never {
    this.conflicts += 1;
    throw new RpcError(SystemErrCode.LocationConflict, message);
  }

  private rethrow(error: unknown): never {
    if (error instanceof RpcError) throw error;
    this.fail(error instanceof Error ? error.message : String(error));
  }
}

function valueOf(request: S2L_RegisterPlayerLocation | PlayerLocationRecovery): PlayerLocationValue {
  return {
    account: request.account,
    gateName: request.gateName,
    mapHostName: request.mapHostName,
    mapId: request.mapId,
    mapInstanceId: request.mapInstanceId,
    actorInstanceId: request.actorInstanceId,
  };
}

function toSnapshot(
  record: LocationRecord<number, PlayerLocationValue>,
): PlayerLocationSnapshot {
  return {
    unitId: record.key,
    account: record.value.account,
    gateName: record.value.gateName,
    mapHostName: record.value.mapHostName,
    mapId: record.value.mapId,
    mapInstanceId: record.value.mapInstanceId,
    actorInstanceId: record.value.actorInstanceId,
    revision: record.revision,
    state: record.state,
  };
}

function sameValue(left: PlayerLocationValue, right: PlayerLocationValue): boolean {
  return left.account === right.account &&
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
    gateName: "",
    mapHostName: "",
    mapId: 0,
    mapInstanceId: 0n,
    actorInstanceId: 0,
    revision: 0n,
    state: "",
  };
}

function validateRoute(request: {
  unitId: number;
  gateName: string;
  mapHostName: string;
  mapId: number;
  mapInstanceId: bigint;
  actorInstanceId: number;
}): void {
  if (request.unitId <= 0 || request.mapId <= 0 || request.mapInstanceId <= 0n || request.actorInstanceId <= 0) {
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
