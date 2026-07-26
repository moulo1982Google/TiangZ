import assert from "node:assert/strict";
import {
  Actor,
  Component,
  MailBoxComponent,
  ProcessHost,
  InitializeGameSingletons,
  SingletonRegistry,
  UnitComponent,
  actor,
  component,
  handler,
} from "../app/core/runtime";
import { MapScene } from "../app/demo/map/MapScene";
import { PlayerUnit } from "../app/demo/map/PlayerUnit";
import { PositionComponent } from "../app/demo/map/PositionComponent";
import { UnitGateComponent } from "../app/demo/map/UnitGateComponent";
import { NativeUnitRef } from "../app/generated/model/native/NativeUnitRef";
import { NativeItemRef } from "../app/generated/model/native/NativeItemRef";
import type { NativeHostOpsApi } from "../app/generated/model/native/NativeOps";
import { NumericComponent } from "../app/demo/numeric/NumericComponent";
import { NumericType } from "../app/demo/numeric/NumericType";
import { BinaryWriter } from "../app/core/protocol/binary";
import { packFrame } from "../app/core/protocol/registry";
import {
  decodeActorLocationEnvelope,
  ActorLocationDirectory,
  encodeActorLocationEnvelope,
  extractFrameRpcId,
  rewriteFrameRpcId,
} from "../app/core/process/ActorLocation";

void main();

async function main(): Promise<void> {
  InitializeGameSingletons({ fixedUpdateMs: 50, maxCatchUpSteps: 2 });
  try {
    await Promise.resolve();
    testGeneratedNativeHandleScalarAccess();
    await testPlayerUnitComponents();
    await testComponentContainer();
    await testOrderedActorMailbox();
    await testActorDespawnRejectsInFlightAndQueuedCalls();
    await testUnorderedActorIsolation();
    testReconnectStormKeepsLatestLocation();
    testRpcIdRewrite();
    console.log("actor self-test passed");
  } finally {
    SingletonRegistry.DestroyAll();
  }
}

function testGeneratedNativeHandleScalarAccess(): void {
  let gets = 0;
  let sets = 0;
  let nextHandle = 7;
  const valuesByHandle = new Map<number, Float64Array>();
  const typesByHandle = new Map<number, number>();
  const numericsByHandle = new Map<number, Map<number, number>>();
  (globalThis as typeof globalThis & {
    __etsNativeOps?: NativeHostOpsApi;
  }).__etsNativeOps = {
    entityCreate: (entityType, values) => {
      const handle = nextHandle++;
      valuesByHandle.set(handle, values.slice());
      typesByHandle.set(handle, entityType);
      return handle;
    },
    entityGetNumber: (handle, field) => {
      gets += 1;
      return valuesByHandle.get(handle)![field - 1];
    },
    entitySetNumber: (handle, field, value) => {
      sets += 1;
      valuesByHandle.get(handle)![field - 1] = value;
    },
    entityDestroy: (handle) => {
      valuesByHandle.delete(handle);
      typesByHandle.delete(handle);
    },
    numericAttach: (handle) => { numericsByHandle.set(handle, new Map()); },
    numericDetach: (handle) => { numericsByHandle.delete(handle); },
    numericGet: (handle, numericType) => numericsByHandle.get(handle)?.get(numericType) ?? 0,
    numericSet: (handle, numericType, value) => {
      const values = numericsByHandle.get(handle)!;
      if ((values.get(numericType) ?? 0) === value) return false;
      values.set(numericType, value);
      return true;
    },
    mapPeekNumericDelta: () => new Uint8Array(14),
    mapAckNumericDelta: () => undefined,
    mapMarkAllNumericsDirty: () => undefined,
    unitSetMovementInput: (handle, inputX, inputY, sequence) => {
      const values = valuesByHandle.get(handle)!;
      if (sequence <= values[16]) return false;
      values[13] = inputX;
      values[14] = inputY;
      values[15] = 1;
      values[16] = sequence;
      return true;
    },
    unitResetMovement: (handle) => {
      const values = valuesByHandle.get(handle)!;
      values[13] = 0;
      values[14] = 0;
      values[15] = 0;
      values[16] = 0;
    },
    mapUpdateMovement: () => new Uint8Array(0),
    dataTakeMetrics: () => new Uint8Array(56),
  };

  const host = new ProcessHost("native-handle-self-test");
  host.spawnScene("map:1", MapScene);
  const actor = host.spawnActor("map:1", "native-probe", ComponentProbeActor);
  const unit = actor.AddComponent(NativeUnitRef, {
    id: 1,
    instanceId: 2,
    mapId: 1,
    x: 12,
    y: 0,
  });
  const item = NativeItemRef.Create({
    id: 100,
    instanceId: 101,
    configId: 3001,
    count: 2,
  });
  unit.x += 1;
  item.count += 2;

  assert.equal(typesByHandle.get(unit.Handle), 1);
  assert.equal(typesByHandle.get(item.Handle), 2);
  assert.equal(valuesByHandle.get(unit.Handle)![3], 13);
  assert.equal(valuesByHandle.get(item.Handle)![3], 4);
  assert.equal(gets, 2);
  assert.equal(sets, 2);
  item.Dispose();
  assert.equal(host.despawnActor("map:1", "native-probe"), true);
  assert.equal(valuesByHandle.size, 0);
}

