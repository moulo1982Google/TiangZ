import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// 套件发布通用附件生成器：为一次套件发布生成 suite-release-manifest.json、DEPENDENCY-AUDIT.md、POST-RELEASE-TEST-PLAN.md 与 SHA256SUMS。
// 清单里的提交、树、CI 运行、依赖审计结果和附件哈希都在运行时从 git、GitHub CLI（gh）和实际文件读取，不手写；发布后测试执行单是每次发布人工写的叙述，由配置指向文件原样复制。
// 用法：node tools/release/suite_release_docs.mjs --config <配置.json> --out <输出目录> [--assets <附件目录>] [--now <ISO 时间>]。配置格式见 suite-release.example.json。
// Generates the common suite release attachments (manifest, dependency audit, post-release test plan, SHA256SUMS). Commits, trees, CI runs, audit counts and
// asset hashes are read from git, the GitHub CLI and the real files at run time. The post-release test plan is hand-written per release and copied verbatim.

export const RELEASE_TYPE = "GitHub Release (stable, not npm/crates.io/VS Code Marketplace)";
export const CHECKSUM_POLICY = "SHA256SUMS covers this manifest and every release payload asset; it excludes itself";
export const COMMON_DOCUMENTS = Object.freeze(["DEPENDENCY-AUDIT.md", "POST-RELEASE-TEST-PLAN.md", "suite-release-manifest.json"]);

/** 文件的 SHA-256 十六进制摘要。 / Hex SHA-256 digest of a file. */
export function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** SHA256SUMS 内容：按名称不区分大小写排序，哈希与名称之间两个空格，末尾换行。 / SHA256SUMS text: case-insensitive name order, two spaces, trailing newline. */
export function formatSha256Sums(entries) {
  const sorted = [...entries].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return `${sorted.map(entry => `${entry.sha256}  ${entry.name}`).join("\n")}\n`;
}

/** 从 npm audit --json 的输出取各级别漏洞数；没有汇总信息时报错，不当作零。 / Counts by severity from npm audit --json; a missing summary is an error, never zero. */
export function parseAuditCounts(report) {
  const counts = report?.metadata?.vulnerabilities;
  if (!counts) throw new Error("npm audit output has no metadata.vulnerabilities");
  return { critical: counts.critical ?? 0, high: counts.high ?? 0, moderate: counts.moderate ?? 0, low: counts.low ?? 0 };
}

/** DEPENDENCY-AUDIT.md 的正文。 / Text of DEPENDENCY-AUDIT.md. */
export function formatAuditMarkdown({ version, date, rows, note }) {
  const lines = rows.flatMap(row => [
    `| ${row.label}（全部依赖） | ${row.all.critical} | ${row.all.high} | ${row.all.moderate} | ${row.all.low} |`,
    `| ${row.label}（生产依赖） | ${row.prod.critical} | ${row.prod.high} | ${row.prod.moderate} | ${row.prod.low} |`,
  ]);
  return [
    `# TiangZ ${version} npm 依赖审计快照`,
    "",
    `生成于 ${date}，在各仓库的发布提交（或沿用的标签）上执行 \`npm audit\`（全部依赖与 \`--omit=dev\` 生产依赖）。这是实际审计结果，不是豁免或整体安全认证。`,
    "",
    "| 范围 | Critical | High | Moderate | Low |",
    "|---|---:|---:|---:|---:|",
    ...lines,
    "",
    ...(note ? [note, ""] : []),
  ].join("\n");
}

const gitOutput = (args, cwd) => execFileSync("git", args, { encoding: "utf8", cwd, maxBuffer: 1 << 28 }).trim();

/** 经 GitHub CLI 读取 GitHub 接口，二进制可用 GH_BIN 指定。 / Reads the GitHub API through the GitHub CLI; GH_BIN overrides the binary. */
function defaultGithubApi(apiPath) {
  return JSON.parse(execFileSync(process.env.GH_BIN || "gh", ["api", apiPath], { encoding: "utf8", maxBuffer: 1 << 28 }));
}

