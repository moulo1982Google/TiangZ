import type { QuestState } from "./Quest";

/** 纯计算已接任务的目标进度，供在线实体和离线事务预备共同使用；不修改输入或执行奖励。
 * Pure advancement shared by live entities and offline transaction planning; no mutation or rewards.
 */
export function AdvanceQuestState(state: QuestState, objectiveId: number, count: number): QuestState {
  if (!Number.isSafeInteger(count) || count <= 0 || state.status !== 1) return state;
  const target = state.objectives.find(objective => objective.objectiveId === objectiveId);
  if (!target || target.current >= target.required) return state;
  const objectives = state.objectives.map(objective => objective === target
    ? { ...objective, current: objective.current + Math.min(count, objective.required - objective.current) }
    : { ...objective });
  return { ...state, objectives, status: objectives.every(objective => objective.current >= objective.required) ? 2 : 1,
    revision: state.revision + 1 };
}
