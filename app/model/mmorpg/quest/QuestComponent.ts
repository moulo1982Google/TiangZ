import type { ItemSnapshot } from "../../../generated/model/server/demo/protocol/messages";
import type {
  QuestComponent as GenericQuestComponent,
  QuestObjectiveIndexEntry,
  QuestTransferState,
} from "../../domains/quest/QuestComponent";

/** MMORPG compatibility facade; quest ownership lives in the reusable domain layer. / MMORPG兼容门面；任务归属位于可复用领域层。 */
export { QuestComponent } from "../../domains/quest/QuestComponent";
export type { QuestObjectiveIndexEntry, QuestTransferState };
export type QuestComponentDomainSurface = GenericQuestComponent;

export interface QuestRewardResult {
  readonly questConfigId: number;
  readonly rewardItems: readonly ItemSnapshot[];
}
