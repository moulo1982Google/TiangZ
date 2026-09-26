import type { SceneConfig } from "./types";
import { utf8Decode } from "../protocol/binary";
import type { MaybePromise } from "../async";
import { RpcError } from "../protocol/RpcError";
import { SystemErrCode } from "../protocol/SystemErrCode";

const MAX_PENDING_OPERATIONS = 65_536;
const OPERATION_META_BYTES = 17;
const MAX_PACKED_BYTES = 64 * 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;

interface PendingOperation {
  resolve: (value: Uint8Array) => void;
  reject: (reason: Error) => void;
}

interface QueuedOperation {
  id: number;
  routeId: number;
  kind: 1 | 2 | 3;
  timeoutMs: number;
  frame: Uint8Array;
  frameLength: number;
}

interface PendingDeadline {
  id: number;
  resolve: () => void;
  reject: (reason: unknown) => void;
  wait?: Promise<void>;
}

const routeIds = new Map<string, number>();
const pending = new Map<number, PendingOperation>();
const queued: QueuedOperation[] = [];
const deadlines = new Map<number, PendingDeadline>();
const unstartedDeadlines = new Set<PendingDeadline>();
let nextOperationId = 1;
let queuedPackedBytes = 4;
const operationCounters = { queueRejected: 0, bytesRejected: 0, pendingRejected: 0, invalidFrames: 0, submitFailures: 0 };

/** 仅记录未提交打包成本与等待回复数，不能当作全部远程在途或堆内存。 / Reports unsubmitted packed cost and reply waiters, not all remote in-flight work or heap memory. */
export function hostSceneOperationMetrics() {
  return {
    hostSceneQueuedOperations: queued.length,
    hostSceneQueuedBytes: queued.length === 0 ? 0 : queuedPackedBytes,
    hostScenePendingReplies: pending.size,
    hostSceneQueueCapacity: MAX_PENDING_OPERATIONS,
    hostSceneQueueByteCapacity: MAX_PACKED_BYTES,
    hostScenePendingCapacity: MAX_PENDING_OPERATIONS,
    hostSceneQueueRejections: operationCounters.queueRejected,
    hostSceneByteRejections: operationCounters.bytesRejected,
    hostScenePendingRejections: operationCounters.pendingRejected,
    hostSceneInvalidFrames: operationCounters.invalidFrames,
    hostSceneSubmitFailures: operationCounters.submitFailures,
  };
}

/** 在新增项进入队列前验证既有 Rust 帧边界。 / Validates the existing Rust frame boundary before admitting a new operation. */
function requireSceneFrame(frame: Uint8Array): void {
  if (!(frame instanceof Uint8Array) || !ArrayBuffer.isView(frame) || frame.length < 2 || frame.length > MAX_FRAME_BYTES) {
    operationCounters.invalidFrames += 1;
    throw new Error(`invalid host scene frame length: ${frame?.length}`);
  }
}

/** 回复名额跨 flush 保留；单向消息不持有此资源。 / Reply admission survives flush and is not held by one-way operations. */
function requireReplyCapacity(): void {
  if (pending.size >= MAX_PENDING_OPERATIONS) {
    operationCounters.pendingRejected += 1;
    throw new RpcError(SystemErrCode.SceneOverloaded, "host scene pending reply limit reached");
  }
}

/** call/send/sleep 共用条数与含元数据的成本；拒绝不会改变旧队列。 / Shares count and metadata-inclusive cost across call/send/sleep without changing admitted work on rejection. */
function requireQueueCapacity(frameLength: number): void {
  if (queued.length >= MAX_PENDING_OPERATIONS) {
    operationCounters.queueRejected += 1;
    throw new RpcError(SystemErrCode.SceneOverloaded, "host scene operation queue limit reached");
  }
  if (queuedPackedBytes + OPERATION_META_BYTES + frameLength > MAX_PACKED_BYTES) {
    operationCounters.bytesRejected += 1;
    throw new RpcError(SystemErrCode.SceneOverloaded, "host scene packed byte limit reached");
  }
}

/** 在全部同步验证成功后接收原帧引用和固定成本。 / Accepts the original frame reference and fixed cost after all synchronous checks succeed. */
function queueOperation(operation: QueuedOperation): void {
  queued.push(operation);
  queuedPackedBytes += OPERATION_META_BYTES + operation.frameLength;
}

