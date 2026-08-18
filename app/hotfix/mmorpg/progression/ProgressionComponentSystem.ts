import {
  G2C_ProgressionChangedCodec,
  GameErrCode,
  NumericComponent,
  NumericType,
  PlayerPersistenceComponent,
  type PlayerUnit,
  ProgressionComponent,
  RpcError,
  STARTER_DUNGEON_COOLDOWN_MS,
  StarterDungeonCooldownSnapshotCodec,
  TimeSystem,
  type ITransfer,
  type ProgressionTransferState,
  type ProgressionRewardResult,
  type StarterDungeonEntryResult,
  systemFor,
} from "#tiangz/model";
import { LevelFromExperience } from "./ProgressionRules";

/** 成长变更必须先提交progression记录，成功后才写在线Numeric。 / Progression changes commit the progression record before mutating online Numeric values. */
@systemFor(ProgressionComponent)
export class ProgressionComponentSystem extends ProgressionComponent implements ITransfer<ProgressionTransferState> {
  CaptureTransfer(): ProgressionTransferState {
    return {
      starterDungeonCooldownEndAtMs: this.starterDungeonCooldownEndAtMs,
      starterDungeonOperationId: this.starterDungeonOperationId,
    };
  }

  RestoreTransfer(state: ProgressionTransferState): void {
    requireProgressionState(state);
    this.starterDungeonCooldownEndAtMs = state.starterDungeonCooldownEndAtMs;
    this.starterDungeonOperationId = state.starterDungeonOperationId;
  }

  async GrantExperience(operationId: string, amount: bigint): Promise<ProgressionRewardResult> {
    if (operationId.trim().length === 0) throw new Error("progression operationId is required");
    if (amount <= 0n) throw new Error(`experience reward must be positive: ${amount}`);

    const player = this.GetParent<PlayerUnit>();
    const numeric = player.GetComponent(NumericComponent);
    const currentExperience = numeric[NumericType.Experience];
    const nextExperience = currentExperience + amount;
    const currentLevel = numeric[NumericType.Level];
    const nextLevel = LevelFromExperience(nextExperience);
    const planned = {
      level: nextLevel,
      experience: nextExperience,
      gainedExperience: amount,
      leveledUp: nextLevel > currentLevel,
    };
    const persistence = player.GetComponent(PlayerPersistenceComponent);
    const numerics = numeric.Snapshot().map(({ numericType, value }) => ({
      numericType,
      value: numericType === NumericType.Level
        ? nextLevel
        : numericType === NumericType.Experience
          ? nextExperience
          : value,
    }));
    const data = persistence.Capture("experience-reward", { numerics });
    const committed = await persistence.ApplyTransaction(
      operationId,
      ["progression"],
      data,
      G2C_ProgressionChangedCodec.encode(planned),
    );
    const durable = G2C_ProgressionChangedCodec.decode(committed.result);

    // 幂等重试可能返回较早的已提交回执；绝不能把在线成长状态倒退。
    // An idempotent retry may return an older committed receipt and must never
    // move the online progression state backwards.
    if (numeric[NumericType.Experience] < durable.experience) {
      numeric[NumericType.Experience] = durable.experience;
      numeric[NumericType.Level] = durable.level;
    }
    return {
      level: durable.level,
      experience: durable.experience,
      gainedExperience: durable.gainedExperience,
      leveledUp: durable.leveledUp,
    };
  }

  /** 个人副本CD先写progression记录，再允许Gate创建实例；同一operationId只返回原回执。 / Persists the personal dungeon cooldown before Gate creates an instance; the same operation id only recovers its original receipt. */
  async ClaimStarterDungeonEntry(operationId: string): Promise<StarterDungeonEntryResult> {
    const normalizedOperationId = operationId.trim();
    if (normalizedOperationId.length === 0 || normalizedOperationId.length > 128) {
      throw new RpcError(GameErrCode.InvalidOperationId, "invalid Starter dungeon operationId");
    }
    if (this.starterDungeonOperationId === normalizedOperationId && this.starterDungeonCooldownEndAtMs > 0n) {
      return {
        cooldownEndAtMs: this.starterDungeonCooldownEndAtMs,
        operationId: normalizedOperationId,
      };
    }

    const now = BigInt(Math.max(0, Math.floor(TimeSystem.Instance.ServerNow)));
    if (now < this.starterDungeonCooldownEndAtMs) {
      throw new RpcError(
        GameErrCode.DungeonCooldown,
        `Starter dungeon cooldown ends at ${this.starterDungeonCooldownEndAtMs}`,
      );
    }

    const player = this.GetParent<PlayerUnit>();
    const planned: ProgressionTransferState = {
      starterDungeonCooldownEndAtMs: now + BigInt(STARTER_DUNGEON_COOLDOWN_MS),
      starterDungeonOperationId: normalizedOperationId,
    };
    const persistence = player.GetComponent(PlayerPersistenceComponent);
    const data = persistence.Capture("starter-dungeon-entry", { progression: planned });
    const scopedOperationId = `starter-dungeon:${player.Account}:${normalizedOperationId}`;
    const committed = await persistence.ApplyTransaction(
      scopedOperationId,
      ["progression"],
      data,
      StarterDungeonCooldownSnapshotCodec.encode({
        cooldownEndAtMs: planned.starterDungeonCooldownEndAtMs,
        operationId: planned.starterDungeonOperationId,
      }),
    );
    const durable = StarterDungeonCooldownSnapshotCodec.decode(committed.result);
    const durableState: ProgressionTransferState = {
      starterDungeonCooldownEndAtMs: durable.cooldownEndAtMs,
      starterDungeonOperationId: durable.operationId,
    };
    requireProgressionState(durableState);
    if (
      this.starterDungeonCooldownEndAtMs > durableState.starterDungeonCooldownEndAtMs &&
      this.starterDungeonOperationId !== durableState.starterDungeonOperationId
    ) {
      throw new RpcError(GameErrCode.DungeonCooldown, "a newer Starter dungeon cooldown is already active");
    }
    this.RestoreTransfer(durableState);
    return {
      cooldownEndAtMs: durableState.starterDungeonCooldownEndAtMs,
      operationId: durableState.starterDungeonOperationId,
    };
  }
}

function requireProgressionState(state: ProgressionTransferState): void {
  if (state.starterDungeonCooldownEndAtMs < 0n) {
    throw new Error(`Starter dungeon cooldown must be non-negative: ${state.starterDungeonCooldownEndAtMs}`);
  }
  if (state.starterDungeonCooldownEndAtMs === 0n && state.starterDungeonOperationId.length !== 0) {
    throw new Error("Starter dungeon operationId must be empty without a cooldown");
  }
  if (state.starterDungeonCooldownEndAtMs > 0n && state.starterDungeonOperationId.length === 0) {
    throw new Error("Starter dungeon operationId is required with a cooldown");
  }
  if (state.starterDungeonOperationId.length > 128) {
    throw new Error("Starter dungeon operationId exceeds 128 characters");
  }
}
