import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import assert from 'node:assert/strict';

function integer(value) {
  const parsed = Number(value.trim());
  assert.ok(Number.isSafeInteger(parsed) && parsed >= 0, 'Invalid control cgroup counter');
  return parsed;
}

// 按真实 cgroup 祖先查最小限额，不能把 Node 未识别父组的默认堆上限当作可用预算。
// Inspect ancestor limits directly instead of trusting Node's default heap budget.
export function readControlCgroup({root = '/sys/fs/cgroup', membershipFile = '/proc/self/cgroup'} = {}) {
  const membership = fs.readFileSync(membershipFile, 'utf8').split('\n').find(line => line.startsWith('0::'))?.slice(3);
  assert.ok(membership?.startsWith('/') && !membership.split('/').includes('..'), 'Missing valid cgroup v2 membership');
  const base = path.resolve(root); let current = path.resolve(base, '.' + membership), selected;
  assert.ok(current === base || current.startsWith(base + path.sep), 'Control cgroup escaped its root');
  while (current !== base) {
    const maximum = fs.readFileSync(path.join(current, 'memory.max'), 'utf8').trim();
    if (maximum !== 'max') {
      const limit = integer(maximum);
      if (!selected || limit < selected.memoryMaxBytes) selected = {directory: current, memoryMaxBytes: limit};
    }
    current = path.dirname(current);
  }
  assert.ok(selected, 'Control cgroup has no verified finite memory limit');
  const read = name => fs.readFileSync(path.join(selected.directory, name), 'utf8');
  const counters = name => Object.fromEntries(read(name).trim().split('\n').map(line => {
    const [key, value] = line.split(/\s+/); return [key, integer(value)];
  }));
  return {path: path.relative(base, selected.directory), memoryMaxBytes: selected.memoryMaxBytes,
    memoryBytes: integer(read('memory.current')), memoryPeakBytes: integer(read('memory.peak')),
    memorySwapBytes: integer(read('memory.swap.current')),
    memoryStat: counters('memory.stat'), memoryEvents: counters('memory.events')};
}

// 采集真实进程堆、外部缓冲、RSS 和共享控制组，不触发强制 GC 或改变产品期限。
// Observe heap, external buffers, RSS and shared cgroup without forcing GC or changing product deadlines.
export function controlMemorySnapshot(point, options) {
  return {point, at: new Date().toISOString(), pid: process.pid, ...process.memoryUsage(),
    peakRssBytes: process.resourceUsage().maxRSS * 1024, heapLimitBytes: v8.getHeapStatistics().heap_size_limit,
    cgroup: readControlCgroup(options)};
}

// 控制侧也执行独立预算门禁，超限或观测缺失须停止本轮，不能继续报合格。
// Fail qualification on control-budget violations or missing evidence as well as target-side failures.
export function validateControlMemory(row, {memoryMaxBytes = 536870912, heapLimitBytes = 167772160,
  processRssMaxBytes = 335544320, headroomBytes = 67108864} = {}) {
  const group = row.cgroup;
  const reserveCharges = ['anon', 'kernel', 'shmem', 'file_dirty', 'file_writeback'].map(key => group.memoryStat[key]);
  for (const value of [row.heapLimitBytes, row.rss, group.memoryBytes, group.memoryPeakBytes,
    group.memorySwapBytes, group.memoryEvents.oom, group.memoryEvents.oom_kill, ...reserveCharges]) {
    assert.ok(Number.isSafeInteger(value) && value >= 0, 'Missing or invalid control memory evidence');
  }
  assert.ok(row.heapLimitBytes > 0 && row.rss > 0, 'Missing live control process memory');
  assert.equal(group.memoryMaxBytes, memoryMaxBytes, 'Shared control memory limit changed');
  assert.ok(row.heapLimitBytes <= heapLimitBytes, 'Node heap budget exceeds its assigned control budget');
  assert.ok(row.rss <= processRssMaxBytes, 'Control process RSS ceiling');
  assert.ok(group.memoryBytes <= memoryMaxBytes, 'Control group total memory ceiling');
  // 干净文件缓存保留在总量证据里，由内核回收；预留门禁单独覆盖匿名、内核、共享和脏页。
  // Keep clean page cache in total accounting; apply the reserve to anonymous/kernel/shared/dirty charges.
  assert.ok(reserveCharges.reduce((sum, value) => sum + value, 0) <= memoryMaxBytes - headroomBytes, 'Control group memory reserve breached');
  assert.equal(group.memorySwapBytes, 0, 'Control group swap used');
  assert.equal(group.memoryEvents.oom, 0, 'Control group OOM');
  assert.equal(group.memoryEvents.oom_kill, 0, 'Control group OOM kill');
}
