import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as transport from "../../app/core/process/HostSceneTransport";
import { SceneCallContext } from "../../app/core/process/context";
import type { LocalSceneRouter, SceneConfig } from "../../app/core/process/types";
import { ProcessHost } from "../../app/core/runtime/host";
import { SystemErrCode } from "../../app/core/protocol/SystemErrCode";

const native = vi.hoisted(() => {
  type Operation = { id: number; kind: number; length: number; code: number };
  const packets: { count: number; bytes: number; operations: Operation[] }[] = [];
  const submit = vi.fn((packet: Uint8Array) => {
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    const count = view.getUint32(0, true), operations: Operation[] = [];
    let offset = 4;
    for (let i = 0; i < count; i++) {
      const id = view.getUint32(offset, true), kind = packet[offset + 8], length = view.getUint32(offset + 13, true);
      offset += 17;
      operations.push({ id, kind, length, code: length >= 2 ? view.getUint16(offset) : 0 });
      offset += length;
    }
    packets.push({ count, bytes: packet.length, operations });
    return count;
  });
  const route = vi.fn(() => 1), createDeadline = vi.fn(() => 1), waitDeadline = vi.fn(async () => {}), cancelDeadline = vi.fn(() => {});
  vi.stubGlobal("__hostRegisterSceneRoute", route);
  vi.stubGlobal("__hostSubmitSceneOperations", submit);
  vi.stubGlobal("__hostCreateDeadline", createDeadline);
  vi.stubGlobal("__hostWaitDeadline", waitDeadline);
  vi.stubGlobal("__hostCancelDeadline", cancelDeadline);
  return { packets, submit, route, createDeadline, waitDeadline, cancelDeadline };
});
const COUNT = 65536, BYTES = 64 * 1024 * 1024, FRAME = 1024 * 1024;
const full = { code: SystemErrCode.SceneOverloaded };
let nextFixture = 1;
beforeEach(() => { vi.clearAllMocks(); native.packets.length = 0; });
afterEach(() => { transport.cancelHostSceneOperations("admission fixture cleanup"); });
function observe<T>(promise: Promise<T>): Promise<T> { void promise.catch(() => {}); return promise; }
function fixture(local = false) {
  const source: SceneConfig = { name: `source-${nextFixture++}`, sceneType: "Admission", innerIp: "127.0.0.1", port: 1 };
  const target = { ...source, name: `target-${nextFixture++}`, port: 2 };
  const frame = new Uint8Array([0, 1]);
  const router: LocalSceneRouter = { hasLocalScene: () => local, callLocalScene: async () => frame, sendLocalScene: () => {} };
  const context = new SceneCallContext({ process: { name: "admission" }, self: source, knownScenes: [source, target],
    tickMs: 50, processHost: new ProcessHost(), localRouter: router }, router);
  return { source, target, frame, context,
    send: (bytes = frame) => transport.sendRemoteScene(source, target, bytes, 5000),
    call: (bytes = frame) => observe(transport.callRemoteScene(source, target, bytes, 5000)) };
}

test.each(["RPC", "sleep"])("a full one-way queue rejects new %s without invalidating the accepted batch", async kind => {
  const f = fixture();
  const before = transport.hostSceneOperationMetrics();
  for (let i = 0; i < COUNT; i++) f.send();
  const extra = kind === "RPC" ? f.call() : observe(transport.sleepHost(5000));
  transport.flushHostSceneOperations();
  // 先断言批次数量，旧无共同上限的代码不能让反例等待永不完成的 Promise。 / Check the batch before awaiting rejection so the old mixed-capacity bug cannot hang the test.
  expect(native.packets[0].count).toBe(COUNT);
  expect(native.packets[0].operations.every(op => op.kind === 2)).toBe(true);
  await expect(extra).rejects.toMatchObject(full);
  expect(transport.hostSceneOperationMetrics()).toMatchObject({ hostSceneQueuedOperations: 0, hostSceneQueuedBytes: 0,
    hostScenePendingReplies: 0, hostSceneQueueRejections: before.hostSceneQueueRejections + 1,
    hostSceneByteRejections: before.hostSceneByteRejections, hostScenePendingRejections: before.hostScenePendingRejections });
  f.send(); transport.flushHostSceneOperations();
  expect(native.packets[1].count).toBe(1);
});

