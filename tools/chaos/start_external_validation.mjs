import { execFile, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const options = parseOptions(process.argv.slice(2));
const markerPath = "/etc/tiangz/chaos-enabled";
let launchCompleted = false;

process.once("exit", () => {
  if (launchCompleted) return;
  if (existsSync(markerPath)) rmSync(markerPath);
  for (const unit of [
    "tiangz-overnight-faults.service",
    "tiangz-overnight-game.service",
    "tiangz-overnight-soak.service",
    "tiangz-overnight-audit.service",
  ]) {
    spawnSync("systemctl", ["stop", unit], { stdio: "ignore" });
  }
});

if (process.platform !== "linux" || process.getuid?.() !== 0) {
  throw new Error("external validation starter must run as root on Linux");
}
for (const required of [
  "/opt/tiangz-chaos/map_probe_load",
  "/opt/tiangz-dbproxy/dbproxy_fault_soak",
  "/opt/tiangz-chaos/perf/chaos/run_longhaul_game.mjs",
  "/opt/tiangz-chaos/tools/chaos/run_external_fault_plan.mjs",
  "/opt/tiangz-chaos/tools/chaos/audit_external_validation.mjs",
  "/opt/tiangz-chaos/tools/chaos/finalize_external_validation.mjs",
]) {
  if (!existsSync(required)) throw new Error(`missing deployment artifact ${required}`);
}

const now = Date.now();
const secondsRemaining = Math.floor((options.deadlineAt - now) / 1_000);
if (secondsRemaining < 1_800) throw new Error("validation deadline must be at least 30 minutes away");
const gameSeconds = secondsRemaining - 120;
const soakSeconds = secondsRemaining - 300;
const faultSeconds = secondsRemaining - 600;
const runDir = path.join(options.baseRunDir, options.runId);
if (existsSync(path.join(runDir, "run-manifest.json"))) {
  throw new Error(`validation run already exists: ${runDir}`);
}
mkdirSync(path.join(runDir, "game"), { recursive: true });
mkdirSync(path.join(runDir, "control"), { recursive: true });
const tiangzUser = await userIdentity("tiangz");
await command("chown", ["-R", `${tiangzUser.uid}:${tiangzUser.gid}`, path.join(runDir, "game")]);

for (const unit of [
  "tiangz-overnight-game.service",
  "tiangz-overnight-soak.service",
  "tiangz-overnight-faults.service",
  "tiangz-overnight-audit.service",
  "tiangz-overnight-finalize.service",
  "tiangz-overnight-finalize.timer",
]) {
  await command("systemctl", ["stop", unit], true);
  await command("systemctl", ["reset-failed", unit], true);
}

await command("/usr/local/bin/node", [
  "/opt/tiangz-chaos/tools/chaos/run_external_fault_plan.mjs",
  "--preflight",
]);

writeFileSync(markerPath, `run_id=${options.runId}\ndeadline=${new Date(options.deadlineAt).toISOString()}\n`, {
  encoding: "utf8",
  mode: 0o600,
});

const manifest = {
  schemaVersion: 2,
  runId: options.runId,
  runDir,
  startedAt: new Date(now).toISOString(),
  deadlineAt: new Date(options.deadlineAt).toISOString(),
  players: options.players,
  seconds: { total: secondsRemaining, game: gameSeconds, soak: soakSeconds, faults: faultSeconds },
  faultPlan: {
    warmupMinutes: options.faultWarmupMinutes,
    minGapMinutes: options.faultMinGapMinutes,
    maxGapMinutes: options.faultMaxGapMinutes,
    jointAfterHours: options.jointAfterHours,
  },
  logging: {
    auditIntervalSeconds: options.auditIntervalSeconds,
    evidenceBudgetBytes: options.evidenceBudgetBytes,
    diskReserveBytes: options.diskReserveBytes,
    journalCap: "4G",
  },
};
atomicWrite(path.join(runDir, "run-manifest.json"), manifest);
updateCurrentLink(runDir, options.baseRunDir);

await startTransient("tiangz-overnight-audit", [
  "User=root",
  "WorkingDirectory=/opt/tiangz-chaos",
  "Restart=on-failure",
  "RestartSec=10",
  `StandardOutput=append:${path.join(runDir, "audit-service.log")}`,
  `StandardError=append:${path.join(runDir, "audit-service.log")}`,
], "/usr/local/bin/node", [
  "/opt/tiangz-chaos/tools/chaos/audit_external_validation.mjs",
  "--deadline", new Date(options.deadlineAt).toISOString(),
  "--interval-seconds", String(options.auditIntervalSeconds),
  "--run-dir", runDir,
  "--evidence-budget-bytes", String(options.evidenceBudgetBytes),
  "--disk-reserve-bytes", String(options.diskReserveBytes),
]);

await startTransient("tiangz-overnight-game", [
  "User=tiangz",
  "Group=tiangz",
  "WorkingDirectory=/opt/tiangz-chaos",
  "Restart=on-failure",
  "RestartSec=15",
  "KillMode=control-group",
  "Nice=5",
  "CPUWeight=50",
  "MemoryHigh=1G",
  "MemoryMax=1536M",
  "LimitNOFILE=65535",
  `StandardOutput=append:${path.join(runDir, "game-service.log")}`,
  `StandardError=append:${path.join(runDir, "game-service.log")}`,
], "/usr/local/bin/node", [
  "/opt/tiangz-chaos/perf/chaos/run_longhaul_game.mjs",
  "--client", "rust",
  "--client-path", "/opt/tiangz-chaos/map_probe_load",
  "--host", "127.0.0.1",
  "--manager-port", "27000",
  "--players", String(options.players),
  "--total-hours", String(gameSeconds / 3_600),
  "--session-seconds", "300",
  "--warmup-seconds", "10",
  "--move-rate", "1",
  "--probe-rate", "0.05",
  "--business-rate", "0.02",
  "--account-prefix", options.accountPrefix,
  "--run-dir", path.join(runDir, "game"),
]);

await startTransient("tiangz-overnight-soak", [
  "User=tiangz",
  "Group=tiangz",
  "WorkingDirectory=/opt/tiangz-dbproxy",
  "EnvironmentFile=/etc/tiangz/dbproxy.env",
  "Restart=no",
  "Nice=5",
  "CPUWeight=50",
  "MemoryHigh=256M",
  "MemoryMax=512M",
  "LimitNOFILE=65535",
  `StandardOutput=append:${path.join(runDir, "dbproxy-soak.log")}`,
  `StandardError=append:${path.join(runDir, "dbproxy-soak.log")}`,
], "/opt/tiangz-dbproxy/dbproxy_fault_soak", [
  "--endpoint", "127.0.0.1:7800",
  "--failover-endpoint", "127.0.0.1:7801",
  "--players", "100",
  "--duration", String(soakSeconds),
  "--cycle-ms", "1000",
  "--read-pool-size", "24",
  "--write-pool-size", "8",
  "--trade-interval-cycles", "300",
  "--report-interval", "60",
  "--validation-timeout", "240",
]);

await startTransient("tiangz-overnight-faults", [
  "User=root",
  "WorkingDirectory=/opt/tiangz-chaos",
  "Restart=on-failure",
  "RestartSec=30",
  "Nice=10",
  "CPUWeight=20",
  `StandardOutput=append:${path.join(runDir, "fault-service.log")}`,
  `StandardError=append:${path.join(runDir, "fault-service.log")}`,
], "/usr/local/bin/node", [
  "/opt/tiangz-chaos/tools/chaos/run_external_fault_plan.mjs",
  "--execute",
  "--duration-hours", String(faultSeconds / 3_600),
  "--warmup-minutes", String(options.faultWarmupMinutes),
  "--min-gap-minutes", String(options.faultMinGapMinutes),
  "--max-gap-minutes", String(options.faultMaxGapMinutes),
  "--joint-after-hours", String(options.jointAfterHours),
  "--run-dir", path.join(runDir, "control"),
  "--marker", markerPath,
]);

await scheduleFinalizer(runDir, options.deadlineAt);
launchCompleted = true;
console.log(JSON.stringify({ status: "started", ...manifest }));

async function startTransient(unit, properties, executable, args) {
  const commandArgs = ["--unit", unit];
  for (const property of properties) commandArgs.push("--property", property);
  commandArgs.push(executable, ...args);
  await command("systemd-run", commandArgs);
}

async function scheduleFinalizer(validationRunDir, deadlineAt) {
  const calendar = `${new Date(deadlineAt).toISOString().replace("T", " ").replace(".000Z", " UTC")}`;
  await command("systemd-run", [
    "--unit", "tiangz-overnight-finalize",
    "--on-calendar", calendar,
    "--timer-property", "AccuracySec=1s",
    "--property", "User=root",
    "--property", "WorkingDirectory=/opt/tiangz-chaos",
    "--property", `StandardOutput=append:${path.join(validationRunDir, "finalizer.log")}`,
    "--property", `StandardError=append:${path.join(validationRunDir, "finalizer.log")}`,
    "/usr/local/bin/node",
    "/opt/tiangz-chaos/tools/chaos/finalize_external_validation.mjs",
    "--run-dir", validationRunDir,
  ]);
}

async function userIdentity(user) {
  const [{ stdout: uid }, { stdout: gid }] = await Promise.all([
    command("id", ["-u", user]),
    command("id", ["-g", user]),
  ]);
  return { uid: uid.trim(), gid: gid.trim() };
}

function updateCurrentLink(target, base) {
  const link = path.join(base, "current-validation");
  if (existsSync(link)) {
    const current = path.resolve(link);
    if (!current.startsWith(`${path.resolve(base)}${path.sep}`)) {
      throw new Error(`refusing to replace unexpected current-validation target ${current}`);
    }
    rmSync(link);
  }
  symlinkSync(target, link, "dir");
}

function atomicWrite(file, value) {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, file);
}

