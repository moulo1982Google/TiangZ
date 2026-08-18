import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const defaultStartup = path.join(root, "configs", "local", "cluster", "StartMachine.json");
const auditDirectory = path.join(root, "temp", "hotfix-operations");
const contractFields = [
  "modelFingerprint",
  "modelSourceHash",
  "protocolFingerprint",
  "stableCoreApiHash",
  "nativeSchemaHash",
  "gameConfigSchemaFingerprint",
  "buildMode",
];

const command = process.argv[2];
const options = parseArgs(process.argv.slice(3));
const operationId = options.operationId ?? `hotfix-${Date.now()}-${randomUUID().slice(0, 8)}`;
let audit;

try {
  if (!new Set(["plan", "apply", "status", "rollback"]).has(command)) usage();
  const targets = await loadTargets(options.startup ?? defaultStartup, options);
  let result;
  if (command === "status") result = await statusTargets(targets);
  else if (command === "rollback") result = await rollbackTargets(targets, operationId);
  else {
    if (!options.candidate) throw new Error(`${command} requires --candidate <directory>`);
    const candidate = await inspectCandidate(options.candidate);
    const statuses = await statusTargets(targets);
    const plan = {
      command: "plan",
      operationId,
      candidate,
      targets: statuses.targets.map((target) => ({
        ...target,
        action: target.hotfix.bundleVersion === candidate.bundleVersion
          ? "skip"
          : contractsEqual(target.hotfix.modelContract, candidate.modelContract) ? "apply" : "incompatible",
      })),
    };
    result = command === "plan" ? plan : await applyPlan(targets, plan, operationId);
  }
  audit = { ok: true, command, operationId, result };
  await writeAudit(audit);
  printResult(result, options.json);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  audit = { ok: false, command, operationId, error: message };
  await writeAudit(audit).catch(() => {});
  if (options.json) process.stdout.write(`${JSON.stringify(audit)}\n`);
  else process.stderr.write(`[hotfix] ${message}\n`);
  process.exitCode = 1;
}

/** 读取部署清单并只保留本机可达、显式启用正式Hotfix入口的Process。 / Reads deployment targets and retains only locally reachable Processes with formal Hotfix operations enabled. */
async function loadTargets(startupValue, options) {
  const startup = path.resolve(root, startupValue);
  const document = await readJson(startup);
  const selectedProcesses = new Set(options.targets);
  const selectedMachine = options.machine;
  const entries = [];
  if (Array.isArray(document.machines)) {
    for (const machine of document.machines) {
      const machineName = requireString(machine.name ?? machine.innerIp, "machine name");
      if (selectedMachine && machineName !== selectedMachine) continue;
      for (const processFile of machine.processes ?? []) {
        const configPath = path.isAbsolute(processFile)
          ? processFile
          : path.resolve(path.dirname(startup), processFile);
        entries.push({ configPath, machine: machineName });
      }
    }
  } else {
    entries.push({ configPath: startup, machine: "local" });
  }
  const targets = [];
  for (const entry of entries) {
    const config = await readJson(entry.configPath);
    const processName = requireString(config.process?.name, `${entry.configPath} process.name`);
    if (selectedProcesses.size > 0 && !selectedProcesses.has(processName)) continue;
    const health = config.process?.observability?.health;
    const operations = config.process?.lifecycle?.hotfixOperations;
    if (!health || !Number.isInteger(health.port) || health.port <= 0) {
      throw new Error(`${processName} must configure process.observability.health.port`);
    }
    if (!operations) {
      throw new Error(`${processName} has not enabled process.lifecycle.hotfixOperations`);
    }
    const host = localHealthHost(requireString(health.ip, `${processName} health.ip`));
    const tokenEnv = requireString(
      operations.authTokenEnv ?? "TIANGZ_HOTFIX_ADMIN_TOKEN",
      `${processName} hotfixOperations.authTokenEnv`,
    );
    const token = process.env[tokenEnv];
    if (!token) throw new Error(`${processName} requires non-empty environment variable ${tokenEnv}`);
    targets.push({
      machine: entry.machine,
      process: processName,
      configPath: entry.configPath,
      endpoint: `http://${host}:${health.port}`,
      token,
    });
  }
  if (targets.length === 0) throw new Error("no Hotfix operation targets matched");
  if (selectedProcesses.size > 0) {
    const found = new Set(targets.map((target) => target.process));
    const missing = [...selectedProcesses].filter((name) => !found.has(name));
    if (missing.length > 0) throw new Error(`Hotfix targets not found: ${missing.join(", ")}`);
  }
  return targets;
}

