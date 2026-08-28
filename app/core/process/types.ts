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
import { Scene, type ActorRuntimeEntity } from "../runtime/entities";
import { SceneContext } from "../runtime/contexts";
import { ProcessHost } from "../runtime/host";
import { Session, SessionComponent } from "../runtime/Session";
import { ActorUnit, Unit } from "../runtime/Unit";
import type { GameUpdateConfig } from "../runtime/Game";
import { readU16BE } from "../protocol/binary";
import { SystemErrCode } from "../protocol/SystemErrCode";
import { RpcError } from "../protocol/RpcError";
import type {
  ActorAwakeArgs,
  ActorCtor,
  SceneCtor,
} from "../runtime/types";
import {
  LatencyRecorder,
  nowMs,
  type LatencyMetricSnapshot,
  type LatencyRecorderOptions,
} from "../metrics/latency";
import { SceneCallContext } from "./context";
import { decodeTraceEnvelope, TraceEnvelopeMsgCode } from "./TraceEnvelope";
import { RunWithTraceContext } from "../telemetry/TraceContext";
import { SceneMessageHelper } from "./SceneMessageHelper";
import {
  type ActorLocationTarget,
  ActorLocationDirectory,
  ActorLocationBatchEnvelopeMsgCode,
  ActorLocationEnvelopeMsgCode,
  encodeActorLocationBatchEnvelope,
  encodeActorLocationEnvelope,
  decodeActorLocationEnvelope,
  forEachActorLocationBatchEntry,
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
  /** 服务间通信地址；旧 JSON 的 ip 字段由 Rust 兼容转换为 innerIp。 / Internal route address; Rust maps legacy JSON ip to innerIp. */
  innerIp: string;
  /** 本地监听地址；省略时由 Runtime 回退到 innerIp。 / Local listener address; Runtime falls back to innerIp when omitted. */
  bindIp?: string;
  /** 客户端连接地址；只用于 LoginMgr/Login/Gate 返回外网入口。 / Client-facing address used only by outer login endpoints. */
  outerIp?: string;
  /** 客户端连接端口；省略时回退到 port。 / Client-facing port; falls back to port when omitted. */
  outerPort?: number;
  port: number;
  protocol?: "auto" | "tcp" | "websocket" | "kcp";
  audience?: "mixed" | "inner" | "outer";
  /** MapHost启动时创建的静态地图配置ID；动态副本由业务管理器运行时创建。 / Static map configs created at MapHost startup; business managers create dynamic instances at runtime. */
  staticMapIds?: number[];
  /** 是否接受MapManager分配的动态地图；false时仅承载staticMapIds。 / Whether this MapHost accepts dynamic instances assigned by MapManager. */
  acceptDynamicMaps?: boolean;
}

/**
 * Rust宿主传给业务V8的只读配置投影，只包含TS业务会消费的字段。
 * 监听、健康检查、Hotfix超时和宿主队列等字段由Rust独占，不应为了与JSON逐字段
 * 对称而暴露给业务；完整启动契约以`src/config.rs`和配置Schema为准。
 *
 * Read-only process configuration projected by the Rust host into the business
 * V8. Host-only listener, health, Hotfix timeout, and queue fields are omitted
 * intentionally; `src/config.rs` and the config schema own the full startup contract.
 */
export interface ProcessConfig {
  name: string;
  identity?: ProcessIdentityConfig;
  logging?: ProcessLoggingConfig;
  network?: ProcessNetworkConfig;
  game?: GameUpdateConfig;
  scheduling?: ProcessSchedulingConfig;
  lifecycle?: ProcessLifecycleConfig;
  persistence?: ProcessPersistenceConfig;
  observability?: ProcessObservabilityConfig;
}

export interface ProcessPersistenceConfig {
  /** 省略时业务继续使用自己选择的非DBProxy Repository。 / When omitted, business keeps using its selected non-DBProxy Repository. */
  dbProxy?: ProcessDbProxyConfig;
}

export interface ProcessDbProxyConfig {
  /** DBProxy监听地址，例如127.0.0.1:7800。 / DBProxy listener endpoint, for example 127.0.0.1:7800. */
  endpoint: string;
  /** 只填写令牌环境变量名，绝不能把令牌值写入JSON。 / Names the token environment variable; never put the token value in JSON. */
  authTokenEnv?: string;
  clientPoolSize?: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
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
  idleTickMs?: number | null;
  maxEventsPerUpdate?: number | null;
  coalesceMicros?: number | null;
}

export interface ProcessObservabilityConfig {
  latency?: LatencyRecorderOptions;
  nativeData?: ProcessNativeDataObservabilityConfig;
  tracing?: ProcessTracingObservabilityConfig;
}

export interface ProcessTracingObservabilityConfig {
  enabled?: boolean;
  sampleRate?: number;
  otlpEndpoint?: string;
}

export interface ProcessNativeDataObservabilityConfig {
  debugScalarAccess?: boolean;
  scalarAccessWarnThreshold?: number;
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
  sendLocalScene(sourceName: string, targetName: string, frame: Uint8Array): MaybePromise<void>;
}

export interface OutboundBatch {
  connectionIdBytes: Uint8Array;
  frame: Uint8Array;
}

type ClientFrameDelivery = "reliable" | "latest";

