import { expect, test } from "vitest";
import type { MaybePromise } from "../../app/core/async";
import { EntryScene } from "../../app/core/process/EntryScene";
import { ProcessRuntime } from "../../app/core/process/ProcessRuntime";
import { entryScene } from "../../app/core/process/registry";
import type { RuntimeEntrySceneConfig } from "../../app/core/process/types";
import { defineMessage, type Codec, type IRequest, type IResponse } from "../../app/core/protocol/message";
import { packFrame } from "../../app/core/protocol/registry";
import { defineRpc } from "../../app/core/protocol/rpc";
import { SystemErrCode } from "../../app/core/protocol/SystemErrCode";
import { actor } from "../../app/core/runtime/metadata";
import { ProcessHost } from "../../app/core/runtime/host";
import { ActorUnit } from "../../app/core/runtime/Unit";

// 仅夹具使用本地 Codec；实际业务继续用生成的协议描述符。 / Local codecs belong only to this fixture, not production protocols.
const codec = <T>(): Codec<T> => ({
  encode: value => new TextEncoder().encode(JSON.stringify(value)),
  decode: bytes => (bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : {}) as T,
});
interface Request extends IRequest { value: number }
interface Response extends IResponse { value: number }
const Work = defineRpc({ name: "MailboxLifetime.Work", requestCode: 61090, responseCode: 61091,
  requestCodec: codec<Request>(), responseCodec: codec<Response>() });
const Message = defineMessage({ name: "MailboxLifetime.Message", msgcode: 61092, codec: codec<{ value: number }>() });
const Transfer = defineRpc({ ...Work, name: "MailboxLifetime.Transfer", requestCode: 61093, responseCode: 61094,
  routing: "actor-location", duringTransfer: "queue" });
const rpcFrame = (value: number) => packFrame(Work.requestCode, Work.requestCodec.encode({ value, rpcId: value + 1 }));
const messageFrame = (value: number) => packFrame(Message.msgcode, Message.codec.encode({ value }));
const array = (owner: object, name: string): unknown[] => Reflect.get(owner, name) as unknown[];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

let active: LifetimeScene;
@entryScene("MailboxLifetime")
class LifetimeScene extends EntryScene {
  readonly seen: number[] = [];
  readonly waits = new Map<number, Promise<void>>();
  constructor(config: RuntimeEntrySceneConfig) { super(config, [Work, Transfer], [Message]); }
  beginTransfer(connectionId: number): void { this.beginActorTransfer(connectionId); }
  protected override onStart(): void { active = this; }
  protected override registerHandlers(): void {
    this.registry.register(Work.requestCode, {
      responseCode: Work.responseCode, decode: Work.requestCodec.decode, encode: Work.responseCodec.encode,
      handle: request => {
        const result = this.work(request.value);
        const response = { rpcId: request.rpcId, error: 0, value: request.value };
        return result ? result.then(() => response) : response;
      },
    });
    this.registry.registerMessage(Message.msgcode, { decode: Message.codec.decode, handle: message => this.work(message.value) });
  }
  private work(value: number): MaybePromise<void> {
    this.seen.push(value);
    return this.waits.get(value);
  }
}

@actor({ mailbox: "ordered" })
class LifetimeActor extends ActorUnit {}
@actor({ mailbox: "unordered" })
class UnorderedLifetimeActor extends ActorUnit {}
@entryScene("UnorderedMailboxLifetime")
class UnorderedLifetimeScene extends LifetimeScene {
  protected override readonly mailbox = "unordered" as const;
}

async function fixture(unordered = false) {
  const config = { name: "lifetime", sceneType: unordered ? "UnorderedMailboxLifetime" : "MailboxLifetime", ip: "127.0.0.1", innerIp: "127.0.0.1", port: 12345 };
  const runtime = new ProcessRuntime({ process: { name: "mailbox-lifetime" }, scenes: [config], knownScenes: [config], tickMs: 50 });
  await runtime.start();
  return { runtime, scene: active, host: Reflect.get(runtime, "processHost") as ProcessHost };
}

