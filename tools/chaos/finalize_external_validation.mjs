import { execFile } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const options = parseOptions(process.argv.slice(2));
const eventsPath = path.join(options.runDir, "finalizer-events.jsonl");
const markerPath = "/etc/tiangz/chaos-enabled";

if (process.platform !== "linux" || process.getuid?.() !== 0) {
  throw new Error("external validation finalizer must run as root on Linux");
}

writeEvent({ type: "finalizer_started" });
let failure;
try {
  if (existsSync(markerPath)) rmSync(markerPath);
  await stopUnit("tiangz-overnight-faults.service");
  await recoverBaseline();

  for (const unit of ["tiangz-overnight-game.service", "tiangz-overnight-soak.service"]) {
    const active = await unitActive(unit);
    if (active) {
      writeEvent({ type: "workload_overran_deadline", unit });
      await stopUnit(unit);
    }
  }
  await stopUnit("tiangz-overnight-audit.service");
  await command("/usr/local/bin/node", [
    "/opt/tiangz-chaos/tools/chaos/audit_external_validation.mjs",
    "--final",
    "--run-dir",
    options.runDir,
  ], 32 * 1024 * 1024);
  const reportPath = path.join(options.runDir, "log-budget-final.json");
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : undefined;
  const status = await finalStatus(report);
  atomicWrite(path.join(options.runDir, "validation-final.json"), status);
  writeEvent({ type: "finalizer_completed", status: status.status });
  if (status.status !== "passed") process.exitCode = 1;
} catch (error) {
  failure = errorMessage(error);
  writeEvent({ type: "finalizer_failed", error: failure });
  atomicWrite(path.join(options.runDir, "validation-final.json"), {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: "failed",
    error: failure,
  });
  process.exitCode = 1;
} finally {
  if (existsSync(markerPath)) rmSync(markerPath);
}

async function recoverBaseline() {
  for (const container of ["tiangz-dbproxy-postgres", "tiangz-dbproxy-redis"]) {
    await command("docker", ["start", container], 4 * 1024 * 1024, true);
  }
  for (const unit of [
    "tiangz-dbproxy@1.service",
    "tiangz-dbproxy@2.service",
    "tiangz-external.service",
  ]) {
    await command("systemctl", ["start", unit]);
  }
  await waitContainerHealthy("tiangz-dbproxy-postgres", 180_000);
  await waitContainerHealthy("tiangz-dbproxy-redis", 180_000);
  await waitUrls([
    "http://127.0.0.1:9090/ready",
    "http://127.0.0.1:9091/ready",
    ...[17601, 17602, 17603, 17604, 17605, 17606, 17607, 17608, 17609, 17610]
      .map((port) => `http://127.0.0.1:${port}/ready`),
  ], 180_000);
  writeEvent({ type: "baseline_recovered" });
}

async function finalStatus(report) {
  const units = {};
  for (const unit of [
    "tiangz-external.service",
    "tiangz-dbproxy@1.service",
    "tiangz-dbproxy@2.service",
    "tiangz-overnight-game.service",
    "tiangz-overnight-soak.service",
    "tiangz-overnight-faults.service",
  ]) {
    const { stdout } = await command("systemctl", [
      "show",
      unit,
      "--property=ActiveState,SubState,Result,ExecMainStatus,NRestarts",
    ], 4 * 1024 * 1024, true);
    units[unit] = Object.fromEntries(stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    }));
  }
  const checks = {
    baseServicesHealthy: units["tiangz-external.service"]?.ActiveState === "active" &&
      units["tiangz-dbproxy@1.service"]?.ActiveState === "active" &&
      units["tiangz-dbproxy@2.service"]?.ActiveState === "active",
    gameRecoveryPassed: report?.checks?.gameRecoveryPassed === true,
    faultPlanPassed: report?.checks?.faultPlanPassed === true,
    prometheusIngestionClean: report?.checks?.prometheusIngestionClean === true &&
      report?.checks?.noApplicationMetricDuplicates === true,
    logBudgetPassed: report?.status === "passed",
  };
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    status: Object.values(checks).every(Boolean) ? "passed" : "needs-review",
    checks,
    units,
    logBudgetReport: report,
  };
}

async function stopUnit(unit) {
  if (await unitActive(unit)) await command("systemctl", ["stop", unit], 4 * 1024 * 1024, true);
}

async function unitActive(unit) {
  const { stdout } = await command("systemctl", ["is-active", unit], 4 * 1024 * 1024, true);
  return stdout.trim() === "active" || stdout.trim() === "activating";
}

async function waitContainerHealthy(container, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { stdout } = await command("docker", [
      "inspect",
      "--format",
      "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
      container,
    ], 4 * 1024 * 1024, true);
    if (["running|healthy", "running|none"].includes(stdout.trim())) return;
    await sleep(500);
  }
  throw new Error(`${container} did not become healthy`);
}

async function waitUrls(urls, timeoutMs) {
  const pending = new Set(urls);
  const deadline = Date.now() + timeoutMs;
  while (pending.size > 0 && Date.now() < deadline) {
    for (const url of [...pending]) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) pending.delete(url);
      } catch {}
    }
    if (pending.size > 0) await sleep(500);
  }
  if (pending.size > 0) throw new Error(`health endpoints not ready: ${[...pending].join(", ")}`);
}

async function command(executable, args, maxBuffer = 4 * 1024 * 1024, allowFailure = false) {
  try {
    return await execFileAsync(executable, args, { encoding: "utf8", maxBuffer });
  } catch (error) {
    if (allowFailure) return { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    throw error;
  }
}

function writeEvent(event) {
  appendFileSync(eventsPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
}

function atomicWrite(file, value) {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, file);
}

function parseOptions(args) {
  const index = args.indexOf("--run-dir");
  if (index < 0 || !args[index + 1]) throw new Error("--run-dir is required");
  return { runDir: path.resolve(args[index + 1]) };
}

function errorMessage(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
