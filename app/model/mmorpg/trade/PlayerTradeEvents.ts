import { defineSyncEvent, defineVetoEvent, SystemErrCode } from "../../../core/public";
import type { PlayerTradeSnapshot } from "../../../generated/model/server/demo/protocol/messages";
import type { PlayerUnit } from "../map/PlayerUnit";
import type { ItemSnapshot } from "../../../generated/model/server/demo/protocol/messages";

export interface PlayerTradeCommitParticipant {
  readonly player: PlayerUnit;
  readonly baseGold: bigint;
  readonly gold: bigint;
  readonly baseItems: readonly ItemSnapshot[];
  readonly nextItems: readonly ItemSnapshot[];
}

/** 双方邮箱内、首次持久化前的只读计划；监听器不得写库或修改实体。 / Read-only plan inside both mailboxes before first persistence; listeners must not mutate entities or storage. */
export interface BeforePlayerTradeCommitEvent {
  readonly tradeId: string;
  readonly requester: PlayerTradeCommitParticipant;
  readonly target: PlayerTradeCommitParticipant;
}

export const PlayerTradeEvents = {
  /** 给表现模块的通知事实；监听器失败不能回滚交易。 / Presentation notification; observer failure cannot roll back a trade. */
  Notification: defineSyncEvent<PlayerTradeNotificationEvent>("PlayerTrade.Notification"),
  /** 模块可同步否决首次交易计划；已提交回执恢复不重新执行业务准入。 / Modules may veto a first plan synchronously; committed receipt recovery does not repeat admission. */
  BeforeCommit: defineVetoEvent<BeforePlayerTradeCommitEvent, number>("PlayerTrade.BeforeCommit", SystemErrCode.Success),
} as const;

export interface PlayerTradeNotificationEvent {
  readonly player: PlayerUnit;
  readonly kind: "invite" | "changed" | "closed";
  readonly tradeId: string;
  readonly trade?: PlayerTradeSnapshot;
  readonly committed: boolean;
  readonly reason: number;
}
