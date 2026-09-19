import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  FULL_FAULT_ORDER, NAMESPACES, WALLET_TOTAL,
  adoptBootState, applyProbeEvent, assertCoverage, checkLoadedState, checkStorageRows,
  createLedger, planSchedule, resumeState, roundsSatisfied, ackCounters,
} from "./lib/persistence_write_modes_ledger.mjs";
import { extractProbeEvent, renderProbeScript } from "./lib/persistence_write_modes_probe.mjs";
import { CONFIRMATION, parseArguments } from "./persistence_write_modes_soak.mjs";

test("plan rejects durations that cannot cover every fault and never shortens them", () => {
  const plan = planSchedule({ seconds: 3600 });
  assert.deepEqual(plan.order, [...FULL_FAULT_ORDER]);
  assert.ok(plan.estimatedCycles >= 1);
  assert.throws(() => planSchedule({ seconds: 300 }), /cannot cover one full fault cycle/);
  assert.throws(() => planSchedule({ seconds: 3600, faults: ["postgres", "postgres"] }), /duplicate/);
  assert.throws(() => planSchedule({ seconds: 3600, faults: ["disk"] }), /unknown fault/);
  assert.throws(() => assertCoverage(["postgres", "redis"], ["postgres"]), /coverage incomplete: redis/);
});

test("arguments require explicit confirmation only for the destructive run", () => {
  assert.equal(parseArguments([]).action, "plan");
  assert.equal(parseArguments(["smoke"]).schedule.order[0], "probe-restart");
  assert.throws(() => parseArguments(["run"]), /requires --confirm/);
  assert.throws(() => parseArguments(["run", "--confirm", "yes"]), /requires --confirm/);
  assert.equal(parseArguments(["run", "--confirm", CONFIRMATION]).action, "run");
  assert.throws(() => parseArguments(["smoke", "--confirm", CONFIRMATION]), /only accepted by run/);
  assert.throws(() => parseArguments(["run", "--seconds", "600", "--confirm", CONFIRMATION]), /seconds must be/);
});

test("ledger accepts sequential intents and acks, and flags out-of-order or phantom acknowledgements", () => {
  const ledger = createLedger(1);
  for (const event of [
    { t: "di", p: 0, v: 1 }, { t: "da", p: 0, v: 1, r: 1 },
    { t: "di", p: 0, v: 2 }, { t: "dr", p: 0, v: 2, c: false }, { t: "di", p: 0, v: 2 }, { t: "dr", p: 0, v: 2, c: true },
    { t: "qi", p: 0, v: 1 }, { t: "qi", p: 0, v: 2 }, { t: "qa", p: 0, v: 2 },
    { t: "wi", p: 0, n: 0 }, { t: "wa", p: 0, n: 0, a: { balance: 1000, seq: 0, rev: 1 }, b: { balance: 1000, seq: 0, rev: 1 } },
  ]) assert.equal(applyProbeEvent(ledger, event), undefined, JSON.stringify(event));
  assert.deepEqual(ledger.acks, { direct: 2, queued: 1, wallet: 1 });
  assert.ok(applyProbeEvent(ledger, { t: "di", p: 0, v: 5 }));
  assert.ok(applyProbeEvent(ledger, { t: "qa", p: 0, v: 9 }));
  assert.ok(applyProbeEvent(ledger, { t: "wi", p: 0, n: 1 }) === undefined);
  assert.ok(applyProbeEvent(ledger, { t: "wa", p: 0, n: 1, a: { balance: 999, seq: 1, rev: 2 }, b: { balance: 1000, seq: 1, rev: 2 } }));
  assert.equal(ledger.violations.length, 3);
});