test("consumed data and control ingress slots release their frame references before compaction", async () => {
  const { runtime, scene } = await fixture();
  try {
    for (let value = 100; value < 120; value++) runtime.pushHostFrame(0, 1, messageFrame(value));
    for (let value = 200; value < 203; value++) runtime.pushHostControlFrame(0, 1, messageFrame(value));
    expect(scene.__pumpMailbox(10)).toBe(10);
    expect(scene.seen).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 200, 108]);
    expect(array(scene, "dataIngress").slice(0, 9)).toEqual(Array(9).fill(undefined));
    expect(array(scene, "controlIngress")[0]).toBeUndefined();
    expect(scene.__canCommitHotfix()).toBe(false);
    scene.__pumpMailbox(100);
    expect(scene.seen).toHaveLength(23);
  } finally { await runtime.stop(); }
});

test.each([false, true])("local Scene result waits remain visible to the Hotfix barrier (unordered=%s)", async unordered => {
  const { runtime, scene, host } = await fixture(unordered);
  const gate = deferred();
  scene.waits.set(0, gate.promise);
  const running = scene.dispatchLocalCall(rpcFrame(0)).catch(error => error);
  try {
    expect((await runtime.update(false, true)).pendingAsync).toBe(true);
    expect(runtime.CanCommitHotfix).toBe(false);
    host.despawnScene("lifetime");
    expect((await runtime.update(false, true)).pendingAsync).toBe(true);
    expect(runtime.CanCommitHotfix).toBe(false);
    gate.resolve();
    expect(await running).toMatchObject({ code: SystemErrCode.SceneNotFound });
    expect((await runtime.update(false, true)).pendingAsync).toBe(false);
  } finally { gate.resolve(); await running; await runtime.stop(); }
});

test.each([false, true])("direct Actor result waits survive owner disposal in the Process barrier (unordered=%s)", async unordered => {
  const { runtime, scene } = await fixture();
  const target = scene.SpawnActor(1, unordered ? UnorderedLifetimeActor : LifetimeActor);
  const gate = deferred();
  const running = Promise.resolve(scene.RunLocalActorMailbox(target, () => gate.promise)).catch(error => error);
  try {
    expect((await runtime.update(false, true)).pendingAsync).toBe(true);
    expect(runtime.CanCommitHotfix).toBe(false);
    scene.DespawnActor(1);
    expect((await runtime.update(false, true)).pendingAsync).toBe(true);
    expect(runtime.CanCommitHotfix).toBe(false);
    gate.resolve();
    expect(await running).toBeInstanceOf(Error);
    expect((await runtime.update(false, true)).pendingAsync).toBe(false);
    expect(runtime.CanCommitHotfix).toBe(true);
  } finally { gate.resolve(); await running; await runtime.stop(); }
});

test.each([false, true])("Actor success and failures release activity exactly once (unordered=%s)", async unordered => {
  const { runtime, scene, host } = await fixture();
  const target = scene.SpawnActor(1, unordered ? UnorderedLifetimeActor : LifetimeActor);
  const failure = new Error("controlled actor failure");
  try {
    expect(host.runActorMailbox(target.InstanceId, () => 42)).toBe(42);
    expect(() => host.runActorMailbox(target.InstanceId, () => { throw failure; })).toThrow(failure);
    await expect(host.runActorMailbox(target.InstanceId, () => Promise.reject(failure))).rejects.toBe(failure);
    expect(host.runActorMailboxVoid(target.InstanceId, () => undefined)).toBeUndefined();
    expect(() => host.runActorMailboxVoid(target.InstanceId, () => { throw failure; })).toThrow(failure);
    await expect(host.runActorMailboxVoid(target.InstanceId, () => Promise.reject(failure))).rejects.toBe(failure);
    expect(host.ActorMailboxPendingCount).toBe(0);
    expect((await runtime.update(false, true)).pendingAsync).toBe(false);
    expect(runtime.CanCommitHotfix).toBe(true);
  } finally { await runtime.stop(); }
});

