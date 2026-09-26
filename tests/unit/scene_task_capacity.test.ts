import { expect, test, vi } from "vitest";
import { ProcessRuntime } from "../../app/core/process/ProcessRuntime";
import { RpcError } from "../../app/core/protocol/RpcError";
import { SystemErrCode } from "../../app/core/protocol/SystemErrCode";
import { Scene } from "../../app/core/runtime/entities";
import { ProcessHost } from "../../app/core/runtime/host";
import { scene } from "../../app/core/runtime/metadata";
import { TimerSystem } from "../../app/core/runtime/TimerSystem";

@scene({ sceneType: "SpawnCapacityFixture" })
class TaskScene extends Scene {}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}
async function createRuntime() {
  const runtime = new ProcessRuntime({ process: { name: "spawn-capacity" }, scenes: [], knownScenes: [], tickMs: 50 });
  await runtime.start();
  return { runtime, host: Reflect.get(runtime, "processHost") as ProcessHost };
}
async function settled(host: ProcessHost) {
  for (let step = 0; step < 40 && host.SceneTaskInFlightCount > 0; step++) await Promise.resolve();
  expect(host.SceneTaskInFlightCount).toBe(0);
}
function expectOverload(run: () => unknown, message: RegExp) {
  let rejected: unknown;
  try { run(); } catch (error) { rejected = error; }
  expect(rejected).toBeInstanceOf(RpcError);
  expect((rejected as RpcError).code).toBe(SystemErrCode.SceneOverloaded);
  expect((rejected as Error).message).toMatch(message);
}

test("17 individually valid Scopes cannot bypass the Process Spawn limit; actual completion restores admission", async () => {
  const { runtime, host } = await createRuntime();
  const held = deferred();
  const owners = Array.from({ length: 16 }, (_, i) => host.spawnScene(`owner-${i}`, TaskScene));
  const extra = host.spawnScene("extra", TaskScene);
  const body = vi.fn();
  try {
    for (const owner of owners) for (let i = 0; i < 256; i++) owner.Tasks.Spawn("held", () => held.promise);
    expect(host.SceneTaskInFlightCount).toBe(4096);
    expectOverload(() => extra.Tasks.Spawn("must-not-run", body), /process scene task capacity exceeded/);
    await Promise.resolve();
    expect(body).not.toHaveBeenCalled();
    expect(extra.Tasks.InFlightCount).toBe(0);
    expect(extra.Tasks.MaxInFlightCount).toBe(0);
    expect(runtime.CanCommitHotfix).toBe(false);
    held.resolve(); await settled(host);
    extra.Tasks.Spawn("retry", body); await settled(host);
    expect(body).toHaveBeenCalledTimes(1);
    expect(runtime.CanCommitHotfix).toBe(true);
  } finally { held.resolve(); await settled(host); await runtime.stop(); }
});

test("the existing per-Scope capacity is an explicit overload and does not consume other Scopes' allowance", async () => {
  const { runtime, host } = await createRuntime();
  const held = deferred();
  const owner = host.spawnScene("full", TaskScene), other = host.spawnScene("other", TaskScene);
  const body = vi.fn();
  try {
    for (let i = 0; i < 256; i++) owner.Tasks.Spawn("held", () => held.promise);
    expectOverload(() => owner.Tasks.Spawn("not-admitted", body), /scene task capacity exceeded/);
    expect(host.SceneTaskInFlightCount).toBe(256);
    other.Tasks.Spawn("independent", body);
    held.resolve(); await settled(host);
    expect(body).toHaveBeenCalledTimes(1);
    expect(owner.Tasks.MaxInFlightCount).toBe(256);
  } finally { held.resolve(); await settled(host); await runtime.stop(); }
});

