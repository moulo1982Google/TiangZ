import type { IMessage, MessageDescriptor } from "../protocol/message";

export type BroadcastKey = string | number;

export interface BroadcastRoute {
  readonly route: string;
  readonly recipientId: number;
}

export interface BroadcastAudience {
  readonly key: string;
  readonly routes: readonly BroadcastRoute[];
}

export interface EncodedAudienceBatch {
  readonly audience: BroadcastAudience;
  readonly frame: Uint8Array;
  readonly itemCount: number;
}

interface BroadcastDescriptorBase<TItem, TMessage extends IMessage> {
  readonly name: string;
  readonly message: MessageDescriptor<TMessage>;
  readonly batchItems: boolean;
  readonly makeMessage: (
    items: readonly TItem[],
    tick: number,
  ) => TMessage;
}

export interface EventBroadcastDescriptor<
  TItem,
  TMessage extends IMessage,
> extends BroadcastDescriptorBase<TItem, TMessage> {
  readonly mode: "event";
}

export interface LatestBroadcastDescriptor<
  TItem,
  TMessage extends IMessage,
> extends BroadcastDescriptorBase<TItem, TMessage> {
  readonly mode: "latest";
  readonly keyOf: (item: TItem) => BroadcastKey;
}

export type BroadcastDescriptor<TItem, TMessage extends IMessage> =
  | EventBroadcastDescriptor<TItem, TMessage>
  | LatestBroadcastDescriptor<TItem, TMessage>;

export interface BroadcastTransport {
  Send(audience: BroadcastAudience, frame: Uint8Array): Promise<void>;
}

export interface BroadcastMetricsSnapshot {
  readonly inFlight: number;
  readonly inFlightItems: number;
  readonly pendingItems: number;
  readonly maxPendingItems: number;
  readonly maxInFlightItems: number;
  readonly queuedItems: number;
  readonly coalescedItems: number;
  readonly sentItems: number;
  readonly broadcastsStarted: number;
  readonly broadcastsCompleted: number;
  readonly broadcastFailures: number;
  readonly lastDurationMs: number;
  readonly maxDurationMs: number;
  readonly totalDurationMs: number;
  readonly lastQueueWaitMs: number;
  readonly maxQueueWaitMs: number;
  readonly totalQueueWaitMs: number;
  readonly lastDispatchMs: number;
  readonly maxDispatchMs: number;
  readonly totalDispatchMs: number;
}

export interface BroadcastHubOptions {
  readonly maxEventQueuePerChannel?: number;
  readonly onError?: (descriptorName: string, error: unknown) => void;
}

export function defineEventBroadcast<TItem, TMessage extends IMessage>(
  descriptor: Omit<EventBroadcastDescriptor<TItem, TMessage>, "mode">,
): EventBroadcastDescriptor<TItem, TMessage> {
  return { ...descriptor, mode: "event" };
}

export function defineLatestBroadcast<TItem, TMessage extends IMessage>(
  descriptor: Omit<LatestBroadcastDescriptor<TItem, TMessage>, "mode">,
): LatestBroadcastDescriptor<TItem, TMessage> {
  return { ...descriptor, mode: "latest" };
}
