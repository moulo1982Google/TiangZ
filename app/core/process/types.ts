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
import { Scene } from "../runtime/entities";
import { SceneContext } from "../runtime/contexts";
import { ProcessHost } from "../runtime/host";
import { Session, SessionComponent } from "../runtime/Session";
import { Unit } from "../runtime/Unit";
import type { GameUpdateConfig } from "../runtime/Game";
import { readU16BE } from "../protocol/binary";
import { SystemErrCode } from "../protocol/SystemErrCode";
import { RpcError } from "../protocol/RpcError";
import type { ActorAwakeArgs, ActorCtor } from "../runtime/types";
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
  getUnitMessageHandlerBindings,
  getUnitRpcHandlerBindings,
} from "./unitHandlers";
import {
  getSessionMessageHandlerBindings,
  getSessionRpcHandlerBindings,
} from "./sessionHandlers";
import type { ProcessLoggingConfig } from "../logging/types";
import type { Logger } from "../logging/Logger";

export interface SceneConfig {
  name: string;
  sceneType: string;
  ip: string;
  port: number;
  protocol?: "auto" | "tcp" | "websocket" | "kcp";
  audience?: "mixed" | "inner" | "outer";
  /** MapHost启动时创建的静态地图配置ID；动态副本由业务管理器运行时创建。 / Static map configs created at MapHost startup; business managers create dynamic instances at runtime. */
  staticMapIds?: number[];
}

export interface ProcessConfig {
  name: string;
  identity?: ProcessIdentityConfig;
  logging?: ProcessLoggingConfig;
  network?: ProcessNetworkConfig;
  game?: GameUpdateConfig;
  scheduling?: ProcessSchedulingConfig;
  lifecycle?: ProcessLifecycleConfig;
  observability?: ProcessObservabilityConfig;
}

export interface ProcessIdentityConfig {
  /** 永久来源服编号；不同可合服区服不得重复。 / Immutable origin-server number unique across mergeable servers. */
  originServerId?: number;
  /** 同一来源服内生成持久 ID 的 Process 编号。 / Persistent-ID worker number inside one origin server. */
  workerId?: number;
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

interface QueuedActorFrame {
  readonly frame: Uint8Array;
  readonly context: ProtocolContext;
  readonly msgcode: number;
  readonly rpcDescriptor?: AnyRpcDescriptor;
  resolve?: (value: Uint8Array | undefined) => void;
}

interface ActorTransferBuffer {
  readonly frames: QueuedActorFrame[];
  bytes: number;
  readonly expiresAtMs: number;
  expired: boolean;
}

export abstract class EntryScene extends Scene {
  private static readonly MAX_UNORDERED_IN_FLIGHT = 4096;
  private static readonly MAX_TRANSFER_FRAMES_PER_CONNECTION = 64;
  private static readonly MAX_TRANSFER_BYTES_PER_CONNECTION = 256 * 1024;
  private static readonly MAX_TRANSFER_WAIT_MS = 3_000;
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
  private readonly actorTransferBuffers = new Map<number, ActorTransferBuffer>();
  private readonly actorTransferMetrics = {
    started: 0,
    completed: 0,
    cancelled: 0,
    timedOut: 0,
    enqueued: 0,
    rejected: 0,
    dropped: 0,
    overloaded: 0,
  };
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
  private sessionComponent: SessionComponent | undefined;

  constructor(
    protected readonly config: RuntimeEntrySceneConfig,
    knownRpcs: readonly AnyRpcDescriptor[] = getKnownRpcDescriptors(),
    knownMessages: readonly AnyMessageDescriptor[] = getKnownMessageDescriptors(),
  ) {
    super(new SceneContext(config.processHost, {
      processId: config.process.name,
      sceneId: config.self.name,
      sceneType: config.self.sceneType,
    }));
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
  }

  /** Scene 挂入 ProcessHost 后注册协议；禁止在构造期间调用，以免子类字段尚未初始化。 / Registers protocols after ProcessHost attachment; never call during construction before subclass fields initialize. */
  __initializeRuntime(): void {
    const hasSessionHandlers =
      getSessionRpcHandlerBindings(this.constructor).length > 0 ||
      getSessionMessageHandlerBindings(this.constructor).length > 0;
    if (hasSessionHandlers) {
      this.sessionComponent = this.AddComponent(SessionComponent);
    }
    this.registerDecoratedRpcHandlers();
    this.registerDecoratedMessageHandlers();
    this.registerExternalRpcHandlers();
    this.registerExternalMessageHandlers();
    this.registerSessionRpcHandlers();
    this.registerSessionMessageHandlers();
    this.registerUnitRpcHandlers();
    this.registerUnitMessageHandlers();
    this.registerHandlers();
  }

