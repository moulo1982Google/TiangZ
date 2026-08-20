import type { BroadcastHub } from "../broadcast/BroadcastHub";
import type {
  BroadcastAudience,
  EncodedAudienceBatch,
  EncodedRouteFrame,
} from "../broadcast/types";
import { CoreLogger } from "../logging/Logger";

interface EncodedStateDeltaBase {
  readonly itemCount: number;
  Ack(): void;
}

export interface EncodedSingleStateDelta extends EncodedStateDeltaBase {
  readonly frame: Uint8Array;
  readonly batches?: never;
  readonly routeFrames?: never;
  readonly audienceKey?: never;
}

export interface EncodedBatchedStateDelta extends EncodedStateDeltaBase {
  readonly frame?: never;
  readonly batches: readonly EncodedAudienceBatch[];
  readonly routeFrames?: never;
  readonly audienceKey: string;
}

export interface EncodedRoutedStateDelta extends EncodedStateDeltaBase {
  readonly frame?: never;
  readonly batches?: never;
  readonly routeFrames: readonly EncodedRouteFrame[];
  readonly audienceKey: string;
}

export type EncodedStateDelta =
  | EncodedSingleStateDelta
  | EncodedBatchedStateDelta
  | EncodedRoutedStateDelta;

export interface StateReplicationSource {
  readonly name: string;
  Peek(): EncodedStateDelta;
}

export class StateReplicationSystem {
  private readonly sources = new Map<string, StateReplicationSource>();
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly broadcast: BroadcastHub,
    private readonly audience: () => BroadcastAudience,
    private readonly onError: (sourceName: string, error: unknown) => void = (
      sourceName,
      error,
    ) => CoreLogger.error("state replication failed", { sourceName, error }),
    private readonly beforePublish?: () => Promise<void> | undefined,
  ) {}

  /** 注册一个具名脏状态源；名称同时用于隔离 latest 广播频道。 / Registers one named dirty-state source; names also isolate latest broadcast channels. */
  Add(source: StateReplicationSource): void {
    if (!source.name) throw new Error("state replication source name is required");
    if (this.sources.has(source.name)) {
      throw new Error(`state replication source is already registered: ${source.name}`);
    }
    this.sources.set(source.name, source);
  }

  /** 停止后续轮询该状态源，但不取消已经在途的发送。 / Stops future polls of a source but does not cancel an already in-flight send. */
  Remove(name: string): boolean {
    return this.sources.delete(name);
  }

  /**
   * 帧尾查看每个状态源，并且只在投递成功后确认版本。
   * 每个源最多存在一个在途版本，避免旧完成事件清除较新的脏状态。
   * 本方法只调度异步任务，不阻塞 Game.Update。
   *
   * Peeks each source at frame end and acknowledges only after delivery succeeds.
   * A source has at most one in-flight revision, preventing an old completion
   * from clearing newer dirty state. This method schedules async work and does
   * not block Game.Update.
   */
  FrameFlush(): void {
    for (const source of this.sources.values()) {
      if (this.inFlight.has(source.name)) continue;
      let delta: EncodedStateDelta;
      try {
        delta = source.Peek();
      } catch (error) {
        this.onError(source.name, error);
        continue;
      }
      if (delta.itemCount === 0) continue;

      this.inFlight.add(source.name);
      try {
        const publish = () => {
          if (delta.routeFrames !== undefined) {
            return this.broadcast.PublishEncodedLatestRouteFrames(
              delta.audienceKey,
              source.name,
              delta.routeFrames,
            );
          }
          if (delta.batches !== undefined) {
            return this.broadcast.PublishEncodedLatestBatches(
              delta.audienceKey,
              source.name,
              delta.batches,
            );
          }
          return this.broadcast.PublishEncodedLatestSnapshot(
            this.audience(),
            source.name,
            delta.frame,
            delta.itemCount,
          );
        };
        const barrier = this.beforePublish?.();
        const delivery = barrier ? barrier.then(publish) : publish();
        void delivery
          .then(() => {
            try {
              delta.Ack();
            } catch (error) {
              this.onError(source.name, error);
            }
          }, (error) => this.onError(source.name, error))
          .finally(() => this.inFlight.delete(source.name));
      } catch (error) {
        this.inFlight.delete(source.name);
        this.onError(source.name, error);
      }
    }
  }
}
