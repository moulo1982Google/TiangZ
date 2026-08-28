import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const apply = process.argv.includes("--apply");
const policies = [
  {
    source: path.join(root, "tools/chaos/sysctl/99-tiangz-redis.conf"),
    target: "/etc/sysctl.d/99-tiangz-redis.conf",
    mode: 0o644,
  },
  {
    source: path.join(root, "tools/chaos/journald/tiangz-chaos.conf"),
    target: "/etc/systemd/journald.conf.d/60-tiangz-chaos.conf",
    mode: 0o644,
  },
  {
    source: path.join(root, "tools/chaos/logrotate/rsyslog"),
    target: "/etc/logrotate.d/rsyslog",
    mode: 0o644,
  },
];

if (process.platform !== "linux") throw new Error("external host preparation requires Linux");
if (apply && process.getuid?.() !== 0) throw new Error("--apply requires root");
for (const policy of policies) {
  if (!existsSync(policy.source)) throw new Error(`missing policy source ${policy.source}`);
}
const validationPath = `/tmp/tiangz-rsyslog-${process.pid}`;
try {
  writeFileSync(validationPath, readFileSync(policies[2].source), { mode: 0o600 });
  execFileSync("logrotate", ["--debug", validationPath], { stdio: "inherit" });
} finally {
  if (existsSync(validationPath)) rmSync(validationPath);
}

if (!apply) {
  console.log(JSON.stringify({ status: "validated", apply: false, policies }, null, 2));
  process.exit(0);
}

const backupDirectory = "/var/backups/tiangz-host-policy";
mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
for (const policy of policies) {
  mkdirSync(path.dirname(policy.target), { recursive: true });
  const backup = path.join(backupDirectory, path.basename(policy.target));
  if (existsSync(policy.target) && !existsSync(backup)) copyFileSync(policy.target, backup);
  const temporary = `${policy.target}.tiangz-${process.pid}`;
  writeFileSync(temporary, readFileSync(policy.source));
  chmodSync(temporary, policy.mode);
  renameSync(temporary, policy.target);
}

execFileSync("sysctl", ["--system"], { stdio: "inherit" });
execFileSync("systemctl", ["restart", "systemd-journald.service"], { stdio: "inherit" });
execFileSync("logrotate", ["--debug", "/etc/logrotate.d/rsyslog"], { stdio: "inherit" });
console.log(JSON.stringify({
  status: "applied",
  overcommitMemory: readFileSync("/proc/sys/vm/overcommit_memory", "utf8").trim(),
  policies: policies.map(({ target }) => target),
  backups: backupDirectory,
}));
