export interface IMessage {}

export interface Codec<T> {
  encode(value: T): Uint8Array;
  decode(payload: Uint8Array): T;
}

export interface MessageDescriptor<TMessage extends IMessage> {
  name: string;
  msgcode: number;
  codec: Codec<TMessage>;
  routing?: MessageRouting;
}

export type MessageRouting = "direct" | "actor-location";

export type AnyMessageDescriptor = MessageDescriptor<any>;

export interface MessageBinding {
  method: string;
  descriptor: AnyMessageDescriptor;
}

const messageBindings = new WeakMap<Function, MessageBinding[]>();
const knownMessageDescriptors: AnyMessageDescriptor[] = [];
const knownMessageKeys = new Set<string>();

/** 保留生成消息描述符的 payload 类型，不增加运行时包装。 / Preserves a generated message descriptor's payload type without runtime wrapping. */
export function defineMessage<TMessage extends IMessage>(
  descriptor: MessageDescriptor<TMessage>,
): MessageDescriptor<TMessage> {
  return descriptor;
}

/** 类定义求值时记录单向 Handler 绑定，但不调用 Handler。 / Records a one-way handler binding when its class definition is evaluated. */
export function message<TMessage extends IMessage>(
  descriptor: MessageDescriptor<TMessage>,
): MethodDecorator {
  return (target, propertyKey) => {
    const ctor = target.constructor;
    const bindings = messageBindings.get(ctor) ?? [];
    bindings.push({
      method: String(propertyKey),
      descriptor: descriptor as AnyMessageDescriptor,
    });
    messageBindings.set(ctor, bindings);
  };
}

/** 返回运行时安装 Handler 所需的装饰器元数据。 / Returns decorator metadata for runtime handler installation. */
export function getMessageBindings(ctor: Function): MessageBinding[] {
  return messageBindings.get(ctor) ?? [];
}

/** 幂等加入生成消息描述符，供路由校验使用。 / Adds generated message descriptors idempotently for routing validation. */
export function registerKnownMessages(
  descriptors: readonly AnyMessageDescriptor[],
): void {
  for (const descriptor of descriptors) {
    const key = `${descriptor.msgcode}:${descriptor.name}`;
    if (knownMessageKeys.has(key)) continue;
    knownMessageKeys.add(key);
    knownMessageDescriptors.push(descriptor);
  }
}

/** 以只读框架元数据形式返回生成描述符。 / Returns generated descriptors as read-only framework metadata. */
export function getKnownMessageDescriptors(): readonly AnyMessageDescriptor[] {
  return knownMessageDescriptors;
}

export interface IRequest extends IMessage {
  rpcId?: number;
}

export interface IResponse extends IMessage {
  rpcId?: number;
  error?: number;
  message?: string;
}

export interface IActorMessage extends IMessage {}

export interface IActorRequest extends IRequest {}

export interface IActorResponse extends IResponse {}

export interface IActorLocationMessage extends IActorMessage {}

export interface IActorLocationRequest extends IActorRequest {}

export interface IActorLocationResponse extends IActorResponse {}
