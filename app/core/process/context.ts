import { readU16BE } from "../protocol/binary";
import { isPromiseLike, type MaybePromise } from "../async";
import type { IMessage, IRequest, IResponse, MessageDescriptor } from "../protocol/message";
import { packFrame } from "../protocol/registry";
import { RpcError } from "../protocol/RpcError";
import type { RpcDescriptor } from "../protocol/rpc";
import { SystemErrCode } from "../protocol/SystemErrCode";
import { nowMs, type LatencyRecorder } from "../metrics/latency";
import type { LocalSceneRouter, RuntimeEntrySceneConfig, SceneConfig } from "./types";
import { callRemoteScene, sendRemoteScene, sleepHost } from "./HostSceneTransport";
import {
  encodeActorLocationEnvelope,
  extractFrameRpcId,
  rewriteFrameRpcId,
  type ActorLocationTarget,
} from "./ActorLocation";
import { Logger } from "../logging/Logger";

export interface SceneCallOptions { timeoutMs?: number; }
export type SceneSendOptions = SceneCallOptions;

export class SceneCallContext {
  private nextRpcId = 1;
  private readonly inFlightRpcIds = new Set<number>();
  readonly logger: Logger;

  constructor(
    private readonly config: RuntimeEntrySceneConfig,
    private readonly localRouter: LocalSceneRouter,
    private readonly latencies?: LatencyRecorder,
  ) {
    this.logger = new Logger(`scene:${config.self.sceneType}`, {
      category: "business",
      process: config.process.name,
      scene: config.self.name,
      sceneType: config.self.sceneType,
    });
  }

  get self(): SceneConfig { return this.config.self; }
  get knownScenes(): readonly SceneConfig[] { return this.config.knownScenes; }

  /** 为兼容旧代码解析第一个匹配的名称或类型；需要歧义检查时应使用 SceneMessageHelper。 / Resolves the first matching name/type for compatibility; prefer SceneMessageHelper for ambiguity checks. */
  ref(nameOrType: string): SceneConfig | undefined {
    return this.config.knownScenes.find(
      (scene) => scene.name === nameOrType || scene.sceneType === nameOrType,
    );
  }

  /** 列出某类型已配置的 Scene 实例，不探测网络。 / Lists configured Scene instances of one type without probing the network. */
  refs(sceneType: string): SceneConfig[] {
    return this.config.knownScenes.filter((scene) => scene.sceneType === sceneType);
  }

  /** 分配 rpcId、编码并选择本地或远程路由，随后校验响应 code、id 与错误。 / Assigns rpcId, encodes, routes locally/remotely, then validates response code/id/error. */
  async call<TReq extends IRequest, TResp extends IResponse>(
    target: SceneConfig,
    descriptor: RpcDescriptor<TReq, TResp>,
    request: TReq,
    options: SceneCallOptions = {},
  ): Promise<TResp> {
    const rpcId = this.reserveRpcId();
    request.rpcId = rpcId;
    const frame = packFrame(descriptor.requestCode, descriptor.requestCodec.encode(request));
    try {
      const responseFrame = await this.callFrame(target, frame, options);
      return this.decodeRpcResponse(descriptor, responseFrame, rpcId);
    } finally {
      this.inFlightRpcIds.delete(rpcId);
    }
  }

  /** 使用 ActorLocation 元数据包装 RPC，并保持目标 Actor mailbox 语义。 / Wraps an RPC in ActorLocation metadata and preserves the target Actor mailbox. */
  async callActor<TReq extends IRequest, TResp extends IResponse>(
    target: ActorLocationTarget,
    descriptor: RpcDescriptor<TReq, TResp>,
    request: TReq,
    options: SceneCallOptions = {},
  ): Promise<TResp> {
    const rpcId = this.reserveRpcId();
    request.rpcId = rpcId;
    const innerFrame = packFrame(
      descriptor.requestCode,
      descriptor.requestCodec.encode(request),
    );
    const frame = encodeActorLocationEnvelope({
      instanceId: target.instanceId,
      fenceToken: target.fenceToken,
      frame: innerFrame,
      rpcId,
    });
    try {
      const responseFrame = await this.callFrame(target.scene, frame, options);
      return this.decodeRpcResponse(descriptor, responseFrame, rpcId);
    } finally {
      this.inFlightRpcIds.delete(rpcId);
    }
  }

  /** 转发不透明客户端 Actor RPC，同时转换外部与内部 rpcId。 / Forwards an opaque client Actor RPC while translating external and internal rpcIds. */
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
    const internalRpcId = this.reserveRpcId();
    const innerFrame = rewriteFrameRpcId(frame, internalRpcId);
    const envelope = encodeActorLocationEnvelope({
      instanceId: target.instanceId,
      fenceToken: target.fenceToken,
      frame: innerFrame,
      rpcId: internalRpcId,
    });
    try {
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
    } finally {
      this.inFlightRpcIds.delete(internalRpcId);
    }
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

