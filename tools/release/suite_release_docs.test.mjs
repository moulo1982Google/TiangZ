import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CHECKSUM_POLICY, formatAuditMarkdown, formatSha256Sums, generateSuiteReleaseDocs, parseAuditCounts } from "./suite_release_docs.mjs";

// 套件发布通用附件生成器的测试：临时 git 仓库、假的 GitHub 接口与假的 npm audit，验证输出与每一类错误。
// Tests for the suite release documents generator: temporary git repositories, fake GitHub API and fake npm audit.

const sha256 = text => createHash("sha256").update(text).digest("hex");
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=release-test", "-c", "user.email=release-test@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();

function makeRepository(root, name, tag) {
  const directory = path.join(root, name);
  mkdirSync(directory, { recursive: true });
  git(directory, "init", "-q", "-b", "main");
  writeFileSync(path.join(directory, "file.txt"), `${name}\n`);
  git(directory, "add", ".");
  git(directory, "commit", "-q", "-m", "release commit");
  git(directory, "tag", "-a", tag, "-m", "release");
  return directory;
}

function workspace(configure = () => {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "suite-release-docs-"));
  makeRepository(root, "host", "v1.0.0");
  makeRepository(root, "tools", "v0.5.0");
  mkdirSync(path.join(root, "assets"));
  writeFileSync(path.join(root, "assets", "host-v1.0.0.zip"), "host package");
  writeFileSync(path.join(root, "plan.md"), "# 发布后测试执行单\n\n全部待执行。\n");
  const config = {
    suite: "TiangZ",
    version: "1.0.0",
    repositories: [
      { repo: "host", github: "example-owner/host", path: "host", tag: "v1.0.0", mainRef: "main", versions: { package: "1.0.0" }, assets: [{ name: "host-v1.0.0.zip", source: "CI artifact" }] },
      { repo: "tools", github: "example-owner/tools", path: "tools", tag: "v0.5.0", mainRef: "main", ci: false, assetsNote: "tag only" },
    ],
    unchangedRepositories: [{ repo: "other", tag: "v0.1.0", reason: "no changes" }],
    auditRepositories: [{ label: "host（v1.0.0）", path: "host", ref: "v1.0.0" }],
    validation: { host: { tag_ci: "verify passed" } },
    knownIssues: ["soak not executed"],
    testPlanFile: "plan.md",
  };
  configure(config, root);
  writeFileSync(path.join(root, "config.json"), JSON.stringify(config));
  return { root, configPath: path.join(root, "config.json") };
}

const fakeGithub = () => (apiPath) => {
  assert.match(apiPath, /^repos\/example-owner\/host\/actions\/runs\?head_sha=[0-9a-f]{40}&per_page=100$/);
  return { workflow_runs: [{ id: 7, name: "verify", event: "push", head_branch: "v1.0.0", status: "completed", conclusion: "success", html_url: "https://example.invalid/runs/7" }] };
};
const fakeAudit = (_target, omitDev) => ({ metadata: { vulnerabilities: omitDev ? { critical: 0, high: 0, moderate: 0, low: 0 } : { critical: 0, high: 1, moderate: 2, low: 0 } } });

test("SHA256SUMS 按名称不区分大小写排序，哈希后两个空格，末尾换行", () => {
  const text = formatSha256Sums([{ name: "tiangz.tgz", sha256: "b" }, { name: "SHA-notes.md", sha256: "a" }, { name: "TiangZ.zip", sha256: "c" }]);
  assert.equal(text, "a  SHA-notes.md\nb  tiangz.tgz\nc  TiangZ.zip\n");
});

test("npm audit 输出缺少汇总信息时报错，不当作零", () => {
  assert.deepEqual(parseAuditCounts({ metadata: { vulnerabilities: { critical: 0, high: 3, moderate: 1, low: 2, total: 6 } } }), { critical: 0, high: 3, moderate: 1, low: 2 });
  assert.throws(() => parseAuditCounts({ error: { code: "ENOLOCK" } }), /no metadata\.vulnerabilities/);
});

