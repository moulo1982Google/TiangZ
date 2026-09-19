// 持久化写法长稳用例的纯逻辑：账本、不变量、故障计划。不访问进程、Docker或数据库，便于单测。
// Pure logic for the persistence write-mode soak: ledger, invariants and fault plan. No process,
// Docker or database access, so it is unit-testable.

export const NAMESPACES = Object.freeze({
  direct: "wms.direct.v1",
  queued: "wms.queued.v1",
  wallet: "wms.wallet.v1",
});
export const WALLET_TOTAL = 2000;
export const MODES = Object.freeze(["direct", "queued", "wallet"]);

/**
 * 故障目录。estimateSeconds 是注入加恢复的保守估计，只用来判断时长能否覆盖一整轮，不缩减任何动作。
 * Fault catalogue. estimateSeconds is a conservative inject+recover estimate used only to reject
 * durations that cannot cover a full cycle; no action is ever shortened to fit.
 */
export const FAULTS = Object.freeze({
  postgres: { estimateSeconds: 95, needsContainers: true, summary: "停止PG 65秒：普通/事务写入暂不可用或结果未知，排队写继续由AOF确认" },
  redis: { estimateSeconds: 55, needsContainers: true, summary: "强杀可靠Redis 35秒：排队写失败，普通/事务写入不受影响" },
  cache: { estimateSeconds: 55, needsContainers: true, summary: "强杀缓存Redis 35秒：三种写法都应继续，读取回源PG" },
  aof: { estimateSeconds: 125, needsContainers: true, summary: "PG停机期间积累排队写，强杀并重启可靠Redis，立即核对恢复出的积压，再恢复PG：已确认排队写不得丢失（memory确认档位只要求强杀3秒前的确认）" },
  "dbproxy-primary": { estimateSeconds: 40, needsContainers: false, summary: "强杀探针首选DBProxy节点20秒：客户端切换到备用节点" },
  "dbproxy-all": { estimateSeconds: 45, needsContainers: false, summary: "强杀全部DBProxy节点20秒：所有写法结果未知，恢复后按原身份重试或对账" },
  "probe-restart": { estimateSeconds: 40, needsContainers: false, summary: "强杀TiangZ探针进程后重启：新进程从PG恢复并按账本核对" },
});
export const FULL_FAULT_ORDER = Object.freeze(["postgres", "redis", "cache", "aof", "dbproxy-primary", "dbproxy-all", "probe-restart"]);

/** 计算一整轮所需时长；覆盖不了全部动作时直接失败，不以部分覆盖冒充通过。
 * Computes one full cycle; fails when the duration cannot cover every action instead of passing partial coverage.
 */
export function planSchedule({ seconds, faults = FULL_FAULT_ORDER, steadySeconds = 60 }) {
  if (!Number.isInteger(seconds) || seconds <= 0) throw new Error("seconds must be a positive integer");
  if (!Number.isInteger(steadySeconds) || steadySeconds < 0) throw new Error("steadySeconds must be a non-negative integer");
  if (faults.length === 0) throw new Error("at least one fault is required");
  const seen = new Set();
  for (const fault of faults) {
    if (!Object.hasOwn(FAULTS, fault)) throw new Error(`unknown fault ${fault}`);
    if (seen.has(fault)) throw new Error(`duplicate fault ${fault}`);
    seen.add(fault);
  }
  const cycleSeconds = faults.reduce((sum, fault) => sum + FAULTS[fault].estimateSeconds + steadySeconds, 0);
  if (seconds < cycleSeconds) {
    throw new Error(`duration ${seconds}s cannot cover one full fault cycle (${cycleSeconds}s); increase --seconds, never shorten faults`);
  }
  return { seconds, steadySeconds, order: [...faults], cycleSeconds, estimatedCycles: Math.floor(seconds / cycleSeconds) };
}

export function assertCoverage(order, completed) {
  const missing = order.filter((fault) => !completed.includes(fault));
  if (missing.length) throw new Error(`fault coverage incomplete: ${missing.join(",")}`);
}