function testRpcIdRewrite(): void {
  const writer = new BinaryWriter();
  writer.uint32(1, 7);
  writer.bytes(2, Uint8Array.from([0xd0, 0x05, 0x7f]));
  writer.uint32(90, 1);
  const frame = packFrame(12_345, writer.finish());
  const rewritten = rewriteFrameRpcId(frame, 300_000);

  assert.equal(extractFrameRpcId(frame), 1);
  assert.equal(extractFrameRpcId(rewritten), 300_000);
  assert.equal(rewritten[0], frame[0]);
  assert.equal(rewritten[1], frame[1]);
  assert.throws(
    () => rewriteFrameRpcId(packFrame(12_345, Uint8Array.from([8, 1])), 2),
    /no rpcId/,
  );

  const envelope = encodeActorLocationEnvelope({
    instanceId: 9_007_199_254_000,
    rpcId: 300_000,
    frame: rewritten,
  });
  const decoded = decodeActorLocationEnvelope(envelope);
  assert.equal(decoded.instanceId, 9_007_199_254_000);
  assert.equal(decoded.rpcId, 300_000);
  assert.deepEqual(decoded.frame, rewritten);
}

@component()
class LifecycleProbeComponent extends Component<[value: string]> {
  destroyed = false;
  private awakeValue = "";

  protected override Awake(value: string): void {
    this.awakeValue = value;
  }

  @handler("Probe.ComponentValue")
  private value(): string {
    return this.awakeValue;
  }

  protected override OnDestroy(): void {
    this.destroyed = true;
  }
}

@actor({ mailbox: "ordered" })
class ComponentProbeActor extends Actor {
  @handler("Probe.Noop")
  private noop(): void {}
}

@component()
class AsyncAwakeComponent extends Component {
  protected override async Awake(): Promise<void> {
    await Promise.resolve();
  }
}

async function testComponentContainer(): Promise<void> {
  const host = new ProcessHost("component-self-test");
  host.spawnScene("map:1", MapScene);
  const actor = host.spawnActor("map:1", "component-probe", ComponentProbeActor);
  const actorRef = host.localActorRef("map:1", "component-probe");

  const component = actor.AddComponent(
    LifecycleProbeComponent,
    "component-value",
  );
  assert.equal(actor.GetComponent(LifecycleProbeComponent), component);
  assert.equal(actor.TryGetComponent(LifecycleProbeComponent), component);
  assert.equal(actor.HasComponent(LifecycleProbeComponent), true);
  assert.equal(
    await host.call(undefined, actorRef, "Probe.ComponentValue"),
    "component-value",
  );
  assert.throws(
    () => actor.AddComponent(LifecycleProbeComponent, "duplicate"),
    /already has component/,
  );
  assert.throws(
    () => actor.AddComponent(AsyncAwakeComponent),
    /Awake must be synchronous/,
  );
  assert.equal(actor.HasComponent(AsyncAwakeComponent), false);

  assert.equal(actor.RemoveComponent(LifecycleProbeComponent), true);
  assert.equal(component.IsDisposed, true);
  assert.equal(component.destroyed, true);
  assert.equal(actor.TryGetComponent(LifecycleProbeComponent), undefined);
  assert.equal(actor.RemoveComponent(LifecycleProbeComponent), false);
  await assert.rejects(
    host.call(undefined, actorRef, "Probe.ComponentValue"),
    /handler not found/,
  );
  assert.throws(
    () => actor.GetComponent(LifecycleProbeComponent),
    /component not found/,
  );

  const componentAtDespawn = actor.AddComponent(
    LifecycleProbeComponent,
    "despawn",
  );
  assert.equal(host.despawnActor("map:1", "component-probe"), true);
  assert.equal(actor.IsDisposed, true);
  assert.equal(componentAtDespawn.IsDisposed, true);
  assert.throws(
    () => actor.AddComponent(LifecycleProbeComponent, "disposed"),
    /entity is disposed/,
  );
}

