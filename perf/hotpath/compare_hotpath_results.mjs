import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

function compare(left, right, options = {}) {
  const rows = [];
  const metadata = compareParameters(left.parameters, right.parameters, rows);
  const beforeCases = indexCases(left.cases, "before", rows);
  const afterCases = indexCases(right.cases, "after", rows);
  validateExpectedCases(left.parameters, beforeCases, "before", rows);
  validateExpectedCases(right.parameters, afterCases, "after", rows);

  if (options.beforePath && options.afterPath &&
    path.resolve(options.beforePath) === path.resolve(options.afterPath) &&
    !options.sameInputAllowed) {
    rows.push({ case: "<input>", status: "same-input", detail: "before and after resolve to the same report" });
  }

  for (const key of beforeCases.keys()) {
    if (!afterCases.has(key)) rows.push({ case: key, status: "missing-after" });
  }
  for (const key of afterCases.keys()) {
    if (!beforeCases.has(key)) rows.push({ case: key, status: "missing-before" });
  }

  for (const [key, previous] of beforeCases) {
    const current = afterCases.get(key);
    if (!current) continue;
    validateCase(key, previous, current, metadata.expectedRounds, left.parameters, rows);
    const comparisonMetrics = left.parameters?.remote
      ? REMOTE_COMPARISON_METRICS
      : COMPARISON_METRICS;
    for (const metric of comparisonMetrics) {
      const beforeValue = readMetric(previous.median, metric);
      const afterValue = readMetric(current.median, metric);
      if (!beforeValue.valid || !afterValue.valid) {
        rows.push({
          case: key,
          metric,
          status: "missing-metric",
          before: beforeValue.raw,
          after: afterValue.raw,
        });
        continue;
      }
      rows.push({
        case: key,
        metric,
        before: beforeValue.value,
        after: afterValue.value,
        changePercent: beforeValue.value === 0
          ? null
          : ((afterValue.value / beforeValue.value) - 1) * 100,
      });
    }
  }

  const matchedCases = [...beforeCases.keys()].filter((key) => afterCases.has(key));
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    before: options.beforePath ?? "<self-test>",
    after: options.afterPath ?? "<self-test>",
    matchedCases,
    parameterAlignment: metadata,
    alignmentOk: rows.every((item) => !item.status),
    comparisonValid: matchedCases.length > 0 && rows.every((item) => !item.status),
    rows,
    note: "吞吐越高越好；延迟、CPU、RSS、GC、Mailbox排队和峰值深度通常越低越好。比较前必须确认参数一致、轮次完整，并且 stalled、probeErrors、businessTransportErrors、Backpressure、Inner超载和Inner超时均为零。comparisonValid=false时不能直接比较。",
  };
}

const COMPARISON_METRICS = [
  "movesPerSecond",
  "moveP50Ms",
  "moveP95Ms",
  "moveP99Ms",
  "serverPeakCpuPercentSum",
  "serverPeakRssBytesSum",
  "serverGcCount",
  "serverGcMs",
  "serverMailboxQueuedCallsSum",
  "serverMailboxOneWayQueuedCallsSum",
  "serverMailboxMaxQueuedDepthSum",
  "serverActorMailboxQueuedCallsSum",
  "serverActorMailboxOneWayQueuedCallsSum",
  "serverActorMailboxMaxQueuedDepthSum",
  "loadGcCount",
  "loadGcMs",
  "loadPeakRssBytes",
];

const REMOTE_COMPARISON_METRICS = [
  "movesPerSecond",
  "moveP50Ms",
  "moveP95Ms",
  "moveP99Ms",
  "loadGcCount",
  "loadGcMs",
  "loadPeakRssBytes",
];

const VALIDATION_METRICS = [
  ["stalled", 0],
  ["probeErrors", 0],
  ["businessTransportErrors", 0],
  ["serverBackpressureWaitsSum", 0],
  ["serverInnerOverloadsSum", 0],
  ["serverInnerTimeoutsSum", 0],
];

const PARAMETER_KEYS = [
  "mode",
  "players",
  "moveRates",
  "businessRate",
  "duration",
  "warmup",
  "rounds",
  "setupConcurrency",
  "host",
  "managerPort",
  "remote",
  "debugRuntime",
];

function compareParameters(before, after, rows) {
  const missing = [];
  const different = [];
  for (const key of PARAMETER_KEYS) {
    if (!(key in (before ?? {})) || !(key in (after ?? {}))) {
      missing.push(key);
      rows.push({ case: "<parameters>", parameter: key, status: "missing-parameter" });
      continue;
    }
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      different.push(key);
      rows.push({
        case: "<parameters>",
        parameter: key,
        status: "parameter-mismatch",
        before: before[key],
        after: after[key],
      });
    }
  }
  return {
    ok: missing.length === 0 && different.length === 0,
    missing,
    different,
    expectedRounds: Number.isInteger(after?.rounds) ? after.rounds : undefined,
  };
}

function indexCases(cases, side, rows) {
  const indexed = new Map();
  for (const item of cases ?? []) {
    const key = caseKey(item);
    if (indexed.has(key)) {
      rows.push({ case: key, status: `duplicate-${side}-case` });
      continue;
    }
    indexed.set(key, item);
  }
  return indexed;
}

