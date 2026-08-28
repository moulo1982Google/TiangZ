import { Component, component, transferable, type ITransfer } from "../../../core/public";
import { BuffComponent } from "../buff/BuffComponent";
import { ItemComponent } from "../item/ItemComponent";
import type { PlayerUnit } from "../map/PlayerUnit";
import { ProgressionComponent } from "../progression/ProgressionComponent";
import { QuestComponent } from "../quest/QuestComponent";
import { SkillComponent } from "../skill/SkillComponent";
import { EncodePlayerDomainData, ProjectPlayerDomainData } from "./PlayerPersistenceCodec";
import {
  CharacterIdOfDomainData,
  ClonePlayerPersistenceRevisions,
  EmptyPlayerPersistenceRevisions,
  PLAYER_PERSISTENCE_DOMAINS,
  type PlayerMultiTransactionReceipt,
  type PlayerMultiTransactionResult,
  type PlayerDomainSaveData,
  type PlayerPersistenceDomain,
  type PlayerPersistenceRevisions,
  type PlayerRepository,
  type PlayerSaveData,
  type PlayerTransactionReceipt,
  type PlayerTransactionRecordKey,
  type PlayerTransactionResult,
} from "./PlayerRepository";

export const PLAYER_PERIODIC_SNAPSHOT_INTERVAL_MS = 30_000;
const PLAYER_PERIODIC_RETRY_MS = 5_000;

export interface PlayerSaveOverrides {
  readonly numerics?: PlayerSaveData["player"]["numerics"];
  readonly gold?: bigint;
  readonly items?: PlayerSaveData["items"];
  readonly buffs?: PlayerSaveData["buffs"];
  readonly skill?: PlayerSaveData["skill"];
  readonly quests?: PlayerSaveData["quests"];
  readonly progression?: PlayerSaveData["progression"];
}

export interface PlayerMultiTransactionParticipant {
  readonly persistence: PlayerPersistenceComponent;
  readonly data: PlayerSaveData;
  readonly domains: readonly PlayerPersistenceDomain[];
}

export interface PlayerMultiTransactionReceiptParticipant {
  readonly persistence: PlayerPersistenceComponent;
  readonly domains: readonly PlayerPersistenceDomain[];
}