async function testPlayerUnitComponents(): Promise<void> {
  const host = new ProcessHost("actor-self-test");
  const map = host.spawnScene("map:1", MapScene);
  const units = map.AddComponent(UnitComponent);
  const player = units.Create(1000, PlayerUnit, {
    account: "tester",
    mapId: 1,
  });
  const native = player.AddComponent(NativeUnitRef, {
    id: 1000,
    instanceId: player.InstanceId,
    mapId: 1,
    x: 12,
    y: -12,
    cellX: 1,
    cellY: -1,
    targetCellX: 1,
    targetCellY: -1,
  });
  player.AddComponent(PositionComponent, native);
  const numeric = player.AddComponent(NumericComponent);
  player.AddComponent(UnitGateComponent, "gate-1", "session-1");
  const actor = host.localActorRef("map:1", 1000);
  const firstInstanceId = actor.instanceId;

  assert.equal(player.Id, 1000);
  assert.equal(player.UnitId, 1000);
  assert.equal(player.InstanceId, actor.instanceId);
  assert.equal(player.Parent, units);
  assert.equal(player.DomainScene(), map);
  assert.equal(host.Root.Get(actor.instanceId), player);
  assert.equal(player.GetComponent(MailBoxComponent).MailboxType, "ordered");
  assert.equal(player.GetComponent(NumericComponent), numeric);
  assert.equal(numeric[NumericType.CurrentHp], 100);
  numeric[NumericType.CurrentHp] += 1;
  assert.equal(numeric[NumericType.CurrentHp], 101);

  const initialized = player.Snapshot();
  assert.equal(units.Get<PlayerUnit>(1000), player);
  assert.deepEqual(units.GetAll(PlayerUnit), [player]);
  assert.deepEqual(
    { x: initialized.x, y: initialized.y },
    { x: 12, y: -12 },
  );
  assert.deepEqual(
    { cellX: initialized.cellX, cellY: initialized.cellY },
    { cellX: 1, cellY: -1 },
  );

  player.RebindGate({
    gateName: "gate-2",
    gateSessionId: "session-2",
  });
  assert.equal(
    player.MatchesGate({
      gateName: "gate-1",
      gateSessionId: "session-1",
    }),
    false,
  );
  assert.equal(
    player.MatchesGate({
      gateName: "gate-2",
      gateSessionId: "session-2",
    }),
    true,
  );

  for (let generation = 3; generation <= 1002; generation += 1) {
    player.RebindGate({
      gateName: `gate-${generation % 4}`,
      gateSessionId: `session-${generation}`,
    });
  }
  assert.equal(
    player.MatchesGate({ gateName: "gate-2", gateSessionId: "session-2" }),
    false,
  );
  assert.equal(
    player.MatchesGate({ gateName: "gate-2", gateSessionId: "session-1002" }),
    true,
  );

  assert.equal(
    player.Move({
      inputX: 1,
      inputY: 0,
      sequence: 5,
    }),
    true,
  );

  assert.equal(
    player.Move({
      inputX: 0,
      inputY: 0,
      sequence: 5,
    }),
    false,
  );
  assert.throws(
    () => player.Move({
      inputX: 2,
      inputY: 0,
      sequence: 6,
    }),
    /invalid movement input/,
  );

  assert.equal(units.Remove(1000), player);
  assert.equal(host.hasActor("map:1", 1000), false);
  assert.equal(host.Root.Get(firstInstanceId), undefined);
  await assert.rejects(
    host.runActorMailbox(firstInstanceId, () => undefined),
    /actor instance not found/,
  );

  const recreated = units.Create(1000, PlayerUnit, {
    account: "tester",
    mapId: 1,
  });
  const recreatedNative = recreated.AddComponent(NativeUnitRef, {
    id: 1000,
    instanceId: recreated.InstanceId,
    mapId: 1,
  });
  recreated.AddComponent(PositionComponent, recreatedNative);
  recreated.AddComponent(NumericComponent);
  recreated.AddComponent(UnitGateComponent, "gate-2", "session-2");
  assert.notEqual(recreated.InstanceId, firstInstanceId);
  await assert.rejects(
    host.call(undefined, actor, "Probe.Noop"),
    /target not found/,
  );
  assert.equal(host.despawnActor("map:1", 1000), true);
  assert.equal(units.Get(1000), undefined);
}

