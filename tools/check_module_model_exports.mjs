import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTestStep } from "./test_step_runner.mjs";
import { resolveHostProfile } from "./host_profile.mjs";

const root = path.resolve(import.meta.dirname, "..");

/** 在一个受期限约束的子进程检查真实登记，结束后只清理本次临时目录。 / Check real registration in one bounded child and clean only its temporary directory. */
export async function checkModuleModelExports({ modulesDirectory = path.join(root, "modules"), hostProfile = "modules",
  timeoutMs = 30_000, maxOutputBytes = 4 * 1024 * 1024, signal } = {}) {
  if (hostProfile !== "modules") throw new Error("Model export checks require the modules host profile");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Model export check timeout must be a positive integer");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "tiangz-model-exports-"));
  const resultFile = path.join(temporary, "result.json");
  let preserveTemporary = false;
  try {
    const step = await runTestStep({ name: "module Model exports", command: process.execPath,
      args: [path.join(root, "tools/module_model_export_probe.mjs"), temporary, path.resolve(modulesDirectory)], timeoutMs },
    { cwd: root, captureOutput: true, maxOutputBytes, signal });
    preserveTemporary = step.cleanupFailed;
    let result, oversizedResult = false;
    try {
      oversizedResult = (await stat(resultFile)).size > maxOutputBytes;
      if (!oversizedResult) result = JSON.parse(await readFile(resultFile, "utf8"));
    } catch { /* A crashed or interrupted probe has no result. */ }
    if (!result || result.formatVersion !== 1 || !Array.isArray(result.diagnostics) || !Array.isArray(result.modules)) {
      result = { formatVersion: 1, ok: false, status: "failed", modules: [], nativeExecutionVerified: false,
        diagnostics: [{ code: "tiangz.model.probe-failed", message: "Model export probe did not return a complete result" }] };
    }
    if (step.status !== "passed" || step.outputTruncated || oversizedResult || step.cleanupFailed || !result.ok) {
      result.ok = false;
      if (step.status === "timed-out" || step.status === "aborted") result.status = step.status;
      else if (result.status === "passed" || step.cleanupFailed || step.outputTruncated || oversizedResult) result.status = "failed";
      if (step.error || step.outputTruncated || oversizedResult) result.diagnostics.push({ code: "tiangz.model.probe-incomplete",
        message: step.error ?? "Model export probe exceeded its output limit" });
    }
    return { ...result, hostProfile, engineRoot: root, modulesDirectory: path.resolve(modulesDirectory),
      exitCode: result.ok ? 0 : step.exitCode || 1, cleanupFailed: step.cleanupFailed, outputTruncated: step.outputTruncated || oversizedResult,
      ...(preserveTemporary ? { retainedDirectory: temporary } : {}),
      ...(step.output ? { output: step.output } : {}) };
  } finally {
    if (!preserveTemporary) await rm(temporary, { recursive: true, force: true });
  }
}

/** CLI 只检查受信任项目；不会更新生成物或启动 Scene/数据库。 / Check trusted projects without updating outputs or starting scenes or databases. */
async function main() {
  const json = process.argv.includes("--json");
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, abort);
  try {
    const result = await checkModuleModelExports({ modulesDirectory: argumentValue("--modules-dir") ?? process.env.TIANGZ_MODULES_DIR,
      hostProfile: resolveHostProfile(), timeoutMs: Number(argumentValue("--timeout-ms") ?? 30_000), signal: controller.signal });
    if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else if (result.ok) process.stdout.write(`[check:model-exports] checked ${result.modules.length} modules; Native execution and service startup not verified\n`);
    else {
      for (const diagnostic of result.diagnostics) process.stderr.write(`[${diagnostic.code}] ${diagnostic.message}\n`);
      if (result.output) process.stderr.write(result.output);
    }
    process.exitCode = result.exitCode;
  } catch (error) {
    const result = { formatVersion: 1, ok: false, status: "unavailable", nativeExecutionVerified: false,
      diagnostics: [{ code: "tiangz.model.check-unavailable", message: error.message }] };
    (json ? process.stdout : process.stderr).write(`${json ? JSON.stringify(result) : error.message}\n`);
    process.exitCode = 1;
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signal, abort);
  }
}

function argumentValue(name) {
  const inline = process.argv.find(value => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
