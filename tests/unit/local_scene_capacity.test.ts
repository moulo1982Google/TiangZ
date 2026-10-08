import { expect, test } from "vitest";
import { EntryScene } from "../../app/core/process/EntryScene";
import { ProcessRuntime } from "../../app/core/process/ProcessRuntime";
import { entryScene } from "../../app/core/process/registry";
import type { RuntimeEntrySceneConfig } from "../../app/core/process/types";
import { defineMessage, type Codec, type IRequest, type IResponse } from "../../app/core/protocol/message";
import { packFrame } from "../../app/core/protocol/registry";
import { defineRpc } from "../../app/core/protocol/rpc";
import { SystemErrCode } from "../../app/core/protocol/SystemErrCode";
import { ProcessHost } from "../../app/core/runtime/host";

// 单元夹具不代替真实生成协议验收。 / Unit fixture codecs do not replace generated-protocol runtime acceptance.
const codec = <T>(): Codec<T> => ({ encode: value => new TextEncoder().encode(JSON.stringify(value)),
  decode: bytes => (bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : {}) as T });
interface Request extends IRequest { value: number }
interface Response extends IResponse { value: number }
const Work = defineRpc({ name: "LocalCapacity.Work", requestCode: 61200, responseCode: 61201,
  requestCodec: codec<Request>(), responseCodec: codec<Response>() });
const Message = defineMessage({ name: "LocalCapacity.Message", msgcode: 61202, codec: codec<{ value: number }>() });
const frame = (value: number) => packFrame(Work.requestCode, Work.requestCodec.encode({ value, rpcId: value + 1 }));
const sendFrame = (value: number) => packFrame(Message.msgcode, Message.codec.encode({ value }));
const overloaded = { code: SystemErrCode.SceneOverloaded };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

let started: CapacityScene[] = [];
@entryScene("LocalSceneCapacity")
class CapacityScene extends EntryScene {
  readonly seen: number[] = [];
  readonly waits = new Map<number, Promise<void>>();
  encodeFailure: Error | undefined;
  constructor(config: RuntimeEntrySceneConfig) { super(config, [Work], [Message]); }
  protected override onStart(): void { started.push(this); }
  protected override registerHandlers(): void {
    const run = (value: number) => { this.seen.push(value); return this.waits.get(value); };
    this.registry.register(Work.requestCode, { responseCode: Work.responseCode, decode: Work.requestCodec.decode,
      encode: (response: Response) => { if (this.encodeFailure) throw this.encodeFailure; return Work.responseCodec.encode(response); },
      handle: request => { const wait = run(request.value); return wait ? wait.then(() => ({ value: request.value })) : { value: request.value }; } });
    this.registry.registerMessage(Message.msgcode, { decode: Message.codec.decode, handle: message => run(message.value) });
  }
}
@entryScene("UnorderedLocalSceneCapacity")
class UnorderedCapacityScene extends CapacityScene {
  protected override readonly mailbox = "unordered" as const;
}
async function fixture(unordered = false, count = 5) {
  started = [];
  const configs = Array.from({ length: count }, (_, i) => ({ name: `local-${i}`, sceneType: unordered ? "UnorderedLocalSceneCapacity" : "LocalSceneCapacity", ip: "127.0.0.1", innerIp: "127.0.0.1", port: 12345 + i }));
  const runtime = new ProcessRuntime({ process: { name: "local-scene-capacity" }, scenes: configs, knownScenes: configs, tickMs: 50 });
  await runtime.start();
  return { runtime, scenes: [...started], host: Reflect.get(runtime, "processHost") as ProcessHost };
}

