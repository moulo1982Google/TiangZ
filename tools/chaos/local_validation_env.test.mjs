import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCachePersistence } from "./local_validation_env.mjs";

test("cache recovery guard requires AOF off, RDB off and an ephemeral data directory", () => {
  const config = { appendonly: "no", save: "", dir: "/data" };
  const mounts = [{ Destination: "/data", Type: "tmpfs" }];
  assert.doesNotThrow(() => assertCachePersistence(config, mounts));
  for (const change of [{ appendonly: "yes" }, { save: "3600 1 300 100 60 10000" }, { save: undefined }, { dir: "/other" }]) {
    assert.throws(() => assertCachePersistence({ ...config, ...change }, mounts));
  }
  assert.throws(() => assertCachePersistence(config, [{ Destination: "/data", Type: "volume" }]));
});
