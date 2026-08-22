export type LocationMutationState = "moving" | "removing";

export interface LocationRecord<TKey, TValue> {
  readonly key: TKey;
  readonly value: TValue;
  readonly revision: bigint;
  readonly state: "active" | LocationMutationState;
  readonly operationId?: string;
}

/**
 * 保存Actor逻辑ID到运行时地址的版本化权威记录。
 * 所有方法都是同步操作，调用方应在一个ordered Scene mailbox中使用它；
 * 它不发送网络消息，也不缓存等待迁移的业务帧。
 *
 * Stores versioned authoritative logical-ID to runtime-address records.
 * All methods are synchronous and must be used from one ordered Scene mailbox.
 * It performs no network I/O and never buffers business frames during moves.
 */
export class LocationDirectory<TKey, TValue> {
  private readonly records = new Map<TKey, MutableLocationRecord<TKey, TValue>>();

  /** 注册一个尚不存在的位置；重复注册必须由上层判断是否属于同一Actor。 / Registers an absent location; callers must decide whether an existing record is the same Actor. */
  Register(key: TKey, value: TValue): LocationRecord<TKey, TValue> {
    if (this.records.has(key)) throw new Error("location already exists");
    const record: MutableLocationRecord<TKey, TValue> = {
      key,
      value,
      revision: 1n,
      state: "active",
    };
    this.records.set(key, record);
    return snapshot(record);
  }

  /** 返回不可变快照；修改返回值不会改变目录。 / Returns an immutable snapshot that cannot mutate the directory. */
  Resolve(key: TKey): LocationRecord<TKey, TValue> | undefined {
    const record = this.records.get(key);
    return record ? snapshot(record) : undefined;
  }

  /** 判断一次提交是否已经完成，供网络响应不确定后的同operationId重试。 / Reports whether an operation already committed so retries can recover after an ambiguous response. */
  WasCommitted(key: TKey, operationId: string): boolean {
    if (!operationId) return false;
    return this.records.get(key)?.lastCommittedOperationId === operationId;
  }

  /**
   * 以revision为CAS条件取得迁移或删除所有权。
   * 相同operationId重试是幂等的；不同操作不能抢占已有锁。
   *
   * Claims move/removal ownership with revision CAS. Retrying the same
   * operationId is idempotent; another operation cannot steal the lock.
   */
  Lock(
    key: TKey,
    expectedRevision: bigint,
    operationId: string,
    state: LocationMutationState,
  ): LocationRecord<TKey, TValue> {
    const record = this.require(key);
    if (record.state !== "active") {
      if (record.operationId === operationId && record.state === state) {
        return snapshot(record);
      }
      throw new Error("location is locked");
    }
    if (record.revision !== expectedRevision) throw new Error("location revision mismatch");
    if (!operationId) throw new Error("location operation id is required");
    record.state = state;
    record.operationId = operationId;
    return snapshot(record);
  }

  /** 原子提交新位置并递增revision；只能由持锁操作完成。 / Atomically commits a new location and increments revision for the lock owner. */
  Commit(key: TKey, operationId: string, value: TValue): LocationRecord<TKey, TValue> {
    const record = this.require(key);
    if (record.state === "active" && record.lastCommittedOperationId === operationId) {
      return snapshot(record);
    }
    if (record.state !== "moving" || record.operationId !== operationId) {
      throw new Error("location move ownership mismatch");
    }
    record.value = value;
    record.revision += 1n;
    record.state = "active";
    record.operationId = undefined;
    record.lastCommittedOperationId = operationId;
    return snapshot(record);
  }

  /** 放弃未提交操作并恢复旧位置；不会改变revision。 / Aborts an uncommitted operation and restores the old location without changing revision. */
  Unlock(key: TKey, operationId: string): LocationRecord<TKey, TValue> {
    const record = this.require(key);
    if (record.state === "active") return snapshot(record);
    if (record.operationId !== operationId) throw new Error("location lock ownership mismatch");
    record.state = "active";
    record.operationId = undefined;
    return snapshot(record);
  }

  /** 删除由removing操作锁定的记录；旧revision或旧operation不能删除新Actor。 / Removes a removing-locked record so stale revisions or operations cannot delete a new Actor. */
  Remove(key: TKey, operationId: string): LocationRecord<TKey, TValue> {
    const record = this.require(key);
    if (record.state !== "removing" || record.operationId !== operationId) {
      throw new Error("location remove ownership mismatch");
    }
    this.records.delete(key);
    return snapshot(record);
  }

  /**
   * 故障接管时删除已确认死亡所有者留下的记录；普通下线必须继续使用Lock + Remove。
   * / Deletes a record left by a confirmed-dead owner during failover; ordinary
   * offline flow must continue to use Lock + Remove.
   */
  DeleteForOwnerTakeover(key: TKey): LocationRecord<TKey, TValue> | undefined {
    const record = this.records.get(key);
    if (!record) return undefined;
    this.records.delete(key);
    return snapshot(record);
  }

  /** 返回稳定快照，供恢复与指标使用；不要在业务热路径全量遍历。 / Returns stable snapshots for recovery and metrics, never for business hot-path scans. */
  Snapshot(): readonly LocationRecord<TKey, TValue>[] {
    return [...this.records.values()].map(snapshot);
  }

  get Count(): number {
    return this.records.size;
  }

  private require(key: TKey): MutableLocationRecord<TKey, TValue> {
    const record = this.records.get(key);
    if (!record) throw new Error("location not found");
    return record;
  }
}

interface MutableLocationRecord<TKey, TValue> {
  key: TKey;
  value: TValue;
  revision: bigint;
  state: "active" | LocationMutationState;
  operationId?: string;
  lastCommittedOperationId?: string;
}

function snapshot<TKey, TValue>(
  record: MutableLocationRecord<TKey, TValue>,
): LocationRecord<TKey, TValue> {
  return {
    key: record.key,
    value: record.value,
    revision: record.revision,
    state: record.state,
    operationId: record.operationId,
  };
}
