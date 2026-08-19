import { Component, component, lifecycle } from "../../../core/public";
import type { MapComponent } from "../map/MapComponent";
import type { PlayerUnit } from "../map/PlayerUnit";
import type { SkillCastCommand, SkillCastState } from "./SkillComponent";
import type { SkillDefinition } from "./SkillDefinition";

/** 飞行法术保存ID、截止时间和发射时冻结的纯规则；Unit仍按ID重取。 / Projectiles retain ids, deadlines, and pure launch-time rules while resolving Units by id. */
export interface SkillProjectile {
  readonly castId: bigint;
  readonly skillId: number;
  readonly sourceUnitId: number;
  readonly targetUnitId: number;
  readonly launchedAtMs: number;
  readonly impactAtMs: number;
  readonly definition: SkillDefinition;
}

export interface SkillMapComponent {
  Cast(caster: PlayerUnit, command: SkillCastCommand): SkillCastState;
  InterruptByMovement(caster: PlayerUnit): boolean;
  HandleDamageDuringCast(target: PlayerUnit): boolean;
}

/** 一张地图只有一个技能调度桶；业务Unit持状态，但不成为Update目标。 / One skill scheduler exists per map; Units own state without becoming Update targets. */
@component()
@lifecycle({ awake: true, destroy: true })
export class SkillMapComponent extends Component<[map: MapComponent]> {
  protected map!: MapComponent;
  protected readonly activeCasterUnitIds = new Set<number>();
  protected readonly projectiles = new Map<bigint, SkillProjectile>();
  /** 高频技能表现共享一个SceneTask排空器，避免每次发布各占一个Hotfix屏障槽位。 / High-frequency skill visuals share one SceneTask drain instead of consuming one Hotfix barrier slot per publish. */
  protected readonly pendingPublishes = new Set<Promise<void>>();
  protected publishDrainActive = false;
  /** 地图私有的技能配置索引；避免Hotfix模块级可变缓存，也避免每次Cast重建。 / Map-owned skill config index; avoids mutable Hotfix module state without rebuilding on every Cast. */
  protected skillCatalogFingerprint = "";
  protected skillCatalogDefinitions: ReadonlyMap<number, SkillDefinition> | undefined;

}
