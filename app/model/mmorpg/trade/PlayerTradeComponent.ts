import { Component, component, lifecycle } from "../../../core/public";
import type {
  C2M_UpdatePlayerTradeOffer,
  M2C_ConfirmPlayerTrade,
  PlayerTradeSnapshot,
} from "../../../generated/model/server/demo/protocol/messages";
import type { PlayerUnit } from "../map/PlayerUnit";

export const PlayerTradePhase = {
  Invited: 1,
  Open: 2,
  Committing: 3,
  Closed: 4,
} as const;

export type PlayerTradePhaseValue = typeof PlayerTradePhase[keyof typeof PlayerTradePhase];

export const PlayerTradeCloseReason = {
  Cancelled: 1,
  Rejected: 2,
  TimedOut: 3,
  PlayerLeft: 4,
  Committed: 5,
  Conflict: 6,
} as const;

export interface PlayerTradeOfferState {
  gold: bigint;
  items: readonly {
    readonly itemId: bigint;
    readonly itemConfigId: number;
    readonly count: number;
  }[];
  confirmed: boolean;
}

export interface PlayerTradeSession {
  readonly tradeId: string;
  readonly operationId: string;
  readonly requesterUnitId: number;
  readonly requesterCharacterId: bigint;
  readonly targetUnitId: number;
  readonly targetCharacterId: bigint;
  phase: PlayerTradePhaseValue;
  expireAtMs: number;
  readonly requesterOffer: PlayerTradeOfferState;
  readonly targetOffer: PlayerTradeOfferState;
  commitPayload?: Uint8Array;
}

export interface PlayerTradeComponent {
  Request(requester: PlayerUnit, targetUnitId: number): Promise<PlayerTradeSnapshot>;
  Respond(target: PlayerUnit, tradeId: string, accept: boolean): Promise<PlayerTradeSnapshot>;
  UpdateOffer(player: PlayerUnit, request: C2M_UpdatePlayerTradeOffer): Promise<PlayerTradeSnapshot>;
  Confirm(player: PlayerUnit, tradeId: string): Promise<M2C_ConfirmPlayerTrade>;
  Cancel(player: PlayerUnit, tradeId: string): Promise<void>;
  RequireCanLeave(player: PlayerUnit): void;
  PlayerLeaving(player: PlayerUnit): void;
}

/**
 * 地图级玩家交易协调器只保存邀请、报价和确认等临时状态；金币、Item Entity与revision仍归PlayerUnit组件。
 * 会话不得持久化，也不得跨地图迁移。最终交换必须通过PlayerPersistenceComponent的多记录事务提交。
 *
 * Map-local player trade coordinator storing only ephemeral invitation, offer,
 * and confirmation state. Currency, Item Entities, and revisions remain owned
 * by PlayerUnit components. Sessions never persist or migrate; final exchange
 * must use PlayerPersistenceComponent's multi-record transaction.
 */
@component()
@lifecycle({ destroy: true })
export class PlayerTradeComponent extends Component {
  protected readonly sessions = new Map<string, PlayerTradeSession>();
  protected readonly tradeIdByCharacterId = new Map<bigint, string>();
  /** 只防止两个PlayerUnit mailbox同时启动同一提交；不得把Promise或Handler闭包存入会话。 / Prevents two PlayerUnit mailboxes from starting the same commit; never stores Promises or Handler closures in a session. */
  protected readonly activeCommits = new Set<string>();
}
