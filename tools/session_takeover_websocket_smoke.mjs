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
const runtime = startRuntime(root, "configs/local/all-in-one.json", "session-takeover-websocket");
const client = path.join(root, "dist", "session_takeover_websocket_smoke.cjs");
let succeeded = false;

try {
  await Promise.all([7000, 7001, 7002, 7201, 7202, 7301, 7302, 7310, 7401].map((port) => (
    waitForPort(port, runtime)
  )));
  await runInherited(process.execPath, [client, "127.0.0.1", "7000"], root);
  succeeded = true;
} finally {
  await stopRuntime(runtime);
  if (!succeeded) {
    console.error(`[session-takeover-websocket] failure logs: ${writeFailureLogs(root, "session-takeover-websocket", [runtime])}`);
  }
}
