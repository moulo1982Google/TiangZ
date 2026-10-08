import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as transport from "../../app/core/process/HostSceneTransport";
import type { SceneConfig } from "../../app/core/process/types";

const native = vi.hoisted(() => {
  const state = { now: 1000 };
  const route = vi.fn(() => 1);
  const packets: Array<{ sampledAtMs: number; operations: Array<{ id: number; kind: number; ms: number; frame: Uint8Array }> }> = [];
  const submit = vi.fn((packed: Uint8Array, sampledAtMs: number) => {
    const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength), operations = [];
    let offset = 4;
    for (let i = 0; i < view.getUint32(0, true); i++) {
      const length = view.getUint32(offset + 13, true);
      operations.push({ id: view.getUint32(offset, true), kind: packed[offset + 8], ms: view.getUint32(offset + 9, true),
        frame: packed.slice(offset + 17, offset + 17 + length) });
      offset += 17 + length;
    }
    packets.push({ sampledAtMs, operations });
    return operations.length;
  });
  vi.stubGlobal("__hostSceneNowMs", () => state.now);
  vi.stubGlobal("__hostRegisterSceneRoute", route);
  vi.stubGlobal("__hostSubmitSceneOperations", submit);
  return { state, route, packets, submit };
});
let fixtureId = 0;
function fixture() {
  const source: SceneConfig = { name: `deadline-source-${++fixtureId}`, sceneType: "Deadline", innerIp: "127.0.0.1", port: 1 };
  const target = { ...source, name: `deadline-target-${fixtureId}`, port: 2 }, frame = new Uint8Array([1, 2]);
  return { frame, call: (ms: number, bytes = frame) => observe(transport.callRemoteScene(source, target, bytes, ms)),
    send: (ms: number) => transport.sendRemoteScene(source, target, frame, ms) };
}
function observe<T>(promise: Promise<T>): Promise<T> { void promise.catch(() => {}); return promise; }
function completePacket() {
  for (const operation of native.packets[0].operations) {
    if (operation.id) transport.completeHostSceneOperation(operation.id, true, operation.frame);
  }
}
beforeEach(() => {
  vi.clearAllMocks();
  native.route.mockReset().mockReturnValue(1);
  native.state.now = 1000;
  native.packets.length = 0;
});
afterEach(() => { transport.cancelHostSceneOperations("deadline fixture cleanup"); vi.restoreAllMocks(); });

test("all remote kinds subtract TS queue time and preserve the batch clock through submission", async () => {
  const f = fixture(), call = f.call(100), sleep = observe(transport.sleepHost(100));
  f.send(100);
  native.state.now = 1025;
  transport.flushHostSceneOperations();
  expect(native.packets[0].sampledAtMs).toBe(1025);
  expect(native.packets[0].operations.map(item => [item.kind, item.ms])).toEqual([[1, 75], [3, 75], [2, 75]]);
  completePacket();
  await expect(call).resolves.toEqual(f.frame);
  await expect(sleep).resolves.toBeUndefined();
});

test("expired calls and sends do not reach Rust or discard a later live operation", async () => {
  const f = fixture(), expired = f.call(20);
  f.send(20);
  const live = f.call(100), before = transport.hostSceneOperationMetrics();
  native.state.now = 1030;
  transport.flushHostSceneOperations();
  expect(native.packets[0].operations).toHaveLength(1);
  expect(native.packets[0].operations[0].ms).toBe(70);
  await expect(expired).rejects.toThrow(/expired|timed out/);
  expect(transport.hostSceneOperationMetrics()).toMatchObject({ hostSceneQueueTimeouts: before.hostSceneQueueTimeouts + 2,
    hostScenePendingReplies: 1, hostSceneQueuedOperations: 0, hostSceneQueuedBytes: 0 });
  completePacket();
  await expect(live).resolves.toEqual(f.frame);
});

test("a host sleep that expired in the TS queue completes without another timer", async () => {
  const before = transport.hostSceneOperationMetrics(), sleep = observe(transport.sleepHost(20));
  native.state.now = 1020;
  transport.flushHostSceneOperations();
  expect(native.submit).not.toHaveBeenCalled();
  await expect(sleep).resolves.toBeUndefined();
  expect(transport.hostSceneOperationMetrics()).toMatchObject({ hostSceneQueueTimeouts: before.hostSceneQueueTimeouts,
    hostScenePendingReplies: 0, hostSceneQueuedOperations: 0 });
});

test("wall clock changes cannot extend a remote operation budget", async () => {
  vi.spyOn(Date, "now").mockReturnValue(9000000000000);
  const f = fixture(), call = f.call(100);
  vi.spyOn(Date, "now").mockReturnValue(0);
  native.state.now = 1010;
  transport.flushHostSceneOperations();
  expect(native.packets[0].operations[0].ms).toBe(90);
  completePacket();
  await call;
});

test("route registration is inside the accepted operation deadline", async () => {
  native.route.mockImplementationOnce(() => { native.state.now += 20; return 1; });
  const f = fixture(), call = f.call(100);
  native.state.now += 5;
  transport.flushHostSceneOperations();
  expect(native.packets[0].operations[0].ms).toBe(75);
  completePacket();
  await call;
});

test("deadline conversion retains the original integer wire behavior and native minima", async () => {
  const f = fixture(), first = f.call(Number.NaN), second = f.call(12.9), sleep = observe(transport.sleepHost(Number.NaN));
  f.send(0);
  transport.flushHostSceneOperations();
  expect(native.packets[0].operations.map(item => [item.kind, item.ms])).toEqual([[1, 1], [1, 12], [2, 1]]);
  completePacket();
  await Promise.all([first, second, sleep]);
});

test("invalid borrowed frames and expired neighbors each fail without damaging a valid frame", async () => {
  const f = fixture(), bytes = new Uint8Array([3, 4]), invalid = f.call(100, bytes), expired = f.call(10), live = f.call(100);
  structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
  native.state.now = 1020;
  transport.flushHostSceneOperations();
  expect(native.packets[0].operations).toHaveLength(1);
  await expect(invalid).rejects.toThrow(/frame changed/);
  await expect(expired).rejects.toThrow(/expired|timed out/);
  completePacket();
  await expect(live).resolves.toEqual(f.frame);
});

test("an invalid native clock fails before route or reply admission instead of using a wall clock", async () => {
  native.state.now = Number.NaN;
  const f = fixture(), call = f.call(100), sleep = observe(transport.sleepHost(100));
  expect(() => f.send(100)).toThrow(/clock/);
  expect(native.route).not.toHaveBeenCalled();
  expect(transport.hostSceneOperationMetrics()).toMatchObject({ hostScenePendingReplies: 0, hostSceneQueuedOperations: 0 });
  await expect(call).rejects.toThrow(/clock/);
  await expect(sleep).rejects.toThrow(/clock/);
});
