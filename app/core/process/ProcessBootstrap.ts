import { isPromiseLike, type MaybePromise } from "../async";
import { HotfixSystem } from "../hotReload/HotfixSystem";
import type { HotfixManifest } from "../hotReload/contracts";
import { ProcessRuntime, type ProcessUpdateResult } from "./ProcessRuntime";
import type { ProcessRuntimeConfig } from "./types";
import { PrepareGlobalIds } from "../persistence/PrepareGlobalIds";
import {
  cancelHostSceneOperations,
  completeHostSceneOperation,
  flushHostSceneOperations,
  sleepHost,
} from "./HostSceneTransport";

interface ProcessBootstrapAdapters {
  readonly modelExports: object;
  readonly configureProcess?: (config: ProcessRuntimeConfig["process"]) => void;
  readonly takeMetrics?: () => object;
  readonly prepareGameConfig?: (manifestJson: string, dataJson: string) => () => void;
}

/** 安装一次进程桥接；领域初始化由不可变宿主入口提供。 / Installs the process bridge once; immutable host entries supply domain initialization. */
export function installProcessBootstrap(adapters: ProcessBootstrapAdapters): void {
  Object.defineProperty(globalThis, "__tiangzGlobalIdRangesVersion", { value: 1, writable: false, configurable: false });
  Object.defineProperty(globalThis, "__tiangzModelExports", {
    value: adapters.modelExports,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  let processRuntime: ProcessRuntime | undefined;
  let processStopping = false;
  let processStarting = false;

  async function startProcess(configJson: string): Promise<string> {
    if (processStarting || processRuntime || processStopping) throw new Error("process cannot start twice or while shutting down");
    processStarting = true;
    let idSource: Awaited<ReturnType<typeof PrepareGlobalIds>>;
    try {
      const config = JSON.parse(configJson) as ProcessRuntimeConfig;
      idSource = await PrepareGlobalIds(config.process);
      if (processStopping) throw new Error("process stopped during global id preparation");
      adapters.configureProcess?.(config.process);
      const runtime = new ProcessRuntime(config, idSource);
      processRuntime = runtime;
      return await runtime.start();
    } catch (error) {
      idSource?.Dispose();
      processRuntime = undefined;
      throw error;
    } finally {
      processStarting = false;
    }
  }

  async function stopProcess(): Promise<string> {
    processStopping = true;
    if (!processRuntime) return "already stopped";
    const runtime = processRuntime;
    const timeoutMs = runtime.StopTimeoutMs;
    try {
      await Promise.race([
        runtime.stop(),
        sleepHost(timeoutMs).then(() => {
          throw new Error(`process stop timed out after ${timeoutMs}ms`);
        }),
      ]);
      return "stopped";
    } finally {
      flushHostSceneOperations();
      cancelHostSceneOperations("process stopped before host operation completed");
      processRuntime = undefined;
      processStopping = false;
    }
  }

  const HOST_EVENT_HEADER_BYTES = 13;

  function pushHostEventsBinary(batch: Uint8Array): string {
    if (!processRuntime) return "false";
    if (batch.length < 4) throw new Error(`invalid host event batch length: ${batch.length}`);
    const view = new DataView(batch.buffer, batch.byteOffset, batch.byteLength);
    const count = view.getUint32(0, true);
    let offset = 4;
    for (let index = 0; index < count; index += 1) {
      if (offset + HOST_EVENT_HEADER_BYTES > batch.length) {
        throw new Error(`truncated host event header at index ${index}`);
      }
      const eventType = batch[offset];
      const connectionId = view.getUint32(offset + 1, true);
      const sceneIndex = view.getUint32(offset + 5, true);
      const payloadLength = view.getUint32(offset + 9, true);
      offset += HOST_EVENT_HEADER_BYTES;
      const payloadEnd = offset + payloadLength;
      if (payloadEnd > batch.length) {
        throw new Error(`truncated host event payload at index ${index}`);
      }
      const payload = batch.subarray(offset, payloadEnd);
      offset = payloadEnd;
      if (eventType === 1) {
        processRuntime.pushHostFrame(sceneIndex, connectionId, payload);
      } else if (eventType === 5) {
        processRuntime.pushHostControlFrame(sceneIndex, connectionId, payload);
      } else if (eventType === 2) {
        processRuntime.pushHostDisconnect(sceneIndex, connectionId);
      } else if (eventType === 3 || eventType === 4) {
        completeHostSceneOperation(connectionId, eventType === 3, payload);
      } else {
        throw new Error(`unknown host event type: ${eventType}`);
      }
    }
    if (offset !== batch.length) throw new Error("host event batch has trailing bytes");
    return "true";
  }

  function updateBinary(sampleMetrics: boolean, hotfixDraining = false): MaybePromise<string> {
    // 停机只排空宿主操作，不能重新推进游戏Timer或接收新业务。 / Shutdown drains host work without advancing gameplay timers or new business.
    if (processStopping) { flushHostSceneOperations(); return "0"; }
    if (!processRuntime) return JSON.stringify({});
    const result = processRuntime.update(sampleMetrics, hotfixDraining);
    return isPromiseLike(result)
      ? Promise.resolve(result).then((value) => flushUpdateResult(value, sampleMetrics))
      : flushUpdateResult(result, sampleMetrics);
  }

  function flushUpdateResult(result: ProcessUpdateResult, sampleMetrics: boolean): string {
    flushHostSceneOperations();
    const outbound = result.outbound;
    if (outbound.length > 0) {
      hostPushOutboundPacked(packOutbound(outbound));
    }
    if (!sampleMetrics) {
      return String((result.pendingAsync ? 1 : 0) | (result.pendingIngress ? 2 : 0));
    }
    return JSON.stringify({
      metrics: result.metrics,
      game: result.game,
      actorMailbox: result.actorMailbox,
      ...adapters.takeMetrics?.(),
      pendingAsync: result.pendingAsync,
      pendingIngress: result.pendingIngress,
    });
  }

  function beginHotfix(manifestJson: string): string {
    if (processRuntime && !processRuntime.CanCommitHotfix) {
      throw new Error("hotfix requires empty ingress and zero in-flight business tasks");
    }
    const manifest = JSON.parse(manifestJson) as HotfixManifest & {
      runtimeConfig?: { manifestJson: string; dataJson: string };
    };
    if (manifest.runtimeConfig && !adapters.prepareGameConfig) {
      throw new Error("Model does not support atomic Hotfix/config release; rebuild and restart");
    }
    const commitConfig = manifest.runtimeConfig
      ? adapters.prepareGameConfig!(manifest.runtimeConfig.manifestJson, manifest.runtimeConfig.dataJson)
      : undefined;
    // 快照已暂存，不在活动 manifest 中重复保留完整 JSON。 / Staging owns the snapshot; do not retain its JSON in the active manifest.
    delete manifest.runtimeConfig;
    HotfixSystem.Begin(manifest, commitConfig);
    return JSON.stringify(HotfixSystem.Status());
  }

  function commitHotfix(): string {
    if (processRuntime && !processRuntime.CanCommitHotfix) {
      throw new Error("hotfix commit barrier was lost before commit");
    }
    return JSON.stringify(HotfixSystem.Commit());
  }

  function abortHotfix(reason: string): string {
    HotfixSystem.Abort(reason);
    return JSON.stringify(HotfixSystem.Status());
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

  const hostPushOutboundPacked = (globalThis as typeof globalThis & {
      __hostPushOutboundPacked: (packed: Uint8Array) => void;
    }).__hostPushOutboundPacked;

  const host = globalThis as typeof globalThis & {
    __etsStartProcess: (configJson: string) => string | Promise<string>;
    __etsStopProcess: () => string | Promise<string>;
    __etsPushHostEventsBinary: (metadata: Uint8Array) => string;
    __etsUpdateBinary: (sampleMetrics: boolean, hotfixDraining?: boolean) => string | Promise<string>;
    __etsBeginHotfix: (manifestJson: string) => string;
    __etsCommitHotfix: () => string;
    __etsAbortHotfix: (reason: string) => string;
    __hostSleep: (ms: number) => Promise<void>;
  };
  host.__hostSleep = sleepHost;
  host.__etsStartProcess = startProcess;
  host.__etsStopProcess = stopProcess;
  host.__etsPushHostEventsBinary = pushHostEventsBinary;
  host.__etsUpdateBinary = updateBinary;
  host.__etsBeginHotfix = beginHotfix;
  host.__etsCommitHotfix = commitHotfix;
  host.__etsAbortHotfix = abortHotfix;
}
