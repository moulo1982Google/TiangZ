import type { MaybePromise } from "../async";
import type {
  AnyMessageDescriptor,
  IMessage,
  MessageDescriptor,
} from "../protocol/message";
import type { ProtocolContext } from "../protocol/registry";
import type {
  AnyRpcDescriptor,
  RpcDescriptor,
} from "../protocol/rpc";
import type { EntryScene } from "./types";
import { HotfixBindingStore } from "../hotReload/HotfixSystem";

type SceneClass<TScene extends EntryScene> = new (...args: any[]) => TScene;

export interface SceneMessageHandler<
  TScene extends EntryScene,
  TMessage extends IMessage,
> {
  handle(
    scene: TScene,
    message: TMessage,
    context: ProtocolContext,
  ): MaybePromise<void>;
}

export interface SceneRpcHandler<TScene extends EntryScene, TReq, TResp> {
  handle(
    scene: TScene,
    request: TReq,
    context: ProtocolContext,
  ): MaybePromise<TResp>;
}

type AnySceneMessageHandlerCtor = new () => SceneMessageHandler<
  EntryScene,
  IMessage
>;
type AnySceneRpcHandlerCtor = new () => SceneRpcHandler<
  EntryScene,
  unknown,
  unknown
>;

export interface SceneMessageHandlerBinding {
  sceneCtor: Function;
  descriptor: AnyMessageDescriptor;
  handlerCtor: AnySceneMessageHandlerCtor;
}

export interface SceneRpcHandlerBinding {
  sceneCtor: Function;
  descriptor: AnyRpcDescriptor;
  handlerCtor: AnySceneRpcHandlerCtor;
}

const messageHandlers = new HotfixBindingStore<SceneMessageHandlerBinding>("scene-message");
const rpcHandlers = new HotfixBindingStore<SceneRpcHandlerBinding>("scene-rpc");

/** 在模块加载时注册外部单向 Scene Handler 类。 / Registers an external one-way Scene handler class at module load time. */
export function messageHandler<
  TScene extends EntryScene,
  TMessage extends IMessage,
>(
  sceneCtor: SceneClass<TScene>,
  descriptor: MessageDescriptor<TMessage>,
): (
  handlerCtor: new () => SceneMessageHandler<TScene, TMessage>,
) => void {
  return (handlerCtor) => {
    messageHandlers.Register(bindingKey(sceneCtor, descriptor.msgcode), {
      sceneCtor,
      descriptor: descriptor as AnyMessageDescriptor,
      handlerCtor: handlerCtor as AnySceneMessageHandlerCtor,
    });
  };
}

/** 使用生成描述符注册外部 Scene RPC Handler 类。 / Registers an external Scene RPC handler class with a generated descriptor. */
export function rpcHandler<TScene extends EntryScene, TReq, TResp>(
  sceneCtor: SceneClass<TScene>,
  descriptor: RpcDescriptor<TReq, TResp>,
): (
  handlerCtor: new () => SceneRpcHandler<TScene, TReq, TResp>,
) => void {
  return (handlerCtor) => {
    rpcHandlers.Register(bindingKey(sceneCtor, descriptor.requestCode), {
      sceneCtor,
      descriptor: descriptor as AnyRpcDescriptor,
      handlerCtor: handlerCtor as AnySceneRpcHandlerCtor,
    });
  };
}

/** 返回 EntryScene 启动时使用的不可变消息元数据。 / Returns immutable message metadata consumed during EntryScene bootstrap. */
export function getSceneMessageHandlerBindings(
  sceneCtor: Function,
): readonly SceneMessageHandlerBinding[] {
  return messageHandlers.Values().filter((binding) => binding.sceneCtor === sceneCtor);
}

/** 返回 EntryScene 启动时使用的不可变 RPC 元数据。 / Returns immutable RPC metadata consumed during EntryScene bootstrap. */
export function getSceneRpcHandlerBindings(
  sceneCtor: Function,
): readonly SceneRpcHandlerBinding[] {
  return rpcHandlers.Values().filter((binding) => binding.sceneCtor === sceneCtor);
}

function bindingKey(sceneCtor: Function, msgcode: number): string {
  return `${sceneCtor.name}:${msgcode}`;
}