function validateExpectedCases(parameters, cases, side, rows) {
  const deployments = parameters?.remote
    ? [parameters.label ?? "remote"]
    : parameters?.mode === "both"
      ? ["all", "split"]
      : [parameters?.mode];
  const expected = new Set();
  const workloadPrefix = (moveRate) => moveRate > 0 ? `steady-${moveRate}hz` : "saturation";
  for (const deployment of deployments) {
    for (const players of parameters?.players ?? []) {
      for (const moveRate of parameters?.moveRates ?? []) {
        const businessSuffix = parameters?.businessRate > 0
          ? `+business-${parameters.businessRate}hz`
          : "";
        expected.add(`${deployment}:${players}:${workloadPrefix(moveRate)}${businessSuffix}`);
      }
    }
  }
  for (const key of expected) {
    if (!cases.has(key)) rows.push({ case: key, side, status: "missing-expected-case" });
  }
  for (const key of cases.keys()) {
    if (!expected.has(key)) rows.push({ case: key, side, status: "unexpected-case" });
  }
}

function validateCase(key, before, after, expectedRounds, parameters, rows) {
  const validationMetrics = parameters?.remote
    ? [
      ["stalled", 0],
      ["probeErrors", 0],
      ["businessTransportErrors", 0],
    ]
    : VALIDATION_METRICS;
  for (const [name, expected] of validationMetrics) {
    for (const [side, item] of [["before", before], ["after", after]]) {
      const metric = readMetric(item.median, name);
      if (!metric.valid) {
        rows.push({ case: key, side, metric: name, status: "missing-validation-metric" });
      } else if (metric.value !== expected) {
        rows.push({ case: key, side, metric: name, status: "invalid-case", value: metric.value, expected });
      }
    }
  }
  for (const [side, item] of [["before", before], ["after", after]]) {
    if (!Number.isInteger(item.roundCount) || item.roundCount <= 0) {
      rows.push({ case: key, side, status: "invalid-round-count", value: item.roundCount });
    } else if (expectedRounds !== undefined && item.roundCount !== expectedRounds) {
      rows.push({ case: key, side, status: "incomplete-rounds", value: item.roundCount, expected: expectedRounds });
    }
  }
}

function readMetric(item, name) {
  const raw = item?.[name];
  const value = raw;
  return {
    raw,
    value,
    valid: typeof value === "number" && Number.isFinite(value),
  };
}

function caseKey(item) {
  return `${item?.label}:${item?.players}:${item?.workload}`;
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key.startsWith("--")) throw new Error(usage());
    if (key === "--self-test" || key === "--allow-same-input") {
      result[camelFlag(key.slice(2))] = true;
      continue;
    }
    if (index + 1 >= values.length || values[index + 1].startsWith("--")) {
      throw new Error(usage());
    }
    result[camelFlag(key.slice(2))] = values[++index];
  }
  if (!result.selfTest && (!result.before || !result.after)) throw new Error(usage());
  return result;
}

function camelFlag(value) {
  return value.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
}

function usage() {
  return "usage: --before <json> --after <json> [--output <json>] [--allow-same-input] | --self-test";
}

function runSelfTest() {
  const parameters = {
    mode: "all",
    players: [50],
    moveRates: [2],
    businessRate: 0,
    duration: 10,
    warmup: 2,
    rounds: 3,
    setupConcurrency: 8,
    host: "127.0.0.1",
    managerPort: 7000,
    remote: false,
    debugRuntime: false,
  };
  const median = Object.fromEntries(COMPARISON_METRICS.map((name) => [name, 1]));
  Object.assign(median, {
    stalled: 0,
    probeErrors: 0,
    businessTransportErrors: 0,
    serverBackpressureWaitsSum: 0,
    serverInnerOverloadsSum: 0,
    serverInnerTimeoutsSum: 0,
  });
  const base = {
    parameters,
    cases: [{ label: "all", players: 50, workload: "steady-2hz", roundCount: 3, median }],
  };
  const valid = compare(base, structuredClone(base));
  if (!valid.comparisonValid) throw new Error(`valid fixture was rejected: ${JSON.stringify(valid.rows)}`);
  const invalid = structuredClone(base);
  invalid.cases[0].median.stalled = 1;
  if (compare(base, invalid).comparisonValid) throw new Error("invalid stalled fixture was accepted");
  const missingMetric = structuredClone(base);
  delete missingMetric.cases[0].median.serverActorMailboxMaxQueuedDepthSum;
  if (compare(base, missingMetric).comparisonValid) throw new Error("missing metric fixture was accepted");
  const incompleteRounds = structuredClone(base);
  incompleteRounds.cases[0].roundCount = 2;
  if (compare(base, incompleteRounds).comparisonValid) throw new Error("incomplete round fixture was accepted");
}

const args = parseArgs(process.argv.slice(2));
if (args.selfTest) {
  runSelfTest();
  console.log("[hotpath-compare] self-test passed");
  process.exit(0);
}

const before = JSON.parse(readFileSync(args.before, "utf8"));
const after = JSON.parse(readFileSync(args.after, "utf8"));
const report = compare(before, after, {
  beforePath: args.before,
  afterPath: args.after,
  sameInputAllowed: args.allowSameInput,
});
const output = args.output ?? path.resolve(path.dirname(args.after), "hotpath_compare_latest.json");
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
console.log(`[hotpath-compare] result: ${output}`);
if (!report.comparisonValid) process.exitCode = 2;
