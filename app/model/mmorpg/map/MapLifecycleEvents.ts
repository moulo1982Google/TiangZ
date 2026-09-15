import { defineVetoEvent, SystemErrCode } from "../../../core/public";

/** 动态地图回收前的同步只读上下文；模块可用私有非零原因阻止未决结算丢失。 / Read-only disposal context lets modules protect unresolved settlement with opaque nonzero reasons. */
export interface BeforeMapDisposeEvent {
  readonly mapInstanceId:bigint;
  readonly mapConfigId:number;
}
export const MapLifecycleEvents = {
  /** 只决定是否可回收，不在监听器中执行事务或异步清理。 / Admission only: listeners must not transact, mutate, or perform asynchronous cleanup. */
  BeforeDispose:defineVetoEvent<BeforeMapDisposeEvent,number>("Map.BeforeDispose",SystemErrCode.Success),
} as const;