  /** 返回配置要求的 Mailbox 类型，由 ProcessHost 创建唯一 MailBoxComponent。 / Returns the configured mailbox type used by ProcessHost to create the sole MailBoxComponent. */
  __mailboxType(): SceneMailboxType {
    return this.mailbox;
  }

  /** 首次收到 Session Handler 消息时创建连接实体；有额外状态的 Scene 可覆盖 Session 类型。 / Creates the connection entity on its first Session-handler message; Scenes with stateful sessions may override its type. */
  protected createSession(connectionId: number): Session<any[]> {
    return this.addSession(connectionId, Session);
  }

  /** 供有状态连接类型复用 Core 的创建与索引事务；业务不要直接调用 ProcessHost。 / Lets stateful connection types reuse Core's create/index transaction; business code must not call ProcessHost directly. */
  protected addSession<T extends Session<any[]>>(
    connectionId: number,
    ctor: ActorCtor<T>,
    ...awakeArgs: ActorAwakeArgs<T>
  ): T {
    return this.requireSessionComponent().Create(connectionId, ctor, ...awakeArgs);
  }

  /** 查询已存在的连接 Session；不会因普通 Scene 消息而隐式创建。 / Finds an existing connection Session without creating one for ordinary Scene messages. */
  protected getSession<T extends Session<any[]> = Session<any[]>>(
    connectionId: number,
  ): T | undefined {
    return this.requireSessionComponent().Get<T>(connectionId);
  }

  /** 返回当前连接 Session 的稳定快照，遍历期间允许断线移除。 / Returns a stable Session snapshot so disconnects may remove entries during iteration. */
  protected getSessions<T extends Session<any[]> = Session<any[]>>(): readonly T[] {
    return this.requireSessionComponent().GetAll<T>();
  }

  private getOrCreateSession(connectionId: number): Session<any[]> {
    return this.getSession(connectionId) ?? this.createSession(connectionId);
  }

