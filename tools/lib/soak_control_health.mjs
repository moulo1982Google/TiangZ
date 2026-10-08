import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

// PID、创建时间、程序路径和脚本身份同时匹配，避免旧状态或 PID 复用冒充运行中。
// Match the PID, creation time, executable and script before treating saved state as live.
export function matchesControlProcess(expected, actual) {
  return actual != null && actual.ProcessId === expected.pid
    && Number.isFinite(Date.parse(expected.startedAt))
    && Date.parse(actual.CreationDate) === Date.parse(expected.startedAt)
    && actual.ExecutablePath?.toLowerCase() === expected.executable.toLowerCase()
    && typeof actual.CommandLine === 'string' && actual.CommandLine.includes(expected.script);
}

export async function probeControlProcess(expected) {
  assert.ok(Number.isSafeInteger(expected.pid) && expected.pid > 0);
  assert.equal(process.platform, 'win32', 'The joint coordinator runs on the Windows host');
  const script = `Get-CimInstance Win32_Process -Filter "ProcessId=${expected.pid}" | Select-Object ProcessId,CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
  const {stdout} = await promisify(execFile)('pwsh', ['-NoProfile', '-Command', script],
    {windowsHide: true, timeout: 5000, maxBuffer: 16384, encoding: 'utf8'});
  const actual = stdout.trim() ? JSON.parse(stdout) : null;
  return {alive: matchesControlProcess(expected, actual), checkedAt: new Date().toISOString(), expectedPid: expected.pid};
}

export function effectiveControlStatus(state, probe) {
  if (state.finishedAt) return state.status;
  if (probe?.alive === false) return 'interrupted';
  if (probe?.alive !== true) return 'unverified';
  return state.status;
}
