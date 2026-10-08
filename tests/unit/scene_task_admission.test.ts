import { expect, test, vi } from "vitest";
import { ProcessRuntime } from "../../app/core/process/ProcessRuntime";
import { Scene } from "../../app/core/runtime/entities";
import { ProcessHost } from "../../app/core/runtime/host";
import { scene } from "../../app/core/runtime/metadata";
import { SingletonRegistry } from "../../app/core/runtime/Singleton";
import { TimerSystem } from "../../app/core/runtime/TimerSystem";
import { TimeSystem } from "../../app/core/runtime/TimeSystem";

@scene({ sceneType: "SpawnAdmissionFixture" })
class TaskScene extends Scene {}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}
async function createRuntime() {
  const runtime = new ProcessRuntime({ process: { name: "spawn-admission" }, scenes: [], knownScenes: [], tickMs: 50 });
  await runtime.start();
  return { runtime, host: Reflect.get(runtime, "processHost") as ProcessHost };
}
async function settled(owner: Scene) {
  for (let step = 0; step < 20 && owner.Tasks.InFlightCount > 0; step++) await Promise.resolve();
  expect(owner.Tasks.InFlightCount).toBe(0);
}

test.each(["missing-service", "registration-error"])("failed Spawn (%s) leaves no phantom task or hotfix barrier and can retry", async failure => {
  const { runtime, host } = await createRuntime();
  const owner = host.spawnScene("owner", TaskScene);
  const body = vi.fn();
  const originalError = new Error("watchdog registration failed");
  const register = failure === "registration-error"
    ? vi.spyOn(TimerSystem.Instance, "NewOnceTimer").mockImplementationOnce(() => { throw originalError; })
    : undefined;
  if (failure === "missing-service") SingletonRegistry.Remove(TimerSystem);
  const restore = () => {
    register?.mockRestore();
    if (!TimerSystem.TryGetInstance()) SingletonRegistry.Add(TimerSystem);
  };
  try {
    expect(() => owner.Tasks.Spawn("rejected", body)).toThrow(failure === "missing-service" ? /singleton not found/ : originalError);
    restore();
    await Promise.resolve();
    expect(body).not.toHaveBeenCalled();
    expect(owner.Tasks.InFlightCount).toBe(0);
    expect(owner.Tasks.MaxInFlightCount).toBe(0);
    expect(host.SceneTaskInFlightCount).toBe(0);
    expect(TimerSystem.Instance.Count).toBe(0);
    expect(runtime.CanCommitHotfix).toBe(true);
    expect((await runtime.update(false, true)).pendingAsync).toBe(false);
    owner.Tasks.Spawn("retry", body);
    await settled(owner);
    expect(body).toHaveBeenCalledTimes(1);
    expect(owner.Tasks.MaxInFlightCount).toBe(1);
    expect(TimerSystem.Instance.Count).toBe(0);
  } finally { restore(); await runtime.stop(); }
});

test("a rejected Spawn cannot release a different Scene's actual task or watchdog", async () => {
  const { runtime, host } = await createRuntime();
  const active = host.spawnScene("active", TaskScene), rejected = host.spawnScene("rejected", TaskScene);
  const started = deferred(), result = deferred();
  active.Tasks.Spawn("in-flight", async () => { started.resolve(); await result.promise; });
  await started.promise;
  const timers = TimerSystem.Instance;
  const register = vi.spyOn(timers, "NewOnceTimer").mockImplementationOnce(() => { throw new Error("injected registration failure"); });
  try {
    expect(() => rejected.Tasks.Spawn("not-admitted", () => {})).toThrow(/registration failure/);
    register.mockRestore();
    expect(rejected.Tasks.InFlightCount).toBe(0);
    expect(active.Tasks.InFlightCount).toBe(1);
    expect(host.SceneTaskInFlightCount).toBe(1);
    expect(timers.Count).toBe(1);
    expect(runtime.CanCommitHotfix).toBe(false);
    result.resolve(); await settled(active);
    expect(timers.Count).toBe(0);
    expect(host.SceneTaskInFlightCount).toBe(0);
    expect(runtime.CanCommitHotfix).toBe(true);
  } finally { register.mockRestore(); result.resolve(); await settled(active); await runtime.stop(); }
});

test("failed admission into an already warned Scope keeps its older in-flight task", async () => {
  const { runtime, host } = await createRuntime();
  const owner = host.spawnScene("same-scope", TaskScene);
  const started = deferred(), result = deferred();
  owner.Tasks.Spawn("older-task", async () => { started.resolve(); await result.promise; });
  await started.promise;
  const timers = TimerSystem.Instance;
  const warning = vi.spyOn(owner.logger, "warn").mockImplementation(() => {});
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_001);
  let register: ReturnType<typeof vi.spyOn> | undefined;
  try {
    timers.__update(TimeSystem.Instance.FrameTime + 10_001);
    now.mockRestore();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(timers.Count).toBe(0);
    register = vi.spyOn(timers, "NewOnceTimer").mockImplementationOnce(() => { throw new Error("next watchdog failed"); });
    expect(() => owner.Tasks.Spawn("rejected-new-task", () => {})).toThrow(/next watchdog failed/);
    register.mockRestore();
    expect(owner.Tasks.InFlightCount).toBe(1);
    expect(owner.Tasks.MaxInFlightCount).toBe(1);
    expect(host.SceneTaskInFlightCount).toBe(1);
    expect(runtime.CanCommitHotfix).toBe(false);
    result.resolve(); await settled(owner);
    expect(host.SceneTaskInFlightCount).toBe(0);
    expect(runtime.CanCommitHotfix).toBe(true);
  } finally { now.mockRestore(); register?.mockRestore(); warning.mockRestore(); result.resolve(); await settled(owner); await runtime.stop(); }
});
