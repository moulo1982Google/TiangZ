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
const options = parseOptions(process.argv.slice(2));
const mode = options.mode;
const client = path.join(root, "dist", "smoke_client.cjs");

if (mode === "all" || mode === "both") {
  await runCase("all-in-one", ["configs/local/all.json"], true);
}
if (mode === "split" || mode === "both") {
  await runCase("split-process", [
    "configs/local/mgr.json",
    "configs/local/login1.json",
    "configs/local/login2.json",
    "configs/local/gate1.json",
    "configs/local/map1.json",
  ], false);
}
console.log("[smoke] runtime smoke passed");

async function runCase(name, configs, checkHealth) {
  console.log(`[smoke] ${name}`);
  const runtimes = configs.map((config) => startRuntime(root, config, path.basename(config, ".json")));
  let succeeded = false;
  try {
    await Promise.all([7000, 7001, 7002, 7201, 7301].map((port) => waitForPort(port, runtimes[0])));
    if (checkHealth) await waitForReady(7600);
    await runInherited(process.execPath, [client, ...options.clientArgs], root);
    succeeded = true;
  } finally {
    await Promise.all(runtimes.map((runtime) => stopRuntime(runtime)));
    if (!succeeded) {
      const directory = writeFailureLogs(root, `runtime-${name}`, runtimes);
      console.error(`[smoke] failure logs: ${directory}`);
    }
  }
}

function parseOptions(args) {
  let mode = "both";
  const clientArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--mode" && ["all", "split", "both"].includes(args[index + 1])) {
      mode = args[index + 1];
      index += 1;
      continue;
    }
    if (args[index] === "--gate-timeout-only") {
      clientArgs.push(args[index]);
      continue;
    }
    throw new Error(
      "usage: node tools/smoke_runtime.mjs [--mode all|split|both] [--gate-timeout-only]",
    );
  }
  return { mode, clientArgs };
}
