import { DbProxyErrorCode, DbProxyRemoteError, type DbProxyClient, type DbProxySnapshotWrite } from "@tiangz/dbproxy-sdk";
import { GLOBAL_ID_COUNTER_LIMIT, GLOBAL_ID_COUNTERS_PER_SECOND, GLOBAL_ID_EPOCH_SECONDS,
  validateGlobalIdSlot, type GlobalIdCounterSource } from "../runtime/GlobalIdLayout";
import { monotonicNow } from "../runtime/Game";

const SCHEMA = "tiangz.global-id.high-water";
const NAMESPACE = "tiangz.global-id";
const DEFAULT_BLOCK_SIZE = 65_536;
type Range = { next: number; end: number };
type Store = Pick<DbProxyClient, "Load" | "Save">;

/**
 * CAS 推进持久高水位；只有首次 applied 响应可授予本地号段，duplicate 一律跳过。
 * 不依赖 GlobalId 生成请求号；请求内容固定，未知结果保留原请求，下次重试不能重建。
 * CAS advances a durable high-water mark. Only an applied reply grants ownership;
 * duplicate replies burn the range. Unknown outcomes retain the exact request for retry.
 */
export class GlobalIdRangeAllocator implements GlobalIdCounterSource {
  private active: Range | undefined;
  private spare: Range | undefined;
  private pending: Promise<void> | undefined;
  private pendingWrite: DbProxySnapshotWrite | undefined;
  private observedEnd = 0;
  private closed = false;
  private retryAt = 0;
  private lastError: unknown;

  constructor(
    private readonly store: Store,
    readonly OriginServerId: number,
    readonly WorkerId: number,
    private readonly blockSize = DEFAULT_BLOCK_SIZE,
    private readonly wallNow: () => number = Date.now,
    private readonly retryNow: () => number = monotonicNow,
  ) {
    validateGlobalIdSlot(OriginServerId, WorkerId);
    if (!Number.isInteger(blockSize) || blockSize < 1 || blockSize > 1_048_576) {
      throw new Error("global id block size must be in [1, 1048576]");
    }
  }

  /** 首个号段确认前不允许发布 Scene；并发调用共用同一请求。 / Prevents Scene publication before the first confirmed range; concurrent calls share one request. */
  async Start(): Promise<void> {
    this.requireOpen();
    if (!this.active && !this.spare) await this.refill();
    this.requireOpen();
  }

  /** 只从本地号段同步取值；不足时有界预取，但绝不回退墙钟生成器。 / Allocates synchronously from local ranges, prefetching with bounds and never falling back to clock IDs. */
  NextCounter(): number {
    this.requireOpen();
    if (!this.active || this.active.next === this.active.end) {
      this.active = this.spare;
      this.spare = undefined;
    }
    if (!this.active) {
      this.prefetch();
      throw new Error("global id range depleted; retry after DBProxy reservation completes", { cause: this.lastError });
    }
    const counter = this.active.next++;
    if (this.active.end - this.active.next <= Math.floor(this.blockSize / 2)) this.prefetch();
    return counter;
  }

  /** 停机时丢弃未消费号段；迟到的预取响应不能重新开放发号。 / Burns unused ranges on shutdown; late reservations cannot reopen allocation. */
  Dispose(): void {
    this.closed = true;
    this.active = undefined;
    this.spare = undefined;
  }

  private requireOpen(): void {
    if (this.closed) throw new Error("global id allocator is closed");
  }

  private prefetch(): void {
    if (this.spare || this.pending || this.retryNow() < this.retryAt) return;
    void this.refill().catch(() => { /* refill records failure; NextCounter remains fail-closed. */ });
  }

  private refill(): Promise<void> {
    this.requireOpen();
    this.pending ??= this.reserve().then(range => {
      this.requireOpen();
      this.spare = range;
      this.lastError = undefined;
      this.retryAt = 0;
    }).catch((error: unknown) => {
      this.lastError = error;
      this.retryAt = this.retryNow() + 1000;
      throw error;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async reserve(): Promise<Range> {
    const record = { namespace: NAMESPACE, key: `${this.OriginServerId}:${this.WorkerId}` };
    for (let attempt = 0; attempt < 16; attempt++) {
      this.requireOpen();
      if (!this.pendingWrite) {
        const snapshot = await this.store.Load(record);
        this.requireOpen();
        let highWater = 0;
        if (snapshot) {
          if (snapshot.record.namespace !== record.namespace || snapshot.record.key !== record.key
              || snapshot.schema !== SCHEMA || snapshot.schemaVersion !== 1 || snapshot.revision < 1n
              || snapshot.payload.byteLength !== 8) throw new Error("invalid global id high-water record");
          highWater = Number(new DataView(snapshot.payload.buffer, snapshot.payload.byteOffset, 8).getBigUint64(0));
          if (!Number.isSafeInteger(highWater) || highWater < 0 || highWater > GLOBAL_ID_COUNTER_LIMIT) {
            throw new Error("invalid global id high-water value");
          }
        }
        if (highWater < this.observedEnd) throw new Error("global id high-water regressed or cache is stale; refusing allocation");
        const second = Math.floor(this.wallNow() / 1000) - GLOBAL_ID_EPOCH_SECONDS;
        if (!Number.isSafeInteger(second) || second < 0 || second >= 2 ** 30) throw new Error("global id clock outside supported epoch");
        const start = Math.max(highWater, second * GLOBAL_ID_COUNTERS_PER_SECOND);
        const end = start + this.blockSize;
        if (end > GLOBAL_ID_COUNTER_LIMIT) throw new Error("global id counter space exhausted");
        const payload = new Uint8Array(8);
        new DataView(payload.buffer).setBigUint64(0, BigInt(end));
        const revision = snapshot?.revision ?? 0n;
        this.pendingWrite = {
          requestId: `tiangz.id-range/v1/${record.key}/${revision}/${start}/${end}`,
          record, schema: SCHEMA, schemaVersion: 1, payload, expectedRevision: revision,
          updatedAtUnixMs: BigInt((GLOBAL_ID_EPOCH_SECONDS + Math.floor(start / GLOBAL_ID_COUNTERS_PER_SECOND)) * 1000),
        };
      }
      const write = this.pendingWrite;
      const end = Number(new DataView(write.payload.buffer, write.payload.byteOffset, 8).getBigUint64(0));
      try {
        const result = await this.store.Save(write);
        this.requireOpen();
        if (result.revision !== write.expectedRevision! + 1n
            || !["applied", "duplicate"].includes(result.disposition)) throw new Error("invalid global id reservation receipt");
        this.pendingWrite = undefined;
        this.observedEnd = Math.max(this.observedEnd, end);
        if (result.disposition === "applied") return { next: end - this.blockSize, end };
        // 重复回执可能属于另一个竞争者；永不采纳其号段。 / A duplicate may belong to another contender; never adopt its range.
      } catch (error) {
        if (!(error instanceof DbProxyRemoteError) || error.code !== DbProxyErrorCode.RevisionConflict) throw error;
        this.pendingWrite = undefined;
      }
    }
    throw new Error("global id reservation contention budget exhausted");
  }
}
