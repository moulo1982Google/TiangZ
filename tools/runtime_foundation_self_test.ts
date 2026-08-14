import assert from "node:assert/strict";
import { ProcessHost } from "../app/core/runtime/host";
import {
  Component,
  ChildEntity,
  Scene,
} from "../app/core/runtime/entities";
import { InitializeGameSingletons } from "../app/core/runtime/Game";
import { ProcessRuntime } from "../app/core/process/ProcessRuntime";
import {
  GlobalIdSystem,
  InstanceIdSystem,
  type TimerId,
} from "../app/core/runtime/IdSystem";
import { scene } from "../app/core/runtime/metadata";
import {
  defineSyncEvent,
  defineVetoEvent,
  syncEventHandler,
  vetoEventHandler,
  type SyncSceneEventHandler,
  type VetoSceneEventHandler,
} from "../app/core/runtime/SceneEventSystem";
import { SingletonRegistry } from "../app/core/runtime/Singleton";
import type { TimerCancelledContext } from "../app/core/runtime/TimerSystem";
import { TimeSystem } from "../app/core/runtime/TimeSystem";
import { TimerSystem } from "../app/core/runtime/TimerSystem";

interface FoundationSyncEvent { readonly value: number }
interface FoundationVetoEvent { readonly blocked: boolean }
const FoundationEvents = {
  Sync: defineSyncEvent<FoundationSyncEvent>("Foundation.Sync"),
  Veto: defineVetoEvent<FoundationVetoEvent, number>("Foundation.Veto", 0),
} as const;

@scene({ sceneType: "Foundation" })
class FoundationScene extends Scene {
  syncTotal = 0;
  vetoChecks: string[] = [];
}

@syncEventHandler(FoundationScene, FoundationEvents.Sync, { id: "foundation.sync" })
class FoundationSyncHandler implements SyncSceneEventHandler<FoundationScene, FoundationSyncEvent> {
  Handle(scene: FoundationScene, event: FoundationSyncEvent): void {
    scene.syncTotal += event.value;
  }
}

@vetoEventHandler(FoundationScene, FoundationEvents.Veto, {
  id: "foundation.veto.first",
  order: 10,
})
class FoundationFirstVetoHandler implements VetoSceneEventHandler<FoundationScene, FoundationVetoEvent, number> {
  Handle(scene: FoundationScene, event: FoundationVetoEvent): number {
    scene.vetoChecks.push("first");
    return event.blocked ? 7001 : 0;
  }
}

@vetoEventHandler(FoundationScene, FoundationEvents.Veto, {
  id: "foundation.veto.second",
  order: 20,
})
class FoundationSecondVetoHandler implements VetoSceneEventHandler<FoundationScene, FoundationVetoEvent, number> {
  Handle(scene: FoundationScene, _event: FoundationVetoEvent): number {
    scene.vetoChecks.push("second");
    return 0;
  }
}

interface TimerArgs { readonly label: string }

class TimerProbeComponent extends Component {
  elapsedArgs: TimerArgs | undefined;
  cancelledArgs: TimerArgs | undefined;
  cancelledContext: TimerCancelledContext | undefined;

  OnElapsed(args: TimerArgs): void {
    this.elapsedArgs = args;
  }

  OnCancelled(args: TimerArgs, context: TimerCancelledContext): void {
    this.cancelledArgs = args;
    this.cancelledContext = context;
  }
}

class FoundationChild extends ChildEntity<[string]> {
  label = "";

  protected override Awake(label: string): void {
    this.label = label;
  }
}

class CascadingChildrenComponent extends Component {
  child!: FoundationChild;

  protected override Awake(): void {
    this.child = this.AddChild(FoundationChild, 9001n, "owned");
  }
}

void main();

async function main(): Promise<void> {
  testFailedBootstrapRollback();
  InitializeGameSingletons(
    { fixedUpdateMs: 50, maxCatchUpSteps: 2 },
    { originServerId: 7, workerId: 3 },
  );
  try {
    testGlobalAndInstanceIds();
    testTimeSemantics();
    testTimerArgumentsAndCancellation();
    await testCoroutineLockIsolation();
    await testSceneEventsAndTasks();
    testSceneDisposeCascadesOwnedEntities();
    console.log("runtime foundation self-test passed");
  } finally {
    SingletonRegistry.DestroyAll();
  }
}

