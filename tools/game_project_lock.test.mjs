import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { acquireGameProjectLock, parsePsStartTime } from "./game_project_lock.mjs";

const engine = path.resolve(import.meta.dirname, "..");
const lockModule = pathToFileURL(path.join(import.meta.dirname, "game_project_lock.mjs")).href;
let temporary;
let counter = 0;

before(async () => {
  await mkdir(path.join(engine, "temp"), { recursive: true });
  temporary = await mkdtemp(path.join(engine, "temp", "dev-lock-"));
});
after(async () => { await rm(temporary, { recursive: true, force: true }); });

async function freshProject() {
  const root = path.join(temporary, `project-${++counter}`);
  await mkdir(root, { recursive: true });
  return { root, file: path.join(root, ".tiangz-dev.lock") };
}
function collect() {
  const lines = [];
  return { lines, log: line => lines.push(line) };
}
/** 已退出子进程的 PID；退出后才写锁，模拟控制台被直接关闭的开发命令。 / PID of an exited child, as a closed console leaves behind. */
function exitedPid() {
  const result = spawnSync(process.execPath, ["-e", ""], { windowsHide: true });
  assert.equal(result.status, 0);
  return result.pid;
}
async function liveChild() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  return child;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise(resolve => child.once("close", resolve));
  child.kill();
  await closed;
}

test("新锁记录持有者身份，释放时删除", async () => {
  const { root, file } = await freshProject();
  const release = await acquireGameProjectLock({ root }, "build");
  const record = JSON.parse(await readFile(file, "utf8"));
  assert.equal(record.pid, process.pid);
  assert.equal(record.action, "build");
  assert.equal(record.hostname, os.hostname());
  assert.match(record.token, /^[0-9a-f-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(record.startedAt)));
  if (process.platform === "linux") assert.match(record.processIdentity, /^linux:/);
  await release();
  await assert.rejects(access(file), { code: "ENOENT" });
});

test("记录的进程已不存在：打印原锁信息后清除并继续（兼容旧格式）", async () => {
  const { root, file } = await freshProject();
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const pid = exitedPid();
  await writeFile(file, JSON.stringify({ pid, action: "dev", startedAt }));
  const { lines, log } = collect();
  const release = await acquireGameProjectLock({ root }, "check", { log });
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], new RegExp(`PID ${pid}`));
  assert.match(lines[0], /action=dev/);
  assert.ok(lines[0].includes(startedAt), lines[0]);
  assert.match(lines[0], /已清除/);
  assert.equal(JSON.parse(await readFile(file, "utf8")).pid, process.pid);
  await release();
  await assert.rejects(access(path.join(root, ".tiangz-dev.lock.takeover")), { code: "ENOENT" });
});