/** 先预留绝对期限；未跨 Update 的调用同步释放，已启动的原生等待实际退出后才返回。 / Reserves an absolute deadline; calls finishing before Update release synchronously, while started native waits drain before returning. */
export async function withHostDeadline<T>(run: () => MaybePromise<T>, ms: number, timeoutMessage: string): Promise<T> {
  const id = hostCreateDeadline(ms);
  let resolve!: () => void, reject!: (reason: unknown) => void;
  const timeout = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  const deadline: PendingDeadline = { id, resolve, reject };
  deadlines.set(id, deadline);
  unstartedDeadlines.add(deadline);
  try {
    return await Promise.race([run(), timeout.then(() => { throw new Error(timeoutMessage); })]);
  } finally {
    unstartedDeadlines.delete(deadline);
    if (deadlines.get(id) === deadline) deadlines.delete(id);
    hostCancelDeadline(id);
    if (deadline.wait) await deadline.wait.catch(() => {});
  }
}

/** 刷新时仅为仍在等待的期限启动原生任务；创建时的绝对期限不重置。 / Starts native waits only for still-pending deadlines at flush, retaining their creation-time expiration.
 */
function flushHostDeadlines(): void {
  for (const deadline of unstartedDeadlines) {
    unstartedDeadlines.delete(deadline);
    try {
      deadline.wait = hostWaitDeadline(deadline.id);
      void deadline.wait.then(deadline.resolve, deadline.reject);
    } catch (error) { deadline.reject(error); }
  }
}

/** 将远程 Scene RPC 放入 Rust 传输队列，并按 operation id 完成等待。 / Queues one remote Scene RPC for Rust transport and resolves by its operation id. */
export function callRemoteScene(
  source: SceneConfig,
  target: SceneConfig,
  frame: Uint8Array,
  timeoutMs: number,
): Promise<Uint8Array> {
  return enqueue(source, target, frame, timeoutMs, 1);
}

/** 将远程 Scene 单向帧入队，不等待对端响应。 / Queues a one-way remote Scene frame without waiting for a peer response. */
export function sendRemoteScene(
  source: SceneConfig,
  target: SceneConfig,
  frame: Uint8Array,
  timeoutMs: number,
): void {
  requireSceneFrame(frame);
  requireQueueCapacity(frame.length);
  queueOperation({
    id: 0,
    routeId: resolveRoute(source, target),
    kind: 2,
    timeoutMs: Math.max(1, Math.min(timeoutMs, 0xffff_ffff)),
    frame,
    frameLength: frame.length,
  });
}

