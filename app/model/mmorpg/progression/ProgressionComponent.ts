import { Component, component, transferable } from "../../../core/public";

export interface ProgressionRewardResult {
  readonly level: bigint;
  readonly experience: bigint;
  readonly gainedExperience: bigint;
  readonly leveledUp: boolean;
}

export interface ProgressionTransferState {
  readonly starterDungeonCooldownEndAtMs: bigint;
  readonly starterDungeonOperationId: string;
}

export interface StarterDungeonEntryResult {
  readonly cooldownEndAtMs: bigint;
  readonly operationId: string;
}

/**
 * 玩家成长事务入口。等级和累计经验仍由Numeric保存并进入progression记录；该组件提供
 * “先持久化、后提交在线状态”的边界，并拥有副本准入等非Numeric成长状态。
 *
 * Player progression transaction boundary. Level and cumulative experience
 * remain Numeric values persisted by the progression record; this component
 * avoids duplicating Numeric progression while owning non-Numeric gates such as dungeon admission.
 */
@component()
@transferable()
export class ProgressionComponent extends Component {
  protected starterDungeonCooldownEndAtMs = 0n;
  protected starterDungeonOperationId = "";

  get StarterDungeonCooldownEndAtMs(): bigint {
    return this.starterDungeonCooldownEndAtMs;
  }

  GrantExperience(operationId: string, amount: bigint): Promise<ProgressionRewardResult> {
    void operationId;
    void amount;
    throw new Error("ProgressionComponent.GrantExperience requires Hotfix implementation");
  }

  ClaimStarterDungeonEntry(operationId: string): Promise<StarterDungeonEntryResult> {
    void operationId;
    throw new Error("ProgressionComponent.ClaimStarterDungeonEntry requires Hotfix implementation");
  }
}
