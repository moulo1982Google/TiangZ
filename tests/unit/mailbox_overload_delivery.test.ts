import { expect, test, vi } from "vitest";
import { EntryScene } from "../../app/core/process/EntryScene";
import { encodeActorLocationEnvelope, encodeActorLocationBatchEnvelope } from "../../app/core/process/ActorLocation";
import { encodeTraceEnvelope } from "../../app/core/process/TraceEnvelope";
import { ProcessRuntime } from "../../app/core/process/ProcessRuntime";
import { entryScene } from "../../app/core/process/registry";
import type { RuntimeEntrySceneConfig } from "../../app/core/process/types";
import { defineMessage, type Codec, type IRequest, type IResponse } from "../../app/core/protocol/message";
import { packFrame, ProtocolRegistry, type ProtocolOutcome } from "../../app/core/protocol/registry";
import { defineRpc } from "../../app/core/protocol/rpc";
import { SystemErrCode } from "../../app/core/protocol/SystemErrCode";
import { ProcessHost } from "../../app/core/runtime/host";
import { actor } from "../../app/core/runtime/metadata";
import { ActorUnit } from "../../app/core/runtime/Unit";

// 纯边界夹具 Codec；实际 V8 验收另走正式 Proto/SDK 生成。 / Boundary-only fixture codec; real V8 acceptance uses generated Proto/SDK.
const codec = <T>(): Codec<T> => ({ encode: value => new TextEncoder().encode(JSON.stringify(value)),
  decode: bytes => (bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : {}) as T });
const Message = defineMessage({ name: "Overload.Message", msgcode: 61100, codec: codec<{ async: boolean }>() });
const Latest = defineMessage({ name: "Overload.Latest", msgcode: 61103, codec: codec<{ async: boolean }>(), routing: "actor-location", forwarding: "latest" });
interface Request extends IRequest { hold: boolean }
interface Response extends IResponse { value: number }
const Work = defineRpc({ name: "Overload.Work", requestCode: 61101, responseCode: 61102,
  requestCodec: codec<Request>(), responseCodec: codec<Response>() });
const messageFrame = (asynchronous = false) => packFrame(Message.msgcode, Message.codec.encode({ async: asynchronous }));
const rpcFrame = (hold = false) => packFrame(Work.requestCode, Work.requestCodec.encode({ rpcId: 67, hold }));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

@actor({ mailbox: "unordered" })
class BusyActor extends ActorUnit {}
let active: DeliveryScene;
@entryScene("OverloadDelivery")
class DeliveryScene extends EntryScene {
  target!: BusyActor;
  readonly closed: number[] = [];
  readonly barrier = deferred();
  asyncWait: Promise<void> | undefined;
  invoked = 0;
  constructor(config: RuntimeEntrySceneConfig) { super(config, [Work], [Message, Latest]); }
  protected override onStart(): void { active = this; this.target = this.SpawnActor(1, BusyActor); }
  protected override disconnectClient(connectionId: number): void { this.closed.push(connectionId); }
  protected override registerHandlers(): void {
    this.registry.registerMessage(Message.msgcode, { decode: Message.codec.decode, handle: (message, context) => {
      context.connectionId = 99999; // 模拟下一跳改写；实际来源仍须从入站 item 取得。 / A rewritten next-hop context is not the ingress source.
      const run = () => this.RunLocalActorMailbox(this.target, () => { this.invoked++; });
      return message.async ? (this.asyncWait ?? Promise.resolve()).then(run) : run();
    } });
    this.registry.register(Work.requestCode, { responseCode: Work.responseCode, decode: Work.requestCodec.decode,
      encode: Work.responseCodec.encode, handle: request => request.hold
        ? this.barrier.promise.then(() => ({ value: 1 }))
        : this.RunLocalActorMailbox(this.target, () => { this.invoked++; return { value: 1 }; }) });
  }
}
@entryScene("UnorderedOverloadDelivery")
class UnorderedDeliveryScene extends DeliveryScene {
  protected override readonly mailbox = "unordered" as const;
}