function testFailedBootstrapRollback(): void {
  assert.throws(
    () => new ProcessRuntime({
      process: {
        name: "invalid-bootstrap",
        identity: { originServerId: 0, workerId: 0 },
      },
      scenes: [],
      knownScenes: [],
      tickMs: 50,
    }),
    /originServerId/,
  );
  assert.equal(SingletonRegistry.TryGet(TimeSystem), undefined);
  assert.equal(SingletonRegistry.TryGet(InstanceIdSystem), undefined);
  assert.equal(SingletonRegistry.TryGet(GlobalIdSystem), undefined);
  assert.equal(SingletonRegistry.TryGet(TimerSystem), undefined);
}

function testGlobalAndInstanceIds(): void {
  const first = GlobalIdSystem.Instance.Next();
  const second = GlobalIdSystem.Instance.Next();
  assert.ok(second > first);
  assert.equal(GlobalIdSystem.OriginServerId(first), 7);
  assert.ok(first <= 0x7fff_ffff_ffff_ffffn);

  const anotherServer = new GlobalIdSystem();
  anotherServer.Configure({ originServerId: 8, workerId: 3 });
  const merged = anotherServer.Next();
  assert.notEqual(first, merged);
  assert.equal(GlobalIdSystem.OriginServerId(merged), 8);
  assert.throws(
    () => anotherServer.Configure({ originServerId: 9, workerId: 3 }),
    /only be configured once/,
  );

  const instance = InstanceIdSystem.Instance.Next();
  const timer = InstanceIdSystem.Instance.NextTimerId();
  assert.equal(instance, 1);
  assert.equal(timer, 1);
  assert.equal(InstanceIdSystem.Instance.Next(), 2);
}

function testTimeSemantics(): void {
  const time = TimeSystem.Instance;
  const deadline = time.ServerDeadlineAfter(1_000);
  assert.equal(time.RemainingServerTime(deadline), 1_000);
  assert.equal(time.IsServerDeadlineReached(deadline), false);
  assert.equal(time.ServerNowSeconds, Math.floor(time.ServerNow / 1_000));
}

function testTimerArgumentsAndCancellation(): void {
  const host = new ProcessHost("foundation-timer");
  const scene = host.spawnScene("foundation", FoundationScene);
  const component = scene.AddComponent(TimerProbeComponent);
  const args: TimerArgs = { label: "cast" };
  const timerId = component.NewOnceTimer(
    1_000,
    "OnElapsed",
    args,
    { onCancelled: "OnCancelled" },
  );
  assert.equal(component.CancelTimer(timerId, "player-moved"), true);
  assert.equal(component.CancelTimer(timerId, "again"), false);
  assert.equal(component.elapsedArgs, undefined);
  assert.equal(component.cancelledArgs, args);
  assert.equal(component.cancelledContext?.reason, "player-moved");

  const elapsed = component.NewOnceTimer(10, "OnElapsed", args);
  TimerSystem.Instance.__update(TimeSystem.Instance.FrameTime + 10);
  assert.notEqual(elapsed, 0 as TimerId);
  assert.equal(component.elapsedArgs, args);

  const silent = component.NewOnceTimer(1_000, "OnElapsed", args, {
    onCancelled: "OnCancelled",
  });
  assert.equal(scene.RemoveComponent(TimerProbeComponent), true);
  assert.notEqual(silent, 0 as TimerId);
  host.Dispose();
}