test("recovery and final reads detect lost acks, phantoms, partial transactions and drift", () => {
  const ledger = createLedger(1);
  Object.assign(ledger.direct[0], { acked: 5, pending: 6 });
  Object.assign(ledger.queued[0], { acked: 7, attempted: 9 });
  Object.assign(ledger.wallet[0], { acked: 3, pending: null });
  const pair = (seq) => ({ a: { balance: 1000 - (seq % 2), seq, rev: seq + 1 }, b: { balance: 1000 + (seq % 2), seq, rev: seq + 1 } });
  const ok = { direct: [{ v: 6, rev: 6 }], queued: [{ v: 7 }], wallet: [pair(3)] };
  assert.deepEqual(checkLoadedState(ledger, ok, "final"), []);
  // 排队写在恢复读取时允许回退，最终不允许低于确认值。 / Queued rollback is allowed at boot, never at the end.
  assert.deepEqual(checkLoadedState(ledger, { ...ok, queued: [{ v: 2 }] }, "boot"), []);
  const codes = (loaded, phase = "final") => checkLoadedState(ledger, loaded, phase).map((problem) => problem.what);
  assert.deepEqual(codes({ ...ok, queued: [{ v: 2 }] }), ["queued-lost-ack"]);
  assert.deepEqual(codes({ ...ok, queued: [{ v: 10 }] }, "boot"), ["queued-phantom"]);
  assert.deepEqual(codes({ ...ok, direct: [{ v: 4, rev: 4 }] }), ["direct-state"]);
  assert.deepEqual(codes({ ...ok, direct: [{ v: 6, rev: 7 }] }), ["direct-revision"]);
  assert.deepEqual(codes({ ...ok, wallet: [{ a: pair(4).a, b: pair(3).b }] }), ["wallet-invariant"]);
  assert.deepEqual(codes({ ...ok, wallet: [pair(5)] }), ["wallet-state"]);
  assert.deepEqual(codes({ ...ok, wallet: [null] }), ["wallet-missing"]);

  const rollbacks = adoptBootState(ledger, { ...ok, queued: [{ v: 4 }] });
  assert.deepEqual(rollbacks, [{ p: 0, rollback: 3 }]);
  assert.equal(ledger.direct[0].acked, 6);
  assert.equal(ledger.direct[0].pending, null);
  assert.deepEqual(resumeState(ledger), { queuedAttempted: [9] });
});

test("storage reconciliation requires write-mode exclusivity and exactly-once transactions", () => {
  const ledger = createLedger(2);
  const clean = { nonWalletTransactionRecords: 0, walletIdempotencyRows: 0, queuedCheckedRows: 0, directUncheckedRows: 0,
    walletOperations: { 0: 4, 1: 1 }, walletSeq: [3, 0] };
  assert.deepEqual(checkStorageRows(ledger, clean), []);
  const whats = checkStorageRows(ledger, { ...clean, queuedCheckedRows: 2, walletIdempotencyRows: 1, walletOperations: { 0: 5, 1: 1 } })
    .map((problem) => problem.what);
  assert.deepEqual(whats, ["wallet-in-snapshot-writes", "queued-with-revision-check", "wallet-not-exactly-once"]);
});

test("recovery rounds require two new acknowledgements from every player and mode", () => {
  const ledger = createLedger(2);
  const baseline = ackCounters(ledger);
  for (const mode of ["direct", "queued", "wallet"]) for (const entry of ledger[mode]) entry.acks = 2;
  ledger.wallet[1].acks = 1;
  assert.equal(roundsSatisfied(ledger, baseline), false);
  ledger.wallet[1].acks = 2;
  assert.equal(roundsSatisfied(ledger, baseline), true);
});

test("probe events are extracted from decorated Host log lines", () => {
  // 取自真实运行时日志：时间戳与颜色码在前，属性在后。 / Captured from a real runtime log: timestamp and colours before, attributes after.
  const line = "\x1b[2m2026-09-19T02:20:32.363975Z\x1b[0m \x1b[32m INFO\x1b[0m \x1b[2mtiangz::typescript\x1b[0m\x1b[2m:\x1b[0m "
    + 'WMS {"t":"wa","p":1,"n":653,"a":{"balance":999,"seq":653,"rev":654},"b":{"balance":1001,"seq":653,"rev":654},"d":"applied"} '
    + 'process="write-modes-probe" category=application attributes={}';
  assert.deepEqual(extractProbeEvent(line), { t: "wa", p: 1, n: 653, a: { balance: 999, seq: 653, rev: 654 }, b: { balance: 1001, seq: 653, rev: 654 }, d: "applied" });
  assert.deepEqual(extractProbeEvent('x WMS {"t":"fatal","error":"a } b \\" {"} attributes={}'), { t: "fatal", error: 'a } b " {' });
  assert.equal(extractProbeEvent("INFO tiangz::metrics: [metrics:inner_transport] active=0"), undefined);
  assert.throws(() => extractProbeEvent('WMS {"t":"di"'), /unterminated/);
});