/** 取出某个引用上的 package.json 与锁文件，在临时目录运行 npm audit；有漏洞时 npm 以非零退出，仍读取其 JSON。 / Runs npm audit on a ref's manifest and lock in a temp directory; npm exits non-zero on findings, the JSON is still read. */
function defaultNpmAudit({ repoPath, ref }, omitDev) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "tiangz-audit-"));
  try {
    for (const name of ["package.json", "package-lock.json"]) writeFileSync(path.join(directory, name), gitOutput(["show", `${ref}:${name}`], repoPath));
    const result = spawnSync("npm", ["audit", "--json", ...(omitDev ? ["--omit=dev"] : [])], { cwd: directory, encoding: "utf8", maxBuffer: 1 << 28, shell: process.platform === "win32" });
    if (result.error) throw result.error;
    return JSON.parse(result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function requireField(object, field, where) {
  if (object?.[field] === undefined || object[field] === null || object[field] === "") throw new Error(`${where} is missing "${field}"`);
  return object[field];
}

function buildRepository(entry, context) {
  const where = `repositories[${entry.repo ?? "?"}]`;
  const repoPath = path.resolve(context.configDirectory, requireField(entry, "path", where));
  const tag = requireField(entry, "tag", where);
  const commit = context.git(["rev-parse", `${tag}^{commit}`], repoPath);
  const mainRef = entry.mainRef ?? "origin/main";
  const main = context.git(["rev-parse", mainRef], repoPath);
  const assets = (entry.assets ?? []).map(asset => {
    const file = path.join(context.assetsDirectory, requireField(asset, "name", `${where}.assets`));
    if (!existsSync(file)) throw new Error(`${where}: asset file not found: ${asset.name}`);
    return { name: asset.name, sha256: sha256File(file), size: statSync(file).size, source: requireField(asset, "source", `${where}.assets[${asset.name}]`) };
  });
  let ciRuns;
  if (entry.github && entry.ci !== false) {
    const response = context.githubApi(`repos/${entry.github}/actions/runs?head_sha=${commit}&per_page=100`);
    if (!Array.isArray(response?.workflow_runs) || response.workflow_runs.length === 0) throw new Error(`${where}: no CI runs found for ${commit}; check the GitHub CLI login`);
    ciRuns = response.workflow_runs.map(run => ({ id: run.id, name: run.name, event: run.event, ref: run.head_branch, status: run.status, conclusion: run.conclusion, url: run.html_url }));
  }
  return {
    repo: entry.repo,
    tag,
    tag_object: context.git(["rev-parse", tag], repoPath),
    commit,
    tree: context.git(["rev-parse", `${tag}^{tree}`], repoPath),
    main,
    main_is_tag_commit: main === commit,
    ...(main !== commit && entry.mainAheadNote ? { main_note: entry.mainAheadNote } : {}),
    versions: entry.versions ?? {},
    assets,
    ...(entry.assetsNote ? { assets_note: entry.assetsNote } : {}),
    ...(ciRuns ? { ci_runs_on_commit: ciRuns } : {}),
  };
}

/**
 * 生成四份通用附件并返回写出的文件与校验和。依赖可注入（git、githubApi、npmAudit），测试用。
 * Writes the four common attachments and returns the files and checksums. Dependencies are injectable for tests.
 */
export function generateSuiteReleaseDocs({ configPath, outDirectory, assetsDirectory = outDirectory, now = new Date().toISOString() }, dependencies = {}) {
  const context = {
    git: dependencies.git ?? gitOutput,
    githubApi: dependencies.githubApi ?? defaultGithubApi,
    configDirectory: path.dirname(path.resolve(configPath)),
    assetsDirectory: path.resolve(assetsDirectory),
  };
  const npmAudit = dependencies.npmAudit ?? defaultNpmAudit;
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const version = requireField(config, "version", "config");
  const suite = config.suite ?? "TiangZ";
  if (!Array.isArray(config.repositories) || config.repositories.length === 0) throw new Error('config needs a non-empty "repositories" list');
  const testPlan = path.resolve(context.configDirectory, requireField(config, "testPlanFile", "config"));
  if (!existsSync(testPlan)) throw new Error(`test plan file not found: ${testPlan}`);

  const repositories = config.repositories.map(entry => buildRepository(entry, context));
  const auditRows = (config.auditRepositories ?? []).map(entry => {
    const repoPath = path.resolve(context.configDirectory, requireField(entry, "path", "auditRepositories"));
    const ref = requireField(entry, "ref", "auditRepositories");
    return { label: requireField(entry, "label", "auditRepositories"), all: parseAuditCounts(npmAudit({ repoPath, ref }, false)), prod: parseAuditCounts(npmAudit({ repoPath, ref }, true)) };
  });
  const manifest = {
    schema: 1,
    suite,
    version,
    release_type: config.releaseType ?? RELEASE_TYPE,
    generated_at: now,
    ...(config.tagNote ? { tag_note: config.tagNote } : {}),
    repositories,
    unchanged_repositories: config.unchangedRepositories ?? [],
    validation: config.validation ?? {},
    dependency_audit: { ...Object.fromEntries(auditRows.map(row => [row.label, `${Object.values(row.all).join("/")} (all) ${Object.values(row.prod).join("/")} (production), critical/high/moderate/low`])), report: "DEPENDENCY-AUDIT.md" },
    known_issues: config.knownIssues ?? [],
    checksum_policy: CHECKSUM_POLICY,
  };

  const out = path.resolve(outDirectory);
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "suite-release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(out, "DEPENDENCY-AUDIT.md"), formatAuditMarkdown({ version, date: now.slice(0, 10), rows: auditRows, note: config.auditNote }));
  writeFileSync(path.join(out, "POST-RELEASE-TEST-PLAN.md"), readFileSync(testPlan));
  const payloads = repositories.flatMap(repository => repository.assets.map(asset => ({ name: asset.name, sha256: asset.sha256 })));
  const documents = COMMON_DOCUMENTS.map(name => ({ name, sha256: sha256File(path.join(out, name)) }));
  const sums = formatSha256Sums([...documents, ...payloads]);
  writeFileSync(path.join(out, "SHA256SUMS"), sums);
  return { directory: out, files: [...COMMON_DOCUMENTS, "SHA256SUMS"], sums, manifest };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!["--config", "--out", "--assets", "--now"].includes(key) || argv[index + 1] === undefined) throw new Error(`unknown or incomplete option: ${key}`);
    options[key.slice(2)] = argv[index + 1];
  }
  if (!options.config || !options.out) throw new Error("usage: suite_release_docs.mjs --config <config.json> --out <directory> [--assets <directory>] [--now <ISO time>]");
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArguments(process.argv.slice(2));
  const result = generateSuiteReleaseDocs({ configPath: options.config, outDirectory: options.out, assetsDirectory: options.assets ?? options.out, ...(options.now ? { now: options.now } : {}) });
  console.log(`[release-docs] wrote ${result.files.join(", ")} to ${result.directory}`);
  process.stdout.write(result.sums);
}
