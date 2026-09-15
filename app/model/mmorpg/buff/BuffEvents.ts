import { defineSyncEvent, defineVetoEvent, SystemErrCode, type Unit } from "../../../core/public";
import type { Buff } from "./Buff";
export interface BuffTickEvent { readonly buff: Buff; readonly target: Unit<any[]>; }
export interface BuffTickResolvedEvent extends BuffTickEvent { readonly restoredHealing: bigint; }
/** 周期效果前只读否决及提交事实；被否决的跳数不补发。 / Read-only periodic veto and committed fact; skipped ticks are not replayed. */
export const BuffEvents = {
  BeforeTick: defineVetoEvent<BuffTickEvent, number>("Buff.BeforeTick",SystemErrCode.Success),
  TickResolved: defineSyncEvent<BuffTickResolvedEvent>("Buff.TickResolved"),
} as const;
