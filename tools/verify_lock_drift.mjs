import { spawn } from "node:child_process";
import process from "node:process";

const root = new URL("../", import.meta.url);
const cwd = decodeURIComponent(root.pathname).replace(/^\/(\w):/, "$1:");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npmCommand = process.platform === "win32" ? "cmd.exe" : npm;

/**
 * 开发期只报告锁漂移，不改变锁文件，也不阻断CI；正式发布仍由verify:release负责拦截。
 * During development this command only reports lock drift, never changes locks
 * or blocks CI; verify:release remains the blocking gate before publishing.
 */
const checks = [
  {
    name: "protocol opcode/schema locks",
    command: process.execPath,
    args: ["tools/codegen_proto.mjs", "--strict-locks"],
  },
  {
    name: "Stable Core API lock",
    command: process.execPath,
    args: ["tools/verify_core_api.mjs", "--strict-lock"],
  },
  {
    name: "project version lock",
    command: process.execPath,
    args: ["tools/verify_project_version.mjs", "--strict"],
  },
  {
    name: "npm dependency lock",
    command: npmCommand,
    args: process.platform === "win32"
      ? ["/d", "/s", "/c", npm, "ci", "--dry-run", "--ignore-scripts", "--no-audit", "--no-fund"]
      : ["ci", "--dry-run", "--ignore-scripts", "--no-audit", "--no-fund"],
  },
];

let warnings = 0;
for (const check of checks) {
  const result = await run(check.command, check.args);
  if (result.code === 0 && !result.signal) {
    process.stdout.write(`[lock-drift] OK   ${check.name}\n`);
    continue;
  }

  warnings += 1;
  process.stdout.write(`[lock-drift] WARN ${check.name}\n`);
  const detail = `${result.stdout}${result.stderr}`.trim();
  if (detail.length > 0) {
    const lines = detail.split(/\r?\n/).slice(-80);
    for (const line of lines) process.stdout.write(`  ${line}\n`);
  }
}

process.stdout.write(
  warnings === 0
    ? "[lock-drift] development lock report clean; release locks remain explicit\n"
    : `[lock-drift] ${warnings} warning(s); development continues, run npm run verify:release before publishing\n`,
);

function run(command, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: 1, signal: undefined, stdout: "", stderr: `${String(error)}\n` });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk.toString());
    child.stderr.on("data", (chunk) => stderr += chunk.toString());
    child.on("error", (error) => resolve({ code: 1, signal: undefined, stdout, stderr: `${stderr}${error.message}\n` }));
    child.on("exit", (code, signal) => resolve({ code: code ?? 1, signal, stdout, stderr }));
  });
}
