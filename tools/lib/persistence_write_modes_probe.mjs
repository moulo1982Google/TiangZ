// 注入真实TiangZ进程的写法长稳探针。probeMain会被序列化进model.js，因此必须自包含：
// 只能使用参数CONFIG和运行时全局对象，不能引用本模块的其他绑定。
// Write-mode soak probe injected into a real TiangZ process. probeMain is serialized into model.js,
// so it must be self-contained: only CONFIG and runtime globals, never other bindings of this module.

export function probeMain(CONFIG) {
  const start = globalThis.__etsStartProcess;
  if (typeof start !== "function") throw new Error("write-mode soak probe requires __etsStartProcess");
  const emit = (event) => console.log("WMS " + JSON.stringify(event));
  const sleep = (ms) => (typeof globalThis.__hostSleep === "function"
    ? globalThis.__hostSleep(ms)
    : new Promise((resolve) => setTimeout(resolve, ms)));
  const describe = (error) => `${error && error.code !== undefined ? `code ${error.code}: ` : ""}${String((error && error.message) || error).slice(0, 200)}`;
  let halted = false;
  const stats = {
    ok: { direct: 0, queued: 0, wallet: 0 },
    errors: { direct: 0, queued: 0, wallet: 0 },
    ambiguous: { direct: 0, wallet: 0 },
    lastError: {},
  };
  const recordError = (mode, error) => { stats.errors[mode] += 1; stats.lastError[mode] = describe(error); };
  const halt = (what, detail) => { if (!halted) emit({ t: "violation", what, detail }); halted = true; };

  globalThis.__etsStartProcess = async (processConfig) => {
    const result = await start(processConfig);
    // 负载在进程启动后后台运行，与真实业务一样经过宿主op访问DBProxy。
    // The workload runs after startup and reaches DBProxy through the same Host ops as business code.
    run().catch((error) => { halted = true; emit({ t: "fatal", error: String((error && error.stack) || error) }); });
    return result;
  };

  async function run() {
    const api = globalThis.__tiangzModelExports;
    const codec = (recordNamespace, schema) => ({
      recordNamespace,
      schema,
      schemaVersion: 1,
      Capture: (value) => value,
      Encode: (value) => api.utf8Encode(JSON.stringify(value)),
      Decode: (payload) => JSON.parse(api.utf8Decode(payload)),
    });
    const owner = `wms-${CONFIG.runId}-e${CONFIG.epoch}`;
    const direct = new api.DbProxyEntityRepository(codec(CONFIG.namespaces.direct, "wms.Counter"), owner);
    const queued = new api.DbProxyQueuedEntityRepository(codec(CONFIG.namespaces.queued, "wms.Counter"), owner);
    const wallet = new api.DbProxyTransactionalEntityRepository(codec(CONFIG.namespaces.wallet, "wms.Wallet"), owner);
    const records = new api.HostDbProxyRecords();
    const key = (p) => `${CONFIG.runId}/${p}`;
    const walletKey = (p, side) => `${CONFIG.runId}/${p}/${side}`;

    // 被强杀的前一进程可能仍有请求在DBProxy内完成；等待其结束后再读取恢复状态。
    // Requests from a killed predecessor may still finish inside DBProxy; settle before the recovery read.
    if (CONFIG.settleMs > 0) await sleep(CONFIG.settleMs);
    const loaded = await retryUntilLoaded(() => loadAll());
    emit({ t: "state", phase: CONFIG.mode === "verify" ? "final" : "boot", epoch: CONFIG.epoch, ...loaded });
    if (CONFIG.mode === "verify") { emit({ t: "done" }); return; }

    const directStates = loaded.direct.map((entry) => ({ v: entry.v, rev: entry.rev }));
    const queuedStates = loaded.queued.map((entry, p) => ({ attempted: Math.max(entry.v, CONFIG.resume.queuedAttempted[p] ?? 0) }));
    emit({ t: "ready", epoch: CONFIG.epoch });
    const loops = [];
    for (let p = 0; p < CONFIG.players; p++) {
      loops.push(directLoop(p, directStates[p]), queuedLoop(p, queuedStates[p]), walletLoop(p, loaded.wallet[p]));
    }
    loops.push(queuedAuditor(queuedStates), statLoop());
    await Promise.all(loops);

    async function loadAll() {
      const state = { direct: [], queued: [], wallet: [] };
      for (let p = 0; p < CONFIG.players; p++) {
        const d = await direct.Load(key(p));
        state.direct.push(d ? { v: d.data.v, rev: Number(d.revision) } : { v: 0, rev: 0 });
        const q = await queued.Load(key(p));
        state.queued.push({ v: q ? q.data.v : 0 });
        const a = await wallet.Load(walletKey(p, "a"));
        const b = await wallet.Load(walletKey(p, "b"));
        state.wallet.push(a || b ? {
          a: a ? { balance: a.data.balance, seq: a.data.seq, rev: Number(a.revision) } : undefined,
          b: b ? { balance: b.data.balance, seq: b.data.seq, rev: Number(b.revision) } : undefined,
        } : null);
      }
      return state;
    }

    async function retryUntilLoaded(load) {
      for (;;) {
        try { return await load(); } catch (error) { recordError("direct", error); await sleep(CONFIG.errorBackoffMs); }
      }
    }

    // 普通写法：CAS保存；结果未知时从PG读取判定是否已提交，不盲目换值重试。
    // Ordinary mode: CAS save; uncertain outcomes are resolved by an authoritative read, never by blindly writing a new value.
    async function directLoop(p, s) {
      let next = s.v + 1;
      while (!halted) {
        emit({ t: "di", p, v: next });
        try {
          const saved = await direct.SaveSnapshot(key(p), { v: next }, BigInt(s.rev));
          const rev = Number(saved.revision);
          if (rev !== next) return halt("direct-revision", { p, v: next, rev });
          s.v = next; s.rev = rev; stats.ok.direct += 1;
          emit({ t: "da", p, v: next, r: rev });
          next += 1;
        } catch (error) {
          recordError("direct", error); stats.ambiguous.direct += 1;
          const committed = await reconcileDirect(p, s, next);
          if (committed === undefined) return undefined;
          if (committed) { s.v = next; s.rev = next; next += 1; } else await sleep(CONFIG.errorBackoffMs);
        }
        await sleep(CONFIG.stepMs);
      }
      return undefined;
    }

    async function reconcileDirect(p, s, attempted) {
      while (!halted) {
        try {
          const current = await direct.Load(key(p));
          const v = current ? current.data.v : 0;
          const rev = current ? Number(current.revision) : 0;
          if (v === attempted && rev === attempted) { stats.ok.direct += 1; emit({ t: "dr", p, v: attempted, c: true }); return true; }
          if (v === s.v && rev === s.rev) { emit({ t: "dr", p, v: attempted, c: false }); return false; }
          halt("direct-reconcile", { p, loaded: v, rev, acked: s.v, attempted });
          return undefined;
        } catch (error) { recordError("direct", error); await sleep(CONFIG.errorBackoffMs); }
      }
      return undefined;
    }

    // 排队写法：值严格递增；失败只计数，下一次写入自然取代它。
    // Queued mode: values strictly increase; failures are counted and superseded by the next write.
    async function queuedLoop(p, s) {
      while (!halted) {
        const v = s.attempted + 1;
        s.attempted = v;
        emit({ t: "qi", p, v });
        try {
          await queued.EnqueueSnapshot(key(p), { v });
          stats.ok.queued += 1;
          emit({ t: "qa", p, v });
        } catch (error) { recordError("queued", error); await sleep(CONFIG.errorBackoffMs); }
        await sleep(CONFIG.stepMs);
      }
    }

    // PG中的排队记录永远不能超过已尝试的最大值。 / A queued record in PostgreSQL may never exceed the largest attempted value.
    async function queuedAuditor(states) {
      let p = 0;
      while (!halted) {
        await sleep(CONFIG.auditMs);
        try {
          const current = await queued.Load(key(p));
          const v = current ? current.data.v : 0;
          if (v > states[p].attempted) return halt("queued-phantom", { p, loaded: v, attempted: states[p].attempted });
        } catch (error) { recordError("queued", error); }
        p = (p + 1) % CONFIG.players;
      }
      return undefined;
    }

    // 事务写法：两个钱包原子转账；结果未知时用原operationId和完全相同的写入重试直到有结论。
    // Transactional mode: atomic transfer between two wallets; uncertain outcomes retry the original
    // operationId with identical writes until decided.
    async function walletLoop(p, s) {
      let n = s ? s.a.seq + 1 : 0;
      while (!halted) {
        const toB = n % 2 === 1;
        const balances = n === 0
          ? { a: CONFIG.walletTotal / 2, b: CONFIG.walletTotal / 2 }
          : { a: s.a.balance + (toB ? -1 : 1), b: s.b.balance + (toB ? 1 : -1) };
        const commit = {
          operationId: `${CONFIG.runId}:w:${p}:${n}:e${CONFIG.epoch}`,
          writes: [
            wallet.TransactionWriteSnapshot(walletKey(p, "a"), { balance: balances.a, seq: n }, BigInt(s ? s.a.rev : 0)),
            wallet.TransactionWriteSnapshot(walletKey(p, "b"), { balance: balances.b, seq: n }, BigInt(s ? s.b.rev : 0)),
          ],
          appends: [],
          outboxEvents: [],
          result: api.utf8Encode(String(n)),
        };
        emit({ t: "wi", p, n });
        const receipt = await commitUntilDecided(p, n, commit);
        if (!receipt) return undefined;
        const revisionOf = (side) => Number(receipt.records.find((record) => record.record.key === walletKey(p, side)).newRevision);
        s = {
          a: { balance: balances.a, seq: n, rev: revisionOf("a") },
          b: { balance: balances.b, seq: n, rev: revisionOf("b") },
        };
        stats.ok.wallet += 1;
        emit({ t: "wa", p, n, a: s.a, b: s.b, d: receipt.disposition });
        n += 1;
        await sleep(CONFIG.stepMs);
      }
      return undefined;
    }

    async function commitUntilDecided(p, n, commit) {
      let attempts = 0;
      while (!halted) {
        try {
          return await records.CommitRecords(commit);
        } catch (error) {
          // 单一所有者下版本冲突或操作号冲突都说明有重复提交或丢失确认。
          // With a single owner, a revision or operation conflict means a duplicate commit or a lost acknowledgement.
          if (api.IsVersionedEntityRevisionConflict(error) || (error && error.code === 2003)) {
            halt("wallet-conflict", { p, n, error: describe(error) });
            return undefined;
          }
          attempts += 1;
          if (attempts === 1) stats.ambiguous.wallet += 1;
          recordError("wallet", error);
          await sleep(CONFIG.errorBackoffMs);
        }
      }
      return undefined;
    }

    async function statLoop() {
      while (!halted) {
        await sleep(CONFIG.statMs);
        emit({ t: "stat", epoch: CONFIG.epoch, ...stats });
      }
    }
  }
}

