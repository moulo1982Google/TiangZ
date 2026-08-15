import { spawn } from "node:child_process";

// Release前才打开冻结门禁；开发命令保持快速且允许契约迭代。
// Enable freeze gates only before a Release; daily development stays iteration-friendly.
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(npm, ["run", "verify"], {
  env: { ...process.env, TIANGZ_LOCK_VERSIONS: "1" },
  stdio: "inherit",
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
