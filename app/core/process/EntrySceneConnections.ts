import { nowMs } from "../metrics/latency";
import type { CustomMetricSnapshot } from "./types";

export interface AsyncIngressSource {
  pending: number;
  disconnected: boolean;
}

/** EntryScene 的连接记账；不拥有 Socket 或业务任务的取消。 / Connection bookkeeping owned by one EntryScene, without owning sockets or business cancellation. */
export class EntrySceneConnections {
  private static readonly DISCONNECTED_FRAME_TOMBSTONE_MS = 30_000;
  private static readonly MAX_DISCONNECTED_FRAME_TOMBSTONES = 65_536;
  private readonly connectionIdBytes = new Map<number, Uint8Array>();
  private readonly asyncIngressSources = new Map<number, AsyncIngressSource>();
  droppedResponsesAfterDisconnect = 0;
  private readonly disconnectedFrameTombstones = new Map<number, number>();
  droppedFramesAfterDisconnect = 0;

  /** 清理 Scene 索引，实际等待仍由原 Promise 持有。 / Clears Scene indexes while original Promises retain actual waits. */
  clear(): void {
    this.connectionIdBytes.clear();
    this.asyncIngressSources.clear();
    this.disconnectedFrameTombstones.clear();
  }

  /** 仅在原 Disconnect 消费位置移除编码缓存。 / Removes cached ID bytes only at the original disconnect-consumption point. */
  forgetConnectionId(connectionId: number): void {
    this.connectionIdBytes.delete(connectionId);
  }

  /** 记录来源失效，业务断线回调仍由 EntryScene 调度。 / Records invalidation while EntryScene still schedules business disconnect callbacks. */
  markDisconnected(connectionId: number): void {
    // 原等待保留失效状态，不依赖短期墓碑；同号新连接会取得另一份状态。
    // Existing waits retain invalidation beyond tombstone expiry; a reused ID gets separate state.
    const source = this.asyncIngressSources.get(connectionId);
    if (source) source.disconnected = true;
    this.asyncIngressSources.delete(connectionId);
    this.markDisconnectedFrame(connectionId);
  }

  /** 最后完成只释放原状态，不能删除同号新来源。 / Last completion releases only its original state, preserving reused IDs. */
  releaseAsyncIngressSource(connectionId: number, source: AsyncIngressSource): void {
    source.pending -= 1;
    if (source.pending === 0 && this.asyncIngressSources.get(connectionId) === source) {
      this.asyncIngressSources.delete(connectionId);
    }
  }

  /** 返回同一连接指标信封，字段与类型保持。 / Returns the same connection metric envelope with unchanged fields and kinds. */
  metricsSnapshot(): CustomMetricSnapshot {
    return {
      name: "connection_ingress",
      values: {
        dropped_frames_after_disconnect_total: this.droppedFramesAfterDisconnect,
        dropped_responses_after_disconnect_total: this.droppedResponsesAfterDisconnect,
        connected_async_sources: this.asyncIngressSources.size,
        connection_id_cache_entries: this.connectionIdBytes.size,
        disconnect_tombstones: this.disconnectedFrameTombstones.size,
      },
      kinds: {
        dropped_frames_after_disconnect_total: "counter",
        dropped_responses_after_disconnect_total: "counter",
        connected_async_sources: "gauge",
        connection_id_cache_entries: "gauge",
        disconnect_tombstones: "gauge",
      },
    };
  }
  /** 控制队列可能先于旧数据帧交付Disconnect；短期墓碑用于拒绝这些不再可响应的残留帧。 / A control-lane disconnect may overtake old data frames; a short-lived tombstone drops frames that can no longer receive responses. */
  private markDisconnectedFrame(connectionId: number): void {
    const now = nowMs();
    this.pruneDisconnectedFrames(now);
    this.disconnectedFrameTombstones.delete(connectionId);
    this.disconnectedFrameTombstones.set(
      connectionId,
      now + EntrySceneConnections.DISCONNECTED_FRAME_TOMBSTONE_MS,
    );
    while (
      this.disconnectedFrameTombstones.size > EntrySceneConnections.MAX_DISCONNECTED_FRAME_TOMBSTONES
    ) {
      const oldest = this.disconnectedFrameTombstones.keys().next().value;
      if (oldest === undefined) break;
      this.disconnectedFrameTombstones.delete(oldest);
    }
  }

  isDisconnectedFrame(connectionId: number): boolean {
    const expiresAt = this.disconnectedFrameTombstones.get(connectionId);
    if (expiresAt === undefined) return false;
    if (expiresAt > nowMs()) return true;
    this.disconnectedFrameTombstones.delete(connectionId);
    return false;
  }

  private pruneDisconnectedFrames(now: number): void {
    for (const [connectionId, expiresAt] of this.disconnectedFrameTombstones) {
      if (expiresAt > now) break;
      this.disconnectedFrameTombstones.delete(connectionId);
    }
  }

  /** 只为实际异步入站等待保留来源，最后结束释放索引；断线不提前结束业务。 / Retains a source only for actual async ingress waits; disconnect invalidates replies without settling business work. */
  retainAsyncIngressSource(connectionId: number): AsyncIngressSource {
    const current = this.asyncIngressSources.get(connectionId);
    if (current) { current.pending += 1; return current; }
    const source = { pending: 1, disconnected: this.isDisconnectedFrame(connectionId) };
    if (!source.disconnected) this.asyncIngressSources.set(connectionId, source);
    return source;
  }

  packConnectionId(connectionId: number): Uint8Array {
    let bytes = this.connectionIdBytes.get(connectionId);
    if (!bytes) {
      bytes = packConnectionIds([connectionId]);
      this.connectionIdBytes.set(connectionId, bytes);
    }
    return bytes;
  }
}

/** 校验并按小端编码连接 ID 数组。 / Validates and encodes connection IDs in little-endian order. */
export function packConnectionIds(connectionIds: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(connectionIds.length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < connectionIds.length; index += 1) {
    const connectionId = connectionIds[index];
    if (
      !Number.isInteger(connectionId) ||
      connectionId < 0 ||
      connectionId > 0xffff_ffff
    ) {
      throw new Error(`invalid connection id: ${connectionId}`);
    }
    view.setUint32(index * 4, connectionId, true);
  }
  return bytes;
}
