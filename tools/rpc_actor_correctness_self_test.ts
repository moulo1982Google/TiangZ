import assert from "node:assert/strict";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

void main();

async function main(): Promise<void> {
  let submitted = new Uint8Array(0);
  const host = globalThis as typeof globalThis & {
    __hostRegisterSceneRoute: () => number;
    __hostSubmitSceneOperations: (packed: Uint8Array) => number;
    __hostLogMinLevel: number;
    __hostLog: () => void;
  };
  host.__hostRegisterSceneRoute = () => 1;
  host.__hostSubmitSceneOperations = (packed) => {
    submitted = packed.slice();
    return 0;
  };
  host.__hostLogMinLevel = 4;
  host.__hostLog = () => undefined;

  const transport = await import("../app/core/process/HostSceneTransport");
  await testHostCompletionAndShutdown(transport, () => submitted);
  await testRpcIdReservation(transport, () => submitted);
  console.log("rpc/actor correctness self-test passed");
}

async function testHostCompletionAndShutdown(
  transport: typeof import("../app/core/process/HostSceneTransport"),
  submitted: () => Uint8Array,
): Promise<void> {
  const source = scene("source", 7001);
  const target = scene("target", 7002);
  const first = transport.callRemoteScene(source, target, Uint8Array.of(1), 1000);
  transport.flushHostSceneOperations();
  const operationId = new DataView(
    submitted().buffer,
    submitted().byteOffset,
    submitted().byteLength,
  ).getUint32(4, true);
  transport.completeHostSceneOperation(operationId, true, Uint8Array.of(7));
  assert.deepEqual(await first, Uint8Array.of(7));

  transport.completeHostSceneOperation(operationId, true, Uint8Array.of(8));
  const cancelled = transport.callRemoteScene(source, target, Uint8Array.of(2), 1000);
  transport.flushHostSceneOperations();
  transport.cancelHostSceneOperations("self-test shutdown");
  await assert.rejects(cancelled, /self-test shutdown/);
  transport.completeHostSceneOperation(operationId + 1, true, Uint8Array.of(9));
}

async function testRpcIdReservation(
  transport: typeof import("../app/core/process/HostSceneTransport"),
  submitted: () => Uint8Array,
): Promise<void> {
  const [{ SceneCallContext }, { ProcessHost }, { packFrame }] = await Promise.all([
    import("../app/core/process/context"),
    import("../app/core/runtime/host"),
    import("../app/core/protocol/registry"),
  ]);
  const calls: Array<{ frame: Uint8Array; response: Deferred<Uint8Array> }> = [];
  const self = scene("source", 7001);
  const target = scene("target", 7002);
  const context = new SceneCallContext(
    {
      process: { name: "rpc-correctness" },
      self,
      knownScenes: [self, target],
      tickMs: 50,
      processHost: new ProcessHost("rpc-correctness"),
      localRouter: undefined as never,
    },
    {
      hasLocalScene: () => true,
      callLocalScene: (_source, _target, frame) => {
        const response = deferred<Uint8Array>();
        calls.push({ frame, response });
        return response.promise;
      },
      sendLocalScene: async () => undefined,
    },
  );
  const descriptor = {
    name: "Correctness.Echo",
    requestCode: 31001,
    responseCode: 31002,
    requestCodec: rpcCodec(),
    responseCodec: rpcCodec(),
  };
  const state = context as unknown as { nextRpcId: number };
  state.nextRpcId = 0xffff_ffff;
  const first = context.call(target, descriptor, {});
  state.nextRpcId = 0xffff_ffff;
  const second = context.call(target, descriptor, {});

  assert.equal(readRpcId(calls[0].frame), 0xffff_ffff);
  assert.equal(readRpcId(calls[1].frame), 1);
  calls[1].response.resolve(packFrame(descriptor.responseCode, encodeRpc({ rpcId: 1 })));
  calls[0].response.resolve(
    packFrame(descriptor.responseCode, encodeRpc({ rpcId: 0xffff_ffff })),
  );
  assert.equal((await second).rpcId, 1);
  assert.equal((await first).rpcId, 0xffff_ffff);

  const mismatch = context.call(target, descriptor, {});
  calls[2].response.resolve(packFrame(descriptor.responseCode, encodeRpc({ rpcId: 99 })));
  await assert.rejects(mismatch, /RPC id mismatch/);

  const timedOut = context.call(target, descriptor, {}, { timeoutMs: 5 });
  transport.flushHostSceneOperations();
  const timeoutBatch = submitted();
  const timeoutOperationId = new DataView(
    timeoutBatch.buffer,
    timeoutBatch.byteOffset,
    timeoutBatch.byteLength,
  ).getUint32(4, true);
  transport.completeHostSceneOperation(timeoutOperationId, true, new Uint8Array(0));
  await assert.rejects(timedOut, /timed out after 5ms/);
}

function scene(name: string, port: number) {
  return { name, sceneType: "Correctness", innerIp: "127.0.0.1", port };
}

function rpcCodec() {
  return {
    encode: encodeRpc,
    decode: (bytes: Uint8Array) => ({ rpcId: new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).getUint32(0, true) }),
  };
}

function encodeRpc(value: { rpcId?: number }): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value.rpcId ?? 0, true);
  return bytes;
}

function readRpcId(frame: Uint8Array): number {
  return new DataView(frame.buffer, frame.byteOffset + 2, 4).getUint32(0, true);
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