test("ordered local RPC and void work share a cap, preserve FIFO and release on target completion", async () => {
  const f = await fixture(), gate = deferred(), target = f.scenes[0];
  target.waits.set(0, gate.promise);
  const first = target.dispatchLocalCall(frame(0)), pending: Promise<unknown>[] = [];
  try {
    for (let i = 1; i < 4096; i++) {
      if (i % 2) expect(target.dispatchLocalSend(sendFrame(i))).toBeUndefined();
      else pending.push(target.dispatchLocalCall(frame(i)));
    }
    const refused = target.dispatchLocalCall(frame(5000));
    pending.push(refused.catch(error => error));
    // 先验证未入队，再等待拒绝；旧无上限实现不能让反例卡住整个用例。 / Check admission before awaiting rejection so the unbounded baseline cannot hang the counterexample.
    expect(target.mailboxMetricsSnapshot().queuedDepth).toBe(4095);
    await expect(refused).rejects.toMatchObject(overloaded);
    expect(() => target.dispatchLocalSend(sendFrame(5001))).toThrow(expect.objectContaining(overloaded));
    expect(target.mailboxMetricsSnapshot().queuedDepth).toBe(4095);
    expect(target.seen).toEqual([0]);
    await f.scenes[1].dispatchLocalCall(frame(8));
    expect(f.host.LocalSceneMailboxPendingCount).toBe(4096);
    expect(f.runtime.CanCommitHotfix).toBe(false);
    gate.resolve(); await first; await Promise.all(pending);
    expect(target.seen).toEqual(Array.from({ length: 4096 }, (_, i) => i));
    expect(f.host.LocalSceneMailboxPendingCount).toBe(0);
    expect(f.runtime.CanCommitHotfix).toBe(true);
    expect((await f.runtime.update(false, true)).game).toMatchObject({ localSceneMailboxInFlight: 0,
      localSceneMailboxCapacity: 16384, localSceneMailboxPerSceneCapacity: 4096, localSceneMailboxMaxInFlight: 4097,
      localSceneMailboxSceneRejections: 2, localSceneMailboxProcessRejections: 0 });
  } finally { gate.resolve(); await first; await Promise.all(pending); await f.runtime.stop(); }
});

test.each([false, true])("unordered local work frees one slot only after the real result (void=%s)", async oneWay => {
  const f = await fixture(true), first = deferred(), rest = deferred(), target = f.scenes[0];
  target.waits.set(0, first.promise); target.waits.set(1, rest.promise);
  const invoke = (value: number) => oneWay ? target.dispatchLocalSend(sendFrame(value)) : target.dispatchLocalCall(frame(value));
  const pending = [Promise.resolve(invoke(0))];
  try {
    for (let i = 1; i < 4096; i++) pending.push(Promise.resolve(invoke(1)));
    expect(() => target.dispatchLocalSend(sendFrame(2))).toThrow(expect.objectContaining(overloaded));
    first.resolve(); await pending[0];
    expect(f.host.LocalSceneMailboxPendingCount).toBe(4095);
    pending.push(Promise.resolve(invoke(1)));
    await expect(target.dispatchLocalCall(frame(2))).rejects.toMatchObject(overloaded);
    expect(target.seen).not.toContain(2);
    rest.resolve(); await Promise.all(pending);
    expect(f.host.LocalSceneMailboxPendingCount).toBe(0);
  } finally { first.resolve(); rest.resolve(); await Promise.all(pending); await f.runtime.stop(); }
});

test("multiple local Scenes cannot bypass Process capacity and disposed running calls retain their slots", async () => {
  const f = await fixture(true), first = deferred(), rest = deferred(), pending: Promise<unknown>[] = [];
  try {
    for (let s = 0; s < 4; s++) {
      const target = f.scenes[s]; target.waits.set(0, first.promise); target.waits.set(1, rest.promise);
      for (let i = 0; i < 4096; i++) pending.push(target.dispatchLocalCall(frame(s === 0 && i === 0 ? 0 : 1)).catch(error => error));
    }
    await expect(f.scenes[4].dispatchLocalCall(frame(2))).rejects.toMatchObject(overloaded);
    for (let s = 0; s < 4; s++) f.host.despawnScene(`local-${s}`);
    expect(f.host.LocalSceneMailboxPendingCount).toBe(16384);
    expect(() => f.scenes[4].dispatchLocalSend(sendFrame(2))).toThrow(expect.objectContaining(overloaded));
    expect((await f.runtime.update(false, true)).pendingAsync).toBe(true);
    first.resolve(); await pending[0];
    expect(f.host.LocalSceneMailboxPendingCount).toBe(16383);
    f.scenes[4].waits.set(1, rest.promise);
    pending.push(f.scenes[4].dispatchLocalCall(frame(1)));
    await expect(f.scenes[4].dispatchLocalCall(frame(2))).rejects.toMatchObject(overloaded);
    expect((await f.runtime.update(false, true)).game).toMatchObject({ localSceneMailboxInFlight: 16384,
      localSceneMailboxMaxInFlight: 16384, localSceneMailboxSceneRejections: 0, localSceneMailboxProcessRejections: 3 });
    rest.resolve(); await Promise.all(pending);
    expect(f.host.LocalSceneMailboxPendingCount).toBe(0);
    await f.scenes[4].dispatchLocalCall(frame(2));
    expect(f.scenes[4].seen).toEqual([1, 2]);
  } finally { first.resolve(); rest.resolve(); await Promise.all(pending); await f.runtime.stop(); }
});

