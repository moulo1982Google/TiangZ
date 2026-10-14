import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");

test("Git can merge unconflicting protocol locks into a collision; formal check rejects it without writes", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "tiangz-protocol-merge-"));
  const modules = path.join(temporary, "modules"), moduleRoot = path.join(modules, "example");
  try {
    for (const folder of ["src/model", "src/hotfix", "proto"]) await mkdir(path.join(moduleRoot, folder), { recursive: true });
    await writeFile(path.join(moduleRoot, "src/model/index.ts"), "export {};\n");
    await writeFile(path.join(moduleRoot, "src/hotfix/index.ts"), "export {};\n");
    await writeFile(path.join(moduleRoot, "tiangz.module.json"), JSON.stringify({ formatVersion: 1, id: "org.example.merge",
      version: "1.0.0", engine: { minVersion: "0.7.0", maxVersionExclusive: "0.8.0" }, dependencies: [],
      entries: { model: "src/model/index.ts", hotfix: "src/hotfix/index.ts" }, protocol: { source: "proto",
        opcodeLock: "proto/opcode.lock.json", schemaLock: "proto/schema.lock.json", serverOutput: "src/model/generated/protocol",
        typescriptOutput: "generated/typescript", generateGodot: false, godotOutput: "generated/godot", godotClassName: "MergeProto" } }));
    await addProto("Base");
    generate(["--update-locks"]);
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Protocol fixture"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    git(["config", "core.autocrlf", "false"]);
    git(["add", "--", "proto"]); git(["commit", "-m", "baseline"]);
    const base = git(["rev-parse", "HEAD"]).stdout.trim();
    git(["switch", "-c", "alpha"]);
    await addProto("Alpha"); generate(["--update-locks"]);
    git(["add", "--", "proto"]); git(["commit", "-m", "alpha protocol"]);
    git(["switch", "-c", "zulu", base]);
    await addProto("Zulu"); generate(["--update-locks"]);
    git(["add", "--", "proto"]); git(["commit", "-m", "zulu protocol"]);
    git(["merge", "--no-ff", "alpha", "-m", "merge protocols without textual conflict"]);
    assert.equal(git(["status", "--porcelain", "--untracked-files=no"]).stdout.trim(), "");
    const opcodeFile = path.join(moduleRoot, "proto/opcode.lock.json");
    const lock = JSON.parse(await readFile(opcodeFile, "utf8"));
    assert.equal(lock.entries.length, 6);
    assert.equal(new Set(lock.entries.map(entry => entry.code)).size, 4, "independent branches should occupy the same two new codes");
    const before = await snapshot(moduleRoot);
    const collided = generate(["--check"], false);
    assert.notEqual(collided.status, 0);
    assert.match(collided.stderr, /msgcode collision/);
    assert.match(collided.stderr, /Alpha/); assert.match(collided.stderr, /Zulu/);
    assert.match(collided.stderr, /opcode\.lock\.json/);
    assert.deepEqual(await snapshot(moduleRoot), before, "failed check must not rewrite locks, source, output or mtimes");
    // 夹具模拟后合入分支只撤回自己的未发布编号，再由正式生成器分配。
    // Simulate withdrawing only the fixture branch's unpublished codes before formal regeneration.
    const withdrawn = lock.entries.filter(entry => !entry.key.includes("Zulu"));
    assert.equal(lock.entries.length - withdrawn.length, 2);
    await writeFile(opcodeFile, `${JSON.stringify({ ...lock, entries: withdrawn }, null, 2)}\n`);
    generate(["--update-locks"]);
    generate(["--check"]);
    const resolved = JSON.parse(await readFile(opcodeFile, "utf8"));
    assert.equal(new Set(resolved.entries.map(entry => entry.code)).size, 6);
    const repeatedBefore = await snapshot(moduleRoot);
    generate(["--check"]);
    assert.deepEqual(await snapshot(moduleRoot), repeatedBefore);
    const duplicateBytes = await readFile(opcodeFile);
    await writeFile(opcodeFile, JSON.stringify({ ...resolved, entries: [...resolved.entries, resolved.entries[0]] }));
    const malformedBefore = await snapshot(moduleRoot);
    const duplicated = generate(["--check"], false);
    assert.notEqual(duplicated.status, 0);
    assert.match(duplicated.stderr, /opcode lock contains a duplicate or invalid key/);
    assert.deepEqual(await snapshot(moduleRoot), malformedBefore);
    await writeFile(opcodeFile, duplicateBytes);

    async function addProto(name) { await writeFile(path.join(moduleRoot, `proto/${name}_C_33000.proto`),
      `syntax = "proto3";\npackage ${name.toLowerCase()};\n//ResponseType S2C_${name}Ping\n// @ets.msg protocol=${name} method=Ping\nmessage C2S_${name}Ping // IRequest\n{ string text = 1; }\nmessage S2C_${name}Ping // IResponse\n{ string text = 1; }\n`); }
    function generate(args, success = true) { return run(process.execPath,
      [path.join(root, "tools/codegen_module_protocol.mjs"), "--modules-dir", modules, "--host-profile", "modules", ...args], root, success); }
    function git(args) { return run("git", args, moduleRoot); }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

/** 快照包含内容和mtime；忽略夹具Git元数据，不忽略任何模块生成物。 / Snapshot content and mtimes, excluding fixture Git metadata only. */
async function snapshot(directory) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(file);
      else files.push({ path: path.relative(directory, file), bytes: (await readFile(file)).toString("base64"), mtime: (await stat(file)).mtimeMs });
    }
  }
  await visit(directory);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function run(command, args, cwd, success = true) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, TIANGZ_LOCK_VERSIONS: "" } });
  if (result.error) throw result.error;
  if (success) assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result;
}
