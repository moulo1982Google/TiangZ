import { afterEach, expect, test, vi } from "vitest";
import { CoreLogger } from "../../app/core/logging/Logger";
import { ProcessRuntime } from "../../app/core/process/ProcessRuntime";
import { Actor, Component, Scene } from "../../app/core/runtime/entities";
import { ProcessHost } from "../../app/core/runtime/host";
import { TimerSystem } from "../../app/core/runtime/TimerSystem";
import { TimeSystem } from "../../app/core/runtime/TimeSystem";

class TimerScene extends Scene {}
class TimerActor extends Actor {
  result: Promise<void> = Promise.resolve();
  calls = 0;
  Run(): Promise<void> { this.calls++; return this.result; }
}
class TimerComponent extends Component {
  result: Promise<void> = Promise.resolve();
  calls = 0;
  Run(): Promise<void> { this.calls++; return this.result; }
}

afterEach(() => vi.restoreAllMocks());

for (const cancelled of [false, true]) {
  for (const rejected of [false, true]) {
    test.each(["actor", "actor-component", "scene-component"] as const)(
      `%s timer blocks hotfix until settlement (cancelled=${cancelled}, rejected=${rejected})`,
      async kind => {
        const runtime = new ProcessRuntime({ process: { name: "timer-drain" }, scenes: [], knownScenes: [], tickMs: 50 });
        await runtime.start();
        const host = (runtime as unknown as { processHost: ProcessHost }).processHost;
        const scene = host.spawnScene("dynamic", TimerScene, { sceneType: "TimerScene" });
        const actor = scene.SpawnActor("timer", TimerActor);
        const owner = kind === "actor" ? actor : (kind === "actor-component" ? actor : scene).AddComponent(TimerComponent);
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        owner.result = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
        const log = vi.spyOn(CoreLogger, "error").mockImplementation(() => undefined);
        try {
          const timer = owner.NewOnceTimer(cancelled ? 60_000 : 0, "Run", undefined, { onCancelled: "Run" });
          expect(runtime.CanCommitHotfix).toBe(true);
          if (cancelled) owner.CancelTimer(timer);
          else TimerSystem.Instance.__update(TimeSystem.Instance.FrameTime);
          expect(owner.calls).toBe(1);
          expect(runtime.CanCommitHotfix).toBe(false);
          expect((await runtime.update(false, true)).pendingAsync).toBe(true);
          if (rejected) reject(new Error("expected timer failure"));
          else resolve();
          for (let step = 0; step < 20; step++) await runtime.update(false, true);
          expect(runtime.CanCommitHotfix).toBe(true);
          expect((await runtime.update(false, true)).pendingAsync).toBe(false);
          expect(log).toHaveBeenCalledTimes(rejected ? 1 : 0);
        } finally {
          resolve();
          for (let step = 0; step < 20; step++) await Promise.resolve();
          await runtime.stop();
        }
      },
    );
  }
}

test("disposing an Actor cancels future timers but keeps an already running callback in the drain", async () => {
  const runtime = new ProcessRuntime({ process: { name: "timer-dispose-drain" }, scenes: [], knownScenes: [], tickMs: 50 });
  await runtime.start();
  const host = (runtime as unknown as { processHost: ProcessHost }).processHost;
  const scene = host.spawnScene("dynamic", TimerScene, { sceneType: "TimerScene" });
  const actor = scene.SpawnActor("timer", TimerActor);
  let resolve!: () => void;
  actor.result = new Promise<void>(yes => { resolve = yes; });
  vi.spyOn(CoreLogger, "error").mockImplementation(() => undefined);
  try {
    actor.NewOnceTimer(0, "Run");
    actor.NewOnceTimer(60_000, "Run");
    TimerSystem.Instance.__update(TimeSystem.Instance.FrameTime);
    scene.DespawnActor("timer");
    expect(TimerSystem.Instance.Count).toBe(0);
    expect(actor.calls).toBe(1);
    expect(runtime.CanCommitHotfix).toBe(false);
    resolve();
    for (let step = 0; step < 20; step++) await runtime.update(false, true);
    expect(runtime.CanCommitHotfix).toBe(true);
    expect(actor.calls).toBe(1);
  } finally {
    resolve();
    for (let step = 0; step < 20; step++) await Promise.resolve();
    await runtime.stop();
  }
});