test("the exact 64 MiB packed boundary includes headers and rejects only later work", async () => {
  const f = fixture(), large = new Uint8Array(FRAME);
  const before = transport.hostSceneOperationMetrics();
  for (let i = 0; i < 63; i++) f.send(large);
  f.send(new Uint8Array(BYTES - 4 - 63 * (FRAME + 17) - 17));
  expect(transport.hostSceneOperationMetrics()).toMatchObject({ hostSceneQueuedOperations: 64, hostSceneQueuedBytes: BYTES });
  const extraCall = f.call(), extraSleep = observe(transport.sleepHost(1));
  expect(() => f.send()).toThrow(expect.objectContaining(full));
  transport.flushHostSceneOperations();
  expect(native.packets[0].bytes).toBe(BYTES);
  expect(native.packets[0].count).toBe(64);
  await expect(extraCall).rejects.toMatchObject(full);
  await expect(extraSleep).rejects.toMatchObject(full);
  expect(transport.hostSceneOperationMetrics()).toMatchObject({ hostSceneByteRejections: before.hostSceneByteRejections + 3,
    hostSceneQueueRejections: before.hostSceneQueueRejections, hostScenePendingRejections: before.hostScenePendingRejections });
  f.send(); transport.flushHostSceneOperations();
  expect(native.packets[1].bytes).toBe(23);
});

test.each([0, 1, FRAME + 1])("invalid %s-byte frames never poison previously accepted work", async length => {
  const f = fixture(), good = f.call();
  const invalid = new Uint8Array(length);
  expect(() => f.send(invalid)).toThrow(/invalid host scene frame length/);
  const bad = f.call(invalid);
  transport.flushHostSceneOperations();
  expect(native.packets[0].count).toBe(1);
  await expect(bad).rejects.toThrow(/invalid host scene frame length/);
  transport.completeHostSceneOperation(native.packets[0].operations[0].id, true, new Uint8Array([7, 8]));
  await expect(good).resolves.toEqual(new Uint8Array([7, 8]));
});

test("pending replies stay bounded across flush while one-way calls keep their own queue budget", async () => {
  const f = fixture();
  for (let i = 0; i < COUNT; i++) f.call();
  transport.flushHostSceneOperations();
  f.send();
  const extra = f.call();
  await expect(extra).rejects.toMatchObject(full);
  await expect(observe(transport.sleepHost(1))).rejects.toMatchObject(full);
  transport.completeHostSceneOperation(native.packets[0].operations[0].id, true, f.frame);
  const replacement = f.call();
  transport.flushHostSceneOperations();
  expect(native.packets[1].operations.map(op => op.kind)).toEqual([2, 1]);
  transport.completeHostSceneOperation(native.packets[1].operations[1].id, true, f.frame);
  await expect(replacement).resolves.toBe(f.frame);
});

test("public remote call and send preserve typed 1011 on shared queue rejection", async () => {
  const f = fixture();
  for (let i = 0; i < COUNT; i++) f.send();
  expect(() => f.context.sendFrame(f.target, f.frame)).toThrow(expect.objectContaining(full));
  const extra = observe(f.context.callFrame(f.target, f.frame));
  transport.flushHostSceneOperations();
  expect(native.packets[0].count).toBe(COUNT);
  await expect(extra).rejects.toMatchObject(full);
});

test("route creation failure does not consume or discard other queued work", async () => {
  const f = fixture(), other = fixture(), first = f.call();
  const failure = new Error("route registration refused");
  native.route.mockImplementationOnce(() => { throw failure; });
  await expect(other.call()).rejects.toBe(failure);
  transport.flushHostSceneOperations();
  expect(native.packets[0].count).toBe(1);
  transport.completeHostSceneOperation(native.packets[0].operations[0].id, true, f.frame);
  await expect(first).resolves.toBe(f.frame);
});

