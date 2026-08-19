const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/**
 * 压测客户端的成功统计不能覆盖服务端故障；这里仅识别结构化错误级别与 panic。
 * Client success counters must not hide server failures; only structured errors and panics fail a run.
 */
export function InspectRuntimeLog(text) {
  const lines = text.replaceAll(ANSI_ESCAPE, "").split(/\r?\n/);
  let errors = 0;
  let panics = 0;
  const samples = [];
  for (const line of lines) {
    const isError = /(?:^|\s)ERROR(?:\s|$)/.test(line);
    const isPanic = /panicked at|fatal runtime error/i.test(line);
    if (!isError && !isPanic) continue;
    if (isError) errors += 1;
    if (isPanic) panics += 1;
    if (samples.length < 5) samples.push(line.trim());
  }
  return { errors, panics, samples };
}
