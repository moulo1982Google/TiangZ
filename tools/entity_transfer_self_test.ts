import {
  CommitPreparedTransfer,
  TransferStagingRegistry,
} from "../app/core/public";

let sourceAlive = true;
let rolledBack = 0;
let candidateId = 0;
let commitFailed = false;
try {
  CommitPreparedTransfer({
    Capture: () => ({ value: 42 }),
    Prepare: (snapshot) => ({ id: ++candidateId, value: snapshot.value }),
    Commit: () => {
      throw new Error("injected commit failure");
    },
    Rollback: () => {
      rolledBack += 1;
    },
  });
} catch (error) {
  commitFailed = String(error).includes("injected commit failure");
}
assert(commitFailed && sourceAlive && rolledBack === 1, "pre-commit failure did not roll back candidate");

const committed = CommitPreparedTransfer({
  Capture: () => 7,
  Prepare: (value) => ({ value }),
  Commit: () => {
    sourceAlive = false;
  },
  Rollback: () => {
    throw new Error("successful transfer must not roll back");
  },
});
assert(committed.value === 7 && !sourceAlive, "successful prepared transfer did not commit");

let now = 1_000;
let prepares = 0;
let commits = 0;
let aborts = 0;
const staging = new TransferStagingRegistry<{ id: number }>(4, () => now);
const first = staging.Prepare(
  "transfer-1",
  "payload-a",
  () => ({ id: ++prepares }),
  () => { aborts += 1; },
);
const retried = staging.Prepare(
  "transfer-1",
  "payload-a",
  () => ({ id: ++prepares }),
  () => { aborts += 1; },
);
assert(first.target === retried.target && prepares === 1 && retried.reused, "Prepare is not idempotent");

let changedPayloadRejected = false;
try {
  staging.Prepare("transfer-1", "payload-b", () => ({ id: 9 }), () => undefined);
} catch (error) {
  changedPayloadRejected = String(error).includes("payload changed");
}
assert(changedPayloadRejected, "Prepare accepted a changed retry payload");

const firstCommit = staging.Commit("transfer-1", (target) => {
  commits += 1;
  return target.id * 10;
});
const retryCommit = staging.Commit("transfer-1", () => {
  commits += 1;
  return -1;
});
assert(
  firstCommit.newlyCommitted && !retryCommit.newlyCommitted &&
    firstCommit.result === retryCommit.result && commits === 1,
  "Commit is not idempotent",
);
assert(
  staging.Snapshot().committed === 1 && staging.Snapshot().prepared === 0,
  "staging snapshot did not expose the committed state",
);

staging.Prepare("transfer-2", "payload-c", () => ({ id: ++prepares }), () => { aborts += 1; });
assert(staging.Abort("transfer-2") && !staging.Abort("transfer-2") && aborts === 1, "Abort is not idempotent");

staging.Prepare("transfer-3", "payload-d", () => ({ id: ++prepares }), () => { aborts += 1; });
now += 31_000;
assert(staging.SweepExpired(30_000, 60_000) === 1 && aborts === 2, "expired Prepare was not rolled back");
now += 30_000;
assert(staging.SweepExpired(30_000, 60_000) === 2, "completed idempotency records were not reclaimed");

staging.Dispose();
console.log("entity transfer self-test passed");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
