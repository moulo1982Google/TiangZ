import assert from "node:assert/strict";
import test from "node:test";
import { assertReconciliationCounts, reconciliationAuditSql, parseReconciliationAudit,
  reconciliationCountsSql, reconciliationReadOnlySql } from "./soak_reconciliation.mjs";

function fixture() {
  return {
    report: { players: 2, final: { totals: { transactionApplied: 7, transactionDuplicate: 1, tradeApplied: 3, tradeDuplicate: 1 } } },
    result: { directPlayers: 2, queuedPlayers: 2, badDirectVersions: 0, directSequenceSum: 8,
      transactionReceipts: 8, trades: 4, tradeReceipts: 4, tradeRecordReceipts: 8,
      walletSnapshots: 8, badWalletSnapshots: 0, ledgerPostings: 8, badLedgerGroups: 0,
      outboxEvents: 4, unpublishedEvents: 0, deadEvents: 0 },
  };
}

test("audit accepts complete receipts and duplicate retries", () => {
  const { result, report } = fixture();
  assertReconciliationCounts(result, report);
});

test("each independently corrupted count fails", () => {
  for (const key of Object.keys(fixture().result)) {
    const { result, report } = fixture();
    result[key]++;
    assert.throws(() => assertReconciliationCounts(result, report), key);
  }
});

test("JSON integers must remain exact and nonnegative", () => {
  for (const value of [Number.MAX_SAFE_INTEGER + 1, -1, 0.5, "4", null]) {
    const { result, report } = fixture();
    result.outboxEvents = value;
    assert.throws(() => assertReconciliationCounts(result, report));
  }
});

test("SQL rejects untrusted run IDs and keeps the original transaction budget", () => {
  for (const id of ["", "1'; SELECT 1", "1:2"]) {
    assert.throws(() => reconciliationCountsSql(id));
    assert.throws(() => reconciliationAuditSql(id));
  }
  const query = reconciliationReadOnlySql(reconciliationCountsSql("123"));
  assert.ok(query.startsWith("BEGIN READ ONLY; SET LOCAL statement_timeout='5s'; SET LOCAL jit=off;"));
  assert.ok(query.endsWith("COMMIT;"));
});

function auditFixture() {
  const { result, report } = fixture();
  const identity = { version: 2, snapshot: "100:105:101,103", isolation: "repeatable read", readOnly: true };
  const groups = {
    direct: ["directPlayers", "queuedPlayers", "badDirectVersions", "directSequenceSum", "transactionReceipts"],
    trade: ["trades", "tradeReceipts", "tradeRecordReceipts"],
    wallet: ["walletSnapshots", "badWalletSnapshots"], ledger: ["ledgerPostings", "badLedgerGroups"],
    outbox: ["outboxEvents", "unpublishedEvents", "deadEvents"],
  };
  const rows = [{ ...identity, type: "begin", statementTimeoutMs: 5000, atMs: 1000 }];
  let atMs = 1100;
  for (const [part, keys] of Object.entries(groups)) {
    rows.push({ ...identity, type: "part-start", part, atMs });
    rows.push({ ...identity, type: "part", part, atMs: atMs + 100,
      counts: Object.fromEntries(keys.map(key => [key, result[key]])) });
    atMs += 1000;
  }
  rows.push({ type: "complete", version: 2, parts: 5 });
  return { rows, report, result };
}

function parse(rows, report, elapsedMs = 5500) {
  return parseReconciliationAudit(rows.map(row => JSON.stringify(row)).join("\n"), report, elapsedMs);
}

test("a complete consistent audit preserves all counts and reports its new budget", () => {
  const { rows, report, result } = auditFixture();
  const actual = parse(rows, report);
  assert.deepEqual(actual.counts, result);
  assert.equal(actual.audit.snapshot, "100:105:101,103");
  assert.equal(actual.audit.contract.statementTimeoutMs, 5000);
  assert.equal(actual.audit.contract.sessionTimeoutMs, 60000);
  assert.equal(actual.audit.contract.nodeReviewTimeoutMs, 600000);
  assert.equal(actual.audit.parts.length, 5);
  assert.ok(actual.audit.parts.every(part => part.durationMs === 100));
});

test("partial, duplicate or reordered session output cannot pass", () => {
  for (const mutate of [
    rows => rows.pop(), rows => rows.splice(3, 2), rows => rows.splice(3, 0, rows[1], rows[2]),
    rows => [rows[1], rows[3]] = [rows[3], rows[1]],
    rows => rows.at(-1).parts--, rows => rows.at(-1).type = "aborted",
    rows => delete rows[2].counts.transactionReceipts,
    rows => rows[2].counts.extra = 0,
  ]) {
    const { rows, report } = auditFixture();
    mutate(rows);
    assert.throws(() => parse(rows, report));
  }
});

test("every part must keep the same read-only repeatable-read identity", () => {
  for (let index = 0; index < auditFixture().rows.length - 1; index++) {
    for (const [key, value] of [["snapshot", "200:201:"], ["isolation", "read committed"],
      ["readOnly", false], ["version", 1], ["atMs", null]]) {
      const { rows, report } = auditFixture();
      rows[index][key] = value;
      assert.throws(() => parse(rows, report), `${index}/${key}`);
    }
  }
});

test("query and overall deadlines reject completed-looking evidence", () => {
  for (const elapsedMs of [60000, 60001, -1, NaN, Infinity, "5500"]) {
    const { rows, report } = auditFixture();
    assert.throws(() => parse(rows, report, elapsedMs));
  }
  for (const durationMs of [5000, 5001, -1]) {
    const { rows, report } = auditFixture();
    rows[2].atMs = rows[1].atMs + durationMs;
    assert.throws(() => parse(rows, report));
  }
});

test("splitting an audit still rejects every corrupted count", () => {
  for (const key of Object.keys(fixture().result)) {
    const { rows, report } = auditFixture();
    rows.find(row => row.counts && Object.hasOwn(row.counts, key)).counts[key]++;
    assert.throws(() => parse(rows, report), key);
  }
});
