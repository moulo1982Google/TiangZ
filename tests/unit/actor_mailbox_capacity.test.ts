import { expect, test, vi } from "vitest";
import { ProcessRuntime } from "../../app/core/process/ProcessRuntime";
import { RpcError } from "../../app/core/protocol/RpcError";
import { SystemErrCode } from "../../app/core/protocol/SystemErrCode";
import { Scene } from "../../app/core/runtime/entities";
import { ProcessHost } from "../../app/core/runtime/host";
import { actor, scene } from "../../app/core/runtime/metadata";
import { ActorUnit } from "../../app/core/runtime/Unit";

@scene({ sceneType: "ActorCapacityScene" })
class Owner extends Scene {}
@actor({ mailbox: "ordered" })
class Ordered extends ActorUnit {}
@actor({ mailbox: "unordered" })
class Unordered extends ActorUnit {}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}
async function fixture() {
  const runtime = new ProcessRuntime({ process: { name: "actor-capacity" }, scenes: [], knownScenes: [], tickMs: 50 });
  await runtime.start();
  const host = Reflect.get(runtime, "processHost") as ProcessHost;
  return { runtime, host, owner: host.spawnScene("owner", Owner) };
}
function overload(run: () => unknown, message: RegExp) {
  let rejected: unknown;
  try { run(); } catch (error) { rejected = error; }
  expect(rejected).toBeInstanceOf(RpcError);
  expect((rejected as RpcError).code).toBe(SystemErrCode.SceneOverloaded);
  expect((rejected as Error).message).toMatch(message);
}
async function settled(host: ProcessHost) {
  for (let turn = 0; turn < 40 && host.ActorMailboxPendingCount > 0; turn++) await Promise.resolve();
  expect(host.ActorMailboxPendingCount).toBe(0);
}

test("ordered RPC and void calls share a per-Actor limit and rejected calls never join the FIFO", async () => {
  const { runtime, host, owner } = await fixture(), gate = deferred();
  const target = owner.SpawnActor(1, Ordered), other = owner.SpawnActor(2, Ordered);
  const seen: number[] = [], rejected = vi.fn();
  const first = Promise.resolve(host.runActorMailbox(target.InstanceId, () => gate.promise));
  const queued: Promise<unknown>[] = [];
  try {
    for (let i = 1; i < 4096; i++) {
      const run = () => { seen.push(i); };
      if (i % 2) host.runActorMailboxVoid(target.InstanceId, run);
      else queued.push(Promise.resolve(host.runActorMailbox(target.InstanceId, run)));
    }
    expect(host.ActorMailboxPendingCount).toBe(4096);
    overload(() => host.runActorMailbox(target.InstanceId, rejected), /actor mailbox capacity exceeded/);
    overload(() => host.runActorMailboxVoid(target.InstanceId, rejected), /actor mailbox capacity exceeded/);
    expect(rejected).not.toHaveBeenCalled();
    expect(host.MailboxMetrics().queuedDepth).toBe(4095);
    expect(host.runActorMailbox(other.InstanceId, () => 7)).toBe(7);
    expect(runtime.CanCommitHotfix).toBe(false);
    gate.resolve(); await first; await Promise.all(queued); await settled(host);
    expect(seen).toEqual(Array.from({ length: 4095 }, (_, i) => i + 1));
    expect(host.MailboxMetrics().queuedDepth).toBe(0);
    expect(runtime.CanCommitHotfix).toBe(true);
    const { game } = await runtime.update(false, true);
    expect(game).toMatchObject({ actorMailboxInFlight: 0, actorMailboxCapacity: 16384,
      actorMailboxPerActorCapacity: 4096, actorMailboxMaxInFlight: 4097,
      actorMailboxActorRejections: 2, actorMailboxProcessRejections: 0 });
  } finally { gate.resolve(); await first; await Promise.all(queued); await runtime.stop(); }
});

test.each([false, true])("unordered calls keep their slot until actual completion (void=%s)", async oneWay => {
  const { runtime, host, owner } = await fixture(), first = deferred(), rest = deferred();
  const target = owner.SpawnActor(1, Unordered), rejected = vi.fn();
  const invoke = (body: () => Promise<void> | void) => oneWay
    ? host.runActorMailboxVoid(target.InstanceId, body) : host.runActorMailbox(target.InstanceId, body);
  const pending = [Promise.resolve(invoke(() => first.promise))];
  try {
    for (let i = 1; i < 4096; i++) pending.push(Promise.resolve(invoke(() => rest.promise)));
    overload(() => invoke(rejected), /actor mailbox capacity exceeded/);
    first.resolve(); await pending[0];
    expect(host.ActorMailboxPendingCount).toBe(4095);
    pending.push(Promise.resolve(invoke(() => rest.promise)));
    expect(host.ActorMailboxPendingCount).toBe(4096);
    overload(() => invoke(rejected), /actor mailbox capacity exceeded/);
    expect(rejected).not.toHaveBeenCalled();
    rest.resolve(); await Promise.all(pending); await settled(host);
    expect(runtime.CanCommitHotfix).toBe(true);
  } finally { first.resolve(); rest.resolve(); await Promise.all(pending); await runtime.stop(); }
});

