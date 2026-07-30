export interface IMessage {}

export interface Codec<T> {
  encode(value: T): Uint8Array;
  decode(payload: Uint8Array): T;
}

export interface MessageDescriptor<TMessage extends IMessage> {
  name: string;
  msgcode: number;
  codec: Codec<TMessage>;
  routing?: "direct" | "actor-location";
}

export function defineMessage<TMessage extends IMessage>(
  descriptor: MessageDescriptor<TMessage>,
): MessageDescriptor<TMessage> {
  return descriptor;
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