test("持锁进程被强制终止（不执行 finally）后，下一次命令自动清除新格式锁", async () => {
  const { root, file } = await freshProject();
  const script = `
    const { acquireGameProjectLock } = await import(${JSON.stringify(lockModule)});
    await acquireGameProjectLock({ root: ${JSON.stringify(root)} }, "dev");
    process.stdout.write("ACQUIRED\\n");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  await new Promise((resolve, reject) => { child.stdout.on("data", bytes => { if (String(bytes).includes("ACQUIRED")) resolve(); }); child.once("error", reject); });
  await assert.rejects(acquireGameProjectLock({ root }, "build", { log: () => assert.fail("live holder must not be cleared") }), /已有开发命令占用工程/);
  await stop(child);
  const record = JSON.parse(await readFile(file, "utf8"));
  assert.equal(record.pid, child.pid);
  const { lines, log } = collect();
  const release = await acquireGameProjectLock({ root }, "build", { log });
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.ok(lines[0].includes(`PID ${child.pid}，action=dev，startedAt=${record.startedAt}`), lines[0]);
  await release();
});

test("记录的进程仍在运行且启动早于锁：照旧拒绝且不改锁", async () => {
  const { root, file } = await freshProject();
  const child = await liveChild();
  try {
    const content = JSON.stringify({ pid: child.pid, action: "dev", startedAt: new Date().toISOString() });
    await writeFile(file, content);
    const { lines, log } = collect();
    await assert.rejects(acquireGameProjectLock({ root }, "check", { log }), /已有开发命令占用工程/);
    assert.deepEqual(lines, []);
    assert.equal(await readFile(file, "utf8"), content);
  } finally { await stop(child); }
});

test("PID 被复用（进程启动晚于锁记录）：判定残留并接管", async () => {
  const { root, file } = await freshProject();
  const startedAt = new Date(Date.now() - 3_600_000).toISOString();
  const child = await liveChild();
  try {
    await writeFile(file, JSON.stringify({ pid: child.pid, action: "dev", startedAt }));
    const { lines, log } = collect();
    const release = await acquireGameProjectLock({ root }, "build", { log });
    assert.equal(lines.length, 1, lines.join("\n"));
    assert.match(lines[0], /复用/);
    assert.equal(JSON.parse(await readFile(file, "utf8")).pid, process.pid);
    await release();
  } finally { await stop(child); }
});

test("读不到进程信息时保守视为仍在运行", async () => {
  for (const probe of [
    { exists: async () => undefined },
    { exists: async () => true, start: async () => undefined },
  ]) {
    const { root, file } = await freshProject();
    const content = JSON.stringify({ pid: 4242, action: "dev", startedAt: new Date(0).toISOString() });
    await writeFile(file, content);
    await assert.rejects(acquireGameProjectLock({ root }, "check", { probe, log: () => assert.fail("must not clear") }), /已有开发命令占用工程/);
    assert.equal(await readFile(file, "utf8"), content);
  }
});

test("无法识别的锁内容、其他主机的锁都不自动清除", async () => {
  const deadProbe = { exists: async () => false };
  for (const content of ["existing owner", "", JSON.stringify({ pid: 0, action: "dev", startedAt: "x" }), JSON.stringify({ pid: 4242, action: "dev", startedAt: new Date().toISOString(), hostname: `${os.hostname()}-other` })]) {
    const { root, file } = await freshProject();
    await writeFile(file, content);
    await assert.rejects(acquireGameProjectLock({ root }, "check", { probe: deadProbe, log: () => assert.fail("must not clear") }), /已有开发命令占用工程/);
    assert.equal(await readFile(file, "utf8"), content);
  }
});

test("同主机同一启动身份：即使锁时间异常也视为仍在运行", async () => {
  const { root, file } = await freshProject();
  const content = JSON.stringify({ pid: 4242, action: "dev", startedAt: new Date(0).toISOString(), hostname: os.hostname(), processIdentity: "linux:boot:1" });
  await writeFile(file, content);
  const probe = { exists: async () => true, start: async () => ({ identity: "linux:boot:1", startedAtMs: Date.now() }) };
  await assert.rejects(acquireGameProjectLock({ root }, "check", { probe }), /已有开发命令占用工程/);
  const reused = { exists: async () => true, start: async () => ({ identity: "linux:boot:2", startedAtMs: 0 }) };
  const { lines, log } = collect();
  const release = await acquireGameProjectLock({ root }, "check", { probe: reused, log });
  assert.match(lines[0], /复用/);
  await release();
});

test("同一进程内两个命令同时发现残留锁：只有一个接管", async () => {
  const { root, file } = await freshProject();
  await writeFile(file, JSON.stringify({ pid: 4242, action: "dev", startedAt: new Date(0).toISOString() }));
  let arrived = 0;
  let open;
  const barrier = new Promise(resolve => { open = resolve; });
  const probe = {
    exists: async pid => {
      if (pid !== 4242) return true;
      if (++arrived === 2) open();
      await barrier;
      return false;
    },
  };
  const { lines, log } = collect();
  const results = await Promise.allSettled([acquireGameProjectLock({ root }, "a", { probe, log }), acquireGameProjectLock({ root }, "b", { probe, log })]);
  const winners = results.filter(result => result.status === "fulfilled");
  assert.equal(winners.length, 1, JSON.stringify(results.map(result => result.reason?.message)));
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(results.find(result => result.status === "rejected").reason.message, /占用工程|正在接管/);
  await winners[0].value();
  await assert.rejects(access(file), { code: "ENOENT" });
  await assert.rejects(access(`${file}.takeover`), { code: "ENOENT" });
});

test("多个进程同时发现残留锁：只有一个接管", async () => {
  const { root, file } = await freshProject();
  await writeFile(file, JSON.stringify({ pid: exitedPid(), action: "dev", startedAt: new Date(Date.now() - 60_000).toISOString() }));
  const script = `
    const { acquireGameProjectLock } = await import(${JSON.stringify(lockModule)});
    try {
      const release = await acquireGameProjectLock({ root: ${JSON.stringify(root)} }, "race");
      process.stdout.write("ACQUIRED\\n");
      process.stdin.resume();
      process.stdin.once("end", async () => { await release(); process.exit(0); });
    } catch (error) { process.stdout.write("REJECTED " + error.message + "\\n"); process.exit(0); }
  `;
  const children = Array.from({ length: 4 }, () => spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true }));
  try {
    const outcomes = await Promise.all(children.map(child => new Promise((resolve, reject) => {
      let text = "";
      child.stdout.on("data", bytes => { text += bytes; if (text.includes("\n")) resolve(text.trim()); });
      child.once("error", reject);
      child.once("close", () => resolve(text.trim()));
    })));
    assert.equal(outcomes.filter(line => line === "ACQUIRED").length, 1, outcomes.join("\n"));
    assert.equal(outcomes.filter(line => line.startsWith("REJECTED")).length, 3, outcomes.join("\n"));
  } finally {
    await Promise.all(children.map(child => new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once("close", resolve);
      child.stdin.end();
    })));
  }
  await assert.rejects(access(file), { code: "ENOENT" });
});

test("接管文件已存在：报错附带接管者信息，不改锁与接管文件", async () => {
  const { root, file } = await freshProject();
  const lock = JSON.stringify({ pid: 4242, action: "dev", startedAt: new Date(0).toISOString() });
  const guard = JSON.stringify({ pid: 777, action: "build", startedAt: "2026-10-11T00:00:00.000Z", hostname: os.hostname() });
  await writeFile(file, lock);
  await writeFile(`${file}.takeover`, guard);
  await assert.rejects(acquireGameProjectLock({ root }, "check", { probe: { exists: async () => false } }), /正在接管.*接管者：PID 777，action=build，startedAt=2026-10-11T00:00:00.000Z/);
  assert.equal(await readFile(file, "utf8"), lock);
  assert.equal(await readFile(`${file}.takeover`, "utf8"), guard);
});

test("无权限删除残留锁：友好报错、不继续，锁保留且接管文件释放", async () => {
  for (const code of ["EACCES", "EPERM"]) {
    const { root, file } = await freshProject();
    const lock = JSON.stringify({ pid: 4242, action: "dev", startedAt: new Date(0).toISOString() });
    await writeFile(file, lock);
    const unlink = async () => { throw Object.assign(new Error(`${code}: denied`), { code }); };
    await assert.rejects(acquireGameProjectLock({ root }, "check", { probe: { exists: async () => false }, unlink, log: () => assert.fail("must not report cleared") }), new RegExp(`无权限删除残留开发锁.*PID 4242.*${code}`));
    assert.equal(await readFile(file, "utf8"), lock);
    await assert.rejects(access(`${file}.takeover`), { code: "ENOENT" });
  }
});

test("每次清除残留锁后都被其他命令抢先：报“多次被抢先”而不是“占用”", async () => {
  const { root, file } = await freshProject();
  let generation = 0;
  const writeStale = () => writeFileSync(file, JSON.stringify({ pid: 4242, action: "dev", startedAt: new Date(++generation * 1000).toISOString() }));
  writeStale();
  const lines = [];
  // 清除后、重新建锁前写入另一把残留锁，模拟其他命令每次都抢先。 / Recreate a stale lock right after each removal to simulate being preempted.
  const log = line => { lines.push(line); writeStale(); };
  await assert.rejects(acquireGameProjectLock({ root }, "check", { probe: { exists: async () => false }, log }), error => {
    assert.match(error.message, /多次尝试取得开发锁均被其他命令抢先/);
    assert.doesNotMatch(error.message, /占用工程/);
    return true;
  });
  assert.equal(lines.length, 3);
});

test("释放只删除仍属于自己的锁", async () => {
  const { root, file } = await freshProject();
  const release = await acquireGameProjectLock({ root }, "build");
  await writeFile(file, "someone else");
  await release();
  assert.equal(await readFile(file, "utf8"), "someone else");
});

test("ps 启动时间按 UTC 解析，格式不符时返回未知", () => {
  assert.equal(parsePsStartTime("Sun Oct 11 14:03:12 2026\n"), Date.UTC(2026, 9, 11, 14, 3, 12));
  assert.equal(parsePsStartTime("Mon Feb  2 01:02:03 2026"), Date.UTC(2026, 1, 2, 1, 2, 3));
  assert.equal(parsePsStartTime(""), undefined);
  assert.equal(parsePsStartTime("11 Okt 2026"), undefined);
});
