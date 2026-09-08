import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const [runDir, deadlineText, prefixBase] = process.argv.slice(2);
const deadline = Date.parse(deadlineText);
if (!runDir?.startsWith('/var/log/tiangz-chaos/') || !Number.isFinite(deadline) || !/^[a-zA-Z0-9_-]{1,64}$/.test(prefixBase)) throw Error('invalid run arguments');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const save = (name, value) => writeFileSync(path.join(runDir, name), JSON.stringify(value, null, 2) + '\n');
const segments = [];
const uid = Number(execFileSync('id', ['-u', 'tiangz'], { encoding: 'utf8' }).trim());
const gid = Number(execFileSync('id', ['-g', 'tiangz'], { encoding: 'utf8' }).trim());
try {
  while (deadline - Date.now() >= 30_000) {
    const seconds = Math.min(14_400, Math.floor((deadline - Date.now()) / 1000));
    const prefix = `${prefixBase}_${segments.length + 1}`;
    const child = spawn('/opt/tiangz-dbproxy/dbproxy_relay_soak', [], {
      uid, gid, env: { ...process.env, DBPROXY_RELAY_SOAK_SECONDS: String(seconds), DBPROXY_RELAY_SOAK_PREFIX: prefix },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    child.stdout.on('data', chunk => { process.stdout.write(chunk); tail = (tail + chunk).slice(-32_768); });
    child.stderr.pipe(process.stderr);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    const line = tail.split(/\r?\n/).findLast(l => l.startsWith('RELAY_FINAL '));
    const result = line ? JSON.parse(line.slice(12)) : null;
    if (code !== 0 || result?.passed !== true || result.prefix !== prefix || result.committed < 1) throw Error(`relay segment ${prefix} failed, exit=${code}`);
    segments.push({ seconds, ...result });
    save('relay-segments.json', segments);
  }
  if (!segments.length) throw Error('no relay segments completed');
  const sql = query => execFileSync('docker', ['exec', '-i', 'tiangz-dbproxy-postgres', 'sh', '-c', 'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'], { input: query, encoding: 'utf8', maxBuffer: 8 * 1024 ** 2 }).trim();
  // Outbox publication is asynchronous; use the same bounded drain window as local validation.
  const drainDeadline = Date.now() + 180_000;
  while (true) {
    let drained = true;
    for (const segment of segments) {
      const counts = sql(`SELECT count(*), count(*) FILTER (WHERE published_at IS NOT NULL), count(*) FILTER (WHERE dead_lettered_at IS NOT NULL) FROM dbproxy_outbox WHERE starts_with(event_id, '${segment.prefix}:');`).split('|').map(Number);
      if (counts[0] !== segment.committed || counts[2] !== 0) throw Error(`outbox record/dead-letter mismatch: ${segment.prefix}`);
      if (counts[1] !== counts[0]) drained = false;
    }
    if (drained) break;
    if (Date.now() >= drainDeadline) throw Error('outbox drain timed out');
    await sleep(1000);
  }
  const redisUrl = new URL(process.env.DBPROXY_REDIS_URL);
  const stream = JSON.parse(execFileSync('docker', ['exec', '-i', 'tiangz-dbproxy-redis', 'sh', '-c', 'read -r REDISCLI_AUTH; export REDISCLI_AUTH; exec redis-cli --json XRANGE external.validation.events - +'], {
    input: decodeURIComponent(redisUrl.password) + '\n', encoding: 'utf8', maxBuffer: 64 * 1024 ** 2,
  }));
  const verified = [];
  for (const segment of segments) {
    const prefix = segment.prefix;
    const counts = sql(`SELECT count(*), count(*) FILTER (WHERE published_at IS NOT NULL), count(*) FILTER (WHERE dead_lettered_at IS NOT NULL) FROM dbproxy_outbox WHERE starts_with(event_id, '${prefix}:');`).split('|').map(Number);
    if (counts[0] !== segment.committed || counts[1] !== counts[0] || counts[2] !== 0) throw Error(`outbox SQL mismatch: ${prefix}`);
    const facts = sql(`SELECT
      (SELECT count(*) FROM dbproxy_snapshots WHERE namespace='relay_soak' AND starts_with(record_key, '${prefix}:')),
      (SELECT count(*) FROM dbproxy_snapshots WHERE namespace='relay_soak' AND starts_with(record_key, '${prefix}:') AND revision=1 AND (convert_from(payload,'UTF8')::jsonb->>'sequence')::bigint=split_part(record_key,':',2)::bigint),
      (SELECT count(*) FROM dbproxy_append_records WHERE namespace='relay_soak_audit' AND starts_with(record_key, '${prefix}:') AND operation_id=record_key AND (convert_from(payload,'UTF8')::jsonb->>'sequence')::bigint=split_part(record_key,':',2)::bigint);`).split('|').map(Number);
    if (facts[0] !== segment.committed * 2 || facts[1] !== facts[0] || facts[2] !== segment.committed) throw Error(`snapshot/fact mismatch: ${prefix}`);
    const seen = new Set();
    for (const [, fields] of stream) {
      const values = Object.fromEntries(Array.from({ length: fields.length / 2 }, (_, i) => [fields[i * 2], fields[i * 2 + 1]]));
      const id = values.event_id;
      if (!id?.startsWith(prefix + ':') || seen.has(id)) continue;
      if (Number(id.slice(prefix.length + 1)) !== seen.size + 1) throw Error(`stream ordering mismatch: ${prefix}`);
      seen.add(id);
    }
    if (seen.size !== segment.committed) throw Error(`stream delivery mismatch: ${prefix}`);
    verified.push({ ...segment, counts, facts, streamUnique: seen.size });
  }
  save('relay-validation-final.json', { passed: true, at: new Date().toISOString(), segments: verified });
  console.log('RELAY_WINDOW_PASSED');
} catch (error) {
  save('relay-validation-final.json', { passed: false, at: new Date().toISOString(), error: error.message, segments });
  process.exitCode = 1;
}
