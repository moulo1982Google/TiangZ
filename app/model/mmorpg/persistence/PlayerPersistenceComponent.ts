import {
  Component,
  component,
  transferable,
  type ITransfer,
} from "../../../core/public";
import { BuffComponent } from "../buff/BuffComponent";
import { ItemComponent } from "../item/ItemComponent";
import type { PlayerUnit } from "../map/PlayerUnit";
import { QuestComponent } from "../quest/QuestComponent";
import { SkillComponent } from "../skill/SkillComponent";
import type { PlayerRepository } from "./PlayerRepository";
import type {
  PlayerSaveData,
  PlayerMultiTransactionReceipt,
  PlayerMultiTransactionResult,
  PlayerTransactionReceipt,
  PlayerTransactionResult,
} from "./PlayerRepository";

export interface PlayerSaveOverrides {
  readonly numerics?: PlayerSaveData["player"]["numerics"];
  readonly gold?: bigint;
  readonly items?: PlayerSaveData["items"];
  readonly buffs?: PlayerSaveData["buffs"];
  readonly skill?: PlayerSaveData["skill"];
  readonly quests?: PlayerSaveData["quests"];
}

export interface PlayerMultiTransactionParticipant {
  readonly persistence: PlayerPersistenceComponent;
  readonly data: PlayerSaveData;
}

