import { isPromiseLike } from "../async";

export interface PreparedTransferOptions<TSnapshot, TTarget> {
  Capture(): TSnapshot;
  /** 抛错前必须自行清理尚未返回的部分资源。 / Must clean partial resources itself before throwing without a target. */
  Prepare(snapshot: TSnapshot): TTarget;
  /** 必须是原子发布步骤；发布成功后不得再执行可能抛错的工作。 / Must be the atomic publication step and perform no fallible work after publication. */
  Commit(target: TTarget): void;
  Rollback(target: TTarget): void;
}

/**
 * 同步准备并提交一次Entity迁移；提交前失败时销毁未公开目标。
 * Capture、Prepare与Commit不得返回Promise，避免迁移快照跨越Hotfix切换点。
 *
 * Prepares and commits one Entity migration synchronously, disposing the
 * unpublished target when a pre-commit step fails. Capture, Prepare, and Commit
 * must not return Promises, so a snapshot cannot cross a Hotfix switch point.
 */
export function CommitPreparedTransfer<TSnapshot, TTarget>(
  options: PreparedTransferOptions<TSnapshot, TTarget>,
): TTarget {
  const snapshot = options.Capture();
  if (isPromiseLike(snapshot)) {
    throw new Error("entity transfer capture must be synchronous");
  }

  let target: TTarget | undefined;
  try {
    target = options.Prepare(snapshot);
    if (isPromiseLike(target)) {
      throw new Error("entity transfer prepare must be synchronous");
    }
    const commit = options.Commit(target) as unknown;
    if (isPromiseLike(commit)) {
      throw new Error("entity transfer commit must be synchronous");
    }
    return target;
  } catch (error) {
    if (target === undefined) throw error;
    try {
      options.Rollback(target);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "entity transfer and rollback both failed",
      );
    }
    throw error;
  }
}

export type TransferStage = "prepared" | "committed" | "aborted";

export interface TransferPrepareResult<TTarget> {
  readonly stage: "prepared" | "committed";
  readonly target: TTarget;
  readonly reused: boolean;
}

export interface TransferCommitResult<TTarget, TResult> {
  readonly target: TTarget;
  readonly result: TResult;
  readonly newlyCommitted: boolean;
}

export interface TransferStagingSnapshot {
  readonly prepared: number;
  readonly committed: number;
  readonly aborted: number;
  readonly total: number;
  readonly capacity: number;
}

interface StagedTransfer<TTarget> {
  readonly fingerprint: string;
  readonly target: TTarget;
  readonly rollback: (target: TTarget) => void;
  stage: TransferStage;
  changedAtMs: number;
  result?: unknown;
}

/**
 * 保存跨进程迁移目标端的有界暂存状态，并让Prepare/Commit/Abort支持重试。
 * committed/aborted记录必须在调用方确认事务结束后Forget，长期业务对象不得放入此表。
 *
 * Keeps bounded target-side staging state for cross-process migration and makes
 * Prepare/Commit/Abort retryable. Callers must Forget committed or aborted
 * records after the transaction settles; long-lived gameplay objects do not belong here.
 */
export class TransferStagingRegistry<TTarget> {
  private readonly records = new Map<string, StagedTransfer<TTarget>>();

