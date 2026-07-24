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

/** 保留生成 RPC 描述符的泛型类型，不增加运行时行为。 / Preserves a generated RPC descriptor's generic types without adding runtime behavior. */
export function defineRpc<TReq, TResp>(
  descriptor: RpcDescriptor<TReq, TResp>,
): RpcDescriptor<TReq, TResp> {
  return descriptor;
}

/** 类模块加载时记录方法绑定，但不调用 Handler。 / Records a method binding while its class module loads; it does not invoke the handler. */
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

/** 返回注册表启动时某个 Scene 构造器对应的装饰器元数据。 / Returns decorator metadata for one Scene constructor during registry bootstrap. */
export function getRpcBindings(ctor: Function): RpcBinding[] {
  return rpcBindings.get(ctor) ?? [];
}

/** 幂等加入生成描述符，供路由校验和自动注册使用。 / Adds generated descriptors idempotently for routing validation and automatic registration. */
export function registerKnownRpcs(descriptors: readonly AnyRpcDescriptor[]): void {
  for (const descriptor of descriptors) {
    const key = `${descriptor.requestCode}:${descriptor.responseCode}:${descriptor.name}`;
    if (knownRpcKeys.has(key)) continue;
    knownRpcKeys.add(key);
    knownRpcDescriptors.push(descriptor);
  }
}

/** 暴露只读元数据；业务代码应使用具名的生成协议对象。 / Exposes read-only metadata; business code should use named generated protocol objects. */
export function getKnownRpcDescriptors(): readonly AnyRpcDescriptor[] {
  return knownRpcDescriptors;
}
