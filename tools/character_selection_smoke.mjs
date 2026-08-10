import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  runInherited,
  startRuntime,
  stopRuntime,
  waitForPort,
  waitForReady,
  writeFailureLogs,
} from "./lib/process_test_harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = path.join(root, "dist", "client_sdk_smoke.cjs");

await runCase("all-in-one", ["configs/local/all-in-one.json"], true);
await runCase("split-process", [
  "configs/local/cluster/manager.json",
  "configs/local/cluster/login-1.json",
  "configs/local/cluster/login-2.json",
  "configs/local/cluster/gate-1.json",
  "configs/local/cluster/map-1.json",
  "configs/local/cluster/map-2.json",
  "configs/local/cluster/dungeon-1.json",
  "configs/local/cluster/location-1.json",
], false);
console.log("[character-selection] smoke passed");

async function runCase(name, configs, checkHealth) {
  console.log(`[character-selection] ${name}`);
  const runtimes = configs.map((config) => startRuntime(root, config, `${name}-${path.basename(config, ".json")}`));
  let succeeded = false;
  try {
    const ports = [7000, 7001, 7002, 7201, 7301, 7302, 7401, 7310];
    await Promise.all(ports.map((port) => waitForPort(port, runtimes[0])));
    if (checkHealth) await waitForReady(7600);
    await runInherited(process.execPath, [client, "websocket", "127.0.0.1", "7000", "1"], root);
    succeeded = true;
  } finally {
    await Promise.all(runtimes.map((runtime) => stopRuntime(runtime)));
    if (!succeeded) {
      const directory = writeFailureLogs(root, `character-selection-${name}`, runtimes);
      console.error(`[character-selection] failure logs: ${directory}`);
    }
  }
}
