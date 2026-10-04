import assert from "node:assert/strict";

// 对账只做一次性聚合，禁用本事务的 JIT，保持五秒截止时间。 / Disable JIT for one-off audit aggregates without changing the five-second deadline.
export function reconciliationReadOnlySql(query) {
  assert.equal(typeof query, "string");
  return `BEGIN READ ONLY; SET LOCAL statement_timeout='5s'; SET LOCAL jit=off; ${query}; COMMIT;`;
}

// 每个状态集合只扫描一次，所有聚合共享同一个语句快照。 / Scan each state set once under the same statement snapshot.
export function reconciliationCountsSql(runId) {
  assert.match(runId, /^\d+$/);
  return `WITH direct AS (
 SELECT revision,regexp_replace(convert_from(payload,'UTF8'),'.*sequence=','')::bigint AS sequence
 FROM dbproxy_snapshots WHERE namespace='fault-soak-player' AND record_key LIKE '${runId}:%:direct'
 ), direct_counts AS (
 SELECT count(*) AS players,count(*) FILTER(WHERE revision<>sequence+1) AS bad,coalesce(sum(sequence),0) AS sequences FROM direct
 ), wallets AS (
 SELECT count(*) AS total,count(*) FILTER(WHERE revision<>1 OR convert_from(payload,'UTF8') NOT IN ('gold=-1','gold=1')) AS bad
 FROM dbproxy_snapshots WHERE namespace='fault-soak-trade'
 ), ledger AS (
 SELECT trade_id,count(*) AS n,sum(amount) AS balance FROM dbproxy_ledger_postings GROUP BY trade_id
 ), ledger_counts AS (
 SELECT coalesce(sum(n),0) AS postings,count(*) FILTER(WHERE n<>2 OR balance<>0) AS bad FROM ledger
 ), outbox AS (
 SELECT count(*) AS total,count(*) FILTER(WHERE published_at IS NULL) AS pending,
 count(*) FILTER(WHERE dead_lettered_at IS NOT NULL) AS dead FROM dbproxy_outbox
 ) SELECT json_build_object(
 'directPlayers',direct_counts.players,
 'queuedPlayers',(SELECT count(*) FROM dbproxy_snapshots WHERE namespace='fault-soak-player' AND record_key LIKE '${runId}:%:queued'),
 'badDirectVersions',direct_counts.bad,
 'directSequenceSum',direct_counts.sequences,
 'transactionReceipts',(SELECT count(*) FROM dbproxy_transactions WHERE operation_id LIKE 'soak:transaction:${runId}:%'),
 'trades',(SELECT count(*) FROM dbproxy_trades),
 'tradeReceipts',(SELECT count(*) FROM dbproxy_trade_operations),
 'tradeRecordReceipts',(SELECT count(*) FROM dbproxy_trade_operation_records),
 'walletSnapshots',wallets.total,'badWalletSnapshots',wallets.bad,
 'ledgerPostings',ledger_counts.postings,'badLedgerGroups',ledger_counts.bad,
 'outboxEvents',outbox.total,'unpublishedEvents',outbox.pending,'deadEvents',outbox.dead)
 FROM direct_counts CROSS JOIN wallets CROSS JOIN ledger_counts CROSS JOIN outbox`;
}

export function assertReconciliationCounts(result, report) {
  for (const [key, value] of Object.entries(result)) assert.ok(Number.isSafeInteger(value) && value >= 0, key);
  assert.equal(result.directPlayers, report.players);
  assert.equal(result.queuedPlayers, report.players);
  for (const key of ["badDirectVersions", "badWalletSnapshots", "badLedgerGroups", "unpublishedEvents", "deadEvents"]) {
    assert.equal(result[key], 0, key);
  }
  assert.equal(result.directSequenceSum, result.transactionReceipts, "Direct transactions are not exactly-once against final snapshots");
  assert.equal(result.transactionReceipts, report.final.totals.transactionApplied + report.final.totals.transactionDuplicate);
  const trades = report.final.totals.tradeApplied + report.final.totals.tradeDuplicate;
  assert.ok(trades > 0);
  for (const key of ["trades", "tradeReceipts", "outboxEvents"]) assert.equal(result[key], trades, key);
  for (const key of ["tradeRecordReceipts", "walletSnapshots", "ledgerPostings"]) assert.equal(result[key], 2 * trades, key);
}