async function testCoroutineLockIsolation(): Promise<void> {
  const host = new ProcessHost("foundation-lock");
  const scene = host.spawnScene("foundation", FoundationScene);
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => releaseFirst = resolve);

  const first = scene.Locks.RunExclusive("Guild", "少林", async () => {
    order.push("first-start");
    await firstGate;
    order.push("first-end");
  });
  assert.deepEqual(order, ["first-start"]);
  const second = scene.Locks.RunExclusive("Guild", "少林", () => {
    order.push("second");
  });
  const otherGuild = scene.Locks.RunExclusive("Guild", "武当", () => {
    order.push("other");
  });
  await Promise.resolve();
  assert.deepEqual(order, ["first-start", "other"]);
  releaseFirst();
  await Promise.all([first, second, otherGuild]);
  assert.deepEqual(order, ["first-start", "other", "first-end", "second"]);

  await assert.rejects(
    scene.Locks.RunExclusive("Guild", "异常释放", () => {
      throw new Error("expected lock failure");
    }),
    /expected lock failure/,
  );
  await scene.Locks.RunExclusive("Guild", "异常释放", () => order.push("released"));
  assert.equal(order.at(-1), "released");
  const staleLocks = scene.Locks;
  host.Dispose();
  await assert.rejects(
    staleLocks.RunExclusive("Guild", "少林", () => undefined),
    /disposed Scene/,
  );
}

async function testSceneEventsAndTasks(): Promise<void> {
  const host = new ProcessHost("foundation-event");
  const first = host.spawnScene("first", FoundationScene);
  const second = host.spawnScene("second", FoundationScene);
  const sync = first.Events.Publish(FoundationEvents.Sync, { value: 2 });
  assert.deepEqual(sync, { handlerCount: 1, failedCount: 0 });
  assert.equal(first.syncTotal, 2);
  assert.equal(second.syncTotal, 0);

  assert.equal(first.Events.Check(FoundationEvents.Veto, { blocked: false }), 0);
  assert.deepEqual(first.vetoChecks, ["first", "second"]);
  first.vetoChecks.length = 0;
  assert.equal(first.Events.Check(FoundationEvents.Veto, { blocked: true }), 7001);
  assert.deepEqual(first.vetoChecks, ["first"]);

  let releaseTask!: () => void;
  const taskGate = new Promise<void>((resolve) => releaseTask = resolve);
  let taskSignal: { readonly aborted: boolean } | undefined;
  const taskId = first.Tasks.Spawn("foundation-task", async ({ signal }) => {
    taskSignal = signal;
    await taskGate;
  });
  assert.ok(taskId > 0);
  assert.equal(first.Tasks.InFlightCount, 1);
  assert.equal(host.SceneTaskInFlightCount, 1);
  await Promise.resolve();
  assert.equal(taskSignal?.aborted, false);
  releaseTask();
  await taskGate;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(first.Tasks.InFlightCount, 0);
  assert.equal(host.SceneTaskInFlightCount, 0);

  let releaseCapacityTasks!: () => void;
  const capacityGate = new Promise<void>((resolve) => releaseCapacityTasks = resolve);
  for (let index = 0; index < 256; index += 1) {
    first.Tasks.Spawn(`capacity-${index}`, async () => capacityGate);
  }
  assert.throws(
    () => first.Tasks.Spawn("capacity-overflow", () => undefined),
    /scene task capacity exceeded/,
  );
  releaseCapacityTasks();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(first.Tasks.InFlightCount, 0);

  let disposedSignal: { readonly aborted: boolean } | undefined;
  first.Tasks.Spawn("dispose-task", async ({ signal }) => {
    disposedSignal = signal;
    await new Promise<void>(() => undefined);
  });
  await Promise.resolve();
  const staleEvents = first.Events;
  host.Dispose();
  assert.equal(disposedSignal?.aborted, true);
  assert.throws(
    () => staleEvents.Publish(FoundationEvents.Sync, { value: 1 }),
    /disposed Scene/,
  );
}

function testSceneDisposeCascadesOwnedEntities(): void {
  const host = new ProcessHost("foundation-dispose");
  const scene = host.spawnScene("dispose", FoundationScene);
  const component = scene.AddComponent(CascadingChildrenComponent);
  const child = component.child;
  const childInstanceId = child.InstanceId;

  host.despawnScene("dispose");
  assert.equal(scene.IsDisposed, true);
  assert.equal(child.IsDisposed, true);
  assert.equal(host.Root.Get(childInstanceId), undefined);
  assert.throws(() => child.AssertAlive(), /entity is disposed/);
}
