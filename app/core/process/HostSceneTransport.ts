import type { SceneConfig } from "./types";
import { utf8Decode } from "../protocol/binary";

const MAX_PENDING_OPERATIONS = 65_536;
const OPERATION_META_BYTES = 17;

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
}

const routeIds = new Map<string, number>();
const pending = new Map<number, PendingOperation>();
const queued: QueuedOperation[] = [];
let nextOperationId = 1;

export function callRemoteScene(
  source: SceneConfig,
  target: SceneConfig,
  frame: Uint8Array,
  timeoutMs: number,
): Promise<Uint8Array> {
  return enqueue(source, target, frame, timeoutMs, 1);
}

export function sendRemoteScene(
  source: SceneConfig,
  target: SceneConfig,
  frame: Uint8Array,
  timeoutMs: number,
): Promise<void> {
  if (queued.length >= MAX_PENDING_OPERATIONS) {
    return Promise.reject(new Error("host scene operation queue limit reached"));
  }
  queued.push({
    id: 0,
    routeId: resolveRoute(source, target),
    kind: 2,
    timeoutMs: Math.max(1, Math.min(timeoutMs, 0xffff_ffff)),
    frame,
  });
  return Promise.resolve();
}

export function sleepHost(ms: number): Promise<void> {
  if (pending.size >= MAX_PENDING_OPERATIONS) {
    return Promise.reject(new Error("host async operation limit reached"));
  }
  const id = allocateOperationId();
  const promise = new Promise<Uint8Array>((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
  queued.push({
    id,
    routeId: 0,
    kind: 3,
    timeoutMs: Math.max(0, Math.min(ms, 0xffff_ffff)),
    frame: new Uint8Array(0),
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
  if (pending.size >= MAX_PENDING_OPERATIONS) {
    return Promise.reject(new Error("host scene operation limit reached"));
  }
  const id = allocateOperationId();
  const routeId = resolveRoute(source, target);
  const promise = new Promise<Uint8Array>((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
  queued.push({
    id,
    routeId,
    kind,
    timeoutMs: Math.max(1, Math.min(timeoutMs, 0xffff_ffff)),
    frame,
  });
  return promise;
}

export function flushHostSceneOperations(): void {
  if (queued.length === 0) return;
  const operations = queued.splice(0, queued.length);
  try {
    hostSubmitSceneOperations(packOperations(operations));
  } catch (error) {
    const reason = error instanceof Error ? error : new Error(String(error));
    for (const operation of operations) {
      if (operation.id !== 0) {
        pending.get(operation.id)?.reject(reason);
        pending.delete(operation.id);
      }
    }
  }
}

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

function allocateOperationId(): number {
  for (let attempts = 0; attempts < MAX_PENDING_OPERATIONS; attempts += 1) {
    const id = nextOperationId;
    nextOperationId = (nextOperationId % 0xffff_ffff) + 1;
    if (!pending.has(id)) return id;
  }
  throw new Error("unable to allocate host scene operation id");
}

function resolveRoute(source: SceneConfig, target: SceneConfig): number {
  const key = `${source.name}\0${target.name}\0${target.ip}\0${target.port}`;
  const existing = routeIds.get(key);
  if (existing !== undefined) return existing;
  const routeId = hostRegisterSceneRoute(
    source.name,
    target.name,
    target.ip,
    target.port,
  );
  routeIds.set(key, routeId);
  return routeId;
}

function packOperations(operations: readonly QueuedOperation[]): Uint8Array {
  let byteLength = 4;
  for (const operation of operations) {
    byteLength += OPERATION_META_BYTES + operation.frame.length;
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
    view.setUint32(offset + 13, operation.frame.length, true);
    offset += OPERATION_META_BYTES;
    packed.set(operation.frame, offset);
    offset += operation.frame.length;
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
};
const hostRegisterSceneRoute = hostApi.__hostRegisterSceneRoute;
const hostSubmitSceneOperations = hostApi.__hostSubmitSceneOperations;