  private requireSessionComponent(): SessionComponent {
    if (!this.sessionComponent) {
      throw new Error(`scene ${this.self.name} SessionComponent is not initialized`);
    }
    return this.sessionComponent;
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

  /**
   * 客户端帧进入本 Scene mailbox 时触发；连接域可在这里记录入站活跃时间。
   * 该钩子发生在协议解析前，不应执行 I/O、业务分发或可能抛错的校验。
   *
   * Invoked when a client frame enters this Scene mailbox. Connection domains
   * may record inbound activity here. It runs before protocol decoding and must
   * not perform I/O, business dispatch, or validation that may throw.
   */
  protected onClientReceive(_connectionId: number): void {}

  /**
   * 在业务Handler和Session mailbox之前消费极轻量的连接控制帧。
   * 返回true时该帧不会进入协议Registry；实现只能做O(1)连接状态更新，禁止业务逻辑、异步调用或响应编码。
   * 该入口用于心跳等必须在长业务RPC等待期间继续生效的控制消息，普通消息必须返回false。
   *
   * Consumes lightweight connection-control frames before business handlers and session mailboxes.
   * Returning true bypasses the protocol registry. Implementations must remain O(1) and synchronous,
   * with no business work, async calls, or response encoding. Ordinary frames must return false.
   */
  protected consumeClientControlFrame(
    _connectionId: number,
    _frame: Uint8Array,
  ): boolean {
    return false;
  }

  /**
   * 客户端帧写入宿主出站队列时触发；它表示“已排队”，不表示网络写入成功。
   * 该时间只适合可观测性，不得用于延长客户端存活期限。
   *
   * Invoked when client frames enter the host outbound queue. It means queued,
   * not successfully written to the network, and must never extend liveness.
   */
  protected onClientSendQueued(_connectionIds: readonly number[]): void {}

  /** 导出Gate迁移屏障的有界队列和累计结果，不包含连接ID等高基数标签。 / Exports bounded Gate transfer queues and cumulative outcomes without high-cardinality connection labels. */
  protected actorTransferMetricSnapshot(): CustomMetricSnapshot {
    let queuedFrames = 0;
    let queuedBytes = 0;
    for (const buffer of this.actorTransferBuffers.values()) {
      queuedFrames += buffer.frames.length;
      queuedBytes += buffer.bytes;
    }
    return {
      name: "actor_transfer_barrier",
      values: {
        active: this.actorTransferBuffers.size,
        queued_frames: queuedFrames,
        queued_bytes: queuedBytes,
        started_total: this.actorTransferMetrics.started,
        completed_total: this.actorTransferMetrics.completed,
        cancelled_total: this.actorTransferMetrics.cancelled,
        timed_out_total: this.actorTransferMetrics.timedOut,
        enqueued_total: this.actorTransferMetrics.enqueued,
        rejected_total: this.actorTransferMetrics.rejected,
        dropped_total: this.actorTransferMetrics.dropped,
        overloaded_total: this.actorTransferMetrics.overloaded,
      },
      kinds: {
        started_total: "counter",
        completed_total: "counter",
        cancelled_total: "counter",
        timed_out_total: "counter",
        enqueued_total: "counter",
        rejected_total: "counter",
        dropped_total: "counter",
        overloaded_total: "counter",
      },
    };
  }

  /**
   * 在Actor迁移前建立Gate侧投递屏障；重复调用不会清空已排队消息。
   * 只有连接入口Scene应调用它，Location和Map不得持有客户端原始帧。
   *
   * Opens a Gate-side delivery barrier before Actor migration. Repeated calls
   * retain queued frames. Only connection-entry Scenes may invoke it; Location
   * and Map must never own raw client frames.
   */
  protected beginActorTransfer(connectionId: number): void {
    if (!this.actorTransferBuffers.has(connectionId)) {
      this.actorTransferBuffers.set(connectionId, {
        frames: [],
        bytes: 0,
        expiresAtMs: nowMs() + EntryScene.MAX_TRANSFER_WAIT_MS,
        expired: false,
      });
      this.actorTransferMetrics.started += 1;
    }
  }

  /**
   * 在Gate绑定新Actor后按原到达顺序释放队列。
   * RPC继续使用原rpcId；单向消息失败只记录日志，不能伪造Response。
   *
   * Releases queued frames in arrival order after Gate binds the new Actor.
   * RPCs keep their original rpcId; one-way failures are logged without fake responses.
   */
  protected finishActorTransfer(connectionId: number): void {
    const buffer = this.actorTransferBuffers.get(connectionId);
    if (!buffer) return;
    this.actorTransferBuffers.delete(connectionId);
    this.actorTransferMetrics.completed += 1;
    for (const item of buffer.frames) {
      const result = this.dispatchActorLocationFrame(
        connectionId,
        item.frame,
        item.context,
        item.rpcDescriptor,
      );
      if (item.resolve) {
        Promise.resolve(result).then(item.resolve, (error) => {
          item.resolve?.(this.registry.routingErrorResponse(
            item.frame,
            error instanceof RpcError ? error.code : SystemErrCode.SceneCallFailed,
            `queued actor call failed: ${errorText(error)}`,
            item.context,
          ));
        });
      } else if (isPromiseLike(result)) {
        void Promise.resolve(result).catch((error) => {
          this.ctx.logger.error("queued actor message failed", {
            connectionId,
            msgcode: item.msgcode,
            error,
          });
        });
      }
    }
  }

  /** 连接关闭时拒绝未执行RPC并丢弃单向消息，避免悬挂Promise。 / Rejects unexecuted RPCs and drops one-way messages when the connection closes. */
  protected cancelActorTransfer(connectionId: number): void {
    const buffer = this.actorTransferBuffers.get(connectionId);
    if (!buffer) return;
    this.actorTransferBuffers.delete(connectionId);
    this.actorTransferMetrics.cancelled += 1;
    for (const item of buffer.frames) {
      item.resolve?.(this.registry.routingErrorResponse(
        item.frame,
        SystemErrCode.SessionNotFound,
        "client disconnected during actor transfer",
        item.context,
      ));
    }
  }

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
    this.expireActorTransfers(nowMs());
    const startedAt = nowMs();
    if (this.mailbox === "unordered") this.drainUnordered(maxFrames);
    else this.drainOrdered(maxFrames);
    return startedAt;
  }

  __completeUpdate(startedAt: number, includeMetrics = true): SceneUpdateResult {
    return this.completeUpdate(startedAt, includeMetrics);
  }

