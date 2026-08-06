import assert from "node:assert/strict";
import {
  defineMessage,
  type Codec,
  type IMessage,
  type IRequest,
  type IResponse,
} from "../app/core/protocol/message";
import { readU16BE } from "../app/core/protocol/binary";
import { packFrame } from "../app/core/protocol/registry";
import { defineRpc } from "../app/core/protocol/rpc";
import { ProcessRuntime } from "../app/core/process/ProcessRuntime";
import { entryScene } from "../app/core/process/registry";
import {
  messageHandler,
  rpcHandler,
  type SceneMessageHandler,
  type SceneRpcHandler,
} from "../app/core/process/sceneHandlers";
import {
  EntryScene,
} from "../app/core/process/types";
import {
  sessionMessageHandler,
  type SessionMessageHandler,
} from "../app/core/process/sessionHandlers";
import { Component } from "../app/core/runtime/entities";
import { ProcessHost } from "../app/core/runtime/host";
import { Session } from "../app/core/runtime/Session";

interface AddMessage extends IMessage {
  value: number;
}

interface ReadRequest extends IRequest {}

interface ReadResponse extends IResponse {
  value: number;
}

const jsonCodec = <T>(): Codec<T> => ({
  encode: (value) => new TextEncoder().encode(JSON.stringify(value)),
  decode: (payload) => JSON.parse(new TextDecoder().decode(payload)) as T,
});

const Add = defineMessage({
  name: "HandlerProbe.Add",
  msgcode: 61001,
  codec: jsonCodec<AddMessage>(),
});

const Read = defineRpc({
  name: "HandlerProbe.Read",
  requestCode: 61002,
  responseCode: 61003,
  requestCodec: jsonCodec<ReadRequest>(),
  responseCodec: jsonCodec<ReadResponse>(),
});

interface SessionWorkMessage extends IMessage {
  value: number;
}

const SessionWork = defineMessage({
  name: "SessionProbe.Work",
  msgcode: 61004,
  codec: jsonCodec<SessionWorkMessage>(),
});

const lifecycleEvents: string[] = [];

class CounterComponent extends Component<[number]> {
  value = 0;
  destroyed = false;

  protected override Awake(initialValue: number): void {
    this.value = initialValue;
  }

  protected override OnDestroy(): void {
    this.destroyed = true;
    lifecycleEvents.push("component-destroy");
  }
}

@entryScene("HandlerProbe")
class HandlerProbeScene extends EntryScene {
  readonly counter = this.AddComponent(CounterComponent, 10);

  protected override onStart(): void {
    lifecycleEvents.push("start");
  }

  protected override onReady(): void {
    lifecycleEvents.push("ready");
  }

  protected override onStop(): void {
    lifecycleEvents.push("stop");
  }
}

const sessionEvents: string[] = [];
let releaseFirstSessionWork: (() => void) | undefined;
let activeSessionScene: SessionHandlerProbeScene | undefined;

class ProbeSession extends Session {
  protected override OnDestroy(): void {
    sessionEvents.push(`destroy:${this.ConnectionId}`);
  }
}

@entryScene("SessionHandlerProbe")
class SessionHandlerProbeScene extends EntryScene {
  protected override readonly mailbox = "unordered" as const;

  protected override onStart(): void {
    activeSessionScene = this;
  }

  protected override createSession(connectionId: number): ProbeSession {
    return this.addSession(connectionId, ProbeSession);
  }

  SessionCount(): number {
    return this.getSessions().length;
  }
}

@sessionMessageHandler(SessionHandlerProbeScene, SessionWork)
class SessionWorkHandler implements SessionMessageHandler<
  SessionHandlerProbeScene,
  ProbeSession,
  SessionWorkMessage
> {
  async handle(
    _scene: SessionHandlerProbeScene,
    session: ProbeSession,
    message: SessionWorkMessage,
  ): Promise<void> {
    sessionEvents.push(`start:${session.ConnectionId}:${message.value}`);
    if (message.value === 1) {
      await new Promise<void>((resolve) => {
        releaseFirstSessionWork = resolve;
      });
    }
    sessionEvents.push(`end:${session.ConnectionId}:${message.value}`);
  }
}

@messageHandler(HandlerProbeScene, Add)
class AddHandler implements SceneMessageHandler<HandlerProbeScene, AddMessage> {
  handle(scene: HandlerProbeScene, message: AddMessage): void {
    scene.GetComponent(CounterComponent).value += message.value;
  }
}

@rpcHandler(HandlerProbeScene, Read)
class ReadHandler implements SceneRpcHandler<
  HandlerProbeScene,
  ReadRequest,
  ReadResponse
> {
  handle(scene: HandlerProbeScene): ReadResponse {
    return { value: scene.GetComponent(CounterComponent).value };
  }
}

void main();

async function main(): Promise<void> {
  testComponentContainer();
  testDuplicateHandlerGuard();
  await testExternalHandlerDispatch();
  await testSessionMailboxAndDisconnect();
  console.log("entry scene handler self-test passed");
}

