import { expect, test, vi } from "vitest";

// 宿主桥接函数在模块加载时读取，必须在导入 core 之前装好替身。 / Host bridge globals are read at module load; install stand-ins before importing core.
const host = vi.hoisted(() => {
  const log: string[] = [];
  const deadlines = new Set<number>();
  let nextDeadline = 1;
  const bridge = globalThis as Record<string, unknown>;
  bridge.__hostPushOutboundPacked = () => { log.push("outbound"); };
  bridge.__hostCloseConnection = (connectionId: number) => { log.push(`close:${connectionId}`); };
  bridge.__hostCreateShutdownDeadline = () => {
    const id = nextDeadline++; deadlines.add(id); return id;
  };
  bridge.__hostCancelDeadline = (id: number) => {
    if (!deadlines.delete(id)) throw new Error("Unknown shutdown deadline");
  };
  return { log, deadlines };
});
vi.mock("../../app/core/persistence/PrepareGlobalIds", () => ({ PrepareGlobalIds: vi.fn(async () => undefined) }));

import { ProcessRuntime } from "../../app/core/process/ProcessRuntime";
import { installProcessBootstrap } from "../../app/core/process/ProcessBootstrap";
import { EntryScene } from "../../app/core/process/EntryScene";
import { entryScene } from "../../app/core/process/registry";

const scenes = new Map<string, CloseOrderFixture>();
@entryScene("CloseOrderFixture")
class CloseOrderFixture extends EntryScene {
  protected override onStart(): void { scenes.set(this.self.name, this); }
  Notify(connectionId: number, marker: number): void { this.sendClientFrameMany([connectionId], new Uint8Array([0, 1, marker])); }
  Close(connectionId: number): void { this.disconnectClient(connectionId); }
}
const sceneConfig = (name: string, port: number) => ({ name, sceneType: "CloseOrderFixture", ip: "127.0.0.1", innerIp: "127.0.0.1", port });
const processConfig = (name: string, ...list: ReturnType<typeof sceneConfig>[]) => ({ process: { name }, scenes: list, knownScenes: list, tickMs: 50 });

test("a close requested after the Scene drained leaves with the frames queued before it, once", async () => {
  const runtime = new ProcessRuntime(processConfig("close-after-drain", sceneConfig("close-a", 12001)));
  await runtime.start();
  try {
    await runtime.update(false);
    const scene = scenes.get("close-a")!;
    // 与 RPC 续体里的顶号相同：Scene 已经排空后才推送通知并断开。 / Like a replacement in an RPC continuation, after the Scene drained.
    scene.Notify(7, 9);
    scene.Close(7);
    scene.Close(7);
    const result = await runtime.update(false);
    expect(result.outbound.map(batch => batch.frame[2])).toEqual([9]);
    expect(result.closes).toEqual([7]);
    expect((await runtime.update(false)).closes).toEqual([]);
    expect(host.log).toEqual([]);
  } finally { await runtime.stop(); }
});

test("closes from several Scenes are merged, and a close without frames still leaves", async () => {
  const runtime = new ProcessRuntime(processConfig("close-merge", sceneConfig("close-b", 12002), sceneConfig("close-c", 12003)));
  await runtime.start();
  try {
    scenes.get("close-b")!.Close(3);
    scenes.get("close-c")!.Notify(4, 1);
    scenes.get("close-c")!.Close(4);
    const result = await runtime.update(false);
    expect(result.closes).toEqual([3, 4]);
    expect(result.outbound).toHaveLength(1);
  } finally { await runtime.stop(); }
});

test("a close still pending when the process stops is handed to the host directly", async () => {
  const runtime = new ProcessRuntime(processConfig("close-on-stop", sceneConfig("close-d", 12004)));
  await runtime.start();
  host.log.length = 0;
  scenes.get("close-d")!.Close(8);
  await runtime.stop();
  expect(host.log).toEqual(["close:8"]);
});

test("the process bridge hands frames to the host before the closes of the same update", async () => {
  installProcessBootstrap({ modelExports: {} });
  const bridge = globalThis as typeof globalThis & {
    __etsStartProcess(config: string): Promise<string>;
    __etsStopProcess(): Promise<string>;
    __etsUpdateBinary(sampleMetrics: boolean): string | Promise<string>;
  };
  await bridge.__etsStartProcess(JSON.stringify(processConfig("close-bridge", sceneConfig("close-e", 12005))));
  try {
    await bridge.__etsUpdateBinary(false);
    host.log.length = 0;
    const scene = scenes.get("close-e")!;
    scene.Notify(5, 2);
    scene.Close(5);
    await bridge.__etsUpdateBinary(false);
    expect(host.log).toEqual(["outbound", "close:5"]);
  } finally { await bridge.__etsStopProcess(); }
  expect(host.deadlines.size).toBe(0);
});
