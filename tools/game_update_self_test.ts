import assert from "node:assert/strict";
import { Actor, Component, Scene } from "../app/core/runtime/entities";
import { Game, InitializeGameSingletons } from "../app/core/runtime/Game";
import { ProcessHost } from "../app/core/runtime/host";
import { actor, scene } from "../app/core/runtime/metadata";
import { SingletonRegistry } from "../app/core/runtime/Singleton";
import { TimeSystem } from "../app/core/runtime/TimeSystem";
import {
  TimerSystem,
  type TimerCancelledContext,
} from "../app/core/runtime/TimerSystem";
import {
  UpdateSystem,
  type IFrameFlush,
  type ILateUpdate,
  type IUpdate,
  type IUpdate10Hz,
  type IUpdate5Hz,
  type IUpdate1Hz,
} from "../app/core/runtime/UpdateSystem";

@scene({ sceneType: "GameUpdateTest" })
class TestScene extends Scene {}

@actor({ mailbox: "ordered" })
class TestActor extends Actor {
  timerCount = 0;
  cancelled: { args: { skillId: number }; context: TimerCancelledContext } | undefined;

  CountTimer(): void {
    this.timerCount += 1;
  }

  CancelCast(args: { skillId: number }, context: TimerCancelledContext): void {
    this.cancelled = { args, context };
  }
}

class CounterComponent extends Component implements IUpdate, IUpdate10Hz, IUpdate5Hz, IUpdate1Hz, ILateUpdate, IFrameFlush {
  updates = 0;
  updates10Hz = 0;
  updates5Hz = 0;
  updates1Hz = 0;
  onceCount = 0;
  repeatedCount = 0;
  readonly phases: string[] = [];
  destroyed = false;

  Update(): void {
    this.updates += 1;
    this.phases.push("update");
  }

  Update10Hz(): void {
    this.updates10Hz += 1;
  }

  Update5Hz(): void {
    this.updates5Hz += 1;
  }

  Update1Hz(): void {
    this.updates1Hz += 1;
  }

  LateUpdate(): void {
    this.phases.push("late");
  }

  FrameFlush(): void {
    this.phases.push("flush");
  }

  protected override OnDestroy(): void {
    this.destroyed = true;
  }

  OnceTimer(): void {
    this.onceCount += 1;
  }

  RepeatedTimer(): void {
    this.repeatedCount += 1;
  }
}

async function main(): Promise<void> {
  SingletonRegistry.DestroyAll();
  InitializeGameSingletons({ fixedUpdateMs: 50, maxCatchUpSteps: 2 });

  const host = new ProcessHost("game-update-test");
  const sceneInstance = host.spawnScene("main", TestScene);
  const counter = sceneInstance.AddComponent(CounterComponent);
  const base = TimeSystem.Instance.FrameTime;

  Game.Instance.Update(base + 49, Date.now(), () => undefined);
  assert.equal(counter.updates, 0);
  assert.equal(counter.updates10Hz, 0);
  assert.equal(counter.updates5Hz, 0);
  assert.equal(counter.updates1Hz, 0);

  Game.Instance.Update(base + 50, Date.now(), () => undefined);
  assert.equal(counter.updates, 1);
  assert.deepEqual(counter.phases, ["update", "late", "flush"]);
  assert.equal(TimeSystem.Instance.FixedDeltaTime, 50);

  Game.Instance.Update(base + 250, Date.now(), () => undefined);
  assert.equal(counter.updates, 3, "a delayed pump must honor maxCatchUpSteps");
  assert.equal(counter.updates10Hz, 1, "10Hz must run on every second 20Hz frame");
  assert.equal(counter.updates5Hz, 0, "5Hz must run on every fourth 20Hz frame");
  assert.equal(Game.Instance.SkippedFixedUpdates, 2);

  counter.NewOnceTimer(25, "OnceTimer");
  const repeatedTimer = counter.NewRepeatedTimer(20, "RepeatedTimer");
  Game.Instance.Update(base + 275, Date.now(), () => undefined);
  assert.equal(counter.onceCount, 1);
  assert.equal(counter.repeatedCount, 1);
  assert.equal(counter.RemoveTimer(repeatedTimer), true);

  Game.Instance.Update(base + 325, Date.now(), () => undefined);
  assert.equal(counter.updates10Hz, 2);
  assert.equal(counter.updates5Hz, 1);
  assert.equal(counter.updates1Hz, 0);
  assert.equal(counter.updates, 4);

  assert.equal(sceneInstance.RemoveComponent(CounterComponent), true);
  assert.equal(counter.destroyed, true);
  assert.equal(UpdateSystem.Instance.Count, 0);
  Game.Instance.Update(base + 350, Date.now(), () => undefined);
  assert.equal(counter.updates, 4);
  assert.equal(counter.repeatedCount, 1);

  const actorInstance = sceneInstance.SpawnActor("player-1", TestActor);
  let releaseMailbox!: () => void;
  const blocker = new Promise<void>((resolve) => { releaseMailbox = resolve; });
  const running = host.runActorMailbox(actorInstance.InstanceId, () => blocker);
  actorInstance.NewOnceTimer(10, "CountTimer");

  Game.Instance.Update(base + 360, Date.now(), () => undefined);
  assert.equal(actorInstance.timerCount, 0, "ordered actor timer must wait behind its mailbox");
  releaseMailbox();
  await running;
  await Promise.resolve();
  assert.equal(actorInstance.timerCount, 1);

  let releaseCancellationMailbox!: () => void;
  const cancellationBlocker = new Promise<void>((resolve) => {
    releaseCancellationMailbox = resolve;
  });
  const cancellationRunning = host.runActorMailbox(
    actorInstance.InstanceId,
    () => cancellationBlocker,
  );
  const castArgs = { skillId: 1001 };
  const castTimer = actorInstance.NewOnceTimer(1_000, "CountTimer", castArgs, {
    onCancelled: "CancelCast",
  });
  assert.equal(actorInstance.CancelTimer(castTimer, "player-moved"), true);
  assert.equal(actorInstance.cancelled, undefined, "actor cancellation must obey mailbox order");
  releaseCancellationMailbox();
  await cancellationRunning;
  await Promise.resolve();
  assert.equal(actorInstance.cancelled?.args, castArgs);
  assert.equal(actorInstance.cancelled?.context.reason, "player-moved");

  actorInstance.NewRepeatedTimer(10, "CountTimer");
  assert.equal(sceneInstance.DespawnActor("player-1"), true);
  Game.Instance.Update(base + 400, Date.now(), () => undefined);
  assert.equal(actorInstance.timerCount, 1, "despawn must cancel actor-owned timers");
  assert.equal(TimerSystem.Instance.Count, 0);

  SingletonRegistry.DestroyAll();
  console.log("game update self-test passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
