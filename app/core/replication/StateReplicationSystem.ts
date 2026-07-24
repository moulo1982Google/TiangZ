import type { BroadcastHub } from "../broadcast/BroadcastHub";
import type { BroadcastAudience } from "../broadcast/types";
import { CoreLogger } from "../logging/Logger";

export interface EncodedStateDelta {
  readonly itemCount: number;
  readonly frame: Uint8Array;
  Ack(): void;
}

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
  ) {}

  /** Registers one named dirty-state source; names also isolate latest broadcast channels. */
  Add(source: StateReplicationSource): void {
    if (!source.name) throw new Error("state replication source name is required");
    if (this.sources.has(source.name)) {
      throw new Error(`state replication source is already registered: ${source.name}`);
    }
    this.sources.set(source.name, source);
  }

  /** Stops future polls of a source but does not cancel an already in-flight send. */
  Remove(name: string): boolean {
    return this.sources.delete(name);
  }

  /**
   * Peeks each source at frame end and acknowledges only after delivery succeeds.
   * A source has at most one in-flight revision, preventing an old completion
   * from clearing newer dirty state. This method schedules async work and does
   * not block Game.Update.
   */
  FrameFlush(): void {
    const audience = this.audience();
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
        void this.broadcast.PublishEncodedLatestSnapshot(
          audience,
          source.name,
          delta.frame,
          delta.itemCount,
        )
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
