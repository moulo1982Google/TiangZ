import type { MaybePromise } from "../async";
import type { RuntimeDataPackInput } from "../content/RuntimeDataPackRegistry";
import type { ProcessLoggingConfig } from "../logging/types";
import type { LatencyMetricSnapshot, LatencyRecorderOptions } from "../metrics/latency";
import type { GameUpdateConfig } from "../runtime/Game";
import type { ProcessHost } from "../runtime/host";
import type { ProcessEnvironment } from "./ProcessRuntimeInfo";

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
  /** @deprecated 地图部署由 MMORPG 模块数据包拥有；过渡期显式双写必须一致。 / Map deployment belongs to the MMORPG data pack; explicit legacy values must agree during migration. */
  staticMapIds?: number[];
  /** @deprecated 使用 MMORPG 模块部署配置；缺失保持旧默认 false。 / Use module-owned MMORPG deployment; absence retains the legacy false default. */
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
  /** 部署环境；宿主已校验，省略时为 development。业务请通过 `ProcessRuntimeInfo` 读取。 / Deployment environment validated by the host; development when omitted. Business code reads it through `ProcessRuntimeInfo`. */
  environment?: ProcessEnvironment;
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
  /** 排队写专用连接数，0（默认）与其他请求共用clientPoolSize连接。 / Connections dedicated to queued writes; 0 (default) shares the clientPoolSize connections. */
  queuedClientPoolSize?: number;
  /** 每条连接同时在途的请求上限，默认64。 / In-flight requests per connection, default 64. */
  maxInFlightPerConnection?: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
}

export interface ProcessIdentityConfig {
  /** 永久来源服编号；不同可合服区服不得重复。 / Immutable origin-server number unique across mergeable servers. */
  originServerId?: number;
  /** 同一来源服内生成持久 ID 的 Process 编号。 / Persistent-ID worker number inside one origin server. */
  workerId?: number;
  /** dbproxy 模式必须在 Scene 创建前领取号段，失败不回退。 / DBProxy mode reserves before Scene construction and never falls back on failure. */
  allocation?: "local-development" | "dbproxy";
}

export interface ProcessLifecycleConfig {
  stopTimeoutMs?: number;
}

export interface ProcessNetworkConfig {
  /** 0.7：全部业务监听端口共享的入站连接上限，含握手；1..1000000，默认65536。 / Since 0.7: shared inbound connection limit including handshakes; 1..1000000, default 65536. */
  maxAcceptedConnections?: number;
  /** 0.7：全部流式监听端口共享的未完成握手上限；1..1000000，默认1024。 / Since 0.7: shared pending stream handshake limit; 1..1000000, default 1024. */
  maxPendingHandshakes?: number;
  /** 0.7：ConnectionWriter payload 与主动 Inner Host 整包共享预算，1..1073741824，默认64MiB；不含响应、入站及 KCP 内部缓存。 / Since 0.7: shared writer payload and active Inner host-packet budget, 1..1073741824, default 64MiB; excludes responses, ingress and KCP internals. */
  maxOutboundBufferedBytes?: number;
  /** 0.7：Rust 已解码入站帧共享逻辑字节额度，1..1073741824，默认64MiB；不含解码器、Host 打包副本和 V8/TS mailbox。 / Since 0.7: shared decoded Rust ingress frame budget, 1..1073741824, default 64MiB; excludes decoders, host batch copies and V8/TS mailboxes. */
  maxIngressBufferedBytes?: number;
  /** 0.7：KCP C 缓存与输出引用的共享保守额度，1..1073741824，默认64MiB；每 Session 另限4MiB，不代表进程总内存。 / Since 0.7: conservative shared KCP cache/output budget, 1..1073741824, default 64MiB; each session also has a 4MiB limit, excluding total process memory. */
  maxKcpBufferedBytes?: number;
  /** 0.7：出站批次从准入起的总写出预算，1..300000ms，默认10000。 / Since 0.7: total outbound budget from admission, 1..300000ms, default 10000. */
  writeTimeoutMs?: number;
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
  /** 宿主装入的不可变数据信封，在任何Scene构造函数运行前可用。 / Host-loaded immutable data envelopes available before any Scene constructor runs. */
  dataPacks?: readonly RuntimeDataPackInput[];
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

export interface SceneUpdateResult {
  outbound: OutboundBatch[];
  /**
   * 本次随出站帧交出的关闭请求；宿主须先提交 outbound 再关闭，传输失败仍可能丢帧。
   * Close requests handed out with this update; submit outbound before closing, though transport failure can still lose frames.
   */
  closes: readonly number[];
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