async function inspectCandidate(candidateValue) {
  const directory = await realpath(path.resolve(root, candidateValue));
  const hotfix = await readFile(path.join(directory, "hotfix.js"));
  const manifest = await readJson(path.join(directory, "hotfix.manifest.json"));
  const model = await readJson(path.join(root, "dist", "model.manifest.json"));
  if (manifest.formatVersion !== 1) throw new Error(`unsupported Hotfix manifest format ${manifest.formatVersion}`);
  const actualHash = createHash("sha256").update(hotfix).digest("hex");
  if (manifest.hotfixHash !== actualHash) throw new Error("candidate hotfix.js hash does not match its manifest");
  for (const field of contractFields) {
    if (manifest[field] !== model[field]) {
      throw new Error(`candidate ${field}=${manifest[field]} does not match active Model contract ${model[field]}`);
    }
  }
  return {
    directory,
    bundleVersion: requireString(manifest.bundleVersion, "candidate bundleVersion"),
    hotfixHash: actualHash,
    buildMode: manifest.buildMode,
    modelContract: Object.fromEntries(contractFields.map((field) => [field, manifest[field]])),
  };
}

async function statusTargets(targets) {
  const results = await Promise.all(targets.map(async (target) => {
    const response = await request(target, "/admin/hotfix/status", "GET");
    return {
      machine: target.machine,
      process: target.process,
      endpoint: target.endpoint,
      hotfix: response.hotfix,
    };
  }));
  return { command: "status", targets: results };
}

async function applyPlan(targets, plan, operationId) {
  const incompatible = plan.targets.filter((target) => target.action === "incompatible");
  if (incompatible.length > 0) {
    throw new Error(`candidate is incompatible with target Model contract: ${incompatible.map((target) => target.process).join(", ")}`);
  }
  const actions = plan.targets.filter((target) => target.action === "apply");
  const targetByName = new Map(targets.map((target) => [target.process, target]));
  const settled = await Promise.allSettled(actions.map(async (action) => {
    const target = targetByName.get(action.process);
    return request(target, "/admin/hotfix/apply", "POST", {
      operationId,
      candidateDirectory: plan.candidate.directory,
    });
  }));
  const applied = [];
  const failures = [];
  settled.forEach((item, index) => {
    if (item.status === "fulfilled") applied.push(item.value);
    else failures.push({ process: actions[index].process, error: item.reason?.message ?? String(item.reason) });
  });
  if (failures.length > 0) {
    const compensationId = `${operationId}-compensate`;
    const appliedProcesses = new Set(applied.map((item) => item.process));
    const reconciliation = await Promise.allSettled(actions.map(async (action) => ({
      process: action.process,
      status: await request(targetByName.get(action.process), "/admin/hotfix/status", "GET"),
    })));
    const uncertain = [];
    reconciliation.forEach((item, index) => {
      if (item.status === "fulfilled") {
        if (item.value.status.hotfix.bundleVersion === plan.candidate.bundleVersion) {
          appliedProcesses.add(item.value.process);
        }
      } else {
        uncertain.push({ process: actions[index].process, error: item.reason?.message ?? String(item.reason) });
      }
    });
    const compensationTargets = [...appliedProcesses];
    const compensation = await Promise.allSettled(compensationTargets.map((processName) =>
      request(targetByName.get(processName), "/admin/hotfix/rollback", "POST", {
        operationId: compensationId,
      })
    ));
    const rollback = compensation.map((item, index) => item.status === "fulfilled"
      ? { process: compensationTargets[index], status: "rolled-back" }
      : { process: compensationTargets[index], status: "failed", error: item.reason?.message ?? String(item.reason) });
    throw new Error(`Hotfix apply failed: ${JSON.stringify({ failures, compensation: rollback, uncertain })}`);
  }
  return {
    command: "apply",
    operationId,
    candidate: plan.candidate,
    skipped: plan.targets.filter((target) => target.action === "skip").map((target) => target.process),
    applied,
  };
}

