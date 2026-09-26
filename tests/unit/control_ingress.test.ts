import { expect, test } from "vitest";
import { EntryScene } from "../../app/core/process/EntryScene";
import { ProcessRuntime } from "../../app/core/process/ProcessRuntime";
import { entryScene } from "../../app/core/process/registry";
import type { RuntimeEntrySceneConfig } from "../../app/core/process/types";
import { defineMessage } from "../../app/core/protocol/message";
import { packFrame } from "../../app/core/protocol/registry";
import { ProcessHost } from "../../app/core/runtime/host";

// 本文件验证 TS 确认所有权；Native 总名额与真实 TCP 在 Rust/Process 矩阵单独验证。 / Tests TS acknowledgement ownership; Native capacity and real TCP have separate tests.
const Message = defineMessage({ name: "ControlIngress.Unit", msgcode: 61310,
  codec: { encode: (value: number) => new Uint8Array([value]), decode: (bytes: Uint8Array) => bytes[0] } });
const frame = (value: number) => packFrame(Message.msgcode, Message.codec.encode(value));
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
let active!: ControlScene;
@entryScene("ControlIngressUnit")
class ControlScene extends EntryScene {
  readonly seen: number[] = [];
  readonly waits = new Map<number, Promise<void>>();
  constructor(config: RuntimeEntrySceneConfig) { super(config, [], [Message]); }
  protected override onStart(): void { active = this; }
  protected override registerHandlers(): void {
    this.registry.registerMessage(Message.msgcode, { decode: Message.codec.decode, handle: value => this.work(value) });
  }
  protected override onDisconnect(id: number): void | Promise<void> { return this.work(id); }
  private work(value: number): void | Promise<void> { this.seen.push(value); return this.waits.get(value); }
}
@entryScene("UnorderedControlIngressUnit")
class UnorderedControlScene extends ControlScene { protected override readonly mailbox = "unordered" as const; }
async function fixture(unordered = false) {
  const config = { name: "controls", sceneType: unordered ? "UnorderedControlIngressUnit" : "ControlIngressUnit", innerIp: "127.0.0.1", port: 12345 };
  const runtime = new ProcessRuntime({ process: { name: "control-ingress" }, scenes: [config], knownScenes: [config], tickMs: 50 });
  const releases = { count: 0 };
  runtime.__bindControlIngressReleases(releases);
  await runtime.start();
  return { runtime, scene: active, releases, host: Reflect.get(runtime, "processHost") as ProcessHost };
}

test("ordered controls acknowledge at actual start, data and eventual completion do not acknowledge again", async () => {
  const f = await fixture(), wait = gate();
  f.scene.waits.set(1, wait.promise);
  try {
    f.runtime.pushHostControlFrame(0, 10, frame(1));
    f.runtime.pushHostControlFrame(0, 10, frame(2));
    f.runtime.pushHostDisconnect(0, 11);
    await f.runtime.update(false);
    expect(f.releases.count).toBe(1);
    expect(f.scene.seen).toEqual([1]);
    expect(f.scene.metricsSnapshot().ingressQueueLength).toBe(2);
    expect(f.runtime.CanCommitHotfix).toBe(false);
    wait.resolve(); await settle();
    expect(f.releases.count).toBe(1);
    f.runtime.pushHostFrame(0, 10, frame(3));
    await f.runtime.update(false, true);
    expect(f.releases.count).toBe(3);
    expect(f.scene.seen).toEqual([1, 3, 2, 11]);
    expect(f.runtime.CanCommitHotfix).toBe(true);
  } finally { wait.resolve(); await settle(); await f.runtime.stop(); }
  expect(f.releases.count).toBe(3);
});

test.each([false, true])("moving control into a busy local mailbox retains admission until start or discard (dispose=%s)", async dispose => {
  const f = await fixture(), wait = gate();
  f.scene.waits.set(1, wait.promise);
  const running = Promise.resolve(f.scene.dispatchLocalSend(frame(1))).catch(error => error);
  try {
    f.runtime.pushHostDisconnect(0, 2);
    f.runtime.pushHostDisconnect(0, 3);
    await f.runtime.update(false);
    expect(f.releases.count).toBe(0);
    expect(f.scene.mailboxMetricsSnapshot().queuedDepth).toBe(1);
    expect(f.scene.metricsSnapshot().ingressQueueLength).toBe(1);
    if (dispose) {
      f.host.despawnScene("controls");
      expect(f.releases.count).toBe(2);
      expect(f.scene.seen).toEqual([1]);
    }
    wait.resolve(); await running; await settle();
    await f.runtime.update(false, true);
    expect(f.releases.count).toBe(2);
    expect(f.scene.seen).toEqual(dispose ? [1] : [1, 2, 3]);
  } finally { wait.resolve(); await running; await settle(); await f.runtime.stop(); }
  expect(f.releases.count).toBe(2);
});

test("unordered controls release count at start while real async work still blocks Hotfix", async () => {
  const f = await fixture(true), wait = gate();
  f.scene.waits.set(1, wait.promise); f.scene.waits.set(2, wait.promise);
  try {
    f.runtime.pushHostDisconnect(0, 1); f.runtime.pushHostDisconnect(0, 2);
    await f.runtime.update(false);
    expect(f.releases.count).toBe(2);
    expect(f.runtime.CanCommitHotfix).toBe(false);
    wait.resolve(); await settle();
    expect(f.runtime.CanCommitHotfix).toBe(true);
    expect(f.releases.count).toBe(2);
  } finally { wait.resolve(); await settle(); await f.runtime.stop(); }
});

test("a mailbox acknowledgement retains its original counter and runs only once", () => {
  const host = new ProcessHost(), first = { count: 0 }, next = { count: 0 };
  host.__bindControlIngressReleases(first);
  const release = host.__controlIngressAcknowledgement();
  host.__bindControlIngressReleases(next);
  release(); release();
  expect(first.count).toBe(1);
  expect(next.count).toBe(0);
});

test("disconnected-source and closed-scene rejections acknowledge only their control nodes", async () => {
  const f = await fixture();
  f.runtime.pushHostDisconnect(0, 7);
  f.runtime.pushHostControlFrame(0, 7, frame(1));
  f.runtime.pushHostFrame(0, 7, frame(2));
  expect(f.releases.count).toBe(1);
  await f.runtime.update(false);
  expect(f.releases.count).toBe(2);
  await f.runtime.stop();
  f.scene.pushHostControlFrame(8, frame(3)); f.scene.pushHostDisconnect(8); f.scene.pushHostFrame(8, frame(4));
  expect(f.releases.count).toBe(4);
  const next = await fixture();
  try {
    f.scene.pushHostDisconnect(9);
    expect(f.releases.count).toBe(5);
    expect(next.releases.count).toBe(0);
  } finally { await next.runtime.stop(); }
});
