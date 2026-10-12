import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const LOCK_NAME = ".tiangz-dev.lock";
const TAKEOVER_SUFFIX = ".takeover";
/** 启动时间比较容差：吸收时钟微调与秒级精度；复用发生在锁写入后此窗口内时保守视为仍在运行。 / Start-time tolerance; reuse inside this window is conservatively treated as live. */
const START_TOLERANCE_MS = 2000;
const PROBE_TIMEOUT_MS = 15000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * 获取工程开发锁，防止两个构建/开发命令同时改写产物；返回只删除自己锁文件的释放函数。
 * Acquires the project development lock so two build/dev commands never rewrite outputs together; returns a release that removes only its own lock.
 *
 * 已有锁时只在能确认记录的进程已退出（PID 不存在，或该 PID 现属于锁写入之后才启动的进程）时清除，并打印一行原锁信息；
 * 锁内容无法识别、来自其他主机或读不到进程信息时保守视为仍被占用并拒绝。清除通过接管文件串行化，并发命令只有一个接管。
 * An existing lock is cleared (with one log line) only when its process is proven gone (PID absent, or now owned by a process started after the lock was written);
 * unreadable content, another host or missing process information is treated as held. Takeover is serialized by a takeover file so only one concurrent command wins.
 *
 * options.probe 与 options.log 仅供测试替换进程探测与输出。 / options.probe and options.log only let tests replace process probing and output.
 */
export async function acquireGameProjectLock(project, action, options = {}) {
  const file = path.join(project.root, LOCK_NAME);
  const probe = { ...defaultProbe, ...options.probe };
  const log = options.log ?? (line => process.stderr.write(`${line}\n`));
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    const handle = await open(file, "wx").catch(error => { if (error.code === "EEXIST") return undefined; throw error; });
    if (handle) return writeOwner(handle, file, action, probe);
    const observed = await readExisting(file);
    if (!observed) continue;
    const verdict = await judgeLock(observed.record, probe);
    last = { observed, verdict };
    if (!verdict.stale) break;
    const outcome = await removeStaleLock(file, observed.bytes, action);
    if (outcome === "busy") throw new Error(`另一命令正在接管残留开发锁：${file}。稍后重试；若持续出现且没有开发命令在运行，确认后手动删除 ${file}${TAKEOVER_SUFFIX}。`);
    if (outcome === "removed") log(`[dev-lock] 已清除残留开发锁 ${file}（${describe(observed.record)}）：${verdict.reason}；继续执行 ${action}。`);
  }
  const detail = last ? `（${describe(last.observed.record)}）：${last.verdict.reason}` : "";
  throw new Error(`已有开发命令占用工程：${file}${detail}。等待该命令结束后重试；只有确认记录的进程不是开发命令且已停止时才手动移除锁。`);
}

/**
 * 把 ps -o lstart= 在 LC_ALL=C、TZ=UTC 下的输出解析为 UTC 毫秒；格式不符返回 undefined。
 * Parses `ps -o lstart=` output produced under LC_ALL=C and TZ=UTC into UTC milliseconds; returns undefined on mismatch.
 */
export function parsePsStartTime(text) {
  const match = /^\s*[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(text ?? "");
  if (!match) return undefined;
  const month = MONTHS.indexOf(match[1]);
  if (month < 0) return undefined;
  return Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]));
}

async function writeOwner(handle, file, action, probe) {
  const token = randomUUID();
  const record = { pid: process.pid, action, startedAt: new Date().toISOString(), hostname: os.hostname(), token };
  const identity = await probe.selfIdentity().catch(() => undefined);
  if (identity) record.processIdentity = identity;
  try { await handle.writeFile(JSON.stringify(record)); }
  catch (error) { await handle.close(); await unlink(file); throw error; }
  return async () => {
    await handle.close();
    let current;
    try { current = JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return; throw error; }
    if (current?.token === token) await unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; });
  };
}

async function readExisting(file) {
  let bytes;
  try { bytes = await readFile(file); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  let record;
  try { record = JSON.parse(bytes.toString("utf8")); } catch { record = undefined; }
  return { bytes, record: record && typeof record === "object" ? record : undefined };
}

/** 判定锁是否残留；任何无法确认的情况都返回 stale=false。 / Decides whether a lock is stale; anything unconfirmed yields stale=false. */
async function judgeLock(record, probe) {
  const lockTime = Date.parse(record?.startedAt);
  if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 0 || !Number.isFinite(lockTime)) return held("锁内容无法识别（可能正在写入或格式不符）");
  if (record.hostname !== undefined && record.hostname !== os.hostname()) return held(`锁由主机 ${record.hostname} 写入，无法在本机核对其进程`);
  const exists = await probe.exists(record.pid).catch(() => undefined);
  if (exists === false) return { stale: true, reason: "记录的进程已不存在" };
  if (exists !== true) return held("无法确认记录的进程状态，保守视为仍在运行");
  const start = await probe.start(record.pid).catch(() => undefined);
  if (record.processIdentity && start?.identity) {
    return start.identity === record.processIdentity ? held("记录的进程仍在运行") : { stale: true, reason: "该 PID 已被其他进程复用（进程启动身份不同）" };
  }
  if (Number.isFinite(start?.startedAtMs)) {
    if (start.startedAtMs > lockTime + START_TOLERANCE_MS) return { stale: true, reason: `该 PID 已被其他进程复用（现进程启动于 ${new Date(start.startedAtMs).toISOString()}，晚于锁记录）` };
    return held("记录的进程仍在运行");
  }
  if (await probe.exists(record.pid).catch(() => undefined) === false) return { stale: true, reason: "记录的进程已不存在" };
  return held("读取不到进程启动时间，保守视为仍在运行");
}

