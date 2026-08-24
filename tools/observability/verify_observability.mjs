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
  const generated = normalizeLineEndings(readFileSync(dashboardOutput, "utf8"));
  const committed = normalizeLineEndings(readFileSync(committedDashboard, "utf8"));
  if (generated !== committed) {
    throw new Error("Grafana Dashboard 与生成器不一致，请运行 npm run observability:dashboard");
  }
  verifyDashboard(JSON.parse(generated));
  verifyPrometheusFiles();
  verifySignalStack();
  verifyTracingConfigs(splitStartup);
  verifyProductionStack();
  console.log("[observability] assets verified");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

/** 统一文本换行，避免Windows Git检出策略制造伪生成漂移。 / Normalizes text line endings so Windows Git checkout policy cannot create false generated drift. */
function normalizeLineEndings(value) {
  return value.replaceAll("\r\n", "\n");
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

/** 验证日志、Trace和Grafana关联配置同时存在且不会把Trace ID做成索引标签。 / Verifies logs, traces, and Grafana correlation are wired without indexing trace IDs as labels. */
function verifySignalStack() {
  const compose = readFileSync(path.resolve(root, "tools/observability/docker-compose.yml"), "utf8");
  const alloy = readFileSync(path.resolve(root, "tools/observability/alloy/config.alloy"), "utf8");
  const loki = readFileSync(path.resolve(root, "tools/observability/loki/loki.yml"), "utf8");
  const tempo = readFileSync(path.resolve(root, "tools/observability/tempo/tempo.yml"), "utf8");
  const datasources = readFileSync(path.resolve(root, "tools/observability/grafana/provisioning/datasources/prometheus.yml"), "utf8");
  for (const service of ["loki:", "tempo:", "alloy:", "grafana:"]) {
    if (!compose.includes(`  ${service}`)) throw new Error(`Compose missing observability service ${service}`);
  }
  if (!compose.includes("../../logs:/var/log/tiangz:ro")) throw new Error("Alloy log volume is missing");
  if (!alloy.includes("stage.structured_metadata") || !alloy.includes("trace_id = \"\"")) {
    throw new Error("Alloy must retain trace_id as structured metadata");
  }
  const labelsBlock = alloy.match(/stage\.labels\s*\{[\s\S]*?\n\s*\}/)?.[0] ?? "";
  if (labelsBlock.includes("trace_id") || labelsBlock.includes("span_id")) {
    throw new Error("Trace and span IDs must not be Loki labels");
  }
  if (!loki.includes("allow_structured_metadata: true")) throw new Error("Loki structured metadata is disabled");
  if (!tempo.includes("endpoint: 0.0.0.0:4318")) throw new Error("Tempo OTLP HTTP receiver is missing");
  for (const uid of ["uid: prometheus", "uid: loki", "uid: tempo"]) {
    if (!datasources.includes(uid)) throw new Error(`Grafana datasource missing ${uid}`);
  }
  if (!datasources.includes("tracesToLogsV2") || !datasources.includes("derivedFields")) {
    throw new Error("Grafana log/trace bidirectional correlation is missing");
  }
}

/** 拆分开发拓扑必须产出JSON文件日志并向本机Tempo采样，保证一键启动后可查询。 / Split development topology must emit JSON files and sampled traces for one-command inspection. */
function verifyTracingConfigs(startupFile) {
  const startup = JSON.parse(readFileSync(startupFile, "utf8"));
  const directory = path.dirname(startupFile);
  const files = new Set(startup.machines.flatMap((machine) => machine.processes));
  for (const relative of files) {
    const config = JSON.parse(readFileSync(path.resolve(directory, relative), "utf8"));
    const logging = config.process?.logging;
    const tracing = config.process?.observability?.tracing;
    if (logging?.format !== "json" || logging?.file?.enabled !== true) {
      throw new Error(`${relative} must enable JSON file logging for Loki`);
    }
    if (tracing?.enabled !== true || tracing?.sampleRate < 1 || !tracing?.otlpEndpoint) {
      throw new Error(`${relative} must enable sampled OTLP tracing for Tempo`);
    }
  }
}

/** 生产单机观测栈必须受资源、端口、保留期与秘密边界约束。 / The production single-host stack must bound resources, ports, retention, and secrets. */
function verifyProductionStack() {
  const base = path.resolve(root, "tools/observability/production");
  const compose = readFileSync(path.join(base, "docker-compose.yml"), "utf8");
  const prometheus = readFileSync(path.join(base, "prometheus/prometheus.yml"), "utf8");
  const targets = readFileSync(path.join(base, "prometheus/targets.yml"), "utf8");
  const alertmanager = readFileSync(path.join(base, "alertmanager/alertmanager.yml"), "utf8");
  const webhook = readFileSync(path.join(base, "alertmanager/alertmanager-webhook.yml"), "utf8");
  const alloy = readFileSync(path.join(base, "alloy/config.alloy"), "utf8");
  const loki = readFileSync(path.join(base, "loki/loki.yml"), "utf8");
  const tempo = readFileSync(path.join(base, "tempo/tempo.yml"), "utf8");
  const datasources = readFileSync(path.join(base, "grafana/provisioning/datasources/datasources.yml"), "utf8");
  const dashboard = JSON.parse(readFileSync(path.join(base, "grafana/dashboards/production-overview.json"), "utf8"));

  for (const service of ["prometheus", "alertmanager", "loki", "tempo", "alloy", "grafana", "node-exporter", "postgres-exporter", "redis-exporter"]) {
    if (!compose.includes(`  ${service}:`)) throw new Error(`Production Compose missing ${service}`);
  }
  if ((compose.match(/network_mode: host/g) ?? []).length !== 9 || compose.includes("\n    ports:")) {
    throw new Error("Production observability must use loopback-bound host networking without published ports");
  }
  if ((compose.match(/mem_limit:/g) ?? []).length !== 9 || !compose.includes("retention.time=7d")) {
    throw new Error("Production observability must bound every service memory and Prometheus retention");
  }
  for (const endpoint of ["127.0.0.1:19090", "127.0.0.1:19093", "127.0.0.1:19100", "127.0.0.1:19187", "127.0.0.1:19121"]) {
    if (!compose.includes(endpoint) && !prometheus.includes(endpoint)) {
      throw new Error(`Production loopback endpoint missing: ${endpoint}`);
    }
  }
  if (!compose.includes("GF_SERVER_HTTP_ADDR: 127.0.0.1") || !compose.includes("GF_SERVER_HTTP_PORT: 13001")) {
    throw new Error("Production Grafana must bind only to 127.0.0.1:13001");
  }
  if ((targets.match(/kind: tiangz/g) ?? []).length !== 10 || (targets.match(/kind: dbproxy/g) ?? []).length !== 2) {
    throw new Error("Production targets must contain 10 TiangZ Processes and 2 DBProxy instances");
  }
  if (!prometheus.includes("127.0.0.1:19093") || !alertmanager.includes("receiver: operator")) {
    throw new Error("Prometheus and Alertmanager routing is incomplete");
  }
  if (!webhook.includes("url_file:") || /https?:\/\//.test(webhook)) {
    throw new Error("Alert webhook must come from a secret file, never the repository");
  }
  if (!alloy.includes("loki.source.journal") || !alloy.includes("stage.structured_metadata")) {
    throw new Error("Production Alloy must collect DBProxy journal and TiangZ structured logs");
  }
  if (!loki.includes("http_listen_address: 127.0.0.1") || !loki.includes("retention_period: 168h")) {
    throw new Error("Production Loki must bind loopback and retain seven days");
  }
  if (!tempo.includes("endpoint: 127.0.0.1:4318") || !tempo.includes("block_retention: 168h")) {
    throw new Error("Production Tempo must bind OTLP to loopback and retain seven days");
  }
  if (!datasources.includes("uid: alertmanager") || !datasources.includes("tracesToLogsV2")) {
    throw new Error("Production Grafana datasources are incomplete");
  }
  const ids = dashboard.panels?.map((panel) => panel.id) ?? [];
  if (ids.length < 8 || new Set(ids).size !== ids.length) {
    throw new Error("Production Dashboard must contain at least 8 panels with unique IDs");
  }
}