  /** 返回本 Scene 是否已排空到可原子切换 Hotfix 的状态。 / Reports whether this Scene is fully drained for an atomic Hotfix switch. */
  __canCommitHotfix(): boolean {
    return this.ingressLength === 0 &&
      this.unorderedTasks.size === 0 &&
      this.orderedTask === undefined &&
      !this.mailboxBusy &&
      this.mailboxTasks.length === 0;
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
    this.onClientSendQueued([connectionId]);
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
    this.onClientSendQueued(connectionIds);
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
    this.onClientSendQueued(connectionIds);
    this.outbound.push({
      connectionIdBytes: packConnectionIds(connectionIds),
      frame,
    });
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
      this.cancelActorTransfer(item.connectionId);
      try {
        const result = this.onDisconnect(item.connectionId);
        if (isPromiseLike(result)) {
          return Promise.resolve(result)
            .catch((error) => {
              this.ctx.logger.error("disconnect handler failed", {
                connectionId: item.connectionId,
                error,
              });
            })
            .finally(() => {
              this.sessionComponent?.Remove(item.connectionId);
            });
        }
      } catch (error) {
        this.ctx.logger.error("disconnect handler failed", {
          connectionId: item.connectionId,
          error,
        });
      }
      this.sessionComponent?.Remove(item.connectionId);
      return;
    }

    this.onClientReceive(item.connectionId);
    if (this.consumeClientControlFrame(item.connectionId, item.frame)) return;
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
    this.onClientSendQueued([connectionId]);
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

    const transfer = this.actorTransferBuffers.get(context.connectionId);
    if (transfer) {
      if (transfer.expired) {
        if (rpcDescriptor) this.actorTransferMetrics.rejected += 1;
        else this.actorTransferMetrics.dropped += 1;
        return rpcDescriptor
          ? this.registry.routingErrorResponse(
            frame,
            SystemErrCode.ActorTransferring,
            "actor transfer barrier timed out",
            context,
          )
          : undefined;
      }
      const policy = rpcDescriptor?.duringTransfer ??
        messageDescriptor?.duringTransfer ??
        (rpcDescriptor ? "reject" : "drop");
      if (policy === "reject" || (rpcDescriptor && (policy === "drop" || policy === "latest"))) {
        this.actorTransferMetrics.rejected += 1;
        return this.registry.routingErrorResponse(
          frame,
          SystemErrCode.ActorTransferring,
          "actor is transferring",
          context,
        );
      }
      if (policy === "drop") {
        this.actorTransferMetrics.dropped += 1;
        return undefined;
      }
      if (policy === "latest") {
        const index = transfer.frames.findIndex(
          (item) => item.msgcode === msgcode && item.resolve === undefined,
        );
        const queued: QueuedActorFrame = { frame, context, msgcode };
        if (index >= 0) {
          const nextBytes = transfer.bytes + frame.byteLength - transfer.frames[index].frame.byteLength;
          if (nextBytes > EntryScene.MAX_TRANSFER_BYTES_PER_CONNECTION) {
            this.actorTransferMetrics.overloaded += 1;
            this.registry.reportSystemError(
              SystemErrCode.SceneOverloaded,
              `actor transfer queue is full for connection ${context.connectionId}`,
              context,
            );
          } else {
            transfer.bytes = nextBytes;
            transfer.frames[index] = queued;
            this.actorTransferMetrics.enqueued += 1;
          }
        } else if (!this.tryReserveTransferFrame(transfer, frame.byteLength)) {
          this.actorTransferMetrics.overloaded += 1;
          this.registry.reportSystemError(
            SystemErrCode.SceneOverloaded,
            `actor transfer queue is full for connection ${context.connectionId}`,
            context,
          );
        } else {
          transfer.frames.push(queued);
          this.actorTransferMetrics.enqueued += 1;
        }
        return undefined;
      }
      if (!this.tryReserveTransferFrame(transfer, frame.byteLength)) {
        this.actorTransferMetrics.overloaded += 1;
        return this.registry.routingErrorResponse(
          frame,
          SystemErrCode.SceneOverloaded,
          "actor transfer queue is full",
          context,
        );
      }
      if (!rpcDescriptor) {
        transfer.frames.push({ frame, context, msgcode });
        this.actorTransferMetrics.enqueued += 1;
        return undefined;
      }
      return new Promise<Uint8Array | undefined>((resolve) => {
        transfer.frames.push({ frame, context, msgcode, rpcDescriptor, resolve });
        this.actorTransferMetrics.enqueued += 1;
      });
    }

