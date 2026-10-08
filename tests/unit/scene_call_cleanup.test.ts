import { afterEach, expect, test, vi } from "vitest";
import { SceneCallContext } from "../../app/core/process/context";
import { decodeActorLocationEnvelope, extractFrameRpcId } from "../../app/core/process/ActorLocation";
import type { LocalSceneRouter, SceneConfig } from "../../app/core/process/types";
import { BinaryWriter } from "../../app/core/protocol/binary";
import { packFrame } from "../../app/core/protocol/registry";
import type { RpcDescriptor } from "../../app/core/protocol/rpc";
import { ProcessHost } from "../../app/core/runtime/host";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const scene: SceneConfig = { name: "cleanup", sceneType: "Cleanup", innerIp: "127.0.0.1", port: 1 };
  const router: LocalSceneRouter = { hasLocalScene: () => true, callLocalScene: async () => { throw new Error("unused transport"); }, sendLocalScene: () => undefined };
  const context = new SceneCallContext({ process: { name: "cleanup" }, self: scene, knownScenes: [scene], tickMs: 50, processHost: new ProcessHost(), localRouter: router }, router);
  const codec = {
    encode(value: { rpcId?: number }): Uint8Array { const writer = new BinaryWriter(); writer.uint32(90, value.rpcId); return writer.finish(); },
    decode(payload: Uint8Array): { rpcId?: number } { return { rpcId: extractFrameRpcId(packFrame(1, payload)) }; },
  };
  const descriptor: RpcDescriptor<{ rpcId?: number }, { rpcId?: number }> = { name: "Cleanup", requestCode: 1, responseCode: 2, requestCodec: codec, responseCodec: codec };
  const send = vi.spyOn(context, "callFrame").mockImplementation(async (_target, frame) => {
    const inner = frame[0] === 0 && frame[1] === descriptor.requestCode ? frame : decodeActorLocationEnvelope(frame).frame;
    return packFrame(descriptor.responseCode, codec.encode({ rpcId: extractFrameRpcId(inner) }));
  });
  const state = context as unknown as { nextRpcId: number; inFlightRpcIds: Set<number> };
  return { context, descriptor, state, send, scene, actor: { instanceId: 1, scene }, codec };
}

test.each(["scene", "actor"] as const)("%s RPC releases its ID when codec encoding fails", async kind => {
  const f = fixture();
  const error = new Error("codec refused request");
  const invalid = { ...f.descriptor, requestCodec: { ...f.codec, encode: () => { throw error; } } };
  const failed = kind === "scene" ? f.context.call(f.scene, invalid, {}) : f.context.callActor(f.actor, invalid, {});
  await expect(failed).rejects.toBe(error);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.state.inFlightRpcIds.size).toBe(0);
  f.state.nextRpcId = 1;
  const result = kind === "scene" ? await f.context.call(f.scene, f.descriptor, {}) : await f.context.callActor(f.actor, f.descriptor, {});
  expect(result.rpcId).toBe(1);
  expect(f.state.inFlightRpcIds.size).toBe(0);
});

test.each(["scene", "actor"] as const)("%s RPC releases its ID when a request rejects rpcId assignment", async kind => {
  const f = fixture();
  const request = Object.freeze({ rpcId: 0 });
  await expect(kind === "scene" ? f.context.call(f.scene, f.descriptor, request) : f.context.callActor(f.actor, f.descriptor, request)).rejects.toBeInstanceOf(TypeError);
  expect(f.state.inFlightRpcIds.size).toBe(0);
  expect(f.send).not.toHaveBeenCalled();
});

test.each(["typed", "opaque"] as const)("%s Actor RPC releases its ID after envelope validation rejects the target", async kind => {
  const f = fixture();
  const target = { ...f.actor, instanceId: 0 };
  const frame = packFrame(f.descriptor.requestCode, f.codec.encode({ rpcId: 42 }));
  await expect(kind === "typed" ? f.context.callActor(target, f.descriptor, {}) : f.context.callActorFrame(target, frame, f.descriptor.responseCode)).rejects.toThrow(/invalid actor instanceId/);
  expect(f.state.inFlightRpcIds.size).toBe(0);
  expect(f.send).not.toHaveBeenCalled();
  f.state.nextRpcId = 1;
  if (kind === "typed") expect((await f.context.callActor(f.actor, f.descriptor, {})).rpcId).toBe(1);
  else expect(extractFrameRpcId(await f.context.callActorFrame(f.actor, frame, f.descriptor.responseCode))).toBe(42);
  expect(f.state.inFlightRpcIds.size).toBe(0);
});

test.each(["scene", "actor", "opaque"] as const)("%s RPC releases its ID on transport and response failures", async kind => {
  const f = fixture();
  const frame = packFrame(f.descriptor.requestCode, f.codec.encode({ rpcId: 42 }));
  const call = () => kind === "scene" ? f.context.call(f.scene, f.descriptor, {}) : kind === "actor" ? f.context.callActor(f.actor, f.descriptor, {}) : f.context.callActorFrame(f.actor, frame, f.descriptor.responseCode);
  f.send.mockRejectedValueOnce(new Error("send failed"));
  await expect(call()).rejects.toThrow("send failed");
  expect(f.state.inFlightRpcIds.size).toBe(0);
  f.send.mockResolvedValueOnce(packFrame(3, f.codec.encode({ rpcId: 2 })));
  await expect(call()).rejects.toThrow(/unexpected.*response code/);
  expect(f.state.inFlightRpcIds.size).toBe(0);
  f.send.mockResolvedValueOnce(packFrame(2, f.codec.encode({ rpcId: 999 })));
  await expect(call()).rejects.toThrow(/(?:RPC id|rpcId) mismatch/);
  expect(f.state.inFlightRpcIds.size).toBe(0);
  if (kind !== "opaque") {
    const error = new Error("response codec failed");
    vi.spyOn(f.codec, "decode").mockImplementationOnce(() => { throw error; });
    await expect(call()).rejects.toBe(error);
    expect(f.state.inFlightRpcIds.size).toBe(0);
  }
  await expect(call()).resolves.toBeDefined();
  expect(f.state.inFlightRpcIds.size).toBe(0);
});
