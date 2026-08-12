import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const before = JSON.parse(readFileSync(args.before, "utf8"));
const after = JSON.parse(readFileSync(args.after, "utf8"));
const report = compare(before, after);
const output = args.output ?? path.resolve(path.dirname(args.after), "hotpath_compare_latest.json");
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
console.log(`[hotpath-compare] result: ${output}`);

function compare(left, right) {
  const beforeCases = new Map((left.cases ?? []).map((item) => [caseKey(item), item.median]));
  const afterCases = new Map((right.cases ?? []).map((item) => [caseKey(item), item.median]));
  const rows = [];
  for (const key of beforeCases.keys()) {
    if (!afterCases.has(key)) rows.push({ case: key, status: "missing-after" });
  }
  for (const item of right.cases ?? []) {
    const key = caseKey(item);
    const previous = beforeCases.get(key);
    if (!previous) {
      rows.push({ case: key, status: "missing-before" });
      continue;
    }
    for (const metric of [
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
      "loadGcCount",
      "loadGcMs",
      "loadPeakRssBytes",
    ]) {
      const beforeValue = Number(previous[metric] ?? 0);
      const afterValue = Number(item.median[metric] ?? 0);
      rows.push({
        case: key,
        metric,
        before: beforeValue,
        after: afterValue,
        changePercent: beforeValue === 0 ? null : ((afterValue / beforeValue) - 1) * 100,
      });
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    before: args.before,
    after: args.after,
    matchedCases: rows.filter((item) => !item.status).length > 0
      ? [...new Set(rows.filter((item) => !item.status).map((item) => item.case))]
      : [],
    alignmentOk: rows.every((item) => !item.status),
    rows,
    note: "吞吐越高越好；延迟、CPU、RSS、GC、Mailbox排队和峰值深度通常越低越好。先看 stalled、transport errors 和 overload 是否为零。alignmentOk=false时不能直接比较。",
  };
}

function caseKey(item) {
  return `${item.label}:${item.players}:${item.workload}`;
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key.startsWith("--") || index + 1 >= values.length) throw new Error("usage: --before <json> --after <json> [--output <json>]");
    result[key.slice(2)] = values[++index];
  }
  if (!result.before || !result.after) throw new Error("usage: --before <json> --after <json> [--output <json>]");
  return result;
}
