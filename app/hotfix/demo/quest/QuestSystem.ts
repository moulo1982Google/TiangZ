import { Quest, QuestStatus, type AwakeQuest, type QuestState, systemFor } from "#tiangz/model";

@systemFor(Quest)
export class QuestSystem extends Quest {
  protected override Awake(request: AwakeQuest): void {
    this.configId = request.configId;
    this.objectives = request.objectives.map((objective) => ({ ...objective }));
    const derivedStatus = this.objectives.every((objective) => objective.current >= objective.required)
      ? QuestStatus.ReadyToTurnIn
      : QuestStatus.InProgress;
    if (request.status !== undefined && request.status !== derivedStatus) {
      throw new Error(`quest ${request.configId} status does not match objective progress`);
    }
    this.status = derivedStatus;
    this.revision = request.revision ?? 1;
  }

  get ConfigId(): number { return this.configId; }

  /** 累加匹配目标并返回是否变化；单次事件不能把进度推进到required之外。 / Advances matching objectives and clamps progress to the accepted requirement. */
  Advance(objectiveId: number, count: number): boolean {
    if (!Number.isSafeInteger(count) || count <= 0) return false;
    if (this.status !== QuestStatus.InProgress) return false;
    const objective = this.objectives.find((item) => item.objectiveId === objectiveId);
    if (!objective || objective.current >= objective.required) return false;
    objective.current = Math.min(objective.required, objective.current + count);
    if (this.objectives.every((item) => item.current >= item.required)) {
      this.status = QuestStatus.ReadyToTurnIn;
    }
    this.revision += 1;
    return true;
  }

  /** 用DBProxy回执恢复已提交的任务状态；只允许同一任务版本前进，不回滚后续进度。 / Restores a committed quest state and never rolls back a newer local revision. */
  Restore(state: QuestState): void {
    if (state.questConfigId !== this.configId) {
      throw new Error(`quest restore owner mismatch: ${state.questConfigId} != ${this.configId}`);
    }
    if (state.revision < this.revision) return;
    if (state.revision === this.revision) return;
    this.objectives = state.objectives.map((objective) => ({ ...objective }));
    this.status = state.status;
    this.revision = state.revision;
  }

  Snapshot(): QuestState {
    return {
      questConfigId: this.configId,
      objectives: this.objectives.map((objective) => ({ ...objective })),
      status: this.status,
      revision: this.revision,
    };
  }
}
