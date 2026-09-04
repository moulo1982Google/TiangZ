import { Component, component, lifecycle } from "../../../core/public";
import type { C2M_RepairItems, M2C_RepairItems } from "../../../generated/model/server/demo/protocol/messages";
import type { NpcComponent } from "../npc/NpcComponent";
import type { PlayerUnit } from "../map/PlayerUnit";

export interface NpcRepairComponent {
  /** 在玩家有序 mailbox 中提交修理事务。 / Commits a repair transaction in the player's ordered mailbox. */
  Repair(player: PlayerUnit, request: C2M_RepairItems): Promise<M2C_RepairItems>;
}

/** 地图级中立修理服务；NPC 能力、物品状态、金币与持久化仍由各自组件拥有。 / Map-level neutral repair service; NPC capability, items, currency, and persistence remain owned by their components. */
@component()
@lifecycle({ awake: true })
export class NpcRepairComponent extends Component<[npc: NpcComponent]> {
  protected npc!: NpcComponent;
}