async function fixture(unordered = false) {
  const config = { name: "delivery", sceneType: unordered ? "UnorderedOverloadDelivery" : "OverloadDelivery", ip: "127.0.0.1", innerIp: "127.0.0.1", port: 12345 };
  const runtime = new ProcessRuntime({ process: { name: "overload-delivery" }, scenes: [config], knownScenes: [config], tickMs: 50 });
  await runtime.start();
  const scene = active, host = Reflect.get(runtime, "processHost") as ProcessHost, gate = deferred();
  const pending = Array.from({ length: 4096 }, () => Promise.resolve(host.runActorMailbox(scene.target.InstanceId, () => gate.promise)));
  return { runtime, scene, host, async close() { gate.resolve(); scene.barrier.resolve(); await Promise.all(pending); await runtime.stop(); } };
}

test.each([[false, false], [false, true], [true, false], [true, true]])(
  "network one-way overload closes only physical ingress and never breaks the Pump (unordered=%s, async=%s)", async (unordered, asynchronous) => {
    const f = await fixture(unordered);
    try {
      f.runtime.pushHostFrame(0, 37, messageFrame(asynchronous));
      await f.runtime.update(false, true);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(f.scene.closed).toEqual([37]);
      expect(f.scene.invoked).toBe(0);
      expect(f.host.ActorMailboxPendingCount).toBe(4096);
      const update = await f.runtime.update(true, true);
      expect(update.outbound).toHaveLength(0);
      expect(update.metrics[0]).toMatchObject({ messageHandlerFailures: 1, protocolSuccesses: 0 });
    } finally { await f.close(); }
  });

test("local one-way synchronous admission failure reaches the caller", async () => {
  const f = await fixture();
  try {
    expect(() => f.runtime.sendLocalScene("source", "delivery", messageFrame())).toThrow(expect.objectContaining({ code: SystemErrCode.SceneOverloaded }));
    expect(f.scene.invoked).toBe(0);
    expect(f.scene.closed).toHaveLength(0);
  } finally { await f.close(); }
});

test("the public Scene send API preserves the typed overload from local admission", async () => {
  const f = await fixture();
  try {
    expect(() => f.scene.scenes.send(f.scene.scenes.byName("delivery"), Message, { async: false }))
      .toThrow(expect.objectContaining({ code: SystemErrCode.SceneOverloaded }));
    expect(f.scene.invoked).toBe(0);
  } finally { await f.close(); }
});

test("a disconnected async source cannot close a new wait using the same connection ID after tombstone expiry", async () => {
  const f = await fixture(true), late = deferred();
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  try {
    f.scene.asyncWait = late.promise;
    f.runtime.pushHostFrame(0, 37, messageFrame(true));
    await f.runtime.update(false, true);
    f.runtime.pushHostDisconnect(0, 37);
    await f.runtime.update(false, true);
    clock = vi.spyOn(performance, "now").mockReturnValue(performance.now() + 31_000);
    f.runtime.pushHostFrame(0, 37, rpcFrame(true));
    await f.runtime.update(false, true);
    late.resolve();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(f.scene.closed).toHaveLength(0);
    f.scene.barrier.resolve();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    const { outbound } = await f.runtime.update(false, true);
    expect(outbound).toHaveLength(1);
    expect(Work.responseCodec.decode(outbound[0].frame.subarray(2))).toMatchObject({ rpcId: 67, error: 0 });
  } finally { late.resolve(); clock?.mockRestore(); await f.close(); }
});

test.each(["trace", "actor", "batch"])("%s envelope keeps overload distinct from malformed input", async kind => {
  const f = await fixture();
  try {
    const actorRegistry = Reflect.get(f.scene, "actorRegistry") as ProtocolRegistry;
    actorRegistry.registerMessage(Latest.msgcode, { decode: Latest.codec.decode,
      handle: () => f.host.runActorMailboxVoid(f.scene.target.InstanceId, () => { f.scene.invoked++; }) });
    const entry = { instanceId: f.scene.target.InstanceId, fenceToken: 1n,
      frame: packFrame(Latest.msgcode, Latest.codec.encode({ async: false })) };
    const frame = kind === "trace" ? encodeTraceEnvelope(messageFrame(), { traceId: "1".repeat(32), spanId: "2".repeat(16), sampled: true })
      : kind === "actor" ? encodeActorLocationEnvelope(entry) : encodeActorLocationBatchEnvelope([entry]);
    f.runtime.pushHostControlFrame(0, 38, frame);
    await f.runtime.update(false, true);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(f.scene.closed).toEqual([38]);
    expect(f.scene.invoked).toBe(0);
    expect((await f.runtime.update(true, true)).metrics[0]).toMatchObject({ messageHandlerFailures: 1, systemErrors: 1 });
  } finally { await f.close(); }
});