/** 每个虚拟玩家、每种写法的最近确认值与在途值。 / Latest acknowledged and in-flight values per virtual player and mode. */
export function createLedger(players) {
  if (!Number.isInteger(players) || players < 1) throw new Error("players must be a positive integer");
  const ledger = { players, direct: [], queued: [], wallet: [], acks: { direct: 0, queued: 0, wallet: 0 }, violations: [] };
  for (let p = 0; p < players; p++) {
    ledger.direct.push({ acked: 0, pending: null, acks: 0 });
    ledger.queued.push({ acked: 0, attempted: 0, acks: 0, maxRollback: 0 });
    // n=-1 表示两个钱包尚未创建；创建本身是 n=0 的事务。 / n=-1 means wallets do not exist yet; creation is transaction n=0.
    ledger.wallet.push({ acked: -1, pending: null, acks: 0 });
  }
  return ledger;
}

function violation(ledger, what, detail) {
  const entry = { what, ...detail };
  ledger.violations.push(entry);
  return entry;
}

function player(ledger, p) {
  if (!Number.isInteger(p) || p < 0 || p >= ledger.players) throw new Error(`probe event has invalid player ${p}`);
  return p;
}

/**
 * 按探针事件更新账本。意图必须先于执行写出，因此进程在任意时刻被杀，账本都知道可能已提交的最大值。
 * Applies a probe event. Intents are written before execution, so a kill at any instant still leaves
 * the ledger aware of the largest value that might have committed.
 */
export function applyProbeEvent(ledger, event) {
  switch (event.t) {
    case "di": {
      const entry = ledger.direct[player(ledger, event.p)];
      if (event.v !== entry.acked + 1) return violation(ledger, "direct-intent-out-of-order", { p: event.p, v: event.v, acked: entry.acked });
      entry.pending = event.v;
      return undefined;
    }
    case "da": {
      const entry = ledger.direct[player(ledger, event.p)];
      if (event.v !== entry.acked + 1 || event.r !== event.v) {
        return violation(ledger, "direct-ack-invalid", { p: event.p, v: event.v, r: event.r, acked: entry.acked });
      }
      entry.acked = event.v; entry.pending = null; entry.acks += 1; ledger.acks.direct += 1;
      return undefined;
    }
    case "dr": {
      const entry = ledger.direct[player(ledger, event.p)];
      if (event.c === true) {
        if (event.v !== entry.pending) return violation(ledger, "direct-reconcile-unknown", { p: event.p, v: event.v, pending: entry.pending });
        entry.acked = event.v; entry.pending = null; entry.acks += 1; ledger.acks.direct += 1;
      }
      return undefined;
    }
    case "qi": {
      const entry = ledger.queued[player(ledger, event.p)];
      if (event.v <= entry.attempted) return violation(ledger, "queued-intent-not-increasing", { p: event.p, v: event.v, attempted: entry.attempted });
      entry.attempted = event.v;
      return undefined;
    }
    case "qa": {
      const entry = ledger.queued[player(ledger, event.p)];
      if (event.v > entry.attempted || event.v <= entry.acked) {
        return violation(ledger, "queued-ack-invalid", { p: event.p, v: event.v, acked: entry.acked, attempted: entry.attempted });
      }
      entry.acked = event.v; entry.acks += 1; ledger.acks.queued += 1;
      return undefined;
    }
    case "wi": {
      const entry = ledger.wallet[player(ledger, event.p)];
      if (event.n !== entry.acked + 1) return violation(ledger, "wallet-intent-out-of-order", { p: event.p, n: event.n, acked: entry.acked });
      entry.pending = event.n;
      return undefined;
    }
    case "wa": {
      const entry = ledger.wallet[player(ledger, event.p)];
      if (event.n !== entry.pending) return violation(ledger, "wallet-ack-unknown", { p: event.p, n: event.n, pending: entry.pending });
      const problem = walletProblem({ a: event.a, b: event.b });
      if (problem) return violation(ledger, "wallet-ack-invariant", { p: event.p, n: event.n, problem });
      if (event.a.seq !== event.n) return violation(ledger, "wallet-ack-sequence", { p: event.p, n: event.n, seq: event.a.seq });
      entry.acked = event.n; entry.pending = null; entry.acks += 1; ledger.acks.wallet += 1;
      return undefined;
    }
    case "violation":
      return violation(ledger, `probe:${event.what}`, event.detail ?? {});
    default:
      return undefined;
  }
}

