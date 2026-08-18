import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const executable = path.join(root, "target", "debug", process.platform === "win32" ? "TiangZ.exe" : "TiangZ");
const candidate = path.join(root, "dist", "hotfix-candidates", "operations-inverted");
const temporary = await mkdtemp(path.join(os.tmpdir(), "tiangz-hotfix-operations-"));
const healthPort = await unusedPort();
const businessPort = await unusedPort(new Set([healthPort]));
const inspectorPort = await unusedPort(new Set([healthPort, businessPort]));
const tokenEnv = "TIANGZ_HOTFIX_OPERATIONS_TEST_TOKEN";
const token = `test-${Date.now()}`;
const configPath = path.join(temporary, "hotfix-operations.json");

await writeFile(configPath, `${JSON.stringify({
  process: {
    name: "hotfix.operations.test",
    lifecycle: {
      hotfixReloadTimeoutMs: 15_000,
      hotfixOperations: { authTokenEnv: tokenEnv },
    },
    debug: {
      inspectorIp: "127.0.0.1",
      inspectorPort,
      breakOnStart: false,
    },
    observability: {
      health: { ip: "127.0.0.1", port: healthPort },
    },
  },
  scenes: [{
    name: "hotfix_operations_bench",
    sceneType: "MapHost",
    ip: "127.0.0.1",
    port: businessPort,
  }],
}, null, 2)}\n`, "utf8");

const runtime = spawn(executable, [configPath], {
  cwd: root,
  env: { ...process.env, [tokenEnv]: token, TIANGZ_WATCHER_CONTROL: "stdin" },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
let runtimeOutput = "";
runtime.stdout.setEncoding("utf8").on("data", (chunk) => { runtimeOutput += chunk; });
runtime.stderr.setEncoding("utf8").on("data", (chunk) => { runtimeOutput += chunk; });

async function runTest() {
try {
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${healthPort}/ready`)).ok;
    } catch {
      return false;
    }
  }, 20_000, "runtime did not become ready");

  const inspector = await InspectorClient.connect(inspectorPort);
  await inspector.command("Debugger.enable");

  const initial = await cli("status");
  const initialHotfix = initial.targets[0].hotfix;
  if (initialHotfix.generation !== 1) throw new Error(`unexpected initial generation ${initialHotfix.generation}`);

  const plan = await cli("plan", ["--candidate", candidate]);
  if (plan.targets[0].action !== "apply") throw new Error("candidate unexpectedly planned as a no-op");

  const applied = await cli("apply", ["--candidate", candidate, "--operation-id", "operations-test-apply"]);
  if (applied.applied[0].report.generation !== 2) throw new Error("apply did not commit generation 2");
  await inspector.waitFor((event) =>
    event.method === "Debugger.scriptParsed"
      && event.params?.url?.replaceAll("\\", "/").endsWith("/operations-inverted/hotfix.js")
      && event.params?.sourceMapURL?.startsWith("data:application/json;base64,"),
  10_000, "reloaded Hotfix script did not publish an inline sourcemap");

  const afterApply = await cli("status");
  if (afterApply.targets[0].hotfix.bundleVersion !== plan.candidate.bundleVersion) {
    throw new Error("status did not expose the applied bundle version");
  }
  if (!afterApply.targets[0].hotfix.previousCandidateDirectory) {
    throw new Error("status did not retain the rollback candidate");
  }

  const rolledBack = await cli("rollback", ["--operation-id", "operations-test-rollback"]);
  if (rolledBack.targets[0].report.generation !== 3) throw new Error("rollback did not commit generation 3");
  const afterRollback = await cli("status");
  if (afterRollback.targets[0].hotfix.bundleVersion !== initialHotfix.bundleVersion) {
    throw new Error("rollback did not restore the initial bundle");
  }

  const corrupted = path.join(temporary, "corrupted");
  await cp(candidate, corrupted, { recursive: true });
  await writeFile(path.join(corrupted, "hotfix.js"), `${await readFile(path.join(corrupted, "hotfix.js"), "utf8")}\n// corrupt\n`, "utf8");
  const rejected = await cliResult("plan", ["--candidate", corrupted]);
  if (rejected.code === 0 || !rejected.output.includes("hash does not match")) {
    throw new Error("corrupted candidate passed formal plan validation");
  }
  const unauthorized = await cliResult("status", [], "wrong-token");
  if (unauthorized.code === 0 || !unauthorized.output.includes("HTTP 401")) {
    throw new Error("invalid Hotfix operations token was accepted");
  }

  inspector.close();
  runtime.stdin.end("shutdown\n");
  const exitCode = await waitForExit(runtime, 30_000);
  if (exitCode !== 0) throw new Error(`runtime exited with ${exitCode}\n${runtimeOutput}`);
  process.stdout.write("formal Hotfix operations and Inspector reload self-test passed\n");
} finally {
  if (runtime.exitCode === null && runtime.signalCode === null) runtime.kill();
  await rm(temporary, { recursive: true, force: true });
}
}

async function cli(command, extra = []) {
  const result = await cliResult(command, extra);
  if (result.code !== 0) throw new Error(`Hotfix CLI failed: ${result.output}\n${runtimeOutput}`);
  return JSON.parse(result.output.trim().split(/\r?\n/).at(-1));
}

function cliResult(command, extra = [], tokenOverride = token) {
  return run(process.execPath, [
    "tools/hotfix_operations.mjs",
    command,
    "--startup", configPath,
    "--json",
    ...extra,
  ], { ...process.env, [tokenEnv]: tokenOverride });
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code: code ?? 1, output }));
  });
}

class InspectorClient {
  static async connect(port) {
    const targets = await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        const values = await response.json();
        return values[0];
      } catch {
        return undefined;
      }
    }, 15_000, "Inspector target did not appear", true);
    const socket = new WebSocket(targets.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new InspectorClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
    socket.addEventListener("message", ({ data }) => this.onMessage(JSON.parse(String(data))));
  }

  command(method) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  waitFor(predicate, timeoutMs, message) {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.resolve !== resolve);
        reject(new Error(message));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve: (value) => { clearTimeout(timer); resolve(value); } });
    });
  }

  onMessage(message) {
    if (message.id) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error.message));
      else pending?.resolve(message.result);
      return;
    }
    this.events.push(message);
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(message)) {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        waiter.resolve(message);
      }
    }
  }

  close() {
    this.socket.close();
  }
}

async function unusedPort(excluded = new Set()) {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const value = server.address().port;
        server.close(() => resolve(value));
      });
    });
    if (!excluded.has(port)) return port;
  }
}

async function waitFor(predicate, timeoutMs, message, returnValue = false) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return returnValue ? value : undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${message}\n${runtimeOutput}`);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`runtime did not exit\n${runtimeOutput}`)), timeoutMs);
    child.once("exit", (code) => { clearTimeout(timer); resolve(code ?? 1); });
  });
}

await runTest();