async function testSessionMailboxAndDisconnect(): Promise<void> {
  sessionEvents.length = 0;
  releaseFirstSessionWork = undefined;
  const config = sessionSceneConfig();
  const runtime = new ProcessRuntime({
    process: { name: "session-handler-self-test" },
    scenes: [config],
    knownScenes: [config],
    tickMs: 50,
  });
  await runtime.start();

  const frame = (value: number) =>
    packFrame(SessionWork.msgcode, SessionWork.codec.encode({ value }));
  runtime.pushHostFrame(0, 11, frame(1));
  runtime.pushHostFrame(0, 11, frame(2));
  runtime.pushHostFrame(0, 22, frame(3));
  runtime.update();
  await waitUntil(() => sessionEvents.includes("end:22:3"));
  assert.equal(sessionEvents.includes("start:11:1"), true);
  assert.equal(sessionEvents.includes("start:11:2"), true);
  assert.equal(sessionEvents.includes("end:11:2"), true);
  assert.equal(sessionEvents.includes("start:22:3"), true);
  assert.equal(sessionEvents.includes("end:22:3"), true);
  assert.equal(sessionEvents.includes("end:11:1"), false);

  releaseFirstSessionWork?.();
  await waitUntil(() => sessionEvents.includes("end:11:1"));
  assert.equal(sessionEvents.includes("end:11:1"), true);

  const scene = activeSessionScene;
  assert.ok(scene);
  assert.equal(scene.SessionCount(), 2);
  runtime.pushHostDisconnect(0, 11);
  runtime.update();
  await waitUntil(() => sessionEvents.includes("destroy:11"));
  assert.equal(scene.SessionCount(), 1);
  await runtime.stop();
  assert.equal(sessionEvents.includes("destroy:22"), true);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("timed out waiting for Session handler state");
}

function testComponentContainer(): void {
  const scene = createScene();
  assert.equal(scene.counter.value, 10);
  assert.equal(scene.GetComponent(CounterComponent), scene.counter);
  assert.equal(scene.HasComponent(CounterComponent), true);
  assert.throws(
    () => scene.AddComponent(CounterComponent, 0),
    /already has component/,
  );

  assert.equal(scene.RemoveComponent(CounterComponent), true);
  assert.equal(scene.counter.destroyed, true);
  assert.equal(scene.counter.IsDisposed, true);
  assert.equal(scene.TryGetComponent(CounterComponent), undefined);
  assert.equal(scene.RemoveComponent(CounterComponent), false);
}

function testDuplicateHandlerGuard(): void {
  @entryScene("DuplicateHandlerProbe")
  class DuplicateHandlerProbeScene extends EntryScene {}

  class FirstHandler implements SceneMessageHandler<DuplicateHandlerProbeScene, AddMessage> {
    handle(): void {}
  }

  class SecondHandler implements SceneMessageHandler<DuplicateHandlerProbeScene, AddMessage> {
    handle(): void {}
  }

  messageHandler(DuplicateHandlerProbeScene, Add)(FirstHandler);
  assert.throws(
    () => messageHandler(DuplicateHandlerProbeScene, Add)(SecondHandler),
    /duplicate external handler/,
  );
}

async function testExternalHandlerDispatch(): Promise<void> {
  lifecycleEvents.length = 0;
  const runtime = new ProcessRuntime({
    process: { name: "handler-self-test" },
    scenes: [sceneConfig()],
    knownScenes: [sceneConfig()],
    tickMs: 50,
  });
  await runtime.start();
  assert.deepEqual(lifecycleEvents, ["start", "ready"]);

  runtime.pushHostFrame(0, 7, packFrame(Add.msgcode, Add.codec.encode({ value: 5 })));
  runtime.pushHostFrame(
    0,
    7,
    packFrame(Read.requestCode, Read.requestCodec.encode({ rpcId: 42 })),
  );
  runtime.pushHostFrame(0, 7, packFrame(65000, new Uint8Array()));

  const result = await runtime.update();
  assert.equal(result.metrics[0]?.processedFrames, 3);
  assert.equal(result.metrics[0]?.protocolSuccesses, 2);
  assert.equal(result.metrics[0]?.failedFrames, 1);
  assert.equal(result.metrics[0]?.systemErrors, 1);
  assert.equal(result.outbound.length, 1);
  assert.deepEqual([...result.outbound[0].connectionIdBytes], [7, 0, 0, 0]);
  assert.equal(readU16BE(result.outbound[0].frame, 0), Read.responseCode);

  const response = Read.responseCodec.decode(result.outbound[0].frame.subarray(2));
  assert.deepEqual(response, { value: 15, rpcId: 42, error: 0 });
  await runtime.stop();
  assert.deepEqual(lifecycleEvents, ["start", "ready", "stop", "component-destroy"]);
}

function createScene(): HandlerProbeScene {
  return new HandlerProbeScene({
    process: { name: "handler-component-self-test" },
    self: sceneConfig(),
    knownScenes: [sceneConfig()],
    tickMs: 50,
    processHost: new ProcessHost("handler-component-self-test"),
    localRouter: {
      hasLocalScene: () => false,
      callLocalScene: () => Promise.reject(new Error("not used")),
      sendLocalScene: () => Promise.reject(new Error("not used")),
    },
  });
}

function sceneConfig() {
  return {
    name: "handler-probe-1",
    sceneType: "HandlerProbe",
    innerIp: "127.0.0.1",
    port: 0,
  };
}

function sessionSceneConfig() {
  return {
    name: "session-handler-probe-1",
    sceneType: "SessionHandlerProbe",
    innerIp: "127.0.0.1",
    port: 0,
  };
}
