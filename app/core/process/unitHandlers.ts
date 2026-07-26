import type { MaybePromise } from "../async";
import type {
  AnyMessageDescriptor,
  IMessage,
  MessageDescriptor,
} from "../protocol/message";
import type { ProtocolContext } from "../protocol/registry";
import type { AnyRpcDescriptor, RpcDescriptor } from "../protocol/rpc";
import type { Unit } from "../runtime/Unit";

type AnyUnit = Unit<any[]>;
type UnitClass<TUnit extends AnyUnit> = abstract new (...args: any[]) => TUnit;

export interface UnitMessageHandler<
  TUnit extends AnyUnit,
  TMessage extends IMessage,
> {
  handle(
    unit: TUnit,
    message: TMessage,
    context: ProtocolContext,
  ): MaybePromise<void>;
}

export interface UnitRpcHandler<TUnit extends AnyUnit, TReq, TResp> {
  handle(
    unit: TUnit,
    request: TReq,
    context: ProtocolContext,
  ): MaybePromise<TResp>;
}

type AnyUnitMessageHandlerCtor = new () => UnitMessageHandler<AnyUnit, IMessage>;
type AnyUnitRpcHandlerCtor = new () => UnitRpcHandler<AnyUnit, unknown, unknown>;

export interface UnitMessageHandlerBinding {
  unitCtor: UnitClass<AnyUnit>;
  descriptor: AnyMessageDescriptor;
  handlerCtor: AnyUnitMessageHandlerCtor;
}

export interface UnitRpcHandlerBinding {
  unitCtor: UnitClass<AnyUnit>;
  descriptor: AnyRpcDescriptor;
  handlerCtor: AnyUnitRpcHandlerCtor;
}

const messageHandlers: UnitMessageHandlerBinding[] = [];
const rpcHandlers: UnitRpcHandlerBinding[] = [];

/** 为指定 Unit 类型注册单向消息 Handler；消息会先按 InstanceId 进入该 Unit 的 mailbox。 / Registers a one-way handler for a Unit type; dispatch first enters that Unit's mailbox by InstanceId. */
export function unitMessageHandler<
  TUnit extends AnyUnit,
  TMessage extends IMessage,
>(
  unitCtor: UnitClass<TUnit>,
  descriptor: MessageDescriptor<TMessage>,
): (handlerCtor: new () => UnitMessageHandler<TUnit, TMessage>) => void {
  return (handlerCtor) => {
    assertUnique(messageHandlers, unitCtor, descriptor.msgcode, descriptor.name);
    messageHandlers.push({
      unitCtor: unitCtor as UnitClass<AnyUnit>,
      descriptor: descriptor as AnyMessageDescriptor,
      handlerCtor: handlerCtor as AnyUnitMessageHandlerCtor,
    });
  };
}

/** 为指定 Unit 类型注册 RPC Handler，并保留请求与响应的静态类型。 / Registers an RPC handler for a Unit type while preserving request and response types. */
export function unitRpcHandler<TUnit extends AnyUnit, TReq, TResp>(
  unitCtor: UnitClass<TUnit>,
  descriptor: RpcDescriptor<TReq, TResp>,
): (handlerCtor: new () => UnitRpcHandler<TUnit, TReq, TResp>) => void {
  return (handlerCtor) => {
    assertUnique(rpcHandlers, unitCtor, descriptor.requestCode, descriptor.name);
    rpcHandlers.push({
      unitCtor: unitCtor as UnitClass<AnyUnit>,
      descriptor: descriptor as AnyRpcDescriptor,
      handlerCtor: handlerCtor as AnyUnitRpcHandlerCtor,
    });
  };
}

/** 仅供 EntryScene 初始化协议路由使用。 / Used only while EntryScene initializes protocol routes. */
export function getUnitMessageHandlerBindings(): readonly UnitMessageHandlerBinding[] {
  return messageHandlers;
}

/** 仅供 EntryScene 初始化协议路由使用。 / Used only while EntryScene initializes protocol routes. */
export function getUnitRpcHandlerBindings(): readonly UnitRpcHandlerBinding[] {
  return rpcHandlers;
}

function assertUnique(
  bindings: readonly (UnitMessageHandlerBinding | UnitRpcHandlerBinding)[],
  unitCtor: UnitClass<AnyUnit>,
  msgcode: number,
  descriptorName: string,
): void {
  const duplicate = bindings.find((binding) => {
    const bindingCode = "msgcode" in binding.descriptor
      ? binding.descriptor.msgcode
      : binding.descriptor.requestCode;
    return binding.unitCtor === unitCtor && bindingCode === msgcode;
  });
  if (duplicate) {
    throw new Error(
      `duplicate Unit handler for ${unitCtor.name} msgcode ${msgcode}: ${descriptorName}`,
    );
  }
}