    return this.dispatchActorLocationFrame(
      context.connectionId,
      frame,
      context,
      rpcDescriptor,
    );
  }

  private dispatchActorLocationFrame(
    connectionId: number,
    frame: Uint8Array,
    context: ProtocolContext,
    rpcDescriptor?: AnyRpcDescriptor,
  ): MaybePromise<Uint8Array | undefined> {
    const target = this.actorLocations.resolveConnection(connectionId);
    if (!target) {
      return this.registry.routingErrorResponse(
        frame,
        SystemErrCode.ActorLocationNotFound,
        `actor location is not bound for connection ${connectionId}`,
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

  private tryReserveTransferFrame(buffer: ActorTransferBuffer, bytes: number): boolean {
    if (
      buffer.frames.length >= EntryScene.MAX_TRANSFER_FRAMES_PER_CONNECTION ||
      buffer.bytes + bytes > EntryScene.MAX_TRANSFER_BYTES_PER_CONNECTION
    ) {
      return false;
    }
    buffer.bytes += bytes;
    return true;
  }

  private expireActorTransfers(currentTimeMs: number): void {
    for (const [connectionId, buffer] of this.actorTransferBuffers) {
      if (buffer.expired || currentTimeMs < buffer.expiresAtMs) continue;
      buffer.expired = true;
      this.actorTransferMetrics.timedOut += 1;
      for (const item of buffer.frames.splice(0)) {
        if (item.resolve) this.actorTransferMetrics.rejected += 1;
        else this.actorTransferMetrics.dropped += 1;
        item.resolve?.(this.registry.routingErrorResponse(
          item.frame,
          SystemErrCode.ActorTransferring,
          "actor transfer barrier timed out",
          item.context,
        ));
      }
      buffer.bytes = 0;
      this.ctx.logger.error("actor transfer barrier timed out", { connectionId });
    }
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
        handle: (request, context) => {
          const current = (this as unknown as Record<string, unknown>)[binding.method];
          if (typeof current !== "function") {
            throw new Error(`RPC handler is not a function: ${descriptor.name}`);
          }
          return current.call(this, request, context);
        },
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
        handle: (message, context) => {
          const current = (this as unknown as Record<string, unknown>)[binding.method];
          if (typeof current !== "function") {
            throw new Error(`Message handler is not a function: ${descriptor.name}`);
          }
          return current.call(this, message, context);
        },
      });
    }
  }

  private registerExternalRpcHandlers(): void {
    for (const binding of getSceneRpcHandlerBindings(this.constructor)) {
      let handlerCtor = binding.handlerCtor;
      let handler = new handlerCtor();
      const currentHandler = () => {
        if (handlerCtor !== binding.handlerCtor) {
          handlerCtor = binding.handlerCtor;
          handler = new handlerCtor();
        }
        return handler;
      };
      this.claimRpcHandler(binding.descriptor.requestCode, binding.handlerCtor.name);
      this.registry.register(binding.descriptor.requestCode, {
        responseCode: binding.descriptor.responseCode,
        decode: binding.descriptor.requestCodec.decode,
        encode: binding.descriptor.responseCodec.encode,
        handle: (request, context) => currentHandler().handle(this, request, context),
      });
    }
  }

  private registerExternalMessageHandlers(): void {
    for (const binding of getSceneMessageHandlerBindings(this.constructor)) {
      let handlerCtor = binding.handlerCtor;
      let handler = new handlerCtor();
      const currentHandler = () => {
        if (handlerCtor !== binding.handlerCtor) {
          handlerCtor = binding.handlerCtor;
          handler = new handlerCtor();
        }
        return handler;
      };
      this.claimMessageHandler(binding.descriptor.msgcode, binding.handlerCtor.name);
      this.registry.registerMessage(binding.descriptor.msgcode, {
        decode: binding.descriptor.codec.decode,
        handle: (message, context) => currentHandler().handle(this, message, context),
      });
    }
  }

