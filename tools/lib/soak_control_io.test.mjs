import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {saveControlJson, ObservedControlTask} from './soak_control_io.mjs';

function sandbox(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tiangz-control-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('tiangz-control-'));
    fs.rmSync(directory, {recursive: true, force: true});
  });
  return {directory, file: path.join(directory, 'response.json')};
}
const fault = code => Object.assign(new Error(code), {code});

test('transient Windows sharing errors preserve the old complete record until publication', t => {
  const {directory, file} = sandbox(t);
  saveControlJson(file, {id: 7});
  let elapsed = 0, attempts = 0;
  const io = {...fs, renameSync(from, to) {
    assert.deepEqual(JSON.parse(fs.readFileSync(to, 'utf8')), {id: 7});
    if (++attempts <= 3) throw fault(['EPERM', 'EACCES', 'EBUSY'][attempts - 1]);
    fs.renameSync(from, to);
  }};
  saveControlJson(file, {id: 8, data: 'complete'}, {io, platform: 'win32', now: () => elapsed, pause: ms => { elapsed += ms; }});
  assert.equal(attempts, 4); assert.equal(elapsed, 60);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {id: 8, data: 'complete'});
  assert.deepEqual(fs.readdirSync(directory), ['response.json']);
});

test('persistent sharing failure stops at the original deadline and retains unpublished evidence', t => {
  const {directory, file} = sandbox(t); saveControlJson(file, {id: 7});
  let elapsed = 0, attempts = 0;
  const io = {...fs, renameSync() { attempts++; throw fault('EPERM'); }};
  assert.throws(() => saveControlJson(file, {id: 8}, {io, platform: 'win32', retryMs: 55,
    now: () => elapsed, pause: ms => { assert.ok(ms > 0); elapsed += ms; }}), error => {
    assert.equal(error.code, 'EPERM'); assert.equal(error.controlFile, file);
    assert.deepEqual(JSON.parse(fs.readFileSync(error.unpublishedFile, 'utf8')), {id: 8}); return true;
  });
  assert.equal(elapsed, 55); assert.equal(attempts, 4);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {id: 7});
  assert.equal(fs.readdirSync(directory).length, 2);
});

test('disk errors and non-Windows permission errors are not retried', t => {
  const {file} = sandbox(t);
  for (const [platform, code] of [['win32', 'ENOSPC'], ['linux', 'EPERM']]) {
    let attempts = 0;
    assert.throws(() => saveControlJson(file, {}, {platform, io: {...fs, renameSync() { attempts++; throw fault(code); }},
      pause: () => assert.fail('Unexpected retry')}), {code});
    assert.equal(attempts, 1);
  }
});

test('a failed background publication is observed before the event-loop unhandled-rejection checkpoint', async () => {
  const task = new ObservedControlTask(), unhandled = [];
  const listener = error => unhandled.push(error); process.on('unhandledRejection', listener);
  try {
    const expected = fault('EPERM');
    task.start(async () => { throw expected; });
    await task.settle(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []); assert.equal(task.pending, null);
    assert.throws(() => task.check(), error => error === expected);
    assert.throws(() => task.start(() => {}), error => error === expected);
    await task.settle(); // Failure remains visible without preventing resource cleanup.
  } finally { process.off('unhandledRejection', listener); }
});

test('control tasks cannot overlap and synchronous action errors also reach the owner', async () => {
  const task = new ObservedControlTask(); let release;
  task.start(() => new Promise(resolve => { release = resolve; }));
  assert.throws(() => task.start(() => {}), /already in progress/);
  await Promise.resolve(); release(); await task.settle(); task.check();
  task.start(() => { throw new Error('action failed'); });
  await task.settle(); assert.throws(() => task.check(), /action failed/);
});

test('actual Windows reader denying delete access releases an atomic replacement', {skip: process.platform !== 'win32', timeout: 15000}, async t => {
  const {file} = sandbox(t); saveControlJson(file, {id: 7});
  const code = '$s=[IO.File]::Open($env:TIANGZ_CONTROL_LOCK_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try { [Console]::WriteLine("LOCKED"); [Console]::Out.Flush(); Start-Sleep -Milliseconds 250 } finally { $s.Dispose() }';
  const child = spawn('pwsh', ['-NoProfile', '-Command', code], {windowsHide: true, env: {...process.env, TIANGZ_CONTROL_LOCK_FILE: file}, stdio: ['ignore', 'pipe', 'pipe']});
  const closed = once(child, 'close'); t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = ''; for await (const chunk of child.stdout) { stdout += chunk; if (stdout.includes('LOCKED')) break; }
  assert.match(stdout, /LOCKED/);
  const began = performance.now(); saveControlJson(file, {id: 8});
  assert.ok(performance.now() - began >= 100, 'The actual sharing conflict was not exercised');
  assert.equal((await closed)[0], 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {id: 8});
});
