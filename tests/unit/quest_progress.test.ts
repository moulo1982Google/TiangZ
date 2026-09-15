import { describe, expect, it } from "vitest";
import { AdvanceQuestState } from "../../app/model/domains/quest/QuestProgress";
import type { QuestState } from "../../app/model/domains/quest/Quest";

describe("offline quest progress planning", () => {
  const state: QuestState = { questConfigId: 42, status: 1, revision: 8,
    objectives: [{ objectiveId: 1, current: 0, required: 3 }, { objectiveId: 2, current: 0, required: 1 }] };
  it("waits for every objective and preserves the uncommitted input", () => {
    const killed = AdvanceQuestState(state, 1, 9);
    expect(killed.status).toBe(1); expect(killed.objectives[0].current).toBe(3);
    expect(state.objectives[0].current).toBe(0);
    const arrived = AdvanceQuestState(killed, 2, 1);
    expect([arrived.status, arrived.revision]).toEqual([2, 10]);
    expect(AdvanceQuestState(arrived, 1, 1)).toBe(arrived);
  });
  it("rejects unknown targets and invalid increments without inventing revisions", () => {
    for (const count of [0, -1, NaN, Infinity, 0.5]) expect(AdvanceQuestState(state, 1, count)).toBe(state);
    expect(AdvanceQuestState(state, 99, 1)).toBe(state);
  });
});
