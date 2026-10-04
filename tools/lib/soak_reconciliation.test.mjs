import assert from "node:assert/strict";
import test from "node:test";
import { assertReconciliationCounts, reconciliationCountsSql, reconciliationReadOnlySql } from "./soak_reconciliation.mjs";

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
  for (const id of ["", "1'; SELECT 1", "1:2"]) assert.throws(() => reconciliationCountsSql(id));
  const query = reconciliationReadOnlySql(reconciliationCountsSql("123"));
  assert.ok(query.startsWith("BEGIN READ ONLY; SET LOCAL statement_timeout='5s'; SET LOCAL jit=off;"));
  assert.ok(query.endsWith("COMMIT;"));
});
