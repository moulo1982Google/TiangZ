import { packFrame } from "../protocol/registry";
import { monotonicNow } from "../runtime/Game";
import type { IMessage } from "../protocol/message";
import type {
  BroadcastAudience,
  BroadcastDescriptor,
  BroadcastHubOptions,
  BroadcastMetricsSnapshot,
  BroadcastTransport,
  EventBroadcastDescriptor,
  LatestBroadcastDescriptor,
} from "./types";

interface Deferred {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface EventJob<TItem> {
  readonly audience: BroadcastAudience;
  readonly items: readonly TItem[];
  readonly tick: number;
  readonly queuedAt: number;
  readonly deferred: Deferred;
}

interface LatestJob<TItem> {
  audience: BroadcastAudience;
  readonly items: Map<string | number, TItem>;
  tick: number;
  queuedAt: number;
  readonly deferred: Deferred[];
}

interface Channel {
  readonly key: string;
  inFlight: boolean;
  inFlightItems: number;
  readonly eventQueue: EventJob<unknown>[];
  latest?: LatestJob<unknown>;
}

const DEFAULT_MAX_EVENT_QUEUE = 1024;

export class BroadcastHub {
  private readonly channels = new Map<string, Channel>();
  private readonly maxEventQueuePerChannel: number;
  private readonly onError: (descriptorName: string, error: unknown) => void;
  private disposed = false;
  private readonly metrics = {
    queuedItems: 0,
    coalescedItems: 0,
    sentItems: 0,
    broadcastsStarted: 0,
    broadcastsCompleted: 0,
    broadcastFailures: 0,
    maxPendingItems: 0,
    maxInFlightItems: 0,
    lastDurationMs: 0,
    maxDurationMs: 0,
    totalDurationMs: 0,
    lastQueueWaitMs: 0,
    maxQueueWaitMs: 0,
    totalQueueWaitMs: 0,
  };

  constructor(
    private readonly transport: BroadcastTransport,
    options: BroadcastHubOptions = {},
  ) {
    this.maxEventQueuePerChannel =
      options.maxEventQueuePerChannel ?? DEFAULT_MAX_EVENT_QUEUE;
    this.onError = options.onError ?? ((name, error) => {
      console.error(`[BroadcastHub] ${name} failed`, error);
    });
  }

  Publish<TItem, TMessage extends IMessage>(
    audience: BroadcastAudience,
    descriptor: BroadcastDescriptor<TItem, TMessage>,
    item: TItem,
    tick = 0,
  ): Promise<void> {
    return this.PublishMany(audience, descriptor, [item], tick);
  }

