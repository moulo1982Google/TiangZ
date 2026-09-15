import { Component, component, type HostDbProxyRecords } from "../../../core/public";
import type { PartyMemberSnapshot, MM2S_PartyAction, S2MM_PartyAction } from "../../../generated/model/server/demo/protocol/messages";

/** 模块配置的会话队伍预算和过期时间，不包含具体玩法知识。 / Module-owned session-party limits without game-specific rules. */
export interface PartyDirectoryPolicy {
  readonly persistent?: boolean;
  readonly maxMembers: number;
  readonly invitationMs: number;
  readonly offlineRetentionMs: number;
}
export interface PartyPresence {
  member: PartyMemberSnapshot;
  lastSeenAt: number;
}
export interface PartyRecord {
  id: bigint;
  leaderId: bigint;
  revision: number;
  members: bigint[];
}
export interface PartyInvitation {
  id: string;
  partyId: bigint;
  recipientId: bigint;
  expiresAt: number;
}
export interface PartyDirectoryDomain {
  policy: Readonly<PartyDirectoryPolicy>;
  persistedRevision?: bigint;
  parties: Map<bigint, PartyRecord>;
  membership: Map<bigint, bigint>;
  presence: Map<bigint, PartyPresence>;
  invitations: Map<string, PartyInvitation>;
  receipts: Map<string, {fingerprint: string; expiresAt: number}>;
}

/** MapManager拥有的队伍会话；多游戏namespace互不串队。 / MapManager-owned party sessions isolated by game namespace. */
@component()
export class PartyDirectoryComponent extends Component {
  protected records: HostDbProxyRecords | undefined = undefined;
  protected readonly domains = new Map<string, PartyDirectoryDomain>();
}
export interface PartyDirectoryComponent {
  /** Factory中注册独立策略；同namespace不可覆盖。 / Registers an immutable namespace policy at the Factory boundary. */
  Register(namespace: string, policy: PartyDirectoryPolicy): void;
  /** 单线程同步完成版本检查与成员变更；调用前完成异步身份验证。 / Atomically validates revisions and mutates membership after asynchronous authentication. */
  Act(request: S2MM_PartyAction): MM2S_PartyAction;
  /** 持久模式通过场景锁和 DBProxy CAS 提交，成功后才发布内存状态。 / Durable transitions commit under scene lock and DBProxy CAS before publishing memory. */
  Execute(request: S2MM_PartyAction): Promise<MM2S_PartyAction>;
}
