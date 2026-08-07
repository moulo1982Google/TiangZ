import type { MaybePromise } from "../async";
import type {
  AnyMessageDescriptor,
  IMessage,
  MessageDescriptor,
} from "../protocol/message";
import type { ProtocolContext } from "../protocol/registry";
import type { AnyRpcDescriptor, RpcDescriptor } from "../protocol/rpc";
import { ActorUnit, type Unit } from "../runtime/Unit";
import { getActorOptions } from "../runtime/metadata";
import { HotfixBindingStore } from "../hotReload/HotfixSystem";

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

const messageHandlers = new HotfixBindingStore<UnitMessageHandlerBinding>("unit-message");
const rpcHandlers = new HotfixBindingStore<UnitRpcHandlerBinding>("unit-rpc");

/** 为指定 Unit 类型注册单向消息 Handler；消息会先按 InstanceId 进入该 Unit 的 mailbox。 / Registers a one-way handler for a Unit type; dispatch first enters that Unit's mailbox by InstanceId. */
export function unitMessageHandler<
  TUnit extends AnyUnit,
  TMessage extends IMessage,
>(
  unitCtor: UnitClass<TUnit>,
  descriptor: MessageDescriptor<TMessage>,
): (handlerCtor: new () => UnitMessageHandler<TUnit, TMessage>) => void {
  requireRoutableUnit(unitCtor);
  return (handlerCtor) => {
    messageHandlers.Register(bindingKey(unitCtor, descriptor.msgcode), {
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
  requireRoutableUnit(unitCtor);
  return (handlerCtor) => {
    rpcHandlers.Register(bindingKey(unitCtor, descriptor.requestCode), {
      unitCtor: unitCtor as UnitClass<AnyUnit>,
      descriptor: descriptor as AnyRpcDescriptor,
      handlerCtor: handlerCtor as AnyUnitRpcHandlerCtor,
    });
  };
}

/** 仅供 EntryScene 初始化协议路由使用。 / Used only while EntryScene initializes protocol routes. */
export function getUnitMessageHandlerBindings(): readonly UnitMessageHandlerBinding[] {
  return messageHandlers.Values();
}

/** 仅供 EntryScene 初始化协议路由使用。 / Used only while EntryScene initializes protocol routes. */
export function getUnitRpcHandlerBindings(): readonly UnitRpcHandlerBinding[] {
  return rpcHandlers.Values();
}

function bindingKey(unitCtor: UnitClass<AnyUnit>, msgcode: number): string {
  return `${unitCtor.name}:${msgcode}`;
}

/** Unit Handler只能绑定显式ActorUnit；普通Unit没有InstanceId路由入口。 / Unit Handlers may bind only explicit ActorUnits because plain Units have no InstanceId route. */
function requireRoutableUnit(unitCtor: UnitClass<AnyUnit>): void {
  if (!(unitCtor.prototype instanceof ActorUnit) || !getActorOptions(unitCtor)) {
    throw new Error(
      `Unit Handler target must extend ActorUnit and declare @actor: ${unitCtor.name}`,
    );
  }
}
