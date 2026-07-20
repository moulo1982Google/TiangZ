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
  const outbound = result.outbound;
  if (outbound.length > 0) {
    hostPushOutboundPacked(packOutbound(outbound));
  }
  return JSON.stringify({
    metrics: result.metrics,
    pendingAsync: result.pendingAsync,
  });
}

function packOutbound(outbound: ProcessUpdateResult["outbound"]): Uint8Array {
  // [batchCount:u32] + repeated [targetCount:u32][targetIds:u32...][frameLen:u32][frame]
  let byteLength = 4;
  for (const batch of outbound) {
    if (batch.connectionIdBytes.length === 0 || batch.connectionIdBytes.length % 4 !== 0) {
      throw new Error("outbound connection ids must be non-empty uint32 values");
    }
    byteLength += 4 + batch.connectionIdBytes.length + 4 + batch.frame.length;
    if (!Number.isSafeInteger(byteLength) || byteLength > 0xffff_ffff) {
      throw new Error(`outbound packet is too large: ${byteLength}`);
    }
  }

  const packed = new Uint8Array(byteLength);
  const view = new DataView(packed.buffer);
  view.setUint32(0, outbound.length, true);
  let offset = 4;
  for (const batch of outbound) {
    view.setUint32(offset, batch.connectionIdBytes.length / 4, true);
    offset += 4;
    packed.set(batch.connectionIdBytes, offset);
    offset += batch.connectionIdBytes.length;
    view.setUint32(offset, batch.frame.length, true);
    offset += 4;
    packed.set(batch.frame, offset);
    offset += batch.frame.length;
  }
  return packed;
}

function hostTakeBinaryArg(): Uint8Array {
  return (globalThis as typeof globalThis & { __hostTakeBinaryArg: () => Uint8Array })
    .__hostTakeBinaryArg();
}

const hostPushOutboundPacked = (globalThis as typeof globalThis & {
    __hostPushOutboundPacked: (packed: Uint8Array) => void;
  }).__hostPushOutboundPacked;

const host = globalThis as typeof globalThis & {
  __etsStartProcess: (configJson: string) => string;
  __etsPushHostEventsBinary: (metadata: Uint8Array) => string;
  __etsUpdateBinary: (arg: string) => string | Promise<string>;
};
host.__etsStartProcess = startProcess;
host.__etsPushHostEventsBinary = pushHostEventsBinary;
host.__etsUpdateBinary = updateBinary;

export {};
