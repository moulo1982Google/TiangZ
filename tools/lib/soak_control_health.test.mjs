import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {matchesControlProcess, effectiveControlStatus} from './soak_control_health.mjs';

const expected = {pid: 12, startedAt: '2026-09-27T07:00:00.1230000Z', executable: path.resolve('fixture-node.exe'), script: path.resolve('fixture-controller.mjs')};
const actual = {ProcessId: 12, CreationDate: '2026-09-27T15:00:00.123+08:00', ExecutablePath: expected.executable.toUpperCase(), CommandLine: `node "${expected.script}"`};
test('identity checks reject dead processes, PID reuse and unrelated programs', () => {
  assert.equal(matchesControlProcess(expected, actual), true);
  for (const changed of [null, {...actual, ProcessId: 13}, {...actual, CreationDate: '2026-09-27T07:00:01.123Z'},
    {...actual, ExecutablePath: path.resolve('other.exe')}, {...actual, CommandLine: 'node other.mjs'}]) {
    assert.equal(matchesControlProcess(expected, changed), false);
  }
});
test('saved running state never overrides a missing or unverified coordinator', () => {
  assert.equal(effectiveControlStatus({status: 'running'}, {alive: false}), 'interrupted');
  assert.equal(effectiveControlStatus({status: 'running'}), 'unverified');
  assert.equal(effectiveControlStatus({status: 'running'}, {alive: true}), 'running');
  assert.equal(effectiveControlStatus({status: 'failed', finishedAt: 'now'}, {alive: false}), 'failed');
  assert.equal(effectiveControlStatus({status: 'passed', finishedAt: 'now'}, {alive: false}), 'passed');
});
