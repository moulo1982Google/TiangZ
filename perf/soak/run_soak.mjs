import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const options = parseOptions(process.argv.slice(2));
const durationSeconds = Math.round(options.minutes * 60);
const runner = path.join(root, "perf", "full_chain", "run_full_chain_perf.mjs");
const args = [
  runner,
  "--mode", options.mode,
  "--players", String(options.players),
  "--move-rates", String(options.moveRate),
  "--duration", String(durationSeconds),
  "--warmup", String(options.warmup),
  "--rounds", "1",
  "--setup-concurrency", String(options.setupConcurrency),
  "--host", options.host,
  "--manager-port", String(options.managerPort),
  "--output-prefix", "soak",
];

if (options.remote) args.push("--remote");
if (options.label) args.push("--label", options.label);

console.log(`[soak] duration=${options.minutes}m (${durationSeconds}s)`);
console.log(`[soak] mode=${options.mode} players=${options.players} moveRate=${options.moveRate}Hz`);
console.log(`[soak] command=${process.execPath} ${args.map(quote).join(" ")}`);
console.log("[soak] reports=perf/results/soak_latest.json and perf/results/soak_latest.md");

if (!options.dryRun) {
  const exit = await run(process.execPath, args);
  process.exitCode = exit.code ?? 1;
}

function parseOptions(args) {
  const valueOptions = new Set([
    "--minutes",
    "--mode",
    "--players",
    "--move-rate",
    "--warmup",
    "--setup-concurrency",
    "--host",
    "--manager-port",
    "--label",
  ]);
  const flagOptions = new Set(["--remote", "--dry-run", "--help"]);
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item.startsWith("--")) throw new Error(`unexpected argument: ${item}`);
    if (flagOptions.has(item)) {
      flags.add(item);
      continue;
    }
    if (!valueOptions.has(item)) throw new Error(`unknown option: ${item}`);
    if (index + 1 >= args.length || args[index + 1].startsWith("--")) {
      throw new Error(`${item} requires a value`);
    }
    values.set(item, args[++index]);
  }
  if (flags.has("--help")) {
    printHelp();
    process.exit(0);
  }
  const mode = values.get("--mode") ?? "split";
  if (!["all", "split"].includes(mode)) throw new Error(`invalid --mode: ${mode}`);
  return {
    minutes: positive(values.get("--minutes") ?? "60", "--minutes"),
    mode,
    players: positiveInteger(values.get("--players") ?? "200", "--players"),
    moveRate: nonNegative(values.get("--move-rate") ?? "2", "--move-rate"),
    warmup: nonNegative(values.get("--warmup") ?? "60", "--warmup"),
    setupConcurrency: positiveInteger(
      values.get("--setup-concurrency") ?? "32",
      "--setup-concurrency",
    ),
    host: values.get("--host") ?? "127.0.0.1",
    managerPort: positiveInteger(values.get("--manager-port") ?? "7000", "--manager-port"),
    remote: flags.has("--remote"),
    label: values.get("--label"),
    dryRun: flags.has("--dry-run"),
  };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function positive(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be > 0`);
  return number;
}

function positiveInteger(value, name) {
  const number = positive(value, name);
  if (!Number.isInteger(number)) throw new Error(`${name} must be an integer`);
  return number;
}

function nonNegative(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} must be >= 0`);
  return number;
}

function quote(value) {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function printHelp() {
  console.log(`TiangZ long-running stability test

Usage:
  npm run perf:soak -- --minutes 10 --mode split --players 200 --move-rate 2

Options:
  --minutes <n>            test duration in minutes; default 60
  --mode <all|split>       deployment topology; default split
  --players <n>            concurrent players; default 200
  --move-rate <hz>         movement reports per player per second; default 2
  --warmup <seconds>       warmup duration; default 60
  --setup-concurrency <n>  concurrent login setup; default 32
  --remote                 do not start local server processes
  --host <address>         remote server host
  --manager-port <port>    LoginMgr port; default 7000
  --label <name>           report label for remote mode
  --dry-run                print the resolved command without running it`);
}
