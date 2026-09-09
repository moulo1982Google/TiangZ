import { Component, component, RpcError, SystemErrCode } from "../../../core/public";

export interface OwnedUnitActionHandler {
  InvokeUnitAction(action: string, version: number, payload: Uint8Array, operationId: string): Promise<Uint8Array> | Uint8Array;
}

const MAX_ACTION_BYTES = 65_536;
const NAMESPACE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/;
const ACTION = /^[a-z][a-z0-9-]{0,63}$/;
const OPERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;

/** 玩家自有组件的有界操作表；只保存组件引用，调用时解析当前方法。 / Bounded action registry for owned components; resolves the current method at invocation. */
@component()
export class UnitActionComponent extends Component {
  private readonly handlers = new Map<string, Component<any[]> & OwnedUnitActionHandler>();

  /** 只接受同一拥有者的存活组件，拒绝覆盖已登记空间。 / Accepts live components of the same owner and rejects namespace replacement. */
  Register(namespace: string, handler: Component<any[]> & OwnedUnitActionHandler): void {
    if (!NAMESPACE.test(namespace) || namespace.length > 128) throw new Error("invalid action namespace");
    if (this.IsDisposed || handler.IsDisposed) throw new Error("action component disposed");
    if (handler.Parent !== this.Parent) throw new Error("action handler owner mismatch");
    if (typeof handler.InvokeUnitAction !== "function") throw new Error("action handler method missing");
    if (this.handlers.has(namespace)) throw new Error(`action namespace already registered: ${namespace}`);
    this.handlers.set(namespace, handler);
  }

  /** 由玩家 mailbox 调用；信封检查不代替业务授权、事务和幂等。 / Invoked from the player mailbox; envelope validation does not replace business authorization, transactions or idempotency. */
  async Invoke(namespace: string, action: string, version: number, operationId: string, payload: Uint8Array): Promise<Uint8Array> {
    if (namespace.length > 128 || !NAMESPACE.test(namespace) || !ACTION.test(action)
      || !Number.isSafeInteger(version) || version < 1 || version > 0xffff_ffff
      || !OPERATION.test(operationId) || !(payload instanceof Uint8Array) || payload.length > MAX_ACTION_BYTES) {
      throw new RpcError(SystemErrCode.DecodeFailed, "invalid unit action envelope");
    }
    const handler = this.handlers.get(namespace);
    if (!handler) throw new RpcError(SystemErrCode.HandlerNotFound, `action namespace not registered: ${namespace}`);
    if (this.IsDisposed || handler.IsDisposed || handler.Parent !== this.Parent) {
      throw new RpcError(SystemErrCode.HandlerNotFound, "unit action component disposed or owner changed");
    }
    const result = await handler.InvokeUnitAction(action, version, payload.slice(), operationId);
    if (!(result instanceof Uint8Array) || result.length > MAX_ACTION_BYTES) {
      throw new RpcError(SystemErrCode.HandlerFailed, "invalid unit action response");
    }
    return result.slice();
  }

  /** 随玩家销毁释放引用，不能跨生命周期复用登记。 / Releases owned references on disposal; registration never crosses lifetimes. */
  protected override OnDestroy(): void {
    this.handlers.clear();
  }
}
