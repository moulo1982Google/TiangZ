import { packFrame } from "../protocol/registry";
import { monotonicNow } from "../runtime/Game";
import type { IMessage } from "../protocol/message";
import type {
  BroadcastAudience,
  BroadcastRoute,
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
  readonly prebuiltFrame?: Uint8Array;
  readonly tick: number;
  readonly queuedAt: number;
  readonly deferred: Deferred;
}

interface LatestJob<TItem> {
  audience: BroadcastAudience;
  readonly items: Map<string | number, TItem>;
  prebuiltFrame?: Uint8Array;
  tick: number;
  queuedAt: number;
  readonly deferred: Deferred[];
}

interface EncodedSnapshotJob {
  batches?: readonly EncodedAudienceBatch[];
  singleBatch?: EncodedAudienceBatch;
  routeFrames?: readonly EncodedRouteFrame[];
  itemCount: number;
  byteLength: number;
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
const DEFAULT_MAX_LATEST_PENDING_ITEMS = 262_144;
const DEFAULT_MAX_LATEST_PENDING_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_LATEST_PENDING_AGE_MS = 5_000;

export class BroadcastHub {
  private readonly channels = new Map<string, Channel>();
  private readonly maxEventQueuePerChannel: number;
  private readonly maxLatestPendingItemsPerChannel: number;
  private readonly maxLatestPendingBytesPerChannel: number;
  private readonly maxLatestPendingAgeMs: number;
  private readonly onError: (descriptorName: string, error: unknown) => void;
  private disposed = false;
  // 维护待发送项计数，避免每次入队都扫描全部频道。 / Keep a running pending-item count instead of scanning every channel on each enqueue.
  private pendingItemCount = 0;
  private readonly metrics = {
    queuedItems: 0,
    coalescedItems: 0,
    supersededPublishes: 0,
    latestCapacityRejections: 0,
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
    this.maxLatestPendingItemsPerChannel =
      options.maxLatestPendingItemsPerChannel ?? DEFAULT_MAX_LATEST_PENDING_ITEMS;
    this.maxLatestPendingBytesPerChannel =
      options.maxLatestPendingBytesPerChannel ?? DEFAULT_MAX_LATEST_PENDING_BYTES;
    this.maxLatestPendingAgeMs =
      options.maxLatestPendingAgeMs ?? DEFAULT_MAX_LATEST_PENDING_AGE_MS;
    this.validateOptions();
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
    const routedAudiences = splitAudienceByRoute(audience);
    for (const routed of routedAudiences) {
      this.requireRoutedPublishCapacity(routed, descriptor, items);
    }
    if (routedAudiences.length === 1) {
      return this.publishRouted(routedAudiences[0], descriptor, items, tick);
    }
    let sharedFrame: Uint8Array;
    try {
      const message = descriptor.makeMessage(items, tick);
      sharedFrame = packFrame(descriptor.message.msgcode, descriptor.message.codec.encode(message));
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.all(
      routedAudiences.map((routed) =>
        this.publishRouted(routed, descriptor, items, tick, sharedFrame)
      ),
    ).then(() => undefined);
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
    if (this.disposed) return Promise.reject(new Error("broadcast hub is disposed"));
    if (!Number.isSafeInteger(itemCount) || itemCount < 0) {
      throw new Error(`invalid encoded broadcast item count: ${itemCount}`);
    }
    if (itemCount === 0 || audience.routes.length === 0) return Promise.resolve();
    this.validateAudience(audience);
    const routedAudiences = splitAudienceByRoute(audience);
    const deliveries = routedAudiences.map((routed) => this.enqueueEncodedLatest(
      routedChannelKey(audience.key, routed.routes[0]!.route),
      descriptorName,
      undefined,
      { audience: routed, frame, itemCount },
    ));
    return deliveries.length === 1
      ? deliveries[0]
      : Promise.all(deliveries).then(() => undefined);
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
    if (this.disposed) return Promise.reject(new Error("broadcast hub is disposed"));
    const batchesByRoute = new Map<string, EncodedAudienceBatch[]>();
    for (const batch of batches) {
      if (batch.itemCount <= 0 || batch.audience.routes.length === 0) continue;
      this.validateEncodedBatch(batch);
      for (const routed of splitAudienceByRoute(batch.audience)) {
        const route = routed.routes[0]!.route;
        const routeBatches = batchesByRoute.get(route) ?? [];
        routeBatches.push({ audience: routed, frame: batch.frame, itemCount: batch.itemCount });
        batchesByRoute.set(route, routeBatches);
      }
    }
    const deliveries = [...batchesByRoute].map(([route, routeBatches]) =>
      this.enqueueEncodedLatest(
        routedChannelKey(audienceKey, route),
        descriptorName,
        routeBatches,
      )
    );
    if (deliveries.length === 0) return Promise.resolve();
    return deliveries.length === 1
      ? deliveries[0]
      : Promise.all(deliveries).then(() => undefined);
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
    let byteLength = 0;
    if (singleBatch) {
      if (singleBatch.itemCount <= 0 || singleBatch.audience.routes.length === 0) {
        return Promise.resolve();
      }
      this.validateEncodedBatch(singleBatch);
      itemCount = singleBatch.itemCount;
      byteLength = singleBatch.frame.byteLength;
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
        byteLength += batch.frame.byteLength;
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
      this.requireLatestCapacity(channelKey, itemCount, byteLength, existing.queuedAt);
    } else {
      this.requireLatestCapacity(channelKey, itemCount, byteLength);
    }

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    if (existing) {
      this.metrics.coalescedItems += existing.itemCount;
      this.pendingItemCount += itemCount - existing.itemCount;
      this.resolveSuperseded(existing.deferred);
      existing.batches = activeBatches;
      existing.singleBatch = activeSingleBatch;
      existing.itemCount = itemCount;
      existing.byteLength = byteLength;
      existing.queuedAt = monotonicNow();
      existing.deferred.push({ resolve, reject });
    } else {
      channel.encodedLatest = {
        batches: activeBatches,
        singleBatch: activeSingleBatch,
        itemCount,
        byteLength,
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
  ): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("broadcast hub is disposed"));
    if (!audienceKey) throw new Error("encoded broadcast audience key is required");
    if (!descriptorName) throw new Error("encoded broadcast name is required");
    if (routeFrames.length === 0) return Promise.resolve();
    const framesByRoute = new Map<string, EncodedRouteFrame[]>();
    for (const item of routeFrames) {
      if (!item.route) throw new Error("encoded route frame has no route");
      if (item.frame.length < 2) throw new Error("encoded route frame is too short");
      if (!Number.isSafeInteger(item.itemCount) || item.itemCount < 0) {
        throw new Error(`invalid encoded route frame item count: ${item.itemCount}`);
      }
      if (item.itemCount === 0) continue;
      const routeFramesForGate = framesByRoute.get(item.route) ?? [];
      routeFramesForGate.push(item);
      framesByRoute.set(item.route, routeFramesForGate);
    }
    const deliveries = [...framesByRoute].map(([route, frames]) => this.enqueueRouteFrames(
      routedChannelKey(audienceKey, route),
      descriptorName,
      frames,
    ));
    if (deliveries.length === 0) return Promise.resolve();
    return deliveries.length === 1
      ? deliveries[0]
      : Promise.all(deliveries).then(() => undefined);
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
      supersededPublishes: this.metrics.supersededPublishes,
      latestCapacityRejections: this.metrics.latestCapacityRejections,
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
    prebuiltFrame?: Uint8Array,
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
        prebuiltFrame,
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

  /** 每个物理路由拥有独立频道；慢 Gate 不再阻塞同一逻辑受众中的其他 Gate。 / Gives each physical route an independent channel so one slow Gate cannot stall its peers. */
  private publishRouted<TItem, TMessage extends IMessage>(
    audience: BroadcastAudience,
    descriptor: BroadcastDescriptor<TItem, TMessage>,
    items: readonly TItem[],
    tick: number,
    prebuiltFrame?: Uint8Array,
  ): Promise<void> {
    const route = audience.routes[0]!.route;
    const channelKey = `${descriptor.name}\0${routedChannelKey(audience.key, route)}`;
    const channel = this.channels.get(channelKey) ?? this.createChannel(channelKey);
    return descriptor.mode === "latest"
      ? this.enqueueLatest(channel, audience, descriptor, items, tick, prebuiltFrame)
      : this.enqueueEvent(channel, audience, descriptor, items, tick, prebuiltFrame);
  }

  /** 跨Gate发布先完成全部容量预检，避免某个可靠事件只进入部分Gate队列。 / Preflights every Gate before enqueue so a reliable event cannot be accepted by only part of its audience due to local capacity. */
  private requireRoutedPublishCapacity<TItem, TMessage extends IMessage>(
    audience: BroadcastAudience,
    descriptor: BroadcastDescriptor<TItem, TMessage>,
    items: readonly TItem[],
  ): void {
    const route = audience.routes[0]!.route;
    const channelKey = `${descriptor.name}\0${routedChannelKey(audience.key, route)}`;
    const channel = this.channels.get(channelKey);
    if (descriptor.mode === "event") {
      if ((channel?.eventQueue.length ?? 0) >= this.maxEventQueuePerChannel) {
        throw new Error(
          `broadcast event queue is full: ${descriptor.name}/${audience.key}/${route}`,
        );
      }
      return;
    }

    const job = channel?.latest as LatestJob<TItem> | undefined;
    const keys = new Set<string | number>();
    for (const item of items) {
      const key = descriptor.keyOf(item);
      if (!job?.items.has(key)) keys.add(key);
    }
    this.requireLatestCapacity(
      channelKey,
      (job?.items.size ?? 0) + keys.size,
      0,
      job?.queuedAt,
    );
  }

  private enqueueLatest<TItem, TMessage extends IMessage>(
    channel: Channel,
    audience: BroadcastAudience,
    descriptor: LatestBroadcastDescriptor<TItem, TMessage>,
    items: readonly TItem[],
    tick: number,
    prebuiltFrame?: Uint8Array,
  ): Promise<void> {
    let job = channel.latest as LatestJob<TItem> | undefined;
    if (!job) {
      const keys = new Set<string | number>();
      for (const item of items) keys.add(descriptor.keyOf(item));
      this.requireLatestCapacity(channel.key, keys.size, 0);
      job = {
        audience,
        items: new Map(),
        prebuiltFrame,
        tick,
        queuedAt: monotonicNow(),
        deferred: [],
      };
      channel.latest = job as LatestJob<unknown>;
    } else {
      const addedKeys = new Set<string | number>();
      for (const item of items) {
        const key = descriptor.keyOf(item);
        if (!job.items.has(key)) addedKeys.add(key);
      }
      this.requireLatestCapacity(
        channel.key,
        job.items.size + addedKeys.size,
        0,
        job.queuedAt,
      );
      job.audience = audience;
      job.tick = Math.max(job.tick, tick);
      // 合并后的最终项集合不再等同于本次发布，必须在实际发送前重新编码。
      // The merged final item set no longer matches this publish, so it must be encoded at dispatch.
      job.prebuiltFrame = undefined;
      this.resolveSuperseded(job.deferred);
      job.queuedAt = monotonicNow();
    }

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
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

  private enqueueRouteFrames(
    channelSuffix: string,
    descriptorName: string,
    routeFrames: readonly EncodedRouteFrame[],
  ): Promise<void> {
    const itemCount = routeFrames.reduce((total, item) => total + item.itemCount, 0);
    const byteLength = routeFrames.reduce((total, item) => total + item.frame.byteLength, 0);
    const channelKey = `${descriptorName}\0${channelSuffix}`;
    const channel = this.channels.get(channelKey) ?? this.createChannel(channelKey);
    if (channel.latest || channel.eventQueue.length > 0) {
      throw new Error(`encoded and object broadcasts share channel ${channelKey}`);
    }

    const existing = channel.encodedLatest;
    if (existing) {
      if (existing.batches || existing.singleBatch !== undefined) {
        throw new Error(`encoded audience and route frames share channel ${channelKey}`);
      }
      this.requireLatestCapacity(channelKey, itemCount, byteLength, existing.queuedAt);
    } else {
      this.requireLatestCapacity(channelKey, itemCount, byteLength);
    }

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    if (existing) {
      this.metrics.coalescedItems += existing.itemCount;
      this.pendingItemCount += itemCount - existing.itemCount;
      this.resolveSuperseded(existing.deferred);
      existing.routeFrames = routeFrames;
      existing.itemCount = itemCount;
      existing.byteLength = byteLength;
      existing.queuedAt = monotonicNow();
      existing.deferred.push({ resolve, reject });
    } else {
      channel.encodedLatest = {
        routeFrames,
        itemCount,
        byteLength,
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

  private requireLatestCapacity(
    channelKey: string,
    itemCount: number,
    byteLength: number,
    queuedAt?: number,
  ): void {
    const ageMs = queuedAt === undefined ? 0 : Math.max(0, monotonicNow() - queuedAt);
    if (
      itemCount <= this.maxLatestPendingItemsPerChannel &&
      byteLength <= this.maxLatestPendingBytesPerChannel &&
      ageMs <= this.maxLatestPendingAgeMs
    ) {
      return;
    }
    this.metrics.latestCapacityRejections += 1;
    throw new Error(
      `broadcast latest pending capacity exceeded: ${channelKey} ` +
      `(items=${itemCount}/${this.maxLatestPendingItemsPerChannel}, ` +
      `bytes=${byteLength}/${this.maxLatestPendingBytesPerChannel}, ` +
      `ageMs=${ageMs}/${this.maxLatestPendingAgeMs})`,
    );
  }

  private resolveSuperseded(deferred: Deferred[]): void {
    if (deferred.length === 0) return;
    this.metrics.supersededPublishes += deferred.length;
    for (const item of deferred) item.resolve();
    deferred.length = 0;
  }

  private validateOptions(): void {
    const values = [
      ["maxEventQueuePerChannel", this.maxEventQueuePerChannel],
      ["maxLatestPendingItemsPerChannel", this.maxLatestPendingItemsPerChannel],
      ["maxLatestPendingBytesPerChannel", this.maxLatestPendingBytesPerChannel],
      ["maxLatestPendingAgeMs", this.maxLatestPendingAgeMs],
    ] as const;
    for (const [name, value] of values) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive safe integer`);
      }
    }
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
    let prebuiltFrame: Uint8Array | undefined;
    if (descriptor.mode === "latest") {
      const job = channel.latest as LatestJob<TItem> | undefined;
      if (!job || job.items.size === 0) return;
      channel.latest = undefined;
      audience = job.audience;
      items = [...job.items.values()];
      tick = job.tick;
      queuedAt = job.queuedAt;
      deferred = job.deferred;
      prebuiltFrame = job.prebuiltFrame;
      this.pendingItemCount -= items.length;
    } else {
      const job = channel.eventQueue.shift() as EventJob<TItem> | undefined;
      if (!job) return;
      audience = job.audience;
      items = job.items;
      tick = job.tick;
      queuedAt = job.queuedAt;
      deferred = [job.deferred];
      prebuiltFrame = job.prebuiltFrame;
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

    let frame = prebuiltFrame;
    if (!frame) {
      try {
        const message = descriptor.makeMessage(items, tick);
        frame = packFrame(descriptor.message.msgcode, descriptor.message.codec.encode(message));
      } catch (error) {
        this.complete(channel, descriptor, startedAt, deferred, error);
        return;
      }
    }

    const dispatchStartedAt = monotonicNow();
    // Event frames are still individually encoded and ordered, but a batch-capable
    // transport can combine same-tick jobs into one physical Gate message.
    // 事件帧仍保持独立编码和顺序语义，但支持批量的Transport可以把同一Tick的作业合并为一条Gate物理消息。
    const delivery = this.transport.SendMany
      ? this.transport.SendMany(
        [{ audience, frame, itemCount: items.length }],
        descriptor.mode === "latest" ? "latest" : "reliable",
      )
      : this.transport.Send(
        audience,
        frame,
        descriptor.mode === "latest" ? "latest" : "reliable",
      );
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
        ? this.transport.SendRouteFrames(job.routeFrames, "latest")
        : Promise.reject(new Error("broadcast transport does not support encoded route frames"))
      : job.singleBatch
      ? this.transport.Send(job.singleBatch.audience, job.singleBatch.frame, "latest")
      : this.transport.SendMany
      ? this.transport.SendMany(job.batches!, "latest")
      : job.batches!.length === 1
      ? this.transport.Send(job.batches![0].audience, job.batches![0].frame, "latest")
      : Promise.all(
        job.batches!.map((batch) =>
          this.transport.Send(batch.audience, batch.frame, "latest")
        ),
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

/** 按物理路由稳定分组，并保留每个 Gate 内的接收者顺序。 / Groups a logical audience by physical route while preserving per-Gate recipient order. */
function splitAudienceByRoute(audience: BroadcastAudience): BroadcastAudience[] {
  const routesByName = new Map<string, BroadcastRoute[]>();
  for (const route of audience.routes) {
    const routes = routesByName.get(route.route) ?? [];
    routes.push(route);
    routesByName.set(route.route, routes);
  }
  return [...routesByName.values()].map((routes) => ({ key: audience.key, routes }));
}

function routedChannelKey(audienceKey: string, route: string): string {
  return `${audienceKey}\0route:${route}`;
}
