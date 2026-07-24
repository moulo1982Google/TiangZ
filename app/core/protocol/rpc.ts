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

/** Preserves a generated RPC descriptor's generic types without adding runtime behavior. */
export function defineRpc<TReq, TResp>(
  descriptor: RpcDescriptor<TReq, TResp>,
): RpcDescriptor<TReq, TResp> {
  return descriptor;
}

/** Records a method binding while its class module loads; it does not invoke the handler. */
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

/** Returns decorator metadata for one Scene constructor during registry bootstrap. */
export function getRpcBindings(ctor: Function): RpcBinding[] {
  return rpcBindings.get(ctor) ?? [];
}

/** Adds generated descriptors idempotently for routing validation and automatic registration. */
export function registerKnownRpcs(descriptors: readonly AnyRpcDescriptor[]): void {
  for (const descriptor of descriptors) {
    const key = `${descriptor.requestCode}:${descriptor.responseCode}:${descriptor.name}`;
    if (knownRpcKeys.has(key)) continue;
    knownRpcKeys.add(key);
    knownRpcDescriptors.push(descriptor);
  }
}

/** Exposes read-only metadata; business code should use named generated protocol objects. */
export function getKnownRpcDescriptors(): readonly AnyRpcDescriptor[] {
  return knownRpcDescriptors;
}