async function command(executable, args, allowFailure = false) {
  try {
    return await execFileAsync(executable, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    if (allowFailure) return { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    throw error;
  }
}

function parseOptions(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`invalid argument near ${key ?? "<end>"}`);
    }
    values.set(key, value);
    index += 1;
  }
  const number = (name, fallback) => {
    const value = Number(values.get(name) ?? fallback);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be > 0`);
    return value;
  };
  const deadlineText = values.get("--deadline");
  if (!deadlineText) throw new Error("--deadline is required");
  const deadlineAt = Date.parse(deadlineText);
  if (!Number.isFinite(deadlineAt)) throw new Error("--deadline must be an ISO timestamp");
  const runId = values.get("--run-id") ?? `validation-${timestamp()}`;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) throw new Error("--run-id contains unsafe characters");
  const accountPrefix = values.get("--account-prefix") ?? "overnight";
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(accountPrefix)) throw new Error("invalid --account-prefix");
  const faultMinGapMinutes = number("--fault-min-gap-minutes", 25);
  const faultMaxGapMinutes = number("--fault-max-gap-minutes", 35);
  if (faultMaxGapMinutes < faultMinGapMinutes) throw new Error("fault max gap must be >= min gap");
  return {
    deadlineAt,
    runId,
    accountPrefix,
    baseRunDir: path.resolve(values.get("--base-run-dir") ?? "/var/log/tiangz-chaos"),
    players: Math.floor(number("--players", 500)),
    faultWarmupMinutes: number("--fault-warmup-minutes", 15),
    faultMinGapMinutes,
    faultMaxGapMinutes,
    jointAfterHours: number("--joint-after-hours", 3),
    auditIntervalSeconds: number("--audit-interval-seconds", 300),
    evidenceBudgetBytes: number("--evidence-budget-bytes", 2 * 1024 ** 3),
    diskReserveBytes: number("--disk-reserve-bytes", 12 * 1024 ** 3),
  };
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
