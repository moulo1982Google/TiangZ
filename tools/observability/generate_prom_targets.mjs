#!/usr/bin/env node
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const root = process.cwd();
const startupPath = path.resolve(root, args.get("--startup") ?? "configs/local/cluster/StartMachine.json");
const outputPath = path.resolve(
  root,
  args.get("--output") ?? "tools/observability/prometheus/targets.yml",
);
const environment = args.get("--env") ?? "local";
const localHost = args.get("--local-host") ?? "host.docker.internal";

const targets = loadTargets(startupPath)
  .map((target) => ({
    ...target,
    host: isLoopback(target.host) || isUnspecified(target.host) ? localHost : target.host,
  }))
  .sort((left, right) =>
    left.machine.localeCompare(right.machine) ||
    left.process.localeCompare(right.process) ||
    left.port - right.port
  );

const seen = new Set();
for (const target of targets) {
  const address = `${target.host}:${target.port}`;
  if (seen.has(address)) {
    throw new Error(`duplicate Prometheus target ${address} from startup ${startupPath}`);
  }
  seen.add(address);
}

if (targets.length === 0) throw new Error(`startup ${startupPath} contains no Prometheus targets`);

const body = targets.flatMap((target) => [
  `- targets: [${yamlString(`${target.host}:${target.port}`)}]`,
  "  labels:",
  `    env: ${yamlString(environment)}`,
  `    machine: ${yamlString(target.machine)}`,
  `    process: ${yamlString(target.process)}`,
]).join("\n");

const output = `${body}\n`;
validateGeneratedTargets(output, targets.length);
writeAtomic(outputPath, output);
console.log(
  `[prometheus] wrote ${targets.length} active target(s) from ${path.relative(root, startupPath)} to ${path.relative(root, outputPath)}`,
);
for (const target of targets) {
  console.log(`${target.machine}/${target.process} -> ${target.host}:${target.port}`);
}

/** 只接受显式的键值参数，避免拼错参数后静默生成错误目标。 / Accepts explicit key-value arguments so typos cannot silently generate wrong targets. */
function parseArgs(values) {
  const allowed = new Set(["--startup", "--output", "--env", "--local-host"]);
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid argument near: ${values.slice(index).join(" ")}`);
    }
    if (!allowed.has(key)) throw new Error(`unknown argument: ${key}`);
    parsed.set(key, value);
  }
  return parsed;
}

/** 从单进程配置或 StartMachine 中提取实际部署端点。 / Extracts deployed endpoints from one process config or StartMachine. */
function loadTargets(startup) {
  const startupJson = readJson(startup);
  if (Array.isArray(startupJson.machines)) {
    const startDirectory = path.dirname(startup);
    return startupJson.machines.flatMap((machine) => {
      if (!Array.isArray(machine.processes)) {
        throw new Error(`machine ${machine.name ?? machine.innerIp ?? "<unknown>"} has no processes array`);
      }
      const machineName = requireString(machine.name ?? machine.innerIp, "machine name");
      const machineHost = requireString(machine.innerIp, `machine ${machineName} innerIp`);
      return machine.processes.map((processFile) => {
        const processPath = path.isAbsolute(processFile)
          ? processFile
          : path.resolve(startDirectory, processFile);
        return targetFromProcessConfig(processPath, machineName, machineHost);
      });
    });
  }
  return [targetFromProcessConfig(startup, "local", undefined)];
}

function targetFromProcessConfig(configPath, machine, advertisedHost) {
  const config = readJson(configPath);
  const processName = requireString(config.process?.name, `${configPath} process.name`);
  const health = config.process?.observability?.health;
  if (!health || !Number.isInteger(health.port) || health.port <= 0 || health.port > 65535) {
    throw new Error(`${configPath} must configure process.observability.health.port`);
  }
  const bindHost = requireString(health.ip, `${configPath} health.ip`);
  if (advertisedHost && !isLoopback(advertisedHost) && isLoopback(bindHost)) {
    throw new Error(
      `${configPath} binds health.ip=${bindHost}, but machine ${machine} is advertised as ${advertisedHost}; bind 0.0.0.0 or the machine management IP`,
    );
  }
  return {
    machine,
    process: processName,
    host: advertisedHost ?? bindHost,
    port: health.port,
  };
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read ${file}: ${message}`);
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function isLoopback(host) {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

function isUnspecified(host) {
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

/** 在替换正式文件前检查条目数量与基本结构。 / Checks entry count and shape before replacing the active file. */
function validateGeneratedTargets(body, expectedCount) {
  const targetLines = body.match(/^- targets: \["[^"\r\n]+"\]$/gm) ?? [];
  const processLabels = body.match(/^    process: "[^"\r\n]+"$/gm) ?? [];
  if (targetLines.length !== expectedCount || processLabels.length !== expectedCount) {
    throw new Error(`generated targets failed validation: expected ${expectedCount} entries`);
  }
}

/** 先完整写入同目录临时文件，再原子替换，避免 Prometheus 读取半截 YAML。 / Writes a complete sibling temp file before atomically replacing the target. */
function writeAtomic(file, body) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, body, "utf8");
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function yamlString(value) {
  return JSON.stringify(value);
}
