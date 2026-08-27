import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const options = parseOptions(process.argv.slice(2));
const sourceDir = path.resolve(root, options.source);
const outputDir = path.resolve(root, options.output);
if (sourceDir === outputDir) throw new Error("chaos config output must differ from its source");
mkdirSync(outputDir, { recursive: true });

for (const name of readdirSync(sourceDir).filter((entry) => entry.endsWith(".json"))) {
  const sourcePath = path.join(sourceDir, name);
  const config = JSON.parse(readFileSync(sourcePath, "utf8"));
  if (config.process) tuneProcess(config.process, name);
  if (Array.isArray(config.scenes)) {
    for (const scene of config.scenes) tuneClientAddress(scene);
  }
  if (Array.isArray(config.knownScenes)) {
    for (const scene of config.knownScenes) tuneClientAddress(scene);
  }
  if (Array.isArray(config.machines)) {
    for (const machine of config.machines) machine.name = "external-chaos-4c8g";
  }
  writeFileSync(path.join(outputDir, name), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

console.log(`[chaos-config] source=${sourceDir}`);
console.log(`[chaos-config] output=${outputDir}`);
console.log(`[chaos-config] runtime logs=${options.logDirectory}`);

function tuneProcess(processConfig, fileName) {
  processConfig.lifecycle ??= {};
  const backoffMs = fileName === "dungeon-1.json" ? 25_000
    : fileName === "manager.json" ? 3_000
      : 5_000;
  processConfig.lifecycle.restart = {
    maxAttempts: 5,
    windowMs: 600_000,
    backoffMs,
  };
  processConfig.logging = {
    ...(processConfig.logging ?? {}),
    level: "info",
    filter: "info,tiangz::metrics=warn",
    format: "json",
    console: false,
    file: {
      enabled: true,
      directory: options.logDirectory,
      rotation: "daily",
    },
  };
  if (processConfig.observability?.latency) {
    processConfig.observability.latency.enabled = true;
    processConfig.observability.latency.sampleRate = 100;
  }
  if (processConfig.observability?.tracing) {
    processConfig.observability.tracing.enabled = true;
    processConfig.observability.tracing.sampleRate = 100;
  }
}

function tuneClientAddress(scene) {
  if (!["LoginMgr", "Login", "Gate"].includes(scene.sceneType)) return;
  scene.outerIp = "127.0.0.1";
  scene.outerPort = scene.port;
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
  return {
    source: values.get("--source") ?? "configs/deploy/external-multiprocess",
    output: values.get("--output") ?? "dist/external-chaos-configs",
    logDirectory: values.get("--log-directory") ?? "/var/log/tiangz-chaos/runtime",
  };
}
