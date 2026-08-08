import { defineSyncEvent } from "../../../core/public";
import type { PlayerUnit } from "../map/PlayerUnit";

export interface QuestProgressEvent {
  readonly player: PlayerUnit;
  readonly objectiveType: number;
  readonly targetConfigId: number;
  readonly count: number;
}

export const QuestEvents = {
  Progress: defineSyncEvent<QuestProgressEvent>("Quest.Progress"),
} as const;
