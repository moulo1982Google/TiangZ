import { packFrame } from "../protocol/registry";
import { monotonicNow } from "../runtime/Game";
import type { IMessage } from "../protocol/message";
import type {
  BroadcastAudience,
  BroadcastDescriptor,
  EncodedAudienceBatch,
  BroadcastHubOptions,
  BroadcastMetricsSnapshot,
  BroadcastTransport,
  EncodedRouteFrame,
  EventBroadcastDescriptor,
  LatestBroadcastDescriptor,
} from "./types";
import { CoreLogger } from "../logging/Logger";

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

interface EncodedSnapshotJob {
  batches?: readonly EncodedAudienceBatch[];
  singleBatch?: EncodedAudienceBatch;
  routeFrames?: readonly EncodedRouteFrame[];
  itemCount: number;
  queuedAt: number;
  readonly deferred: Deferred[];
}

interface Channel {
  readonly key: string;
  inFlight: boolean;
  inFlightItems: number;
  readonly eventQueue: EventJob<unknown>[];
  latest?: LatestJob<unknown>;
  encodedLatest?: EncodedSnapshotJob;
}

const DEFAULT_MAX_EVENT_QUEUE = 1024;

export class BroadcastHub {
  private readonly channels = new Map<string, Channel>();
  private readonly maxEventQueuePerChannel: number;
  private readonly onError: (descriptorName: string, error: unknown) => void;
  private disposed = false;
  // 维护待发送项计数，避免每次入队都扫描全部频道。 / Keep a running pending-item count instead of scanning every channel on each enqueue.
  private pendingItemCount = 0;
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
    lastDispatchMs: 0,
    maxDispatchMs: 0,
    totalDispatchMs: 0,
  };

  constructor(
    private readonly transport: BroadcastTransport,
    options: BroadcastHubOptions = {},
  ) {
    this.maxEventQueuePerChannel =
      options.maxEventQueuePerChannel ?? DEFAULT_MAX_EVENT_QUEUE;
    this.onError = options.onError ?? ((name, error) => {
      CoreLogger.error("broadcast channel failed", { channel: name, error });
    });
  }

  /** 按生成描述符指定的投递模式发布一条事件或状态。 / Publishes one event/state item according to the generated descriptor's delivery mode. */
  Publish<TItem, TMessage extends IMessage>(
    audience: BroadcastAudience,
    descriptor: BroadcastDescriptor<TItem, TMessage>,
    item: TItem,
    tick = 0,
  ): Promise<void> {
    return this.PublishMany(audience, descriptor, [item], tick);
  }

  /**
   * 向一个逻辑受众频道发布一批数据。
   * `event` 保留每一项并可能触发背压；`latest` 可以覆盖同 key 的未发送项。
   * 不可对不可逆事件使用 `latest`。
   *
   * Publishes a batch to one logical audience channel.
   * `event` preserves every item and may backpressure; `latest` may replace
   * unsent items with the same key. Do not use latest for irreversible events.
   */
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

  /**
   * 将 Rust 已编码的可覆盖快照直接入队，不在 TS 中解码。
   * 帧必须视为不可变；同频道较旧的未发送快照可能被覆盖，因此只能用于状态同步。
   *
   * Queues a Rust-encoded replaceable snapshot without decoding it in TS.
   * The frame is treated as immutable and an older unsent snapshot on the same
   * channel may be superseded; callers must only use this for state.
   */
  PublishEncodedLatestSnapshot(
    audience: BroadcastAudience,
    descriptorName: string,
    frame: Uint8Array,
    itemCount: number,
  ): Promise<void> {
    return this.enqueueEncodedLatest(
      audience.key,
      descriptorName,
      undefined,
      { audience, frame, itemCount },
    );
  }

  /**
   * 将同一逻辑帧的多组 AOI 受众作为一个 latest 作业入队。
   * 频道 key 由地图和描述符保持稳定，受众分组变化不会泄漏频道。
   *
   * Queues multiple AOI audience groups as one latest job. The map/descriptor
   * channel key remains stable even when recipient groups change.
   */
  PublishEncodedLatestBatches(
    audienceKey: string,
    descriptorName: string,
    batches: readonly EncodedAudienceBatch[],
  ): Promise<void> {
    return this.enqueueEncodedLatest(audienceKey, descriptorName, batches);
  }

  private enqueueEncodedLatest(
    audienceKey: string,
    descriptorName: string,
    batches?: readonly EncodedAudienceBatch[],
    singleBatch?: EncodedAudienceBatch,
  ): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("broadcast hub is disposed"));
    }
    if (!audienceKey) throw new Error("encoded broadcast audience key is required");
    if (!descriptorName) throw new Error("encoded broadcast name is required");

    let activeBatches: readonly EncodedAudienceBatch[] | undefined = batches;
    const activeSingleBatch = singleBatch;
    let itemCount = 0;
    if (singleBatch) {
      if (singleBatch.itemCount <= 0 || singleBatch.audience.routes.length === 0) {
        return Promise.resolve();
      }
      this.validateEncodedBatch(singleBatch);
      itemCount = singleBatch.itemCount;
    } else {
      const source = batches ?? [];
      let hasInactive = false;
      for (const batch of source) {
        if (batch.itemCount <= 0 || batch.audience.routes.length === 0) {
          hasInactive = true;
          continue;
        }
        this.validateEncodedBatch(batch);
        itemCount += batch.itemCount;
      }
      if (itemCount === 0) return Promise.resolve();
      if (hasInactive) {
        const filtered: EncodedAudienceBatch[] = [];
        for (const batch of source) {
          if (batch.itemCount > 0 && batch.audience.routes.length > 0) {
            filtered.push(batch);
          }
        }
        activeBatches = filtered;
      }
    }

    if (activeSingleBatch) {
      //单批次路径不创建包装数组；singleBatch is kept separate to avoid a wrapper array on the hot path.
      activeBatches = undefined;
    }
    const channelKey = `${descriptorName}\0${audienceKey}`;
    const channel = this.channels.get(channelKey) ?? this.createChannel(channelKey);
    if (channel.latest || channel.eventQueue.length > 0) {
      throw new Error(`encoded and object broadcasts share channel ${channelKey}`);
    }

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    const existing = channel.encodedLatest;
    if (existing) {
      if (
        existing.routeFrames ||
        (activeSingleBatch !== undefined
          ? existing.batches !== undefined
          : existing.singleBatch !== undefined)
      ) {
        throw new Error(`encoded audience and route frames share channel ${channelKey}`);
      }
      this.metrics.coalescedItems += existing.itemCount;
      this.pendingItemCount += itemCount - existing.itemCount;
      existing.batches = activeBatches;
      existing.singleBatch = activeSingleBatch;
      existing.itemCount = itemCount;
      existing.deferred.push({ resolve, reject });
    } else {
      channel.encodedLatest = {
        batches: activeBatches,
        singleBatch: activeSingleBatch,
        itemCount,
        queuedAt: monotonicNow(),
        deferred: [{ resolve, reject }],
      };
      this.pendingItemCount += itemCount;
    }
    this.metrics.queuedItems += itemCount;
    this.recordPending();
    this.pumpEncodedSnapshot(channel, descriptorName);
    return promise;
  }

  private validateEncodedBatch(batch: EncodedAudienceBatch): void {
    if (batch.frame.length < 2) throw new Error("encoded broadcast frame is too short");
    if (!Number.isSafeInteger(batch.itemCount) || batch.itemCount < 0) {
      throw new Error(`invalid encoded broadcast item count: ${batch.itemCount}`);
    }
    this.validateAudience(batch.audience);
  }

  /**
   * 将上游已经按物理路由编码完成的可覆盖帧入队。Transport 只做原样发送，
   * 不再接触接收者列表或 protobuf payload。
   *
   * Queues replaceable frames already encoded for physical routes. The transport
   * sends them verbatim and never rebuilds recipient lists or protobuf payloads.
   */
  PublishEncodedLatestRouteFrames(
    audienceKey: string,
    descriptorName: string,
    routeFrames: readonly EncodedRouteFrame[],
    itemCount: number,
  ): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("broadcast hub is disposed"));
    if (!audienceKey) throw new Error("encoded broadcast audience key is required");
    if (!descriptorName) throw new Error("encoded broadcast name is required");
    if (!Number.isSafeInteger(itemCount) || itemCount < 0) {
      throw new Error(`invalid encoded broadcast item count: ${itemCount}`);
    }
    if (itemCount === 0 || routeFrames.length === 0) return Promise.resolve();
    for (const item of routeFrames) {
      if (!item.route) throw new Error("encoded route frame has no route");
      if (item.frame.length < 2) throw new Error("encoded route frame is too short");
    }
    const activeFrames = routeFrames;
    const channelKey = `${descriptorName}\0${audienceKey}`;
    const channel = this.channels.get(channelKey) ?? this.createChannel(channelKey);
    if (channel.latest || channel.eventQueue.length > 0) {
      throw new Error(`encoded and object broadcasts share channel ${channelKey}`);
    }

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    const existing = channel.encodedLatest;
    if (existing) {
      if (existing.batches || existing.singleBatch !== undefined) {
        throw new Error(`encoded audience and route frames share channel ${channelKey}`);
      }
      this.metrics.coalescedItems += existing.itemCount;
      this.pendingItemCount += itemCount - existing.itemCount;
      existing.routeFrames = activeFrames;
      existing.itemCount = itemCount;
      existing.deferred.push({ resolve, reject });
    } else {
      channel.encodedLatest = {
        routeFrames: activeFrames,
        itemCount,
        queuedAt: monotonicNow(),
        deferred: [{ resolve, reject }],
      };
      this.pendingItemCount += itemCount;
    }
    this.metrics.queuedItems += itemCount;
    this.recordPending();
    this.pumpEncodedSnapshot(channel, descriptorName);
    return promise;
  }

  /** 返回当前队列和在途指标，不修改频道状态。 / Returns current queue/in-flight metrics without mutating channel state. */
  Snapshot(): BroadcastMetricsSnapshot {
    let inFlight = 0;
    let inFlightItems = 0;
    for (const channel of this.channels.values()) {
      if (channel.inFlight) inFlight += 1;
      inFlightItems += channel.inFlightItems;
    }
    return {
      inFlight,
      inFlightItems,
      pendingItems: this.pendingItemCount,
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
      lastDispatchMs: this.metrics.lastDispatchMs,
      maxDispatchMs: this.metrics.maxDispatchMs,
      totalDispatchMs: this.metrics.totalDispatchMs,
    };
  }

  /** 拒绝等待中的发布者并禁止后续投递；已经交给传输层的任务不会被撤回。 / Rejects pending publishers and prevents future delivery; in-flight transport work is not recalled. */
  Dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new Error("broadcast hub disposed before delivery");
    for (const channel of this.channels.values()) {
      for (const job of channel.eventQueue) job.deferred.reject(error);
      for (const deferred of channel.latest?.deferred ?? []) deferred.reject(error);
      for (const deferred of channel.encodedLatest?.deferred ?? []) deferred.reject(error);
      channel.eventQueue.length = 0;
      channel.latest = undefined;
      channel.encodedLatest = undefined;
    }
    this.pendingItemCount = 0;
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
    this.pendingItemCount += items.length;
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
      else this.pendingItemCount += 1;
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
      this.pendingItemCount -= items.length;
    } else {
      const job = channel.eventQueue.shift() as EventJob<TItem> | undefined;
      if (!job) return;
      audience = job.audience;
      items = job.items;
      tick = job.tick;
      queuedAt = job.queuedAt;
      deferred = [job.deferred];
      this.pendingItemCount -= items.length;
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

    const dispatchStartedAt = monotonicNow();
    const delivery = this.transport.Send(audience, frame);
    this.recordDispatch(monotonicNow() - dispatchStartedAt);
    void delivery
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
      !channel.encodedLatest &&
      channel.eventQueue.length === 0
    ) {
      this.channels.delete(channel.key);
    }
  }

  private pumpEncodedSnapshot(channel: Channel, descriptorName: string): void {
    if (channel.inFlight || this.disposed) return;
    const job = channel.encodedLatest;
    if (!job) return;
    channel.encodedLatest = undefined;
    this.pendingItemCount -= job.itemCount;

    const startedAt = monotonicNow();
    const queueWaitMs = Math.max(0, startedAt - job.queuedAt);
    channel.inFlight = true;
    channel.inFlightItems = job.itemCount;
    this.metrics.broadcastsStarted += 1;
    this.metrics.sentItems += job.itemCount;
    this.metrics.maxInFlightItems = Math.max(
      this.metrics.maxInFlightItems,
      job.itemCount,
    );
    this.metrics.lastQueueWaitMs = queueWaitMs;
    this.metrics.maxQueueWaitMs = Math.max(this.metrics.maxQueueWaitMs, queueWaitMs);
    this.metrics.totalQueueWaitMs += queueWaitMs;

    const dispatchStartedAt = monotonicNow();
    const delivery = job.routeFrames
      ? this.transport.SendRouteFrames
        ? this.transport.SendRouteFrames(job.routeFrames)
        : Promise.reject(new Error("broadcast transport does not support encoded route frames"))
      : job.singleBatch
      ? this.transport.Send(job.singleBatch.audience, job.singleBatch.frame)
      : job.batches!.length === 1
      ? this.transport.Send(job.batches![0].audience, job.batches![0].frame)
      : this.transport.SendMany
      ? this.transport.SendMany(job.batches!)
      : Promise.all(
        job.batches!.map((batch) => this.transport.Send(batch.audience, batch.frame)),
      ).then(() => undefined);
    this.recordDispatch(monotonicNow() - dispatchStartedAt);
    void delivery
      .then(() => this.completeEncodedSnapshot(
        channel,
        descriptorName,
        startedAt,
        job.deferred,
      ))
      .catch((error) => this.completeEncodedSnapshot(
        channel,
        descriptorName,
        startedAt,
        job.deferred,
        error,
      ));
  }

  private completeEncodedSnapshot(
    channel: Channel,
    descriptorName: string,
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
      this.onError(descriptorName, error);
      for (const item of deferred) item.reject(error);
    }
    this.pumpEncodedSnapshot(channel, descriptorName);
    if (
      !channel.inFlight &&
      !channel.latest &&
      !channel.encodedLatest &&
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

  /** 记录 Transport 在返回 Promise 前完成的同步分组与入队耗时。 / Records synchronous grouping and enqueue work completed before Transport returns its Promise. */
  private recordDispatch(durationMs: number): void {
    const normalized = Math.max(0, durationMs);
    this.metrics.lastDispatchMs = normalized;
    this.metrics.maxDispatchMs = Math.max(this.metrics.maxDispatchMs, normalized);
    this.metrics.totalDispatchMs += normalized;
  }

  private recordPending(): void {
    this.metrics.maxPendingItems = Math.max(
      this.metrics.maxPendingItems,
      this.pendingItemCount,
    );
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
