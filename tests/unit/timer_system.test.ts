import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { InitializeGameSingletons } from "../../app/core/runtime/Game";
import { SingletonRegistry } from "../../app/core/runtime/Singleton";
import { TimerSystem } from "../../app/core/runtime/TimerSystem";
import { TimeSystem } from "../../app/core/runtime/TimeSystem";

beforeEach(() => {
  InitializeGameSingletons();
  TimeSystem.Instance.__update(Math.ceil(TimeSystem.Instance.FrameTime), Date.now());
});
afterEach(() => {
  vi.restoreAllMocks();
  SingletonRegistry.DestroyAll();
});

test("timers created inside a callback wait for the next update without blocking existing due timers", () => {
  const timers = TimerSystem.Instance;
  const now = TimeSystem.Instance.FrameTime;
  const calls: string[] = [];
  timers.NewOnceTimer(0, () => {
    calls.push("first");
    timers.NewOnceTimer(0, () => {
      calls.push("next");
      timers.NewOnceTimer(0, () => { calls.push("last"); });
    });
  });
  timers.NewOnceTimer(1, () => { calls.push("already-due"); });
  timers.__update(now + 1);
  expect(calls).toEqual(["first", "already-due"]);
  timers.__update(now + 1);
  expect(calls).toEqual(["first", "already-due", "next"]);
  timers.__update(now + 1);
  expect(calls).toEqual(["first", "already-due", "next", "last"]);
  expect(timers.Count).toBe(0);
});

test("cancellation still removes a due candidate and a newly registered timer immediately", () => {
  const timers = TimerSystem.Instance;
  const now = TimeSystem.Instance.FrameTime;
  const calls: string[] = [];
  timers.NewOnceTimer(0, () => {
    expect(timers.Cancel(later)).toBe(true);
    const nested = timers.NewOnceTimer(0, () => { calls.push("nested"); });
    expect(timers.Cancel(nested)).toBe(true);
    calls.push("first");
  });
  const later = timers.NewOnceTimer(1, () => { calls.push("cancelled"); });
  timers.__update(now + 1);
  timers.__update(now + 1);
  expect(calls).toEqual(["first"]);
  expect(timers.Count).toBe(0);
});

test("same-deadline timers all execute and repeated timers skip missed periods and can cancel themselves", () => {
  const timers = TimerSystem.Instance;
  const now = TimeSystem.Instance.FrameTime;
  const calls: number[] = [];
  for (let index = 0; index < 3; index++) {
    timers.NewOnceTimer(0, () => { calls.push(index); });
  }
  let repeats = 0;
  const repeated = timers.NewRepeatedTimer(10, () => {
    if (++repeats === 2) timers.Cancel(repeated);
  });
  timers.__update(now + 100);
  expect(calls.sort()).toEqual([0, 1, 2]);
  expect(repeats).toBe(1);
  timers.__update(now + 109);
  expect(repeats).toBe(1);
  timers.__update(now + 110);
  timers.__update(now + 1_000);
  expect(repeats).toBe(2);
  expect(timers.Count).toBe(0);
});

test("fractional frame times do not leave a repeated timer due again in the same period", () => {
  const timers = TimerSystem.Instance;
  vi.spyOn(TimeSystem.Instance, "FrameTime", "get").mockReturnValue(28.003);
  let calls = 0;
  timers.NewRepeatedTimer(10, () => { calls++; });
  timers.__update(128.003);
  expect(calls).toBe(1);
  timers.__update(128.003);
  timers.__update(138);
  expect(calls).toBe(1);
  timers.__update(138.003);
  expect(calls).toBe(2);
});