test("rendered probe is valid JavaScript and rejects unsafe configuration", () => {
  const config = probeConfig({ epoch: 1 });
  assert.doesNotThrow(() => new vm.Script(renderProbeScript(config)));
  assert.throws(() => renderProbeScript({ ...config, runId: "x'; DROP" }), /runId/);
  assert.throws(() => renderProbeScript({ ...config, mode: "write" }), /mode/);
  const { stepMs: _omitted, ...missing } = config;
  assert.throws(() => renderProbeScript(missing), /missing stepMs/);
});

test("probe keeps the ledger consistent through ambiguous commits and a kill/restart", async () => {
  const store = new FakeDbProxy();
  const ledger = createLedger(3);
  const feed = (events) => {
    for (const event of events) {
      if (event.t === "state") {
        const problems = checkLoadedState(ledger, event, event.phase);
        assert.deepEqual(problems, [], `${event.phase} state`);
        if (event.phase === "boot" && event.epoch > 1) adoptBootState(ledger, event);
      } else if (event.t === "fatal" || event.t === "violation") {
        assert.fail(JSON.stringify(event));
      } else {
        assert.equal(applyProbeEvent(ledger, event), undefined, JSON.stringify(event));
      }
    }
  };

  // 第一轮：约三分之一的写入在提交后向客户端报告失败，模拟结果未知。
  // Epoch 1: about a third of writes commit but report failure to the client, simulating uncertain outcomes.
  store.ambiguousEvery = 3;
  const first = await runProbe(store, probeConfig({ epoch: 1, resume: resumeState(ledger) }), 400);
  feed(first);
  assert.ok(ledger.acks.direct > 3 && ledger.acks.queued > 3 && ledger.acks.wallet > 3, JSON.stringify(ledger.acks));
  assert.ok(store.ambiguousInjected > 0);

  // 进程被杀：未完成的请求可能已提交，新进程按账本核对后继续。
  // The process is killed: in-flight requests may have committed; the new process checks against the ledger and continues.
  const second = await runProbe(store, probeConfig({ epoch: 2, resume: resumeState(ledger), settleMs: 1 }), 300);
  feed(second);

  const final = await runProbe(store, probeConfig({ epoch: 3, mode: "verify", resume: resumeState(ledger), settleMs: 1 }), 100);
  const state = final.find((event) => event.t === "state");
  assert.equal(state.phase, "final");
  assert.deepEqual(checkLoadedState(ledger, state, "final"), []);
  for (const pair of state.wallet) assert.equal(pair.a.balance + pair.b.balance, WALLET_TOTAL);
  assert.ok(final.some((event) => event.t === "done"));
  // 事务在结果未知时以原operationId重试，因此每个序号只提交一次。 / Uncertain transactions retry their operationId, so each sequence commits once.
  for (let p = 0; p < 3; p++) assert.equal(store.walletCommits(p), state.wallet[p].a.seq + 1);
});

function probeConfig(overrides) {
  return {
    runId: "wms-unit-test", epoch: 1, mode: "run", players: 3, namespaces: NAMESPACES, resume: { queuedAttempted: [] },
    walletTotal: WALLET_TOTAL, stepMs: 1, errorBackoffMs: 1, auditMs: 5, statMs: 1000, settleMs: 0, ...overrides,
  };
}

