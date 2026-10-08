import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// 只给本次构建进程树提供候选 Git 来源，不改全局配置。 / Candidate Git sources belong only to this build process tree.
const args = process.argv.slice(2);
const separator = args.indexOf("--");
if (args[0] !== "--manifest" || separator !== 2 || args.length < 4) {
  throw new Error("Usage: npm run release:with-local-deps -- --manifest <manifest.json> -- <command> [args]");
}
const manifestFile = path.resolve(args[1]);
const root = path.dirname(manifestFile);
const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
assert.equal(manifest.formatVersion, 1);
assert.ok(Array.isArray(manifest.repositories) && manifest.repositories.length > 0 && manifest.repositories.length <= 6);
const env = { ...process.env, CARGO_NET_GIT_FETCH_WITH_CLI: "true", GIT_TERMINAL_PROMPT: "0" };
let count = Number(env.GIT_CONFIG_COUNT ?? 0);
assert.ok(Number.isSafeInteger(count) && count >= 0 && count <= 100, "Invalid inherited Git configuration count");
const configure = (key, value) => {
  env[`GIT_CONFIG_KEY_${count}`] = key;
  env[`GIT_CONFIG_VALUE_${count}`] = value;
  env.GIT_CONFIG_COUNT = String(++count);
};
const names = new Set();
const remotes = new Set();
const prepared = [];
for (const repository of manifest.repositories) {
  assert.match(repository.name, /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
  assert.match(repository.remote, /^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+\.git$/);
  assert.match(repository.tag, /^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
  assert.match(repository.commit, /^[a-f0-9]{40}$/);
  assert.match(repository.sha256, /^[a-f0-9]{64}$/);
  assert.ok(!names.has(repository.name) && !remotes.has(repository.remote), "Duplicate repository name or remote");
  names.add(repository.name); remotes.add(repository.remote);
  const bundle = path.resolve(root, repository.bundle);
  const relative = path.relative(root, bundle);
  assert.ok(relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`), "Bundle must be inside the artifact directory");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(bundle)) hash.update(chunk);
  assert.equal(hash.digest("hex"), repository.sha256, `Bundle checksum mismatch: ${repository.name}`);
  prepared.push({ repository, bundle });
}

for (const { repository, bundle } of prepared) {
  const mirror = path.join(root, "git-mirrors", `${repository.name}-${repository.sha256.slice(0, 12)}.git`);
  if (!existsSync(mirror)) {
    mkdirSync(path.dirname(mirror), { recursive: true });
    git(["clone", "--bare", bundle, mirror]);
  }
  const actual = git(["--git-dir", mirror, "rev-parse", "--verify", `refs/tags/${repository.tag}^{commit}`]).trim();
  assert.equal(actual, repository.commit, `Candidate tag mismatch: ${repository.name}`);
  // tag-only bundle 没有默认分支，npm clone 仍需要可解析的 HEAD。 / npm clone requires a resolvable HEAD even for a tag-only bundle.
  const branch = "tiangz-candidate";
  const branchCommit = git(["--git-dir", mirror, "branch", "--list", "--format=%(objectname)", branch]).trim();
  if (branchCommit) assert.equal(branchCommit, repository.commit, `Candidate mirror branch mismatch: ${repository.name}`);
  else git(["--git-dir", mirror, "branch", branch, repository.commit]);
  git(["--git-dir", mirror, "symbolic-ref", "HEAD", `refs/heads/${branch}`]);
  const key = `url.${pathToFileURL(mirror).href}.insteadOf`;
  // npm 的 GitHub fetcher 也会改用同仓库的 SSH URL。 / npm's GitHub fetcher may select the same repository's SSH URL.
  const githubPath = repository.remote.slice("https://github.com/".length);
  for (const remote of [repository.remote, `ssh://git@github.com/${githubPath}`, `git@github.com:${githubPath}`]) configure(key, remote);
  console.log(`[candidate-source] ${repository.name} ${repository.tag} ${actual}`);
}
configure("protocol.file.allow", "always");
const command = args[separator + 1];
const commandArgs = args.slice(separator + 2);
let executable = command;
if (command === "npm") {
  assert.ok(process.env.npm_execpath && existsSync(process.env.npm_execpath), "Invoke this helper through npm run so it can use the same npm CLI on Windows and Linux");
  executable = process.execPath;
  commandArgs.unshift(process.env.npm_execpath);
}
const child = spawn(executable, commandArgs, { env, stdio: "inherit", windowsHide: true, shell: false });
child.once("error", error => { console.error(error); process.exitCode = 1; });
child.once("exit", (code, signal) => {
  if (signal) console.error(`[candidate-source] command terminated: ${signal}`);
  process.exitCode = code ?? 1;
});

function git(arguments_) {
  const result = spawnSync("git", arguments_, { encoding: "utf8", windowsHide: true, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Candidate Git preparation failed: ${result.stderr}`);
  return result.stdout;
}
