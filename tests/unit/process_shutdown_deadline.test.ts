import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installProcessBootstrap } from "../../app/core/process/ProcessBootstrap";
import * as transport from "../../app/core/process/HostSceneTransport";
import type { SceneConfig } from "../../app/core/process/types";

const native = vi.hoisted(() => {
  interface Wait { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }
  const resources = new Map<number, Wait>(), running = new Set<number>();
  const delayedCancellations: Array<() => void> = [];
  let nextId = 1;
  const state = { holdCancellation: false };
  const createResource = (_ms: number) => {
    const id = nextId++;
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
    void promise.catch(() => {});
    resources.set(id, { promise, resolve, reject });
    return id;
  };
  const createCall = vi.fn(createResource), createStop = vi.fn(createResource);
  const wait = vi.fn((id: number) => {
    running.add(id);
    return resources.get(id)!.promise.finally(() => { running.delete(id); });
  });
  const cancel = vi.fn((id: number) => {
    const resource = resources.get(id);
    if (!resource) return;
    resources.delete(id);
    const finish = () => resource.reject(new Error("deadline cancelled"));
    if (state.holdCancellation && running.has(id)) delayedCancellations.push(finish);
    else finish();
  });
  const packets: Uint8Array[] = [];
  const submit = vi.fn((frame: Uint8Array) => { packets.push(frame); return 0; });
  const start = vi.fn(async () => "started"), stop = vi.fn<() => Promise<void>>(async () => {});
  vi.stubGlobal("__hostCreateDeadline", createCall);
  vi.stubGlobal("__hostCreateShutdownDeadline", createStop);
  vi.stubGlobal("__hostWaitDeadline", wait);
  vi.stubGlobal("__hostCancelDeadline", cancel);
  vi.stubGlobal("__hostSubmitSceneOperations", submit);
  vi.stubGlobal("__hostRegisterSceneRoute", vi.fn(() => 1));
  return { resources, running, delayedCancellations, state, createCall, createStop, createResource,
    wait, cancel, submit, packets, start, stop };
});
vi.mock("../../app/core/persistence/PrepareGlobalIds", () => ({ PrepareGlobalIds: async () => undefined }));
vi.mock("../../app/core/process/ProcessRuntime", () => ({ ProcessRuntime: class {
  readonly StopTimeoutMs = 30000;
  start = native.start;
  stop = native.stop;
} }));

const modelExports = {};
const host = globalThis as typeof globalThis & {
  __etsStartProcess(config: string): Promise<string>;
  __etsStopProcess(): Promise<string>;
};
function gate() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
function observe<T>(promise: Promise<T>): Promise<T> { void promise.catch(() => {}); return promise; }
async function microtasks() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
beforeEach(async () => {
  vi.clearAllMocks();
  native.stop.mockReset().mockResolvedValue(undefined);
  native.createStop.mockReset().mockImplementation(native.createResource);
  native.packets.length = 0;
  native.state.holdCancellation = false;
  installProcessBootstrap({ modelExports });
  await host.__etsStartProcess(JSON.stringify({ process: { name: "shutdown" }, scenes: [], knownScenes: [], tickMs: 50 }));
});
afterEach(async () => {
  native.state.holdCancellation = false;
  transport.cancelHostSceneOperations("shutdown fixture cleanup");
  for (const finish of native.delayedCancellations.splice(0)) finish();
  for (const id of native.resources.keys()) native.cancel(id);
  await microtasks();
});

test("fast shutdown closes its reserved deadline without submitting an ordinary timer", async () => {
  await expect(host.__etsStopProcess()).resolves.toBe("stopped");
  expect(native.stop).toHaveBeenCalledOnce();
  expect(native.createStop).toHaveBeenCalledWith(30000);
  expect(native.createCall).not.toHaveBeenCalled();
  expect(native.wait).not.toHaveBeenCalled();
  expect(native.submit).not.toHaveBeenCalled();
  expect(native.resources.size).toBe(0);
});

test("failed shutdown preserves its error and closes the reserved deadline", async () => {
  const failure = new Error("stop hook failed");
  native.stop.mockRejectedValueOnce(failure);
  await expect(host.__etsStopProcess()).rejects.toBe(failure);
  expect(native.createStop).toHaveBeenCalledOnce();
  expect(native.cancel).toHaveBeenCalledOnce();
  expect(native.submit).not.toHaveBeenCalled();
});