/** 传输超时使用 Rust 宿主定时器；游戏逻辑定时必须使用 TimerSystem。 / Uses the Rust host timer for transport deadlines; gameplay timers belong to TimerSystem. */
export function sleepHost(ms: number): Promise<void> {
  try {
    requireReplyCapacity();
    requireQueueCapacity(0);
  } catch (error) {
    return Promise.reject(error);
  }
  const id = allocateOperationId();
  const promise = new Promise<Uint8Array>((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
  queueOperation({
    id,
    routeId: 0,
    kind: 3,
    timeoutMs: Math.max(0, Math.min(ms, 0xffff_ffff)),
    frame: new Uint8Array(0),
    frameLength: 0,
  });
  return promise.then(() => undefined);
}

function enqueue(
  source: SceneConfig,
  target: SceneConfig,
  frame: Uint8Array,
  timeoutMs: number,
  kind: 1,
): Promise<Uint8Array> {
  try {
    requireSceneFrame(frame);
    requireReplyCapacity();
    requireQueueCapacity(frame.length);
    const routeId = resolveRoute(source, target);
    const id = allocateOperationId();
    const promise = new Promise<Uint8Array>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    queueOperation({ id, routeId, kind, timeoutMs: Math.max(1, Math.min(timeoutMs, 0xffff_ffff)), frame, frameLength: frame.length });
    return promise;
  } catch (error) { return Promise.reject(error); }
}

/** 只终结该项的回复等待；单向失败由聚合指标记录。 / Settles only this operation's reply waiter; one-way failures are counted in aggregate metrics. */
function rejectOperation(operation: QueuedOperation, reason: Error): void {
  if (operation.id === 0) return;
  const reply = pending.get(operation.id);
  pending.delete(operation.id);
  reply?.reject(reason);
}

/** 在本次 Update 末尾把所有待处理 call/send 打包为一次 host op。 / Packs all queued call/send operations into one host op at the end of the update. */
export function flushHostSceneOperations(): void {
  flushHostDeadlines();
  if (queued.length === 0) return;
  const operations = queued.splice(0, queued.length);
  queuedPackedBytes = 4;
  const valid: QueuedOperation[] = [];
  for (const operation of operations) {
    if (operation.frame.length !== operation.frameLength) {
      operationCounters.invalidFrames += 1;
      rejectOperation(operation, new Error("host scene frame changed before submission"));
    } else {
      valid.push(operation);
    }
  }
  if (valid.length === 0) return;
  try {
    hostSubmitSceneOperations(packOperations(valid));
  } catch (error) {
    operationCounters.submitFailures += 1;
    const reason = error instanceof Error ? error : new Error(String(error));
    for (const operation of valid) rejectOperation(operation, reason);
  }
}

/** 完成一个等待中的宿主操作；未知 id 按过期完成事件忽略。 / Completes one pending host operation; unknown ids are ignored as stale completions. */
export function completeHostSceneOperation(
  id: number,
  succeeded: boolean,
  payload: Uint8Array,
): void {
  const operation = pending.get(id);
  if (!operation) return;
  pending.delete(id);
  if (succeeded) operation.resolve(payload);
  else operation.reject(new Error(utf8Decode(payload)));
}

/** 停机时拒绝所有尚未完成的宿主操作并丢弃未提交队列；迟到完成事件会被安全忽略。 / Rejects all unfinished host operations and drops unsubmitted work during shutdown; late completions are safely ignored. */
export function cancelHostSceneOperations(
  reason = "process stopped before host operation completed",
): void {
  queued.splice(0, queued.length);
  queuedPackedBytes = 4;
  const error = new Error(reason);
  for (const deadline of deadlines.values()) {
    hostCancelDeadline(deadline.id);
    deadline.reject(error);
  }
  deadlines.clear();
  unstartedDeadlines.clear();
  for (const operation of pending.values()) operation.reject(error);
  pending.clear();
}

function allocateOperationId(): number {
  for (let attempts = 0; attempts < MAX_PENDING_OPERATIONS; attempts += 1) {
    const id = nextOperationId;
    nextOperationId = (nextOperationId % 0xffff_ffff) + 1;
    if (!pending.has(id)) return id;
  }
  throw new Error("unable to allocate host scene operation id");
}

function resolveRoute(source: SceneConfig, target: SceneConfig): number {
  const key = `${source.name}\0${target.name}\0${target.innerIp}\0${target.port}`;
  const existing = routeIds.get(key);
  if (existing !== undefined) return existing;
  const routeId = hostRegisterSceneRoute(
    source.name,
    target.name,
    target.innerIp,
    target.port,
  );
  routeIds.set(key, routeId);
  return routeId;
}

function packOperations(operations: readonly QueuedOperation[]): Uint8Array {
  let byteLength = 4;
  for (const operation of operations) {
    byteLength += OPERATION_META_BYTES + operation.frameLength;
  }
  const packed = new Uint8Array(byteLength);
  const view = new DataView(packed.buffer);
  view.setUint32(0, operations.length, true);
  let offset = 4;
  for (const operation of operations) {
    view.setUint32(offset, operation.id, true);
    view.setUint32(offset + 4, operation.routeId, true);
    packed[offset + 8] = operation.kind;
    view.setUint32(offset + 9, operation.timeoutMs, true);
    view.setUint32(offset + 13, operation.frameLength, true);
    offset += OPERATION_META_BYTES;
    packed.set(operation.frame, offset);
    offset += operation.frameLength;
  }
  return packed;
}

const hostApi = globalThis as typeof globalThis & {
  __hostRegisterSceneRoute: (
    sourceName: string,
    targetName: string,
    targetIp: string,
    targetPort: number,
  ) => number;
  __hostSubmitSceneOperations: (packed: Uint8Array) => number;
  __hostCreateDeadline: (ms: number) => number;
  __hostWaitDeadline: (id: number) => Promise<void>;
  __hostCancelDeadline: (id: number) => void;
};
const hostRegisterSceneRoute = hostApi.__hostRegisterSceneRoute;
const hostSubmitSceneOperations = hostApi.__hostSubmitSceneOperations;
const hostCreateDeadline = hostApi.__hostCreateDeadline;
const hostWaitDeadline = hostApi.__hostWaitDeadline;
const hostCancelDeadline = hostApi.__hostCancelDeadline;