test("four full Actors exhaust the Process quota even after disposal; one actual completion frees exactly one slot", async () => {
  const { runtime, host, owner } = await fixture(), first = deferred(), rest = deferred();
  const actors = Array.from({ length: 4 }, (_, i) => owner.SpawnActor(i + 1, Unordered));
  const pending: Promise<unknown>[] = [], rejected = vi.fn();
  try {
    for (let a = 0; a < actors.length; a++) for (let i = 0; i < 4096; i++) {
      pending.push(Promise.resolve(host.runActorMailbox(actors[a].InstanceId,
        () => a === 0 && i === 0 ? first.promise : rest.promise)).catch(error => error));
    }
    const extra = owner.SpawnActor(5, Unordered);
    overload(() => host.runActorMailbox(extra.InstanceId, rejected), /process actor mailbox capacity exceeded/);
    for (let i = 1; i <= 4; i++) owner.DespawnActor(i);
    expect(host.ActorMailboxPendingCount).toBe(16384);
    overload(() => host.runActorMailboxVoid(extra.InstanceId, rejected), /process actor mailbox capacity exceeded/);
    expect((await runtime.update(false, true)).pendingAsync).toBe(true);
    expect(rejected).not.toHaveBeenCalled();
    first.resolve(); await pending[0];
    expect(host.ActorMailboxPendingCount).toBe(16383);
    pending.push(Promise.resolve(host.runActorMailbox(extra.InstanceId, () => rest.promise)));
    overload(() => host.runActorMailboxVoid(extra.InstanceId, rejected), /process actor mailbox capacity exceeded/);
    expect((await runtime.update(false, true)).game).toMatchObject({ actorMailboxInFlight: 16384,
      actorMailboxMaxInFlight: 16384, actorMailboxActorRejections: 0, actorMailboxProcessRejections: 3 });
    rest.resolve(); await Promise.all(pending); await settled(host);
    expect(host.runActorMailbox(extra.InstanceId, () => 42)).toBe(42);
    expect(runtime.CanCommitHotfix).toBe(true);
  } finally { first.resolve(); rest.resolve(); await Promise.all(pending); await runtime.stop(); }
});

test("ordered disposal releases only unexecuted work and a reused Actor ID has its own allowance", async () => {
  const { runtime, host, owner } = await fixture(), old = deferred(), current = deferred();
  const target = owner.SpawnActor(1, Ordered), unexecuted = vi.fn();
  const running = Promise.resolve(host.runActorMailbox(target.InstanceId, () => old.promise)).catch(error => error);
  for (let i = 1; i < 4096; i++) host.runActorMailboxVoid(target.InstanceId, unexecuted);
  const pending: Promise<unknown>[] = [];
  try {
    owner.DespawnActor(1);
    expect(host.ActorMailboxPendingCount).toBe(1);
    expect(unexecuted).not.toHaveBeenCalled();
    const replacement = owner.SpawnActor(1, Unordered);
    for (let i = 0; i < 4096; i++) pending.push(Promise.resolve(host.runActorMailbox(replacement.InstanceId, () => current.promise)));
    old.resolve(); await running;
    expect(host.ActorMailboxPendingCount).toBe(4096);
    overload(() => host.runActorMailbox(replacement.InstanceId, unexecuted), /actor mailbox capacity exceeded/);
    expect(unexecuted).not.toHaveBeenCalled();
    current.resolve(); await Promise.all(pending); await settled(host);
  } finally { old.resolve(); current.resolve(); await running; await Promise.all(pending); await runtime.stop(); }
});

test("completion from a stopped Runtime releases only its original ProcessHost", async () => {
  const previous = await fixture(), old = deferred(), current = deferred();
  const target = previous.owner.SpawnActor(1, Unordered);
  const running = Promise.resolve(previous.host.runActorMailbox(target.InstanceId, () => old.promise)).catch(error => error);
  await previous.runtime.stop();
  const { runtime, host, owner } = await fixture();
  const replacement = owner.SpawnActor(1, Unordered);
  const pending = Promise.resolve(host.runActorMailbox(replacement.InstanceId, () => current.promise));
  try {
    old.resolve(); await running; await settled(previous.host);
    expect(host.ActorMailboxPendingCount).toBe(1);
    expect(runtime.CanCommitHotfix).toBe(false);
    current.resolve(); await pending; await settled(host);
    expect(runtime.CanCommitHotfix).toBe(true);
  } finally { old.resolve(); current.resolve(); await running; await pending; await runtime.stop(); }
});