test("a full remote queue cannot prematurely terminate a pending shutdown", async () => {
  const pendingStop = gate();
  native.stop.mockReturnValueOnce(pendingStop.promise);
  const source: SceneConfig = { name: "source", sceneType: "ShutdownTest", innerIp: "127.0.0.1", port: 1 };
  const target = { ...source, name: "target", port: 2 }, frame = new Uint8Array([1, 1]);
  for (let i = 0; i < 65536; i++) transport.sendRemoteScene(source, target, frame, 30000);
  let settled = false;
  const result = observe(host.__etsStopProcess().finally(() => { settled = true; }));
  await microtasks();
  expect(settled).toBe(false);
  expect(native.createStop).toHaveBeenCalledOnce();
  transport.flushHostSceneOperations();
  expect(native.packets).toHaveLength(1);
  expect(new DataView(native.packets[0].buffer).getUint32(0, true)).toBe(65536);
  expect(native.wait).toHaveBeenCalledOnce();
  pendingStop.resolve();
  await expect(result).resolves.toBe("stopped");
  expect(native.running.size).toBe(0);
  expect(transport.hostSceneOperationMetrics().hostScenePendingReplies).toBe(0);
});

test("concurrent shutdown callers share one result, stop and reserved deadline", async () => {
  const pendingStop = gate();
  native.stop.mockReturnValue(pendingStop.promise);
  const first = observe(host.__etsStopProcess()), second = observe(host.__etsStopProcess());
  expect(second).toBe(first);
  expect(native.stop).toHaveBeenCalledOnce();
  expect(native.createStop).toHaveBeenCalledOnce();
  pendingStop.resolve();
  await expect(first).resolves.toBe("stopped");
  await expect(second).resolves.toBe("stopped");
});

test("shutdown timeout retains its original message without claiming the stop hook completed", async () => {
  const pendingStop = gate();
  let actualStopFinished = false;
  native.stop.mockReturnValueOnce(pendingStop.promise.then(() => { actualStopFinished = true; }));
  const result = observe(host.__etsStopProcess());
  expect(native.createStop).toHaveBeenCalledOnce();
  transport.flushHostSceneOperations();
  expect(native.wait).toHaveBeenCalledOnce();
  native.resources.values().next().value!.resolve();
  await expect(result).rejects.toThrow("process stop timed out after 30000ms");
  expect(actualStopFinished).toBe(false);
  expect(native.resources.size).toBe(0);
  pendingStop.resolve();
  await microtasks();
  expect(actualStopFinished).toBe(true);
});

test("shutdown waits for an already-started native waiter to actually exit after cancellation", async () => {
  const pendingStop = gate();
  native.stop.mockReturnValueOnce(pendingStop.promise);
  native.state.holdCancellation = true;
  let settled = false;
  const result = observe(host.__etsStopProcess().finally(() => { settled = true; }));
  expect(native.createStop).toHaveBeenCalledOnce();
  transport.flushHostSceneOperations();
  pendingStop.resolve();
  await microtasks();
  expect(native.resources.size).toBe(0);
  expect(native.running.size).toBe(1);
  expect(settled).toBe(false);
  for (const finish of native.delayedCancellations.splice(0)) finish();
  await expect(result).resolves.toBe("stopped");
  expect(native.running.size).toBe(0);
});

test("deadline creation failure still executes and observes real shutdown before reporting failure", async () => {
  const failure = new Error("shutdown deadline unavailable"), pendingStop = gate();
  native.createStop.mockImplementationOnce(() => { throw failure; });
  native.stop.mockReturnValueOnce(pendingStop.promise);
  let settled = false;
  const result = observe(host.__etsStopProcess().finally(() => { settled = true; }));
  expect(native.createStop).toHaveBeenCalledOnce();
  expect(native.stop).toHaveBeenCalledOnce();
  await microtasks();
  expect(settled).toBe(false);
  pendingStop.resolve();
  await expect(result).rejects.toBe(failure);
  expect(native.submit).not.toHaveBeenCalled();
});

test("deadline admission and stop hook failures both remain visible", async () => {
  const admission = new Error("no deadline"), hook = new Error("hook cleanup failed");
  native.createStop.mockImplementationOnce(() => { throw admission; });
  native.stop.mockRejectedValueOnce(hook);
  const result = observe(host.__etsStopProcess());
  expect(native.createStop).toHaveBeenCalledOnce();
  await expect(result).rejects.toMatchObject({ errors: [admission, hook] });
  expect(native.stop).toHaveBeenCalledOnce();
});