  PublishMany<TItem, TMessage extends IMessage>(
    audience: BroadcastAudience,
    descriptor: BroadcastDescriptor<TItem, TMessage>,
    items: readonly TItem[],
    tick = 0,
  ): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("broadcast hub is disposed"));
    }
    if (items.length === 0 || audience.routes.length === 0) {
      return Promise.resolve();
    }

    this.validateAudience(audience);
    if (descriptor.mode === "event" && !descriptor.batchItems && items.length !== 1) {
      throw new Error(
        `${descriptor.name} is a single-event broadcast; call Publish once per event`,
      );
    }
    const channelKey = `${descriptor.name}\0${audience.key}`;
    const channel = this.channels.get(channelKey) ?? this.createChannel(channelKey);
    if (descriptor.mode === "latest") {
      return this.enqueueLatest(channel, audience, descriptor, items, tick);
    }
    return this.enqueueEvent(channel, audience, descriptor, items, tick);
  }

  Snapshot(): BroadcastMetricsSnapshot {
    let inFlight = 0;
    let inFlightItems = 0;
    let pendingItems = 0;
    for (const channel of this.channels.values()) {
      if (channel.inFlight) inFlight += 1;
      inFlightItems += channel.inFlightItems;
      if (channel.latest) pendingItems += channel.latest.items.size;
      for (const job of channel.eventQueue) pendingItems += job.items.length;
    }
    return {
      inFlight,
      inFlightItems,
      pendingItems,
      maxPendingItems: this.metrics.maxPendingItems,
      maxInFlightItems: this.metrics.maxInFlightItems,
      queuedItems: this.metrics.queuedItems,
      coalescedItems: this.metrics.coalescedItems,
      sentItems: this.metrics.sentItems,
      broadcastsStarted: this.metrics.broadcastsStarted,
      broadcastsCompleted: this.metrics.broadcastsCompleted,
      broadcastFailures: this.metrics.broadcastFailures,
      lastDurationMs: this.metrics.lastDurationMs,
      maxDurationMs: this.metrics.maxDurationMs,
      totalDurationMs: this.metrics.totalDurationMs,
      lastQueueWaitMs: this.metrics.lastQueueWaitMs,
      maxQueueWaitMs: this.metrics.maxQueueWaitMs,
      totalQueueWaitMs: this.metrics.totalQueueWaitMs,
    };
  }

  Dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new Error("broadcast hub disposed before delivery");
    for (const channel of this.channels.values()) {
      for (const job of channel.eventQueue) job.deferred.reject(error);
      for (const deferred of channel.latest?.deferred ?? []) deferred.reject(error);
      channel.eventQueue.length = 0;
      channel.latest = undefined;
    }
  }

  private enqueueEvent<TItem, TMessage extends IMessage>(
    channel: Channel,
    audience: BroadcastAudience,
    descriptor: EventBroadcastDescriptor<TItem, TMessage>,
    items: readonly TItem[],
    tick: number,
  ): Promise<void> {
    if (channel.eventQueue.length >= this.maxEventQueuePerChannel) {
      throw new Error(
        `broadcast event queue is full: ${descriptor.name}/${audience.key}`,
      );
    }
    const promise = new Promise<void>((resolve, reject) => {
      channel.eventQueue.push({
        audience,
        items,
        tick,
        queuedAt: monotonicNow(),
        deferred: { resolve, reject },
      } as EventJob<unknown>);
    });
    this.metrics.queuedItems += items.length;
    this.recordPending();
    this.pump(channel, descriptor);
    return promise;
  }

  private enqueueLatest<TItem, TMessage extends IMessage>(
    channel: Channel,
    audience: BroadcastAudience,
    descriptor: LatestBroadcastDescriptor<TItem, TMessage>,
    items: readonly TItem[],
    tick: number,
  ): Promise<void> {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    let job = channel.latest as LatestJob<TItem> | undefined;
    if (!job) {
      job = {
        audience,
        items: new Map(),
        tick,
        queuedAt: monotonicNow(),
        deferred: [],
      };
      channel.latest = job as LatestJob<unknown>;
    } else {
      job.audience = audience;
      job.tick = Math.max(job.tick, tick);
    }
    job.deferred.push({ resolve, reject });
    this.metrics.queuedItems += items.length;
    for (const item of items) {
      const key = descriptor.keyOf(item);
      if (job.items.has(key)) this.metrics.coalescedItems += 1;
      job.items.set(key, item);
    }
    this.recordPending();
    this.pump(channel, descriptor);
    return promise;
  }

  private pump<TItem, TMessage extends IMessage>(
    channel: Channel,
    descriptor: BroadcastDescriptor<TItem, TMessage>,
  ): void {
    if (channel.inFlight || this.disposed) return;

    let audience: BroadcastAudience;
    let items: readonly TItem[];
    let tick: number;
    let queuedAt: number;
    let deferred: readonly Deferred[];
    if (descriptor.mode === "latest") {
      const job = channel.latest as LatestJob<TItem> | undefined;
      if (!job || job.items.size === 0) return;
      channel.latest = undefined;
      audience = job.audience;
      items = [...job.items.values()];
      tick = job.tick;
      queuedAt = job.queuedAt;
      deferred = job.deferred;
    } else {
      const job = channel.eventQueue.shift() as EventJob<TItem> | undefined;
      if (!job) return;
      audience = job.audience;
      items = job.items;
      tick = job.tick;
      queuedAt = job.queuedAt;
      deferred = [job.deferred];
    }

    const startedAt = monotonicNow();
    const queueWaitMs = Math.max(0, startedAt - queuedAt);
    channel.inFlight = true;
    channel.inFlightItems = items.length;
    this.metrics.broadcastsStarted += 1;
    this.metrics.sentItems += items.length;
    this.metrics.maxInFlightItems = Math.max(
      this.metrics.maxInFlightItems,
      items.length,
    );
    this.metrics.lastQueueWaitMs = queueWaitMs;
    this.metrics.maxQueueWaitMs = Math.max(this.metrics.maxQueueWaitMs, queueWaitMs);
    this.metrics.totalQueueWaitMs += queueWaitMs;

    let frame: Uint8Array;
    try {
      const message = descriptor.makeMessage(items, tick);
      frame = packFrame(descriptor.message.msgcode, descriptor.message.codec.encode(message));
    } catch (error) {
      this.complete(channel, descriptor, startedAt, deferred, error);
      return;
    }

    void this.transport.Send(audience, frame)
      .then(() => this.complete(channel, descriptor, startedAt, deferred))
      .catch((error) => this.complete(channel, descriptor, startedAt, deferred, error));
  }

  private complete<TItem, TMessage extends IMessage>(
    channel: Channel,
    descriptor: BroadcastDescriptor<TItem, TMessage>,
    startedAt: number,
    deferred: readonly Deferred[],
    error?: unknown,
  ): void {
    const durationMs = Math.max(0, monotonicNow() - startedAt);
    this.metrics.lastDurationMs = durationMs;
    this.metrics.maxDurationMs = Math.max(this.metrics.maxDurationMs, durationMs);
    this.metrics.totalDurationMs += durationMs;
    channel.inFlight = false;
    channel.inFlightItems = 0;
    if (error === undefined) {
      this.metrics.broadcastsCompleted += 1;
      for (const item of deferred) item.resolve();
    } else {
      this.metrics.broadcastFailures += 1;
      this.onError(descriptor.name, error);
      for (const item of deferred) item.reject(error);
    }
    this.pump(channel, descriptor);
    if (
      !channel.inFlight &&
      !channel.latest &&
      channel.eventQueue.length === 0
    ) {
      this.channels.delete(channel.key);
    }
  }

  private createChannel(key: string): Channel {
    const channel: Channel = {
      key,
      inFlight: false,
      inFlightItems: 0,
      eventQueue: [],
    };
    this.channels.set(key, channel);
    return channel;
  }

  private recordPending(): void {
    let pending = 0;
    for (const channel of this.channels.values()) {
      if (channel.latest) pending += channel.latest.items.size;
      for (const job of channel.eventQueue) pending += job.items.length;
    }
    this.metrics.maxPendingItems = Math.max(this.metrics.maxPendingItems, pending);
  }

  private validateAudience(audience: BroadcastAudience): void {
    if (!audience.key) throw new Error("broadcast audience key is required");
    for (const route of audience.routes) {
      if (
        !route.route ||
        !Number.isInteger(route.recipientId) ||
        route.recipientId <= 0
      ) {
        throw new Error(`invalid broadcast route in audience ${audience.key}`);
      }
    }
  }
}