export interface SceneUpdateResult {
  outbound: OutboundBatch[];
  metrics?: SceneMetricsSnapshot;
  pendingAsync: boolean;
  pendingIngress: boolean;
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
  lastIngressPumpFrames: number;
  lastIngressPumpCostMs: number;
  lastUpdateCostMs: number;
  lastHandlerCostMs: number;
  maxHandlerCostMs: number;
  totalHandlerCostMs: number;
  asyncInFlight: number;
  maxAsyncInFlight: number;
  mailbox: MailboxMetricsSnapshot;
  latencies: LatencyMetricSnapshot[];
  customMetrics: CustomMetricSnapshot[];
}

export interface MailboxMetricsSnapshot {
  readonly fastPathCalls: number;
  readonly queuedCalls: number;
  readonly asyncCalls: number;
  readonly oneWayFastPathCalls: number;
  readonly oneWayQueuedCalls: number;
  readonly oneWayAsyncCalls: number;
  readonly queuedDepth: number;
  readonly maxQueuedDepth: number;
}

export interface CustomMetricSnapshot {
  name: string;
  /**
   * 仅用于区分同一场景内有限数量的指标实例；禁止放入账号、Unit、连接或动态实例 ID。
   * Distinguishes a bounded number of metric instances within one scene. Never use
   * account, unit, connection, or unbounded dynamic-instance IDs here.
   */
  labels?: Readonly<Record<string, string>>;
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
  run?: () => MaybePromise<T>;
  resolve?: (value: T | PromiseLike<T>) => void;
  reject?: (reason?: unknown) => void;
  oneWay?: boolean;
}

interface QueuedActorFrame {
  readonly frame: Uint8Array;
  readonly context: ProtocolContext;
  readonly msgcode: number;
  readonly rpcDescriptor?: AnyRpcDescriptor;
  readonly messageDescriptor?: AnyMessageDescriptor;
  resolve?: (value: Uint8Array | undefined) => void;
}

interface ActorTransferBuffer {
  readonly frames: QueuedActorFrame[];
  bytes: number;
  readonly expiresAtMs: number;
  expired: boolean;
}

interface PendingLatestActorLocationFrame {
  target: SceneConfig;
  instanceId: number;
  fenceToken?: bigint;
  frame: Uint8Array;
}

