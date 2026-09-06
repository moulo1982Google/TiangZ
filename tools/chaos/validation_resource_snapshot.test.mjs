import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("native snapshot identifies a live CPU workload and keeps evidence bounded", {
  skip: process.platform !== "win32", timeout: 30_000,
}, async () => {
  const child = spawn(process.execPath, ["-e",
    'console.log("ready"); const until=Date.now()+15000; while(Date.now()<until) Math.sqrt(Math.random());'],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  try {
    await once(child.stdout, "data");
    const executable = fileURLToPath(new URL("../../target/release/validation_resource_snapshot.exe", import.meta.url));
    const { stdout } = await promisify(execFile)(executable, [], {
      windowsHide: true, timeout: 20_000, maxBuffer: 256 * 1024,
    });
    const snapshot = JSON.parse(stdout);
    assert.ok(snapshot.cpuSampleSeconds >= 0.9);
    assert.ok(snapshot.cpuProcesses.length <= 8);
    assert.ok(snapshot.processes.length <= 12);
    const busy = snapshot.cpuProcesses.find(p => p.pid === child.pid);
    assert.ok(busy?.cpuPercent > 0, "the live workload must have nonzero interval CPU");
    for (const p of [...snapshot.processes, ...snapshot.cpuProcesses]) {
      assert.ok(Number.isFinite(p.cpuPercent) && p.cpuPercent >= 0 && p.cpuPercent <= 100);
      assert.deepEqual(Object.keys(p).sort(), ["cpuPercent", "name", "pid", "rssBytes"]);
    }
  } finally {
    if (child.exitCode === null) child.kill();
    await closed;
  }
});
