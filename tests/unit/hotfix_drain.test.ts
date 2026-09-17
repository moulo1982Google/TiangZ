import { expect, test } from "vitest";
import { ProcessRuntime } from "../../app/core/process/ProcessRuntime";
import { TimerSystem } from "../../app/core/runtime/TimerSystem";
import { UpdateSystem } from "../../app/core/runtime/UpdateSystem";
import { TimeSystem } from "../../app/core/runtime/TimeSystem";
import { EntryScene } from "../../app/core/process/types";
import { entryScene } from "../../app/core/process/registry";

let active: DrainFixture;
@entryScene("DrainFixture")
class DrainFixture extends EntryScene {
  protected override onStart(): void { active = this; }
}

test("already admitted result waits complete during pause without bypassing the safe point", async () => {
  const scene = { name: "drain", sceneType: "DrainFixture", ip: "127.0.0.1", innerIp: "127.0.0.1", port: 12345 };
  const runtime = new ProcessRuntime({ process: { name: "drain-result" }, scenes: [scene], knownScenes: [scene], tickMs: 50 });
  await runtime.start();
  try {
    let complete!: () => void;
    const result = new Promise<void>(resolve => { complete = resolve; });
    active.Tasks.Spawn("result-in-flight", () => result);
    expect((await runtime.update(false, true)).pendingAsync).toBe(true);
    expect(runtime.CanCommitHotfix).toBe(false);
    complete();
    for (let i = 0; i < 10; i++) await runtime.update(false, true);
    expect(runtime.CanCommitHotfix).toBe(true);
    expect((await runtime.update(false, true)).pendingAsync).toBe(false);
  } finally { await runtime.stop(); }
});

test("hotfix drain keeps time and async completions alive without firing timers or fixed updates", async () => {
  const runtime = new ProcessRuntime({ process: { name: "hotfix-drain", game: { fixedUpdateMs: 1 } }, scenes: [], knownScenes: [], tickMs: 1 });
  await runtime.start();
  try {
    let timers = 0;
    let updates = 0;
    TimerSystem.Instance.NewOnceTimer(1, () => { timers++; });
    UpdateSystem.Instance.Add({ Update: () => { updates++; } });
    const before = TimeSystem.Instance.ServerNow;
    // Test fixture only: let the timer become due while no game Update runs.
    await new Promise(resolve => setTimeout(resolve, 10));
    const drained = await runtime.update(true, true);
    expect(TimeSystem.Instance.ServerNow).toBeGreaterThanOrEqual(before);
    expect(timers).toBe(0);
    expect(updates).toBe(0);
    expect(drained.pendingAsync).toBe(false);
    expect(runtime.CanCommitHotfix).toBe(true);
    await runtime.update(true, false);
    expect(timers).toBe(1);
    expect(updates).toBeGreaterThan(0);
    await runtime.update(true, false);
    expect(timers).toBe(1);
  } finally { await runtime.stop(); }
});