test("Scene ordered RPC and one-way work keep FIFO while idle nodes are bounded", async () => {
  const { runtime, scene } = await fixture();
  const first = deferred(), second = deferred();
  scene.waits.set(0, first.promise); scene.waits.set(1, second.promise);
  const firstCall = scene.dispatchLocalCall(rpcFrame(0));
  const secondCall = scene.dispatchLocalCall(rpcFrame(1));
  for (let value = 2; value < 258; value++) expect(scene.dispatchLocalSend(messageFrame(value))).toBeUndefined();
  const lastCall = scene.dispatchLocalCall(rpcFrame(258));
  try {
    expect(scene.seen).toEqual([0]);
    first.resolve(); await firstCall;
    expect(scene.seen).toEqual([0, 1]);
    expect(array(scene, "mailboxTasks")[0]).toBeUndefined();
    expect(scene.__canCommitHotfix()).toBe(false);
    second.resolve(); await secondCall; await lastCall;
    expect(scene.seen).toEqual(Array.from({ length: 259 }, (_, value) => value));
    expect(array(scene, "recycledMailboxTasks")).toHaveLength(64);
    expect(array(scene, "recycledMailboxTasks").every(node => Object.values(node as object).every(value => value === undefined))).toBe(true);
    expect(scene.__canCommitHotfix()).toBe(true);
  } finally {
    first.resolve(); second.resolve();
    await Promise.allSettled([firstCall, secondCall, lastCall]);
    await runtime.stop();
  }
});

test("Actor ordered RPC and one-way work release old slots and bound idle nodes", async () => {
  const { runtime, scene, host } = await fixture();
  const target = scene.SpawnActor(1, LifetimeActor);
  const actorRuntime = (Reflect.get(host, "actorsByInstanceId") as Map<number, object>).get(target.InstanceId)!;
  const first = deferred(), second = deferred();
  const seen: number[] = [];
  const run = (value: number) => { seen.push(value); return value === 0 ? first.promise : value === 1 ? second.promise : undefined; };
  const firstCall = host.runActorMailbox(target.InstanceId, () => run(0));
  const secondCall = host.runActorMailbox(target.InstanceId, () => run(1));
  for (let value = 2; value < 258; value++) expect(host.runActorMailboxVoid(target.InstanceId, () => run(value))).toBeUndefined();
  const lastCall = host.runActorMailbox(target.InstanceId, () => run(258));
  try {
    first.resolve(); await firstCall;
    expect(seen).toEqual([0, 1]);
    expect(array(actorRuntime, "queue")[0]).toBeUndefined();
    second.resolve(); await secondCall; await lastCall;
    expect(seen).toEqual(Array.from({ length: 259 }, (_, value) => value));
    expect(array(actorRuntime, "recycledQueueItems")).toHaveLength(64);
    expect(host.MailboxMetrics().queuedDepth).toBe(0);
  } finally {
    first.resolve(); second.resolve();
    await Promise.allSettled([firstCall, secondCall, lastCall]);
    await runtime.stop();
  }
});

test("Scene disposal rejects queued calls without completing active work or retaining late output", async () => {
  const { runtime, scene, host } = await fixture();
  const first = deferred(), second = deferred();
  scene.waits.set(0, first.promise); scene.waits.set(1, second.promise);
  const firstCall = scene.dispatchLocalCall(rpcFrame(0));
  let activeFinished = false;
  const secondCall = scene.dispatchLocalCall(rpcFrame(1)).then(value => { activeFinished = true; return value; }, error => { activeFinished = true; throw error; });
  const secondResult = secondCall.catch(error => error);
  const queued = scene.dispatchLocalCall(rpcFrame(2)).then(() => "unexpected success", error => error);
  scene.dispatchLocalSend(messageFrame(3));
  runtime.pushHostFrame(0, 1, messageFrame(4));
  runtime.pushHostControlFrame(0, 1, messageFrame(5));
  try {
    first.resolve(); await firstCall;
    expect(scene.seen).toEqual([0, 1]);
    host.despawnScene("lifetime");
    // 先检查同步清理，旧实现不会让本测试无限等一个永不拒绝的 RPC。 / Check synchronous cleanup before awaiting a potentially orphaned RPC.
    expect(scene.mailboxMetricsSnapshot().queuedDepth).toBe(0);
    expect(await queued).toMatchObject({ code: SystemErrCode.SceneNotFound });
    expect(activeFinished).toBe(false);
    expect(array(scene, "dataIngress")).toHaveLength(0);
    expect(array(scene, "controlIngress")).toHaveLength(0);
    await expect(scene.dispatchLocalCall(rpcFrame(6))).rejects.toMatchObject({ code: SystemErrCode.SceneNotFound });
    expect(() => scene.dispatchLocalSend(messageFrame(7))).toThrow();
    expect(() => runtime.sendLocalScene("sender", "lifetime", messageFrame(8))).toThrow();
    second.resolve();
    expect(await secondResult).toMatchObject({ code: SystemErrCode.SceneNotFound });
    expect(scene.seen).toEqual([0, 1]);
    expect(array(scene, "recycledMailboxTasks")).toHaveLength(0);
    expect(scene.__completeUpdate(0, false).outbound).toHaveLength(0);
  } finally {
    first.resolve(); second.resolve();
    await Promise.allSettled([firstCall, secondResult, queued]);
    await runtime.stop();
  }
});

