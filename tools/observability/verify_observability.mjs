#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const temporary = mkdtempSync(path.join(os.tmpdir(), "tiangz-observability-"));

try {
  const splitStartup = path.resolve(root, "configs/local/cluster/StartMachine.json");
  const splitTargets = path.join(temporary, "split-targets.yml");
  run("node", ["tools/observability/generate_prom_targets.mjs", "--startup", splitStartup, "--local-host", "host.docker.internal", "--output", splitTargets]);
  verifyTargets(splitTargets, countConfiguredProcesses(splitStartup));

  const singleTargets = path.join(temporary, "single-targets.yml");
  run("node", ["tools/observability/generate_prom_targets.mjs", "--startup", "configs/local/all-in-one.json", "--local-host", "host.docker.internal", "--output", singleTargets]);
  verifyTargets(singleTargets, 1);

  const remoteProcess = path.join(temporary, "remote-map.json");
  const remoteStartup = path.join(temporary, "StartMachine.json");
  writeFileSync(remoteProcess, JSON.stringify({
    process: { name: "remote-map", observability: { health: { ip: "127.0.0.1", port: 7610 } } },
  }), "utf8");
  writeFileSync(remoteStartup, JSON.stringify({
    machines: [{ name: "remote", innerIp: "192.0.2.10", processes: ["remote-map.json"] }],
  }), "utf8");
  runExpectFailure("node", [
    "tools/observability/generate_prom_targets.mjs",
    "--startup", remoteStartup,
    "--output", path.join(temporary, "invalid-remote.yml"),
  ], "bind 0.0.0.0 or the machine management IP");

  const dashboardOutput = path.join(temporary, "dashboard.json");
  run("node", ["tools/observability/generate_dashboard.mjs", "--output", dashboardOutput]);
  const committedDashboard = path.resolve(root, "tools/observability/grafana/provisioning/dashboards/files/tiangz-process-overview.json");
  const generated = readFileSync(dashboardOutput, "utf8");
  const committed = readFileSync(committedDashboard, "utf8");
  if (generated !== committed) {
    throw new Error("Grafana Dashboard 与生成器不一致，请运行 npm run observability:dashboard");
  }
  verifyDashboard(JSON.parse(generated));
  verifyPrometheusFiles();
  console.log("[observability] assets verified");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

/** 执行仓库内生成器并保留失败输出。 / Runs a repository generator and preserves failure output. */
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", shell: false });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  }
}

/** 断言配置错误被生成器主动拒绝，而不是留下不可抓取 Target。 / Asserts invalid deployment is rejected instead of producing an unreachable target. */
function runExpectFailure(command, args, expectedMessage) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", shell: false });
  const output = `${result.stdout}${result.stderr}`;
  if (result.status === 0 || !output.includes(expectedMessage)) {
    throw new Error(`${command} did not reject invalid input as expected:\n${output}`);
  }
}

/** 验证 file_sd 条目数量、地址唯一性和必需标签。 / Validates file_sd count, unique addresses, and required labels. */
function verifyTargets(file, expectedCount) {
  const body = readFileSync(file, "utf8");
  const addresses = [...body.matchAll(/^- targets: \["([^"\r\n]+)"\]$/gm)].map((match) => match[1]);
  if (addresses.length !== expectedCount) throw new Error(`${file} expected ${expectedCount} targets, got ${addresses.length}`);
  if (new Set(addresses).size !== addresses.length) throw new Error(`${file} has duplicate targets`);
  for (const label of ["env", "machine", "process"]) {
    const count = (body.match(new RegExp(`^    ${label}: "[^"\\r\\n]+"$`, "gm")) ?? []).length;
    if (count !== expectedCount) throw new Error(`${file} has invalid ${label} labels`);
  }
}

/** 从 StartMachine 计算应生成的进程目标数，避免拓扑调整后维护重复常量。 / Counts configured process targets so topology changes do not require a duplicate constant. */
function countConfiguredProcesses(file) {
  const startup = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(startup.machines)) throw new Error(`${file} has no machines array`);
  return startup.machines.reduce((total, machine) => {
    if (!Array.isArray(machine.processes)) throw new Error(`${file} contains a machine without processes`);
    return total + machine.processes.length;
  }, 0);
}

/** 防止面板 ID、查询 refId 冲突，并确保核心诊断视图没有被误删。 / Prevents panel/refId collisions and guards required diagnostics. */
function verifyDashboard(dashboard) {
  if (!Array.isArray(dashboard.panels) || dashboard.panels.length < 22) {
    throw new Error("Dashboard must contain at least 22 diagnostic panels");
  }
  const ids = dashboard.panels.map((panel) => panel.id);
  if (new Set(ids).size !== ids.length) throw new Error("Dashboard panel IDs must be unique");
  for (const panel of dashboard.panels) {
    const refs = (panel.targets ?? []).map((target) => target.refId);
    if (refs.some((ref) => typeof ref !== "string") || new Set(refs).size !== refs.length) {
      throw new Error(`Dashboard panel ${panel.title} has invalid refIds`);
    }
  }
  const titles = new Set(dashboard.panels.map((panel) => panel.title));
  for (const title of ["Prometheus 抓取健康", "Runtime 心跳年龄", "Scene 错误分类", "协议 Handler P99"]) {
    if (!titles.has(title)) throw new Error(`Dashboard missing required panel: ${title}`);
  }
}

/** 做无外部依赖的规则接线检查；完整 PromQL 语法由 Docker 中的 promtool 验收。 / Performs dependency-free rule wiring checks; Docker promtool validates full PromQL syntax. */
function verifyPrometheusFiles() {
  const prometheus = readFileSync(path.resolve(root, "tools/observability/prometheus/prometheus.yml"), "utf8");
  const compose = readFileSync(path.resolve(root, "tools/observability/docker-compose.yml"), "utf8");
  const rules = readFileSync(path.resolve(root, "tools/observability/prometheus/rules/tiangz.yml"), "utf8");
  if (!prometheus.includes("/etc/prometheus/rules/*.yml")) throw new Error("Prometheus rule_files is missing");
  if (!compose.includes("./prometheus:/etc/prometheus:ro")) {
    throw new Error("Prometheus directory volume is missing; atomic target replacement requires a directory mount");
  }
  const alerts = [...rules.matchAll(/^      - alert: (\S+)$/gm)].map((match) => match[1]);
  if (alerts.length < 10 || new Set(alerts).size !== alerts.length) {
    throw new Error("Prometheus rules must contain at least 10 uniquely named alerts");
  }
  if ((rules.match(/^        expr: .+$/gm) ?? []).length !== alerts.length) {
    throw new Error("Every Prometheus alert must define a non-empty expr");
  }
}
