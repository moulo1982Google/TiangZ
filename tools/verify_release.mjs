import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Release前才打开冻结门禁；开发命令保持快速且允许契约迭代。
// Enable freeze gates only before a Release; daily development stays iteration-friendly.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmExecPath = process.env.npm_execpath;
const command = npmExecPath
  ? process.execPath
  : process.platform === "win32"
    ? process.env.ComSpec ?? "cmd.exe"
    : "npm";
const args = npmExecPath
  ? [npmExecPath, "run", "verify"]
  : process.platform === "win32"
    ? ["/d", "/s", "/c", "npm run verify"]
    : ["run", "verify"];
const child = spawn(command, args, {
  cwd: root,
  env: { ...process.env, TIANGZ_LOCK_VERSIONS: "1" },
  stdio: "inherit",
  windowsHide: true,
});

child.on("error", (error) => {
  console.error(`[verify:release] failed to start npm: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`[verify:release] npm terminated by ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
