import {
  getKnownMessageDescriptors,
  getMessageBindings,
  type AnyMessageDescriptor,
  type IMessage,
  type IRequest,
  type IResponse,
  type MessageDescriptor,
} from "../protocol/message";
import { isPromiseLike, type MaybePromise } from "../async";
import {
  packFrame,
  ProtocolContext,
  ProtocolRegistry,
} from "../protocol/registry";
import {
  AnyRpcDescriptor,
  getKnownRpcDescriptors,
  getRpcBindings,
  RpcDescriptor,
} from "../protocol/rpc";
import { Entity, ProcessHost } from "../runtime";
import type { GameUpdateConfig } from "../runtime/Game";
import { readU16BE } from "../protocol/binary";
import { SystemErrCode } from "../protocol/SystemErrCode";
import { RpcError } from "../protocol/RpcError";
import type { ActorRef, MessageTarget, SceneRef } from "../runtime";
import {
  LatencyRecorder,
  nowMs,
  type LatencyMetricSnapshot,
  type LatencyRecorderOptions,
} from "../metrics/latency";
import { SceneCallContext } from "./context";
import { SceneMessageHelper } from "./SceneMessageHelper";
import {
  ActorLocationDirectory,
  ActorLocationEnvelopeMsgCode,
  ActorLocationEnvelopeHeaderBytes,
  encodeActorLocationEnvelope,
  readActorLocationInstanceId,
} from "./ActorLocation";
import {
  getSceneMessageHandlerBindings,
  getSceneRpcHandlerBindings,
} from "./sceneHandlers";
import {
  getActorMessageHandlerBindings,
  getActorRpcHandlerBindings,
} from "./actorHandlers";

export interface SceneConfig {
  name: string;
  sceneType: string;
  ip: string;
  port: number;
}

export interface ProcessConfig {
  name: string;
  game?: GameUpdateConfig;
  scheduling?: ProcessSchedulingConfig;
  observability?: ProcessObservabilityConfig;
}

export interface ProcessSchedulingConfig {
  mode?: "low-latency" | "throughput" | "adaptive";
  idleTickMs?: number;
  maxEventsPerUpdate?: number;
  coalesceMicros?: number;
}

export interface ProcessObservabilityConfig {
  latency?: LatencyRecorderOptions;
}

export interface RuntimeEntrySceneConfig {
  process: ProcessConfig;
  self: SceneConfig;
  knownScenes: SceneConfig[];
  tickMs: number;
  processHost: ProcessHost;
  localRouter: LocalSceneRouter;
}

export interface ProcessRuntimeConfig {
  process: ProcessConfig;
  scenes: SceneConfig[];
  knownScenes: SceneConfig[];
  tickMs: number;
}

export interface LocalSceneRouter {
  hasLocalScene(name: string): boolean;
  callLocalScene(sourceName: string, targetName: string, frame: Uint8Array): Promise<Uint8Array>;
  sendLocalScene(sourceName: string, targetName: string, frame: Uint8Array): Promise<void>;
}

export interface OutboundBatch {
  connectionIdBytes: Uint8Array;
  frame: Uint8Array;
}

export interface SceneUpdateResult {
  outbound: OutboundBatch[];
  metrics?: SceneMetricsSnapshot;
  pendingAsync: boolean;
}

export interface SceneMetricsSnapshot {
  scene: string;
  sceneType: string;
  processedFrames: number;
  failedFrames: number;
  ingressQueueLength: number;
  maxIngressQueueLength: number;
  lastUpdateCostMs: number;
  lastHandlerCostMs: number;
  maxHandlerCostMs: number;
  totalHandlerCostMs: number;
  asyncInFlight: number;
  maxAsyncInFlight: number;
  latencies: LatencyMetricSnapshot[];
}

export type SceneMailboxType = "ordered" | "unordered";

type QueuedEvent =
  | {
      kind: "frame";
      connectionId: number;
      frame: Uint8Array;
      queuedAtMs: number;
    }
  | {
      kind: "disconnect";
      connectionId: number;
      queuedAtMs: number;
    };

