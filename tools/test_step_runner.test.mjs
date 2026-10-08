import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { runTestStep } from "./test_step_runner.mjs";

const root = path.resolve(import.meta.dirname, "..");
const nodeStep = (script, args = [], timeoutMs = 10_000) => ({ command: process.execPath, args: ["-e", script, ...args], timeoutMs });
const execute = (step, options = {}) => runTestStep(step, { cwd: root, captureOutput: true, ...options });

test("steps preserve arguments, environment, exit codes and bounded UTF-8 output", async () => {
  const args = ["", "space here", "中文", 'quote"inside', 'slash\\"quote', "trailing\\", "$(not-a-command)", "`literal`", "a&b;c"];
  const result = await execute(nodeStep('console.log(JSON.stringify({args:process.argv.slice(1),value:process.env.TIANGZ_STEP_TEST}));', args), {
    env: { ...process.env, TIANGZ_STEP_TEST: "isolated" },
  });
  assert.equal(result.status, "passed", result.output);
  assert.deepEqual(JSON.parse(result.output), { args, value: "isolated" });
  const failure = await execute(nodeStep('process.stderr.write("known failure"); process.exit(7)'));
  assert.equal(failure.status, "failed");
  assert.equal(failure.exitCode, 7);
  assert.match(failure.output, /known failure/);
  const large = await execute(nodeStep('process.stdout.write("x".repeat(8192)+"THE_END");'), { maxOutputBytes: 256 });
  assert.equal(large.status, "passed", large.output);
  assert.equal(large.outputTruncated, true);
  assert.ok(Buffer.byteLength(large.output) < 400);
  assert.match(large.output, /output truncated/);
  assert.ok(large.output.endsWith("THE_END"));
});

test("unavailable executables fail without an unowned fallback", async () => {
  const result = await execute({ command: path.join(root, "temp/nonexistent-test-command"), args: [], timeoutMs: 10_000 });
  assert.equal(result.status, "failed");
  assert.notEqual(result.exitCode, 0);
  const noArgs = await execute({ command: process.platform === "win32" ? path.join(process.env.SystemRoot, "System32/whoami.exe") : "/bin/true", args: [], timeoutMs: 10_000 });
  assert.equal(noArgs.status, "passed", noArgs.error);
});

async function createTree(leakAfterExit = false) {
  await mkdir(path.join(root, "temp"), { recursive: true });
  const fixture = await mkdtemp(path.join(root, "temp/test-step-tree-"));
  const identity = path.join(fixture, "identity.json");
  const grandchild = `const net=require("node:net");
const server=net.createServer();
server.listen(0,"127.0.0.1",()=>process.send({pid:process.pid,port:server.address().port}));
setInterval(()=>{},1000);`;
  const parent = `const {spawn}=require("node:child_process"); const fs=require("node:fs");
const child=spawn(process.execPath,["-e",${JSON.stringify(grandchild)}],{stdio:["ignore","inherit","inherit","ipc"],windowsHide:true,detached:process.platform==="win32"});
child.on("message",info=>{ fs.writeFileSync(process.argv[1],JSON.stringify({...info,parent:process.pid})); ${leakAfterExit ? "process.exit(0);" : ""} });
setInterval(()=>{},1000);`;
  return { step: nodeStep(parent, [identity]), identity };
}

async function waitIdentity(file) {
  for (let i = 0; i < 150; i++) {
    try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await delay(20);
  }
  assert.fail(`fixture did not start: ${file}`);
}

async function assertReclaimed(info) {
  // 返回后立即重新绑定，不让后续 PID 消失的轮询掩盖端口尚未回收。 / Rebind immediately so PID polling cannot hide a lingering listener.
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(info.port, "127.0.0.1", resolve); });
  } finally { if (server.listening) await new Promise(resolve => server.close(resolve)); }
  for (const pid of [info.parent, info.pid]) {
    let alive = true;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") { alive = false; break; } throw error; }
      await delay(20);
    }
    assert.equal(alive, false, `owned process ${pid} survived`);
  }
}

test("timeout reclaims a live process tree and its TCP listener before returning", { timeout: 15_000 }, async () => {
  const fixture = await createTree();
  const started = performance.now();
  const result = await execute({ ...fixture.step, timeoutMs: 4_000 });
  assert.equal(result.status, "timed-out", JSON.stringify(result));
  assert.equal(result.exitCode, 124);
  assert.equal(result.cleanupFailed, false, JSON.stringify(result));
  assert.ok(performance.now() - started >= 3_900);
  assert.ok(performance.now() - started < 9_000);
  await assertReclaimed(await waitIdentity(fixture.identity));
});

test("abort reclaims the tree and an already-aborted step never starts", { timeout: 15_000 }, async () => {
  const fixture = await createTree();
  const controller = new AbortController();
  const running = execute(fixture.step, { signal: controller.signal });
  const info = await waitIdentity(fixture.identity);
  controller.abort();
  const result = await running;
  assert.equal(result.status, "aborted", JSON.stringify(result));
  assert.equal(result.exitCode, 130);
  await assertReclaimed(info);
  const skipped = await execute(nodeStep('throw new Error("must never execute");'), { signal: controller.signal });
  assert.equal(skipped.status, "aborted");
  assert.equal(skipped.output, "");
});

test("a successful root cannot leave a background service for the next step", { timeout: 15_000 }, async () => {
  const fixture = await createTree(true);
  const result = await execute(fixture.step);
  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.equal(result.exitCode, 125);
  await assertReclaimed(await waitIdentity(fixture.identity));
});

test("a nested step is reclaimed when its owning matrix process disappears", { timeout: 15_000 }, async () => {
  const fixture = await createTree();
  const entry = pathToFileURL(path.join(root, "tools/test_step_runner.mjs")).toString();
  const script = `import(${JSON.stringify(entry)}).then(async ({runTestStep}) => {
    const result = await runTestStep(${JSON.stringify({ ...fixture.step, timeoutMs: 20_000 })}, {cwd:${JSON.stringify(root)}});
    process.exit(result.exitCode);
  });`;
  const controller = new AbortController();
  const running = execute(nodeStep(script), { signal: controller.signal });
  const info = await waitIdentity(fixture.identity);
  controller.abort();
  const result = await running;
  assert.equal(result.status, "aborted", JSON.stringify(result));
  assert.equal(result.cleanupFailed, false, JSON.stringify(result));
  await assertReclaimed(info);
});
