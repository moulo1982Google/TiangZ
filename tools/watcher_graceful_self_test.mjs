import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(root, "target", "debug", process.platform === "win32" ? "TiangZ.exe" : "TiangZ");
const child = spawn(executable, ["configs/local/StartMachine.json"], {
  cwd: root,
  env: { ...process.env, TIANGZ_WATCHER_CONTROL: "stdin" },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
let output = "";
child.stdout.setEncoding("utf8").on("data", (chunk) => output += chunk);
child.stderr.setEncoding("utf8").on("data", (chunk) => output += chunk);

try {
  await Promise.all([7000, 7001, 7002, 7100, 7201, 7301].map(waitForPort));
  child.stdin.end("shutdown\n");
  const { code, signal } = await waitForExit(child, 30_000);
  if (code !== 0) throw new Error(`Watcher exited with code=${code} signal=${signal}`);
  console.log("watcher graceful self-test passed (all child exits successful and within timeout)");
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill();
}

function waitForPort(port) {
  const deadline = Date.now() + 15_000;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error(`timed out waiting for 127.0.0.1:${port}`));
        else setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

function waitForExit(processHandle, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Watcher graceful shutdown timed out")), timeoutMs);
    processHandle.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    processHandle.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