@actor({ mailbox: "ordered" })
class OrderedProbeActor extends Actor {
  readonly completed: number[] = [];
  maxRunning = 0;
  private running = 0;

  @handler("Probe.Run")
  private async run(request: { id: number; delayMs: number }): Promise<void> {
    this.running += 1;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    await new Promise((resolve) => setTimeout(resolve, request.delayMs));
    this.completed.push(request.id);
    this.running -= 1;
  }
}

async function testOrderedActorMailbox(): Promise<void> {
  const host = new ProcessHost("mailbox-self-test");
  host.spawnScene("map:1", MapScene);
  const probe = host.spawnActor("map:1", "probe", OrderedProbeActor);
  const actor = host.localActorRef("map:1", "probe");

  await Promise.all([
    host.call(undefined, actor, "Probe.Run", { id: 1, delayMs: 10 }),
    host.call(undefined, actor, "Probe.Run", { id: 2, delayMs: 0 }),
  ]);

  assert.equal(probe.maxRunning, 1);
  assert.deepEqual(probe.completed, [1, 2]);
}

@actor({ mailbox: "ordered" })
class DespawnProbeActor extends Actor {
  private releaseGate!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });

  release(): void {
    this.releaseGate();
  }

  @handler("Probe.WaitForDespawn")
  private async waitForDespawn(): Promise<string> {
    await this.gate;
    return "stale-success";
  }
}

async function testActorDespawnRejectsInFlightAndQueuedCalls(): Promise<void> {
  const host = new ProcessHost("actor-despawn-self-test");
  host.spawnScene("map:1", MapScene);
  const probe = host.spawnActor("map:1", "probe", DespawnProbeActor);
  const actor = host.localActorRef("map:1", "probe");
  const running = host.call<string>(undefined, actor, "Probe.WaitForDespawn");
  const queued = host.call<string>(undefined, actor, "Probe.WaitForDespawn");

  assert.equal(host.despawnActor("map:1", "probe"), true);
  await assert.rejects(queued, /actor despawned/);
  probe.release();
  await assert.rejects(running, /target despawned during dispatch/);
}

@actor({ mailbox: "unordered" })
class UnorderedProbeActor extends Actor {
  maxRunning = 0;
  private running = 0;

  @handler("Probe.UnorderedRun")
  private async run(request: { fail?: boolean }): Promise<string> {
    this.running += 1;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    await Promise.resolve();
    this.running -= 1;
    if (request.fail) throw new Error("isolated unordered failure");
    return "ok";
  }

  @handler("Probe.UnorderedSelf")
  private selfCall(): Promise<string> {
    return this.ctx.call(this.ctx.self, "Probe.UnorderedLeaf");
  }

  @handler("Probe.UnorderedLeaf")
  private leaf(): string {
    return "self-ok";
  }
}

async function testUnorderedActorIsolation(): Promise<void> {
  const host = new ProcessHost("unordered-self-test");
  host.spawnScene("map:1", MapScene);
  const probe = host.spawnActor("map:1", "probe", UnorderedProbeActor);
  const actor = host.localActorRef("map:1", "probe");
  const results = await Promise.allSettled([
    host.call(undefined, actor, "Probe.UnorderedRun", {}),
    host.call(undefined, actor, "Probe.UnorderedRun", { fail: true }),
  ]);

  assert.equal(probe.maxRunning, 2);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(
    await host.call(undefined, actor, "Probe.UnorderedSelf"),
    "self-ok",
  );
}

function testReconnectStormKeepsLatestLocation(): void {
  const directory = new ActorLocationDirectory();
  const mapScene = {
    name: "map-1",
    sceneType: "MapHost",
    ip: "127.0.0.1",
    port: 7301,
  };
  let previousConnectionId = 0;
  for (let generation = 1; generation <= 5000; generation += 1) {
    const connectionId = 10_000 + generation;
    directory.bindConnection(connectionId, {
      instanceId: generation,
      scene: mapScene,
    });
    if (previousConnectionId !== 0) {
      directory.unbindConnection(previousConnectionId);
      assert.equal(directory.resolveConnection(previousConnectionId), undefined);
    }
    assert.equal(
      directory.resolveConnection(connectionId)?.instanceId,
      generation,
    );
    previousConnectionId = connectionId;
  }

  const latestConnectionId = 99_999;
  directory.bindConnection(latestConnectionId, {
    instanceId: 5000,
    scene: mapScene,
  });
  directory.unbindConnection(previousConnectionId);
  assert.equal(directory.resolveConnection(latestConnectionId)?.instanceId, 5000);
}
