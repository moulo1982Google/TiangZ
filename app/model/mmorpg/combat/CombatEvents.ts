import {
  SystemErrCode,
  defineSyncEvent,
  defineVetoEvent,
  type Unit,
} from "../../../core/public";
import type { DamageRequest, DamageResult } from "./CombatComponent";

/**
 * 扣血和护盾消耗前的同步只读伤害尝试。监听器可返回非零的不透明规避原因，但不得修改Unit或请求。
 * Synchronous read-only damage attempt before health or absorbers mutate. A
 * listener may return a non-zero opaque prevention reason, but must not mutate
 * the Unit or request.
 */
export interface BeforeDamageEvent {
  readonly target: Unit<any[]>;
  readonly request: Readonly<DamageRequest>;
  readonly attemptSequence: number;
}

/**
 * 已提交伤害的同步事实。监听器可以追加领域效果，但不能回滚已经写入的生命值。
 * Synchronous fact emitted after damage is committed. Listeners may append
 * domain effects, but cannot roll back the health mutation represented here.
 */
export interface DamageResolvedEvent {
  readonly target: Unit<any[]>;
  readonly request: Readonly<DamageRequest>;
  readonly result: Readonly<DamageResult>;
}

export const CombatEvents = {
  /** 仅当DamageRequest显式允许规避时检查；默认伤害路径不付出扩展链成本。 / Checked only for explicitly preventable requests, keeping the default damage path free of extension-chain work. */
  BeforeDamage: defineVetoEvent<BeforeDamageEvent, number>(
    "Combat.BeforeDamage",
    SystemErrCode.Success,
  ),
  DamageResolved: defineSyncEvent<DamageResolvedEvent>("Combat.DamageResolved"),
  /** 否决已经确定后的可追加事实，不代表扣血。 / Post-veto fact that permits follow-up effects but represents no health mutation. */
  DamagePrevented: defineSyncEvent<DamageResolvedEvent>("Combat.DamagePrevented"),
} as const;
