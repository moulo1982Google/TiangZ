import assert from "node:assert/strict";
import {
  Actor,
  Component,
  Game,
  InitializeGameSingletons,
  ProcessHost,
  Scene,
  SingletonRegistry,
  TimeSystem,
  TimerSystem,
  UpdateSystem,
  actor,
  scene,
  type IUpdate,
} from "../app/core/runtime";

@scene({ sceneType: "GameUpdateTest" })
class TestScene extends Scene {}

@actor({ mailbox: "ordered" })
class TestActor extends Actor {}

class CounterComponent extends Component implements IUpdate {
  updates = 0;
  destroyed = false;

  Update(): void {
    this.updates += 1;
  }

  protected override OnDestroy(): void {
    this.destroyed = true;
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
  assert.equal(TimeSystem.Instance.FixedDeltaTime, 50);

  Game.Instance.Update(base + 250, Date.now(), () => undefined);
  assert.equal(counter.updates, 3, "a delayed pump must honor maxCatchUpSteps");
  assert.equal(Game.Instance.SkippedFixedUpdates, 2);

  let onceCount = 0;
  let repeatedCount = 0;
  counter.NewOnceTimer(25, () => { onceCount += 1; });
  const repeatedTimer = counter.NewRepeatedTimer(20, () => { repeatedCount += 1; });
  Game.Instance.Update(base + 275, Date.now(), () => undefined);
  assert.equal(onceCount, 1);
  assert.equal(repeatedCount, 1);
  assert.equal(counter.RemoveTimer(repeatedTimer), true);

  assert.equal(sceneInstance.RemoveComponent(CounterComponent), true);
  assert.equal(counter.destroyed, true);
  assert.equal(UpdateSystem.Instance.Count, 0);
  Game.Instance.Update(base + 350, Date.now(), () => undefined);
  assert.equal(counter.updates, 3);
  assert.equal(repeatedCount, 1);

  const actorInstance = sceneInstance.SpawnActor("player-1", TestActor);
  let releaseMailbox!: () => void;
  const blocker = new Promise<void>((resolve) => { releaseMailbox = resolve; });
  const running = host.runActorMailbox(actorInstance.InstanceId, () => blocker);
  let actorTimerCount = 0;
  actorInstance.NewOnceTimer(10, () => { actorTimerCount += 1; });

  Game.Instance.Update(base + 360, Date.now(), () => undefined);
  assert.equal(actorTimerCount, 0, "ordered actor timer must wait behind its mailbox");
  releaseMailbox();
  await running;
  await Promise.resolve();
  assert.equal(actorTimerCount, 1);

  actorInstance.NewRepeatedTimer(10, () => { actorTimerCount += 1; });
  assert.equal(sceneInstance.DespawnActor("player-1"), true);
  Game.Instance.Update(base + 400, Date.now(), () => undefined);
  assert.equal(actorTimerCount, 1, "despawn must cancel actor-owned timers");
  assert.equal(TimerSystem.Instance.Count, 0);

  SingletonRegistry.DestroyAll();
  console.log("game update self-test passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