export abstract class EntryScene extends Scene {
  private static readonly MAX_UNORDERED_IN_FLIGHT = 4096;
  private static readonly MAX_CONSECUTIVE_DATA_INGRESS = 8;
  private static readonly MAX_TRANSFER_FRAMES_PER_CONNECTION = 64;
  private static readonly MAX_TRANSFER_BYTES_PER_CONNECTION = 256 * 1024;
  private static readonly MAX_TRANSFER_WAIT_MS = 3_000;
  private static readonly LATEST_ACTOR_FORWARD_WINDOW_MS = 20;
  private static readonly DISCONNECTED_FRAME_TOMBSTONE_MS = 30_000;
  private static readonly MAX_DISCONNECTED_FRAME_TOMBSTONES = 65_536;
  protected readonly registry: ProtocolRegistry;
  private readonly actorRegistry: ProtocolRegistry;
  protected readonly ctx: SceneCallContext;
  readonly scenes: SceneMessageHelper;
  private readonly processHost: ProcessHost;
  protected readonly actorLocations = new ActorLocationDirectory();
  protected readonly mailbox: SceneMailboxType = "ordered";
  private readonly controlIngress: QueuedEvent[] = [];
  private controlIngressHead = 0;
  private readonly dataIngress: QueuedEvent[] = [];
  private dataIngressHead = 0;
  private consecutiveDataIngress = 0;
  private readonly outboundControl: OutboundBatch[] = [];
  private readonly outboundReliable: OutboundBatch[] = [];
  private readonly outboundLatest: OutboundBatch[] = [];
  private outboundReliableEnqueued = 0;
  private outboundLatestEnqueued = 0;
  private readonly outboundLaneDepths = {
    control: 0,
    reliable: 0,
    latest: 0,
    total: 0,
    maxControl: 0,
    maxReliable: 0,
    maxLatest: 0,
    maxTotal: 0,
  };
  private mailboxTaskHead = 0;
  private readonly recycledMailboxTasks: MailboxTask[] = [];
  private readonly mailboxMetrics = {
    fastPathCalls: 0,
    queuedCalls: 0,
    asyncCalls: 0,
    oneWayFastPathCalls: 0,
    oneWayQueuedCalls: 0,
    oneWayAsyncCalls: 0,
    queuedDepth: 0,
    maxQueuedDepth: 0,
  };
  private readonly connectionIdBytes = new Map<number, Uint8Array>();
  private readonly disconnectedFrameTombstones = new Map<number, number>();
  private droppedFramesAfterDisconnect = 0;
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
  private readonly latestActorLocationFrames = new Map<
    number,
    Map<number, PendingLatestActorLocationFrame>
  >();
  private latestActorLocationFrameCount = 0;
  private actorLocationFenceRejections = 0;
  private latestActorLocationFlushAtMs: number | undefined;
  private readonly latestActorLocationMetrics = {
    queued: 0,
    coalesced: 0,
    forwarded: 0,
    batches: 0,
    failedBatches: 0,
    failedFrames: 0,
    dropped: 0,
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
    lastIngressPumpFrames: 0,
    lastIngressPumpCostMs: 0,
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
    return `[${this.self.name}] ${this.self.sceneType} scene started at ${this.self.bindIp ?? this.self.innerIp}:${this.self.port}`;
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
   * Returning true bypasses the protocol registry. Implementations must remain O(1)
   * and synchronous, with no business work, async calls, or response encoding.
   * Ordinary frames must return false.
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

  /**
   * 可覆盖状态进入宿主出站队列时触发；默认不做逐连接观测，避免高频状态扇出重复访问会话表。
   * 需要观测 latest 流量时应维护聚合计数，不能在这里执行逐连接业务逻辑。
   *
   * Invoked for replaceable state queued to the host. The default avoids
   * per-connection bookkeeping on high-frequency fan-out. Overrides should
   * maintain aggregate counters rather than perform per-connection business work.
   */
  protected onClientLatestFrameQueued(_connectionIds: readonly number[]): void {}

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

  /** 导出可覆盖Actor转发的聚合效果和失败数；不包含连接或Actor高基数标签。 / Exports replaceable Actor-forwarding aggregation and failures without connection or Actor labels. */
  protected actorLatestForwardMetricSnapshot(): CustomMetricSnapshot {
    return {
      name: "actor_latest_forward",
      values: {
        pending_frames: this.latestActorLocationFrameCount,
        queued_total: this.latestActorLocationMetrics.queued,
        coalesced_total: this.latestActorLocationMetrics.coalesced,
        forwarded_total: this.latestActorLocationMetrics.forwarded,
        batches_total: this.latestActorLocationMetrics.batches,
        failed_batches_total: this.latestActorLocationMetrics.failedBatches,
        failed_frames_total: this.latestActorLocationMetrics.failedFrames,
        dropped_total: this.latestActorLocationMetrics.dropped,
      },
      kinds: {
        queued_total: "counter",
        coalesced_total: "counter",
        forwarded_total: "counter",
        batches_total: "counter",
        failed_batches_total: "counter",
        failed_frames_total: "counter",
        dropped_total: "counter",
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
        item.messageDescriptor,
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
    this.dropLatestActorLocationFrames(connectionId);
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
    this.dropLatestActorLocationFrames();
    this.__dispose();
  }

  pushHostFrame(connectionId: number, frame: Uint8Array): void {
    if (this.isDisconnectedFrame(connectionId)) {
      this.droppedFramesAfterDisconnect += 1;
      return;
    }
    this.enqueueIngress({
      kind: "frame",
      connectionId,
      frame,
      queuedAtMs: this.latencies.enabled ? nowMs() : 0,
    }, false);
  }

  pushHostControlFrame(connectionId: number, frame: Uint8Array): void {
    if (this.isDisconnectedFrame(connectionId)) {
      this.droppedFramesAfterDisconnect += 1;
      return;
    }
    this.enqueueIngress({
      kind: "frame",
      connectionId,
      frame,
      queuedAtMs: this.latencies.enabled ? nowMs() : 0,
    }, true);
  }

  pushHostDisconnect(connectionId: number): void {
    this.markDisconnectedFrame(connectionId);
    this.enqueueIngress({
      kind: "disconnect",
      connectionId,
      queuedAtMs: this.latencies.enabled ? nowMs() : 0,
    }, true);
  }

  private enqueueIngress(event: QueuedEvent, control: boolean): void {
    (control ? this.controlIngress : this.dataIngress).push(event);
    this.metrics.maxIngressQueueLength = Math.max(
      this.metrics.maxIngressQueueLength,
      this.ingressLength,
    );
  }

  /** 每次进程 Update 消费有界入站队列，并返回打包后的出站任务。 / Drains bounded ingress and returns packed outbound work once per process update. */
  update(maxFrames = 512, includeMetrics = true): SceneUpdateResult {
    const startedAt = nowMs();
    this.__pumpMailbox(maxFrames);
    return this.__completeUpdate(startedAt, includeMetrics);
  }

  __pumpMailbox(maxFrames = 512): number {
    this.expireActorTransfers(nowMs());
    const startedAt = nowMs();
    const processed = this.mailbox === "unordered"
      ? this.drainUnordered(maxFrames)
      : this.drainOrdered(maxFrames);
    this.metrics.lastIngressPumpFrames = processed;
    this.metrics.lastIngressPumpCostMs = nowMs() - startedAt;
    return processed;
  }

  __completeUpdate(startedAt: number, includeMetrics = true): SceneUpdateResult {
    return this.completeUpdate(startedAt, includeMetrics);
  }

  /** 返回本 Scene 是否已排空到可原子切换 Hotfix 的状态。 / Reports whether this Scene is fully drained for an atomic Hotfix switch. */
  __canCommitHotfix(): boolean {
    return this.ingressLength === 0 &&
      this.latestActorLocationFrameCount === 0 &&
      this.unorderedTasks.size === 0 &&
      this.orderedTask === undefined &&
      this.Tasks.InFlightCount === 0 &&
      !this.mailboxBusy &&
      this.mailboxTaskLength() === 0;
  }

  /** 注册显式 Handler；生成的装饰器绑定会单独安装。 / Registers explicit handlers; generated decorator bindings are installed separately. */
  protected registerHandlers(): void {}

  /** 构造进程内唯一的子 Scene id，不向业务暴露分隔符约定。 / Builds a process-unique child Scene id without exposing the separator contract. */
  private childSceneId(localId: string): string {
    return `${this.self.name}/${localId}`;
  }

  /**
   * 在当前EntryScene命名空间创建动态子Scene；业务不接触ProcessHost全局容器。
   * Creates a dynamic child Scene inside this EntryScene namespace without
   * exposing the process-wide ProcessHost container to business code.
   */
  SpawnChildScene<T extends Scene>(localId: string, ctor: SceneCtor<T>): T {
    return this.processHost.spawnScene(this.childSceneId(localId), ctor);
  }

  /** 销毁当前EntryScene拥有的动态子Scene；调用前仍须完成领域清理。 / Despawns an owned child Scene after domain cleanup has completed. */
  DespawnChildScene(localId: string): boolean {
    return this.processHost.despawnScene(this.childSceneId(localId));
  }

  /**
   * 让已经解析出的本地Actor操作进入其真实mailbox；不能替代Location或跨进程路由。
   * Runs an operation for an already resolved local Actor through its actual
   * mailbox; this cannot replace Location or cross-process routing.
   */
  RunLocalActorMailbox<TActor extends ActorUnit<any[]>, TResult>(
    actor: TActor,
    body: (current: TActor) => MaybePromise<TResult>,
  ): MaybePromise<TResult> {
    return this.processHost.runActorMailbox(actor.InstanceId, (current) => {
      if (current !== actor) {
        throw new Error(`actor instance changed: ${actor.InstanceId}`);
      }
      return body(actor);
    });
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
    this.sendClientFrame(
      connectionId,
      packFrame(descriptor.msgcode, descriptor.codec.encode(message)),
    );
  }

  /** 只编码一次，再将不可变帧扇出到多个客户端连接。 / Encodes once and fans the immutable frame out to many client connections. */
  protected sendClientMany<TMessage extends IMessage>(
    connectionIds: readonly number[],
    descriptor: MessageDescriptor<TMessage>,
    message: TMessage,
  ): void {
    if (connectionIds.length === 0) return;

    const frame = packFrame(descriptor.msgcode, descriptor.codec.encode(message));
    this.sendClientFrameMany(connectionIds, frame);
  }

  /** 只向一个连接入队已编码帧，复用连接ID字节缓存。 / Queues one encoded frame for one connection while reusing the cached connection-id bytes. */
  private sendClientFrame(
    connectionId: number,
    frame: Uint8Array,
    delivery: ClientFrameDelivery = "reliable",
  ): void {
    if (delivery === "latest") this.onClientLatestFrameQueued([connectionId]);
    else this.onClientSendQueued([connectionId]);
    this.outboundQueue(delivery).push({
      connectionIdBytes: this.packConnectionId(connectionId),
      frame,
    });
  }

  /** 将已编码帧入队；调用后不得再修改该帧。 / Queues an already encoded frame; callers must not mutate it after this call. */
  protected sendClientFrameMany(
    connectionIds: readonly number[],
    frame: Uint8Array,
    delivery: ClientFrameDelivery = "reliable",
  ): void {
    if (connectionIds.length === 0) return;
    if (connectionIds.length === 1) {
      this.sendClientFrame(connectionIds[0]!, frame, delivery);
      return;
    }
    if (delivery === "latest") this.onClientLatestFrameQueued(connectionIds);
    else this.onClientSendQueued(connectionIds);
    this.outboundQueue(delivery).push({
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
  dispatchLocalSend(frame: Uint8Array): MaybePromise<void> {
    return this.dispatchMailboxVoid(() => this.handleFrame(frame));
  }

  /** 返回当前Scene mailbox热路径计数；监控读取不会改变队列。 / Returns Scene mailbox hot-path counters without changing the queue. */
  mailboxMetricsSnapshot(): MailboxMetricsSnapshot {
    return { ...this.mailboxMetrics, queuedDepth: this.mailboxTaskLength() };
  }

  /** 返回当前时点快照，不重置累计计数器。 / Returns a point-in-time snapshot without resetting cumulative counters. */
  metricsSnapshot(): SceneMetricsSnapshot {
    const asyncInFlight = this.unorderedTasks.size +
      (this.orderedTask ? 1 : 0) +
      this.Tasks.InFlightCount;
    this.metrics.maxAsyncInFlight = Math.max(
      this.metrics.maxAsyncInFlight,
      asyncInFlight,
      this.Tasks.MaxInFlightCount,
    );
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
      lastIngressPumpFrames: this.metrics.lastIngressPumpFrames,
      lastIngressPumpCostMs: this.metrics.lastIngressPumpCostMs,
      lastUpdateCostMs: this.metrics.lastUpdateCostMs,
      lastHandlerCostMs: this.metrics.lastHandlerCostMs,
      maxHandlerCostMs: this.metrics.maxHandlerCostMs,
      totalHandlerCostMs: this.metrics.totalHandlerCostMs,
      asyncInFlight,
      maxAsyncInFlight: this.metrics.maxAsyncInFlight,
      mailbox: this.mailboxMetricsSnapshot(),
      latencies: this.latencies.snapshot(),
      customMetrics: [
        this.actorLatestForwardMetricSnapshot(),
        {
          name: "outbound_lanes",
          values: {
            outbound_control_depth: this.outboundLaneDepths.control,
            outbound_reliable_depth: this.outboundLaneDepths.reliable,
            outbound_latest_depth: this.outboundLaneDepths.latest,
            outbound_total_depth: this.outboundLaneDepths.total,
            outbound_control_depth_max: this.outboundLaneDepths.maxControl,
            outbound_reliable_depth_max: this.outboundLaneDepths.maxReliable,
            outbound_latest_depth_max: this.outboundLaneDepths.maxLatest,
            outbound_total_depth_max: this.outboundLaneDepths.maxTotal,
            outbound_reliable_enqueued_total: this.outboundReliableEnqueued,
            outbound_latest_enqueued_total: this.outboundLatestEnqueued,
          },
          kinds: {
            outbound_control_depth: "gauge",
            outbound_reliable_depth: "gauge",
            outbound_latest_depth: "gauge",
            outbound_total_depth: "gauge",
            outbound_control_depth_max: "gauge",
            outbound_reliable_depth_max: "gauge",
            outbound_latest_depth_max: "gauge",
            outbound_total_depth_max: "gauge",
            outbound_reliable_enqueued_total: "counter",
            outbound_latest_enqueued_total: "counter",
          },
        },
        {
          name: "connection_ingress",
          values: {
            dropped_frames_after_disconnect_total: this.droppedFramesAfterDisconnect,
            disconnect_tombstones: this.disconnectedFrameTombstones.size,
          },
          kinds: {
            dropped_frames_after_disconnect_total: "counter",
            disconnect_tombstones: "gauge",
          },
        },
        {
          name: "actor_location_fence",
          values: {
            rejected_total: this.actorLocationFenceRejections,
          },
          kinds: {
            rejected_total: "counter",
          },
        },
      ],
    };
  }

  /** 控制队列可能先于旧数据帧交付Disconnect；短期墓碑用于拒绝这些不再可响应的残留帧。 / A control-lane disconnect may overtake old data frames; a short-lived tombstone drops frames that can no longer receive responses. */
  private markDisconnectedFrame(connectionId: number): void {
    const now = nowMs();
    this.pruneDisconnectedFrames(now);
    this.disconnectedFrameTombstones.delete(connectionId);
    this.disconnectedFrameTombstones.set(
      connectionId,
      now + EntryScene.DISCONNECTED_FRAME_TOMBSTONE_MS,
    );
    while (
      this.disconnectedFrameTombstones.size > EntryScene.MAX_DISCONNECTED_FRAME_TOMBSTONES
    ) {
      const oldest = this.disconnectedFrameTombstones.keys().next().value;
      if (oldest === undefined) break;
      this.disconnectedFrameTombstones.delete(oldest);
    }
  }

  private isDisconnectedFrame(connectionId: number): boolean {
    const expiresAt = this.disconnectedFrameTombstones.get(connectionId);
    if (expiresAt === undefined) return false;
    if (expiresAt > nowMs()) return true;
    this.disconnectedFrameTombstones.delete(connectionId);
    return false;
  }

  private pruneDisconnectedFrames(now: number): void {
    for (const [connectionId, expiresAt] of this.disconnectedFrameTombstones) {
      if (expiresAt > now) break;
      this.disconnectedFrameTombstones.delete(connectionId);
    }
  }

  private drainOutbound(): OutboundBatch[] {
    const controlDepth = this.outboundControl.length;
    const reliableDepth = this.outboundReliable.length;
    const latestDepth = this.outboundLatest.length;
    const totalDepth = controlDepth + reliableDepth + latestDepth;
    this.outboundLaneDepths.control = controlDepth;
    this.outboundLaneDepths.reliable = reliableDepth;
    this.outboundLaneDepths.latest = latestDepth;
    this.outboundLaneDepths.total = totalDepth;
    this.outboundLaneDepths.maxControl = Math.max(this.outboundLaneDepths.maxControl, controlDepth);
    this.outboundLaneDepths.maxReliable = Math.max(this.outboundLaneDepths.maxReliable, reliableDepth);
    this.outboundLaneDepths.maxLatest = Math.max(this.outboundLaneDepths.maxLatest, latestDepth);
    this.outboundLaneDepths.maxTotal = Math.max(this.outboundLaneDepths.maxTotal, totalDepth);
    const control = this.outboundControl.splice(0, this.outboundControl.length);
    const reliable = this.outboundReliable.splice(0, this.outboundReliable.length);
    const latest = this.outboundLatest.splice(0, this.outboundLatest.length);
    if (reliable.length === 0 && latest.length === 0) return control;
    control.push(...reliable, ...latest);
    return control;
  }

  private outboundQueue(delivery: ClientFrameDelivery): OutboundBatch[] {
    if (delivery === "latest") {
      this.outboundLatestEnqueued += 1;
      return this.outboundLatest;
    }
    this.outboundReliableEnqueued += 1;
    return this.outboundReliable;
  }

  private get ingressLength(): number {
    return this.controlIngress.length - this.controlIngressHead +
      this.dataIngress.length - this.dataIngressHead;
  }

  private dequeueIngress(): QueuedEvent | undefined {
    const controlAvailable = this.controlIngressHead < this.controlIngress.length;
    const dataAvailable = this.dataIngressHead < this.dataIngress.length;
    if (!controlAvailable && !dataAvailable) return undefined;
    if (controlAvailable && (!dataAvailable || this.consecutiveDataIngress >= EntryScene.MAX_CONSECUTIVE_DATA_INGRESS)) {
      this.consecutiveDataIngress = 0;
      return this.dequeueIngressQueue(this.controlIngress, "controlIngressHead");
    }
    this.consecutiveDataIngress += 1;
    return this.dequeueIngressQueue(this.dataIngress, "dataIngressHead");
  }

  private dequeueIngressQueue(
    queue: QueuedEvent[],
    headKey: "controlIngressHead" | "dataIngressHead",
  ): QueuedEvent {
    const item = queue[this[headKey]++];
    if (this[headKey] === queue.length) {
      queue.length = 0;
      this[headKey] = 0;
    } else if (this[headKey] >= 1024 && this[headKey] * 2 >= queue.length) {
      queue.splice(0, this[headKey]);
      this[headKey] = 0;
    }
    return item;
  }

  private completeUpdate(startedAt: number, includeMetrics: boolean): SceneUpdateResult {
    this.flushLatestActorLocationFrames();
    this.metrics.lastUpdateCostMs = nowMs() - startedAt;
    return {
      outbound: this.drainOutbound(),
      metrics: includeMetrics ? this.metricsSnapshot() : undefined,
      pendingAsync: this.orderedTask !== undefined ||
        this.unorderedTasks.size > 0 ||
        this.Tasks.InFlightCount > 0,
      pendingIngress: this.ingressLength > 0,
    };
  }

  private drainOrdered(maxFrames: number): number {
    if (this.orderedTask) return 0;
    let processed = 0;
    while (
      this.ingressLength > 0 &&
      processed < maxFrames
    ) {
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
    return processed;
  }

  private drainUnordered(maxFrames: number): number {
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
    return processed;
  }

  private dispatchMailbox<T>(run: () => MaybePromise<T>): MaybePromise<T> {
    if (this.mailbox === "unordered") {
      this.mailboxMetrics.fastPathCalls += 1;
      const result = run();
      if (isPromiseLike(result)) this.mailboxMetrics.asyncCalls += 1;
      return result;
    }
    if (this.mailboxBusy) {
      this.mailboxMetrics.queuedCalls += 1;
      return new Promise<T>((resolve, reject) => {
        this.enqueueMailboxTask(
          run as () => MaybePromise<unknown>,
          resolve as (value: unknown) => void,
          reject,
        );
      });
    }
    this.mailboxMetrics.fastPathCalls += 1;
    this.mailboxBusy = true;
    return this.runMailboxTask(run);
  }

  /**
   * 场景单向消息的Mailbox路径；忙时只排队，不创建完成Promise。
   * 如果当前Handler本身异步，仍返回它的异步结果供上层记录错误。
   *
   * One-way Scene mailbox path; a busy mailbox queues without a completion
   * Promise. If the current handler is async, its result is still returned so
   * the caller can observe and log the failure.
   */
  private dispatchMailboxVoid(run: () => MaybePromise<unknown>): MaybePromise<void> {
    if (this.mailbox === "unordered") {
      this.mailboxMetrics.oneWayFastPathCalls += 1;
      const result = run();
      if (isPromiseLike(result)) {
        this.mailboxMetrics.oneWayAsyncCalls += 1;
        // unordered 不需要等待或改写返回值；直接透传 Handler 自己的 Promise，避免再包一层。
        // Unordered does not need ordering or a rewritten value; pass through the Handler Promise without another wrapper.
        return result as Promise<void>;
      }
      return undefined;
    }
    if (this.mailboxBusy) {
      this.mailboxMetrics.oneWayQueuedCalls += 1;
      this.enqueueMailboxTask(run, undefined, undefined, true);
      return undefined;
    }
    this.mailboxMetrics.oneWayFastPathCalls += 1;
    this.mailboxBusy = true;
    return this.runMailboxTask(run, true) as MaybePromise<void>;
  }

  private runMailboxTask<T>(
    run: () => MaybePromise<T>,
    oneWay = false,
  ): MaybePromise<T> {
    try {
      const result = run();
      if (isPromiseLike(result)) {
        if (oneWay) this.mailboxMetrics.oneWayAsyncCalls += 1;
        else this.mailboxMetrics.asyncCalls += 1;
      }
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
    // 同步任务必须在循环中排空；递归调用会让长串同步消息耗尽V8调用栈。
    // Synchronous tasks drain in a loop; recursive completion would exhaust the V8 stack for a long queue.
    while (true) {
      const next = this.dequeueMailboxTask();
      if (!next) {
        this.mailboxBusy = false;
        return;
      }
      try {
        const result = next.run!();
        if (isPromiseLike(result)) {
          if (next.oneWay === true) this.mailboxMetrics.oneWayAsyncCalls += 1;
          else this.mailboxMetrics.asyncCalls += 1;
        }
        if (isPromiseLike(result)) {
          void Promise.resolve(result).then(
            (value) => {
              next.resolve?.(value);
              this.recycleMailboxTask(next);
              this.finishMailboxTask();
            },
            (error) => {
              if (next.reject) next.reject(error);
              else this.ctx.logger.error("one-way scene mailbox failed", { error });
              this.recycleMailboxTask(next);
              this.finishMailboxTask();
            },
          );
          return;
        }
        next.resolve?.(result);
        this.recycleMailboxTask(next);
      } catch (error) {
        if (next.reject) next.reject(error);
        else this.ctx.logger.error("one-way scene mailbox failed", { error });
        this.recycleMailboxTask(next);
      }
    }
  }

  private enqueueMailboxTask(
    run: () => MaybePromise<unknown>,
    resolve?: (value: unknown) => void,
    reject?: (reason?: unknown) => void,
    oneWay = false,
  ): void {
    const task = this.recycledMailboxTasks.pop() ?? { run };
    task.run = run;
    task.resolve = resolve;
    task.reject = reject;
    task.oneWay = oneWay;
    this.mailboxTasks.push(task);
    this.mailboxMetrics.queuedDepth += 1;
    this.mailboxMetrics.maxQueuedDepth = Math.max(
      this.mailboxMetrics.maxQueuedDepth,
      this.mailboxMetrics.queuedDepth,
    );
  }

  private dequeueMailboxTask(): MailboxTask | undefined {
    if (this.mailboxTaskHead >= this.mailboxTasks.length) return undefined;
    const task = this.mailboxTasks[this.mailboxTaskHead++];
    if (this.mailboxTaskHead === this.mailboxTasks.length) {
      this.mailboxTasks.length = 0;
      this.mailboxTaskHead = 0;
    } else if (
      this.mailboxTaskHead >= 1024 &&
      this.mailboxTaskHead * 2 >= this.mailboxTasks.length
    ) {
      this.mailboxTasks.splice(0, this.mailboxTaskHead);
      this.mailboxTaskHead = 0;
    }
    this.mailboxMetrics.queuedDepth = Math.max(
      0,
      this.mailboxMetrics.queuedDepth - 1,
    );
    return task;
  }

  private recycleMailboxTask(task: MailboxTask): void {
    task.run = undefined;
    task.resolve = undefined;
    task.reject = undefined;
    task.oneWay = undefined;
    this.recycledMailboxTasks.push(task);
  }

  private mailboxTaskLength(): number {
    return this.mailboxTasks.length - this.mailboxTaskHead;
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

    if (this.isDisconnectedFrame(item.connectionId)) {
      this.droppedFramesAfterDisconnect += 1;
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
    this.outboundControl.push({
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
    if (msgcode === TraceEnvelopeMsgCode) {
      try {
        const envelope = decodeTraceEnvelope(frame);
        const tracedContext: ProtocolContext = {
          ...context,
          traceId: envelope.context.traceId,
          spanId: envelope.context.spanId,
          traceSampled: envelope.context.sampled,
          logger: context.logger?.child({
            traceId: envelope.context.traceId,
            spanId: envelope.context.spanId,
          }),
        };
        return RunWithTraceContext(envelope.context, () =>
          this.routeOrHandleFrame(envelope.frame, tracedContext));
      } catch (error) {
        this.registry.reportSystemError(
          SystemErrCode.MalformedFrame,
          `invalid trace envelope: ${errorText(error)}`,
          context,
        );
        return undefined;
      }
    }
    if (msgcode === ActorLocationEnvelopeMsgCode) {
      try {
        const envelope = decodeActorLocationEnvelope(frame);
        return this.actorRegistry.handle(envelope.frame, {
          actorInstanceId: envelope.instanceId,
          actorLocationFenceToken: envelope.fenceToken,
          traceId: context.traceId,
          spanId: context.spanId,
          traceSampled: context.traceSampled,
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

    if (msgcode === ActorLocationBatchEnvelopeMsgCode) {
      try {
        return this.dispatchActorLocationBatch(frame, context);
      } catch (error) {
        this.registry.reportSystemError(
          SystemErrCode.MalformedFrame,
          `invalid actor location batch envelope: ${errorText(error)}`,
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
        const queued: QueuedActorFrame = { frame, context, msgcode, messageDescriptor };
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
        transfer.frames.push({ frame, context, msgcode, messageDescriptor });
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
      messageDescriptor,
    );
  }

  private dispatchActorLocationFrame(
    connectionId: number,
    frame: Uint8Array,
    context: ProtocolContext,
    rpcDescriptor?: AnyRpcDescriptor,
    messageDescriptor?: AnyMessageDescriptor,
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
    if (messageDescriptor?.forwarding === "latest") {
      this.queueLatestActorLocationFrame(
        connectionId,
        target,
        messageDescriptor.msgcode,
        frame,
      );
      return;
    }
    const routedFrame = encodeActorLocationEnvelope({
      instanceId: target.instanceId,
      fenceToken: target.fenceToken,
      frame,
    });
    const result = this.ctx.sendFrame(target.scene, routedFrame);
    if (!isPromiseLike(result)) return;
    return result.then(
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

  private dispatchActorLocationBatch(
    frame: Uint8Array,
    context: ProtocolContext,
  ): MaybePromise<Uint8Array | undefined> {
    const pending: Promise<unknown>[] = [];
    forEachActorLocationBatchEntry(frame, (entry) => {
      const msgcode = readU16BE(entry.frame, 0);
      const descriptor = this.knownMessagesByCode.get(msgcode);
      if (descriptor?.routing !== "actor-location" || descriptor.forwarding !== "latest") {
        throw new Error(`nested msgcode ${msgcode} is not a latest ActorLocation message`);
      }
      const result = this.actorRegistry.handle(entry.frame, {
        actorInstanceId: entry.instanceId,
        actorLocationFenceToken: entry.fenceToken,
        traceId: context.traceId,
        spanId: context.spanId,
        traceSampled: context.traceSampled,
        logger: context.logger,
      });
      if (isPromiseLike(result)) pending.push(Promise.resolve(result));
    });
    if (pending.length === 0) return;
    return Promise.all(pending).then(() => undefined);
  }

  private queueLatestActorLocationFrame(
    connectionId: number,
    target: ActorLocationTarget,
    msgcode: number,
    frame: Uint8Array,
  ): void {
    const byMsgcode = this.latestActorLocationFrames.get(connectionId) ?? new Map();
    const pending = byMsgcode.get(msgcode);
    if (pending) {
      pending.target = target.scene;
      pending.instanceId = target.instanceId;
      pending.fenceToken = target.fenceToken;
      pending.frame = frame;
      this.latestActorLocationMetrics.coalesced += 1;
    } else {
      byMsgcode.set(msgcode, {
        target: target.scene,
        instanceId: target.instanceId,
        fenceToken: target.fenceToken,
        frame,
      });
      this.latestActorLocationFrameCount += 1;
    }
    this.latestActorLocationFrames.set(connectionId, byMsgcode);
    this.latestActorLocationFlushAtMs ??=
      nowMs() + EntryScene.LATEST_ACTOR_FORWARD_WINDOW_MS;
    this.latestActorLocationMetrics.queued += 1;
  }

  /** 每轮按目标Scene形成一个内部批量帧；发送完成不参与Scene mailbox等待。 / Emits one inner batch per target Scene per update without making the Scene mailbox await transport completion. */
  private flushLatestActorLocationFrames(): void {
    if (this.latestActorLocationFrameCount === 0) return;
    if (
      this.latestActorLocationFlushAtMs !== undefined &&
      nowMs() < this.latestActorLocationFlushAtMs
    ) return;
    const byScene = new Map<string, {
      target: SceneConfig;
      entries: PendingLatestActorLocationFrame[];
    }>();
    for (const byMsgcode of this.latestActorLocationFrames.values()) {
      for (const pending of byMsgcode.values()) {
        const group = byScene.get(pending.target.name) ?? {
          target: pending.target,
          entries: [],
        };
        group.entries.push(pending);
        byScene.set(pending.target.name, group);
      }
    }
    this.latestActorLocationFrames.clear();
    this.latestActorLocationFrameCount = 0;
    this.latestActorLocationFlushAtMs = undefined;

    for (const group of byScene.values()) {
      const frameCount = group.entries.length;
      try {
        const batch = encodeActorLocationBatchEnvelope(group.entries);
        this.latestActorLocationMetrics.forwarded += frameCount;
        this.latestActorLocationMetrics.batches += 1;
        const delivery = this.ctx.sendFrame(group.target, batch);
        if (isPromiseLike(delivery)) {
          void Promise.resolve(delivery).catch((error) => {
            this.latestActorLocationMetrics.failedBatches += 1;
            this.latestActorLocationMetrics.failedFrames += frameCount;
            this.ctx.logger.error("latest actor batch forwarding failed", {
              target: group.target.name,
              frameCount,
              error,
            });
          });
        }
      } catch (error) {
        this.latestActorLocationMetrics.failedBatches += 1;
        this.latestActorLocationMetrics.failedFrames += frameCount;
        this.ctx.logger.error("latest actor batch encoding failed", {
          target: group.target.name,
          frameCount,
          error,
        });
      }
    }
  }

  private dropLatestActorLocationFrames(connectionId?: number): void {
    if (connectionId !== undefined) {
      const pending = this.latestActorLocationFrames.get(connectionId);
      if (!pending) return;
      this.latestActorLocationFrames.delete(connectionId);
      this.latestActorLocationFrameCount -= pending.size;
      this.latestActorLocationMetrics.dropped += pending.size;
      if (this.latestActorLocationFrameCount === 0) {
        this.latestActorLocationFlushAtMs = undefined;
      }
      return;
    }
    this.latestActorLocationMetrics.dropped += this.latestActorLocationFrameCount;
    this.latestActorLocationFrames.clear();
    this.latestActorLocationFrameCount = 0;
    this.latestActorLocationFlushAtMs = undefined;
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
          return this.processHost.runActorMailboxVoid(session.InstanceId, (target) =>
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
            this.requireActorLocationFence(actor, context);
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
            return binding.handler.handle(actor as unknown as Unit<any[]>, request, context);
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
          return this.processHost.runActorMailboxVoid(instanceId, (actor) => {
            this.requireActorLocationFence(actor, context);
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
            return binding.handler.handle(actor as unknown as Unit<any[]>, message, context);
          });
        },
      });
    }
  }

  /** 在真实Actor mailbox内校验外部路由代次，避免接管后的旧Gate继续驱动业务。 / Validates an external route generation inside the real Actor mailbox so a stale Gate cannot drive gameplay after takeover. */
  private requireActorLocationFence(
    actor: ActorRuntimeEntity<any[]>,
    context: ProtocolContext,
  ): void {
    const token = context.actorLocationFenceToken;
    if (token === undefined) return;
    if (actor.__matchesActorLocationFenceToken(token)) return;
    this.actorLocationFenceRejections += 1;
    throw new RpcError(
      SystemErrCode.ActorLocationFenceRejected,
      `actor location fence rejected for instance ${actor.InstanceId}`,
    );
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