function contractsEqual(left, right) {
  return contractFields.every((field) => left?.[field] === right?.[field]);
}

async function rollbackTargets(targets, operationId) {
  const results = await Promise.all(targets.map((target) =>
    request(target, "/admin/hotfix/rollback", "POST", { operationId })
  ));
  return { command: "rollback", operationId, targets: results };
}

async function request(target, route, method, body) {
  const response = await fetch(`${target.endpoint}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${target.token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(130_000),
  });
  const text = await response.text();
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error(`${target.process} returned HTTP ${response.status} with invalid JSON`);
  }
  if (!response.ok) {
    throw new Error(`${target.process} returned HTTP ${response.status}: ${document.error ?? document.status}`);
  }
  return document;
}

function parseArgs(values) {
  const parsed = { targets: [], json: false };
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (key === "--json") parsed.json = true;
    else if (key === "--target") parsed.targets.push(requireArgument(values, ++index, key));
    else if (key === "--startup") parsed.startup = requireArgument(values, ++index, key);
    else if (key === "--candidate") parsed.candidate = requireArgument(values, ++index, key);
    else if (key === "--machine") parsed.machine = requireArgument(values, ++index, key);
    else if (key === "--operation-id") parsed.operationId = requireArgument(values, ++index, key);
    else throw new Error(`unknown argument: ${key}`);
  }
  return parsed;
}

function requireArgument(values, index, key) {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
  return value;
}

function localHealthHost(host) {
  if (["0.0.0.0", "::", "localhost"].includes(host)) return "127.0.0.1";
  if (host === "127.0.0.1" || host === "::1" || host.startsWith("127.")) return host;
  throw new Error(`Hotfix operations are local-only; health.ip=${host} is not loopback or wildcard`);
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`failed to read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

async function writeAudit(entry) {
  await mkdir(auditDirectory, { recursive: true });
  await appendFile(
    path.join(auditDirectory, "audit.jsonl"),
    `${JSON.stringify({ timestamp: new Date().toISOString(), ...sanitizeAudit(entry) })}\n`,
    "utf8",
  );
}

function sanitizeAudit(value) {
  if (Array.isArray(value)) return value.map(sanitizeAudit);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "token")
    .map(([key, item]) => [key, sanitizeAudit(item)]));
}

function printResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (result.command === "status" || result.command === "plan") {
    for (const target of result.targets) {
      process.stdout.write(
        `[hotfix] ${target.process}: generation=${target.hotfix.generation} bundle=${target.hotfix.bundleVersion}`
        + `${target.action ? ` action=${target.action}` : ""}\n`,
      );
    }
    if (result.candidate) process.stdout.write(`[hotfix] candidate=${result.candidate.bundleVersion} ${result.candidate.directory}\n`);
  } else {
    process.stdout.write(`[hotfix] ${result.command} completed operationId=${result.operationId}\n`);
  }
}

function usage() {
  throw new Error(
    "usage: npm run hotfix -- <plan|apply|status|rollback> --startup <config> [--candidate <directory>] [--target <process>] [--machine <name>]",
  );
}
