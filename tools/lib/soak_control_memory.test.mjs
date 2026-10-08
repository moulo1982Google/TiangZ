import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readControlCgroup, validateControlMemory} from './soak_control_memory.mjs';

test('finite ancestor budget is detected even when the direct service limit is unlimited', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tiangz-control-memory-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('tiangz-control-memory-'));
    fs.rmSync(directory, {recursive: true, force: true});
  });
  const parent = path.join(directory, 'control.slice'), service = path.join(parent, 'run.service');
  fs.mkdirSync(service, {recursive: true});
  fs.writeFileSync(path.join(service, 'memory.max'), 'max\n');
  for (const [key, value] of Object.entries({'memory.max': '536870912', 'memory.current': '104857600',
    'memory.peak': '125829120', 'memory.swap.current': '0', 'memory.events': 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n',
    'memory.stat': 'anon 52428800\nkernel 1048576\nshmem 0\nfile_dirty 0\nfile_writeback 0\nfile 51380224'})) {
    fs.writeFileSync(path.join(parent, key), value + '\n');
  }
  const membershipFile = path.join(directory, 'membership'); fs.writeFileSync(membershipFile, '0::/control.slice/run.service\n');
  const group = readControlCgroup({root: directory, membershipFile});
  assert.equal(group.path, 'control.slice'); assert.equal(group.memoryMaxBytes, 536870912);
  assert.equal(group.memoryBytes, 104857600); assert.equal(group.memoryEvents.oom_kill, 0);
  fs.writeFileSync(path.join(parent, 'memory.max'), 'max\n');
  assert.throws(() => readControlCgroup({root: directory, membershipFile}), /no verified finite/);
  fs.writeFileSync(membershipFile, '0::/../escape\n');
  assert.throws(() => readControlCgroup({root: directory, membershipFile}), /Missing valid/);
});

function sample() {return {rss: 64*1048576, heapLimitBytes: 140*1048576,
  cgroup: {memoryMaxBytes: 512*1048576, memoryBytes: 128*1048576, memoryPeakBytes: 160*1048576,
    memorySwapBytes: 0, memoryEvents: {oom: 0, oom_kill: 0},
    memoryStat: {anon: 100*1048576, kernel: 2*1048576, shmem: 0, file_dirty: 0, file_writeback: 0}}};}

test('default multi-GiB V8 heap fails before any workload starts', () => {
  validateControlMemory(sample()); const row = sample(); row.heapLimitBytes = 2348810240;
  assert.throws(() => validateControlMemory(row), /Node heap budget/);
});

test('RSS, shared reserve, limit changes, swap and OOM independently reject qualification', () => {
  for (const change of [row => {row.rss = 321*1048576;}, row => {row.cgroup.memoryStat.anon = 449*1048576;},
    row => {row.cgroup.memoryBytes = 513*1048576;},
    row => {row.cgroup.memoryMaxBytes = 1024*1048576;}, row => {row.cgroup.memorySwapBytes = 1;},
    row => {row.cgroup.memoryEvents.oom = 1;}, row => {row.cgroup.memoryEvents.oom_kill = 1;}]) {
    const row = sample(); change(row); assert.throws(() => validateControlMemory(row));
  }
});

test('missing or malformed control evidence is not converted into zero usage', () => {
  for (const change of [row => {delete row.cgroup.memoryEvents.oom;}, row => {row.rss = 0;},
    row => {row.cgroup.memoryBytes = -1;}, row => {row.cgroup.memoryPeakBytes = NaN;},
    row => {delete row.heapLimitBytes;}, row => {delete row.cgroup.memoryStat.anon;}]) {
    const row = sample(); change(row); assert.throws(() => validateControlMemory(row));
  }
});

test('clean page-cache growth remains visible without being classified as private-memory exhaustion', () => {
  const row = sample(); row.cgroup.memoryBytes = 500*1048576; row.cgroup.memoryStat.file = 398*1048576;
  validateControlMemory(row);
  row.cgroup.memoryStat.file_dirty = 360*1048576;
  assert.throws(() => validateControlMemory(row), /reserve breached/);
});
