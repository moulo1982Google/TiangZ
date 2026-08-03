import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Actor, ChildEntity, Component } from "../app/core/runtime/entities";
import { Game, InitializeGameSingletons } from "../app/core/runtime/Game";
import { ProcessHost } from "../app/core/runtime/host";
import { MailBoxComponent } from "../app/core/runtime/MailBoxComponent";
import { Session } from "../app/core/runtime/Session";
import { actor, component } from "../app/core/runtime/metadata";
import { SingletonRegistry } from "../app/core/runtime/Singleton";
import { UnitComponent } from "../app/core/runtime/Unit";
import { MapScene } from "../app/model/demo/map/MapScene";
import { PlayerUnit } from "../app/model/demo/map/PlayerUnit";
import { GateSession } from "../app/model/demo/gate/GateSession";
import { PositionComponent } from "../app/model/demo/map/PositionComponent";
import { UnitGateComponent } from "../app/model/demo/map/UnitGateComponent";
import { NativeUnitRef } from "../app/generated/model/native/NativeUnitRef";
import { NativeItemRef } from "../app/generated/model/native/NativeItemRef";
import type { NativeHostOpsApi } from "../app/generated/model/native/NativeOps";
import { NumericComponent } from "../app/model/demo/numeric/NumericComponent";
import { NumericType } from "../app/model/demo/numeric/NumericType";
import { Item } from "../app/model/demo/item/Item";
import { ItemComponent } from "../app/model/demo/item/ItemComponent";
import { TimeSystem } from "../app/core/runtime/TimeSystem";
import { BinaryWriter } from "../app/core/protocol/binary";
import { packFrame } from "../app/core/protocol/registry";
import {
  decodeActorLocationEnvelope,
  ActorLocationDirectory,
  encodeActorLocationEnvelope,
  extractFrameRpcId,
  rewriteFrameRpcId,
} from "../app/core/process/ActorLocation";
import { HotfixSystem, systemFor } from "../app/core/hotReload/HotfixSystem";
import type { HotfixManifest } from "../app/core/hotReload/contracts";
import { GameConfigRegistry } from "../app/generated/model/config";

void main();