test("disposing an ordered Scene releases unexecuted void and RPC nodes but not its running call", async () => {
  const f = await fixture(), gate = deferred(), target = f.scenes[0]; target.waits.set(0, gate.promise);
  const running = target.dispatchLocalCall(frame(0)).catch(error => error);
  const pending: Promise<unknown>[] = [];
  for (let i = 1; i < 4096; i++) {
    if (i % 2) target.dispatchLocalSend(sendFrame(i));
    else pending.push(target.dispatchLocalCall(frame(i)).catch(error => error));
  }
  try {
    f.host.despawnScene("local-0");
    expect(f.host.LocalSceneMailboxPendingCount).toBe(1);
    expect(target.mailboxMetricsSnapshot().queuedDepth).toBe(0);
    expect(target.seen).toEqual([0]);
    for (const result of await Promise.all(pending)) expect(result).toMatchObject({ code: SystemErrCode.SceneNotFound });
    await expect(target.dispatchLocalCall(frame(5000))).rejects.toMatchObject({ code: SystemErrCode.SceneNotFound });
    gate.resolve(); expect(await running).toMatchObject({ code: SystemErrCode.SceneNotFound });
    expect(f.host.LocalSceneMailboxPendingCount).toBe(0);
    expect(Reflect.get(target, "recycledMailboxTasks")).toHaveLength(0);
  } finally { gate.resolve(); await running; await Promise.all(pending); await f.runtime.stop(); }
});

test("synchronous response encoding failure releases admission exactly once and the same Scene can retry", async () => {
  const f = await fixture(), target = f.scenes[0], failure = new Error("controlled encoder failure");
  try {
    target.encodeFailure = failure;
    await expect(target.dispatchLocalCall(frame(1))).rejects.toBe(failure);
    expect(f.host.LocalSceneMailboxPendingCount).toBe(0);
    target.encodeFailure = undefined;
    expect(Work.responseCodec.decode((await target.dispatchLocalCall(frame(2))).subarray(2))).toMatchObject({ value: 2, rpcId: 3, error: 0 });
    expect(f.host.LocalSceneMailboxPendingCount).toBe(0);
  } finally { target.encodeFailure = undefined; await f.runtime.stop(); }
});

test("public Scene call and send preserve local admission errors and do not execute rejected handlers", async () => {
  const f = await fixture(true), gate = deferred(), target = f.scenes[0], source = f.scenes[1];
  target.waits.set(0, gate.promise);
  const pending = Array.from({ length: 4096 }, () => target.dispatchLocalCall(frame(0)));
  try {
    await expect(source.scenes.call(source.scenes.byName("local-0"), Work, { value: 2 })).rejects.toMatchObject(overloaded);
    expect(() => source.scenes.send(source.scenes.byName("local-0"), Message, { value: 2 })).toThrow(expect.objectContaining(overloaded));
    expect(target.seen).not.toContain(2);
  } finally { gate.resolve(); await Promise.all(pending); await f.runtime.stop(); }
});

test("late local completion after Runtime restart cannot decrement the new Host's allowance", async () => {
  const old = await fixture(true, 1), oldResult = deferred(), nextResult = deferred();
  old.scenes[0].waits.set(0, oldResult.promise);
  const previous = old.scenes[0].dispatchLocalCall(frame(0)).catch(error => error);
  await old.runtime.stop();
  const f = await fixture(true, 1); f.scenes[0].waits.set(0, nextResult.promise);
  const current = f.scenes[0].dispatchLocalCall(frame(0));
  try {
    oldResult.resolve(); await previous;
    expect(old.host.LocalSceneMailboxPendingCount).toBe(0);
    expect(f.host.LocalSceneMailboxPendingCount).toBe(1);
    expect(f.runtime.CanCommitHotfix).toBe(false);
    nextResult.resolve(); await current;
    expect(f.host.LocalSceneMailboxPendingCount).toBe(0);
  } finally { oldResult.resolve(); nextResult.resolve(); await previous; await current; await f.runtime.stop(); }
});