test("submission failure releases queue and pending waiters so a new batch can complete", async () => {
  const before = transport.hostSceneOperationMetrics();
  const f = fixture(), call = f.call(), sleep = observe(transport.sleepHost(1));
  f.send();
  const failure = new Error("host submission failed");
  native.submit.mockImplementationOnce(() => { throw failure; });
  transport.flushHostSceneOperations();
  await expect(call).rejects.toBe(failure);
  await expect(sleep).rejects.toBe(failure);
  expect(transport.hostSceneOperationMetrics()).toMatchObject({ hostSceneQueuedOperations: 0, hostSceneQueuedBytes: 0,
    hostScenePendingReplies: 0, hostSceneSubmitFailures: before.hostSceneSubmitFailures + 1 });
  const retry = f.call(); transport.flushHostSceneOperations();
  expect(native.packets[0].count).toBe(1);
  transport.completeHostSceneOperation(native.packets[0].operations[0].id, true, f.frame);
  await expect(retry).resolves.toBe(f.frame);
});

test("a detached borrowed frame cannot invalidate other accepted operations", async () => {
  const before = transport.hostSceneOperationMetrics();
  const f = fixture(), first = f.call();
  const buffer = new ArrayBuffer(2), frame = new Uint8Array(buffer);
  const invalid = f.call(frame); f.send(frame);
  const last = f.call(new Uint8Array([0, 3]));
  structuredClone(buffer, { transfer: [buffer] });
  transport.flushHostSceneOperations();
  expect(native.packets[0].operations.map(op => op.code)).toEqual([1, 3]);
  await expect(invalid).rejects.toThrow(/host scene frame/);
  for (const op of native.packets[0].operations) transport.completeHostSceneOperation(op.id, true, f.frame);
  await expect(first).resolves.toBe(f.frame);
  await expect(last).resolves.toBe(f.frame);
  expect(transport.hostSceneOperationMetrics()).toMatchObject({ hostSceneInvalidFrames: before.hostSceneInvalidFrames + 2,
    hostSceneSubmitFailures: before.hostSceneSubmitFailures, hostScenePendingReplies: 0 });
});

test("a full remote queue does not prevent a local deadline from releasing", async () => {
  const f = fixture(), local = fixture(true);
  for (let i = 0; i < COUNT; i++) f.send();
  await expect(local.context.callFrame(local.target, local.frame, { timeoutMs: 5 })).resolves.toBe(local.frame);
  expect(native.createDeadline).toHaveBeenCalledTimes(1);
  expect(native.cancelDeadline).toHaveBeenCalledTimes(1);
  expect(native.waitDeadline).not.toHaveBeenCalled();
  transport.flushHostSceneOperations();
  expect(native.packets[0].count).toBe(COUNT);
});

test("queue accounting ends on flush while reply accounting ends on completion or shutdown", async () => {
  const f = fixture(), call = f.call(), sleep = observe(transport.sleepHost(1));
  f.send();
  expect(transport.hostSceneOperationMetrics()).toMatchObject({ hostSceneQueuedOperations: 3, hostSceneQueuedBytes: 59,
    hostScenePendingReplies: 2, hostSceneQueueCapacity: COUNT, hostSceneQueueByteCapacity: BYTES, hostScenePendingCapacity: COUNT });
  transport.flushHostSceneOperations();
  expect(transport.hostSceneOperationMetrics()).toMatchObject({ hostSceneQueuedOperations: 0, hostSceneQueuedBytes: 0, hostScenePendingReplies: 2 });
  transport.completeHostSceneOperation(native.packets[0].operations[0].id, true, f.frame);
  await call;
  expect(transport.hostSceneOperationMetrics().hostScenePendingReplies).toBe(1);
  const queued = f.call();
  transport.cancelHostSceneOperations("accounting shutdown");
  await expect(sleep).rejects.toThrow("accounting shutdown");
  await expect(queued).rejects.toThrow("accounting shutdown");
  expect(transport.hostSceneOperationMetrics()).toMatchObject({ hostSceneQueuedOperations: 0, hostSceneQueuedBytes: 0, hostScenePendingReplies: 0 });
});
