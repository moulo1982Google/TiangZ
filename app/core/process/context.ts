import { readU16BE } from "../protocol/binary";
import type { IMessage, IRequest, IResponse, MessageDescriptor } from "../protocol/message";
import { packFrame } from "../protocol/registry";
import { RpcError } from "../protocol/RpcError";
import type { RpcDescriptor } from "../protocol/rpc";
import { SystemErrCode } from "../protocol/SystemErrCode";
import { nowMs, type LatencyRecorder } from "../metrics/latency";
import type { LocalSceneRouter, RuntimeEntrySceneConfig, SceneConfig } from "./types";
import {
  encodeActorLocationEnvelope,
  extractFrameRpcId,
  rewriteFrameRpcId,
  type ActorLocationTarget,
} from "./ActorLocation";

export interface SceneCallOptions { timeoutMs?: number; }
export type SceneSendOptions = SceneCallOptions;

export class SceneCallContext {
  private nextRpcId = 1;

  constructor(
    private readonly config: RuntimeEntrySceneConfig,
    private readonly localRouter: LocalSceneRouter,
    private readonly latencies?: LatencyRecorder,
  ) {}

  get self(): SceneConfig { return this.config.self; }
  get knownScenes(): readonly SceneConfig[] { return this.config.knownScenes; }

  ref(nameOrType: string): SceneConfig | undefined {
    return this.config.knownScenes.find(
      (scene) => scene.name === nameOrType || scene.sceneType === nameOrType,
    );
  }

  refs(sceneType: string): SceneConfig[] {
    return this.config.knownScenes.filter((scene) => scene.sceneType === sceneType);
  }

  async call<TReq extends IRequest, TResp extends IResponse>(
    target: SceneConfig,
    descriptor: RpcDescriptor<TReq, TResp>,
    request: TReq,
    options: SceneCallOptions = {},
  ): Promise<TResp> {
    const rpcId = this.allocateRpcId();
    request.rpcId = rpcId;
    const frame = packFrame(descriptor.requestCode, descriptor.requestCodec.encode(request));

    const responseFrame = await this.callFrame(target, frame, options);

    return this.decodeRpcResponse(descriptor, responseFrame, rpcId);
  }

  async callActor<TReq extends IRequest, TResp extends IResponse>(
    target: ActorLocationTarget,
    descriptor: RpcDescriptor<TReq, TResp>,
    request: TReq,
    options: SceneCallOptions = {},
  ): Promise<TResp> {
    const rpcId = this.allocateRpcId();
    request.rpcId = rpcId;
    const innerFrame = packFrame(
      descriptor.requestCode,
      descriptor.requestCodec.encode(request),
    );
    const frame = encodeActorLocationEnvelope({
      instanceId: target.instanceId,
      frame: innerFrame,
      rpcId,
    });
    const responseFrame = await this.callFrame(target.scene, frame, options);
    return this.decodeRpcResponse(descriptor, responseFrame, rpcId);
  }

  async callActorFrame(
    target: ActorLocationTarget,
    frame: Uint8Array,
    expectedResponseCode: number,
    options: SceneCallOptions = {},
  ): Promise<Uint8Array> {
    const clientRpcId = extractFrameRpcId(frame);
    if (!clientRpcId) {
      throw new RpcError(SystemErrCode.MalformedFrame, "actor RPC request has no rpcId");
    }
    const internalRpcId = this.allocateRpcId();
    const innerFrame = rewriteFrameRpcId(frame, internalRpcId);
    const envelope = encodeActorLocationEnvelope({
      instanceId: target.instanceId,
      frame: innerFrame,
      rpcId: internalRpcId,
    });
    const responseFrame = await this.callFrame(target.scene, envelope, options);
    if (responseFrame.length < 2 || readU16BE(responseFrame, 0) !== expectedResponseCode) {
      throw new RpcError(
        SystemErrCode.UnexpectedResponseCode,
        `unexpected actor response code ${responseFrame.length < 2 ? "missing" : readU16BE(responseFrame, 0)}, expected ${expectedResponseCode}`,
      );
    }
    if (extractFrameRpcId(responseFrame) !== internalRpcId) {
      throw new RpcError(SystemErrCode.RpcIdMismatch, "actor response rpcId mismatch");
    }
    return rewriteFrameRpcId(responseFrame, clientRpcId);
  }