function held(reason) { return { stale: false, reason }; }

/**
 * 持有接管文件时重新读取并逐字节比对，仍是判定为残留的那份锁才删除；接管文件已存在时不等待。
 * Under the takeover file, re-reads and byte-compares the lock and deletes it only if it is still the lock judged stale; does not wait when the takeover file exists.
 */
async function removeStaleLock(file, staleBytes, action) {
  const guardFile = `${file}${TAKEOVER_SUFFIX}`;
  let guard;
  try { guard = await open(guardFile, "wx"); }
  catch (error) { if (error.code === "EEXIST") return "busy"; throw error; }
  try {
    await guard.writeFile(JSON.stringify({ pid: process.pid, action, startedAt: new Date().toISOString(), hostname: os.hostname() }));
    let current;
    try { current = await readFile(file); }
    catch (error) { if (error.code === "ENOENT") return "gone"; throw error; }
    if (!current.equals(staleBytes)) return "changed";
    try { await unlink(file); }
    catch (error) { if (error.code === "ENOENT") return "gone"; throw error; }
    return "removed";
  } finally {
    await guard.close();
    await unlink(guardFile).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

function describe(record) {
  if (!record) return "锁内容无法识别";
  return `PID ${record.pid ?? "?"}，action=${record.action ?? "?"}，startedAt=${record.startedAt ?? "?"}${record.hostname ? `，host=${record.hostname}` : ""}`;
}

const defaultProbe = {
  /** true=存在，false=确认不存在，undefined=无法确认。EPERM 表示存在但无权操作。 / true=exists, false=confirmed absent, undefined=unknown; EPERM means it exists. */
  async exists(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) {
      if (error.code === "ESRCH") return false;
      if (error.code === "EPERM") return true;
      return undefined;
    }
  },
  /** 返回 { identity?, startedAtMs? }；取不到返回 undefined。 / Returns { identity?, startedAtMs? }, or undefined when unavailable. */
  async start(pid) {
    if (process.platform === "win32") return { startedAtMs: await windowsCreationTime(pid) };
    const linux = process.platform === "linux" ? await linuxStart(pid) : undefined;
    let startedAtMs = linux?.startedAtMs;
    if (startedAtMs === undefined) startedAtMs = parsePsStartTime(await run("ps", ["-o", "lstart=", "-p", String(pid)], { ...process.env, LC_ALL: "C", TZ: "UTC" }));
    return { identity: linux?.identity, startedAtMs };
  },
  /** 写锁时记录本进程的精确启动身份；只有 Linux 能低成本取得（boot_id + 启动 tick）。 / Exact start identity of this process; only cheap on Linux. */
  async selfIdentity() { return process.platform === "linux" ? (await linuxStart("self", false))?.identity : undefined; },
};

async function windowsCreationTime(pid) {
  const script = `$p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${Number(pid)}' -ErrorAction Stop; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') }`;
  const output = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], process.env);
  const value = Date.parse(output?.trim() ?? "");
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Linux：identity 为 boot_id + 启动 tick（精确）；startedAtMs 为 btime + tick/CLK_TCK（btime 截到秒，只会偏早），供旧格式锁使用。
 * Linux: identity is boot_id + start ticks (exact); startedAtMs is btime + ticks/CLK_TCK (btime truncates, so only earlier) for old-format locks.
 */
async function linuxStart(pid, withTime = true) {
  let ticks;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // comm 字段可能含空格和括号，从最后一个 ')' 之后计数；starttime 是第 22 个字段。 / comm may contain spaces; field 22 (starttime) is counted after the last ')'.
    ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch { return undefined; }
  if (!/^\d+$/.test(ticks ?? "")) return undefined;
  const bootId = await readFile("/proc/sys/kernel/random/boot_id", "utf8").then(text => text.trim(), () => "");
  if (!withTime) return { identity: bootId ? `linux:${bootId}:${ticks}` : undefined };
  const btime = await readFile("/proc/stat", "utf8").then(text => /^btime\s+(\d+)$/m.exec(text)?.[1], () => undefined);
  const clockTicks = Number((await run("getconf", ["CLK_TCK"], process.env))?.trim());
  const startedAtMs = btime && Number.isSafeInteger(clockTicks) && clockTicks > 0 ? Number(btime) * 1000 + Math.floor(Number(ticks) * 1000 / clockTicks) : undefined;
  return { identity: bootId ? `linux:${bootId}:${ticks}` : undefined, startedAtMs };
}

function run(command, args, env) {
  return new Promise(resolve => {
    execFile(command, args, { env, encoding: "utf8", timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => resolve(error ? undefined : stdout));
  });
}
