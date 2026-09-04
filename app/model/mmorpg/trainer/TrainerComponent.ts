import { Component, component } from "../../../core/public";
import type {
  C2M_LearnTrainerSkill,
  M2C_LearnTrainerSkill,
} from "../../../generated/model/server/demo/protocol/messages";
import type { PlayerUnit } from "../map/PlayerUnit";
import type { NpcComponent } from "../npc/NpcComponent";
import type { SkillDefinitionProfileComponent } from "../skill/SkillDefinitionProfileComponent";
import type { TrainerContentProfileComponent } from "./TrainerContentProfileComponent";

export interface TrainerComponent {
  Learn(
    player: PlayerUnit,
    request: C2M_LearnTrainerSkill,
  ): Promise<M2C_LearnTrainerSkill>;
}

/**
 * 地图域训练师事务协调器；内容、NPC索引、玩家技能归属、货币与持久化仍留在各自组件中。
 * Map-scoped trainer transaction coordinator; content, NPC indexing, player skill ownership, currency, and persistence remain in their owning components.
 */
@component()
export class TrainerComponent extends Component<[
  npc: NpcComponent,
  content: TrainerContentProfileComponent,
  skills: SkillDefinitionProfileComponent,
]> {
  protected npc!: NpcComponent;
  protected content!: TrainerContentProfileComponent;
  protected skills!: SkillDefinitionProfileComponent;
}
