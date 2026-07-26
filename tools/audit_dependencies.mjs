import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(readFileSync(path.join(root, "security", "dependency-exceptions.json"), "utf8"));
const exceptions = policy.exceptions;

const npm = runJson(process.execPath, [requiredNpmExecPath(), "audit", "--json"]);
const npmIssues = Object.entries(npm.vulnerabilities ?? {})
  .filter(([, issue]) => ["high", "critical"].includes(issue.severity))
  .map(([packageName, issue]) => ({ ecosystem: "npm", package: packageName, issue }));

const cargo = runJson("cargo", ["audit", "--json"]);
const cargoIssues = (cargo.vulnerabilities?.list ?? []).map((issue) => ({
  ecosystem: "cargo",
  package: issue.package?.name ?? "unknown",
  issue,
}));

const unresolved = [...npmIssues, ...cargoIssues].filter((entry) => !isExcepted(entry));
if (unresolved.length > 0) {
  for (const entry of unresolved) {
    const id = entry.issue.advisory?.id ?? advisoryIds(entry.issue).join(",") ?? "unknown";
    console.error(`[dependency-audit] ${entry.ecosystem}:${entry.package} ${id}`);
  }
  throw new Error(`${unresolved.length} dependency advisories are not covered by an active exception`);
}

console.log(`[dependency-audit] passed; npm=${npmIssues.length}, cargo=${cargoIssues.length}, excepted=${npmIssues.length + cargoIssues.length}`);

function isExcepted(entry) {
  const serialized = JSON.stringify(entry.issue);
  return exceptions.some((exception) =>
    exception.ecosystem === entry.ecosystem
    && exception.package === entry.package
    && serialized.includes(exception.id));
}

function advisoryIds(issue) {
  return (issue.via ?? [])
    .filter((value) => typeof value === "object" && value !== null)
    .flatMap((value) => [value.source, value.url, value.title])
    .filter(Boolean)
    .map(String);
}

function runJson(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!result.stdout.trim()) {
    throw new Error(`${command} produced no JSON output:\n${result.stderr}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${command} returned invalid JSON: ${error.message}\n${result.stdout}\n${result.stderr}`);
  }
}

function requiredNpmExecPath() {
  if (!process.env.npm_execpath) throw new Error("run this audit through npm run audit:dependencies");
  return process.env.npm_execpath;
}