/** 在vm中运行真实探针源码，到时后冻结所有等待，模拟进程被杀。 / Runs the real probe source in a vm and freezes every wait at the deadline, like a kill. */
async function runProbe(store, config, milliseconds) {
  const events = [];
  const context = vm.createContext({
    console: { log: (line) => { if (line.startsWith("WMS ")) events.push(JSON.parse(line.slice(4))); } },
    setTimeout, TextEncoder, TextDecoder, BigInt, JSON, Math, Promise, Error, Number, String,
  });
  context.globalThis = context;
  context.__etsStartProcess = async () => "started";
  context.__tiangzModelExports = store.api(() => frozen);
  let frozen = false;
  new vm.Script(renderProbeScript(config)).runInContext(context);
  await context.__etsStartProcess({});
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
  frozen = true;
  context.__hostSleep = () => new Promise(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return events;
}

/** 进程内DBProxy替身：CAS、幂等事务回执，以及“已提交但客户端收到失败”的注入。
 * In-process DBProxy double with CAS, idempotent transaction receipts and "committed but the client saw a failure" injection.
 */
class FakeDbProxy {
  constructor() {
    this.records = new Map();
    this.operations = new Map();
    this.ambiguousEvery = 0;
    this.ambiguousInjected = 0;
    this.calls = 0;
  }

  maybeAmbiguous() {
    this.calls += 1;
    if (this.ambiguousEvery && this.calls % this.ambiguousEvery === 0) {
      this.ambiguousInjected += 1;
      const error = new Error("storage unavailable after commit");
      error.code = 3001;
      throw error;
    }
  }

  walletCommits(p) {
    return [...this.operations.keys()].filter((id) => id.startsWith(`wms-unit-test:w:${p}:`)).length;
  }

  api(isFrozen) {
    const store = this;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const guard = () => { if (isFrozen()) return new Promise(() => undefined); return undefined; };
    const load = (codec, key) => {
      const stored = store.records.get(`${codec.recordNamespace}/${key}`);
      return stored ? { data: codec.Decode(stored.payload), revision: BigInt(stored.revision) } : undefined;
    };
    const conflict = () => { const error = new Error("revision conflict"); error.code = 2001; return error; };
    class Base {
      constructor(codec) { this.codec = codec; }
      async Load(key) { return guard() ?? load(this.codec, key); }
    }
    return {
      utf8Encode: (text) => encoder.encode(text),
      utf8Decode: (bytes) => decoder.decode(bytes),
      IsVersionedEntityRevisionConflict: (error) => error?.code === 2001,
      DbProxyEntityRepository: class extends Base {
        async SaveSnapshot(key, value, expectedRevision) {
          const pending = guard(); if (pending) return pending;
          const id = `${this.codec.recordNamespace}/${key}`;
          const actual = store.records.get(id)?.revision ?? 0;
          if (BigInt(actual) !== expectedRevision) throw conflict();
          store.records.set(id, { revision: actual + 1, payload: this.codec.Encode(value) });
          store.maybeAmbiguous();
          return { disposition: "applied", revision: BigInt(actual + 1) };
        }
      },
      DbProxyQueuedEntityRepository: class extends Base {
        async EnqueueSnapshot(key, value) {
          const pending = guard(); if (pending) return pending;
          const id = `${this.codec.recordNamespace}/${key}`;
          store.records.set(id, { revision: (store.records.get(id)?.revision ?? 0) + 1, payload: this.codec.Encode(value) });
          store.maybeAmbiguous();
        }
      },
      DbProxyTransactionalEntityRepository: class extends Base {
        TransactionWriteSnapshot(key, value, expectedRevision) {
          return { record: { namespace: this.codec.recordNamespace, key }, expectedRevision, payload: this.codec.Encode(value) };
        }
      },
      HostDbProxyRecords: class {
        async CommitRecords(commit) {
          const pending = guard(); if (pending) return pending;
          const previous = store.operations.get(commit.operationId);
          if (previous) return { ...previous, disposition: "duplicate" };
          for (const write of commit.writes) {
            const actual = store.records.get(`${write.record.namespace}/${write.record.key}`)?.revision ?? 0;
            if (BigInt(actual) !== write.expectedRevision) throw conflict();
          }
          const records = commit.writes.map((write) => {
            const id = `${write.record.namespace}/${write.record.key}`;
            const revision = (store.records.get(id)?.revision ?? 0) + 1;
            store.records.set(id, { revision, payload: write.payload });
            return { record: write.record, newRevision: BigInt(revision) };
          });
          const receipt = { disposition: "applied", records, result: commit.result };
          store.operations.set(commit.operationId, receipt);
          store.maybeAmbiguous();
          return receipt;
        }
      },
    };
  }
}
