import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SceneCallContext } from "../../app/core/process/context";
import { cancelHostSceneOperations, flushHostSceneOperations } from "../../app/core/process/HostSceneTransport";
import type { LocalSceneRouter, SceneConfig } from "../../app/core/process/types";
import { RpcError } from "../../app/core/protocol/RpcError";
import { SystemErrCode } from "../../app/core/protocol/SystemErrCode";
import { ProcessHost } from "../../app/core/runtime/host";
import { EntryScene } from "../../app/core/process/EntryScene";
import { ProcessRuntime } from "../../app/core/process/ProcessRuntime";
import { entryScene } from "../../app/core/process/registry";
import type { RuntimeEntrySceneConfig } from "../../app/core/process/types";
import type { Codec, IRequest, IResponse } from "../../app/core/protocol/message";
import { defineRpc } from "../../app/core/protocol/rpc";

const native = vi.hoisted(() => {
  interface Wait { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }
  const resources = new Map<number, Wait>();
  let nextId = 1;
  const create = vi.fn((_ms: number) => {
    const id = nextId++;
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
    void promise.catch(() => {});
    resources.set(id, { promise, resolve, reject });
    return id;
  });
  const wait = vi.fn((id: number) => resources.get(id)!.promise);
  const cancel = vi.fn((id: number) => {
    resources.get(id)?.reject(new Error("deadline cancelled"));
    resources.delete(id);
  });
  const submit = vi.fn((_frame: Uint8Array) => 0);
  vi.stubGlobal("__hostCreateDeadline", create);
  vi.stubGlobal("__hostWaitDeadline", wait);
  vi.stubGlobal("__hostCancelDeadline", cancel);
  vi.stubGlobal("__hostSubmitSceneOperations", submit);
  return { create, wait, cancel, submit, resources };
});
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => {
  cancelHostSceneOperations();
  for (const [id, resource] of native.resources) { resource.reject(new Error("fixture cleanup")); native.resources.delete(id); }
});

function fixture(run: () => Promise<Uint8Array> = async () => new Uint8Array([1, 2])) {
  const source: SceneConfig = { name: "source", sceneType: "DeadlineTest", innerIp: "127.0.0.1", port: 1 };
  const target = { ...source, name: "target", port: 2 };
  const invoke = vi.fn(run);
  const router: LocalSceneRouter = { hasLocalScene: () => true, callLocalScene: invoke, sendLocalScene: () => undefined };
  const context = new SceneCallContext({ process: { name: "deadline" }, self: source, knownScenes: [source, target],
    tickMs: 50, processHost: new ProcessHost(), localRouter: router }, router);
  return { context, target, invoke, call: () => context.callFrame(target, new Uint8Array([1, 1]), { timeoutMs: 30000 }) };
}
async function microtasks() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

test("successful local calls release deadlines instead of submitting abandoned host timers", async () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) await expect(f.call()).resolves.toEqual(new Uint8Array([1, 2]));
  flushHostSceneOperations();
  expect(native.submit).not.toHaveBeenCalled();
  expect(native.resources.size).toBe(0);
  expect(native.cancel).toHaveBeenCalledTimes(100);
  expect(native.wait).not.toHaveBeenCalled();
});

test("local rejection preserves overload and releases only its own deadline", async () => {
  const error = new RpcError(SystemErrCode.SceneOverloaded, "full");
  const f = fixture(async () => { throw error; });
  await expect(f.call()).rejects.toBe(error);
  flushHostSceneOperations();
  expect(native.submit).not.toHaveBeenCalled();
  expect(native.resources.size).toBe(0);
  expect(native.cancel).toHaveBeenCalledTimes(1);
});

test("deadline admission failure does not start the local target", async () => {
  native.create.mockImplementationOnce(() => { throw new Error("[scene-overloaded] deadline capacity full"); });
  const f = fixture();
  await expect(f.call()).rejects.toMatchObject({ code: SystemErrCode.SceneOverloaded });
  expect(f.invoke).not.toHaveBeenCalled();
  expect(native.resources.size).toBe(0);
});

test("deferred wait setup failure closes its resource without pretending to cancel started work", async () => {
  native.wait.mockImplementationOnce(id => {
    // 创建后等待者尚未移交时，夹具仍观察自己的 Promise。 / Observe the fixture promise when wait setup fails before handoff.
    void native.resources.get(id)!.promise.catch(() => {});
    throw new Error("wait registration failed");
  });
  let release!: (value: Uint8Array) => void;
  const f = fixture(() => new Promise(resolve => { release = resolve; }));
  const call = f.call();
  try {
    flushHostSceneOperations();
    await expect(call).rejects.toThrow("wait registration failed");
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(native.resources.size).toBe(0);
  } finally { release(new Uint8Array([1, 2])); }
});

