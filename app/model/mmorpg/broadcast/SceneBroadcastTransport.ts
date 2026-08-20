import type {
  BroadcastAudience,
  BroadcastDelivery,
  BroadcastTransport,
  EncodedAudienceBatch,
  EncodedRouteFrame,
  SceneMessageHelper,
} from "../../../core/public";
import { GateMessages } from "../../../generated/model/server/demo/protocol/messageDescriptors";

interface PendingBroadcastBatch {
  readonly batches: readonly EncodedAudienceBatch[];
  readonly delivery: BroadcastDelivery;
  resolve(): void;
  reject(error: unknown): void;
}

interface PendingRouteFrameJob {
  readonly frames: readonly EncodedRouteFrame[];
  resolve(): void;
  reject(error: unknown): void;
}

interface RouteFrameGroup {
  readonly route: string;
  readonly messageCode: number;
  readonly frames: Uint8Array[];
}

const RELIABLE_DELIVERY = 1;
const LATEST_DELIVERY = 2;

export class SceneBroadcastTransport implements BroadcastTransport {
  private readonly pendingBatches: PendingBroadcastBatch[] = [];
  private batchFlushScheduled = false;
  private readonly pendingRouteFrameJobs: PendingRouteFrameJob[] = [];
  private routeFrameFlushScheduled = false;

  constructor(private readonly scenes: SceneMessageHelper) {}

  /** 发送单组客户端帧；低频即时事件继续使用紧凑的单帧内网协议。 / Sends one client frame group through the compact single-frame inner protocol. */
  async Send(
    audience: BroadcastAudience,
    frame: Uint8Array,
    delivery: BroadcastDelivery = "reliable",
  ): Promise<void> {
    const recipientsByGate = groupRecipientsByGate(audience);

    await Promise.all(
      [...recipientsByGate].map(([gateName, targetUnitIds]) =>
        this.scenes.send(
          this.scenes.byName(gateName),
          GateMessages.ClientBroadcast,
          {
            targetUnitIds: [...targetUnitIds],
            frame,
            deliveryClass: encodeDelivery(delivery),
          },
        ),
      ),
    );
  }

  /**
   * 把同一同步调度边界内的已编码帧按Gate重组，每个Gate只接收一条内网批量消息。
   * frame保持不可变且不重新编码；这里只消除Map到Gate之间的细碎消息，不合并客户端协议帧。
   *
   * Regroups encoded frames from one synchronous scheduling boundary by Gate so
   * each Gate receives one inner batch message. Frames stay immutable and are
   * not re-encoded; this removes fragmented Map-to-Gate messages without
   * merging client protocol frames.
   */
  SendMany(
    batches: readonly EncodedAudienceBatch[],
    delivery: BroadcastDelivery = "reliable",
  ): Promise<void> {
    const completion = new Promise<void>((resolve, reject) => {
      this.pendingBatches.push({ batches, delivery, resolve, reject });
    });
    if (!this.batchFlushScheduled) {
      this.batchFlushScheduled = true;
      queueMicrotask(() => this.FlushPendingBatches());
    }
    return completion;
  }

  /**
   * Rust已经生成完整Gate批帧；同一同步调度边界内按Gate合并外层protobuf批帧，不触碰客户端payload。
   * Rust already emitted complete Gate batch frames; frames for one Gate in the same synchronous
   * boundary are merged by concatenating repeated protobuf fields without touching client payloads.
   */
  SendRouteFrames(
    frames: readonly EncodedRouteFrame[],
    delivery: BroadcastDelivery = "latest",
  ): Promise<void> {
    if (delivery !== "latest") {
      throw new Error("encoded route frames are reserved for latest-state delivery");
    }
    const completion = new Promise<void>((resolve, reject) => {
      this.pendingRouteFrameJobs.push({ frames, resolve, reject });
    });
    if (!this.routeFrameFlushScheduled) {
      this.routeFrameFlushScheduled = true;
      queueMicrotask(() => this.FlushPendingRouteFrameJobs());
    }
    return completion;
  }