interface MailboxTask<T = unknown> {
  run: () => MaybePromise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export abstract class EntryScene extends Entity {
  private static readonly MAX_UNORDERED_IN_FLIGHT = 4096;
  protected readonly registry: ProtocolRegistry;
  private readonly actorRegistry: ProtocolRegistry;
  protected readonly ctx: SceneCallContext;
  readonly scenes: SceneMessageHelper;
  readonly processHost: ProcessHost;
  protected readonly actorLocations = new ActorLocationDirectory();
  protected readonly mailbox: SceneMailboxType = "ordered";
  private readonly ingress: QueuedEvent[] = [];
  private ingressHead = 0;
  private readonly outbound: OutboundBatch[] = [];
  private readonly connectionIdBytes = new Map<number, Uint8Array>();
  private readonly unorderedTasks = new Set<Promise<void>>();
  private orderedTask: Promise<void> | undefined;
  private mailboxBusy = false;
  private readonly mailboxTasks: MailboxTask[] = [];
  private readonly metrics = {
    processedFrames: 0,
    failedFrames: 0,
    maxIngressQueueLength: 0,
    lastUpdateCostMs: 0,
    lastHandlerCostMs: 0,
    maxHandlerCostMs: 0,
    totalHandlerCostMs: 0,
    maxAsyncInFlight: 0,
  };
  private readonly latencies: LatencyRecorder;
  private readonly knownRpcsByCode = new Map<number, AnyRpcDescriptor>();
  private readonly knownMessagesByCode = new Map<number, AnyMessageDescriptor>();
  private readonly registeredRpcHandlers = new Map<number, string>();
  private readonly registeredMessageHandlers = new Map<number, string>();

  constructor(
    protected readonly config: RuntimeEntrySceneConfig,
    knownRpcs: readonly AnyRpcDescriptor[] = getKnownRpcDescriptors(),
    knownMessages: readonly AnyMessageDescriptor[] = getKnownMessageDescriptors(),
  ) {
    super();
    this.latencies = new LatencyRecorder(config.process.observability?.latency);
    const latencyMetrics = this.latencies.enabled ? this.latencies : undefined;
    this.ctx = new SceneCallContext(config, config.localRouter, latencyMetrics);
    this.scenes = new SceneMessageHelper(this.ctx);
    this.processHost = config.processHost;
    this.registry = new ProtocolRegistry(
      (message) => console.error(`[${config.self.name}] ${message}`),
      latencyMetrics,
    );
    this.actorRegistry = new ProtocolRegistry(
      (message) => console.error(`[${config.self.name}/actor] ${message}`),
      latencyMetrics,
    );
    for (const descriptor of knownRpcs) {
      this.knownRpcsByCode.set(descriptor.requestCode, descriptor);
      this.registry.registerKnownRpc(descriptor);
      this.actorRegistry.registerKnownRpc(descriptor);
    }
    for (const descriptor of knownMessages) {
      this.knownMessagesByCode.set(descriptor.msgcode, descriptor);
      this.registry.registerKnownMessage(descriptor);
      this.actorRegistry.registerKnownMessage(descriptor);
    }
    this.registerDecoratedRpcHandlers();
    this.registerDecoratedMessageHandlers();
    this.registerExternalRpcHandlers();
    this.registerExternalMessageHandlers();
    this.registerActorRpcHandlers();
    this.registerActorMessageHandlers();
    this.registerHandlers();
  }

  get self(): SceneConfig {
    return this.config.self;
  }

  start(): string {
    return `[${this.self.name}] ${this.self.sceneType} scene started at ${this.self.ip}:${this.self.port}`;
  }

  pushHostFrame(connectionId: number, frame: Uint8Array): void {
    this.enqueueIngress({
      kind: "frame",
      connectionId,
      frame,
      queuedAtMs: this.latencies.enabled ? nowMs() : 0,
    });
  }

  pushHostDisconnect(connectionId: number): void {
    this.enqueueIngress({
      kind: "disconnect",
      connectionId,
      queuedAtMs: this.latencies.enabled ? nowMs() : 0,
    });
  }

  private enqueueIngress(event: QueuedEvent): void {
    this.ingress.push(event);
    this.metrics.maxIngressQueueLength = Math.max(
      this.metrics.maxIngressQueueLength,
      this.ingressLength,
    );
  }

  update(maxFrames = 512, includeMetrics = true): SceneUpdateResult {
    const startedAt = this.__pumpMailbox(maxFrames);
    return this.__completeUpdate(startedAt, includeMetrics);
  }

  __pumpMailbox(maxFrames = 512): number {
    const startedAt = nowMs();
    if (this.mailbox === "unordered") this.drainUnordered(maxFrames);
    else this.drainOrdered(maxFrames);
    return startedAt;
  }

  __completeUpdate(startedAt: number, includeMetrics = true): SceneUpdateResult {
    return this.completeUpdate(startedAt, includeMetrics);
  }

  protected registerHandlers(): void {}

  childSceneId(localId: string): string {
    return `${this.self.name}/${localId}`;
  }

  protected onDisconnect(_connectionId: number): MaybePromise<void> {}

  protected sendClient<TMessage extends IMessage>(
    connectionId: number,
    descriptor: MessageDescriptor<TMessage>,
    message: TMessage,
  ): void {
    this.outbound.push({
      connectionIdBytes: this.packConnectionId(connectionId),
      frame: packFrame(descriptor.msgcode, descriptor.codec.encode(message)),
    });
  }

  protected sendClientMany<TMessage extends IMessage>(
    connectionIds: readonly number[],
    descriptor: MessageDescriptor<TMessage>,
    message: TMessage,
  ): void {
    if (connectionIds.length === 0) return;

    const frame = packFrame(descriptor.msgcode, descriptor.codec.encode(message));
    this.outbound.push({
      connectionIdBytes: packConnectionIds(connectionIds),
      frame,
    });
  }

  protected registerSceneRpc<TReq extends IRequest, TResp extends IResponse>(
    descriptor: RpcDescriptor<TReq, TResp>,
    target: SceneRef | ((request: TReq) => SceneRef),
    options: TargetRpcOptions<TReq, TResp> = {},
  ): void {
    this.registerTargetRpc(descriptor, target, options);
  }

  protected registerActorRpc<TReq extends IRequest, TResp extends IResponse>(
    descriptor: RpcDescriptor<TReq, TResp>,
    target: ActorRef | ((request: TReq) => ActorRef),
    options: TargetRpcOptions<TReq, TResp> = {},
  ): void {
    this.registerTargetRpc(descriptor, target, options);
  }

  dispatchLocalCall(frame: Uint8Array): Promise<Uint8Array> {
    const result = this.dispatchMailbox(() => this.handleFrame(frame));
    return Promise.resolve(result).then((response) => {
      if (!response) throw new Error(`scene ${this.self.name} returned no RPC response`);
      return response;
    });
  }

  dispatchLocalSend(frame: Uint8Array): Promise<void> {
    return Promise.resolve(this.dispatchMailbox(() => this.handleFrame(frame))).then(() => undefined);
  }

  metricsSnapshot(): SceneMetricsSnapshot {
    return {
      scene: this.self.name,
      sceneType: this.self.sceneType,
      processedFrames: this.metrics.processedFrames,
      failedFrames: this.metrics.failedFrames,
      ingressQueueLength: this.ingressLength,
      maxIngressQueueLength: this.metrics.maxIngressQueueLength,
      lastUpdateCostMs: this.metrics.lastUpdateCostMs,
      lastHandlerCostMs: this.metrics.lastHandlerCostMs,
      maxHandlerCostMs: this.metrics.maxHandlerCostMs,
      totalHandlerCostMs: this.metrics.totalHandlerCostMs,
      asyncInFlight: this.unorderedTasks.size,
      maxAsyncInFlight: this.metrics.maxAsyncInFlight,
      latencies: this.latencies.snapshot(),
    };
  }

  private drainOutbound(): OutboundBatch[] {
    const frames = this.outbound.splice(0, this.outbound.length);
    return frames;
  }

  private get ingressLength(): number {
    return this.ingress.length - this.ingressHead;
  }

  private dequeueIngress(): QueuedEvent | undefined {
    if (this.ingressHead >= this.ingress.length) return undefined;
    const item = this.ingress[this.ingressHead++];
    if (this.ingressHead === this.ingress.length) {
      this.ingress.length = 0;
      this.ingressHead = 0;
    } else if (
      this.ingressHead >= 1024 &&
      this.ingressHead * 2 >= this.ingress.length
    ) {
      this.ingress.splice(0, this.ingressHead);
      this.ingressHead = 0;
    }
    return item;
  }

  private completeUpdate(startedAt: number, includeMetrics: boolean): SceneUpdateResult {
    this.metrics.lastUpdateCostMs = nowMs() - startedAt;
    return {
      outbound: this.drainOutbound(),
      metrics: includeMetrics ? this.metricsSnapshot() : undefined,
      pendingAsync: this.orderedTask !== undefined || this.unorderedTasks.size > 0,
    };
  }

  private drainOrdered(maxFrames: number): void {
    if (this.orderedTask) return;
    let processed = 0;
    while (this.ingressLength > 0 && processed < maxFrames) {
      const item = this.dequeueIngress()!;
      const result = this.dispatchMailbox(() => this.processIngress(item));
      processed += 1;
      if (isPromiseLike(result)) {
        let task: Promise<void>;
        task = Promise.resolve(result)
          .catch((error) => {
            console.error(`[${this.self.name}] ordered handler failed`, error);
          })
          .finally(() => {
            if (this.orderedTask === task) this.orderedTask = undefined;
          });
        this.orderedTask = task;
        break;
      }
    }
  }

  private drainUnordered(maxFrames: number): void {
    let processed = 0;
    while (
      this.ingressLength > 0 &&
      processed < maxFrames &&
      this.unorderedTasks.size < EntryScene.MAX_UNORDERED_IN_FLIGHT
    ) {
      const item = this.dequeueIngress()!;
      try {
        const result = this.processIngress(item);
        if (isPromiseLike(result)) {
          let task: Promise<void>;
          task = Promise.resolve(result)
            .catch((error) => {
              console.error(`[${this.self.name}] unordered handler failed`, error);
            })
            .finally(() => {
              this.unorderedTasks.delete(task);
            });
          this.unorderedTasks.add(task);
          this.metrics.maxAsyncInFlight = Math.max(
            this.metrics.maxAsyncInFlight,
            this.unorderedTasks.size,
          );
        }
      } catch (error) {
        console.error(`[${this.self.name}] unordered handler failed`, error);
      }
      processed += 1;
    }
  }

  private dispatchMailbox<T>(run: () => MaybePromise<T>): MaybePromise<T> {
    if (this.mailbox === "unordered") return run();
    if (this.mailboxBusy) {
      return new Promise<T>((resolve, reject) => {
        this.mailboxTasks.push({
          run: run as () => MaybePromise<unknown>,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
      });
    }
    this.mailboxBusy = true;
    return this.runMailboxTask(run);
  }

  private runMailboxTask<T>(run: () => MaybePromise<T>): MaybePromise<T> {
    try {
      const result = run();
      if (isPromiseLike(result)) {
        return Promise.resolve(result).then(
          (value) => {
            this.finishMailboxTask();
            return value;
          },
          (error) => {
            this.finishMailboxTask();
            throw error;
          },
        );
      }
      this.finishMailboxTask();
      return result;
    } catch (error) {
      this.finishMailboxTask();
      throw error;
    }
  }

  private finishMailboxTask(): void {
    const next = this.mailboxTasks.shift();
    if (!next) {
      this.mailboxBusy = false;
      return;
    }
    try {
      const result = this.runMailboxTask(next.run);
      if (isPromiseLike(result)) Promise.resolve(result).then(next.resolve, next.reject);
      else next.resolve(result);
    } catch (error) {
      next.reject(error);
    }
  }

  private processIngress(item: QueuedEvent): MaybePromise<void> {
    if (this.latencies.enabled) {
      this.latencies.record("ingress.queue", nowMs() - item.queuedAtMs);
    }
    if (item.kind === "disconnect") {
      this.connectionIdBytes.delete(item.connectionId);
      try {
        const result = this.onDisconnect(item.connectionId);
        if (isPromiseLike(result)) {
          return Promise.resolve(result).catch((error) => {
            console.error(
              `[${this.self.name}] disconnect handler failed for connection ${item.connectionId}`,
              error,
            );
          });
        }
      } catch (error) {
        console.error(
          `[${this.self.name}] disconnect handler failed for connection ${item.connectionId}`,
          error,
        );
      }
      return;
    }

    const response = this.handleFrame(item.frame, {
      connectionId: item.connectionId,
    });
    if (isPromiseLike(response)) {
      return Promise.resolve(response).then((value) => {
        this.enqueueResponse(item.connectionId, value);
      });
    }
    this.enqueueResponse(item.connectionId, response);
  }

  private enqueueResponse(
    connectionId: number,
    response: Uint8Array | undefined,
  ): void {
    if (!response) return;
    this.outbound.push({
      connectionIdBytes: this.packConnectionId(connectionId),
      frame: response,
    });
  }

  private packConnectionId(connectionId: number): Uint8Array {
    let bytes = this.connectionIdBytes.get(connectionId);
    if (!bytes) {
      bytes = packConnectionIds([connectionId]);
      this.connectionIdBytes.set(connectionId, bytes);
    }
    return bytes;
  }

  private handleFrame(
    frame: Uint8Array,
    context: ProtocolContext = {},
  ): MaybePromise<Uint8Array | undefined> {
    const startedAt = nowMs();
    const msgcode = this.latencies.enabled && frame.length >= 2
      ? readU16BE(frame, 0)
      : undefined;
    try {
      const response = this.routeOrHandleFrame(frame, context);
      if (isPromiseLike(response)) {
        return Promise.resolve(response).then(
          (value) => {
            this.completeHandler(startedAt, false);
            if (this.latencies.enabled) {
              this.latencies.record("frame.total", nowMs() - startedAt, msgcode);
            }
            return value;
          },
          (error) => {
            this.completeHandler(startedAt, true);
            if (this.latencies.enabled) {
              this.latencies.record("frame.total", nowMs() - startedAt, msgcode);
            }
            throw error;
          },
        );
      }
      this.completeHandler(startedAt, false);
      if (this.latencies.enabled) {
        this.latencies.record("frame.total", nowMs() - startedAt, msgcode);
      }
      return response;
    } catch (error) {
      this.completeHandler(startedAt, true);
      if (this.latencies.enabled) {
        this.latencies.record("frame.total", nowMs() - startedAt, msgcode);
      }
      throw error;
    }
  }

  private routeOrHandleFrame(
    frame: Uint8Array,
    context: ProtocolContext,
  ): MaybePromise<Uint8Array | undefined> {
    if (frame.length < 2) return this.registry.handle(frame, context);

    const msgcode = readU16BE(frame, 0);
    if (msgcode === ActorLocationEnvelopeMsgCode) {
      try {
        const instanceId = readActorLocationInstanceId(frame);
        return this.actorRegistry.handle(frame.subarray(ActorLocationEnvelopeHeaderBytes), {
          actorInstanceId: instanceId,
        });
      } catch (error) {
        this.registry.reportSystemError(
          SystemErrCode.MalformedFrame,
          `invalid actor location envelope: ${errorText(error)}`,
        );
        return undefined;
      }
    }

    if (context.connectionId === undefined || context.actorInstanceId !== undefined) {
      return this.registry.handle(frame, context);
    }

    const rpcDescriptor = this.knownRpcsByCode.get(msgcode);
    const messageDescriptor = this.knownMessagesByCode.get(msgcode);
    if (
      rpcDescriptor?.routing !== "actor-location" &&
      messageDescriptor?.routing !== "actor-location"
    ) {
      return this.registry.handle(frame, context);
    }

    const target = this.actorLocations.resolveConnection(context.connectionId);
    if (!target) {
      return this.registry.routingErrorResponse(
        frame,
        SystemErrCode.ActorLocationNotFound,
        `actor location is not bound for connection ${context.connectionId}`,
      );
    }

    if (rpcDescriptor) {
      return this.ctx.callActorFrame(
        target,
        frame,
        rpcDescriptor.responseCode,
      ).then(
        (response) => response,
        (error) => this.registry.routingErrorResponse(
          frame,
          error instanceof RpcError ? error.code : SystemErrCode.SceneCallFailed,
          `actor location call failed: ${errorText(error)}`,
        ),
      );
    }
    const routedFrame = encodeActorLocationEnvelope({
      instanceId: target.instanceId,
      frame,
    });
    return this.ctx.sendFrame(target.scene, routedFrame).then(
      () => undefined,
      (error) => {
        this.registry.reportSystemError(
          error instanceof RpcError ? error.code : SystemErrCode.SceneCallFailed,
          `actor location send failed: ${errorText(error)}`,
        );
        return undefined;
      },
    );
  }

  private completeHandler(startedAt: number, failed: boolean): void {
    const cost = nowMs() - startedAt;
    this.metrics.processedFrames += 1;
    if (failed) this.metrics.failedFrames += 1;
    this.metrics.lastHandlerCostMs = cost;
    this.metrics.maxHandlerCostMs = Math.max(
      this.metrics.maxHandlerCostMs,
      cost,
    );
    this.metrics.totalHandlerCostMs += cost;
  }

  private registerTargetRpc<TReq extends IRequest, TResp extends IResponse>(
    descriptor: RpcDescriptor<TReq, TResp>,
    target: MessageTarget | ((request: TReq) => MessageTarget),
    options: TargetRpcOptions<TReq, TResp>,
  ): void {
    const handlerName = options.handlerName ?? descriptor.name;
    this.claimRpcHandler(descriptor.requestCode, handlerName);
    this.registry.register(descriptor.requestCode, {
      responseCode: descriptor.responseCode,
      decode: descriptor.requestCodec.decode,
      encode: descriptor.responseCodec.encode,
      handle: async (request) => {
        const resolvedTarget =
          typeof target === "function" ? target(request) : target;
        const response = await this.processHost.call<TResp>(
          undefined,
          resolvedTarget,
          handlerName,
          request,
        );
        await options.after?.call(this, request, response);
        return response;
      },
    });
  }

  private registerDecoratedRpcHandlers(): void {
    for (const binding of getRpcBindings(this.constructor)) {
      const descriptor = binding.descriptor;
      const method = (this as unknown as Record<string, unknown>)[binding.method];
      if (typeof method !== "function") {
        throw new Error(`RPC handler is not a function: ${descriptor.name}`);
      }

      this.claimRpcHandler(descriptor.requestCode, binding.method);

      this.registry.register(descriptor.requestCode, {
        responseCode: descriptor.responseCode,
        decode: descriptor.requestCodec.decode,
        encode: descriptor.responseCodec.encode,
        handle: (request, context) => method.call(this, request, context),
      });
    }
  }

  private registerDecoratedMessageHandlers(): void {
    for (const binding of getMessageBindings(this.constructor)) {
      const descriptor = binding.descriptor;
      const method = (this as unknown as Record<string, unknown>)[binding.method];
      if (typeof method !== "function") {
        throw new Error(`Message handler is not a function: ${descriptor.name}`);
      }

      this.claimMessageHandler(descriptor.msgcode, binding.method);

      this.registry.registerMessage(descriptor.msgcode, {
        decode: descriptor.codec.decode,
        handle: (message, context) => method.call(this, message, context),
      });
    }
  }

  private registerExternalRpcHandlers(): void {
    for (const binding of getSceneRpcHandlerBindings(this.constructor)) {
      const handler = new binding.handlerCtor();
      this.claimRpcHandler(binding.descriptor.requestCode, binding.handlerCtor.name);
      this.registry.register(binding.descriptor.requestCode, {
        responseCode: binding.descriptor.responseCode,
        decode: binding.descriptor.requestCodec.decode,
        encode: binding.descriptor.responseCodec.encode,
        handle: (request, context) => handler.handle(this, request, context),
      });
    }
  }

  private registerExternalMessageHandlers(): void {
    for (const binding of getSceneMessageHandlerBindings(this.constructor)) {
      const handler = new binding.handlerCtor();
      this.claimMessageHandler(binding.descriptor.msgcode, binding.handlerCtor.name);
      this.registry.registerMessage(binding.descriptor.msgcode, {
        decode: binding.descriptor.codec.decode,
        handle: (message, context) => handler.handle(this, message, context),
      });
    }
  }

  private registerActorRpcHandlers(): void {
    const grouped = groupByCode(
      getActorRpcHandlerBindings(),
      (binding) => binding.descriptor.requestCode,
    );
    for (const [msgcode, bindings] of grouped) {
      const descriptor = bindings[0].descriptor;
      const handlers = bindings.map((binding) => ({
        ...binding,
        handler: new binding.handlerCtor(),
      }));
      const handlerByActorCtor = new Map<Function, (typeof handlers)[number]>();
      this.actorRegistry.register(msgcode, {
        responseCode: descriptor.responseCode,
        decode: descriptor.requestCodec.decode,
        encode: descriptor.responseCodec.encode,
        handle: (request, context) => {
          const instanceId = context.actorInstanceId;
          if (instanceId === undefined) {
            throw new RpcError(
              SystemErrCode.ActorLocationNotFound,
              `actor instance id is missing for msgcode ${msgcode}`,
            );
          }
          if (!this.processHost.Root.Get(instanceId)) {
            throw new RpcError(
              SystemErrCode.ActorLocationNotFound,
              `actor instance not found: ${instanceId}`,
            );
          }
          return this.processHost.runActorMailbox(instanceId, (actor) => {
            const actorCtor = actor.constructor;
            let binding = handlerByActorCtor.get(actorCtor);
            if (!binding) {
              binding = handlers.find((item) => actor instanceof item.actorCtor);
              if (binding) handlerByActorCtor.set(actorCtor, binding);
            }
            if (!binding) {
              throw new RpcError(
                SystemErrCode.HandlerNotFound,
                `actor RPC handler not found: ${actor.constructor.name} msgcode ${msgcode}`,
              );
            }
            return binding.handler.handle(actor, request, context);
          });
        },
      });
    }
  }

  private registerActorMessageHandlers(): void {
    const grouped = groupByCode(
      getActorMessageHandlerBindings(),
      (binding) => binding.descriptor.msgcode,
    );
    for (const [msgcode, bindings] of grouped) {
      const descriptor = bindings[0].descriptor;
      const handlers = bindings.map((binding) => ({
        ...binding,
        handler: new binding.handlerCtor(),
      }));
      const handlerByActorCtor = new Map<Function, (typeof handlers)[number]>();
      this.actorRegistry.registerMessage(msgcode, {
        decode: descriptor.codec.decode,
        handle: (message, context) => {
          const instanceId = context.actorInstanceId;
          if (instanceId === undefined) {
            throw new RpcError(
              SystemErrCode.ActorLocationNotFound,
              `actor instance id is missing for msgcode ${msgcode}`,
            );
          }
          if (!this.processHost.Root.Get(instanceId)) {
            throw new RpcError(
              SystemErrCode.ActorLocationNotFound,
              `actor instance not found: ${instanceId}`,
            );
          }
          return this.processHost.runActorMailbox(instanceId, (actor) => {
            const actorCtor = actor.constructor;
            let binding = handlerByActorCtor.get(actorCtor);
            if (!binding) {
              binding = handlers.find((item) => actor instanceof item.actorCtor);
              if (binding) handlerByActorCtor.set(actorCtor, binding);
            }
            if (!binding) {
              throw new RpcError(
                SystemErrCode.HandlerNotFound,
                `actor message handler not found: ${actor.constructor.name} msgcode ${msgcode}`,
              );
            }
            return binding.handler.handle(actor, message, context);
          });
        },
      });
    }
  }

  private claimRpcHandler(msgcode: number, owner: string): void {
    const existing = this.registeredRpcHandlers.get(msgcode);
    if (existing) {
      throw new Error(
        `duplicate RPC handler for ${this.self.sceneType} msgcode ${msgcode}: ${existing}, ${owner}`,
      );
    }
    this.registeredRpcHandlers.set(msgcode, owner);
  }

  private claimMessageHandler(msgcode: number, owner: string): void {
    const existing = this.registeredMessageHandlers.get(msgcode);
    if (existing) {
      throw new Error(
        `duplicate message handler for ${this.self.sceneType} msgcode ${msgcode}: ${existing}, ${owner}`,
      );
    }
    this.registeredMessageHandlers.set(msgcode, owner);
  }
}

export type EntrySceneCtor = new (config: RuntimeEntrySceneConfig) => EntryScene;

export interface TargetRpcOptions<TReq, TResp> {
  handlerName?: string;
  after?: (this: EntryScene, request: TReq, response: TResp) => void | Promise<void>;
}

function packConnectionIds(connectionIds: readonly number[]): Uint8Array {
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function groupByCode<T>(
  items: readonly T[],
  getCode: (item: T) => number,
): Map<number, T[]> {
  const grouped = new Map<number, T[]>();
  for (const item of items) {
    const code = getCode(item);
    const values = grouped.get(code) ?? [];
    values.push(item);
    grouped.set(code, values);
  }
  return grouped;
}
