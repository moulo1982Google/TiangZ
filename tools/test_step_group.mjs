import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

// 专用组拥有者保持事件循环空闲，父级消失时依靠 IPC EOF 回收嵌套步骤。 / The dedicated group owner stays responsive and reclaims nested steps on parent IPC EOF.
if (!process.send || !process.connected) throw new Error("test step group requires an owning IPC parent");
const request = JSON.parse(Buffer.from(process.argv[2], "base64").toString("utf8"));
const killOwnedGroup = () => process.kill(-process.pid, "SIGKILL");
process.once("disconnect", killOwnedGroup);
process.once("SIGTERM", killOwnedGroup);
process.once("SIGINT", killOwnedGroup);

function remainingProcesses() {
  if (process.platform === "linux") {
    return readdirSync("/proc").filter(name => /^\d+$/.test(name) && Number(name) !== process.pid).filter(name => {
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        return Number(fields[2]) === process.pid && !["Z", "X"].includes(fields[0]);
      } catch (error) { if (["ENOENT", "ESRCH", "EACCES"].includes(error.code)) return false; throw error; }
    }).length;
  }
  const sample = spawnSync("ps", ["-e", "-o", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 1_000, maxBuffer: 4 * 1024 * 1024 });
  if (sample.status !== 0) throw new Error(`cannot inspect owned process group: ${sample.error?.message ?? sample.stderr}`);
  return sample.stdout.trim().split(/\r?\n/).filter(line => {
    const [pid, group, state] = line.trim().split(/\s+/);
    return Number(group) === process.pid && Number(pid) !== process.pid && Number(pid) !== sample.pid && !state.startsWith("Z");
  }).length;
}

let complete = false;
async function finish(code, error) {
  if (complete) return;
  complete = true;
  let remaining = 0;
  try {
    for (let attempt = 0; attempt < 50 && (remaining = remainingProcesses()) > 0; attempt++) await delay(10);
  } catch (failure) { error = failure.message; }
  if (remaining > 0 || error) {
    const message = error ?? `command left ${remaining} descendant process(es)`;
    process.stderr.write(`[test-step] ${message}\n`);
    process.send({ kind: "step-exit", exitCode: code === 0 ? 125 : code, error: message }, () => killOwnedGroup());
  } else {
    process.exit(code);
  }
}

const child = spawn(request.command, request.args, { stdio: "inherit", shell: false });
child.once("error", error => { void finish(1, error.message); });
child.once("exit", (code, signal) => { void finish(code ?? 1, signal ? `command ended with ${signal}` : undefined); });