/** 钱包对的原子性不变量；返回问题描述或undefined。 / Atomicity invariants of a wallet pair; returns a problem or undefined. */
export function walletProblem({ a, b }) {
  if (!a || !b) return "wallet pair incomplete";
  if (a.seq !== b.seq) return `partial transaction: seq ${a.seq} vs ${b.seq}`;
  if (a.rev !== b.rev || a.rev !== a.seq + 1) return `revision drift: ${a.rev}/${b.rev} for seq ${a.seq}`;
  if (a.balance + b.balance !== WALLET_TOTAL) return `balance not conserved: ${a.balance}+${b.balance}`;
  if (a.balance !== WALLET_TOTAL / 2 - (a.seq % 2)) return `balance does not match seq ${a.seq}: ${a.balance}`;
  return undefined;
}

/**
 * 核对从PG读到的状态。boot：重启后恢复读取；final：排空排队积压后的最终状态。
 * 普通与事务记录只能等于最近确认值或唯一在途值；排队记录不能超过尝试值，最终不能低于确认值。
 *
 * Checks state loaded from PostgreSQL. boot: recovery read after restart; final: after the queue
 * drained. Direct and transactional records must equal the latest ack or the single in-flight value;
 * queued records never exceed the attempted value and finally never fall below the acknowledged one.
 */
export function checkLoadedState(ledger, loaded, phase) {
  if (phase !== "boot" && phase !== "final") throw new Error("phase must be boot or final");
  const problems = [];
  for (let p = 0; p < ledger.players; p++) {
    const direct = ledger.direct[p];
    const d = loaded.direct[p] ?? { v: 0, rev: 0 };
    if (d.v !== direct.acked && d.v !== direct.pending) problems.push({ what: "direct-state", p, loaded: d.v, acked: direct.acked, pending: direct.pending });
    else if (d.rev !== d.v) problems.push({ what: "direct-revision", p, v: d.v, rev: d.rev });

    const queued = ledger.queued[p];
    const q = loaded.queued[p] ?? { v: 0 };
    if (q.v > queued.attempted) problems.push({ what: "queued-phantom", p, loaded: q.v, attempted: queued.attempted });
    else if (phase === "final" && q.v < queued.acked) problems.push({ what: "queued-lost-ack", p, loaded: q.v, acked: queued.acked });

    const wallet = ledger.wallet[p];
    const w = loaded.wallet[p];
    if (!w) {
      if (wallet.acked !== -1) problems.push({ what: "wallet-missing", p, acked: wallet.acked });
    } else {
      const problem = walletProblem(w);
      if (problem) problems.push({ what: "wallet-invariant", p, problem });
      else if (w.a.seq !== wallet.acked && w.a.seq !== wallet.pending) problems.push({ what: "wallet-state", p, loaded: w.a.seq, acked: wallet.acked, pending: wallet.pending });
    }
  }
  return problems;
}

/** 恢复读取通过后，以PG状态为准继续；排队记录仍从已尝试值继续递增，以便发现迟到覆盖。
 * After a passing recovery read, continue from PostgreSQL; queued records keep increasing from the
 * attempted value so late overwrites remain detectable.
 */
export function adoptBootState(ledger, loaded) {
  const rollbacks = [];
  for (let p = 0; p < ledger.players; p++) {
    const direct = ledger.direct[p];
    direct.acked = (loaded.direct[p] ?? { v: 0 }).v; direct.pending = null;
    const wallet = ledger.wallet[p];
    wallet.acked = loaded.wallet[p] ? loaded.wallet[p].a.seq : -1; wallet.pending = null;
    const queued = ledger.queued[p];
    const rollback = Math.max(0, queued.acked - (loaded.queued[p] ?? { v: 0 }).v);
    queued.maxRollback = Math.max(queued.maxRollback, rollback);
    if (rollback > 0) rollbacks.push({ p, rollback });
  }
  return rollbacks;
}

