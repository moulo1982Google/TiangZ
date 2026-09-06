// Keep the observer cheap: no synchronous PowerShell/CIM process on the load path.
import os from "node:os";

export function cpuTotals(cpus = os.cpus()) {
  return cpus.reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle,
    total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
}

export function cpuPercent(previous, current) {
  if (!previous || current.total <= previous.total || current.idle < previous.idle) return null;
  return Math.max(0, Math.min(100, 100 * (1 - (current.idle - previous.idle) / (current.total - previous.total))));
}

export function resourceViolation(sample) {
  for (const key of ["availableMemoryBytes", "freeDiskBytes", "artifactBytes"]) {
    if (!Number.isFinite(sample[key]) || sample[key] < 0) return `invalid resource counter: ${key}`;
  }
  if (sample.availableMemoryBytes < 1024 ** 3) return "available memory below 1 GiB";
  if (sample.freeDiskBytes < 10 * 1024 ** 3) return "free disk below 10 GiB";
  if (sample.artifactBytes > 2 * 1024 ** 3) return "evidence exceeds 2 GiB";
  return undefined;
}

export function memoryPressure(previousBytes, currentBytes) {
  return Number.isFinite(currentBytes) && (currentBytes < 2 * 1024 ** 3 ||
    (Number.isFinite(previousBytes) && previousBytes - currentBytes >= 512 * 1024 ** 2));
}

export function cpuPressure(percent) {
  return Number.isFinite(percent) && percent >= 90 && percent <= 100;
}

export function hasDroppedLogs(metrics) {
  return [...metrics.matchAll(/^tiangz_process_dropped_logs_total(?:\{[^}]*\})?\s+(\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gim)]
    .some(match => Number(match[1]) > 0);
}
