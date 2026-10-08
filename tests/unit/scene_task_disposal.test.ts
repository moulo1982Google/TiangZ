import { expect, test, vi } from "vitest";
import { ProcessRuntime } from "../../app/core/process/ProcessRuntime";
import { Scene } from "../../app/core/runtime/entities";
import { ProcessHost } from "../../app/core/runtime/host";
import { scene } from "../../app/core/runtime/metadata";
import { TimerSystem } from "../../app/core/runtime/TimerSystem";
import type { SceneTaskSignal } from "../../app/core/runtime/SceneTaskSystem";

@scene({ sceneType: "SpawnDisposalFixture" })
class TaskScene extends Scene {}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}
async function createRuntime() {
  const runtime = new ProcessRuntime({ process: { name: "spawn-disposal" }, scenes: [], knownScenes: [], tickMs: 50 });
  await runtime.start();
  return { runtime, host: Reflect.get(runtime, "processHost") as ProcessHost };
}
async function taskSettled(owner: Scene) {
  for (let step = 0; step < 20 && owner.Tasks.InFlightCount > 0; step++) await Promise.resolve();
  expect(owner.Tasks.InFlightCount).toBe(0);
}

test("a disposed dynamic Scene remains in Process drain accounting until its task actually finishes", async () => {
  const { runtime, host } = await createRuntime();
  const owner = host.spawnScene("dynamic", TaskScene);
  const started = deferred(), complete = deferred();
  const timers = TimerSystem.Instance;
  let signal!: SceneTaskSignal;
  owner.Tasks.Spawn("actual-result", async context => { signal = context.signal; started.resolve(); await complete.promise; });
  await started.promise;
  try {
    expect((await runtime.update(false, true)).pendingAsync).toBe(true);
    host.despawnScene("dynamic");
    expect(signal.aborted).toBe(true);
    expect(owner.Tasks.InFlightCount).toBe(1);
    expect(timers.Count).toBe(0);
    expect(host.SceneTaskInFlightCount).toBe(1);
    expect((await runtime.update(false, true)).pendingAsync).toBe(true);
    expect(runtime.CanCommitHotfix).toBe(false);
    complete.resolve(); await taskSettled(owner);
    expect(Reflect.get(host, "retiredTaskScopes").size).toBe(0);
    expect(host.SceneTaskInFlightCount).toBe(0);
    expect((await runtime.update(false, true)).pendingAsync).toBe(false);
    expect(runtime.CanCommitHotfix).toBe(true);
  } finally { complete.resolve(); await taskSettled(owner); await runtime.stop(); }
});

test("an old task completing after restart cannot cancel a timer in the new runtime", async () => {
  const { runtime: first, host } = await createRuntime();
  const owner = host.spawnScene("old", TaskScene);
  const started = deferred(), complete = deferred();
  owner.Tasks.Spawn("late-result", async () => { started.resolve(); await complete.promise; });
  await started.promise;
  await first.stop();
  const { runtime: second } = await createRuntime();
  const newTimers = TimerSystem.Instance;
  const newTimer = newTimers.NewOnceTimer(60_000, () => {});
  const cancel = vi.spyOn(newTimers, "Cancel");
  try {
    complete.resolve(); await taskSettled(owner);
    expect(cancel).not.toHaveBeenCalled();
    expect(newTimers.Cancel(newTimer)).toBe(true);
    expect(Reflect.get(host, "retiredTaskScopes").size).toBe(0);
  } finally { complete.resolve(); await taskSettled(owner); cancel.mockRestore(); await second.stop(); }
});

test("disposal before the task microtask starts prevents its body and releases retained ownership", async () => {
  const { runtime, host } = await createRuntime();
  const owner = host.spawnScene("unstarted", TaskScene);
  const body = vi.fn();
  try {
    owner.Tasks.Spawn("not-started", body);
    host.despawnScene("unstarted");
    expect(owner.Tasks.InFlightCount).toBe(1);
    expect(host.SceneTaskInFlightCount).toBe(1);
    expect(() => owner.Tasks.Spawn("too-late", body)).toThrow(/disposed/);
    await taskSettled(owner);
    expect(body).not.toHaveBeenCalled();
    expect(Reflect.get(host, "retiredTaskScopes").size).toBe(0);
    expect(host.SceneTaskInFlightCount).toBe(0);
  } finally { await runtime.stop(); }
});

test.each([false, true])("same-ID replacement and retired Scope settle independently (failure=%s)", async fail => {
  const { runtime, host } = await createRuntime();
  const old = host.spawnScene("reused", TaskScene);
  const oldStarted = deferred(), oldComplete = deferred(), newStarted = deferred(), newComplete = deferred();
  const failure = vi.spyOn(old.logger, "error").mockImplementation(() => {});
  let replacement: TaskScene | undefined;
  try {
    old.Tasks.Spawn("old", async () => {
      oldStarted.resolve(); await oldComplete.promise;
      if (fail) throw new Error("fixture failure after disposal");
    });
    await oldStarted.promise;
    host.despawnScene("reused");
    replacement = host.spawnScene("reused", TaskScene);
    replacement.Tasks.Spawn("new", async () => { newStarted.resolve(); await newComplete.promise; });
    await newStarted.promise;
    expect(host.SceneTaskInFlightCount).toBe(2);
    expect(host.sceneById("reused")).toBe(replacement);
    oldComplete.resolve(); await taskSettled(old);
    expect(failure).toHaveBeenCalledTimes(fail ? 1 : 0);
    expect(Reflect.get(host, "retiredTaskScopes").size).toBe(0);
    expect(host.SceneTaskInFlightCount).toBe(1);
    expect(runtime.CanCommitHotfix).toBe(false);
    newComplete.resolve(); await taskSettled(replacement);
    expect(host.SceneTaskInFlightCount).toBe(0);
    expect(runtime.CanCommitHotfix).toBe(true);
  } finally {
    oldComplete.resolve(); newComplete.resolve(); await taskSettled(old);
    if (replacement) await taskSettled(replacement);
    failure.mockRestore(); await runtime.stop();
  }
});

test("only the last real task completion releases a retired Scope", async () => {
  const { runtime, host } = await createRuntime();
  const owner = host.spawnScene("multiple", TaskScene);
  const firstStarted = deferred(), firstComplete = deferred(), secondStarted = deferred(), secondComplete = deferred();
  try {
    const first = owner.Tasks.Spawn("first", async () => { firstStarted.resolve(); await firstComplete.promise; });
    owner.Tasks.Spawn("second", async () => { secondStarted.resolve(); await secondComplete.promise; });
    await Promise.all([firstStarted.promise, secondStarted.promise]);
    expect(owner.Tasks.Cancel(first)).toBe(true);
    host.despawnScene("multiple");
    expect(host.SceneTaskInFlightCount).toBe(2);
    firstComplete.resolve();
    for (let step = 0; step < 20 && owner.Tasks.InFlightCount === 2; step++) await Promise.resolve();
    expect(owner.Tasks.InFlightCount).toBe(1);
    expect(host.SceneTaskInFlightCount).toBe(1);
    expect(Reflect.get(host, "retiredTaskScopes").size).toBe(1);
    secondComplete.resolve(); await taskSettled(owner);
    expect(Reflect.get(host, "retiredTaskScopes").size).toBe(0);
  } finally { firstComplete.resolve(); secondComplete.resolve(); await taskSettled(owner); await runtime.stop(); }
});
