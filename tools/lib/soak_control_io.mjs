import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const waitCell = new Int32Array(new SharedArrayBuffer(4));

function publishTemporary(file, temporary, {io, platform, now, pause, retryMs}) {
  const deadline = now() + retryMs;
  for (;;) {
    try { io.renameSync(temporary, file); return; }
    catch (error) {
      const remaining = deadline - now();
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || remaining <= 0) throw error;
      pause(Math.min(20, remaining));
    }
  }
}

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
  try {
    publishTemporary(file, temporary, {io, platform, now, pause, retryMs});
  } catch (error) {
    // 保留未发布内容供取证；原目标保持完整，失败由调用方终止本轮。
    // Retain the unpublished candidate for diagnosis; the caller must fail the run.
    error.controlFile = file;
    error.unpublishedFile = temporary;
    throw error;
  }
}

// 大报告按有界块写入同目录临时文件，写完关闭才原子发布；失败保留旧报告和临时证据。
// Write bounded chunks before atomic publication; retain both old report and failed candidate on error.
export function saveControlJsonChunks(file, chunks, {
  io = fs, platform = process.platform, now = () => performance.now(),
  pause = ms => Atomics.wait(waitCell, 0, 0, ms), retryMs = 1000,
} = {}) {
  assert.ok(Number.isFinite(retryMs) && retryMs >= 0 && retryMs <= 1000);
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = io.openSync(temporary, 'wx');
    let parts = [], size = 0;
    const flush = () => {
      if (!size) return;
      const bytes = Buffer.concat(parts, size);
      for (let offset = 0; offset < bytes.length;) {
        const written = io.writeSync(fd, bytes, offset, bytes.length - offset);
        assert.ok(Number.isInteger(written) && written > 0 && written <= bytes.length - offset, 'Invalid control-file write');
        offset += written;
      }
      parts = []; size = 0;
    };
    for (const chunk of chunks) {
      assert.ok(typeof chunk === 'string' || Buffer.isBuffer(chunk), 'Invalid control-file chunk');
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      assert.ok(bytes.length <= 1048576, 'Control-file chunk exceeds its bound');
      if (!bytes.length) continue;
      if (size + bytes.length > 262144) flush();
      parts.push(bytes); size += bytes.length;
      if (size >= 262144) flush();
    }
    flush(); io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
    publishTemporary(file, temporary, {io, platform, now, pause, retryMs});
  } catch (error) {
    if (fd !== undefined) {
      try { io.closeSync(fd); } catch { /* Preserve the original publication failure. */ }
    }
    error.controlFile = file; error.unpublishedFile = temporary;
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
