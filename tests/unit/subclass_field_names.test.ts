import { expect, test } from "vitest";
import { EntryScene } from "../../app/core/process/EntryScene";
import { ProcessRuntime } from "../../app/core/process/ProcessRuntime";
import { entryScene } from "../../app/core/process/registry";
import type { RuntimeEntrySceneConfig } from "../../app/core/process/types";
import { defineMessage, type Codec, type IRequest, type IResponse } from "../../app/core/protocol/message";
import { packFrame } from "../../app/core/protocol/registry";
import { defineRpc } from "../../app/core/protocol/rpc";
import { Component } from "../../app/core/runtime/entities";

// 0.7.0 回归：EntryScene/Component 的内部状态曾是 TS private，业务子类同名字段（如 Gate 的 connections）会编译失败，
// 运行时还会覆盖引擎自己的状态。现在内部状态是 ES 私有字段，子类可以自由使用这些名字。
// 0.7.0 regression: EntryScene/Component internals were TS-private, so same-named subclass fields (a Gate's
// `connections`) failed to compile and would overwrite engine state at runtime. They are ES private now.
const codec = <T>(): Codec<T> => ({ encode: value => new TextEncoder().encode(JSON.stringify(value)),
  decode: bytes => (bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : {}) as T });
interface Request extends IRequest { value: number }
interface Response extends IResponse { value: number }
const Echo = defineRpc({ name: "SubclassFields.Echo", requestCode: 61300, responseCode: 61301,
  requestCodec: codec<Request>(), responseCodec: codec<Response>() });
const Note = defineMessage({ name: "SubclassFields.Note", msgcode: 61302, codec: codec<{ value: number }>() });

class NamesComponent extends Component {
  readonly parent = "business parent";
  readonly children = ["business child"];
  readonly components = new Map<string, number>([["business", 1]]);
  readonly timers = 7;
  readonly disposed = "business disposed";
  readonly awoken = "business awoken";
}

let started: NamesScene | undefined;
@entryScene("SubclassFieldNames")
class NamesScene extends EntryScene {
  // 与引擎内部字段同名的业务字段。 / Business fields named like engine internals.
  readonly connections = new Map<number, string>();
  readonly metrics = { business: true };
  readonly latencies: number[] = [];
  readonly processHost = "business host";
  readonly mailboxTasks: string[] = [];
  readonly controlIngress: string[] = [];
  readonly orderedTask = "business task";
  lifecycleState = "business lifecycle";
  constructor(config: RuntimeEntrySceneConfig) { super(config, [Echo], [Note]); }
  protected override onStart(): void { started = this; }
  protected override registerHandlers(): void {
    this.registry.register(Echo.requestCode, { responseCode: Echo.responseCode, decode: Echo.requestCodec.decode,
      encode: Echo.responseCodec.encode, handle: async (request: Request) => {
        this.connections.set(request.value, "seen");
        await Promise.resolve();
        return { value: request.value + 1 };
      } });
    this.registry.registerMessage(Note.msgcode, { decode: Note.codec.decode, handle: message => { this.latencies.push(message.value); } });
  }
}

test("business subclasses may use field names that the engine uses internally", async () => {
  const config = { name: "names-0", sceneType: "SubclassFieldNames", ip: "127.0.0.1", innerIp: "127.0.0.1", port: 0 };
  const runtime = new ProcessRuntime({ process: { name: "subclass-field-names" }, scenes: [config], knownScenes: [config], tickMs: 50 });
  await runtime.start();
  try {
    const scene = started!;
    const reply = await scene.dispatchLocalCall(packFrame(Echo.requestCode, Echo.requestCodec.encode({ value: 41, rpcId: 1 })));
    expect(reply).toBeDefined();
    scene.dispatchLocalSend(packFrame(Note.msgcode, Note.codec.encode({ value: 9 })));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect([...scene.connections]).toEqual([[41, "seen"]]);
    expect(scene.latencies).toEqual([9]);
    expect(scene.metrics).toEqual({ business: true });
    expect(scene.processHost).toBe("business host");
    expect(scene.orderedTask).toBe("business task");
    expect(scene.lifecycleState).toBe("business lifecycle");
    expect(scene.mailboxMetricsSnapshot().queuedDepth).toBe(0);

    const component = scene.AddComponent(NamesComponent);
    expect(component.GetParent()).toBe(scene);
    expect(component.parent).toBe("business parent");
    expect(component.children).toEqual(["business child"]);
    expect(component.timers).toBe(7);
    expect(scene.GetComponent(NamesComponent)).toBe(component);
    scene.RemoveComponent(NamesComponent);
    expect(scene.TryGetComponent(NamesComponent)).toBeUndefined();
  } finally { await runtime.stop(); }
});
