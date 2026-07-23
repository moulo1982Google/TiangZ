import type { Codec } from "./Message";

export interface RpcDescriptor<TRequest, TResponse> {
  name: string;
  requestCode: number;
  responseCode: number;
  requestCodec: Codec<TRequest>;
  responseCodec: Codec<TResponse>;
  routing?: "direct" | "actor-location";
}

export function defineRpc<TRequest, TResponse>(
  descriptor: RpcDescriptor<TRequest, TResponse>,
): RpcDescriptor<TRequest, TResponse> {
  return descriptor;
}
