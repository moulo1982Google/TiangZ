import assert from "node:assert/strict";

export const reconciliationAuditContract = Object.freeze({
  version: 2,
  isolation: "repeatable read",
  readOnly: true,
  statementTimeoutMs: 5000,
  sessionTimeoutMs: 60000,
  nodeReviewTimeoutMs: 600000,
});

const countParts = Object.freeze({
  direct: ["directPlayers", "queuedPlayers", "badDirectVersions", "directSequenceSum", "transactionReceipts"],
  trade: ["trades", "tradeReceipts", "tradeRecordReceipts"],
  wallet: ["walletSnapshots", "badWalletSnapshots"],
  ledger: ["ledgerPostings", "badLedgerGroups"],
  outbox: ["outboxEvents", "unpublishedEvents", "deadEvents"],
});

// 对账只做一次性聚合，禁用本事务的 JIT，保持五秒截止时间。 / Disable JIT for one-off audit aggregates without changing the five-second deadline.
export function reconciliationReadOnlySql(query) {
  assert.equal(typeof query, "string");
  return `BEGIN READ ONLY; SET LOCAL statement_timeout='5s'; SET LOCAL jit=off; ${query}; COMMIT;`;
}

// 每个状态集合只扫描一次；账本物化两列后完整分组，避免冷缓存全量索引回表。 / Scan each state set once and materialize ledger input before grouping to avoid cold full-index heap fetches.
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
 ), ledger_input AS MATERIALIZED (
 SELECT trade_id,amount FROM dbproxy_ledger_postings
 ), ledger AS (
 SELECT trade_id,count(*) AS n,sum(amount) AS balance FROM ledger_input GROUP BY trade_id
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

// 全量分项共享一个可重复读快照；每条五秒、会话六十秒是新审计契约。 / Full parts share one repeatable-read snapshot; five seconds per statement and sixty seconds per session form a new audit contract.
export function reconciliationAuditSql(runId) {
  assert.match(runId, /^\d+$/);
  const queries = {
    direct: `WITH direct AS (
      SELECT revision,regexp_replace(convert_from(payload,'UTF8'),'.*sequence=','')::bigint AS sequence
      FROM dbproxy_snapshots WHERE namespace='fault-soak-player' AND record_key LIKE '${runId}:%:direct'
    ) SELECT json_build_object(
      'directPlayers',count(*),
      'queuedPlayers',(SELECT count(*) FROM dbproxy_snapshots WHERE namespace='fault-soak-player' AND record_key LIKE '${runId}:%:queued'),
      'badDirectVersions',count(*) FILTER(WHERE revision<>sequence+1),
      'directSequenceSum',coalesce(sum(sequence),0),
      'transactionReceipts',(SELECT count(*) FROM dbproxy_transactions WHERE operation_id LIKE 'soak:transaction:${runId}:%')
    ) AS counts FROM direct`,
    trade: `SELECT json_build_object(
      'trades',(SELECT count(*) FROM dbproxy_trades),
      'tradeReceipts',(SELECT count(*) FROM dbproxy_trade_operations),
      'tradeRecordReceipts',(SELECT count(*) FROM dbproxy_trade_operation_records)
    ) AS counts`,
    wallet: `SELECT json_build_object('walletSnapshots',count(*),
      'badWalletSnapshots',count(*) FILTER(WHERE revision<>1 OR convert_from(payload,'UTF8') NOT IN ('gold=-1','gold=1'))
    ) AS counts FROM dbproxy_snapshots WHERE namespace='fault-soak-trade'`,
    ledger: `WITH ledger_input AS MATERIALIZED (SELECT trade_id,amount FROM dbproxy_ledger_postings),
      ledger AS (SELECT trade_id,count(*) AS n,sum(amount) AS balance FROM ledger_input GROUP BY trade_id)
      SELECT json_build_object('ledgerPostings',coalesce(sum(n),0),
        'badLedgerGroups',count(*) FILTER(WHERE n<>2 OR balance<>0)) AS counts FROM ledger`,
    outbox: `SELECT json_build_object('outboxEvents',count(*),
      'unpublishedEvents',count(*) FILTER(WHERE published_at IS NULL),
      'deadEvents',count(*) FILTER(WHERE dead_lettered_at IS NOT NULL)) AS counts FROM dbproxy_outbox`,
  };
  const identity = `'version',2,'snapshot',pg_current_snapshot()::text,
    'isolation',current_setting('transaction_isolation'),'readOnly',current_setting('transaction_read_only')='on',
    'atMs',extract(epoch FROM clock_timestamp())*1000`;
  const statements = [
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "SET LOCAL statement_timeout='5s'",
    "SET LOCAL jit=off",
    `SELECT json_build_object('type','begin',${identity},'statementTimeoutMs',5000)`,
  ];
  for (const [name, query] of Object.entries(queries)) {
    statements.push(`SELECT json_build_object('type','part-start','part','${name}',${identity})`);
    statements.push(`SELECT json_build_object('type','part','part','${name}',${identity},'counts',counts) FROM (${query}) audit_part`);
  }
  statements.push("COMMIT", "SELECT json_build_object('type','complete','version',2,'parts',5)");
  return statements.join(";\n") + ";\n";
}

// 缺项、重复、快照变化、部分输出或期限届满都不能成为通过证据。 / Missing, duplicate, inconsistent, partial or expired evidence cannot pass.
export function parseReconciliationAudit(stdout, report, elapsedMs) {
  assert.equal(typeof stdout, "string");
  assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < reconciliationAuditContract.sessionTimeoutMs,
    "Reconciliation session deadline exceeded");
  const rows = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  const names = Object.keys(countParts);
  assert.equal(rows.length, 2 + 2 * names.length, "Incomplete reconciliation session");
  const begin = rows[0];
  assert.equal(begin.type, "begin");
  assert.equal(begin.statementTimeoutMs, reconciliationAuditContract.statementTimeoutMs);
  assert.match(begin.snapshot, /^\d+:\d+:(?:\d+(?:,\d+)*)?$/);
  const counts = {}, parts = [];
  function checkIdentity(row) {
    assert.equal(row.version, reconciliationAuditContract.version);
    assert.equal(row.snapshot, begin.snapshot, "Reconciliation snapshot changed");
    assert.equal(row.isolation, reconciliationAuditContract.isolation);
    assert.equal(row.readOnly, true);
    assert.ok(Number.isFinite(row.atMs) && row.atMs >= begin.atMs, "Invalid audit timestamp");
  }
  checkIdentity(begin);
  for (const [index, name] of names.entries()) {
    const start = rows[1 + index * 2], end = rows[2 + index * 2];
    assert.equal(start.type, "part-start");
    assert.equal(end.type, "part");
    assert.equal(start.part, name);
    assert.equal(end.part, name);
    checkIdentity(start); checkIdentity(end);
    assert.ok(start.atMs >= (index ? rows[index * 2].atMs : begin.atMs), "Audit parts were reordered");
    const durationMs = end.atMs - start.atMs;
    assert.ok(durationMs >= 0 && durationMs < reconciliationAuditContract.statementTimeoutMs, `${name} deadline exceeded`);
    assert.deepEqual(Object.keys(end.counts).sort(), [...countParts[name]].sort(), `Incomplete ${name} counts`);
    Object.assign(counts, end.counts);
    parts.push({ name, durationMs, counts: end.counts });
  }
  assert.deepEqual(rows.at(-1), { type: "complete", version: reconciliationAuditContract.version, parts: names.length },
    "Reconciliation transaction did not complete");
  assertReconciliationCounts(counts, report);
  return { counts, audit: { contract: reconciliationAuditContract, snapshot: begin.snapshot, elapsedMs, parts } };
}

export function assertReconciliationCounts(result, report) {
  assert.deepEqual(Object.keys(result).sort(), Object.values(countParts).flat().sort(), "Incomplete reconciliation counts");
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
