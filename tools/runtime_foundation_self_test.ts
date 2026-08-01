import assert from "node:assert/strict";
import { ProcessHost } from "../app/core/runtime/host";
import {
  Component,
  Scene,
} from "../app/core/runtime/entities";
import { InitializeGameSingletons } from "../app/core/runtime/Game";
import {
  GlobalIdSystem,
  InstanceIdSystem,
  type TimerId,
} from "../app/core/runtime/IdSystem";
import { scene } from "../app/core/runtime/metadata";
import {
  asyncEventHandler,
  defineAsyncEvent,
  defineSyncEvent,
  syncEventHandler,
  type AsyncSceneEventHandler,
  type SyncSceneEventHandler,
} from "../app/core/runtime/SceneEventSystem";
import { SingletonRegistry } from "../app/core/runtime/Singleton";
import type { TimerCancelledContext } from "../app/core/runtime/TimerSystem";
import { TimeSystem } from "../app/core/runtime/TimeSystem";
import { TimerSystem } from "../app/core/runtime/TimerSystem";

interface FoundationSyncEvent { readonly value: number }
interface FoundationAsyncEvent { readonly value: number }
const FoundationEvents = {
  Sync: defineSyncEvent<FoundationSyncEvent>("Foundation.Sync"),
  Async: defineAsyncEvent<FoundationAsyncEvent>("Foundation.Async"),
} as const;

@scene({ sceneType: "Foundation" })
class FoundationScene extends Scene {
  syncTotal = 0;
  asyncTotal = 0;
}

@syncEventHandler(FoundationScene, FoundationEvents.Sync)
class FoundationSyncHandler implements SyncSceneEventHandler<FoundationScene, FoundationSyncEvent> {
  Handle(scene: FoundationScene, event: FoundationSyncEvent): void {
    scene.syncTotal += event.value;
  }
}

@asyncEventHandler(FoundationScene, FoundationEvents.Async)
class FoundationAsyncHandler implements AsyncSceneEventHandler<FoundationScene, FoundationAsyncEvent> {
  async Handle(scene: FoundationScene, event: FoundationAsyncEvent): Promise<void> {
    await Promise.resolve();
    scene.asyncTotal += event.value;
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

void main();

async function main(): Promise<void> {
  InitializeGameSingletons(
    { fixedUpdateMs: 50, maxCatchUpSteps: 2 },
    { originServerId: 7, workerId: 3 },
  );
  try {
    testGlobalAndInstanceIds();
    testTimeSemantics();
    testTimerArgumentsAndCancellation();
    await testCoroutineLockIsolation();
    await testSceneEvents();
    console.log("runtime foundation self-test passed");
  } finally {
    SingletonRegistry.DestroyAll();
  }
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

async function testSceneEvents(): Promise<void> {
  const host = new ProcessHost("foundation-event");
  const first = host.spawnScene("first", FoundationScene);
  const second = host.spawnScene("second", FoundationScene);
  const sync = first.Events.Publish(FoundationEvents.Sync, { value: 2 });
  assert.deepEqual(sync, { handlerCount: 1, failedCount: 0 });
  assert.equal(first.syncTotal, 2);
  assert.equal(second.syncTotal, 0);

  const asyncResult = await first.Events.PublishAsync(FoundationEvents.Async, { value: 3 });
  assert.deepEqual(asyncResult, { handlerCount: 1, failedCount: 0 });
  assert.equal(first.asyncTotal, 3);
  assert.equal(second.asyncTotal, 0);
  const staleEvents = first.Events;
  host.Dispose();
  assert.throws(
    () => staleEvents.Publish(FoundationEvents.Sync, { value: 1 }),
    /disposed Scene/,
  );
}
