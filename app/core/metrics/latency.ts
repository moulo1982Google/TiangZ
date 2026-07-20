export interface LatencyMetricSnapshot {
  name: string;
  msgcode?: number;
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface LatencyRecorderOptions {
  enabled?: boolean;
  sampleRate?: number;
}

interface MetricState {
  count: number;
  totalMs: number;
  maxMs: number;
  buckets: number[];
}

const BUCKETS_MS = [
  0.05,
  0.1,
  0.25,
  0.5,
  1,
  2,
  5,
  10,
  20,
  50,
  100,
  250,
  500,
  1000,
];

export class LatencyRecorder {
  private readonly metrics = new Map<string, MetricState>();
  readonly enabled: boolean;
  private readonly sampleRate: number;
  private sampleCounter = 0;

  constructor(options: LatencyRecorderOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.sampleRate = Math.max(1, Math.floor(options.sampleRate ?? 1));
  }

  record(name: string, elapsedMs: number, msgcode?: number): void {
    if (!this.enabled) return;
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    this.sampleCounter = (this.sampleCounter % 0xffff_ffff) + 1;
    if (this.sampleCounter % this.sampleRate !== 0) return;

    const key = metricKey(name, msgcode);
    let metric = this.metrics.get(key);
    if (!metric) {
      metric = {
        count: 0,
        totalMs: 0,
        maxMs: 0,
        buckets: new Array(BUCKETS_MS.length + 1).fill(0) as number[],
      };
      this.metrics.set(key, metric);
    }

    metric.count += 1;
    metric.totalMs += elapsedMs;
    metric.maxMs = Math.max(metric.maxMs, elapsedMs);
    metric.buckets[bucketIndex(elapsedMs)] += 1;
  }

  snapshot(): LatencyMetricSnapshot[] {
    return [...this.metrics.entries()]
      .map(([key, metric]) => {
        const parsed = parseMetricKey(key);
        return {
          ...parsed,
          count: metric.count,
          avgMs: metric.count > 0 ? metric.totalMs / metric.count : 0,
          p50Ms: percentile(metric, 0.5),
          p95Ms: percentile(metric, 0.95),
          p99Ms: percentile(metric, 0.99),
          maxMs: metric.maxMs,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name) || (a.msgcode ?? 0) - (b.msgcode ?? 0));
  }
}

export function nowMs(): number {
  const perf = (globalThis as typeof globalThis & {
    performance?: { now?: () => number };
  }).performance;
  return typeof perf?.now === "function" ? perf.now() : Date.now();
}

function bucketIndex(elapsedMs: number): number {
  for (let index = 0; index < BUCKETS_MS.length; index += 1) {
    if (elapsedMs <= BUCKETS_MS[index]) return index;
  }
  return BUCKETS_MS.length;
}

function percentile(metric: MetricState, ratio: number): number {
  if (metric.count === 0) return 0;
  const target = Math.max(1, Math.ceil(metric.count * ratio));
  let seen = 0;
  for (let index = 0; index < metric.buckets.length; index += 1) {
    seen += metric.buckets[index];
    if (seen >= target) {
      return index < BUCKETS_MS.length ? BUCKETS_MS[index] : metric.maxMs;
    }
  }
  return metric.maxMs;
}

function metricKey(name: string, msgcode?: number): string {
  return msgcode === undefined ? name : `${name}#${msgcode}`;
}

function parseMetricKey(key: string): { name: string; msgcode?: number } {
  const marker = key.lastIndexOf("#");
  if (marker < 0) return { name: key };
  return {
    name: key.slice(0, marker),
    msgcode: Number(key.slice(marker + 1)),
  };
}
