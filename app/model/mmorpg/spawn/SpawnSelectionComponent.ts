import { Component, component, lifecycle } from "../../../core/public";
import type { InteractableComponent } from "../interactable/InteractableComponent";
import type { MonsterComponent } from "../monster/MonsterComponent";
import type { SpawnSelectionEntityCandidateKindValue } from "./SpawnSelectionContentProfileComponent";

export interface SpawnSelectionComponent {
  Owns(kind: SpawnSelectionEntityCandidateKindValue, spawnId: number): boolean;
  OwnsGroup(groupId: string): boolean;
  /** 显式启用一个受外部条件控制的根组；已启用时保持幂等。 / Explicitly enables a condition-controlled root group; idempotent while enabled. */
  ActivateGroup(groupId: string): boolean;
  /** 显式停用根组并递归移除当前子树；已停用时保持幂等。 / Explicitly disables a root group and recursively removes its selected subtree; idempotent while disabled. */
  DeactivateGroup(groupId: string): boolean;
  /** 活跃候选进入冷却；到期时所在组重新抽取。 / Moves an active candidate into cooldown; its group reselects when due. */
  Release(kind: SpawnSelectionEntityCandidateKindValue, spawnId: number, eligibleAtMs: number): boolean;
}

/** 地图级中立刷点选择运行时。 / Map-level neutral spawn-selection runtime. */
@component()
@lifecycle({ awake: true })
export class SpawnSelectionComponent extends Component<[
  monster: MonsterComponent,
  interactable: InteractableComponent,
]> {
  /** 热更实现拥有的中立状态机，不暴露到稳定 API。 / Neutral state-machine storage owned by the hotfix implementation and hidden from Stable API. */
  protected runtimeState: unknown;
}