test("caller waits for actual native cancellation before returning a fast result", async () => {
  let cancelledId: number | undefined;
  native.cancel.mockImplementationOnce(id => { cancelledId = id; });
  let release!: (value: Uint8Array) => void;
  let finished = false;
  const call = fixture(() => new Promise(resolve => { release = resolve; })).call().then(value => { finished = true; return value; });
  try {
    flushHostSceneOperations();
    release(new Uint8Array([1, 2]));
    await microtasks();
    expect(native.cancel).toHaveBeenCalledTimes(1);
    expect(finished).toBe(false);
    expect(native.resources.size).toBe(1);
  } finally {
    release(new Uint8Array([1, 2]));
    if (cancelledId !== undefined) {
      native.resources.get(cancelledId)!.reject(new Error("cancel completed"));
      native.resources.delete(cancelledId);
    }
    await call;
  }
  expect(finished).toBe(true);
});

test("local calls without an explicit timeout do not allocate a deadline", async () => {
  const f = fixture();
  await expect(f.context.callFrame(f.target, new Uint8Array([1, 1]))).resolves.toBeDefined();
  expect(native.create).not.toHaveBeenCalled();
  expect(native.submit).not.toHaveBeenCalled();
});

test.each([[12.5, 12], [0, 1], [Infinity, 0xffff_ffff], [NaN, 0]])("local deadline keeps the previous packed uint32 conversion (%s -> %s)", async (input, encoded) => {
  const f = fixture();
  await f.context.callFrame(f.target, new Uint8Array([1, 1]), { timeoutMs: input });
  expect(native.create).toHaveBeenCalledWith(encoded);
});

test.each([false, true])("shutdown rejects deadline waits and closes owned resources (started=%s)", async started => {
  let release!: (value: Uint8Array) => void;
  const f = fixture(() => new Promise(resolve => { release = resolve; }));
  const call = f.call();
  try {
    if (started) flushHostSceneOperations();
    cancelHostSceneOperations("deadline fixture stopped");
    await expect(call).rejects.toThrow("deadline fixture stopped");
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(native.resources.size).toBe(0);
    flushHostSceneOperations();
    expect(native.wait).toHaveBeenCalledTimes(started ? 1 : 0);
  } finally { release(new Uint8Array([1, 2])); }
});

// 这里验证实际 mailbox 所有权；真实协议由宿主夹具生成。 / Tests actual mailbox ownership here; host fixtures generate real protocols separately.
const jsonCodec = <T>(): Codec<T> => ({ encode: value => new TextEncoder().encode(JSON.stringify(value)),
  decode: bytes => (bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : {}) as T });
const Work = defineRpc({ name: "DeadlineLifecycle.Work", requestCode: 61220, responseCode: 61221,
  requestCodec: jsonCodec<IRequest & { value: number }>(), responseCodec: jsonCodec<IResponse & { value: number }>() });
let scenes: DeadlineScene[] = [];
@entryScene("DeadlineLifecycle")
class DeadlineScene extends EntryScene {
  gate: Promise<void> | undefined;
  seen: number[] = [];
  constructor(config: RuntimeEntrySceneConfig) { super(config, [Work], []); }
  protected override onStart(): void { scenes.push(this); }
  protected override registerHandlers(): void {
    this.registry.register(Work.requestCode, { responseCode: Work.responseCode,
      decode: Work.requestCodec.decode, encode: Work.responseCodec.encode,
      handle: request => {
        this.seen.push(request.value);
        return request.value === 1 && this.gate ? this.gate.then(() => ({ value: request.value })) : { value: request.value };
      } });
  }
}

test("local timeout releases its deadline but retains actual ordered work and hotfix drain", async () => {
  scenes = [];
  const configs = ["source", "target"].map((name, i) => ({ name, sceneType: "DeadlineLifecycle", innerIp: "127.0.0.1", ip: "127.0.0.1", port: 13000 + i }));
  const runtime = new ProcessRuntime({ process: { name: "deadline-lifecycle" }, scenes: configs, knownScenes: configs, tickMs: 50 });
  await runtime.start();
  const [source, target] = scenes;
  const host = Reflect.get(runtime, "processHost") as ProcessHost;
  let release!: () => void;
  target.gate = new Promise<void>(resolve => { release = resolve; });
  const first = source.scenes.call(target.self, Work, { value: 1 }, { timeoutMs: 1 });
  void first.catch(() => {});
  let second: Promise<unknown> | undefined;
  try {
    await microtasks();
    expect(native.resources.size).toBe(1);
    flushHostSceneOperations();
    native.resources.values().next().value!.resolve();
    await expect(first).rejects.toMatchObject({ code: SystemErrCode.SceneCallFailed, message: "local scene call to target timed out after 1ms" });
    expect(native.resources.size).toBe(0);
    expect(host.LocalSceneMailboxPendingCount).toBe(1);
    expect(runtime.CanCommitHotfix).toBe(false);
    second = source.scenes.call(target.self, Work, { value: 2 });
    await microtasks();
    expect(target.seen).toEqual([1]);
    expect(host.LocalSceneMailboxPendingCount).toBe(2);
    release();
    await expect(second).resolves.toMatchObject({ value: 2 });
    expect(target.seen).toEqual([1, 2]);
    expect(host.LocalSceneMailboxPendingCount).toBe(0);
    expect(runtime.CanCommitHotfix).toBe(true);
  } finally {
    release();
    await first.catch(() => {});
    await second;
    await runtime.stop();
  }
});