  constructor(
    private readonly capacity = 1024,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error(`invalid transfer staging capacity: ${capacity}`);
    }
  }

  /** 创建不可见目标；重复Prepare返回同一目标，载荷指纹不同则拒绝。 / Creates an unpublished target; duplicate Prepare reuses it while a mismatched payload fingerprint is rejected. */
  Prepare(
    transferId: string,
    fingerprint: string,
    prepare: () => TTarget,
    rollback: (target: TTarget) => void,
  ): TransferPrepareResult<TTarget> {
    this.ValidateIdentity(transferId, fingerprint);
    const existing = this.records.get(transferId);
    if (existing) {
      if (existing.stage === "aborted") {
        throw new Error(`transfer is already aborted: ${transferId}`);
      }
      return {
        stage: existing.stage,
        target: existing.target,
        reused: true,
      };
    }
    if (this.records.size >= this.capacity) {
      throw new Error(`transfer staging capacity exceeded: ${this.capacity}`);
    }

    const target = prepare();
    if (isPromiseLike(target)) {
      throw new Error("transfer staging prepare must be synchronous");
    }
    this.records.set(transferId, {
      fingerprint,
      target,
      rollback,
      stage: "prepared",
      changedAtMs: this.now(),
    });
    return { stage: "prepared", target, reused: false };
  }

  /** 原子公开已准备目标；commit必须先完成可失败计算，最后一步才发布且发布后不得抛错。重复Commit返回首次结果。 / Atomically publishes a prepared target; commit must finish fallible work before its final non-throwing publication step. Duplicate Commit returns the first result. */
  Commit<TResult>(
    transferId: string,
    commit: (target: TTarget) => TResult,
  ): TransferCommitResult<TTarget, TResult> {
    const record = this.Require(transferId);
    if (record.stage === "aborted") {
      throw new Error(`cannot commit aborted transfer: ${transferId}`);
    }
    if (record.stage === "committed") {
      return {
        target: record.target,
        result: record.result as TResult,
        newlyCommitted: false,
      };
    }

    const result = commit(record.target);
    if (isPromiseLike(result)) {
      throw new Error("transfer staging commit must be synchronous");
    }
    record.result = result;
    record.stage = "committed";
    record.changedAtMs = this.now();
    return { target: record.target, result, newlyCommitted: true };
  }

  /** 中止未提交迁移并销毁候选目标；重复Abort不重复销毁。 / Aborts an uncommitted transfer and disposes its candidate; duplicate Abort does not dispose twice. */
  Abort(transferId: string): boolean {
    const record = this.Require(transferId);
    if (record.stage === "committed") {
      throw new Error(`cannot abort committed transfer: ${transferId}`);
    }
    if (record.stage === "aborted") return false;
    record.rollback(record.target);
    record.stage = "aborted";
    record.changedAtMs = this.now();
    return true;
  }

  /** 回滚过期Prepare并清除完成态幂等记录，防止源进程宕机永久占满暂存表。 / Rolls back expired prepares and removes completed idempotency records so a crashed source cannot fill staging forever. */
  SweepExpired(preparedTtlMs: number, completedTtlMs: number): number {
    if (preparedTtlMs <= 0 || completedTtlMs <= 0) {
      throw new Error("transfer staging TTL must be positive");
    }
    const now = this.now();
    let removed = 0;
    for (const [transferId, record] of this.records) {
      const ttl = record.stage === "prepared" ? preparedTtlMs : completedTtlMs;
      if (now - record.changedAtMs < ttl) continue;
      if (record.stage === "prepared") record.rollback(record.target);
      this.records.delete(transferId);
      removed += 1;
    }
    return removed;
  }

  /** 移除完成态幂等记录；prepared记录必须先Commit或Abort。 / Removes a completed idempotency record; a prepared record must first be committed or aborted. */
  Forget(transferId: string): boolean {
    const record = this.records.get(transferId);
    if (!record) return false;
    if (record.stage === "prepared") {
      throw new Error(`cannot forget prepared transfer: ${transferId}`);
    }
    return this.records.delete(transferId);
  }

  /** 返回迁移阶段，供日志、指标和故障诊断使用。 / Returns the transfer stage for logs, metrics, and fault diagnosis. */
  Stage(transferId: string): TransferStage | undefined {
    return this.records.get(transferId)?.stage;
  }

  /** 汇总当前暂存阶段，不暴露候选业务对象。 / Summarizes current staging states without exposing candidate gameplay objects. */
  Snapshot(): TransferStagingSnapshot {
    let prepared = 0;
    let committed = 0;
    let aborted = 0;
    for (const record of this.records.values()) {
      if (record.stage === "prepared") prepared += 1;
      else if (record.stage === "committed") committed += 1;
      else aborted += 1;
    }
    return {
      prepared,
      committed,
      aborted,
      total: this.records.size,
      capacity: this.capacity,
    };
  }

  /** 关闭宿主时回滚全部未提交目标；已提交对象已归业务所有。 / Rolls back every uncommitted target during host shutdown; committed targets already belong to gameplay. */
  Dispose(): void {
    let firstError: unknown;
    for (const [transferId, record] of this.records) {
      if (record.stage !== "prepared") continue;
      try {
        record.rollback(record.target);
        record.stage = "aborted";
      } catch (error) {
        firstError ??= new Error(`failed to abort staged transfer ${transferId}`, {
          cause: error,
        });
      }
    }
    this.records.clear();
    if (firstError !== undefined) throw firstError;
  }

  private ValidateIdentity(transferId: string, fingerprint: string): void {
    if (!transferId) throw new Error("transfer id is required");
    if (!fingerprint) throw new Error("transfer fingerprint is required");
    const existing = this.records.get(transferId);
    if (existing && existing.fingerprint !== fingerprint) {
      throw new Error(`transfer payload changed during retry: ${transferId}`);
    }
  }

  private Require(transferId: string): StagedTransfer<TTarget> {
    const record = this.records.get(transferId);
    if (!record) throw new Error(`transfer is not prepared: ${transferId}`);
    return record;
  }
}