test.each([false, true])("Scene disposal prevents late network output and terminates transfer waits (transfer=%s)", async transfer => {
  const { runtime, scene, host } = await fixture();
  const gate = deferred();
  scene.waits.set(0, gate.promise);
  if (transfer) scene.beginTransfer(1);
  runtime.pushHostFrame(0, 1, transfer
    ? packFrame(Transfer.requestCode, Transfer.requestCodec.encode({ rpcId: 1, value: 0 })) : rpcFrame(0));
  expect(scene.__pumpMailbox(1)).toBe(1);
  const running = Reflect.get(scene, "orderedTask") as Promise<void>;
  try {
    expect(running).toBeInstanceOf(Promise);
    expect(scene.__canCommitHotfix()).toBe(false);
    host.despawnScene("lifetime");
    runtime.pushHostFrame(0, 1, messageFrame(9));
    runtime.pushHostControlFrame(0, 1, messageFrame(10));
    runtime.pushHostDisconnect(0, 1);
    expect(array(scene, "dataIngress")).toHaveLength(0);
    expect(array(scene, "controlIngress")).toHaveLength(0);
    expect((Reflect.get(scene, "actorTransferBuffers") as Map<number, unknown>).size).toBe(0);
    if (!transfer) expect(scene.__canCommitHotfix()).toBe(false);
    gate.resolve(); await running;
    expect(scene.__completeUpdate(0, false).outbound).toHaveLength(0);
    expect(scene.seen).toEqual(transfer ? [] : [0]);
  } finally { gate.resolve(); await running; await runtime.stop(); }
});

test("Actor disposal rejects waiting calls and late completion cannot refill its pool", async () => {
  const { runtime, scene, host } = await fixture();
  const target = scene.SpawnActor(1, LifetimeActor);
  const actorRuntime = (Reflect.get(host, "actorsByInstanceId") as Map<number, object>).get(target.InstanceId)!;
  const first = deferred(), second = deferred();
  const firstCall = host.runActorMailbox(target.InstanceId, () => first.promise);
  let activeFinished = false, unexecuted = 0;
  const secondCall = Promise.resolve(host.runActorMailbox(target.InstanceId, () => second.promise)).finally(() => { activeFinished = true; });
  const secondResult = secondCall.catch(error => error);
  const queued = Promise.resolve(host.runActorMailbox(target.InstanceId, () => { unexecuted++; })).catch(error => error);
  try {
    first.resolve(); await firstCall;
    scene.DespawnActor(1);
    expect(await queued).toBeInstanceOf(Error);
    expect(host.MailboxMetrics().queuedDepth).toBe(0);
    expect(activeFinished).toBe(false);
    expect(array(actorRuntime, "recycledQueueItems")).toHaveLength(0);
    second.resolve();
    expect(await secondResult).toBeInstanceOf(Error);
    expect(unexecuted).toBe(0);
    expect(array(actorRuntime, "queue")).toHaveLength(0);
    expect(array(actorRuntime, "recycledQueueItems")).toHaveLength(0);
  } finally {
    first.resolve(); second.resolve();
    await Promise.allSettled([firstCall, secondResult, queued]);
    await runtime.stop();
  }
});
