import { afterEach, expect, test, vi } from "vitest";
import { LatencyRecorder, nowMs } from "../../app/core/metrics/latency";

afterEach(() => { vi.unstubAllGlobals(); });

test("a disabled recorder keeps nothing", () => {
  const recorder = new LatencyRecorder();
  expect(recorder.enabled).toBe(false);
  recorder.record("rpc", 1);
  expect(recorder.snapshot()).toEqual([]);
});

test("bucket percentiles, overflow max and invalid samples", () => {
  const recorder = new LatencyRecorder({ enabled: true });
  for (const elapsed of [-1, Number.NaN, Number.POSITIVE_INFINITY]) recorder.record("rpc", elapsed);
  expect(recorder.snapshot()).toEqual([]);
  for (let i = 0; i < 98; i++) recorder.record("rpc", 0.3);
  recorder.record("rpc", 4);
  recorder.record("rpc", 2500);
  const [metric] = recorder.snapshot();
  expect(metric).toMatchObject({ name: "rpc", count: 100, p50Ms: 0.5, p95Ms: 0.5, p99Ms: 5, maxMs: 2500 });
  expect(metric!.msgcode).toBeUndefined();
  expect(metric!.avgMs).toBeCloseTo((98 * 0.3 + 4 + 2500) / 100);
  expect(metric!.bucketCounts).toHaveLength(metric!.boundsMs.length + 1);
  expect(metric!.bucketCounts.at(-1)).toBe(1);

  const overflow = new LatencyRecorder({ enabled: true });
  overflow.record("slow", 1500);
  expect(overflow.snapshot()[0]).toMatchObject({ p50Ms: 1500, p99Ms: 1500, sumMs: 1500 });
});

test("sampling keeps every Nth sample and metrics sort by name, then msgcode", () => {
  const recorder = new LatencyRecorder({ enabled: true, sampleRate: 3.9 });
  for (let i = 0; i < 9; i++) recorder.record("call", 1, 20);
  recorder.record("call", 1, 10);
  recorder.record("call", 1, 10);
  recorder.record("call", 1, 10);
  recorder.record("a", 1);
  recorder.record("a", 1);
  recorder.record("a", 1);
  expect(recorder.snapshot().map(({ name, msgcode, count }) => ({ name, msgcode, count }))).toEqual([
    { name: "a", msgcode: undefined, count: 1 },
    { name: "call", msgcode: 10, count: 1 },
    { name: "call", msgcode: 20, count: 3 },
  ]);
  // A sample rate below one records every sample.
  const every = new LatencyRecorder({ enabled: true, sampleRate: 0 });
  every.record("x", 1);
  expect(every.snapshot()[0]!.count).toBe(1);
});

test("names may contain #: \"a#1\" without a msgcode and \"a\" with msgcode 1 stay separate", () => {
  const recorder = new LatencyRecorder({ enabled: true });
  recorder.record("a#1", 1);
  recorder.record("a", 2, 1);
  recorder.record("a#1", 3);
  const snapshot = recorder.snapshot();
  expect(snapshot.map(({ name, msgcode, count, maxMs }) => ({ name, msgcode, count, maxMs }))).toEqual([
    { name: "a", msgcode: 1, count: 1, maxMs: 2 },
    { name: "a#1", msgcode: undefined, count: 2, maxMs: 3 },
  ]);
  expect("msgcode" in snapshot[1]!).toBe(false);
});

test("nowMs prefers performance.now and falls back to Date.now", () => {
  vi.stubGlobal("performance", { now: () => 12.5 });
  expect(nowMs()).toBe(12.5);
  vi.stubGlobal("performance", undefined);
  vi.spyOn(Date, "now").mockReturnValueOnce(99);
  expect(nowMs()).toBe(99);
});
