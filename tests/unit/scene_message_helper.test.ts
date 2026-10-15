import { expect, test, vi } from "vitest";
import { SceneMessageHelper } from "../../app/core/process/SceneMessageHelper";
import type { SceneCallContext } from "../../app/core/process/context";
import type { SceneConfig } from "../../app/core/process/types";
import { SystemErrCode } from "../../app/core/protocol/SystemErrCode";

const scene = (name: string, type: string) => ({ name, type }) as unknown as SceneConfig;
const map1 = scene("Map1", "Map");
const map2 = scene("Map2", "Map");
const gate = scene("Gate", "Gate");

function helper() {
  const scenes = [map1, map2, gate];
  const ctx = {
    knownScenes: scenes,
    refs: vi.fn((type: string) => scenes.filter((item) => (item as unknown as { type: string }).type === type)),
    call: vi.fn(async () => ({ ok: true })),
    callActor: vi.fn(async () => ({ actor: true })),
    send: vi.fn(),
    sendFrame: vi.fn(),
    sendActor: vi.fn(),
  };
  return { ctx, messages: new SceneMessageHelper(ctx as unknown as SceneCallContext) };
}

test("scene resolution rejects missing and ambiguous deployments", () => {
  const { messages } = helper();
  expect(messages.one("Gate")).toBe(gate);
  expect(messages.many("Map")).toEqual([map1, map2]);
  expect(messages.optionalOne("Chat")).toBeUndefined();
  expect(messages.byName("Map2")).toBe(map2);
  expect(() => messages.one("Chat")).toThrow(expect.objectContaining({ code: SystemErrCode.SceneNotFound }));
  expect(() => messages.one("Map")).toThrow(expect.objectContaining({ code: SystemErrCode.AmbiguousScene }));
  expect(() => messages.optionalOne("Map")).toThrow("has 2 instances");
  expect(() => messages.byName("Nope")).toThrow(expect.objectContaining({ code: SystemErrCode.SceneNotFound }));
});

test("calls and sends delegate to the context with default options", async () => {
  const { ctx, messages } = helper();
  const descriptor = {} as never;
  const request = {} as never;
  const actor = {} as never;
  await expect(messages.callOne("Gate", descriptor, request)).resolves.toEqual({ ok: true });
  expect(ctx.call).toHaveBeenLastCalledWith(gate, descriptor, request, {});
  await expect(messages.callOptionalOne("Chat", descriptor, request)).resolves.toBeUndefined();
  await messages.callOptionalOne("Gate", descriptor, request, { timeoutMs: 5 } as never);
  expect(ctx.call).toHaveBeenLastCalledWith(gate, descriptor, request, { timeoutMs: 5 });
  expect(ctx.call).toHaveBeenCalledTimes(2);
  await expect(messages.callActor(actor, descriptor, request)).resolves.toEqual({ actor: true });
  expect(ctx.callActor).toHaveBeenCalledWith(actor, descriptor, request, {});

  messages.sendOne("Gate", descriptor, request);
  expect(ctx.send).toHaveBeenCalledWith(gate, descriptor, request, {});
  const frame = Uint8Array.of(1);
  messages.sendFrame(map1, frame);
  expect(ctx.sendFrame).toHaveBeenCalledWith(map1, frame, {});
  messages.sendActor(actor, descriptor, request);
  expect(ctx.sendActor).toHaveBeenCalledWith(actor, descriptor, request, {});
});