test("a partially accepted batch closes on the first rejection and still observes earlier asynchronous failures", async () => {
  const f = await fixture(), earlier = deferred(), free = f.scene.SpawnActor(2, BusyActor);
  const actorRegistry = Reflect.get(f.scene, "actorRegistry") as ProtocolRegistry;
  actorRegistry.registerMessage(Latest.msgcode, { decode: Latest.codec.decode,
    handle: (_message, context) => f.host.runActorMailboxVoid(context.actorInstanceId!, () =>
      earlier.promise.then(() => f.host.runActorMailboxVoid(f.scene.target.InstanceId, () => { f.scene.invoked++; }))) });
  const frame = packFrame(Latest.msgcode, Latest.codec.encode({ async: false }));
  try {
    f.runtime.pushHostControlFrame(0, 39, encodeActorLocationBatchEnvelope([
      { instanceId: free.InstanceId, frame }, { instanceId: f.scene.target.InstanceId, frame },
    ]));
    await f.runtime.update(false, true);
    expect(f.scene.closed).toEqual([39]);
    expect(f.host.ActorMailboxPendingCount).toBe(4097);
    earlier.resolve();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(f.host.ActorMailboxPendingCount).toBe(4096);
    expect(f.scene.invoked).toBe(0);
    expect((await f.runtime.update(true, true)).metrics[0]).toMatchObject({ messageHandlerFailures: 2, systemErrors: 2 });
  } finally { earlier.resolve(); for (let i = 0; i < 30; i++) await Promise.resolve(); await f.close(); }
});

test("acceptance by a busy local Scene does not turn later Actor overload into protocol success", async () => {
  const f = await fixture(), held = f.scene.dispatchLocalCall(rpcFrame(true));
  try {
    expect(f.runtime.sendLocalScene("source", "delivery", messageFrame())).toBeUndefined();
    f.scene.barrier.resolve(); await held;
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(f.scene.invoked).toBe(0);
    expect((await f.runtime.update(true, true)).metrics[0]).toMatchObject({ messageHandlerFailures: 1, protocolSuccesses: 1 });
  } finally { f.scene.barrier.resolve(); await held; await f.close(); }
});

test("RPC capacity rejection preserves the request correlation ID", async () => {
  const f = await fixture();
  try {
    const response = await f.scene.dispatchLocalCall(rpcFrame());
    expect(Work.responseCodec.decode(response.subarray(2))).toMatchObject({ rpcId: 67, error: SystemErrCode.SceneOverloaded });
    expect(f.scene.invoked).toBe(0);
    expect(f.scene.closed).toHaveLength(0);
  } finally { await f.close(); }
});

test.each([false, true])("one-way failure metrics preserve 1011 and do not mask ordinary handler failures (async=%s)", async asynchronous => {
  const f = await fixture(), outcomes: ProtocolOutcome[] = [], registry = new ProtocolRegistry(() => {}, undefined, value => outcomes.push(value));
  registry.registerMessage(Message.msgcode, { decode: Message.codec.decode, handle: () => {
    const run = () => f.host.runActorMailboxVoid(f.scene.target.InstanceId, () => { f.scene.invoked++; });
    return asynchronous ? Promise.resolve().then(run) : run();
  } });
  try {
    if (asynchronous) await expect(registry.handle(messageFrame())).rejects.toMatchObject({ code: SystemErrCode.SceneOverloaded });
    else expect(() => registry.handle(messageFrame())).toThrow(expect.objectContaining({ code: SystemErrCode.SceneOverloaded }));
    expect(outcomes).toMatchObject([{ kind: "message-handler-failed", code: SystemErrCode.SceneOverloaded }]);
    registry.registerMessage(Message.msgcode, { decode: Message.codec.decode, handle: () => {
      const fail = () => { throw new Error("ordinary handler failure"); };
      return asynchronous ? Promise.resolve().then(fail) : fail();
    } });
    expect(await registry.handle(messageFrame())).toBeUndefined();
    expect(outcomes[1]).toMatchObject({ kind: "message-handler-failed", code: SystemErrCode.HandlerFailed });
  } finally { await f.close(); }
});
