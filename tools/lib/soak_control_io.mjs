import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const waitCell = new Int32Array(new SharedArrayBuffer(4));

// 控制文件只通过同目录 rename 发布；Windows 短暂共享冲突有界重试，绝不先删旧文件。
// Publish complete control files by same-directory rename; bound Windows sharing retries without deleting the old value.
export function saveControlJson(file, value, {
  io = fs, platform = process.platform, now = () => performance.now(),
  pause = ms => Atomics.wait(waitCell, 0, 0, ms), retryMs = 1000,
} = {}) {
  assert.ok(Number.isFinite(retryMs) && retryMs >= 0 && retryMs <= 1000);
  const bytes = JSON.stringify(value, null, 2) + '\n';
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  io.writeFileSync(temporary, bytes, {flag: 'wx'});
  const deadline = now() + retryMs;
  try {
    for (;;) {
      try { io.renameSync(temporary, file); return; }
      catch (error) {
        const remaining = deadline - now();
        if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || remaining <= 0) throw error;
        pause(Math.min(20, remaining));
      }
    }
  } catch (error) {
    // 保留未发布内容供取证；原目标保持完整，失败由调用方终止本轮。
    // Retain the unpublished candidate for diagnosis; the caller must fail the run.
    error.controlFile = file;
    error.unpublishedFile = temporary;
    throw error;
  }
}

// 后台故障任务的拒绝立即接管，由协调循环显式检查；清理仍可等待已接管的任务。
// Observe a background rejection immediately, then surface it in the coordinator loop while permitting cleanup.
export class ObservedControlTask {
  pending = null;
  failure = null;
  check() { if (this.failure) throw this.failure; }
  start(work) {
    this.check();
    assert.equal(this.pending, null, 'A control task is already in progress');
    this.pending = Promise.resolve().then(work)
      .catch(error => { this.failure = error instanceof Error ? error : new Error(String(error)); })
      .finally(() => { this.pending = null; });
    return this.pending;
  }
  async settle() { if (this.pending) await this.pending; }
}