/** 恢复后每个玩家每种写法都至少再确认 rounds 次，才算业务恢复。 / Recovery requires every player and mode to acknowledge rounds more writes. */
export function ackCounters(ledger) {
  return MODES.map((mode) => ledger[mode].map((entry) => entry.acks));
}

export function roundsSatisfied(ledger, baseline, rounds = 2) {
  const current = ackCounters(ledger);
  return current.every((counts, mode) => counts.every((count, p) => count - baseline[mode][p] >= rounds));
}

/** 入队确认档位，由DBProxy部署配置决定。 / Enqueue acknowledgement levels, set by the DBProxy deployment. */
export const ENQUEUE_ACKS = Object.freeze(["aof", "memory"]);

/**
 * AOF故障：可靠Redis重启后，直接核对恢复出的积压条目。只核对PG停机期间才确认的玩家（其值只能在积压中），
 * 值大于强杀时已尝试值的条目是重启后新写入，无法作证，记为masked。
 * AOF fault: after the reliable Redis restarts, check the restored backlog directly. Only players acknowledged
 * while PostgreSQL was down are eligible (their value can only live in the backlog); an entry above the value
 * attempted at the kill was written after the restart and cannot testify, so it counts as masked.
 */
export function verifyRestoredQueued({ required, ackedAtPostgresStop, attemptedAtKill, restored }) {
  const result = { eligible: 0, verified: 0, masked: 0, lost: [] };
  for (let p = 0; p < required.length; p++) {
    if (required[p] <= ackedAtPostgresStop[p]) continue;
    result.eligible += 1;
    const value = restored[p];
    if (value === undefined) result.lost.push({ p, required: required[p], restored: "missing" });
    else if (value > attemptedAtKill[p]) result.masked += 1;
    else if (value < required[p]) result.lost.push({ p, required: required[p], restored: value });
    else result.verified += 1;
  }
  return result;
}

/**
 * PG的停库是优雅关闭，关闭前几秒落库任务仍能提交；这些条目落库后已从积压删除。
 * 对积压中缺失的玩家，用PG重启后读到的值补上（取两者较大者）再核对。
 * Stopping PostgreSQL is a graceful shutdown during which the flush worker can still commit for a few seconds; such
 * entries were removed from the backlog after landing. For players missing from the backlog, fill in the value read
 * from PostgreSQL after its restart (taking the larger of the two) before verifying.
 */
export function mergeRestoredWithPostgres(restored, postgres) {
  return restored.map((value, p) => {
    const stored = postgres.get(p);
    if (stored === undefined) return value;
    return value === undefined ? stored : Math.max(value, stored);
  });
}

/** 探针传给新进程的续写参数。 / Resume parameters handed to a restarted probe. */
export function resumeState(ledger) {
  return { queuedAttempted: ledger.queued.map((entry) => entry.attempted) };
}

/**
 * PG层的独立核对：写法互斥与事务恰好一次。rows 由控制器用SQL查询得到。
 * Storage-level independent checks: write-mode exclusivity and exactly-once transactions.
 */
export function checkStorageRows(ledger, rows) {
  const problems = [];
  const expect = (what, actual, expected) => { if (actual !== expected) problems.push({ what, actual, expected }); };
  expect("direct-or-queued-in-transactions", rows.nonWalletTransactionRecords, 0);
  expect("wallet-in-snapshot-writes", rows.walletIdempotencyRows, 0);
  expect("queued-with-revision-check", rows.queuedCheckedRows, 0);
  expect("direct-without-revision-check", rows.directUncheckedRows, 0);
  for (let p = 0; p < ledger.players; p++) {
    const committed = rows.walletOperations[p] ?? 0;
    const finalSeq = rows.walletSeq[p] ?? -1;
    // 每个序号恰好一个已提交事务（含n=0的创建）。 / Exactly one committed transaction per sequence, including creation n=0.
    if (committed !== finalSeq + 1) problems.push({ what: "wallet-not-exactly-once", p, committed, finalSeq });
  }
  return problems;
}
