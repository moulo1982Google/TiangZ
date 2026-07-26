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
  type ProtocolOutcome,
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
import type { ProcessLoggingConfig } from "../logging/types";
import type { Logger } from "../logging/Logger";

export interface SceneConfig {
  name: string;
  sceneType: string;
  ip: string;
  port: number;
  protocol?: "auto" | "tcp" | "websocket" | "kcp";
  audience?: "mixed" | "inner" | "outer";
}

export interface ProcessConfig {
  name: string;
  logging?: ProcessLoggingConfig;
  network?: ProcessNetworkConfig;
  game?: GameUpdateConfig;
  scheduling?: ProcessSchedulingConfig;
  lifecycle?: ProcessLifecycleConfig;
  observability?: ProcessObservabilityConfig;
}

export interface ProcessLifecycleConfig {
  stopTimeoutMs?: number;
}

export interface ProcessNetworkConfig {
  ioBackend?: "epoll" | "io-uring";
  uringEntries?: number;
  uringReadBufferBytes?: number;
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
  protocolSuccesses: number;
  businessErrors: number;
  systemErrors: number;
  decodeErrors: number;
  handlerNotFound: number;
  messageHandlerFailures: number;
  ingressQueueLength: number;
  maxIngressQueueLength: number;
  lastUpdateCostMs: number;
  lastHandlerCostMs: number;
  maxHandlerCostMs: number;
  totalHandlerCostMs: number;
  asyncInFlight: number;
  maxAsyncInFlight: number;
  latencies: LatencyMetricSnapshot[];
  customMetrics: CustomMetricSnapshot[];
}

export interface CustomMetricSnapshot {
  name: string;
  values: Readonly<Record<string, number>>;
  /** 未声明的字段按 gauge 导出；累计值必须显式声明为 counter。 / Undeclared fields are gauges; cumulative values must be marked as counters. */
  kinds?: Readonly<Record<string, CustomMetricKind>>;
}