  /** 选择本地 mailbox 或远程传输，并记录统一的链路耗时指标。 / Chooses local mailbox or remote transport and records one common latency metric. */
  async callFrame(
    target: SceneConfig,
    frame: Uint8Array,
    options: SceneCallOptions = {},
  ): Promise<Uint8Array> {
    const startedAt = this.latencies ? nowMs() : 0;
    const isLocal = this.localRouter.hasLocalScene(target.name);
    try {
      if (!isLocal) {
        return await callRemoteScene(
          this.self,
          target,
          frame,
          options.timeoutMs ?? 5000,
        );
      }
      const localCall = this.localRouter.callLocalScene(
        this.self.name,
        target.name,
        frame,
      );
      if (options.timeoutMs === undefined) return await localCall;
      const timeoutMs = Math.max(1, Math.min(options.timeoutMs, 0xffff_ffff));
      return await Promise.race([
        localCall,
        sleepHost(timeoutMs).then(() => {
          throw new Error(
            `local scene call to ${target.name} timed out after ${timeoutMs}ms`,
          );
        }),
      ]);
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

  /** 编码并发送单向 Scene 消息，不创建响应等待者。 / Encodes and sends a one-way Scene message without a response waiter. */
  send<TMessage extends IMessage>(
    target: SceneConfig,
    descriptor: MessageDescriptor<TMessage>,
    message: TMessage,
    options: SceneSendOptions = {},
  ): MaybePromise<void> {
    const frame = packFrame(descriptor.msgcode, descriptor.codec.encode(message));
    return this.sendFrame(target, frame, options);
  }

  /** 包装并向具体 Actor InstanceId 发送单向消息。 / Wraps and sends a one-way message to a concrete Actor InstanceId. */
  sendActor<TMessage extends IMessage>(
    target: ActorLocationTarget,
    descriptor: MessageDescriptor<TMessage>,
    message: TMessage,
    options: SceneSendOptions = {},
  ): MaybePromise<void> {
    const innerFrame = packFrame(descriptor.msgcode, descriptor.codec.encode(message));
    const frame = encodeActorLocationEnvelope({
      instanceId: target.instanceId,
      fenceToken: target.fenceToken,
      frame: innerFrame,
    });
    return this.sendFrame(target.scene, frame, options);
  }

  /** 使用与 RPC 相同的本地/远程错误映射发送不透明帧。 / Sends an opaque frame through the same local/remote error mapping as RPC calls. */
  sendFrame(
    target: SceneConfig,
    frame: Uint8Array,
    options: SceneSendOptions = {},
  ): MaybePromise<void> {
    const startedAt = this.latencies ? nowMs() : 0;
    const isLocal = this.localRouter.hasLocalScene(target.name);
    const finish = (): void => {
      if (this.latencies) {
        this.latencies.record(
          isLocal ? "scene.send.local" : "scene.send.remote",
          nowMs() - startedAt,
          frame.length >= 2 ? readU16BE(frame, 0) : undefined,
        );
      }
    };
    const mapError = (error: unknown): RpcError => {
      const text = error instanceof Error ? error.message : String(error);
      return new RpcError(
        text.includes("[scene-overloaded]")
          ? SystemErrCode.SceneOverloaded
          : SystemErrCode.SceneCallFailed,
        text,
      );
    };
    try {
      const result = isLocal
        ? this.localRouter.sendLocalScene(this.self.name, target.name, frame)
        : sendRemoteScene(this.self, target, frame, options.timeoutMs ?? 5000);
      if (isPromiseLike(result)) {
        return result.then(
          () => {
            finish();
          },
          (error) => {
            finish();
            throw mapError(error);
          },
        );
      }
      finish();
      return;
    } catch (error) {
      finish();
      throw mapError(error);
    }
  }

  /** 预留未被在途调用占用的 rpcId；直到调用完成前都不允许复用。 / Reserves an rpcId not used by an in-flight call and keeps it unavailable until completion. */
  private reserveRpcId(): number {
    if (this.inFlightRpcIds.size >= 0xffff_ffff) {
      throw new RpcError(SystemErrCode.SceneOverloaded, "rpcId space is exhausted");
    }
    const attemptsLimit = this.inFlightRpcIds.size + 1;
    for (let attempts = 0; attempts < attemptsLimit; attempts += 1) {
      const rpcId = this.nextRpcId;
      this.nextRpcId = (this.nextRpcId % 0xffff_ffff) + 1;
      if (this.inFlightRpcIds.has(rpcId)) continue;
      this.inFlightRpcIds.add(rpcId);
      return rpcId;
    }
    throw new RpcError(SystemErrCode.SceneOverloaded, "rpcId space is exhausted");
  }
}
