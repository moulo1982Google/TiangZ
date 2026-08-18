import { Component, component } from "../../../core/public";

export interface ProgressionRewardResult {
  readonly level: bigint;
  readonly experience: bigint;
  readonly gainedExperience: bigint;
  readonly leveledUp: boolean;
}

/**
 * 玩家成长事务入口。等级和累计经验仍由Numeric保存并进入progression记录；该组件只提供
 * “先持久化、后提交在线状态”的业务边界，不复制第二份成长状态。
 *
 * Player progression transaction boundary. Level and cumulative experience
 * remain Numeric values persisted by the progression record; this component
 * owns no duplicate progression state.
 */
@component()
export class ProgressionComponent extends Component {
  GrantExperience(operationId: string, amount: bigint): Promise<ProgressionRewardResult> {
    void operationId;
    void amount;
    throw new Error("ProgressionComponent.GrantExperience requires Hotfix implementation");
  }
}
