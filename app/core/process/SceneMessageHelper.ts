import type { IMessage, IRequest, IResponse, MessageDescriptor } from "../protocol/message";
import { RpcError } from "../protocol/RpcError";
import type { RpcDescriptor } from "../protocol/rpc";
import { SystemErrCode } from "../protocol/SystemErrCode";
import type { SceneCallContext, SceneCallOptions, SceneSendOptions } from "./context";
import type { SceneConfig } from "./types";
import type { ActorLocationTarget } from "./ActorLocation";

export class SceneMessageHelper {
  constructor(private readonly ctx: SceneCallContext) {}

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

  many(sceneType: string): SceneConfig[] { return this.ctx.refs(sceneType); }

  byName(name: string): SceneConfig {
    const target = this.ctx.knownScenes.find((scene) => scene.name === name);
    if (!target) throw new RpcError(SystemErrCode.SceneNotFound, `scene not found: ${name}`);
    return target;
  }

  call<TReq extends IRequest, TResp extends IResponse>(
    target: SceneConfig,
    descriptor: RpcDescriptor<TReq, TResp>,
    request: TReq,
    options: SceneCallOptions = {},
  ): Promise<TResp> {
    return this.ctx.call(target, descriptor, request, options);
  }

  callOne<TReq extends IRequest, TResp extends IResponse>(
    sceneType: string,
    descriptor: RpcDescriptor<TReq, TResp>,
    request: TReq,
    options: SceneCallOptions = {},
  ): Promise<TResp> {
    return this.call(this.one(sceneType), descriptor, request, options);
  }

  async callOptionalOne<TReq extends IRequest, TResp extends IResponse>(
    sceneType: string,
    descriptor: RpcDescriptor<TReq, TResp>,
    request: TReq,
    options: SceneCallOptions = {},
  ): Promise<TResp | undefined> {
    const target = this.optionalOne(sceneType);
    return target ? this.call(target, descriptor, request, options) : undefined;
  }

  callActor<TReq extends IRequest, TResp extends IResponse>(
    target: ActorLocationTarget,
    descriptor: RpcDescriptor<TReq, TResp>,
    request: TReq,
    options: SceneCallOptions = {},
  ): Promise<TResp> {
    return this.ctx.callActor(target, descriptor, request, options);
  }

  send<TMessage extends IMessage>(
    target: SceneConfig,
    descriptor: MessageDescriptor<TMessage>,
    message: TMessage,
    options: SceneSendOptions = {},
  ): Promise<void> {
    return this.ctx.send(target, descriptor, message, options);
  }

  sendOne<TMessage extends IMessage>(
    sceneType: string,
    descriptor: MessageDescriptor<TMessage>,
    message: TMessage,
    options: SceneSendOptions = {},
  ): Promise<void> {
    return this.send(this.one(sceneType), descriptor, message, options);
  }

  sendActor<TMessage extends IMessage>(
    target: ActorLocationTarget,
    descriptor: MessageDescriptor<TMessage>,
    message: TMessage,
    options: SceneSendOptions = {},
  ): Promise<void> {
    return this.ctx.sendActor(target, descriptor, message, options);
  }
}
