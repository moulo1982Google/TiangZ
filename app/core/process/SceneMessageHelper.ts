import type { IMessage, IRequest, IResponse, MessageDescriptor } from "../protocol/message";
import type { MaybePromise } from "../async";
import { RpcError } from "../protocol/RpcError";
import type { RpcDescriptor } from "../protocol/rpc";
import { SystemErrCode } from "../protocol/SystemErrCode";
import type { SceneCallContext, SceneCallOptions, SceneSendOptions } from "./context";
import type { SceneConfig } from "./types";
import type { ActorLocationTarget } from "./ActorLocation";

export class SceneMessageHelper {
  constructor(private readonly ctx: SceneCallContext) {}

  /** 解析某类型唯一的 Scene；零个或多个实例都视为部署错误。 / Resolves the sole Scene of a type; zero or multiple matches are deployment errors. */
  one(sceneType: string): SceneConfig {
    const scenes = this.many(sceneType);
    if (scenes.length === 0) {
      throw new RpcError(SystemErrCode.SceneNotFound, `scene not found: ${sceneType}`);
    }
    if (scenes.length > 1) {
      throw new RpcError(
        SystemErrCode.AmbiguousScene,
        `scene type ${sceneType} has ${scenes.length} instances`,
      );
    }
    return scenes[0];
  }

  /** 解析零个或一个 Scene，同时拒绝存在多个实例的歧义部署。 / Resolves zero or one Scene while still rejecting ambiguous scaled deployments. */
  optionalOne(sceneType: string): SceneConfig | undefined {
    const scenes = this.many(sceneType);
    if (scenes.length > 1) {
      throw new RpcError(
        SystemErrCode.AmbiguousScene,
        `scene type ${sceneType} has ${scenes.length} instances`,
      );
    }
    return scenes[0];
  }

  /** 返回全部已配置实例，供业务显式负载均衡或扇出。 / Returns all configured instances for explicit load balancing or fan-out. */
  many(sceneType: string): SceneConfig[] { return this.ctx.refs(sceneType); }

  /** 在业务明确选定实例后，解析对应的具体 Scene 配置。 / Resolves a concrete configured Scene after business code deliberately selected its instance. */
  byName(name: string): SceneConfig {
    const target = this.ctx.knownScenes.find((scene) => scene.name === name);
    if (!target) throw new RpcError(SystemErrCode.SceneNotFound, `scene not found: ${name}`);
    return target;
  }

  /** 调用已知 Scene 实例，并通过 payload 内的 rpcId 多路复用响应。 / Calls a known Scene instance and multiplexes the response by payload rpcId. */
  call<TReq extends IRequest, TResp extends IResponse>(
    target: SceneConfig,
    descriptor: RpcDescriptor<TReq, TResp>,
    request: TReq,
    options: SceneCallOptions = {},
  ): Promise<TResp> {
    return this.ctx.call(target, descriptor, request, options);
  }

  /** 调用单例 Scene 类型；不可用于横向扩展的多实例类型。 / Calls a singleton Scene type; do not use it for horizontally scaled types. */
  callOne<TReq extends IRequest, TResp extends IResponse>(
    sceneType: string,
    descriptor: RpcDescriptor<TReq, TResp>,
    request: TReq,
    options: SceneCallOptions = {},
  ): Promise<TResp> {
    return this.call(this.one(sceneType), descriptor, request, options);
  }

  /** 调用可选单例能力；未部署时返回 undefined。 / Calls an optional singleton capability and returns undefined when it is not deployed. */
  async callOptionalOne<TReq extends IRequest, TResp extends IResponse>(
    sceneType: string,
    descriptor: RpcDescriptor<TReq, TResp>,
    request: TReq,
    options: SceneCallOptions = {},
  ): Promise<TResp | undefined> {
    const target = this.optionalOne(sceneType);
    return target ? this.call(target, descriptor, request, options) : undefined;
  }

  /** 经由所属 Scene 和 mailbox 调用具体 Actor InstanceId。 / Calls a concrete Actor InstanceId through its owning Scene and mailbox. */
  callActor<TReq extends IRequest, TResp extends IResponse>(
    target: ActorLocationTarget,
    descriptor: RpcDescriptor<TReq, TResp>,
    request: TReq,
    options: SceneCallOptions = {},
  ): Promise<TResp> {
    return this.ctx.callActor(target, descriptor, request, options);
  }

  /** 发送单向 Scene 消息，不创建 RPC 完成等待。 / Sends a one-way Scene message without allocating an RPC completion. */
  send<TMessage extends IMessage>(
    target: SceneConfig,
    descriptor: MessageDescriptor<TMessage>,
    message: TMessage,
    options: SceneSendOptions = {},
  ): MaybePromise<void> {
    return this.ctx.send(target, descriptor, message, options);
  }

  /**
   * 发送已经包含 msgcode 的完整 Scene 帧，供协议生成器和批量 Transport 使用。
   * 业务 Handler 应优先使用 `send`，避免绕过 descriptor 的类型检查。
   *
   * Sends a complete Scene frame that already includes its msgcode. This is for
   * generated protocol paths and transports; business handlers should prefer `send`.
   */
  sendFrame(
    target: SceneConfig,
    frame: Uint8Array,
    options: SceneSendOptions = {},
  ): MaybePromise<void> {
    return this.ctx.sendFrame(target, frame, options);
  }

  /** 向某类型唯一的 Scene 发送单向消息。 / Sends a one-way message to the sole Scene of a type. */
  sendOne<TMessage extends IMessage>(
    sceneType: string,
    descriptor: MessageDescriptor<TMessage>,
    message: TMessage,
    options: SceneSendOptions = {},
  ): MaybePromise<void> {
    return this.send(this.one(sceneType), descriptor, message, options);
  }

  /** 发送单向 Actor 消息，并保持目标 mailbox 的顺序语义。 / Sends a one-way Actor message while preserving target mailbox ordering. */
  sendActor<TMessage extends IMessage>(
    target: ActorLocationTarget,
    descriptor: MessageDescriptor<TMessage>,
    message: TMessage,
    options: SceneSendOptions = {},
  ): MaybePromise<void> {
    return this.ctx.sendActor(target, descriptor, message, options);
  }
}
