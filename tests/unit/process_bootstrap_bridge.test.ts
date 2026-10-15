import { afterEach, expect, test, vi } from "vitest";

// 宿主桥接函数在模块加载时读取，必须在导入 core 之前装好替身。 / Host bridge globals are read at module load; install stand-ins before importing core.
vi.hoisted(() => {
  const bridge = globalThis as Record<string, unknown>;
  bridge.__hostPushOutboundPacked = () => undefined;
  bridge.__hostCloseConnection = () => undefined;
  let nextDeadline = 1;
  bridge.__hostCreateShutdownDeadline = () => nextDeadline++;
  bridge.__hostCancelDeadline = () => undefined;
});
vi.mock("../../app/core/persistence/PrepareGlobalIds", () => ({ PrepareGlobalIds: vi.fn(async () => undefined) }));

import { ProcessRuntime } from "../../app/core/process/ProcessRuntime";
import { installProcessBootstrap } from "../../app/core/process/ProcessBootstrap";

const bridge = globalThis as typeof globalThis & {
  __etsStartProcess(config: string): Promise<string>;
  __etsStopProcess(): Promise<string>;
  __etsPushHostEventsBinary(batch: Uint8Array): string;
  __etsUpdateBinary(sampleMetrics: boolean, hotfixDraining?: boolean): string | Promise<string>;
  __etsBeginHotfix(manifestJson: string): string;
  __etsAbortHotfix(reason: string): string;
  __etsTakeReleasedControlIngress(): number;
};
installProcessBootstrap({ modelExports: {}, takeMetrics: () => ({ model: 1 }) });

afterEach(() => { vi.restoreAllMocks(); });

/** [count:u32 LE] + repeated [type:u8][connectionId:u32][sceneIndex:u32][payloadLength:u32][payload]. */
function batch(...events: [type: number, connectionId: number, sceneIndex: number, payload: number[]][]): Uint8Array {
  const bytes: number[] = [];
  const u32 = (value: number) => bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
  u32(events.length);
  for (const [type, connectionId, sceneIndex, payload] of events) {
    bytes.push(type);
    u32(connectionId);
    u32(sceneIndex);
    u32(payload.length);
    bytes.push(...payload);
  }
  return Uint8Array.from(bytes);
}

test("events and updates before the process starts are ignored", async () => {
  expect(bridge.__etsPushHostEventsBinary(batch([1, 1, 0, []]))).toBe("false");
  expect(await bridge.__etsUpdateBinary(true)).toBe("{}");
  expect(bridge.__etsTakeReleasedControlIngress()).toBe(0);
});

test("each host event type reaches its runtime entry, and malformed batches throw", async () => {
  await bridge.__etsStartProcess(JSON.stringify({ process: { name: "bridge" }, scenes: [], knownScenes: [], tickMs: 50 }));
  try {
    const frame = vi.spyOn(ProcessRuntime.prototype, "pushHostFrame").mockImplementation(() => undefined);
    const control = vi.spyOn(ProcessRuntime.prototype, "pushHostControlFrame").mockImplementation(() => undefined);
    const disconnect = vi.spyOn(ProcessRuntime.prototype, "pushHostDisconnect").mockImplementation(() => undefined);
    const http = vi.spyOn(ProcessRuntime.prototype, "pushHostHttpRequest").mockImplementation(() => undefined);
    expect(bridge.__etsPushHostEventsBinary(batch(
      [1, 11, 0, [1, 2]], [5, 12, 1, [3]], [2, 13, 2, []], [6, 14, 3, [4]],
      // Completions for unknown host operations are late replies and are dropped.
      [3, 999, 0, []], [4, 998, 0, [0x78]],
    ))).toBe("true");
    expect(frame).toHaveBeenCalledWith(0, 11, Uint8Array.of(1, 2));
    expect(control).toHaveBeenCalledWith(1, 12, Uint8Array.of(3));
    expect(disconnect).toHaveBeenCalledWith(2, 13);
    expect(http).toHaveBeenCalledWith(3, 14, Uint8Array.of(4));

    expect(() => bridge.__etsPushHostEventsBinary(Uint8Array.of(1, 0))).toThrow("invalid host event batch length: 2");
    expect(() => bridge.__etsPushHostEventsBinary(batch([1, 1, 0, []]).subarray(0, 10))).toThrow("truncated host event header at index 0");
    expect(() => bridge.__etsPushHostEventsBinary(batch([1, 1, 0, [1, 2]]).subarray(0, 18))).toThrow("truncated host event payload at index 0");
    expect(() => bridge.__etsPushHostEventsBinary(batch([9, 1, 0, []]))).toThrow("unknown host event type: 9");
    expect(() => bridge.__etsPushHostEventsBinary(Uint8Array.of(...batch(), 0))).toThrow("trailing bytes");

    expect(await bridge.__etsUpdateBinary(false)).toBe("0");
    const sampled = JSON.parse(await bridge.__etsUpdateBinary(true));
    expect(sampled).toMatchObject({ model: 1, pendingAsync: false, pendingIngress: false });
    expect(sampled).toHaveProperty("metrics");
  } finally {
    await bridge.__etsStopProcess();
  }
});

test("a hotfix carrying game config needs a Model that can stage it", () => {
  expect(() => bridge.__etsBeginHotfix(JSON.stringify({ runtimeConfig: { manifestJson: "{}", dataJson: "{}" } })))
    .toThrow("does not support atomic Hotfix/config release");
  expect(JSON.parse(bridge.__etsAbortHotfix("unit test"))).toBeTypeOf("object");
});
