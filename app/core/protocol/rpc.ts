import type { Codec } from "./message";

export interface RpcDescriptor<TReq, TResp> {
  name: string;
  requestCode: number;
  responseCode: number;
  requestCodec: Codec<TReq>;
  responseCodec: Codec<TResp>;
  routing?: RpcRouting;
}

export type RpcRouting = "direct" | "actor-location";

export type AnyRpcDescriptor = RpcDescriptor<any, any>;

export interface RpcBinding {
  method: string;
  descriptor: AnyRpcDescriptor;
}

const rpcBindings = new WeakMap<Function, RpcBinding[]>();
const knownRpcDescriptors: AnyRpcDescriptor[] = [];
const knownRpcKeys = new Set<string>();

export function defineRpc<TReq, TResp>(
  descriptor: RpcDescriptor<TReq, TResp>,
): RpcDescriptor<TReq, TResp> {
  return descriptor;
}

export function rpc<TReq, TResp>(
  descriptor: RpcDescriptor<TReq, TResp>,
): MethodDecorator {
  return (target, propertyKey) => {
    const ctor = target.constructor;
    const bindings = rpcBindings.get(ctor) ?? [];
    bindings.push({
      method: String(propertyKey),
      descriptor: descriptor as AnyRpcDescriptor,
    });
    rpcBindings.set(ctor, bindings);
  };
}

export function getRpcBindings(ctor: Function): RpcBinding[] {
  return rpcBindings.get(ctor) ?? [];
}

export function registerKnownRpcs(descriptors: readonly AnyRpcDescriptor[]): void {
  for (const descriptor of descriptors) {
    const key = `${descriptor.requestCode}:${descriptor.responseCode}:${descriptor.name}`;
    if (knownRpcKeys.has(key)) continue;
    knownRpcKeys.add(key);
    knownRpcDescriptors.push(descriptor);
  }
}

export function getKnownRpcDescriptors(): readonly AnyRpcDescriptor[] {
  return knownRpcDescriptors;
}
