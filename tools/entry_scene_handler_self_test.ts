import assert from "node:assert/strict";
import {
  defineMessage,
  registerKnownMessages,
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
import { ActorUnit, UnitComponent } from "../app/core/runtime/Unit";
import { actor } from "../app/core/runtime/metadata";
import {
  unitMessageHandler,
  type UnitMessageHandler,
} from "../app/core/process/unitHandlers";
import type { MaybePromise } from "../app/core/async";

interface AddMessage extends IMessage {
  value: number;
}

interface SlowMessage extends IMessage {
  busyMs: number;
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

const Slow = defineMessage({
  name: "HandlerProbe.Slow",
  msgcode: 61007,
  codec: jsonCodec<SlowMessage>(),
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

interface MailboxDrainMessage extends IMessage {
  remaining: number;
}

const SessionWork = defineMessage({
  name: "SessionProbe.Work",
  msgcode: 61004,
  codec: jsonCodec<SessionWorkMessage>(),
});

const MailboxDrain = defineMessage({
  name: "MailboxProbe.Drain",
  msgcode: 61005,
  codec: jsonCodec<MailboxDrainMessage>(),
});

interface LatestActorInput extends IMessage {
  sequence: number;
}

const LatestActorInputMessage = defineMessage({
  name: "ActorForwardProbe.LatestInput",
  msgcode: 61006,
  codec: jsonCodec<LatestActorInput>(),
  routing: "actor-location" as const,
  forwarding: "latest" as const,
});
registerKnownMessages([LatestActorInputMessage]);

const lifecycleEvents: string[] = [];
let activeHandlerScene: HandlerProbeScene | undefined;
let activeSenderScene: SenderProbeScene | undefined;
let activeMailboxDrainScene: MailboxDrainProbeScene | undefined;
let activeActorForwardGate: ActorForwardGateScene | undefined;
let activeActorForwardTarget: ActorForwardTargetScene | undefined;
let activeOutboundPriorityScene: OutboundPriorityProbeScene | undefined;

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

@actor({ mailbox: "ordered" })
class ActorForwardProbeUnit extends ActorUnit {
  readonly sequences: number[] = [];
}

@entryScene("ActorForwardTarget")
class ActorForwardTargetScene extends EntryScene {
  readonly units = this.AddComponent(UnitComponent);
  probe!: ActorForwardProbeUnit;

  protected override onStart(): void {
    this.probe = this.units.Create(1, ActorForwardProbeUnit);
    activeActorForwardTarget = this;
  }
}

@entryScene("ActorForwardGate")
class ActorForwardGateScene extends EntryScene {
  protected override readonly mailbox = "unordered" as const;

  protected override onStart(): void {
    activeActorForwardGate = this;
  }

  Bind(connectionId: number, target: ActorForwardTargetScene): void {
    this.actorLocations.bindConnection(connectionId, {
      instanceId: target.probe.InstanceId,
      scene: this.scenes.byName("actor-forward-target-1"),
    });
  }
}

@unitMessageHandler(ActorForwardProbeUnit, LatestActorInputMessage)
class LatestActorInputHandler implements UnitMessageHandler<ActorForwardProbeUnit, LatestActorInput> {
  handle(unit: ActorForwardProbeUnit, message: LatestActorInput): void {
    unit.sequences.push(message.sequence);
  }
}

@entryScene("HandlerProbe")
class HandlerProbeScene extends EntryScene {
  readonly counter = this.AddComponent(CounterComponent, 10);
  readonly handledValues: number[] = [];

  protected override onStart(): void {
    activeHandlerScene = this;
    lifecycleEvents.push("start");
  }

  protected override onReady(): void {
    lifecycleEvents.push("ready");
  }

  protected override onStop(): void {
    lifecycleEvents.push("stop");
  }
}

@entryScene("OutboundPriorityProbe")
class OutboundPriorityProbeScene extends EntryScene {
  protected override onStart(): void {
    activeOutboundPriorityScene = this;
  }

  QueueLatestThenReliable(): void {
    this.sendClientFrameMany([7], Uint8Array.from([0, 2]), "latest");
    this.sendClientFrameMany([7], Uint8Array.from([0, 1]), "reliable");
  }

}

@entryScene("SenderProbe")
class SenderProbeScene extends EntryScene {
  protected override onStart(): void {
    activeSenderScene = this;
  }

  SendAdd(value: number): MaybePromise<void> {
    return this.scenes.send(
      this.scenes.byName("handler-probe-1"),
      Add,
      { value },
    );
  }
}

@entryScene("MailboxDrainProbe")
class MailboxDrainProbeScene extends EntryScene {
  processed = 0;

  protected override onStart(): void {
    activeMailboxDrainScene = this;
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
    scene.handledValues.push(message.value);
    scene.GetComponent(CounterComponent).value += message.value;
  }
}

@messageHandler(HandlerProbeScene, Slow)
class SlowHandler implements SceneMessageHandler<HandlerProbeScene, SlowMessage> {
  handle(scene: HandlerProbeScene, message: SlowMessage): void {
    const deadline = performance.now() + message.busyMs;
    while (performance.now() < deadline) {
      // Deliberately occupy the synchronous V8 handler for the fairness regression.
    }
    scene.GetComponent(CounterComponent).value += 1;
  }
}

@messageHandler(MailboxDrainProbeScene, MailboxDrain)
class MailboxDrainHandler implements SceneMessageHandler<MailboxDrainProbeScene, MailboxDrainMessage> {
  handle(scene: MailboxDrainProbeScene, message: MailboxDrainMessage): void {
    scene.processed += 1;
    if (message.remaining <= 0) return;
    scene.dispatchLocalSend(
      packFrame(MailboxDrain.msgcode, MailboxDrain.codec.encode({
        remaining: message.remaining - 1,
      })),
    );
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
  await testLocalSceneSendFastPath();
  await testLatestActorForwardBatch();
  await testSynchronousMailboxDrain();
  await testHostNullSchedulingProjection();
  await testControlIngressPriorityAndDataFairness();
  await testRuntimePumpFairness();
  await testClientOutboundPriority();
  await testExternalHandlerDispatch();
  await testSessionMailboxAndDisconnect();
  console.log("entry scene handler self-test passed");
}

async function testControlIngressPriorityAndDataFairness(): Promise<void> {
  const config = sceneConfig();
  const runtime = new ProcessRuntime({
    process: {
      name: "control-ingress-priority-self-test",
      scheduling: { maxEventsPerUpdate: 64 },
    },
    scenes: [config],
    knownScenes: [config],
    tickMs: 50,
  });
  await runtime.start();
  const frame = (value: number) => packFrame(Add.msgcode, Add.codec.encode({ value }));
  for (let value = 100; value < 180; value += 1) {
    runtime.pushHostFrame(0, 7, frame(value));
  }
  for (let value = 1; value <= 10; value += 1) {
    runtime.pushHostControlFrame(0, 7, frame(value));
  }

  await runtime.update();
  assert.equal(activeHandlerScene!.handledValues.length, 64);
  assert.deepEqual(
    activeHandlerScene!.handledValues.slice(0, 18),
    [100, 101, 102, 103, 104, 105, 106, 107, 1, 108, 109, 110, 111, 112, 113, 114, 115, 2],
    "control ingress must make bounded progress without starving the dominant data stream",
  );
  await runtime.stop();
}

async function testHostNullSchedulingProjection(): Promise<void> {
  const config = outboundPrioritySceneConfig();
  const runtime = new ProcessRuntime({
    process: {
      name: "host-null-scheduling-self-test",
      scheduling: {
        mode: "adaptive",
        idleTickMs: null,
        maxEventsPerUpdate: null,
        coalesceMicros: null,
      },
    },
    scenes: [config],
    knownScenes: [config],
    tickMs: 50,
  });
  await runtime.start();
  await runtime.update();
  await runtime.stop();
}

async function testRuntimePumpFairness(): Promise<void> {
  const first = sceneConfig();
  const second = { ...first, name: "handler-probe-2" };
  const runtime = new ProcessRuntime({
    process: {
      name: "runtime-pump-fairness-self-test",
      game: { fixedUpdateMs: 10, maxCatchUpSteps: 2 },
      scheduling: { maxEventsPerUpdate: 8 },
    },
    scenes: [first, second],
    knownScenes: [first, second],
    tickMs: 10,
  });
  await runtime.start();
  const baseline = await runtime.update();
  for (let index = 0; index < 20; index += 1) {
    runtime.pushHostFrame(
      0,
      7,
      packFrame(Slow.msgcode, Slow.codec.encode({ busyMs: 2 })),
    );
  }
  runtime.pushHostFrame(
    1,
    8,
    packFrame(Slow.msgcode, Slow.codec.encode({ busyMs: 2 })),
  );
  await new Promise((resolve) => setTimeout(resolve, 12));

  let result = await runtime.update();
  assert.equal(result.pendingIngress, true);
  assert.equal(runtime.CanCommitHotfix, false, "queued ingress must keep the Hotfix barrier closed");
  assert.ok(
    result.game.frameCount > baseline.game.frameCount,
    "fixed Tick must progress even while Scene ingress remains continuously non-empty",
  );
  assert.equal(result.game.skippedFixedUpdates, baseline.game.skippedFixedUpdates);
  assert.equal(result.metrics.find((item) => item.scene === second.name)?.processedFrames, 1);
  for (let attempt = 0; result.pendingIngress && attempt < 30; attempt += 1) {
    result = await runtime.update();
  }
  assert.equal(result.pendingIngress, false);
  assert.equal(runtime.CanCommitHotfix, true, "Hotfix may commit only after ingress is fully drained");
  await runtime.stop();
}

async function testClientOutboundPriority(): Promise<void> {
  activeOutboundPriorityScene = undefined;
  const config = outboundPrioritySceneConfig();
  const runtime = new ProcessRuntime({
    process: { name: "outbound-priority-self-test" },
    scenes: [config],
    knownScenes: [config],
    tickMs: 50,
  });
  await runtime.start();
  activeOutboundPriorityScene!.QueueLatestThenReliable();
  const result = await runtime.update();
  assert.deepEqual(
    result.outbound.map((batch) => batch.frame[1]),
    [1, 2],
    "reliable client frames must drain before replaceable latest state",
  );
  const outboundLanes = result.metrics
    .flatMap((scene) => scene.customMetrics)
    .find((metric) => metric.name === "outbound_lanes");
  assert.equal(outboundLanes?.values.outbound_reliable_depth, 1);
  assert.equal(outboundLanes?.values.outbound_latest_depth, 1);
  assert.equal(outboundLanes?.values.outbound_total_depth, 2);
  assert.equal(outboundLanes?.values.outbound_reliable_depth_max, 1);
  assert.equal(outboundLanes?.values.outbound_latest_depth_max, 1);
  assert.equal(outboundLanes?.values.outbound_reliable_enqueued_total, 1);
  assert.equal(outboundLanes?.values.outbound_latest_enqueued_total, 1);
  await runtime.stop();
}

async function testLatestActorForwardBatch(): Promise<void> {
  activeActorForwardGate = undefined;
  activeActorForwardTarget = undefined;
  const gate = actorForwardGateConfig();
  const target = actorForwardTargetConfig();
  const runtime = new ProcessRuntime({
    process: { name: "actor-forward-self-test" },
    scenes: [gate, target],
    knownScenes: [gate, target],
    tickMs: 50,
  });
  await runtime.start();
  activeActorForwardGate!.Bind(71, activeActorForwardTarget!);

  const frame = (sequence: number) =>
    packFrame(
      LatestActorInputMessage.msgcode,
      LatestActorInputMessage.codec.encode({ sequence }),
    );
  runtime.pushHostFrame(0, 71, frame(1));
  runtime.pushHostFrame(0, 71, frame(2));
  runtime.pushHostFrame(0, 71, frame(3));
  await runtime.update();
  await new Promise((resolve) => setTimeout(resolve, 25));
  const result = await runtime.update();

  assert.deepEqual(activeActorForwardTarget!.probe.sequences, [3]);
  const metric = result.metrics
    .find((item) => item.scene === gate.name)
    ?.customMetrics.find((item) => item.name === "actor_latest_forward");
  assert.equal(metric?.values.queued_total, 3);
  assert.equal(metric?.values.coalesced_total, 2);
  assert.equal(metric?.values.forwarded_total, 1);
  assert.equal(metric?.values.batches_total, 1);
  assert.equal(metric?.values.failed_batches_total, 0);
  await runtime.stop();
}

async function testSynchronousMailboxDrain(): Promise<void> {
  activeMailboxDrainScene = undefined;
  const config = mailboxDrainSceneConfig();
  const runtime = new ProcessRuntime({
    process: { name: "scene-mailbox-drain-self-test" },
    scenes: [config],
    knownScenes: [config],
    tickMs: 50,
  });
  await runtime.start();

  const chainLength = 50_000;
  const result = activeMailboxDrainScene!.dispatchLocalSend(
    packFrame(MailboxDrain.msgcode, MailboxDrain.codec.encode({ remaining: chainLength })),
  );
  assert.equal(result, undefined);
  assert.equal(activeMailboxDrainScene!.processed, chainLength + 1);
  await runtime.stop();
}

async function testLocalSceneSendFastPath(): Promise<void> {
  activeHandlerScene = undefined;
  activeSenderScene = undefined;
  const target = sceneConfig();
  const sender = {
    ...target,
    name: "sender-probe-1",
    sceneType: "SenderProbe",
  };
  const runtime = new ProcessRuntime({
    process: { name: "scene-send-self-test" },
    scenes: [target, sender],
    knownScenes: [target, sender],
    tickMs: 50,
  });
  await runtime.start();
  const delivery = activeSenderScene!.SendAdd(7);
  assert.equal(delivery, undefined);
  assert.equal(activeHandlerScene!.counter.value, 17);
  await runtime.stop();
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
  runtime.pushHostFrame(0, 22, frame(4));
  runtime.pushHostDisconnect(0, 22);
  runtime.update();
  await waitUntil(() => sessionEvents.includes("destroy:22"));
  assert.equal(sessionEvents.includes("start:22:4"), false);
  assert.equal(scene.SessionCount(), 0);
  const ingressMetrics = scene.metricsSnapshot().customMetrics.find(
    (metric) => metric.name === "connection_ingress",
  );
  assert.equal(ingressMetrics?.values.dropped_frames_after_disconnect_total, 1);
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

function mailboxDrainSceneConfig() {
  return {
    name: "scene-mailbox-drain-probe-1",
    sceneType: "MailboxDrainProbe",
    innerIp: "127.0.0.1",
    port: 0,
  };
}

function actorForwardGateConfig() {
  return {
    name: "actor-forward-gate-1",
    sceneType: "ActorForwardGate",
    innerIp: "127.0.0.1",
    port: 0,
  };
}

function actorForwardTargetConfig() {
  return {
    name: "actor-forward-target-1",
    sceneType: "ActorForwardTarget",
    innerIp: "127.0.0.1",
    port: 0,
  };
}

function outboundPrioritySceneConfig() {
  return {
    name: "outbound-priority-probe-1",
    sceneType: "OutboundPriorityProbe",
    innerIp: "127.0.0.1",
    port: 0,
  };
}
