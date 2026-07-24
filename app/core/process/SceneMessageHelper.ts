import type { IMessage, IRequest, IResponse, MessageDescriptor } from "../protocol/message";
import { RpcError } from "../protocol/RpcError";
import type { RpcDescriptor } from "../protocol/rpc";
import { SystemErrCode } from "../protocol/SystemErrCode";
import type { SceneCallContext, SceneCallOptions, SceneSendOptions } from "./context";
import type { SceneConfig } from "./types";
import type { ActorLocationTarget } from "./ActorLocation";

export class SceneMessageHelper {
  constructor(private readonly ctx: SceneCallContext) {}

  /** Resolves the sole Scene of a type; zero or multiple matches are deployment errors. */
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

  /** Resolves zero or one Scene while still rejecting ambiguous scaled deployments. */
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

  /** Returns all configured instances for explicit load balancing or fan-out. */
  many(sceneType: string): SceneConfig[] { return this.ctx.refs(sceneType); }

  /** Resolves a concrete configured Scene after business code deliberately selected its instance. */
  byName(name: string): SceneConfig {
    const target = this.ctx.knownScenes.find((scene) => scene.name === name);
    if (!target) throw new RpcError(SystemErrCode.SceneNotFound, `scene not found: ${name}`);
    return target;
  }

  /** Calls a known Scene instance and multiplexes the response by payload rpcId. */
  call<TReq extends IRequest, TResp extends IResponse>(
    target: SceneConfig,
    descriptor: RpcDescriptor<TReq, TResp>,
    request: TReq,
    options: SceneCallOptions = {},
  ): Promise<TResp> {
    return this.ctx.call(target, descriptor, request, options);
  }

  /** Calls a singleton Scene type; do not use it for horizontally scaled types. */
  callOne<TReq extends IRequest, TResp extends IResponse>(
    sceneType: string,
    descriptor: RpcDescriptor<TReq, TResp>,
    request: TReq,
    options: SceneCallOptions = {},
  ): Promise<TResp> {
    return this.call(this.one(sceneType), descriptor, request, options);
  }

  /** Calls an optional singleton capability and returns undefined when it is not deployed. */
  async callOptionalOne<TReq extends IRequest, TResp extends IResponse>(
    sceneType: string,
    descriptor: RpcDescriptor<TReq, TResp>,
    request: TReq,
    options: SceneCallOptions = {},
  ): Promise<TResp | undefined> {
    const target = this.optionalOne(sceneType);
    return target ? this.call(target, descriptor, request, options) : undefined;
  }

  /** Calls a concrete Actor InstanceId through its owning Scene and mailbox. */
  callActor<TReq extends IRequest, TResp extends IResponse>(
    target: ActorLocationTarget,
    descriptor: RpcDescriptor<TReq, TResp>,
    request: TReq,
    options: SceneCallOptions = {},
  ): Promise<TResp> {
    return this.ctx.callActor(target, descriptor, request, options);
  }

  /** Sends a one-way Scene message without allocating an RPC completion. */
  send<TMessage extends IMessage>(
    target: SceneConfig,
    descriptor: MessageDescriptor<TMessage>,
    message: TMessage,
    options: SceneSendOptions = {},
  ): Promise<void> {
    return this.ctx.send(target, descriptor, message, options);
  }

  /** Sends a one-way message to the sole Scene of a type. */
  sendOne<TMessage extends IMessage>(
    sceneType: string,
    descriptor: MessageDescriptor<TMessage>,
    message: TMessage,
    options: SceneSendOptions = {},
  ): Promise<void> {
    return this.send(this.one(sceneType), descriptor, message, options);
  }

  /** Sends a one-way Actor message while preserving target mailbox ordering. */
  sendActor<TMessage extends IMessage>(
    target: ActorLocationTarget,
    descriptor: MessageDescriptor<TMessage>,
    message: TMessage,
    options: SceneSendOptions = {},
  ): Promise<void> {
    return this.ctx.sendActor(target, descriptor, message, options);
  }
}
