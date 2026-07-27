import type { MaybePromise } from "../async";
import type { IMessage, MessageDescriptor } from "../protocol/message";
import type { ProtocolContext } from "../protocol/registry";
import type { AnyRpcDescriptor, RpcDescriptor } from "../protocol/rpc";
import type { AnyMessageDescriptor } from "../protocol/message";
import type { Session } from "../runtime/Session";
import type { EntryScene } from "./types";
import { HotfixBindingStore } from "../hotReload/HotfixSystem";

type SceneClass<TScene extends EntryScene> = new (...args: any[]) => TScene;

export interface SessionMessageHandler<
  TScene extends EntryScene,
  TSession extends Session<any[]>,
  TMessage extends IMessage,
> {
  handle(
    scene: TScene,
    session: TSession,
    message: TMessage,
    context: ProtocolContext,
  ): MaybePromise<void>;
}

export interface SessionRpcHandler<
  TScene extends EntryScene,
  TSession extends Session<any[]>,
  TReq,
  TResp,
> {
  handle(
    scene: TScene,
    session: TSession,
    request: TReq,
    context: ProtocolContext,
  ): MaybePromise<TResp>;
}

type AnySessionMessageHandlerCtor = new () => SessionMessageHandler<EntryScene, Session<any[]>, IMessage>;
type AnySessionRpcHandlerCtor = new () => SessionRpcHandler<EntryScene, Session<any[]>, unknown, unknown>;

export interface SessionMessageHandlerBinding {
  sceneCtor: Function;
  descriptor: AnyMessageDescriptor;
  handlerCtor: AnySessionMessageHandlerCtor;
}

export interface SessionRpcHandlerBinding {
  sceneCtor: Function;
  descriptor: AnyRpcDescriptor;
  handlerCtor: AnySessionRpcHandlerCtor;
}

const messageHandlers = new HotfixBindingStore<SessionMessageHandlerBinding>("session-message");
const rpcHandlers = new HotfixBindingStore<SessionRpcHandlerBinding>("session-rpc");

/** 为指定 Scene 注册连接 Session 的单向消息 Handler。 / Registers a one-way connection-Session handler for one Scene. */
export function sessionMessageHandler<
  TScene extends EntryScene,
  TSession extends Session<any[]>,
  TMessage extends IMessage,
>(
  sceneCtor: SceneClass<TScene>,
  descriptor: MessageDescriptor<TMessage>,
): (handlerCtor: new () => SessionMessageHandler<TScene, TSession, TMessage>) => void {
  return (handlerCtor) => {
    messageHandlers.Register(bindingKey(sceneCtor, descriptor.msgcode), {
      sceneCtor,
      descriptor: descriptor as AnyMessageDescriptor,
      handlerCtor: handlerCtor as AnySessionMessageHandlerCtor,
    });
  };
}

/** 为指定 Scene 注册连接 Session 的 RPC Handler。 / Registers a connection-Session RPC handler for one Scene. */
export function sessionRpcHandler<
  TScene extends EntryScene,
  TSession extends Session<any[]>,
  TReq,
  TResp,
>(
  sceneCtor: SceneClass<TScene>,
  descriptor: RpcDescriptor<TReq, TResp>,
): (handlerCtor: new () => SessionRpcHandler<TScene, TSession, TReq, TResp>) => void {
  return (handlerCtor) => {
    rpcHandlers.Register(bindingKey(sceneCtor, descriptor.requestCode), {
      sceneCtor,
      descriptor: descriptor as AnyRpcDescriptor,
      handlerCtor: handlerCtor as AnySessionRpcHandlerCtor,
    });
  };
}

export function getSessionMessageHandlerBindings(sceneCtor: Function): readonly SessionMessageHandlerBinding[] {
  return messageHandlers.Values().filter((binding) => binding.sceneCtor === sceneCtor);
}

export function getSessionRpcHandlerBindings(sceneCtor: Function): readonly SessionRpcHandlerBinding[] {
  return rpcHandlers.Values().filter((binding) => binding.sceneCtor === sceneCtor);
}

function bindingKey(sceneCtor: Function, msgcode: number): string {
  return `${sceneCtor.name}:${msgcode}`;
}
