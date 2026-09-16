import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, unlink, symlink, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { publishClientSdk } from "./client_sdk_publish.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tiangz-client-publish-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const engineRoot = path.join(root, "engine");
  const projectRoot = path.join(root, "game");
  const source = path.join(engineRoot, "client_sdk/typescript");
  await mkdir(source, { recursive: true });
  await mkdir(projectRoot);
  await writeFile(path.join(source, "Client.ts"), "export const version = 1;\n");
  const config = { formatVersion: 1, sdkTargets: [{ language: "typescript", output: "client/Generated/SDK" }], handlerTargets: [] };
  const configure = () => writeFile(path.join(projectRoot, "tiangz.clients.json"), JSON.stringify(config));
  await configure();
  return { engineRoot, projectRoot, source, config, configure, output: path.join(projectRoot, "client/Generated/SDK/Client.ts") };
}

test("publishes idempotently, excludes bench and preserves editor metadata", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.source, "Generated/Model/bench"), { recursive: true });
  await writeFile(path.join(f.source, "Generated/Model/bench/Bench.ts"), "bench");
  assert.equal((await publishClientSdk(f)).files, 1);
  await writeFile(f.output + ".meta", "editor uuid");
  assert.equal((await publishClientSdk(f)).changed, 0);
  await publishClientSdk({ ...f, check: true });
  assert.equal(await readFile(f.output + ".meta", "utf8"), "editor uuid");
});

test("project-owned SDK composition stays contained and cannot overlap its outputs", async t => {
  const f = await fixture(t);
  const source = path.join(f.projectRoot, "sdk");
  await mkdir(source); await writeFile(path.join(source, "Game.ts"), "export const game = 1;\n");
  f.config.sdkTargets[0].source = "sdk";
  await f.configure();
  assert.equal((await publishClientSdk(f)).files, 1);
  f.config.sdkTargets[0].source = "../engine";
  await f.configure();
  await assert.rejects(publishClientSdk(f), /path|escape|relative/i);
  f.config.sdkTargets[0].source = f.config.sdkTargets[0].output;
  await f.configure();
  await assert.rejects(publishClientSdk(f), /overlap/);
});

test("check detects drift without writing; publishing rejects edited outputs", async (t) => {
  const f = await fixture(t);
  await publishClientSdk(f);
  await writeFile(path.join(f.source, "Client.ts"), "export const version = 2;\n");
  await assert.rejects(publishClientSdk({ ...f, check: true }), /stale/);
  assert.match(await readFile(f.output, "utf8"), /version = 1/);
  await publishClientSdk(f);
  await writeFile(f.output, "hand edited");
  await assert.rejects(publishClientSdk(f), /was edited/);
  assert.equal(await readFile(f.output, "utf8"), "hand edited");
});

test("removes only unchanged obsolete generated files", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "Old.ts"), "old");
  await publishClientSdk(f);
  await unlink(path.join(f.source, "Old.ts"));
  assert.equal((await publishClientSdk(f)).removed, 1);
  await assert.rejects(readFile(path.join(path.dirname(f.output), "Old.ts")), { code: "ENOENT" });
});

test("rejects escaping and overlapping output paths before publication", async (t) => {
  const f = await fixture(t);
  f.config.sdkTargets.push({ language: "typescript", output: "../escape" });
  await f.configure();
  await assert.rejects(publishClientSdk(f), /escapes/);
  await assert.rejects(readFile(f.output), { code: "ENOENT" });
  f.config.sdkTargets[1].output = "client/Generated";
  await f.configure();
  await assert.rejects(publishClientSdk(f), /overlapping/);
});

test("rejects output directory junctions", async (t) => {
  const f = await fixture(t);
  await symlink(f.engineRoot, path.join(f.projectRoot, "client"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(publishClientSdk(f), /links are forbidden/);
});

test("generates handler imports from project-owned source", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.projectRoot, "client/Handlers"), { recursive: true });
  await writeFile(path.join(f.projectRoot, "client/Handlers/HelloHandler.ts"), "export {};");
  f.config.handlerTargets.push({ source: "client", output: "client/Generated/Hotfix/handlers.ts" });
  await f.configure();
  await publishClientSdk(f);
  assert.match(await readFile(path.join(f.projectRoot, "client/Generated/Hotfix/handlers.ts"), "utf8"), /\.\.\/\.\.\/Handlers\/HelloHandler/);
});

test("manifest cannot authorize deleting unrelated project files", async (t) => {
  const f = await fixture(t);
  await publishClientSdk(f);
  const manifest = path.join(f.projectRoot, ".tiangz/client-sdk.manifest.json");
  const value = JSON.parse(await readFile(manifest, "utf8"));
  value.files["README.md"] = "bad hash";
  await writeFile(manifest, JSON.stringify(value));
  await writeFile(path.join(f.projectRoot, "README.md"), "user content");
  await assert.rejects(publishClientSdk(f), /no longer declared/);
  assert.equal(await readFile(path.join(f.projectRoot, "README.md"), "utf8"), "user content");
});
