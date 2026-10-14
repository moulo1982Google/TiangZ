import path from "node:path";
import { runTestStep } from "./test_step_runner.mjs";

/** CLI 检查复用既有进程树所有者，JSON 模式捕获有界诊断而不污染协议。 / Reuse bounded process ownership; capture diagnostics in JSON mode. */
export function gameProjectCheckTool(engine, { env = process.env, signal, quiet = false, timeoutMs = 300_000, maxOutputBytes = 4 * 1024 * 1024 } = {}) {
  return async (name, ...args) => {
    const model = name === "check_module_model_exports.mjs";
    const identity = name === "game_project_check_identity_probe.mjs";
    const commandArgs = [path.join(engine, "tools", name), ...args, ...(model ? ["--json"] : [])];
    const outcome = await runTestStep({ name, command: process.execPath,
      args: commandArgs, timeoutMs: name === "build_module_native.mjs" ? 1_200_000 : identity ? Math.min(timeoutMs, 60_000) : timeoutMs },
    { cwd: engine, env, signal, captureOutput: true, maxOutputBytes });
    if (model && !outcome.outputTruncated && !outcome.cleanupFailed && !["timed-out", "aborted"].includes(outcome.status)) {
      try {
        const probe = JSON.parse(outcome.output);
        if (probe.formatVersion !== 1 || !Array.isArray(probe.diagnostics) || typeof probe.ok !== "boolean") throw Error("invalid Model report");
        outcome.probe = probe;
        if (!probe.ok && ["failed", "unavailable", "timed-out", "aborted"].includes(probe.status)) outcome.status = probe.status;
      } catch (error) {
        outcome.status = "failed";
        outcome.error = `incomplete Model check report: ${error.message}`;
      }
    }
    if (identity && outcome.status === "passed" && !outcome.outputTruncated && !outcome.cleanupFailed) {
      try {
        const probe = JSON.parse(outcome.output);
        if (probe.formatVersion !== 1 || !probe.ok || !probe.identity?.engine?.sourceSha256 || !Array.isArray(probe.identity.modules)) throw Error("invalid identity report");
        outcome.identity = probe.identity;
      } catch (error) { outcome.status = "failed"; outcome.error = `incomplete check identity report: ${error.message}`; }
    }
    if (!quiet && outcome.output) {
      const output = identity && outcome.identity ? "" : outcome.probe ? outcome.probe.diagnostics.map(item => `[${item.code}] ${item.message}\n`).join("") + (outcome.probe.output ?? "") : outcome.output;
      (outcome.status === "passed" ? process.stdout : process.stderr).write(output);
    }
    return { ...outcome, command: process.execPath, args: commandArgs, cwd: engine };
  };
}
