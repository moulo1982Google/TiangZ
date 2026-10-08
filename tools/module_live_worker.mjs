import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { RUNTIME_CONTRACT_RULESET_VERSION } from "@tiangz/developer-tools-core";
import { loadGameProject } from "./game_project_config.mjs";
import { loadGameModuleCatalog } from "./game_module_catalog.mjs";
import { runModuleCompiler } from "./module_typecheck.mjs";
import { ModuleTypeCache } from "./module_type_cache.mjs";

const root = path.resolve(import.meta.dirname, "..");
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_OVERLAY_BYTES = 2 * 1024 * 1024;
const cache = new ModuleTypeCache();
let buffered = Buffer.alloc(0), busy = false, stopped = false;
let project, catalog;
const declarations = new Map();

try {
  if (process.argv.length !== 4 || process.argv[2] !== "--project") throw new Error("Use --project <declared game project>");
  project = await loadGameProject(path.resolve(process.argv[3]));
  if (await realpath(project.engineRoot) !== await realpath(root)) throw new Error("Live checker host differs from the saved project declaration");
  catalog = await loadGameModuleCatalog({ projectRoot: root, modulesDirectory: project.modulesDirectory });
  if (!catalog.modules.length || catalog.modules.length > 16) throw new Error("Live checking requires 1..16 modules; use the host CLI for larger projects");
  await remember(project.file);
  for (const module of catalog.modules) {
    await remember(path.join(module.root, "tiangz.module.json"));
    const config = path.join(module.root, "tsconfig.json");
    const details = await lstat(config);
    if (!details.isFile() || details.isSymbolicLink() || !within(module.realRoot, await realpath(config))) throw new Error(`Invalid module tsconfig: ${module.id}`);
    await remember(config);
  }
  send({ event: "ready", formatVersion: 1, engineRoot: root, projectRoot: project.root, typescriptVersion: ts.version,
    ruleSetVersion: RUNTIME_CONTRACT_RULESET_VERSION, modules: catalog.modules.map(module => module.id),
    declarationFiles: [project.file, ...catalog.modules.flatMap(module => ["tiangz.module.json", "tsconfig.json"]
      .flatMap(file => [path.join(module.root, file), path.join(module.installedRoot, file)]))],
    sourceRoots: catalog.modules.flatMap(module => [...module.entries.modelRoots, ...module.entries.hotfixRoots]
      .flatMap(directory => [directory, path.join(module.installedRoot, path.relative(module.root, directory))])) });
  process.stdin.on("data", consume);
  process.stdin.once("end", stop);
  process.stdin.once("error", fail);
  process.stdout.once("error", stop);
  process.once("SIGTERM", stop);
} catch (error) { fail(error); }

/** 读取有界 JSON 行；单个请求在途，防止消息积压。 / Read bounded JSON lines with exactly one in-flight request. */
function consume(chunk) {
  if (stopped) return;
  buffered = Buffer.concat([buffered, chunk]);
  if (buffered.length > MAX_FRAME_BYTES) { fail(new Error("Live checker input frame exceeds 16 MiB")); return; }
  for (let newline; !stopped && (newline = buffered.indexOf(10)) >= 0;) {
    const line = buffered.subarray(0, newline);
    buffered = buffered.subarray(newline + 1);
    let request;
    try {
      request = JSON.parse(line.toString("utf8"));
      if (!request || request.formatVersion !== 1 || !Number.isSafeInteger(request.id) || request.id <= 0) throw new Error("Invalid live checker request identity");
      if (request.method === "shutdown") { stop(); return; }
      if (request.method !== "analyze" || busy || !Array.isArray(request.overlays) || request.overlays.length > 256) throw new Error("Live checker requires one analyze request at a time and at most 256 overlays");
      busy = true;
      void analyze(request).catch(fail).finally(() => { busy = false; });
    } catch (error) { fail(error); }
  }
}

/** 复用 CLI 的检查顺序和诊断，仅将已知源码替换为内存文本。 / Reuse CLI diagnostic ordering with overlays restricted to known module sources. */
async function analyze(request) {
  try {
    for (const [file, original] of declarations) {
      if (!original.equals(await readFile(file))) throw new Error("Project declaration changed; reload the live checker from saved files");
    }
    const overlays = [], seen = new Set();
    for (const overlay of request.overlays) {
      if (!overlay || typeof overlay.file !== "string" || !path.isAbsolute(overlay.file) || !overlay.file.endsWith(".ts") || typeof overlay.text !== "string"
        || Buffer.byteLength(overlay.text, "utf8") > MAX_OVERLAY_BYTES) throw new Error("Invalid or oversized TypeScript overlay");
      const file = await realpath(overlay.file);
      const owner = catalog.moduleForFile(file);
      if (!owner || ![...owner.entries.modelRoots, ...owner.entries.hotfixRoots].some(directory => within(directory, file))) throw new Error("Overlay is outside the selected module source roots");
      const key = cache.key(file);
      if (seen.has(key)) throw new Error("Duplicate TypeScript overlay");
      seen.add(key);
      overlays.push({ file, text: overlay.text });
      // 当前 Program 也可能以安装联接的路径读取同一源码。
      // The Program may read the same source through its installed module link.
      const installed = path.join(owner.installedRoot, path.relative(owner.root, file));
      if (cache.key(installed) !== key) overlays.push({ file: installed, text: overlay.text });
    }
    if (stopped) return;
    cache.setOverlays(overlays);
    const contractWarnings = [];
    for (const module of catalog.modules) {
      runModuleCompiler({ project: path.join(module.root, "tsconfig.json"), moduleId: module.id, root, catalog, modulesOnly: project.hostProfile === "modules", json: true, contractWarnings,
        createProgram: options => cache.createProgram(module.id, options) });
    }
    result(request.id, "checked", contractWarnings);
  } catch (error) {
    if (error.diagnostics) result(request.id, "checked", error.diagnostics);
    else {
      cache.dispose();
      result(request.id, "unavailable", [{ code: "tiangz.module.live-unavailable", message: error.message, file: project.file, line: 1, column: 1 }]);
    }
  }
}

function result(id, status, diagnostics) {
  if (stopped) return;
  send({ formatVersion: 1, id, status, typescriptVersion: ts.version, ruleSetVersion: RUNTIME_CONTRACT_RULESET_VERSION,
    diagnostics: diagnostics.map(item => ({ ...item, severity: item.severity ?? "error" })), cache: cache.stats });
}

function send(value) {
  const line = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) throw new Error("Live checker diagnostic frame exceeds 16 MiB");
  process.stdout.write(line);
}

function stop() {
  stopped = true;
  cache.dispose();
  buffered = Buffer.alloc(0);
  process.stdin.destroy();
}

function fail(error) {
  if (stopped) return;
  try { send({ event: "fatal", formatVersion: 1, message: error instanceof Error ? error.message : String(error) }); }
  finally { process.exitCode = 1; stop(); }
}

async function remember(file) { declarations.set(file, await readFile(file)); }
function within(directory, file) {
  const relative = path.relative(directory, file);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