@component()
@transferable()
export class PlayerPersistenceComponent extends Component<[
  repository: PlayerRepository,
  revision: bigint,
]> implements ITransfer<bigint> {
  private repository!: PlayerRepository;
  private revision = 0n;
  private savePromise: Promise<void> | undefined;
  private readonly uncertainOperations = new Set<string>();

  /** 保存地图工厂选定的Repository及已加载revision；revision随Unit迁移而Repository引用不迁移。 / Captures the factory-selected Repository and loaded revision; the revision transfers with the Unit while the Repository reference does not. */
  protected override Awake(repository: PlayerRepository, revision: bigint): void {
    if (revision < 0n) throw new Error(`player persistence revision must be non-negative: ${revision}`);
    this.repository = repository;
    this.revision = revision;
  }

  get Revision(): bigint {
    return this.revision;
  }

  CaptureTransfer(): bigint {
    return this.revision;
  }

  RestoreTransfer(revision: bigint): void {
    if (revision < 0n) throw new Error(`transferred persistence revision must be non-negative: ${revision}`);
    this.revision = revision;
  }

  /**
   * 把已恢复的Unit纯数据交给无DBProxy目标进程的内存Repository，保证跨进程迁移后仍能继续CAS。
   * 配置了DBProxy时该方法不产生写入，数据库中的权威快照不会被迁移过程覆盖。
   *
   * Hands restored Unit values to an in-memory Repository in a no-DBProxy target
   * so CAS can continue after cross-process transfer. With DBProxy configured it
   * performs no write and never overwrites durable authority during transfer.
   */
  AdoptTransfer(): void {
    const adopt = this.repository.AdoptTransfer;
    if (!adopt) return;
    adopt.call(this.repository, this.Capture("map-transfer"), this.revision);
  }

  /**
   * 捕获完整玩家纯数据，可用经过预检但尚未应用的items/quests覆盖当前值。
   * 本函数不修改Entity，也不跨await；事务业务必须先在同一同步栈中完成全部规划。
   *
   * Captures complete player value data and may substitute preflighted items or
   * quests that are not applied yet. It never mutates Entities or crosses an
   * await; transactional gameplay must finish planning in one synchronous stack.
   */
  Capture(reason: string, overrides: PlayerSaveOverrides = {}): PlayerSaveData {
    if (reason.trim().length === 0) throw new Error("player persistence reason is required");
    const player = this.GetParent<PlayerUnit>();
    const snapshot = player.Snapshot();
    const {
      gateName: _gateName,
      unitId: _unitId,
      numerics,
      ...persistent
    } = snapshot;
    return {
      player: {
        ...persistent,
        gold: overrides.gold ?? snapshot.gold,
        numerics: overrides.numerics ?? numerics.map(({ numericType, value }) => ({ numericType, value })),
      },
      items: overrides.items ?? player.GetComponent(ItemComponent).Snapshot(),
      buffs: overrides.buffs ?? player.GetComponent(BuffComponent).CaptureTransfer().map(({
        sourceUnitId,
        ...buff
      }) => ({
        ...buff,
        source: sourceUnitId === player.UnitId ? "self" as const : "detached" as const,
      })),
      skill: overrides.skill ?? player.GetComponent(SkillComponent).CaptureTransfer(),
      quests: overrides.quests ?? player.GetComponent(QuestComponent).CaptureTransfer(),
      reason,
    };
  }

  /**
   * 把关键业务的操作后快照交给Repository可靠提交；成功前不改变本地revision。
   * Handler和业务Component不得直接访问DBProxy Transport，否则会绕过这一所有权边界。
   *
   * Reliably commits a critical post-operation snapshot through the Repository
   * without changing local revision before success. Handlers and gameplay
   * Components must never bypass this owner by calling DBProxy Transport.
   */
  async ApplyTransaction(
    operationId: string,
    data: PlayerSaveData,
    result: Uint8Array,
  ): Promise<PlayerTransactionResult> {
    const player = this.GetParent<PlayerUnit>();
    if (data.player.account !== player.Account || data.player.characterId !== player.CharacterId) {
      throw new Error(
        `player transaction identity mismatch: ${data.player.account}/${data.player.characterId} != ${player.Account}/${player.CharacterId}`,
      );
    }
    try {
      const committed = await Promise.resolve(this.repository.ApplyTransaction({
        operationId,
        data,
        result: result.slice(),
      }, this.revision));
      this.uncertainOperations.delete(operationId);
      this.revision = committed.revision;
      return { ...committed, result: committed.result.slice() };
    } catch (error) {
      // 连接失败无法证明PostgreSQL没有提交；保留不确定标记，让同一Actor的重试先查回执。
      // A transport failure cannot prove PostgreSQL did not commit; retain an uncertainty marker so this Actor checks the receipt before retrying.
      this.uncertainOperations.add(operationId);
      throw error;
    }
  }

  IsTransactionUncertain(operationId: string): boolean {
    return this.uncertainOperations.has(operationId);
  }

  /** 读取已提交事务的原始业务结果；仅用于确定性operationId的重试恢复。 / Loads an original committed result for retry recovery with a deterministic operationId. */
  async LoadTransaction(operationId: string): Promise<PlayerTransactionReceipt | undefined> {
    const player = this.GetParent<PlayerUnit>();
    const receipt = await Promise.resolve(
      this.repository.LoadTransaction(player.CharacterId, operationId),
    );
    if (!receipt) return undefined;
    this.uncertainOperations.delete(operationId);
    if (receipt.revision > this.revision) this.revision = receipt.revision;
    return { revision: receipt.revision, result: receipt.result.slice() };
  }

  /**
   * 通过一个共享Repository原子提交多个在线玩家；调用者必须在await前完成全部纯值规划。
   * 任一身份、Repository或revision不一致都会在写入前失败，成功后才同步推进每个本地组件的revision。
   *
   * Atomically commits multiple online players through one shared Repository.
   * Callers must finish all value planning before await. Identity, Repository,
   * or revision mismatches fail before writing; local revisions advance only
   * after the shared commit succeeds.
   */
  async ApplyMultiTransaction(
    operationId: string,
    participants: readonly PlayerMultiTransactionParticipant[],
    result: Uint8Array,
  ): Promise<PlayerMultiTransactionResult> {
    const normalized = normalizeParticipants(participants);
    for (const participant of normalized) {
      participant.persistence.requireTransactionIdentity(participant.data);
      if (participant.persistence.repository !== this.repository) {
        throw new Error("player multi transaction participants must share one Repository");
      }
    }
    try {
      const committed = await Promise.resolve(this.repository.ApplyMultiTransaction({
        operationId,
        entries: normalized.map((participant) => ({
          data: participant.data,
          expectedRevision: participant.persistence.revision,
        })),
        result: result.slice(),
      }));
      const revisions = new Map(
        committed.revisions.map((entry) => [entry.characterId, entry.revision]),
      );
      for (const participant of normalized) {
        const revision = revisions.get(participant.data.player.characterId);
        if (revision === undefined) {
          throw new Error(
            `player multi transaction omitted revision: ${participant.data.player.characterId}`,
          );
        }
        participant.persistence.revision = revision;
        participant.persistence.uncertainOperations.delete(operationId);
      }
      return {
        disposition: committed.disposition,
        revisions: committed.revisions.map((entry) => ({ ...entry })),
        result: committed.result.slice(),
      };
    } catch (error) {
      // 任一参与者都无法独立判断事务是否提交；全部标记不确定，恢复必须查询同一多记录回执。
      // No participant can independently prove whether the transaction committed;
      // mark all uncertain and recover only through the shared multi-record receipt.
      for (const participant of normalized) {
        participant.persistence.uncertainOperations.add(operationId);
      }
      throw error;
    }
  }

  IsMultiTransactionUncertain(
    operationId: string,
    participants: readonly PlayerPersistenceComponent[],
  ): boolean {
    return participants.some((participant) => participant.uncertainOperations.has(operationId));
  }

  /** 查询共享多记录回执并同步全部参与者revision；缺少任一角色都视为契约错误。 / Loads a shared multi-record receipt and synchronizes every participant revision, rejecting incomplete receipts. */
  async LoadMultiTransaction(
    operationId: string,
    participants: readonly PlayerPersistenceComponent[],
  ): Promise<PlayerMultiTransactionReceipt | undefined> {
    const normalized = normalizePersistenceComponents(participants);
    for (const participant of normalized) {
      if (participant.repository !== this.repository) {
        throw new Error("player multi transaction participants must share one Repository");
      }
    }
    const characterIds = normalized.map((participant) => participant.GetParent<PlayerUnit>().CharacterId);
    const receipt = await Promise.resolve(
      this.repository.LoadMultiTransaction(characterIds, operationId),
    );
    if (!receipt) return undefined;
    const revisions = new Map(receipt.revisions.map((entry) => [entry.characterId, entry.revision]));
    for (const participant of normalized) {
      const characterId = participant.GetParent<PlayerUnit>().CharacterId;
      const revision = revisions.get(characterId);
      if (revision === undefined) {
        throw new Error(`player multi transaction receipt omitted revision: ${characterId}`);
      }
      if (revision > participant.revision) participant.revision = revision;
      participant.uncertainOperations.delete(operationId);
    }
    return {
      revisions: receipt.revisions.map((entry) => ({ ...entry })),
      result: receipt.result.slice(),
    };
  }

  /**
   * 在断线、踢下线和进程停机路径中只保存玩家一次。
   * 第一个 reason 生效，后续调用者等待同一个 Promise。
   * 踢人 Handler 不可直接调用 Repository，否则会绕过这个幂等边界。
   *
   * Saves the player exactly once across disconnect, kick, and process stop.
   * The first reason wins and all later callers await the same Promise. Do not
   * call the Repository directly from kick handlers because that bypasses this
   * idempotency boundary and can persist the same Unit multiple times.
   */
  SaveOnOffline(reason: string): Promise<void> {
    if (this.savePromise) return this.savePromise;
    const player = this.GetParent<PlayerUnit>();
    this.savePromise = Promise.resolve()
      .then(() => {
        const data = this.Capture(reason);
        return Promise.resolve(this.repository.Save(data, this.revision));
      })
      .then((result) => {
        this.revision = result.revision;
      })
      .then(() => {
        player.logger.info("player data saved", {
          account: player.Account,
          unitId: player.UnitId,
          reason,
          revision: this.revision.toString(),
        });
      });
    return this.savePromise;
  }

  private requireTransactionIdentity(data: PlayerSaveData): void {
    const player = this.GetParent<PlayerUnit>();
    if (data.player.account !== player.Account || data.player.characterId !== player.CharacterId) {
      throw new Error(
        `player transaction identity mismatch: ${data.player.account}/${data.player.characterId} != ${player.Account}/${player.CharacterId}`,
      );
    }
  }
}

function normalizeParticipants(
  participants: readonly PlayerMultiTransactionParticipant[],
): readonly PlayerMultiTransactionParticipant[] {
  if (participants.length < 2) throw new Error("player multi transaction requires at least two participants");
  const normalized = [...participants].sort((left, right) => compareBigInt(
    left.data.player.characterId,
    right.data.player.characterId,
  ));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].data.player.characterId === normalized[index].data.player.characterId) {
      throw new Error(`duplicate player multi transaction participant: ${normalized[index].data.player.characterId}`);
    }
  }
  return normalized;
}

function normalizePersistenceComponents(
  participants: readonly PlayerPersistenceComponent[],
): readonly PlayerPersistenceComponent[] {
  if (participants.length < 2) throw new Error("player multi transaction requires at least two participants");
  const normalized = [...participants].sort((left, right) => compareBigInt(
    left.GetParent<PlayerUnit>().CharacterId,
    right.GetParent<PlayerUnit>().CharacterId,
  ));
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1].GetParent<PlayerUnit>().CharacterId;
    const current = normalized[index].GetParent<PlayerUnit>().CharacterId;
    if (previous === current) throw new Error(`duplicate player multi transaction participant: ${current}`);
  }
  return normalized;
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