async function main(): Promise<void> {
  const gameConfigDirectory = path.resolve("game_config/generated");
  GameConfigRegistry.Install(
    readFileSync(path.join(gameConfigDirectory, "game-config.manifest.json"), "utf8"),
    readFileSync(path.join(gameConfigDirectory, "server.json"), "utf8"),
  );
  InitializeGameSingletons({ fixedUpdateMs: 50, maxCatchUpSteps: 2 });
  try {
    HotfixSystem.Begin(testHotfixManifest("actor-normal"));
    await import("../app/hotfix/demo/map/PlayerUnitSystem");
    await import("../app/hotfix/demo/numeric/NumericComponentSystem");
    await import("../app/hotfix/demo/item/ItemSystem");
    await import("../app/hotfix/demo/item/ItemComponentSystem");
    HotfixSystem.Commit();
    await Promise.resolve();
    testGeneratedNativeHandleScalarAccess();
    await testPlayerUnitComponents();
    await testComponentContainer();
    await testChildEntityContainer();
    await testItemChildEntity();
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

function testHotfixManifest(bundleVersion: string): HotfixManifest {
  return {
    formatVersion: 1,
    bundleVersion,
    modelFingerprint: "actor-self-test",
    modelSourceHash: "actor-self-test",
    protocolFingerprint: "actor-self-test",
    stableCoreApiHash: "actor-self-test",
    nativeSchemaHash: "actor-self-test",
    hotfixHash: bundleVersion,
    buildMode: "demo",
  };
}

function testGeneratedNativeHandleScalarAccess(): void {
  let gets = 0;
  let sets = 0;
  let nextHandle = 7;
  const valuesByHandle = new Map<number, Float64Array>();
  const typesByHandle = new Map<number, number>();
  const numericsByHandle = new Map<number, Map<number, bigint>>();
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
    numericGet: (handle, numericType) => numericsByHandle.get(handle)?.get(numericType) ?? 0n,
    numericSet: (handle, numericType, value) => {
      const values = numericsByHandle.get(handle)!;
      if ((values.get(numericType) ?? 0n) === value) return false;
      if (numericType === NumericType.MaxHp) throw new Error("MaxHp is derived");
      values.set(numericType, value);
      if ([NumericType.MaxHpBase, NumericType.MaxHpAdd, NumericType.MaxHpPct].includes(numericType)) {
        const base = values.get(NumericType.MaxHpBase) ?? 0n;
        const addition = values.get(NumericType.MaxHpAdd) ?? 0n;
        const percentage = values.get(NumericType.MaxHpPct) ?? 0n;
        values.set(NumericType.MaxHp, (base + addition) * (100n + percentage) / 100n);
      }
      return true;
    },
    mapPeekNumericDelta: () => new Uint8Array(14),
    mapAckNumericDelta: () => undefined,
    mapMarkAllNumericsDirty: () => undefined,
    unitSetMovementInput: (handle, inputX, inputZ, sequence) => {
      const values = valuesByHandle.get(handle)!;
      if (sequence <= values[20]) return false;
      values[17] = inputX;
      values[18] = inputZ;
      values[19] = 1;
      values[20] = sequence;
      return true;
    },
    unitResetMovement: (handle) => {
      const values = valuesByHandle.get(handle)!;
      values[17] = 0;
      values[18] = 0;
      values[19] = 0;
      values[20] = 0;
    },
    mapUpdateMovement: () => new Uint8Array(0),
    dataTakeMetrics: () => new Uint8Array(84),
  };

  const host = new ProcessHost("native-handle-self-test");
  host.spawnScene("map:1", MapScene);
  const actor = host.spawnActor("map:1", "native-probe", ComponentProbeActor);
  const unit = actor.AddComponent(NativeUnitRef, {
    id: 1,
    instanceId: 2,
    mapId: 1,
    x: 1,
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
  assert.equal(valuesByHandle.get(unit.Handle)![3], 2);
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

  get Value(): string {
    return this.awakeValue;
  }

  protected override OnDestroy(): void {
    this.destroyed = true;
  }
}

@actor({ mailbox: "ordered" })
class ComponentProbeActor extends Actor {}

@component()
class AsyncAwakeComponent extends Component {
  protected override async Awake(): Promise<void> {
    await Promise.resolve();
  }
}

class LifecycleProbeChild extends ChildEntity<[value: string]> {
  value = "";
  ticks = 0;
  destroyed = false;

  protected override Awake(value: string): void {
    this.value = value;
  }

  Tick(): void {
    this.ticks += 1;
  }

  protected override OnDestroy(): void {
    this.destroyed = true;
  }
}

class AsyncAwakeChild extends ChildEntity {
  protected override async Awake(): Promise<void> {
    await Promise.resolve();
  }
}

@component()
class ChildOwnerComponent extends Component {}

async function testComponentContainer(): Promise<void> {
  const host = new ProcessHost("component-self-test");
  host.spawnScene("map:1", MapScene);
  const actor = host.spawnActor("map:1", "component-probe", ComponentProbeActor);

  const component = actor.AddComponent(
    LifecycleProbeComponent,
    "component-value",
  );
  assert.equal(actor.GetComponent(LifecycleProbeComponent), component);
  assert.equal(actor.TryGetComponent(LifecycleProbeComponent), component);
  assert.equal(actor.HasComponent(LifecycleProbeComponent), true);
  assert.equal(component.Value, "component-value");
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

async function testChildEntityContainer(): Promise<void> {
  const host = new ProcessHost("child-entity-self-test");
  const map = host.spawnScene("map:1", MapScene);
  const actor = host.spawnActor("map:1", "child-owner", ComponentProbeActor);
  const owner = actor.AddComponent(ChildOwnerComponent);
  const rootCountBefore = host.Root.Count;
  const child = owner.AddChild(LifecycleProbeChild, 101, "awake-value");

  assert.equal(child.Id, 101);
  assert.equal(child.Parent, owner);
  assert.equal(child.DomainScene(), map);
  assert.equal(child.value, "awake-value");
  assert.equal(owner.GetChild(LifecycleProbeChild, 101), child);
  assert.equal(owner.TryGetChild(LifecycleProbeChild, 101), child);
  assert.deepEqual(owner.GetChildren(LifecycleProbeChild), [child]);
  assert.equal(owner.ChildCount, 1);
  assert.equal(host.Root.Get(child.InstanceId), child);
  assert.equal(host.Root.Count, rootCountBefore + 1);
  assert.equal(child.HasComponent(MailBoxComponent), false);
  assert.throws(
    () => owner.AddChild(LifecycleProbeChild, 101, "duplicate"),
    /already has child/,
  );

  const timerBase = TimeSystem.Instance.FrameTime;
  child.NewRepeatedTimer(10, "Tick");
  Game.Instance.Update(timerBase + 10, Date.now(), () => undefined);
  await Promise.resolve();
  assert.equal(child.ticks, 1);

  assert.throws(
    () => owner.AddChild(AsyncAwakeChild, 102),
    /Awake must be synchronous/,
  );
  assert.equal(owner.TryGetChild(AsyncAwakeChild, 102), undefined);
  assert.equal(host.Root.Count, rootCountBefore + 1);

  const childInstanceId = child.InstanceId;
  const removed = owner.RemoveChild(LifecycleProbeChild, 101);
  assert.equal(removed, child);
  assert.equal(child.IsDisposed, true);
  assert.equal(child.destroyed, true);
  assert.equal(host.Root.Get(childInstanceId), undefined);
  assert.equal(owner.ChildCount, 0);

  const cascaded = owner.AddChild(LifecycleProbeChild, 103, "cascade");
  assert.equal(actor.RemoveComponent(ChildOwnerComponent), true);
  assert.equal(cascaded.IsDisposed, true);
  assert.equal(cascaded.destroyed, true);
  assert.equal(host.Root.Count, rootCountBefore);
  host.Dispose();
}

async function testItemChildEntity(): Promise<void> {
  const host = new ProcessHost("item-child-self-test");
  host.spawnScene("map:1", MapScene);
  const actor = host.spawnActor("map:1", "item-owner", ComponentProbeActor);
  const inventory = actor.AddComponent(ItemComponent);
  const item = inventory.GetChildren(Item)[0];
  assert.ok(item);

  assert.equal(item.Parent, inventory);
  assert.equal(item.instanceId, item.InstanceId);
  assert.equal(item.configId, 1001);
  assert.equal(item.count, 3);
  assert.equal(host.Root.Get(item.InstanceId), item);
  assert.equal(inventory.UseItem(item.id).count, 2);
  assert.equal(inventory.AddItem(item.id, 2).count, 4);
  assert.equal(inventory.RemoveItem(item.id, 3).count, 1);

  const instanceId = item.InstanceId;
  assert.equal(host.despawnActor("map:1", "item-owner"), true);
  assert.equal(item.IsDisposed, true);
  assert.equal(host.Root.Get(instanceId), undefined);
  host.Dispose();
}

async function testPlayerUnitComponents(): Promise<void> {
  const host = new ProcessHost("actor-self-test");
  const map = host.spawnScene("map:1", MapScene);
  const defaultSession = map.SpawnActor(99_000, Session);
  assert.equal(defaultSession.GetComponent(MailBoxComponent).MailboxType, "unordered");
  await assertUnorderedMailbox(host, defaultSession);
  assert.equal(map.DespawnActor(99_000), true);
  const gateSession = map.SpawnActor(99_001, GateSession);
  assert.equal(gateSession.GetComponent(MailBoxComponent).MailboxType, "unordered");
  await assertUnorderedMailbox(host, gateSession);
  assert.equal(map.DespawnActor(99_001), true);
  const units = map.AddComponent(UnitComponent);
  const player = units.Create(1000, PlayerUnit, {
    account: "tester",
    mapId: 1,
  });
  const native = player.AddComponent(NativeUnitRef, {
    id: 1000,
    instanceId: player.InstanceId,
    mapId: 1,
    x: 1,
    y: 0,
    z: -1,
    cellX: 1,
    cellZ: -1,
    targetCellX: 1,
    targetCellZ: -1,
  });
  player.AddComponent(PositionComponent, native, 128, 128, 1);
  const numeric = player.AddComponent(NumericComponent);
  player.AddComponent(UnitGateComponent, "gate-1");
  const firstInstanceId = player.InstanceId;

  assert.equal(player.Id, 1000);
  assert.equal(player.UnitId, 1000);
  assert.equal(player.InstanceId, firstInstanceId);
  assert.equal(player.Parent, units);
  assert.equal(player.DomainScene(), map);
  assert.equal(host.Root.Get(firstInstanceId), player);
  assert.equal(player.GetComponent(MailBoxComponent).MailboxType, "ordered");
  await assertOrderedMailbox(host, player);
  assert.equal(player.GetComponent(NumericComponent), numeric);
  assert.equal(numeric[NumericType.CurrentHp], 100n);
  assert.equal(numeric[NumericType.MaxHp], 1000n);
  numeric[NumericType.MaxHpAdd] += 100n;
  numeric[NumericType.MaxHpPct] += 20n;
  assert.equal(numeric[NumericType.MaxHp], 1320n);
  numeric[NumericType.CurrentHp] += 1n;
  assert.equal(numeric[NumericType.CurrentHp], 101n);

  const initialized = player.Snapshot();
  assert.equal(units.Get<PlayerUnit>(1000), player);
  assert.deepEqual(units.GetAll(PlayerUnit), [player]);
  assert.deepEqual(
    { x: initialized.x, y: initialized.y, z: initialized.z },
    { x: 1, y: 0, z: -1 },
  );
  assert.deepEqual(
    { cellX: initialized.cellX, cellZ: initialized.cellZ },
    { cellX: 1, cellZ: -1 },
  );

  player.SecondEnterMap();
  assert.equal(player.MatchesGate({ gateName: "gate-1" }), true);
  assert.equal(player.MatchesGate({ gateName: "gate-2" }), false);

  assert.equal(
    player.Move({
      inputX: 1,
      inputZ: 0,
      sequence: 5,
    }),
    true,
  );

  assert.equal(
    player.Move({
      inputX: 0,
      inputZ: 0,
      sequence: 5,
    }),
    false,
  );
  assert.throws(
    () => player.Move({
      inputX: 2,
      inputZ: 0,
      sequence: 6,
    }),
    /invalid movement input/,
  );

  const stableHandle = native.Handle;
  HotfixSystem.Begin(testHotfixManifest("actor-inverted"));
  await import("../perf/hotfix/fixtures/inverted");
  const { NumericComponentSystem } = await import(
    "../app/hotfix/demo/numeric/NumericComponentSystem"
  );
  const { ItemSystem } = await import("../app/hotfix/demo/item/ItemSystem");
  const { ItemComponentSystem } = await import(
    "../app/hotfix/demo/item/ItemComponentSystem"
  );
  systemFor(NumericComponent)(NumericComponentSystem);
  systemFor(Item)(ItemSystem);
  systemFor(ItemComponent)(ItemComponentSystem);
  HotfixSystem.Commit();
  assert.equal(
    player.Move({ inputX: 0, inputZ: 1, sequence: 6 }),
    true,
  );
  assert.equal(native.inputZ, -1);
  assert.equal(player.InstanceId, firstInstanceId);
  assert.equal(native.Handle, stableHandle);

  assert.equal(units.Remove(1000), player);
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
  recreated.AddComponent(UnitGateComponent, "gate-2");
  assert.notEqual(recreated.InstanceId, firstInstanceId);
  assert.equal(host.despawnActor("map:1", 1000), true);
  assert.equal(units.Get(1000), undefined);
}

/** 验证unordered Actor不会让一个等待中的RPC阻塞后续无关调用。 / Verifies that an awaiting unordered Actor does not block a later unrelated call. */
async function assertUnorderedMailbox(host: ProcessHost, actor: Actor<any[]>): Promise<void> {
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => release = resolve);
  const first = Promise.resolve(host.runActorMailbox(actor.InstanceId, () => blocker));
  const second = host.runActorMailbox(actor.InstanceId, () => "concurrent");
  assert.equal(await Promise.resolve(second), "concurrent");
  release();
  await first;
}

/** 验证ordered PlayerUnit会把后续调用保留到前一个异步事务完成。 / Verifies that an ordered PlayerUnit retains a later call until the previous async transaction completes. */
async function assertOrderedMailbox(host: ProcessHost, actor: Actor<any[]>): Promise<void> {
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => release = resolve);
  const first = Promise.resolve(host.runActorMailbox(actor.InstanceId, () => blocker));
  let secondRan = false;
  const second = Promise.resolve(host.runActorMailbox(actor.InstanceId, () => {
    secondRan = true;
  }));
  await Promise.resolve();
  assert.equal(secondRan, false);
  release();
  await Promise.all([first, second]);
  assert.equal(secondRan, true);
}

@actor({ mailbox: "ordered" })
class OrderedProbeActor extends Actor {
  readonly completed: number[] = [];
  maxRunning = 0;
  private running = 0;

  async Run(request: { id: number; delayMs: number }): Promise<void> {
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

  await Promise.all([
    host.runActorMailbox(probe.InstanceId, (actor) =>
      (actor as OrderedProbeActor).Run({ id: 1, delayMs: 10 })
    ),
    host.runActorMailbox(probe.InstanceId, (actor) =>
      (actor as OrderedProbeActor).Run({ id: 2, delayMs: 0 })
    ),
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

  async WaitForDespawn(): Promise<string> {
    await this.gate;
    return "stale-success";
  }
}

async function testActorDespawnRejectsInFlightAndQueuedCalls(): Promise<void> {
  const host = new ProcessHost("actor-despawn-self-test");
  host.spawnScene("map:1", MapScene);
  const probe = host.spawnActor("map:1", "probe", DespawnProbeActor);
  const running = host.runActorMailbox(probe.InstanceId, (actor) =>
    (actor as DespawnProbeActor).WaitForDespawn()
  );
  const queued = host.runActorMailbox(probe.InstanceId, (actor) =>
    (actor as DespawnProbeActor).WaitForDespawn()
  );

  assert.equal(host.despawnActor("map:1", "probe"), true);
  await assert.rejects(Promise.resolve(queued), /actor despawned/);
  probe.release();
  await assert.rejects(Promise.resolve(running), /actor despawned during mailbox execution/);
}

@actor({ mailbox: "unordered" })
class UnorderedProbeActor extends Actor {
  maxRunning = 0;
  private running = 0;

  async Run(request: { fail?: boolean }): Promise<string> {
    this.running += 1;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    await Promise.resolve();
    this.running -= 1;
    if (request.fail) throw new Error("isolated unordered failure");
    return "ok";
  }
}

async function testUnorderedActorIsolation(): Promise<void> {
  const host = new ProcessHost("unordered-self-test");
  host.spawnScene("map:1", MapScene);
  const probe = host.spawnActor("map:1", "probe", UnorderedProbeActor);
  const results = await Promise.allSettled([
    host.runActorMailbox(probe.InstanceId, (actor) =>
      (actor as UnorderedProbeActor).Run({})
    ),
    host.runActorMailbox(probe.InstanceId, (actor) =>
      (actor as UnorderedProbeActor).Run({ fail: true })
    ),
  ]);

  assert.equal(probe.maxRunning, 2);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
}

function testReconnectStormKeepsLatestLocation(): void {
  const directory = new ActorLocationDirectory();
  const mapScene = {
    name: "map-1",
    sceneType: "MapHost",
    innerIp: "127.0.0.1",
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