/**
 * 从运行时日志行提取探针事件。console.log经过宿主日志层，前有时间戳和颜色码、后有属性，
 * 所以按"WMS {"定位并做括号/字符串感知的扫描，而不是假设行首。
 *
 * Extracts a probe event from a runtime log line. console.log passes through the Host logger with a
 * timestamp and colour codes before and attributes after, so locate "WMS {" and scan braces and
 * strings instead of assuming the line start.
 */
export function extractProbeEvent(line) {
  const text = line.replace(/\x1b\[[0-9;]*m/g, "");
  const start = text.indexOf("WMS {");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start + 4; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
    } else if (char === "\"") inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return JSON.parse(text.slice(start + 4, index + 1));
  }
  throw new Error("unterminated probe event");
}

/** 生成追加到model.js的脚本。 / Renders the script appended to model.js. */
export function renderProbeScript(config) {
  const required = ["runId", "epoch", "mode", "players", "namespaces", "resume", "walletTotal",
    "stepMs", "errorBackoffMs", "auditMs", "statMs", "settleMs"];
  for (const name of required) if (config[name] === undefined) throw new Error(`probe config missing ${name}`);
  if (config.mode !== "run" && config.mode !== "verify") throw new Error("probe mode must be run or verify");
  if (!/^[a-z0-9-]{4,40}$/.test(config.runId)) throw new Error("runId must be 4..40 lowercase letters, digits or dashes");
  return `\n;(${probeMain.toString()})(${JSON.stringify(config)});\n`;
}
