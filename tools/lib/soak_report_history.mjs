import fs from 'node:fs';
import assert from 'node:assert/strict';
import {StringDecoder} from 'node:string_decoder';
import {saveControlJsonChunks} from './soak_control_io.mjs';

function* lines(file, limit) {
  const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(65536), decoder = new StringDecoder('utf8');
  let pending = '';
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) {
        pending += decoder.end();
        assert.equal(pending, '', 'Incomplete report history record');
        return;
      }
      pending += decoder.write(buffer.subarray(0, count));
      let split;
      while ((split = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, split); pending = pending.slice(split + 1);
        assert.ok(Buffer.byteLength(line) <= limit, 'Report history record exceeds its bound');
        assert.ok(line.length, 'Empty report history record');
        yield line;
      }
      assert.ok(Buffer.byteLength(pending) <= limit, 'Report history record exceeds its bound');
    }
  } finally { fs.closeSync(fd); }
}

// 历史逐条落盘，内存仅保留末条和计数；不裁剪采样或验收记录，文件必须独占创建。
// Persist every record while retaining only the latest and count; never overwrite prior evidence.
export class ReportHistory {
  constructor(file, {maximumRowBytes = 1048576} = {}) {
    assert.ok(Number.isSafeInteger(maximumRowBytes) && maximumRowBytes > 0 && maximumRowBytes <= 1048576);
    this.file = file; this.maximumRowBytes = maximumRowBytes; this.length = 0; this.latest = undefined;
    fs.closeSync(fs.openSync(file, 'wx'));
  }
  push(row) {
    const text = JSON.stringify(row);
    assert.ok(typeof text === 'string', 'History record must be JSON');
    assert.ok(Buffer.byteLength(text) <= this.maximumRowBytes, 'Report history record exceeds its bound');
    fs.appendFileSync(this.file, text + '\n'); this.latest = JSON.parse(text); return ++this.length;
  }
  at(index) { assert.equal(index, -1, 'Only the latest history record is resident'); return this.latest; }
  *rows() {
    const expected = this.length; let count = 0;
    for (const line of lines(this.file, this.maximumRowBytes)) {
      assert.ok(++count <= expected, 'Unexpected additional history record');
      yield JSON.parse(line);
    }
    assert.equal(count, expected, 'Missing history record');
    assert.equal(this.length, expected, 'History changed during report publication');
  }
  toJSON() { throw new Error('ReportHistory requires saveControlReport; whole-report JSON.stringify is forbidden'); }
}

function* bytes(text) {
  const encoded = Buffer.from(text, 'utf8');
  for (let offset = 0; offset < encoded.length; offset += 65536) yield encoded.subarray(offset, offset + 65536);
}

function* reportChunks(report) {
  yield '{'; let fieldCount = 0;
  for (const key of Object.keys(report)) {
    const value = report[key];
    if (value instanceof ReportHistory) {
      yield `${fieldCount++ ? ',' : ''}\n  ${JSON.stringify(key)}: [`;
      let count = 0;
      for (const row of value.rows()) {
        yield count++ ? ',\n' : '\n';
        yield* bytes(JSON.stringify(row, null, 2).replace(/^/gm, '    '));
      }
      yield count ? '\n  ]' : ']';
    } else {
      const text = JSON.stringify(value, null, 2);
      if (text === undefined) continue;
      assert.ok(Buffer.byteLength(text) <= 1048576, 'Report metadata exceeds its bound');
      yield `${fieldCount++ ? ',' : ''}\n  ${JSON.stringify(key)}: `;
      yield* bytes(text.replace(/\n/g, '\n  '));
    }
  }
  yield fieldCount ? '\n}\n' : '}\n';
}

// 保持完整两空格 JSON 报告格式；每次只解析和编码一条历史记录再原子发布。
// Preserve the complete canonical report while encoding only one history record at a time.
export function saveControlReport(file, report, options) {
  assert.ok(report && Object.getPrototypeOf(report) === Object.prototype, 'Report must be a plain object');
  saveControlJsonChunks(file, reportChunks(report), options);
}
