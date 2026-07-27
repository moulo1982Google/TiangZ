import assert from "node:assert/strict";
import { Actor, Component, Scene } from "../app/core/runtime/entities";
import { Game, InitializeGameSingletons } from "../app/core/runtime/Game";
import { ProcessHost } from "../app/core/runtime/host";
import { actor, scene } from "../app/core/runtime/metadata";
import { SingletonRegistry } from "../app/core/runtime/Singleton";
import { TimeSystem } from "../app/core/runtime/TimeSystem";
import { TimerSystem } from "../app/core/runtime/TimerSystem";
import {
  UpdateSystem,
  type IFrameFlush,
  type ILateUpdate,
  type IUpdate,
} from "../app/core/runtime/UpdateSystem";

@scene({ sceneType: "GameUpdateTest" })
class TestScene extends Scene {}

@actor({ mailbox: "ordered" })
class TestActor extends Actor {
  timerCount = 0;

  CountTimer(): void {
    this.timerCount += 1;
  }
}

class CounterComponent extends Component implements IUpdate, ILateUpdate, IFrameFlush {
  updates = 0;
  onceCount = 0;
  repeatedCount = 0;
  readonly phases: string[] = [];
  destroyed = false;

  Update(): void {
    this.updates += 1;
    this.phases.push("update");
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

  Game.Instance.Update(base + 50, Date.now(), () => undefined);
  assert.equal(counter.updates, 1);
  assert.deepEqual(counter.phases, ["update", "late", "flush"]);
  assert.equal(TimeSystem.Instance.FixedDeltaTime, 50);

  Game.Instance.Update(base + 250, Date.now(), () => undefined);
  assert.equal(counter.updates, 3, "a delayed pump must honor maxCatchUpSteps");
  assert.equal(Game.Instance.SkippedFixedUpdates, 2);

  counter.NewOnceTimer(25, "OnceTimer");
  const repeatedTimer = counter.NewRepeatedTimer(20, "RepeatedTimer");
  Game.Instance.Update(base + 275, Date.now(), () => undefined);
  assert.equal(counter.onceCount, 1);
  assert.equal(counter.repeatedCount, 1);
  assert.equal(counter.RemoveTimer(repeatedTimer), true);

  assert.equal(sceneInstance.RemoveComponent(CounterComponent), true);
  assert.equal(counter.destroyed, true);
  assert.equal(UpdateSystem.Instance.Count, 0);
  Game.Instance.Update(base + 350, Date.now(), () => undefined);
  assert.equal(counter.updates, 3);
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
