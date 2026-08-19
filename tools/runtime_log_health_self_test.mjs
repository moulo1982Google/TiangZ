import assert from "node:assert/strict";
import { InspectRuntimeLog } from "../perf/lib/runtime_log_health.mjs";

assert.deepEqual(InspectRuntimeLog("INFO ready\nWARN socket closed"), {
  errors: 0,
  panics: 0,
  samples: [],
});

const inspected = InspectRuntimeLog(
  "\u001b[31mERROR\u001b[0m map state replication failed\n" +
  "thread 'main' panicked at src/main.rs:1\n",
);
assert.equal(inspected.errors, 1);
assert.equal(inspected.panics, 1);
assert.equal(inspected.samples.length, 2);

console.log("Runtime log health self-test passed");
