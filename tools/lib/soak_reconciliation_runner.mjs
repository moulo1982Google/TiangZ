import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { reconciliationAuditContract, reconciliationAuditSql, reconciliationReadOnlySql,
  parseReconciliationAudit } from "./soak_reconciliation.mjs";

// 只对已停写的隔离阶段执行收尾；部分输出不能发布通过结果。 / Audit an isolated quiescent stage; partial output cannot publish a passing result.
export function reconcile(resources, database, redisIndex, dbReport, directory) {
  assert.match(database, /^v07_stage_[a-z0-9_]+$/);
  assert.match(dbReport.ready.runId, /^\d+$/);
  assert.ok(Number.isInteger(redisIndex) && redisIndex >= 0 && redisIndex < 16);
  function docker(args) {
    const child = spawnSync("docker", args, { encoding: "utf8", windowsHide: true,
      timeout: reconciliationAuditContract.sessionTimeoutMs, maxBuffer: 32 * 1024 * 1024 });
    assert.equal(child.status, 0, child.error?.message ?? child.stderr);
    return child.stdout.trim();
  }
  const psql = ["exec", resources.containers.postgres.name, "psql", "-X", "-U", "tzcap", "-d", database,
    "-v", "ON_ERROR_STOP=1", "-Atqc"];
  const query = reconciliationAuditSql(dbReport.ready.runId);
  fs.writeFileSync(path.join(directory, "reconciliation.sql"), query);
  const started = performance.now();
  const session = docker([...psql, query]);
  const elapsedMs = performance.now() - started;
  fs.writeFileSync(path.join(directory, "reconciliation-session.jsonl"), session + "\n");
  const { counts: result, audit } = parseReconciliationAudit(session, dbReport, elapsedMs);
  const eventIds = docker([...psql, reconciliationReadOnlySql(
    'SELECT event_id FROM dbproxy_outbox ORDER BY event_id COLLATE "C"')]).split("\n");
  const script = `local ids={} local seen={} local total=0 local cursor='-' repeat local rows=redis.call('XRANGE',KEYS[1],cursor,'+','COUNT',512) for _,row in ipairs(rows) do total=total+1 local id=nil for i=1,#row[2],2 do if row[2][i]=='event_id' then id=row[2][i+1] end end if not id then return redis.error_reply('event_id missing') end if not seen[id] then seen[id]=true table.insert(ids,id) end cursor='('..row[1] end until #rows==0 return cjson.encode({ids=ids,messages=total})`;
  const delivered = JSON.parse(docker(["exec", resources.containers.reliableRedis.name, "redis-cli", "-n", String(redisIndex),
    "--no-auth-warning", "--raw", "EVAL_RO", script, "1", "dbproxy:outbox:fault-soak.trade"]));
  assert.equal(delivered.ids.length, eventIds.length);
  delivered.ids.sort(); eventIds.sort();
  assert.deepEqual(delivered.ids, eventIds, "Missing/different delivered event IDs");
  result.redisMessages = delivered.messages;
  result.uniqueDeliveredEvents = delivered.ids.length;
  result.eventIdsSha256 = crypto.createHash("sha256").update(eventIds.join("\n")).digest("hex");
  result.audit = audit;
  result.status = "passed";
  result.scope = "This quiescent fixture: complete receipts vs final sequences, trade snapshot/ledger/outbox cardinalities, zero-sum trade postings, and exact delivered event ID set. Full stream metadata/payload review follows separately; consumer projections/7-day deployment are separate.";
  fs.writeFileSync(path.join(directory, "reconciliation.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}
