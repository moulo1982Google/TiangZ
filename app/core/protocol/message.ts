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

export function defineMessage<TMessage extends IMessage>(
  descriptor: MessageDescriptor<TMessage>,
): MessageDescriptor<TMessage> {
  return descriptor;
}

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

export function getMessageBindings(ctor: Function): MessageBinding[] {
  return messageBindings.get(ctor) ?? [];
}

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

export interface ISocialMessage extends IActorMessage {}
 
export interface ISocialRequest extends IActorRequest {}

export interface ISocialResponse extends IActorResponse {}

export interface IRankMessage extends IActorMessage {}

export interface IRankRequest extends IActorRequest {}

export interface IRankResponse extends IActorResponse {}
