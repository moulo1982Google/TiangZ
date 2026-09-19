// `.native`持久化写法（普通CAS / @queued / @transactional）长稳与故障恢复用例。
// Soak and fault-recovery test for `.native` persistence write modes (ordinary CAS / @queued / @transactional).
//
//   plan   默认。只打印计划，不读凭据、不访问Docker、不启动进程。
//   check  只读检查制品是否存在并记录哈希。
//   smoke  内存DBProxy + 真实TiangZ探针 + 一次探针强杀重启；不连接数据库容器，不注入存储故障。
//   run    专用演练环境的长稳：清理本用例自己的库和Redis库号，启动两个DBProxy节点并按计划注入故障。
//          必须显式 --confirm；与其他可靠性演练共用同一把锁，不能并行。
//
//   plan   Default. Prints the plan only; reads no credentials, touches no Docker, starts nothing.
//   check  Read-only artifact existence and hash check.
//   smoke  In-memory DBProxy + real TiangZ probe + one probe kill/restart; no database containers or storage faults.
//   run    Soak on the dedicated drill environment: resets only this test's database and Redis DB number,
//          starts two DBProxy nodes and injects the planned faults. Requires --confirm and shares the
//          reliability lock with the other drills, so it never runs concurrently with them.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { atomicReleaseId } from "./atomic_release_identity.mjs";
import { stopRuntime, sleep } from "./lib/process_test_harness.mjs";
import {
  FAULTS, FULL_FAULT_ORDER, MODES, NAMESPACES, WALLET_TOTAL,
  ackCounters, adoptBootState, applyProbeEvent, assertCoverage, checkLoadedState, checkStorageRows,
  createLedger, planSchedule, resumeState, roundsSatisfied,
} from "./lib/persistence_write_modes_ledger.mjs";
import { extractProbeEvent, renderProbeScript } from "./lib/persistence_write_modes_probe.mjs";

export const CONFIRMATION = "reset-write-modes-soak-data-and-inject-faults";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.resolve(root, "..");
const dbRoot = path.join(workspace, "TiangZ-DBProxy");
const evidenceBase = path.join(workspace, ".build-tmp", "local-validation");
const exe = process.platform === "win32" ? ".exe" : "";
const ARTIFACTS = {
  runtime: path.join(root, "target", "debug", `TiangZ${exe}`),
  dbproxy: path.join(dbRoot, "target", "release", `tiangz-dbproxy-server${exe}`),
};
// 夹具模块只提供一个空场景类型；运行时包由当前源码经正式模块工具链现场构建。
// The fixture module only provides an empty scene type; runtime bundles are built from current source by the official module toolchain.
const FIXTURE_MODULE_ID = "org.tiangz.writemodes";
const FIXTURE_MODEL = `import { EntryScene, entryScene, defineGameModule } from "#tiangz/core";
import type { QueuedEntityRepository, TransactionalEntityRepository } from "#tiangz/core";

// 写法长稳探针的宿主场景；负载由测试注入，场景本身不承载业务。
// Host scene for the write-mode soak probe; the workload is injected by the test and the scene owns no gameplay.
@entryScene()
export class WriteModesProbeScene extends EntryScene {}

// 编译期确认模块可从稳定入口取得受限仓库类型。 / Compile-time check that modules reach the restricted repository types through the stable entry.
export type WriteModesProbeContracts = [QueuedEntityRepository<unknown, unknown>, TransactionalEntityRepository<unknown, unknown>];

defineGameModule({ id: "${FIXTURE_MODULE_ID}", version: "0.1.0", modelExports: { WriteModesProbeScene } });
`;
// 专用演练环境与Examples可靠性入口相同；本用例只使用自己的数据库和Redis库号。
// Same dedicated drill environment as the Examples reliability entry; this test owns only its database and Redis DB number.
const ENVIRONMENT = Object.freeze({
  project: "tiangz-dbproxy-local",
  postgres: "tiangz-dbproxy-postgres",
  redis: "tiangz-dbproxy-redis",
  cache: "tiangz-dbproxy-cache",
  database: "dbproxy_write_modes_soak",
  redisDb: 5,
});
const BACKLOG_KEYS = ["dbproxy:snapshot-backlog:pending", "dbproxy:snapshot-backlog:processing"];
const PROBE_TIMING = { stepMs: 250, errorBackoffMs: 500, auditMs: 1000, statMs: 5000 };
// 本组验证正确性而非容量。单条Enqueue每节点单连接等待everysec的WAITAOF，实测约1.5次/秒/节点，
// 且宿主平时只连首选节点；每玩家40秒一次、按玩家错开，20玩家约0.5次/秒，留出余量避免自我维持的过载。
// This suite proves correctness, not capacity. Single Enqueue waits for everysec WAITAOF on one connection
// per node (~1.5/s per node measured) and the Host normally uses only the primary node; one write per
// player every 40 s, staggered, keeps 20 players at ~0.5/s so overload cannot become self-sustaining.
const DURABLE_QUEUED_STEP_MS = 40_000;
// 操作事件只进内存账本；保留最近一段供失败定位，避免日志随时长线性膨胀。
// Op events go to the in-memory ledger; keep a recent window for failure analysis so logs do not grow with duration.
const RECENT_OP_LIMIT = 5000;

