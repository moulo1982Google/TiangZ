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
import { Component, ProcessHost } from "../app/core/runtime";

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

class CounterComponent extends Component<[number]> {
  value = 0;
  destroyed = false;

  protected override Awake(initialValue: number): void {
    this.value = initialValue;
  }

  protected override OnDestroy(): void {
    this.destroyed = true;
  }
}

@entryScene("HandlerProbe")
class HandlerProbeScene extends EntryScene {
  readonly counter = this.AddComponent(CounterComponent, 10);
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
  console.log("entry scene handler self-test passed");
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
  const runtime = new ProcessRuntime({
    process: { name: "handler-self-test" },
    scenes: [sceneConfig()],
    knownScenes: [sceneConfig()],
    tickMs: 50,
  });

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
    ip: "127.0.0.1",
    port: 0,
  };
}