  private registerSessionRpcHandlers(): void {
    for (const binding of getSessionRpcHandlerBindings(this.constructor)) {
      let handlerCtor = binding.handlerCtor;
      let handler = new handlerCtor();
      const currentHandler = () => {
        if (handlerCtor !== binding.handlerCtor) {
          handlerCtor = binding.handlerCtor;
          handler = new handlerCtor();
        }
        return handler;
      };
      this.claimRpcHandler(binding.descriptor.requestCode, binding.handlerCtor.name);
      this.registry.register(binding.descriptor.requestCode, {
        responseCode: binding.descriptor.responseCode,
        decode: binding.descriptor.requestCodec.decode,
        encode: binding.descriptor.responseCodec.encode,
        handle: (request, context) => {
          const connectionId = context.connectionId;
          if (connectionId === undefined) {
            throw new RpcError(
              SystemErrCode.SessionNotFound,
              `Session RPC requires a client connection: ${binding.descriptor.name}`,
            );
          }
          const session = this.getOrCreateSession(connectionId);
          return this.processHost.runActorMailbox(session.InstanceId, (target) =>
            currentHandler().handle(this, target as Session<any[]>, request, context)
          );
        },
      });
    }
  }

  private registerSessionMessageHandlers(): void {
    for (const binding of getSessionMessageHandlerBindings(this.constructor)) {
      let handlerCtor = binding.handlerCtor;
      let handler = new handlerCtor();
      const currentHandler = () => {
        if (handlerCtor !== binding.handlerCtor) {
          handlerCtor = binding.handlerCtor;
          handler = new handlerCtor();
        }
        return handler;
      };
      this.claimMessageHandler(binding.descriptor.msgcode, binding.handlerCtor.name);
      this.registry.registerMessage(binding.descriptor.msgcode, {
        decode: binding.descriptor.codec.decode,
        handle: (message, context) => {
          const connectionId = context.connectionId;
          if (connectionId === undefined) {
            throw new RpcError(
              SystemErrCode.SessionNotFound,
              `Session message requires a client connection: ${binding.descriptor.name}`,
            );
          }
          const session = this.getOrCreateSession(connectionId);
          return this.processHost.runActorMailbox(session.InstanceId, (target) =>
            currentHandler().handle(this, target as Session<any[]>, message, context)
          );
        },
      });
    }
  }

  private registerUnitRpcHandlers(): void {
    const grouped = groupByCode(
      getUnitRpcHandlerBindings(),
      (binding) => binding.descriptor.requestCode,
    );
    for (const [msgcode, bindings] of grouped) {
      const descriptor = bindings[0].descriptor;
      const handlers = bindings.map((binding) => ({
        binding,
        handlerCtor: binding.handlerCtor,
        handler: new binding.handlerCtor(),
      }));
      const handlerByUnitCtor = new Map<Function, (typeof handlers)[number]>();
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
            const unitCtor = actor.constructor;
            let binding = handlerByUnitCtor.get(unitCtor);
            if (!binding) {
              binding = handlers.find((item) => actor instanceof item.binding.unitCtor);
              if (binding) handlerByUnitCtor.set(unitCtor, binding);
            }
            if (!binding) {
              throw new RpcError(
                SystemErrCode.HandlerNotFound,
                `Unit RPC handler not found: ${actor.constructor.name} msgcode ${msgcode}`,
              );
            }
            if (binding.handlerCtor !== binding.binding.handlerCtor) {
              binding.handlerCtor = binding.binding.handlerCtor;
              binding.handler = new binding.handlerCtor();
            }
            return binding.handler.handle(actor as Unit<any[]>, request, context);
          });
        },
      });
    }
  }

  private registerUnitMessageHandlers(): void {
    const grouped = groupByCode(
      getUnitMessageHandlerBindings(),
      (binding) => binding.descriptor.msgcode,
    );
    for (const [msgcode, bindings] of grouped) {
      const descriptor = bindings[0].descriptor;
      const handlers = bindings.map((binding) => ({
        binding,
        handlerCtor: binding.handlerCtor,
        handler: new binding.handlerCtor(),
      }));
      const handlerByUnitCtor = new Map<Function, (typeof handlers)[number]>();
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
            const unitCtor = actor.constructor;
            let binding = handlerByUnitCtor.get(unitCtor);
            if (!binding) {
              binding = handlers.find((item) => actor instanceof item.binding.unitCtor);
              if (binding) handlerByUnitCtor.set(unitCtor, binding);
            }
            if (!binding) {
              throw new RpcError(
                SystemErrCode.HandlerNotFound,
                `Unit message handler not found: ${actor.constructor.name} msgcode ${msgcode}`,
              );
            }
            if (binding.handlerCtor !== binding.binding.handlerCtor) {
              binding.handlerCtor = binding.binding.handlerCtor;
              binding.handler = new binding.handlerCtor();
            }
            return binding.handler.handle(actor as Unit<any[]>, message, context);
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
