import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ReportHistory, saveControlReport} from './soak_report_history.mjs';
import {saveControlJsonChunks} from './soak_control_io.mjs';

function sandbox(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tiangz-report-history-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('tiangz-report-history-'));
    fs.rmSync(directory, {recursive: true, force: true});
  });
  return {directory, file: path.join(directory, 'report.json')};
}

test('streamed report preserves every record and canonical JSON bytes including Unicode', t => {
  const {directory, file} = sandbox(t);
  const progress = new ReportHistory(path.join(directory, 'progress.jsonl'));
  const empty = new ReportHistory(path.join(directory, 'empty.jsonl'));
  const rows = [{elapsedSeconds: 5, total: {transactions: 8}, name: '玩家😀\n一'}, null,
    {text: '😀'.repeat(20000), nested: [{a: true}, {b: '繁體'}]}];
  for (const row of rows) progress.push(row);
  const report = {status: 'running', progress, skipped: undefined, empty, final: {passed: true}, tail: '末尾'};
  saveControlReport(file, report);
  const expected = {...report, progress: rows, empty: []};
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(expected, null, 2) + '\n');
  assert.equal(progress.length, rows.length); assert.deepEqual(progress.at(-1), rows.at(-1));
  assert.deepEqual([...progress.rows()], rows);
  assert.throws(() => JSON.stringify(report), /whole-report JSON.stringify is forbidden/);
  assert.throws(() => new ReportHistory(progress.file), {code: 'EEXIST'});
});

test('resident latest value matches its immutable disk record rather than an input alias', t => {
  const {directory} = sandbox(t), series = new ReportHistory(path.join(directory, 'history.jsonl'));
  const row = {value: {n: 1}}; series.push(row); row.value.n = 2;
  assert.equal(series.at(-1).value.n, 1); assert.deepEqual([...series.rows()], [{value: {n: 1}}]);
});

test('missing, extra, truncated and over-bound history fail without replacing the previous report', t => {
  const {directory, file} = sandbox(t);
  for (const [index, damage] of [p => fs.truncateSync(p, 0), p => fs.appendFileSync(p, '{}\n'),
    p => fs.appendFileSync(p, '{'), p => fs.writeFileSync(p, 'x'.repeat(1025) + '\n')].entries()) {
    const series = new ReportHistory(path.join(directory, `history-${index}.jsonl`), {maximumRowBytes: 1024});
    series.push({n: 1}); fs.writeFileSync(file, '{"status":"previous"}\n'); damage(series.file);
    assert.throws(() => saveControlReport(file, {status: 'passed', samples: series}), error => {
      assert.equal(error.controlFile, file); assert.ok(fs.existsSync(error.unpublishedFile)); return true;
    });
    assert.equal(fs.readFileSync(file, 'utf8'), '{"status":"previous"}\n');
  }
});

test('oversized or unserializable records fail before changing history count or latest', t => {
  const {directory} = sandbox(t), series = new ReportHistory(path.join(directory, 'bounded.jsonl'), {maximumRowBytes: 16});
  series.push({n: 1});
  assert.throws(() => series.push({data: 'x'.repeat(32)}), /exceeds its bound/);
  assert.throws(() => series.push(undefined), /must be JSON/);
  assert.equal(series.length, 1); assert.deepEqual(series.at(-1), {n: 1});
  assert.deepEqual([...series.rows()], [{n: 1}]);
});

test('streamed atomic publication handles real short writes and retains old bytes during Windows sharing retry', t => {
  const {file} = sandbox(t); fs.writeFileSync(file, '{"old":true}\n');
  let now = 0, renames = 0, writes = 0;
  const io = {...fs, writeSync(fd, buffer, offset, length) {
    writes++; return fs.writeSync(fd, buffer, offset, Math.min(7, length));
  }, renameSync(from, to) {
    assert.equal(fs.readFileSync(to, 'utf8'), '{"old":true}\n');
    if (++renames < 3) throw Object.assign(new Error('sharing'), {code: 'EPERM'});
    fs.renameSync(from, to);
  }};
  saveControlJsonChunks(file, ['{"text":"😀', '中文"}\n'], {io, platform: 'win32', now: () => now, pause: ms => {now += ms;}});
  assert.equal(renames, 3); assert.ok(writes > 1); assert.equal(now, 40);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {text: '😀中文'});
});

test('stream write errors and iterator failures retain candidate and original report', t => {
  const {file} = sandbox(t); fs.writeFileSync(file, '{"old":true}\n');
  assert.throws(() => saveControlJsonChunks(file, ['{}\n'], {io: {...fs, writeSync() {
    throw Object.assign(new Error('disk full'), {code: 'ENOSPC'});
  }}}), error => {
    assert.equal(error.code, 'ENOSPC'); assert.ok(fs.existsSync(error.unpublishedFile)); return true;
  });
  assert.equal(fs.readFileSync(file, 'utf8'), '{"old":true}\n');
  function* broken() {yield '{'; throw new Error('source failure');}
  assert.throws(() => saveControlJsonChunks(file, broken()), /source failure/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"old":true}\n');
});

test('complete report larger than the assigned V8 heap succeeds in a constrained child', {timeout: 60000}, t => {
  const {directory} = sandbox(t);
  const module = new URL('./soak_report_history.mjs', import.meta.url).href;
  const script = `import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict'; import v8 from 'node:v8';
    import {ReportHistory,saveControlReport} from ${JSON.stringify(module)};
    const root=process.argv[1],rows=new ReportHistory(path.join(root,'large.jsonl'));
    for(let n=0;n<4096;n++)rows.push({n,text:'x'.repeat(16384)});
    const file=path.join(root,'large-report.json');saveControlReport(file,{status:'fixture',samples:rows});
    let n=0;for(const row of rows.rows()){assert.equal(row.n,n++);assert.equal(row.text.length,16384);}
    assert.equal(n,4096);const size=fs.statSync(file).size;assert.ok(size>64*1024*1024);
    console.log(JSON.stringify({rows:n,bytes:size,heapLimitBytes:v8.getHeapStatistics().heap_size_limit,peakRssBytes:process.resourceUsage().maxRSS*1024}));`;
  const result = spawnSync(process.execPath, ['--max-old-space-size=32', '--max-semi-space-size=2', '--input-type=module', '-e', script, directory],
    {encoding: 'utf8', windowsHide: true, timeout: 55000, maxBuffer: 16384});
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const evidence = JSON.parse(result.stdout);
  assert.ok(evidence.heapLimitBytes <= 40*1024*1024); assert.equal(evidence.rows, 4096);
  assert.ok(evidence.bytes > evidence.heapLimitBytes);
});
