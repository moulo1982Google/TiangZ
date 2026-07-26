import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  runInherited,
  startRuntime,
  stopRuntime,
  waitForPort,
  writeFailureLogs,
} from "./lib/process_test_harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = parseMode(process.argv.slice(2));
const client = path.join(root, "dist", "mailbox_parity_test.cjs");

if (mode === "all" || mode === "both") {
  await runCase("all-in-one", ["configs/tests/mailbox_parity_all.json"]);
}
if (mode === "split" || mode === "both") {
  await runCase("split-process", [
    "configs/tests/mailbox_parity_bench.json",
    "configs/tests/mailbox_parity_caller.json",
  ]);
}
console.log("[mailbox-parity] all cases passed");

async function runCase(name, configs) {
  console.log(`[mailbox-parity] ${name}`);
  const runtimes = configs.map((config) => startRuntime(root, config, path.basename(config, ".json")));
  let succeeded = false;
  try {
    await waitForPort(7400, runtimes[0]);
    await waitForPort(7410, runtimes.at(-1));
    await runInherited(process.execPath, [client], root);
    succeeded = true;
  } finally {
    await Promise.all(runtimes.map((runtime) => stopRuntime(runtime)));
    if (!succeeded) {
      const directory = writeFailureLogs(root, `mailbox-${name}`, runtimes);
      console.error(`[mailbox-parity] failure logs: ${directory}`);
    }
  }
}

function parseMode(args) {
  if (args.length === 0) return "both";
  if (args.length === 2 && args[0] === "--mode" && ["all", "split", "both"].includes(args[1])) {
    return args[1];
  }
  throw new Error("usage: node tools/mailbox_parity_test.mjs [--mode all|split|both]");
}