function parseArguments(argv) {
  const [action = "plan", ...rest] = argv;
  if (!["plan", "check", "smoke", "run"].includes(action)) throw new Error("expected plan/check/smoke/run");
  const values = new Map();
  for (let i = 0; i < rest.length; i += 2) {
    if (!["--seconds", "--players", "--steady-seconds", "--confirm"].includes(rest[i]) || rest[i + 1] === undefined || values.has(rest[i])) {
      throw new Error("invalid or duplicate option");
    }
    values.set(rest[i], rest[i + 1]);
  }
  const smoke = action === "smoke";
  const seconds = Number(values.get("--seconds") ?? (smoke ? 60 : 3600));
  const players = Number(values.get("--players") ?? (smoke ? 4 : 20));
  const steadySeconds = Number(values.get("--steady-seconds") ?? (smoke ? 5 : 60));
  const [minSeconds, maxSeconds] = smoke ? [10, 600] : [900, 14400];
  if (!Number.isInteger(seconds) || seconds < minSeconds || seconds > maxSeconds) throw new Error(`seconds must be ${minSeconds}..${maxSeconds}`);
  if (!Number.isInteger(players) || players < 1 || players > (smoke ? 20 : 100)) throw new Error(`players must be 1..${smoke ? 20 : 100}`);
  if (!Number.isInteger(steadySeconds) || steadySeconds < 1 || steadySeconds > 600) throw new Error("steady-seconds must be 1..600");
  if (action === "run" && values.get("--confirm") !== CONFIRMATION) throw new Error(`run requires --confirm ${CONFIRMATION}`);
  if (action !== "run" && values.has("--confirm")) throw new Error("--confirm is only accepted by run");
  const faults = smoke ? ["probe-restart"] : [...FULL_FAULT_ORDER];
  return { action, seconds, players, steadySeconds, faults, schedule: planSchedule({ seconds, faults, steadySeconds }) };
}

function describePlan(options) {
  return {
    title: "持久化写法长稳与故障恢复 / persistence write-mode soak",
    action: options.action,
    players: options.players,
    workload: "每个虚拟玩家并行三条写入链：普通CAS保存、@queued排队写、@transactional双钱包原子转账 / per virtual player: ordinary CAS saves, @queued writes, @transactional two-wallet transfers",
    namespaces: NAMESPACES,
    probeTiming: { ...PROBE_TIMING, queuedStepMs: queuedStepMs(options.action),
      note: "正确性用例：排队写负载刻意低于实测单节点容量，不代表容量 / correctness suite: queued load deliberately below measured single-node capacity; not a capacity result" },
    schedule: options.schedule,
    faults: Object.fromEntries(options.faults.map((fault) => [fault, FAULTS[fault].summary])),
    recoveryRule: "每次故障后等待依赖恢复，并要求每个玩家每种写法再确认至少两次 / after each fault every player and mode must acknowledge at least two more writes",
    checks: [
      "意图先于写入记录；进程在任意时刻被杀，账本仍知道可能已提交的最大值 / intents precede writes",
      "重启恢复读取：普通/事务记录只能是最近确认值或唯一在途值，排队记录不超过尝试值 / boot recovery read",
      "排空排队积压后最终读取：排队记录不低于确认值（包括AOF重启场景） / final read after draining the queue",
      "钱包：同序号、同revision、总额守恒、恰好一次提交 / wallets: atomic, conserved, exactly once",
      "PG直接核对写法互斥：排队行无版本校验、普通行有版本校验、事务记录不出现在快照写入中 / storage-level exclusivity",
    ],
    environment: options.action === "run" ? { ...ENVIRONMENT, note: "只重建本用例数据库并清空Redis库号5；不触碰其他演练数据 / resets only this test's database and Redis DB 5" }
      : options.action === "smoke" ? { dbproxy: "memory backend on a free loopback port", containers: "none" } : "not accessed",
    artifacts: ARTIFACTS,
    status: "planned, not executed",
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.action === "plan") { console.log(JSON.stringify(describePlan(options), null, 2)); return; }
  const hashes = checkArtifacts();
  if (options.action === "check") {
    console.log(JSON.stringify({ artifacts: hashes, dbproxyConfigs: checkDbProxyConfigs(),
      status: "artifacts present and DBProxy configs valid offline; no database, container or runtime was started" }, null, 2));
    return;
  }
  await new Soak(options, hashes).execute();
}

function checkArtifacts() {
  const required = [ARTIFACTS.runtime, ARTIFACTS.dbproxy];
  const missing = required.filter((file) => !existsSync(file));
  if (missing.length) throw new Error(`missing artifacts (build first):\n${missing.join("\n")}`);
  const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
  return { runtime: hash(ARTIFACTS.runtime), dbproxy: hash(ARTIFACTS.dbproxy) };
}

class Soak {
  constructor(options, hashes) {
    this.options = options;
    this.hashes = hashes;
    this.run = options.action === "run";
    this.runId = `wms-${Date.now().toString(36)}`;
    this.ledger = createLedger(options.players);
    this.children = new Set();
    this.dbproxies = new Map();
    this.probe = undefined;
    this.epoch = 0;
    this.failure = undefined;
    this.completed = [];
    this.rollbacks = [];
    this.lastStat = undefined;
    this.recentOps = [];
    this.token = randomBytes(24).toString("hex");
  }

