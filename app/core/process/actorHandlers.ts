import type { MaybePromise } from "../async";
import type {
  AnyMessageDescriptor,
  IMessage,
  MessageDescriptor,
} from "../protocol/message";
import type { ProtocolContext } from "../protocol/registry";
import type { AnyRpcDescriptor, RpcDescriptor } from "../protocol/rpc";
import type { Actor } from "../runtime";

type AnyActor = Actor<any[]>;
type ActorClass<TActor extends AnyActor> = abstract new (...args: any[]) => TActor;

export interface ActorMessageHandler<
  TActor extends AnyActor,
  TMessage extends IMessage,
> {
  handle(
    actor: TActor,
    message: TMessage,
    context: ProtocolContext,
  ): MaybePromise<void>;
}

export interface ActorRpcHandler<TActor extends AnyActor, TReq, TResp> {
  handle(
    actor: TActor,
    request: TReq,
    context: ProtocolContext,
  ): MaybePromise<TResp>;
}

type AnyActorMessageHandlerCtor = new () => ActorMessageHandler<AnyActor, IMessage>;
type AnyActorRpcHandlerCtor = new () => ActorRpcHandler<AnyActor, unknown, unknown>;

export interface ActorMessageHandlerBinding {
  actorCtor: ActorClass<AnyActor>;
  descriptor: AnyMessageDescriptor;
  handlerCtor: AnyActorMessageHandlerCtor;
}

export interface ActorRpcHandlerBinding {
  actorCtor: ActorClass<AnyActor>;
  descriptor: AnyRpcDescriptor;
  handlerCtor: AnyActorRpcHandlerCtor;
}

const messageHandlers: ActorMessageHandlerBinding[] = [];
const rpcHandlers: ActorRpcHandlerBinding[] = [];

export function actorMessageHandler<
  TActor extends AnyActor,
  TMessage extends IMessage,
>(
  actorCtor: ActorClass<TActor>,
  descriptor: MessageDescriptor<TMessage>,
): (handlerCtor: new () => ActorMessageHandler<TActor, TMessage>) => void {
  return (handlerCtor) => {
    assertUnique(messageHandlers, actorCtor, descriptor.msgcode, descriptor.name);
    messageHandlers.push({
      actorCtor: actorCtor as ActorClass<AnyActor>,
      descriptor: descriptor as AnyMessageDescriptor,
      handlerCtor: handlerCtor as AnyActorMessageHandlerCtor,
    });
  };
}

export function actorRpcHandler<TActor extends AnyActor, TReq, TResp>(
  actorCtor: ActorClass<TActor>,
  descriptor: RpcDescriptor<TReq, TResp>,
): (handlerCtor: new () => ActorRpcHandler<TActor, TReq, TResp>) => void {
  return (handlerCtor) => {
    assertUnique(rpcHandlers, actorCtor, descriptor.requestCode, descriptor.name);
    rpcHandlers.push({
      actorCtor: actorCtor as ActorClass<AnyActor>,
      descriptor: descriptor as AnyRpcDescriptor,
      handlerCtor: handlerCtor as AnyActorRpcHandlerCtor,
    });
  };
}

export function getActorMessageHandlerBindings(): readonly ActorMessageHandlerBinding[] {
  return messageHandlers;
}

export function getActorRpcHandlerBindings(): readonly ActorRpcHandlerBinding[] {
  return rpcHandlers;
}

function assertUnique(
  bindings: readonly (ActorMessageHandlerBinding | ActorRpcHandlerBinding)[],
  actorCtor: ActorClass<AnyActor>,
  msgcode: number,
  descriptorName: string,
): void {
  const duplicate = bindings.find((binding) => {
    const bindingCode = "msgcode" in binding.descriptor
      ? binding.descriptor.msgcode
      : binding.descriptor.requestCode;
    return binding.actorCtor === actorCtor && bindingCode === msgcode;
  });
  if (duplicate) {
    throw new Error(
      `duplicate actor handler for ${actorCtor.name} msgcode ${msgcode}: ${descriptorName}`,
    );
  }
}
