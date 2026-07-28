import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const osRelease = parseOsRelease(readFileSync("/etc/os-release", "utf8"));
console.log(
  `[linux-smoke] system=${osRelease.PRETTY_NAME ?? osRelease.ID ?? "unknown"}`,
);
run("node", ["--version"]);
run("npm", ["--version"]);
run("rustc", ["--version"]);

// 这里刻意只做编译、Rust基础单测和真实Runtime冒烟，不运行性能或长稳测试。
run("npm", ["run", "build"]);
run("cargo", ["test", "--locked", "--lib"]);
run("cargo", ["build", "--locked", "--bin", "TiangZ"]);
run("node", ["tools/smoke_runtime.mjs", "--mode", "both"]);

console.log(
  `[linux-smoke] passed system=${osRelease.ID ?? "unknown"} version=${osRelease.VERSION_ID ?? "unknown"}`,
);

function run(command, args) {
  console.log(`[linux-smoke] $ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with code=${result.status} signal=${result.signal ?? "none"}`);
  }
}

function parseOsRelease(content) {
  const result = {};
  for (const line of content.split(/\r?\n/u)) {
    const match = /^([A-Z_]+)=(.*)$/u.exec(line);
    if (!match) continue;
    result[match[1]] = match[2].replace(/^"|"$/gu, "");
  }
  return result;
}