  async execute() {
    const base = this.run ? evidenceBase : path.join(root, "temp");
    mkdirSync(base, { recursive: true });
    this.dir = path.join(base, `write-modes-${this.options.action}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    mkdirSync(this.dir);
    this.report = { status: "running", runId: this.runId, startedAt: new Date().toISOString(), plan: describePlan(this.options), hashes: this.hashes,
      repositories: gitHeads() };
    this.save();
    let lock;
    if (this.run) {
      // 与Examples可靠性入口共用锁；锁残留时需人工确认旧控制器已退出，不自动抢锁。紧挨try获取，保证finally一定释放。
      // Shares the Examples reliability lock; a stale lock needs manual confirmation, never takeover. Taken right before try so finally always releases it.
      lock = await open(path.join(evidenceBase, "reliability.lock"), "wx");
    }
    try {
      if (lock) await lock.writeFile(JSON.stringify({ pid: process.pid, action: "write-modes", at: new Date().toISOString() }));
      // 先构建夹具：构建失败时不清库、不启动任何进程。 / Build first: a build failure neither resets data nor starts processes.
      this.prepareRuntimeDirectory();
      if (this.run) this.prepareDedicatedEnvironment(); else this.env = {};
      await this.startDbProxies();
      await this.startProbe("run");
      await this.soak();
      await this.finish();
      this.report.status = "passed";
      console.log(`[write-modes] passed: ${path.join(this.dir, "final.json")}`);
    } catch (error) {
      this.report.status = "failed";
      this.report.error = String(error?.stack ?? error);
      console.error(`[write-modes] failed: ${error?.message ?? error}`);
      process.exitCode = 1;
    } finally {
      await this.cleanup();
      this.report.finishedAt = new Date().toISOString();
      this.report.ledger = summarizeLedger(this.ledger);
      this.report.rollbacks = this.rollbacks;
      this.report.completedFaults = this.completed;
      this.report.lastProbeStat = this.lastStat;
      writeFileSync(path.join(this.dir, "ledger.json"), JSON.stringify(this.ledger, null, 2));
      if (this.report.status !== "passed") writeFileSync(path.join(this.dir, "probe-recent-ops.log"), this.recentOps.join("\n") + "\n");
      this.save("final.json");
      if (lock) { await lock.close(); await unlink(path.join(evidenceBase, "reliability.lock")); }
      console.log(`[write-modes] evidence: ${this.dir}`);
    }
  }

  save(file = "report.json") { writeFileSync(path.join(this.dir, file), JSON.stringify(this.report, null, 2)); }

  event(type, details = {}) {
    const value = { at: new Date().toISOString(), type, ...details };
    appendFileSync(path.join(this.dir, "events.jsonl"), JSON.stringify(value) + "\n");
    console.log(`[write-modes] ${JSON.stringify(value)}`);
  }

  fail(reason, details = {}) {
    if (this.failure) return;
    this.failure = new Error(`${reason} ${JSON.stringify(details)}`);
    this.event("failure", { reason, ...details });
  }

  assertHealthy() {
    if (this.failure) throw this.failure;
    if (existsSync(path.join(this.dir, "STOP"))) throw new Error("STOP requested");
  }

  async wait(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { this.assertHealthy(); await sleep(Math.min(250, deadline - Date.now())); }
    this.assertHealthy();
  }

  async until(predicate, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.assertHealthy();
      if (await predicate()) return;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  // ---------- 专用环境 / dedicated environment ----------

  prepareDedicatedEnvironment() {
    const inspected = JSON.parse(command("docker", ["inspect", ENVIRONMENT.postgres, ENVIRONMENT.redis, ENVIRONMENT.cache]));
    for (const container of inspected) {
      if (container.Config.Labels?.["com.docker.compose.project"] !== ENVIRONMENT.project) {
        throw new Error(`refusing container ${container.Name} outside compose project ${ENVIRONMENT.project}`);
      }
      for (const bindings of Object.values(container.NetworkSettings.Ports ?? {})) {
        if (bindings?.some((binding) => binding.HostIp !== "127.0.0.1")) throw new Error(`${container.Name} port is not loopback-only`);
      }
    }
    const appendonly = redisCli(ENVIRONMENT.cache, ["CONFIG", "GET", "appendonly"]).split(/\r?\n/)[1];
    const save = redisCli(ENVIRONMENT.cache, ["CONFIG", "GET", "save"]).split(/\r?\n/)[1];
    if (appendonly !== "no" || save !== "") throw new Error("snapshot cache must disable AOF and RDB; restored stale cache would violate the recovery contract");
    const values = {};
    for (const line of readFileSync(path.join(dbRoot, "deploy", "local", ".env"), "utf8").split(/\r?\n/)) {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
    for (const name of ["DBPROXY_POSTGRES_USER", "DBPROXY_POSTGRES_PASSWORD", "DBPROXY_REDIS_PASSWORD"]) {
      if (!values[name]) throw new Error(`missing ${name} in TiangZ-DBProxy/deploy/local/.env`);
    }
    const user = encodeURIComponent(values.DBPROXY_POSTGRES_USER);
    const password = encodeURIComponent(values.DBPROXY_POSTGRES_PASSWORD);
    const redisPassword = encodeURIComponent(values.DBPROXY_REDIS_PASSWORD);
    this.env = {
      WMS_POSTGRES_URL: `postgresql://${user}:${password}@127.0.0.1:5432/${ENVIRONMENT.database}`,
      WMS_REDIS_URL: `redis://:${redisPassword}@127.0.0.1:6379/${ENVIRONMENT.redisDb}`,
      WMS_CACHE_REDIS_URL: `redis://:${redisPassword}@127.0.0.1:6380/${ENVIRONMENT.redisDb}`,
    };
    // 只重建本用例的数据库与Redis库号。 / Reset only this test's database and Redis DB number.
    psql(`DROP DATABASE IF EXISTS ${ENVIRONMENT.database} WITH (FORCE);`, "postgres");
    psql(`CREATE DATABASE ${ENVIRONMENT.database};`, "postgres");
    for (const container of [ENVIRONMENT.redis, ENVIRONMENT.cache]) redisCli(container, ["-n", String(ENVIRONMENT.redisDb), "FLUSHDB"]);
    this.event("environment_prepared", { database: ENVIRONMENT.database, redisDb: ENVIRONMENT.redisDb });
  }