  private decodeRpcResponse<TReq, TResp extends IResponse>(
    descriptor: RpcDescriptor<TReq, TResp>,
    responseFrame: Uint8Array,
    rpcId: number,
  ): TResp {

    if (responseFrame.length < 2) {
      throw new RpcError(SystemErrCode.MalformedFrame, "response frame too short");
    }
    const responseCode = readU16BE(responseFrame, 0);
    if (responseCode !== descriptor.responseCode) {
      throw new RpcError(
        SystemErrCode.UnexpectedResponseCode,
        `unexpected response code ${responseCode}, expected ${descriptor.responseCode}`,
      );
    }
    const response = descriptor.responseCodec.decode(responseFrame.subarray(2));
    if (response.rpcId !== rpcId) {
      throw new RpcError(
        SystemErrCode.RpcIdMismatch,
        `RPC id mismatch ${response.rpcId ?? 0}, expected ${rpcId}`,
      );
    }
    if ((response.error ?? SystemErrCode.Success) !== SystemErrCode.Success) {
      throw new RpcError(response.error!, response.message ?? descriptor.name);
    }
    return response;
  }

  async callFrame(
    target: SceneConfig,
    frame: Uint8Array,
    options: SceneCallOptions = {},
  ): Promise<Uint8Array> {
    const startedAt = this.latencies ? nowMs() : 0;
    const isLocal = this.localRouter.hasLocalScene(target.name);
    try {
      return isLocal
        ? await this.localRouter.callLocalScene(this.self.name, target.name, frame)
        : await hostSceneCall(this.self, target, frame, options.timeoutMs ?? 5000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RpcError(
        message.includes("[scene-overloaded]")
          ? SystemErrCode.SceneOverloaded
          : SystemErrCode.SceneCallFailed,
        message,
      );
    } finally {
      if (this.latencies) {
        this.latencies.record(
          isLocal ? "scene.call.local" : "scene.call.remote",
          nowMs() - startedAt,
          frame.length >= 2 ? readU16BE(frame, 0) : undefined,
        );
      }
    }
  }

  async send<TMessage extends IMessage>(
    target: SceneConfig,
    descriptor: MessageDescriptor<TMessage>,
    message: TMessage,
    options: SceneSendOptions = {},
  ): Promise<void> {
    const frame = packFrame(descriptor.msgcode, descriptor.codec.encode(message));
    await this.sendFrame(target, frame, options);
  }

  async sendActor<TMessage extends IMessage>(
    target: ActorLocationTarget,
    descriptor: MessageDescriptor<TMessage>,
    message: TMessage,
    options: SceneSendOptions = {},
  ): Promise<void> {
    const innerFrame = packFrame(descriptor.msgcode, descriptor.codec.encode(message));
    const frame = encodeActorLocationEnvelope({
      instanceId: target.instanceId,
      frame: innerFrame,
    });
    await this.sendFrame(target.scene, frame, options);
  }

  async sendFrame(
    target: SceneConfig,
    frame: Uint8Array,
    options: SceneSendOptions = {},
  ): Promise<void> {
    const startedAt = this.latencies ? nowMs() : 0;
    const isLocal = this.localRouter.hasLocalScene(target.name);
    try {
      if (isLocal) {
        await this.localRouter.sendLocalScene(this.self.name, target.name, frame);
      } else {
        await hostSceneSend(this.self, target, frame, options.timeoutMs ?? 5000);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      throw new RpcError(
        text.includes("[scene-overloaded]")
          ? SystemErrCode.SceneOverloaded
          : SystemErrCode.SceneCallFailed,
        text,
      );
    } finally {
      if (this.latencies) {
        this.latencies.record(
          isLocal ? "scene.send.local" : "scene.send.remote",
          nowMs() - startedAt,
          frame.length >= 2 ? readU16BE(frame, 0) : undefined,
        );
      }
    }
  }

  private allocateRpcId(): number {
    const rpcId = this.nextRpcId;
    this.nextRpcId = (this.nextRpcId % 0xffff_ffff) + 1;
    return rpcId;
  }
}

function hostSceneSend(source: SceneConfig, target: SceneConfig, frame: Uint8Array, timeoutMs: number): Promise<void> {
  const host = globalThis as typeof globalThis & {
    __hostSceneSend?: (
      sourceName: string,
      targetName: string,
      targetIp: string,
      targetPort: number,
      frame: Uint8Array,
      timeoutMs: number,
    ) => Promise<void>;
  };
  if (!host.__hostSceneSend) throw new Error("host scene send op is not available");
  return host.__hostSceneSend(
    source.name,
    target.name,
    target.ip,
    target.port,
    frame,
    timeoutMs,
  );
}

function hostSceneCall(source: SceneConfig, target: SceneConfig, frame: Uint8Array, timeoutMs: number): Promise<Uint8Array> {
  const host = globalThis as typeof globalThis & {
    __hostSceneCall?: (
      sourceName: string,
      targetName: string,
      targetIp: string,
      targetPort: number,
      frame: Uint8Array,
      timeoutMs: number,
    ) => Promise<Uint8Array>;
  };
  if (!host.__hostSceneCall) throw new Error("host scene call op is not available");
  return host.__hostSceneCall(
    source.name,
    target.name,
    target.ip,
    target.port,
    frame,
    timeoutMs,
  );
}