test("cancelled tasks and disposed Scopes hold the Process quota until actual completion, including same-ID replacement", async () => {
  const { runtime, host } = await createRuntime();
  const held = deferred(), first = deferred();
  const owners = Array.from({ length: 16 }, (_, i) => host.spawnScene(`owner-${i}`, TaskScene));
  let firstId: ReturnType<TaskScene["Tasks"]["Spawn"]> | undefined;
  try {
    for (let owner = 0; owner < owners.length; owner++) for (let i = 0; i < 256; i++) {
      const id = owners[owner].Tasks.Spawn("held", () => owner === 0 && i === 0 ? first.promise : held.promise);
      if (owner === 0 && i === 0) firstId = id;
    }
    await Promise.resolve();
    expect(owners[0].Tasks.Cancel(firstId!)).toBe(true);
    for (let i = 0; i < owners.length; i++) host.despawnScene(`owner-${i}`);
    const replacement = host.spawnScene("owner-0", TaskScene);
    expect(host.SceneTaskInFlightCount).toBe(4096);
    expect(TimerSystem.Instance.Count).toBe(0);
    expectOverload(() => replacement.Tasks.Spawn("too-early", () => {}), /process scene task capacity/);
    expect((await runtime.update(false, true)).pendingAsync).toBe(true);
    first.resolve();
    for (let step = 0; step < 40 && host.SceneTaskInFlightCount === 4096; step++) await Promise.resolve();
    expect(host.SceneTaskInFlightCount).toBe(4095);
    replacement.Tasks.Spawn("recovered-one-slot", () => held.promise);
    expect(host.SceneTaskInFlightCount).toBe(4096);
    expectOverload(() => replacement.Tasks.Spawn("still-full", () => {}), /process scene task capacity/);
    held.resolve(); await settled(host);
    expect(Reflect.get(host, "retiredTaskScopes").size).toBe(0);
    expect(runtime.CanCommitHotfix).toBe(true);
  } finally { first.resolve(); held.resolve(); await settled(host); await runtime.stop(); }
});

test("watchdog failure at the last Process slot rolls back quota and does not increase the successful high-water mark", async () => {
  const { runtime, host } = await createRuntime();
  const held = deferred();
  const owners = Array.from({ length: 16 }, (_, i) => host.spawnScene(`owner-${i}`, TaskScene));
  const extra = host.spawnScene("retry-owner", TaskScene);
  const failure = new Error("watchdog must not consume the last slot");
  let register: ReturnType<typeof vi.spyOn> | undefined;
  try {
    for (let owner = 0; owner < owners.length; owner++) for (let i = 0; i < (owner === 15 ? 255 : 256); i++) {
      owners[owner].Tasks.Spawn("held", () => held.promise);
    }
    register = vi.spyOn(TimerSystem.Instance, "NewOnceTimer").mockImplementationOnce(() => { throw failure; });
    expect(() => extra.Tasks.Spawn("failed", () => {})).toThrow(failure);
    register.mockRestore();
    expect(host.SceneTaskMetrics()).toMatchObject({ sceneTaskInFlight: 4095, sceneTaskMaxInFlight: 4095, sceneTaskRejections: 0 });
    extra.Tasks.Spawn("last-slot", () => held.promise);
    expect(host.SceneTaskMetrics()).toMatchObject({ sceneTaskInFlight: 4096, sceneTaskMaxInFlight: 4096, sceneTaskRejections: 0 });
    expectOverload(() => extra.Tasks.Spawn("excess", () => {}), /process scene task capacity/);
    const update = await runtime.update(true, true);
    expect(update.game).toMatchObject({ sceneTaskInFlight: 4096, sceneTaskCapacity: 4096, sceneTaskMaxInFlight: 4096, sceneTaskRejections: 1 });
    held.resolve(); await settled(host);
    expect(host.SceneTaskMetrics()).toMatchObject({ sceneTaskInFlight: 0, sceneTaskMaxInFlight: 4096, sceneTaskRejections: 1 });
  } finally { register?.mockRestore(); held.resolve(); await settled(host); await runtime.stop(); }
});

test("late completion after Runtime restart cannot release a new Host's task allowance", async () => {
  const { runtime: oldRuntime, host: oldHost } = await createRuntime();
  const old = oldHost.spawnScene("same-id", TaskScene), oldResult = deferred();
  old.Tasks.Spawn("old", () => oldResult.promise);
  await Promise.resolve();
  await oldRuntime.stop();
  const { runtime, host } = await createRuntime();
  const owner = host.spawnScene("same-id", TaskScene), result = deferred();
  try {
    owner.Tasks.Spawn("new", () => result.promise);
    await Promise.resolve();
    oldResult.resolve(); await settled(oldHost);
    expect(host.SceneTaskInFlightCount).toBe(1);
    expect(runtime.CanCommitHotfix).toBe(false);
    result.resolve(); await settled(host);
    expect(runtime.CanCommitHotfix).toBe(true);
  } finally { oldResult.resolve(); result.resolve(); await settled(oldHost); await settled(host); await runtime.stop(); }
});