  async containersHealthy(names = [ENVIRONMENT.postgres, ENVIRONMENT.redis, ENVIRONMENT.cache]) {
    await this.until(() => {
      const state = JSON.parse(command("docker", ["inspect", ...names]));
      return state.every((container) => container.State.Running && container.State.Health?.Status === "healthy");
    }, 120_000, `healthy containers ${names.join(",")}`);
  }

  // ---------- DBProxy 节点 / DBProxy nodes ----------

  async startDbProxies() {
    const count = this.run ? 2 : 1;
    for (let index = 1; index <= count; index++) {
      const name = `dbproxy${index}`;
      const port = await freePort();
      const observability = await freePort();
      const configPath = path.join(this.dir, `${name}.json`);
      writeFileSync(configPath, JSON.stringify(dbproxyConfig({ durable: this.run, port, observability }), null, 2));
      this.dbproxies.set(name, { name, port, observability, configPath });
      await this.startDbProxy(name);
    }
  }

  async startDbProxy(name) {
    const node = this.dbproxies.get(name);
    node.process = this.spawnLogged(name, ARTIFACTS.dbproxy, ["--config", node.configPath], dbRoot, {
      ...this.env, WMS_DBPROXY_TOKEN: this.token, RUST_LOG: "info",
    });
    await this.until(async () => {
      if (node.process.child.exitCode !== null) throw new Error(`${name} exited before ready; see ${node.process.log}`);
      try { return (await fetch(`http://127.0.0.1:${node.observability}/ready`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
    }, 120_000, `${name} readiness`);
    this.event("dbproxy_ready", { name, port: node.port });
  }

  async killDbProxy(name) {
    const node = this.dbproxies.get(name);
    node.process.child.kill("SIGKILL");
    await node.process.done;
    this.event("dbproxy_killed", { name });
  }

  async dbproxiesReady() {
    for (const node of this.dbproxies.values()) {
      await this.until(async () => {
        try { return (await fetch(`http://127.0.0.1:${node.observability}/ready`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
      }, 120_000, `${node.name} readiness`);
    }
  }

  // ---------- 探针 / probe ----------

  /** 用正式模块工具链从当前源码构建夹具运行时。 / Builds the fixture runtime from current source with the official module toolchain. */
  prepareRuntimeDirectory() {
    if (this.runtimeDir) return;
    this.runtimeDir = path.join(this.dir, "fixture");
    const modules = path.join(this.runtimeDir, "modules");
    const moduleRoot = path.join(modules, "writemodes");
    const dist = path.join(this.runtimeDir, "dist");
    mkdirSync(path.join(this.runtimeDir, "configs"), { recursive: true });
    const tool = (args) => execFileSync(process.execPath, args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 180_000,
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TIANGZ_MODULES_DIR: modules } });
    tool(["tools/create_game_module.mjs", "--id", FIXTURE_MODULE_ID, "--path", moduleRoot]);
    writeFileSync(path.join(moduleRoot, "src", "model", "index.ts"), FIXTURE_MODEL);
    writeFileSync(path.join(moduleRoot, "src", "hotfix", "index.ts"), "export {};\n");
    tool(["tools/prepare_game_modules.mjs", "--modules-dir", modules]);
    tool(["tools/build_runtime_bundles.mjs", "--modules-dir", modules, "--out-dir", dist]);
    tool(["tools/build_game_config_data.mjs", "--modules-dir", modules, "--out-dir", dist, "--initial"]);
    this.originalModel = readFileSync(path.join(dist, "model.js"), "utf8");
    this.originalManifests = Object.fromEntries(["model.manifest.json", "hotfix.manifest.json"].map((file) =>
      [file, readFileSync(path.join(dist, file), "utf8")]));
    this.report.hashes.fixtureModel = createHash("sha256").update(this.originalModel).digest("hex");
    this.event("fixture_built", { module: FIXTURE_MODULE_ID });
  }

  async startProbe(mode) {
    this.prepareRuntimeDirectory();
    this.epoch += 1;
    const nodes = [...this.dbproxies.values()];
    const scenePort = await freePort();
    writeFileSync(path.join(this.runtimeDir, "configs", "probe.json"), JSON.stringify({
      process: {
        name: "write-modes-probe",
        identity: { originServerId: 33, workerId: 0 },
        persistence: { dbProxy: {
          endpoint: `127.0.0.1:${nodes[0].port}`,
          failoverEndpoints: nodes.slice(1).map((node) => `127.0.0.1:${node.port}`),
          authTokenEnv: "WMS_TIANGZ_DBPROXY_TOKEN", clientPoolSize: 4, connectTimeoutMs: 2000, requestTimeoutMs: 5000, maxFrameBytes: 8388608,
        } },
      },
      scenes: [{ name: "probe", sceneType: "WriteModesProbe", ip: "127.0.0.1", port: scenePort, protocol: "websocket", audience: "outer" }],
    }, null, 2));
    const model = this.originalModel + renderProbeScript({
      runId: this.runId, epoch: this.epoch, mode, players: this.options.players, namespaces: NAMESPACES,
      resume: resumeState(this.ledger), walletTotal: WALLET_TOTAL, settleMs: this.epoch > 1 ? 5000 : 0, ...PROBE_TIMING,
      queuedStepMs: queuedStepMs(this.options.action),
    });
    writeFileSync(path.join(this.runtimeDir, "dist", "model.js"), model);
    const fingerprint = createHash("sha256").update(model).digest("hex");
    for (const [file, content] of Object.entries(this.originalManifests)) {
      const manifest = JSON.parse(content);
      manifest.modelFingerprint = fingerprint;
      // 发布身份绑定Model指纹；注入探针后按同一契约重算，而不是绕过宿主校验。
      // The release identity binds the Model fingerprint; recompute it with the same contract instead of bypassing Host checks.
      if (typeof manifest.releaseId === "string") {
        manifest.releaseId = atomicReleaseId(manifest);
        manifest.bundleVersion = `${manifest.bundleVersion.split("+")[0]}+${manifest.releaseId}`;
      }
      writeFileSync(path.join(this.runtimeDir, "dist", file), JSON.stringify(manifest));
    }
    const name = `probe-e${this.epoch}-${mode}`;
    const probe = this.spawnLogged(name, ARTIFACTS.runtime, [`--runtime-root=${this.runtimeDir}`, path.join(this.runtimeDir, "configs", "probe.json")], this.runtimeDir, {
      RUST_LOG: "info", TIANGZ_WATCHER_CONTROL: "stdin", WMS_TIANGZ_DBPROXY_TOKEN: this.token,
    }, (line) => this.onProbeLine(line));
    this.probe = { ...probe, mode, epoch: this.epoch, ready: false, done: false, state: undefined };
    this.event("probe_started", { epoch: this.epoch, mode });
    await this.until(() => {
      if (probe.child.exitCode !== null) throw new Error(`probe exited early; see ${probe.log}`);
      return mode === "verify" ? this.probe.done : this.probe.ready;
    }, 180_000, `probe epoch ${this.epoch} ${mode}`);
  }

  /** 返回true表示该行已进入账本，不再写入日志文件。 / Returns true when the line went into the ledger and is not written to the log file. */
  onProbeLine(line) {
    let event;
    try { event = extractProbeEvent(line); } catch { this.fail("probe emitted malformed event", { line: line.slice(0, 300) }); return false; }
    if (!event) return false;
    if (event.t === "fatal") {
      // 主动停止时宿主会取消进行中的操作，这是预期结果。 / A requested stop cancels in-flight host operations; that is expected.
      if (!this.probe?.stopping) this.fail("probe fatal", { error: event.error });
      return false;
    }
    if (event.t === "stat") { this.lastStat = event; return false; }
    if (event.t === "ready") { this.probe.ready = true; this.event("probe_ready", { epoch: event.epoch }); return false; }
    if (event.t === "done") { this.probe.done = true; return false; }
    if (event.t === "state") { this.onProbeState(event); return false; }
    if (event.t === "violation") { applyProbeEvent(this.ledger, event); this.fail("probe violation", event); return false; }
    const problem = applyProbeEvent(this.ledger, event);
    this.recentOps.push(JSON.stringify(event));
    if (this.recentOps.length > RECENT_OP_LIMIT) this.recentOps.splice(0, this.recentOps.length - RECENT_OP_LIMIT);
    if (problem) this.fail("invariant violated", problem);
    return true;
  }

  onProbeState(state) {
    const problems = checkLoadedState(this.ledger, state, state.phase);
    this.event("probe_state_checked", { phase: state.phase, epoch: state.epoch, problems: problems.length });
    writeFileSync(path.join(this.dir, `state-e${state.epoch}-${state.phase}.json`), JSON.stringify(state, null, 2));
    if (problems.length) { this.fail(`${state.phase} recovery read violated invariants`, { problems: problems.slice(0, 20) }); return; }
    if (state.phase === "boot" && state.epoch > 1) {
      const rollbacks = adoptBootState(this.ledger, state);
      if (rollbacks.length) this.rollbacks.push({ epoch: state.epoch, queued: rollbacks });
      this.event("probe_state_adopted", { epoch: state.epoch, queuedRollbacks: rollbacks.length });
    }
    if (this.probe) this.probe.state = state;
  }

  async killProbe() {
    this.probe.stopping = true;
    this.probe.child.kill("SIGKILL");
    await this.probe.done$;
    this.event("probe_killed", { epoch: this.probe.epoch });
  }

  async stopProbe() {
    if (!this.probe || this.probe.child.exitCode !== null) return;
    this.probe.stopping = true;
    await stopRuntime({ child: this.probe.child }, 20_000);
    await this.probe.done$;
  }

  // ---------- 负载与故障 / workload and faults ----------

  async soak() {
    const { schedule } = this.options;
    const deadline = Date.now() + schedule.seconds * 1000;
    this.event("soak_started", { seconds: schedule.seconds, order: schedule.order });
    await this.rounds("initial");
    let cycle = 0;
    for (;;) {
      cycle += 1;
      for (const fault of schedule.order) {
        const covered = schedule.order.every((name) => this.completed.includes(name));
        const needed = (FAULTS[fault].estimateSeconds + schedule.steadySeconds) * 1000;
        if (covered && Date.now() + needed > deadline) {
          this.event("soak_window_closed", { cycles: cycle, completed: this.completed.length });
          assertCoverage(schedule.order, this.completed);
          return;
        }
        await this.wait(schedule.steadySeconds * 1000);
        this.event("fault_started", { fault, cycle });
        await this.inject(fault);
        await this.recover(fault);
        await this.rounds(fault);
        this.completed.push(fault);
        this.event("fault_recovered", { fault, cycle });
        this.checkpoint();
      }
    }
  }

  async inject(fault) {
    switch (fault) {
      case "postgres":
        command("docker", ["stop", "--time", "5", ENVIRONMENT.postgres]);
        await this.wait(65_000);
        command("docker", ["start", ENVIRONMENT.postgres]);
        return;
      case "redis":
      case "cache": {
        const container = fault === "redis" ? ENVIRONMENT.redis : ENVIRONMENT.cache;
        command("docker", ["kill", container]);
        await this.wait(35_000);
        command("docker", ["start", container]);
        return;
      }
      case "aof": {
        // PG停机时排队写仍由AOF确认；此刻的确认值在Redis强杀重启后也必须最终落库。
        // With PG down, queued writes are still acknowledged by AOF; these acks must survive a Redis kill and land later.
        command("docker", ["stop", "--time", "5", ENVIRONMENT.postgres]);
        await this.wait(15_000);
        this.aofAcked = this.ledger.queued.map((entry) => entry.acked);
        this.event("aof_acked_snapshot", { total: this.aofAcked.reduce((sum, value) => sum + value, 0) });
        command("docker", ["kill", ENVIRONMENT.redis]);
        await this.wait(5_000);
        command("docker", ["start", ENVIRONMENT.redis]);
        await this.containersHealthy([ENVIRONMENT.redis]);
        await this.wait(15_000);
        command("docker", ["start", ENVIRONMENT.postgres]);
        return;
      }
      case "dbproxy-primary":
        await this.killDbProxy("dbproxy1");
        await this.wait(20_000);
        await this.startDbProxy("dbproxy1");
        return;
      case "dbproxy-all":
        for (const name of this.dbproxies.keys()) await this.killDbProxy(name);
        await this.wait(20_000);
        for (const name of this.dbproxies.keys()) await this.startDbProxy(name);
        return;
      case "probe-restart":
        await this.killProbe();
        await this.wait(10_000);
        await this.startProbe("run");
        return;
      default:
        throw new Error(`unknown fault ${fault}`);
    }
  }

  async recover(fault) {
    if (FAULTS[fault].needsContainers) await this.containersHealthy();
    await this.dbproxiesReady();
    if (this.probe.child.exitCode !== null) throw new Error("probe exited during recovery");
  }

  /** 每个玩家每种写法再确认两次，证明业务而不只是端口恢复。 / Two more acks per player and mode prove business recovery, not just open ports. */
  async rounds(label) {
    const baseline = ackCounters(this.ledger);
    await this.until(() => roundsSatisfied(this.ledger, baseline, 2), 300_000, `two business rounds after ${label}`);
    this.event("business_rounds_passed", { after: label, acks: { ...this.ledger.acks } });
  }

  checkpoint() {
    writeFileSync(path.join(this.dir, "ledger.json"), JSON.stringify(this.ledger));
    this.report.completedFaults = this.completed;
    this.report.acks = { ...this.ledger.acks };
    this.save();
  }

  // ---------- 收尾与对账 / finish and reconcile ----------

  async finish() {
    await this.stopProbe();
    this.event("workload_stopped", { acks: { ...this.ledger.acks } });
    await this.wait(10_000);
    if (this.run) await this.drainBacklog();
    await this.startProbe("verify");
    const final = this.probe.state;
    await this.stopProbe();
    if (this.aofAcked) {
      const lost = this.aofAcked.flatMap((acked, p) => ((final.queued[p]?.v ?? 0) < acked ? [{ p, acked, final: final.queued[p]?.v ?? 0 }] : []));
      if (lost.length) throw new Error(`AOF-acknowledged queued writes were lost: ${JSON.stringify(lost.slice(0, 10))}`);
      this.event("aof_acks_survived", { players: this.aofAcked.length });
    }
    if (this.run) this.reconcileStorage(final);
    this.assertHealthy();
  }

  async drainBacklog() {
    let quiet = 0;
    await this.until(() => {
      const depth = BACKLOG_KEYS.reduce((sum, key) =>
        sum + Number(redisCli(ENVIRONMENT.redis, ["-n", String(ENVIRONMENT.redisDb), "ZCARD", key]).trim() || 0), 0);
      quiet = depth === 0 ? quiet + 1 : 0;
      return quiet >= 3;
    }, 300_000, "queued backlog drain");
    this.event("backlog_drained");
  }

  reconcileStorage(final) {
    const like = `'${this.runId}/%'`;
    const count = (query) => Number(psql(query).trim());
    const walletOperations = {};
    for (const line of psql(`SELECT split_part(operation_id, ':', 3), count(*) FROM dbproxy_multi_transactions WHERE operation_id LIKE '${this.runId}:w:%' GROUP BY 1;`).trim().split(/\r?\n/).filter(Boolean)) {
      const [p, n] = line.split("|");
      walletOperations[Number(p)] = Number(n);
    }
    const rows = {
      nonWalletTransactionRecords: count(`SELECT count(*) FROM dbproxy_multi_transaction_records WHERE namespace IN ('${NAMESPACES.direct}', '${NAMESPACES.queued}') AND record_key LIKE ${like};`),
      walletIdempotencyRows: count(`SELECT count(*) FROM dbproxy_idempotency WHERE namespace = '${NAMESPACES.wallet}' AND record_key LIKE ${like};`),
      queuedCheckedRows: count(`SELECT count(*) FROM dbproxy_idempotency WHERE namespace = '${NAMESPACES.queued}' AND record_key LIKE ${like} AND expected_revision IS NOT NULL;`),
      directUncheckedRows: count(`SELECT count(*) FROM dbproxy_idempotency WHERE namespace = '${NAMESPACES.direct}' AND record_key LIKE ${like} AND expected_revision IS NULL;`),
      walletOperations,
      walletSeq: final.wallet.map((pair) => (pair ? pair.a.seq : -1)),
    };
    const problems = checkStorageRows(this.ledger, rows);
    // 绕过DBProxy直接读PG，与探针经DBProxy读到的最终状态逐条比对。
    // Read PostgreSQL directly, bypassing DBProxy, and compare with the probe's final state row by row.
    const snapshots = new Map();
    for (const line of psql(`SELECT namespace, record_key, revision, convert_from(payload, 'UTF8') FROM dbproxy_snapshots WHERE record_key LIKE ${like};`).trim().split(/\r?\n/).filter(Boolean)) {
      const [namespace, key, revision, ...payload] = line.split("|");
      snapshots.set(`${namespace}|${key}`, { revision: Number(revision), data: JSON.parse(payload.join("|")) });
    }
    for (let p = 0; p < this.options.players; p++) {
      const direct = snapshots.get(`${NAMESPACES.direct}|${this.runId}/${p}`);
      if ((direct?.data.v ?? 0) !== final.direct[p].v || (direct?.revision ?? 0) !== final.direct[p].rev) problems.push({ what: "sql-direct-mismatch", p });
      if ((snapshots.get(`${NAMESPACES.queued}|${this.runId}/${p}`)?.data.v ?? 0) !== final.queued[p].v) problems.push({ what: "sql-queued-mismatch", p });
      for (const side of ["a", "b"]) {
        const row = snapshots.get(`${NAMESPACES.wallet}|${this.runId}/${p}/${side}`);
        const expected = final.wallet[p]?.[side];
        if (row?.data.seq !== expected?.seq || row?.data.balance !== expected?.balance || row?.revision !== expected?.rev) problems.push({ what: "sql-wallet-mismatch", p, side });
      }
    }
    this.report.storage = { rows: { ...rows, walletOperations: Object.keys(walletOperations).length }, snapshots: snapshots.size, problems };
    this.event("storage_reconciled", { snapshots: snapshots.size, problems: problems.length });
    if (problems.length) throw new Error(`storage reconciliation failed: ${JSON.stringify(problems.slice(0, 20))}`);
  }

  // ---------- 进程管理 / process management ----------

  spawnLogged(name, file, args, cwd, extraEnv, onLine) {
    const log = path.join(this.dir, `${name}.log`);
    const stream = createWriteStream(log, { flags: "a" });
    const child = spawn(file, args, { cwd, windowsHide: true, env: { ...process.env, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
    const record = { name, child, log };
    this.children.add(record);
    for (const source of [child.stdout, child.stderr]) {
      readline.createInterface({ input: source, crlfDelay: Infinity }).on("line", (line) => {
        const consumed = onLine ? onLine(line) : false;
        if (!consumed) stream.write(line + "\n");
      });
    }
    record.done = new Promise((resolve) => child.once("close", (code, signal) => {
      this.children.delete(record);
      stream.end();
      resolve({ code, signal });
    }));
    record.done$ = record.done;
    child.once("error", (error) => this.fail(`${name} failed to start`, { error: String(error) }));
    return record;
  }

  async cleanup() {
    if (this.probe && this.probe.child.exitCode === null) {
      // 失败后的收尾停止同样是主动停止，宿主取消在途操作产生的fatal不是新的失败。
      // Stopping during cleanup is intentional too; the resulting cancellation fatal is not a new failure.
      this.probe.stopping = true;
      await stopRuntime({ child: this.probe.child }, 10_000).catch(() => undefined);
    }
    for (const record of [...this.children]) { record.child.kill("SIGKILL"); await record.done; }
    if (this.run) {
      // 故障中途失败时恢复依赖，避免给下一个演练留下停止的容器。 / Restore dependencies if a fault was interrupted.
      for (const container of [ENVIRONMENT.postgres, ENVIRONMENT.redis, ENVIRONMENT.cache]) {
        try { command("docker", ["start", container]); } catch (error) { this.report.cleanupError = String(error); }
      }
    }
  }
}

/** 内存后端没有AOF等待，冒烟保持快节奏；真实存储按容量余量放慢排队写。 / The memory backend has no AOF wait, so smoke stays fast; durable runs pace queued writes below capacity. */
function queuedStepMs(action) {
  return action === "smoke" ? PROBE_TIMING.stepMs : DURABLE_QUEUED_STEP_MS;
}

/** 专用环境使用PG+可靠Redis+独立缓存；冒烟使用内存后端。 / Dedicated runs use PG + reliable Redis + separate cache; smoke uses the memory backend. */
function dbproxyConfig({ durable, port, observability }) {
  return {
    configVersion: 1,
    server: { listenAddr: `127.0.0.1:${port}`, authTokenEnv: "WMS_DBPROXY_TOKEN", maxFrameBytes: 8388608, maxPayloadBytes: 1048576,
      handshakeTimeoutMs: 5000, shutdownGraceMs: 5000 },
    runtime: { workerThreads: 2 },
    storage: durable ? {
      backend: "postgresRedis", postgresUrlEnv: "WMS_POSTGRES_URL", redisUrlEnv: "WMS_REDIS_URL", cacheRedisUrlEnv: "WMS_CACHE_REDIS_URL", shards: 4,
    } : { backend: "memory", shards: 4 },
    ...(durable ? {
      backlog: { workers: 1, leaseMs: 30000, idleDelayMs: 20, failureDelayMs: 1000 },
      cacheRepair: { workers: 1, leaseMs: 30000, idleDelayMs: 250, baseRetryDelayMs: 1000, maxRetryDelayMs: 60000, maxAttempts: 20 },
    } : {}),
    logging: { filterEnv: "RUST_LOG", defaultFilter: "info" },
    observability: { listenAddr: `127.0.0.1:${observability}` },
  };
}

/** 用DBProxy自带的离线检查校验两种配置；不读密钥、不建立连接。 / Validates both configs with DBProxy's offline check; reads no secrets and opens no connections. */
function checkDbProxyConfigs() {
  const directory = path.join(root, "temp");
  mkdirSync(directory, { recursive: true });
  const results = {};
  for (const durable of [true, false]) {
    const file = path.join(directory, `write-modes-dbproxy-${durable ? "durable" : "memory"}.check.json`);
    writeFileSync(file, JSON.stringify(dbproxyConfig({ durable, port: 17820, observability: 19820 })));
    results[durable ? "durable" : "memory"] = command(ARTIFACTS.dbproxy, ["--check-config", file]).trim();
  }
  return results;
}

function summarizeLedger(ledger) {
  return {
    players: ledger.players,
    acks: ledger.acks,
    maxQueuedRollback: Math.max(0, ...ledger.queued.map((entry) => entry.maxRollback)),
    violations: ledger.violations.slice(0, 50),
    modes: MODES,
  };
}

function command(file, args, options = {}) {
  return execFileSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 * 1024, ...options });
}

function psql(query, database = ENVIRONMENT.database) {
  if (database !== ENVIRONMENT.database && database !== "postgres") throw new Error("database outside the write-mode soak allowlist");
  return command("docker", ["exec", "-i", ENVIRONMENT.postgres, "sh", "-c",
    'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1" -At', "sh", database], { input: query });
}

function redisCli(container, args) {
  if (container !== ENVIRONMENT.redis && container !== ENVIRONMENT.cache) throw new Error("Redis outside the write-mode soak allowlist");
  if (args[0] === "FLUSHDB" || (args.includes("FLUSHDB") && args[args.indexOf("-n") + 1] !== String(ENVIRONMENT.redisDb))) {
    throw new Error("FLUSHDB is only allowed on the write-mode soak Redis DB");
  }
  return command("docker", ["exec", container, "sh", "-c",
    'export REDISCLI_AUTH="$REDIS_PASSWORD"; exec redis-cli --no-auth-warning "$@"', "sh", ...args]);
}

function gitHeads() {
  const head = (directory) => { try { return command("git", ["-C", directory, "rev-parse", "HEAD"]).trim(); } catch { return "unknown"; } };
  const dirty = (directory) => { try { return command("git", ["-C", directory, "status", "--short"]).trim().length > 0; } catch { return undefined; } };
  return Object.fromEntries([["TiangZ", root], ["TiangZ-DBProxy", dbRoot]].map(([name, directory]) => [name, { head: head(directory), dirty: dirty(directory) }]));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase()) {
  main().catch((error) => { console.error(error?.stack ?? error); process.exitCode = 1; });
}

export { parseArguments, describePlan };
