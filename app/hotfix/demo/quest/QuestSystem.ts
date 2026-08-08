import { Quest, type AwakeQuest, type QuestState, systemFor } from "#tiangz/model";

@systemFor(Quest)
export class QuestSystem extends Quest {
  protected override Awake(request: AwakeQuest): void {
    this.configId = request.configId;
    this.objectives = request.objectives.map((objective) => ({ ...objective }));
    this.revision = request.revision ?? 1;
  }

  get ConfigId(): number { return this.configId; }

  /** 累加匹配目标并返回是否变化；单次事件不能把进度推进到required之外。 / Advances matching objectives and clamps progress to the accepted requirement. */
  Advance(objectiveId: number, count: number): boolean {
    if (!Number.isSafeInteger(count) || count <= 0) return false;
    const objective = this.objectives.find((item) => item.objectiveId === objectiveId);
    if (!objective || objective.current >= objective.required) return false;
    objective.current = Math.min(objective.required, objective.current + count);
    this.revision += 1;
    return true;
  }

  Snapshot(): QuestState {
    return {
      questConfigId: this.configId,
      objectives: this.objectives.map((objective) => ({ ...objective })),
      revision: this.revision,
      readyToComplete: this.objectives.every((objective) => objective.current >= objective.required),
    };
  }
}