@component()
@transferable()
export class PlayerPersistenceComponent extends Component<[
  repository: PlayerRepository,
  revisions: PlayerPersistenceRevisions,
]> implements ITransfer<PlayerPersistenceRevisions> {
  private repository!: PlayerRepository;
  private revisions: PlayerPersistenceRevisions = EmptyPlayerPersistenceRevisions();
  private finalSavePromise: Promise<void> | undefined;
  private nextPeriodicSaveAtMs = 0;
  private readonly uncertainOperations = new Set<string>();
  private readonly committedPayloads = new Map<PlayerPersistenceDomain, Uint8Array>();

  /** 保存Repository和领域revision向量；跨图只迁移revision，不迁移Repository引用。 / Captures the Repository and domain revision vector; map transfer moves revisions but never the Repository reference. */
  protected override Awake(repository: PlayerRepository, revisions: PlayerPersistenceRevisions): void {
    validateRevisions(revisions);
    this.repository = repository;
    this.revisions = ClonePlayerPersistenceRevisions(revisions);
    const characterId = this.GetParent<PlayerUnit>().CharacterId;
    this.nextPeriodicSaveAtMs = Date.now() + periodicJitter(characterId);
  }

  Revision(domain: PlayerPersistenceDomain): bigint {
    return this.revisions[domain];
  }

  get Revisions(): PlayerPersistenceRevisions {
    return ClonePlayerPersistenceRevisions(this.revisions);
  }

  CaptureTransfer(): PlayerPersistenceRevisions {
    return this.Revisions;
  }

  RestoreTransfer(revisions: PlayerPersistenceRevisions): void {
    validateRevisions(revisions);
    this.revisions = ClonePlayerPersistenceRevisions(revisions);
  }

  /** 无DBProxy迁移把五个领域及revision向量交给目标内存Repository。 / A no-DBProxy transfer hands all five domains and their revisions to the target in-memory Repository. */
  AdoptTransfer(): void {
    const adopt = this.repository.AdoptTransfer;
    if (!adopt) return;
    adopt.call(this.repository, this.Capture("map-transfer"), this.revisions);
  }

  /** 同步捕获完整玩家值；事务通过domains参数决定实际持久化哪些字段。 / Synchronously captures aggregate player values; transaction domains decide which fields are actually persisted. */
  Capture(reason: string, overrides: PlayerSaveOverrides = {}): PlayerSaveData {
    if (reason.trim().length === 0) throw new Error("player persistence reason is required");
    const player = this.GetParent<PlayerUnit>();
    const snapshot = player.Snapshot();
    const { gateName: _gateName, unitId: _unitId, numerics, ...persistent } = snapshot;
    return {
      player: {
        ...persistent,
        gold: overrides.gold ?? snapshot.gold,
        numerics: overrides.numerics ?? numerics.map(({ numericType, value }) => ({ numericType, value })),
      },
      items: overrides.items ?? player.GetComponent(ItemComponent).Snapshot(),
      buffs: overrides.buffs ?? player.GetComponent(BuffComponent).CaptureTransfer().map(({ sourceUnitId, ...buff }) => ({
        ...buff,
        source: sourceUnitId === player.UnitId ? "self" as const : "detached" as const,
      })),
      skill: overrides.skill ?? player.GetComponent(SkillComponent).CaptureTransfer(),
      quests: overrides.quests ?? player.GetComponent(QuestComponent).CaptureTransfer(),
      progression: overrides.progression ?? player.GetComponent(ProgressionComponent).CaptureTransfer(),
      reason,
    };
  }

  /** 只提交调用方声明的领域记录；成功前不修改任何本地revision。 / Commits only declared domain records and changes no local revision before success. */
  async ApplyTransaction(
    operationId: string,
    domains: readonly PlayerPersistenceDomain[],
    data: PlayerSaveData,
    result: Uint8Array,
  ): Promise<PlayerTransactionResult> {
    this.requireTransactionIdentity(data);
    const normalizedDomains = normalizeDomains(domains);
    try {
      const records = normalizedDomains.map((domain) => ({
        domain,
        data: ProjectPlayerDomainData(data, domain),
        expectedRevision: this.revisions[domain],
      }));
      const committed = await Promise.resolve(this.repository.ApplyTransaction({
        operationId,
        records,
        result: result.slice(),
      }));
      this.applyCommittedRevisions(committed.revisions);
      for (const record of records) this.rememberCommittedPayload(record.domain, record.data);
      this.uncertainOperations.delete(operationId);
      return cloneTransactionResult(committed);
    } catch (error) {
      this.uncertainOperations.add(operationId);
      throw error;
    }
  }

  IsTransactionUncertain(operationId: string): boolean {
    return this.uncertainOperations.has(operationId);
  }

  /** 查询指定领域集合的原始业务回执；调用方必须与首次提交使用相同集合。 / Loads the original receipt for the exact domain set used by the first commit. */
  async LoadTransaction(
    operationId: string,
    domains: readonly PlayerPersistenceDomain[],
  ): Promise<PlayerTransactionReceipt | undefined> {
    const player = this.GetParent<PlayerUnit>();
    const keys = normalizeDomains(domains).map((domain) => ({ characterId: player.CharacterId, domain }));
    const receipt = await Promise.resolve(this.repository.LoadTransaction(keys, operationId));
    if (!receipt) return undefined;
    this.applyCommittedRevisions(receipt.revisions);
    this.uncertainOperations.delete(operationId);
    return cloneTransactionReceipt(receipt);
  }

  /** 持有全部参与者ordered mailbox时原子提交跨玩家领域记录。 / Atomically commits cross-player domain records while every participant ordered mailbox is held. */
  async ApplyMultiTransaction(
    operationId: string,
    participants: readonly PlayerMultiTransactionParticipant[],
    result: Uint8Array,
  ): Promise<PlayerMultiTransactionResult> {
    const normalized = normalizeParticipants(participants);
    const records = normalized.flatMap((participant) => {
      participant.persistence.requireTransactionIdentity(participant.data);
      if (participant.persistence.repository !== this.repository) {
        throw new Error("player multi transaction participants must share one Repository");
      }
      return normalizeDomains(participant.domains).map((domain) => ({
        domain,
        data: ProjectPlayerDomainData(participant.data, domain),
        expectedRevision: participant.persistence.revisions[domain],
      }));
    });
    try {
      const committed = await Promise.resolve(this.repository.ApplyMultiTransaction({
        operationId,
        records,
        result: result.slice(),
      }));
      for (const participant of normalized) {
        participant.persistence.applyCommittedRevisions(committed.revisions);
        for (const domain of normalizeDomains(participant.domains)) {
          participant.persistence.rememberCommittedPayload(
            domain,
            ProjectPlayerDomainData(participant.data, domain),
          );
        }
        participant.persistence.uncertainOperations.delete(operationId);
      }
      return cloneTransactionResult(committed);
    } catch (error) {
      for (const participant of normalized) participant.persistence.uncertainOperations.add(operationId);
      throw error;
    }
  }

  IsMultiTransactionUncertain(
    operationId: string,
    participants: readonly PlayerPersistenceComponent[],
  ): boolean {
    return participants.some((participant) => participant.uncertainOperations.has(operationId));
  }

  /** 查询共享跨记录回执并同步每个在线参与者的领域revision。 / Loads a shared cross-record receipt and synchronizes each online participant's domain revisions. */
  async LoadMultiTransaction(
    operationId: string,
    participants: readonly PlayerMultiTransactionReceiptParticipant[],
  ): Promise<PlayerMultiTransactionReceipt | undefined> {
    const normalized = normalizeReceiptParticipants(participants);
    const keys: PlayerTransactionRecordKey[] = [];
    for (const participant of normalized) {
      if (participant.persistence.repository !== this.repository) {
        throw new Error("player multi transaction participants must share one Repository");
      }
      const characterId = participant.persistence.GetParent<PlayerUnit>().CharacterId;
      for (const domain of normalizeDomains(participant.domains)) keys.push({ characterId, domain });
    }
    const receipt = await Promise.resolve(this.repository.LoadMultiTransaction(keys, operationId));
    if (!receipt) return undefined;
    for (const participant of normalized) {
      participant.persistence.applyCommittedRevisions(receipt.revisions);
      participant.persistence.uncertainOperations.delete(operationId);
    }
    return cloneTransactionReceipt(receipt);
  }

  IsPeriodicSaveDue(nowMs: number): boolean {
    return !this.finalSavePromise && nowMs >= this.nextPeriodicSaveAtMs;
  }

  /** ordered mailbox内可靠保存五个领域；单个领域成功后立即推进其revision，后续失败可安全重试。 / Reliably saves five domains inside the ordered mailbox, advancing each successful revision so a later failure can retry safely. */
  async SavePeriodic(nowMs: number): Promise<void> {
    this.nextPeriodicSaveAtMs = nowMs + PLAYER_PERIODIC_SNAPSHOT_INTERVAL_MS;
    try {
      await this.SaveSnapshot("periodic");
    } catch (error) {
      this.nextPeriodicSaveAtMs = nowMs + PLAYER_PERIODIC_RETRY_MS;
      throw error;
    }
  }

  /** 断线、踢下线和停机只执行一次最终Flush，重复调用共享Promise。 / Disconnect, kick, and shutdown execute one final flush and share its Promise. */
  SaveOnOffline(reason: string): Promise<void> {
    if (this.finalSavePromise) return this.finalSavePromise;
    const player = this.GetParent<PlayerUnit>();
    this.finalSavePromise = this.SaveSnapshot(reason).then(() => {
      player.logger.info("player domains saved", {
        account: player.Account,
        unitId: player.UnitId,
        reason,
        revisions: revisionLog(this.revisions),
      });
    });
    return this.finalSavePromise;
  }

  private async SaveSnapshot(reason: string): Promise<void> {
    const data = this.Capture(reason);
    const candidates = PLAYER_PERSISTENCE_DOMAINS.map((domain) => ({
      domain,
      data: ProjectPlayerDomainData(data, domain),
    })).filter((candidate) => !this.isCommittedPayload(candidate.domain, candidate.data));
    if (candidates.length === 0) return;
    const outcomes = await Promise.resolve(this.repository.SaveDomains(
      candidates.map(({ domain, data: domainData }) => ({
        domain,
        data: domainData,
        expectedRevision: this.revisions[domain],
      })),
    ));
    const candidatesByDomain = new Map(candidates.map((candidate) => [candidate.domain, candidate.data]));
    const seen = new Set<PlayerPersistenceDomain>();
    const failures: { domain: PlayerPersistenceDomain; error: unknown }[] = [];
    for (const outcome of outcomes) {
      const domain = outcome.ok ? outcome.result.domain : outcome.domain;
      if (seen.has(domain)) throw new Error(`player batch save returned duplicate domain: ${domain}`);
      seen.add(domain);
      if (outcome.ok) {
        this.revisions[domain] = outcome.result.revision;
        const committed = candidatesByDomain.get(domain);
        if (!committed) throw new Error(`player batch save returned unexpected domain: ${domain}`);
        this.rememberCommittedPayload(domain, committed);
      }
      else failures.push({ domain, error: outcome.error });
    }
    if (seen.size !== candidates.length) {
      throw new Error(`player batch save returned ${seen.size}/${candidates.length} dirty domains`);
    }
    if (failures.length > 0) {
      const detail = failures.map((failure) => `${failure.domain}: ${errorMessage(failure.error)}`).join("; ");
      throw new Error(`player batch save failed after applying successful revisions: ${detail}`);
    }
  }

  private isCommittedPayload(domain: PlayerPersistenceDomain, data: PlayerDomainSaveData): boolean {
    const previous = this.committedPayloads.get(domain);
    return previous !== undefined && bytesEqual(previous, canonicalDomainPayload(domain, data));
  }

  private rememberCommittedPayload(domain: PlayerPersistenceDomain, data: PlayerDomainSaveData): void {
    this.committedPayloads.set(domain, canonicalDomainPayload(domain, data));
  }

  private applyCommittedRevisions(revisions: readonly { characterId: bigint; domain: PlayerPersistenceDomain; revision: bigint }[]): void {
    const characterId = this.GetParent<PlayerUnit>().CharacterId;
    for (const revision of revisions) {
      if (revision.characterId !== characterId) continue;
      if (revision.revision > this.revisions[revision.domain]) this.revisions[revision.domain] = revision.revision;
    }
  }

  private requireTransactionIdentity(data: PlayerSaveData): void {
    const player = this.GetParent<PlayerUnit>();
    if (data.player.account !== player.Account || data.player.characterId !== player.CharacterId) {
      throw new Error(`player transaction identity mismatch: ${data.player.account}/${data.player.characterId} != ${player.Account}/${player.CharacterId}`);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeDomains(domains: readonly PlayerPersistenceDomain[]): readonly PlayerPersistenceDomain[] {
  const normalized = [...new Set(domains)].sort();
  if (normalized.length === 0) throw new Error("player transaction requires at least one persistence domain");
  return normalized;
}

function normalizeParticipants(participants: readonly PlayerMultiTransactionParticipant[]): readonly PlayerMultiTransactionParticipant[] {
  if (participants.length < 2) throw new Error("player multi transaction requires at least two participants");
  return [...participants].sort((left, right) => compareBigInt(
    left.data.player.characterId,
    right.data.player.characterId,
  ));
}

function normalizeReceiptParticipants(
  participants: readonly PlayerMultiTransactionReceiptParticipant[],
): readonly PlayerMultiTransactionReceiptParticipant[] {
  if (participants.length < 2) throw new Error("player multi transaction requires at least two participants");
  return [...participants].sort((left, right) => compareBigInt(
    left.persistence.GetParent<PlayerUnit>().CharacterId,
    right.persistence.GetParent<PlayerUnit>().CharacterId,
  ));
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateRevisions(revisions: PlayerPersistenceRevisions): void {
  for (const domain of PLAYER_PERSISTENCE_DOMAINS) {
    if (revisions[domain] < 0n) throw new Error(`player ${domain} revision must be non-negative: ${revisions[domain]}`);
  }
}

function periodicJitter(characterId: bigint): number {
  return Number(characterId % BigInt(PLAYER_PERIODIC_SNAPSHOT_INTERVAL_MS));
}

function canonicalDomainPayload(
  domain: PlayerPersistenceDomain,
  data: PlayerDomainSaveData,
): Uint8Array {
  // `reason` is diagnostic metadata, not player state. Changing from periodic to shutdown (or
  // from a business operation ID to periodic) must not turn an otherwise identical domain dirty.
  return EncodePlayerDomainData(domain, { ...data, reason: "state-fingerprint" } as PlayerDomainSaveData);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function cloneTransactionResult(result: PlayerTransactionResult): PlayerTransactionResult {
  return { ...result, revisions: result.revisions.map((revision) => ({ ...revision })), result: result.result.slice() };
}

function cloneTransactionReceipt(receipt: PlayerTransactionReceipt): PlayerTransactionReceipt {
  return { revisions: receipt.revisions.map((revision) => ({ ...revision })), result: receipt.result.slice() };
}

function revisionLog(revisions: PlayerPersistenceRevisions): Record<PlayerPersistenceDomain, string> {
  return {
    inventory: revisions.inventory.toString(),
    progression: revisions.progression.toString(),
    quest: revisions.quest.toString(),
    runtime: revisions.runtime.toString(),
    wallet: revisions.wallet.toString(),
  };
}
