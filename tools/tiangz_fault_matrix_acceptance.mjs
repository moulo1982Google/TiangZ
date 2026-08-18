import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runInherited } from "./lib/process_test_harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbProxyRoot = path.join(root, "tools-projects", "TiangZ-DBProxy");
const reportPath = path.join(root, "temp", "test-logs", "tiangz-fault-matrix-report.json");
const stages = [];

try {
  await runStage(
    "player-trade-faults",
    process.execPath,
    [path.join(root, "tools", "player_trade_persistence_acceptance.mjs")],
    root,
  );
  await runStage(
    "player-domain-recovery",
    process.execPath,
    [path.join(root, "tools", "player_domain_recovery_acceptance.mjs")],
    root,
  );
  await runStage(
    "dbproxy-storage-faults",
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(dbProxyRoot, "tools", "fault_matrix.ps1")],
    dbProxyRoot,
  );
  writeReport("passed");
  console.log("[fault-matrix] TiangZ end-to-end fault matrix passed");
  console.log(`[fault-matrix] report: ${path.relative(root, reportPath)}`);
} catch (error) {
  writeReport("failed", { error: error instanceof Error ? error.stack ?? error.message : String(error) });
  console.error(`[fault-matrix] failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`[fault-matrix] report: ${path.relative(root, reportPath)}`);
  process.exitCode = 1;
}

async function runStage(name, command, args, cwd) {
  const startedAt = Date.now();
  console.log(`[fault-matrix] start ${name}`);
  try {
    await runInherited(command, args, cwd);
    stages.push({ name, status: "passed", durationMs: Date.now() - startedAt });
  } catch (error) {
    stages.push({
      name,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
    throw error;
  }
}

function writeReport(status, detail = {}) {
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({
    status,
    generatedAt: new Date().toISOString(),
    stages,
    ...detail,
  }, null, 2), "utf8");
}
