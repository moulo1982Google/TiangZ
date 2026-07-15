import "./generated/hotfix/scenes";
import "./generated/hotfix/handlers";
import { isPromiseLike, type MaybePromise } from "./core/async";
import { ProcessRuntime, type ProcessUpdateResult } from "./core/process/ProcessRuntime";
import type { ProcessRuntimeConfig } from "./core/process/types";

let processRuntime: ProcessRuntime | undefined;

function startProcess(configJson: string): string {
  processRuntime = new ProcessRuntime(JSON.parse(configJson) as ProcessRuntimeConfig);
  return processRuntime.start();
}

const HOST_EVENT_META_BYTES = 9;

function pushHostEventsBinary(metadata: Uint8Array): string {
  if (!processRuntime) return "false";
  if (metadata.length % HOST_EVENT_META_BYTES !== 0) {
    throw new Error(`invalid host event metadata length: ${metadata.length}`);
  }
  const view = new DataView(metadata.buffer, metadata.byteOffset, metadata.byteLength);
  for (let offset = 0; offset < metadata.length; offset += HOST_EVENT_META_BYTES) {
    const eventType = metadata[offset];
    const connectionId = view.getUint32(offset + 1, true);
    const sceneIndex = view.getUint32(offset + 5, true);
    if (eventType === 1) {
      processRuntime.pushHostFrame(sceneIndex, connectionId, hostTakeBinaryArg());
    } else if (eventType === 2) {
      processRuntime.pushHostDisconnect(sceneIndex, connectionId);
    } else {
      throw new Error(`unknown host event type: ${eventType}`);
    }
  }
  return "true";
}

function updateBinary(_arg: string): MaybePromise<string> {
  if (!processRuntime) return JSON.stringify({});
  const result = processRuntime.update();
  return isPromiseLike(result)
    ? Promise.resolve(result).then(flushUpdateResult)
    : flushUpdateResult(result);
}

function flushUpdateResult(result: ProcessUpdateResult): string {
  for (const batch of result.outbound) {
    hostPushOutboundBatch(batch.connectionIdBytes, batch.frame);
  }
  return JSON.stringify({ metrics: result.metrics });
}

function hostTakeBinaryArg(): Uint8Array {
  return (globalThis as typeof globalThis & { __hostTakeBinaryArg: () => Uint8Array })
    .__hostTakeBinaryArg();
}

function hostPushOutboundBatch(
  connectionIdBytes: Uint8Array,
  frame: Uint8Array,
): void {
  (globalThis as typeof globalThis & {
    __hostPushOutboundBatch: (
      connectionIdBytes: Uint8Array,
      frame: Uint8Array,
    ) => void;
  }).__hostPushOutboundBatch(connectionIdBytes, frame);
}

const host = globalThis as typeof globalThis & {
  __etsStartProcess: (configJson: string) => string;
  __etsPushHostEventsBinary: (metadata: Uint8Array) => string;
  __etsUpdateBinary: (arg: string) => string | Promise<string>;
};
host.__etsStartProcess = startProcess;
host.__etsPushHostEventsBinary = pushHostEventsBinary;
host.__etsUpdateBinary = updateBinary;

export {};
