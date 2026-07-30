import type {
  BroadcastAudience,
  BroadcastTransport,
  EncodedAudienceBatch,
  SceneMessageHelper,
} from "../../../core/public";
import { GateMessages } from "../../../generated/model/server/demo/protocol/messageDescriptors";

interface PendingBroadcastBatch {
  readonly batches: readonly EncodedAudienceBatch[];
  resolve(): void;
  reject(error: unknown): void;
}

export class SceneBroadcastTransport implements BroadcastTransport {
  private readonly pendingBatches: PendingBroadcastBatch[] = [];
  private batchFlushScheduled = false;

  constructor(private readonly scenes: SceneMessageHelper) {}

  /** 发送单组客户端帧；低频即时事件继续使用紧凑的单帧内网协议。 / Sends one client frame group through the compact single-frame inner protocol. */
  async Send(audience: BroadcastAudience, frame: Uint8Array): Promise<void> {
    const recipientsByGate = groupRecipientsByGate(audience);

    await Promise.all(
      [...recipientsByGate].map(([gateName, targetUnitIds]) =>
        this.scenes.send(
          this.scenes.byName(gateName),
          GateMessages.ClientBroadcast,
          { targetUnitIds: [...targetUnitIds], frame },
        ),
      ),
    );
  }

  /**
   * 把同一逻辑作业的AOI帧按Gate重组，每个Gate只接收一条内网批量消息。
   * frame保持不可变且不重新编码；这里只消除Map到Gate之间的细碎消息，不合并客户端协议帧。
   *
   * Regroups AOI frames from one logical job by Gate so each Gate receives one
   * inner batch message. Frames stay immutable and are not re-encoded; this
   * removes fragmented Map-to-Gate messages without merging client frames.
   */
  SendMany(batches: readonly EncodedAudienceBatch[]): Promise<void> {
    const delivery = new Promise<void>((resolve, reject) => {
      this.pendingBatches.push({ batches, resolve, reject });
    });
    if (!this.batchFlushScheduled) {
      this.batchFlushScheduled = true;
      queueMicrotask(() => this.FlushPendingBatches());
    }
    return delivery;
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

    const deliveriesByGate = new Map<string, Array<{
      targetUnitIds: number[];
      frame: Uint8Array;
    }>>();
    const gatesByJob = pending.map(() => new Set<string>());
    for (let jobIndex = 0; jobIndex < pending.length; jobIndex += 1) {
      for (const batch of pending[jobIndex].batches) {
        for (const [gateName, recipients] of groupRecipientsByGate(batch.audience)) {
          if (recipients.size === 0) continue;
          const deliveries = deliveriesByGate.get(gateName) ?? [];
          deliveries.push({ targetUnitIds: [...recipients], frame: batch.frame });
          deliveriesByGate.set(gateName, deliveries);
          gatesByJob[jobIndex].add(gateName);
        }
      }
    }

    const sendsByGate = new Map<string, Promise<void>>();
    for (const [gateName, batches] of deliveriesByGate) {
      try {
        sendsByGate.set(gateName, this.scenes.send(
          this.scenes.byName(gateName),
          GateMessages.ClientBroadcastBatch,
          { batches },
        ));
      } catch (error) {
        sendsByGate.set(gateName, Promise.reject(error));
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