test("依赖审计文档把全部依赖与生产依赖分行列出，并带说明", () => {
  const markdown = formatAuditMarkdown({ version: "1.0.0", date: "2026-10-14", rows: [{ label: "host", all: { critical: 0, high: 1, moderate: 0, low: 0 }, prod: { critical: 0, high: 0, moderate: 0, low: 0 } }], note: "说明一句" });
  assert.match(markdown, /^# TiangZ 1\.0\.0 npm 依赖审计快照/);
  assert.match(markdown, /\| host（全部依赖） \| 0 \| 1 \| 0 \| 0 \|/);
  assert.match(markdown, /\| host（生产依赖） \| 0 \| 0 \| 0 \| 0 \|/);
  assert.match(markdown, /说明一句/);
});

test("生成四份附件：清单按真实 git 与文件生成，校验和覆盖清单、文档与载荷但不含自身", () => {
  const { root, configPath } = workspace();
  try {
    const out = path.join(root, "out");
    const result = generateSuiteReleaseDocs({ configPath, outDirectory: out, assetsDirectory: path.join(root, "assets"), now: "2026-10-14T00:00:00.000Z" }, { githubApi: fakeGithub(), npmAudit: fakeAudit });
    const manifest = JSON.parse(readFileSync(path.join(out, "suite-release-manifest.json"), "utf8"));
    const hostDirectory = path.join(root, "host");
    const [host, tools] = manifest.repositories;
    assert.equal(manifest.version, "1.0.0");
    assert.equal(manifest.generated_at, "2026-10-14T00:00:00.000Z");
    assert.equal(manifest.checksum_policy, CHECKSUM_POLICY);
    assert.equal(host.commit, git(hostDirectory, "rev-parse", "v1.0.0^{commit}"));
    assert.equal(host.tag_object, git(hostDirectory, "rev-parse", "v1.0.0"));
    assert.equal(host.tree, git(hostDirectory, "rev-parse", "v1.0.0^{tree}"));
    assert.equal(host.main_is_tag_commit, true);
    assert.deepEqual(host.assets, [{ name: "host-v1.0.0.zip", sha256: sha256("host package"), size: 12, source: "CI artifact" }]);
    assert.equal(host.ci_runs_on_commit.length, 1);
    assert.equal(host.ci_runs_on_commit[0].conclusion, "success");
    assert.equal(tools.ci_runs_on_commit, undefined);
    assert.equal(tools.assets_note, "tag only");
    assert.deepEqual(manifest.known_issues, ["soak not executed"]);
    assert.match(readFileSync(path.join(out, "DEPENDENCY-AUDIT.md"), "utf8"), /\| host（v1\.0\.0）（全部依赖） \| 0 \| 1 \| 2 \| 0 \|/);
    assert.equal(readFileSync(path.join(out, "POST-RELEASE-TEST-PLAN.md"), "utf8"), "# 发布后测试执行单\n\n全部待执行。\n");
    const lines = readFileSync(path.join(out, "SHA256SUMS"), "utf8").trim().split("\n");
    assert.deepEqual(lines.map(line => line.slice(66)), ["DEPENDENCY-AUDIT.md", "host-v1.0.0.zip", "POST-RELEASE-TEST-PLAN.md", "suite-release-manifest.json"]);
    for (const line of lines) {
      const name = line.slice(66);
      const file = name === "host-v1.0.0.zip" ? path.join(root, "assets", name) : path.join(out, name);
      assert.equal(line.slice(0, 64), sha256(readFileSync(file)), name);
    }
    assert.equal(result.sums, readFileSync(path.join(out, "SHA256SUMS"), "utf8"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("main 领先标签时写出配置里的说明，指向标签提交时不写", () => {
  const { root, configPath } = workspace(config => { config.repositories[0].mainAheadNote = "main is ahead by CI-only commits"; });
  try {
    writeFileSync(path.join(root, "host", "later.txt"), "later");
    git(path.join(root, "host"), "add", ".");
    git(path.join(root, "host"), "commit", "-q", "-m", "after the tag");
    const out = path.join(root, "out");
    generateSuiteReleaseDocs({ configPath, outDirectory: out, assetsDirectory: path.join(root, "assets") }, { githubApi: fakeGithub(), npmAudit: fakeAudit });
    const [host, tools] = JSON.parse(readFileSync(path.join(out, "suite-release-manifest.json"), "utf8")).repositories;
    assert.equal(host.main_is_tag_commit, false);
    assert.equal(host.main_note, "main is ahead by CI-only commits");
    assert.equal(tools.main_is_tag_commit, true);
    assert.equal(tools.main_note, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("缺附件、读不到 CI 运行、缺测试执行单、缺字段时都报错，不写出半成品的清单", () => {
  const missingAsset = workspace();
  const noRuns = workspace();
  const missingPlan = workspace(config => { config.testPlanFile = "nope.md"; });
  const missingTag = workspace(config => { delete config.repositories[0].tag; });
  try {
    const run = (setup, dependencies, expected) => assert.throws(
      () => generateSuiteReleaseDocs({ configPath: setup.configPath, outDirectory: path.join(setup.root, "out"), assetsDirectory: path.join(setup.root, "assets") }, dependencies),
      expected,
    );
    rmSync(path.join(missingAsset.root, "assets", "host-v1.0.0.zip"));
    run(missingAsset, { githubApi: fakeGithub(), npmAudit: fakeAudit }, /asset file not found: host-v1\.0\.0\.zip/);
    run(noRuns, { githubApi: () => ({ message: "API rate limit exceeded" }), npmAudit: fakeAudit }, /no CI runs found/);
    run(missingPlan, { githubApi: fakeGithub(), npmAudit: fakeAudit }, /test plan file not found/);
    run(missingTag, { githubApi: fakeGithub(), npmAudit: fakeAudit }, /missing "tag"/);
    for (const setup of [missingAsset, noRuns, missingPlan, missingTag]) assert.throws(() => readFileSync(path.join(setup.root, "out", "suite-release-manifest.json")), /ENOENT/);
  } finally {
    for (const setup of [missingAsset, noRuns, missingPlan, missingTag]) rmSync(setup.root, { recursive: true, force: true });
  }
});

test("示例配置能被读取，且包含生成器需要的全部字段", () => {
  const example = JSON.parse(readFileSync(fileURLToPath(new URL("./suite-release.example.json", import.meta.url)), "utf8"));
  for (const field of ["version", "repositories", "testPlanFile", "auditRepositories", "validation", "knownIssues", "unchangedRepositories"]) assert.ok(example[field] !== undefined, field);
  for (const repository of example.repositories) for (const field of ["repo", "path", "tag"]) assert.ok(repository[field], `${repository.repo}.${field}`);
});