export type CustomMetricKind = "counter" | "gauge";

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
    protocolSuccesses: 0,
    businessErrors: 0,
    systemErrors: 0,
    decodeErrors: 0,
    handlerNotFound: 0,
    messageHandlerFailures: 0,
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
  private lifecycleState: "created" | "started" | "ready" | "stopping" | "stopped" = "created";
  private stopPromise: Promise<void> | undefined;

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
      (message) => this.ctx.logger.error("protocol error", { detail: message }),
      latencyMetrics,
      (outcome) => this.recordProtocolOutcome(outcome),
    );
    this.actorRegistry = new ProtocolRegistry(
      (message) => this.ctx.logger.error("actor protocol error", { detail: message }),
      latencyMetrics,
      (outcome) => this.recordProtocolOutcome(outcome),
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

  get logger(): Logger {
    return this.ctx.logger;
  }

  /** 生成面向运维的启动摘要；子类可追加拓扑信息。 / Produces an operator-facing startup summary; subclasses may append topology details. */
  startupMessage(): string {
    return `[${this.self.name}] ${this.self.sceneType} scene started at ${this.self.ip}:${this.self.port}`;
  }

  /** 在 ready 前获取 Scene 资源；失败会中止进程启动。 / Acquires Scene resources before readiness; failure aborts process startup. */
  protected onStart(): MaybePromise<void> {}

  /** 所有本地 Scene start 完成后执行，此时才可使用跨 Scene 依赖。 / Runs after every local Scene started, so cross-Scene dependencies may now be used. */
  protected onReady(): MaybePromise<void> {}

  /** 刷新并释放 Scene 资源；必须幂等，且耗时受进程 stopTimeoutMs 限制。 / Flushes Scene resources; it must be idempotent and bounded by process stopTimeoutMs. */
  protected onStop(): MaybePromise<void> {}

  async __startLifecycle(): Promise<void> {
    if (this.lifecycleState !== "created") {
      throw new Error(`scene ${this.self.name} cannot start from ${this.lifecycleState}`);
    }
    await this.onStart();
    this.lifecycleState = "started";
  }

  async __readyLifecycle(): Promise<void> {
    if (this.lifecycleState !== "started") {
      throw new Error(`scene ${this.self.name} cannot become ready from ${this.lifecycleState}`);
    }
    await this.onReady();
    this.lifecycleState = "ready";
  }

  __stopLifecycle(): Promise<void> {
    this.stopPromise ??= this.stopLifecycle();
    return this.stopPromise;
  }

  private async stopLifecycle(): Promise<void> {
    if (this.lifecycleState === "stopped") return;
    if (this.lifecycleState === "created") {
      this.lifecycleState = "stopped";
      return;
    }
    this.lifecycleState = "stopping";
    try {
      await this.onStop();
    } finally {
      this.lifecycleState = "stopped";
    }
  }

  __disposeRuntime(): void {
    this.__dispose();
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

  /** 每次进程 Update 消费有界入站队列，并返回打包后的出站任务。 / Drains bounded ingress and returns packed outbound work once per process update. */
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

  /** 注册显式 Handler；生成的装饰器绑定会单独安装。 / Registers explicit handlers; generated decorator bindings are installed separately. */
  protected registerHandlers(): void {}

  /** 构造进程内唯一的子 Scene id，不向业务暴露分隔符约定。 / Builds a process-unique child Scene id without exposing the separator contract. */
  childSceneId(localId: string): string {
    return `${this.self.name}/${localId}`;
  }

  /** 在本 Scene mailbox 内处理断线；这里禁止无上限重试。 / Handles connection loss inside this Scene's mailbox; avoid unbounded retries here. */
  protected onDisconnect(_connectionId: number): MaybePromise<void> {}

  /** 请求宿主关闭连接；断线业务稍后仍通过 mailbox 执行。 / Requests host-side closure; disconnect business logic runs later through the mailbox. */
  protected disconnectClient(connectionId: number): void {
    if (!Number.isInteger(connectionId) || connectionId <= 0) {
      throw new Error(`invalid connection id: ${connectionId}`);
    }
    hostCloseConnection(connectionId);
  }

  /** 为一个客户端连接编码并入队一条 protobuf 消息。 / Encodes and queues one protobuf message for one client connection. */
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

  /** 只编码一次，再将不可变帧扇出到多个客户端连接。 / Encodes once and fans the immutable frame out to many client connections. */
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

  /** 将已编码帧入队；调用后不得再修改该帧。 / Queues an already encoded frame; callers must not mutate it after this call. */
  protected sendClientFrameMany(
    connectionIds: readonly number[],
    frame: Uint8Array,
  ): void {
    if (connectionIds.length === 0) return;
    this.outbound.push({
      connectionIdBytes: packConnectionIds(connectionIds),
      frame,
    });
  }

  /** 显式注册 RPC 路由；普通业务 Handler 优先使用装饰器。 / Registers an RPC route explicitly; decorators are preferred for ordinary handlers. */
  protected registerSceneRpc<TReq extends IRequest, TResp extends IResponse>(
    descriptor: RpcDescriptor<TReq, TResp>,
    target: SceneRef | ((request: TReq) => SceneRef),
    options: TargetRpcOptions<TReq, TResp> = {},
  ): void {
    this.registerTargetRpc(descriptor, target, options);
  }

  /** 为生成描述符和 Actor 类型注册 Actor RPC 转发。 / Registers Actor RPC forwarding for a generated descriptor and Actor type. */
  protected registerActorRpc<TReq extends IRequest, TResp extends IResponse>(
    descriptor: RpcDescriptor<TReq, TResp>,
    target: ActorRef | ((request: TReq) => ActorRef),
    options: TargetRpcOptions<TReq, TResp> = {},
  ): void {
    this.registerTargetRpc(descriptor, target, options);
  }

  /** 按正常 mailbox 与协议分发语义路由本地 call。 / Routes a local call through normal mailbox and protocol dispatch semantics. */
  dispatchLocalCall(frame: Uint8Array): Promise<Uint8Array> {
    const result = this.dispatchMailbox(() => this.handleFrame(frame));
    return Promise.resolve(result).then((response) => {
      if (!response) throw new Error(`scene ${this.self.name} returned no RPC response`);
      return response;
    });
  }

  /** 路由本地单向帧，不创建响应完成项。 / Routes a local one-way frame without creating a response completion. */
  dispatchLocalSend(frame: Uint8Array): Promise<void> {
    return Promise.resolve(this.dispatchMailbox(() => this.handleFrame(frame))).then(() => undefined);
  }

  /** 返回当前时点快照，不重置累计计数器。 / Returns a point-in-time snapshot without resetting cumulative counters. */
  metricsSnapshot(): SceneMetricsSnapshot {
    return {
      scene: this.self.name,
      sceneType: this.self.sceneType,
      processedFrames: this.metrics.processedFrames,
      failedFrames: this.metrics.failedFrames,
      protocolSuccesses: this.metrics.protocolSuccesses,
      businessErrors: this.metrics.businessErrors,
      systemErrors: this.metrics.systemErrors,
      decodeErrors: this.metrics.decodeErrors,
      handlerNotFound: this.metrics.handlerNotFound,
      messageHandlerFailures: this.metrics.messageHandlerFailures,
      ingressQueueLength: this.ingressLength,
      maxIngressQueueLength: this.metrics.maxIngressQueueLength,
      lastUpdateCostMs: this.metrics.lastUpdateCostMs,
      lastHandlerCostMs: this.metrics.lastHandlerCostMs,
      maxHandlerCostMs: this.metrics.maxHandlerCostMs,
      totalHandlerCostMs: this.metrics.totalHandlerCostMs,
      asyncInFlight: this.unorderedTasks.size,
      maxAsyncInFlight: this.metrics.maxAsyncInFlight,
      latencies: this.latencies.snapshot(),
      customMetrics: [],
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
            this.ctx.logger.error("ordered handler failed", { error });
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
              this.ctx.logger.error("unordered handler failed", { error });
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
        this.ctx.logger.error("unordered handler failed", { error });
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
            this.ctx.logger.error("disconnect handler failed", {
              connectionId: item.connectionId,
              error,
            });
          });
        }
      } catch (error) {
        this.ctx.logger.error("disconnect handler failed", {
          connectionId: item.connectionId,
          error,
        });
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
    const requestContext = context.logger
      ? context
      : { ...context, logger: this.logger };
    const startedAt = nowMs();
    const msgcode = this.latencies.enabled && frame.length >= 2
      ? readU16BE(frame, 0)
      : undefined;
    try {
      const response = this.routeOrHandleFrame(frame, requestContext);
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
          logger: context.logger,
        });
      } catch (error) {
        this.registry.reportSystemError(
          SystemErrCode.MalformedFrame,
          `invalid actor location envelope: ${errorText(error)}`,
          context,
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
        context,
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
          context,
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
          context,
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

  private recordProtocolOutcome(outcome: ProtocolOutcome): void {
    switch (outcome.kind) {
      case "success":
        this.metrics.protocolSuccesses += 1;
        return;
      case "business-error":
        this.metrics.businessErrors += 1;
        return;
      case "decode-error":
        this.metrics.decodeErrors += 1;
        break;
      case "handler-not-found":
        this.metrics.handlerNotFound += 1;
        break;
      case "message-handler-failed":
        this.metrics.messageHandlerFailures += 1;
        break;
      case "system-error":
        break;
    }
    this.metrics.systemErrors += 1;
    this.metrics.failedFrames += 1;
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

const hostCloseConnection = (globalThis as typeof globalThis & {
  __hostCloseConnection: (connectionId: number) => void;
}).__hostCloseConnection;

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