  /** 合并同Gate的S2G_ClientBroadcastBatch外壳；客户端协议帧仍保持每个batch独立。 / Merges S2G_ClientBroadcastBatch envelopes per Gate while keeping each client frame as its own batch. */
  private FlushPendingRouteFrameJobs(): void {
    this.routeFrameFlushScheduled = false;
    const pending = this.pendingRouteFrameJobs.splice(0, this.pendingRouteFrameJobs.length);
    if (pending.length === 0) return;

    const groups = new Map<string, RouteFrameGroup>();
    const groupsByJob = pending.map(() => new Set<string>());
    for (let jobIndex = 0; jobIndex < pending.length; jobIndex += 1) {
      const job = pending[jobIndex];
      try {
        for (const item of job.frames) {
          if (item.frame.length < 2) throw new Error("encoded route frame is too short");
          const messageCode = (item.frame[0] << 8) | item.frame[1];
          if (messageCode !== GateMessages.ClientBroadcastBatch.msgcode) {
            throw new Error("encoded route frame must be a Gate.ClientBroadcastBatch frame");
          }
          const key = `${item.route}\0${messageCode}`;
          const group = groups.get(key) ?? {
            route: item.route,
            messageCode,
            frames: [],
          };
          group.frames.push(item.frame);
          groups.set(key, group);
          groupsByJob[jobIndex].add(key);
        }
      } catch (error) {
        job.reject(error);
      }
    }

    const sendsByGroup = new Map<string, Promise<void>>();
    for (const [key, group] of groups) {
      const merged = mergeClientBroadcastBatchFrames(group.messageCode, group.frames);
      try {
        sendsByGroup.set(
          key,
          Promise.resolve(this.scenes.sendFrame(this.scenes.byName(group.route), merged)),
        );
      } catch (error) {
        sendsByGroup.set(key, Promise.reject(error));
      }
    }

    for (let jobIndex = 0; jobIndex < pending.length; jobIndex += 1) {
      const sends = [...groupsByJob[jobIndex]]
        .map((key) => sendsByGroup.get(key))
        .filter((send): send is Promise<void> => send !== undefined);
      if (sends.length === 0 && groupsByJob[jobIndex].size > 0) continue;
      if (groupsByJob[jobIndex].size === 0) {
        pending[jobIndex].resolve();
        continue;
      }
      void Promise.all(sends).then(
        () => pending[jobIndex].resolve(),
        (error) => pending[jobIndex].reject(error),
      );
    }
  }

  /**
   * 在当前同步Game Tick结束时合并全部批量作业；每个逻辑作业只等待自己涉及的Gate。
   * 一个Gate失败不会误伤完全不经过该Gate的作业，dirty Ack仍由原BroadcastHub决定。
   *
   * Coalesces every batched job at the end of the current synchronous game
   * tick. Each logical job waits only for Gates it touches, so a failed Gate
   * cannot reject unrelated jobs and dirty acknowledgements remain unchanged.
   */
  private FlushPendingBatches(): void {
    this.batchFlushScheduled = false;
    const pending = this.pendingBatches.splice(0, this.pendingBatches.length);
    if (pending.length === 0) return;

    const deliveriesByGate = new Map<string, {
      gateName: string;
      delivery: BroadcastDelivery;
      batches: Array<{
      targetUnitIds: number[];
      frame: Uint8Array;
      }>;
    }>();
    const gatesByJob = pending.map(() => new Set<string>());
    for (let jobIndex = 0; jobIndex < pending.length; jobIndex += 1) {
      for (const batch of pending[jobIndex].batches) {
        for (const [gateName, recipients] of groupRecipientsByGate(batch.audience)) {
          if (recipients.size === 0) continue;
          const key = `${pending[jobIndex].delivery}\0${gateName}`;
          const deliveries = deliveriesByGate.get(key) ?? {
            gateName,
            delivery: pending[jobIndex].delivery,
            batches: [],
          };
          deliveries.batches.push({ targetUnitIds: [...recipients], frame: batch.frame });
          deliveriesByGate.set(key, deliveries);
          gatesByJob[jobIndex].add(key);
        }
      }
    }

    const sendsByGate = new Map<string, Promise<void> | void>();
    for (const [key, group] of deliveriesByGate) {
      try {
        sendsByGate.set(key, this.scenes.send(
          this.scenes.byName(group.gateName),
          GateMessages.ClientBroadcastBatch,
          {
            batches: group.batches,
            deliveryClass: encodeDelivery(group.delivery),
          },
        ));
      } catch (error) {
        sendsByGate.set(key, Promise.reject(error));
      }
    }

    for (let jobIndex = 0; jobIndex < pending.length; jobIndex += 1) {
      const sends = [...gatesByJob[jobIndex]].map((gateName) => sendsByGate.get(gateName)!);
      void Promise.all(sends).then(
        () => pending[jobIndex].resolve(),
        (error) => pending[jobIndex].reject(error),
      );
    }
  }
}

function encodeDelivery(delivery: BroadcastDelivery): number {
  return delivery === "latest" ? LATEST_DELIVERY : RELIABLE_DELIVERY;
}

/** 按Gate去重一组逻辑受众，不修改原Audience。 / Deduplicates one logical audience by Gate without mutating it. */
function groupRecipientsByGate(audience: BroadcastAudience): Map<string, Set<number>> {
  const recipientsByGate = new Map<string, Set<number>>();
  for (const route of audience.routes) {
    const recipients = recipientsByGate.get(route.route) ?? new Set<number>();
    recipients.add(route.recipientId);
    recipientsByGate.set(route.route, recipients);
  }
  return recipientsByGate;
}

function mergeClientBroadcastBatchFrames(
  messageCode: number,
  frames: readonly Uint8Array[],
): Uint8Array {
  const payloadLength = frames.reduce((total, frame) => total + frame.length - 2, 0);
  const merged = new Uint8Array(payloadLength + 2);
  merged[0] = (messageCode >>> 8) & 0xff;
  merged[1] = messageCode & 0xff;
  let offset = 2;
  for (const frame of frames) {
    merged.set(frame.subarray(2), offset);
    offset += frame.length - 2;
  }
  return merged;
}
