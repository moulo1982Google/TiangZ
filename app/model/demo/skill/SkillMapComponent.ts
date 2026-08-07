import { Component, component, lifecycle } from "../../../core/public";
import type { MapComponent } from "../map/MapComponent";
import type { PlayerUnit } from "../map/PlayerUnit";
import type { SkillCastCommand, SkillCastState } from "./SkillComponent";

/** 地图级飞行法术只保存ID与截止时间；每次Tick重新解析Unit。 / Map-level projectiles retain ids and deadlines only, resolving Units on every tick. */
export interface SkillProjectile {
  readonly castId: bigint;
  readonly skillId: number;
  readonly sourceUnitId: number;
  readonly targetUnitId: number;
  readonly launchedAtMs: number;
  readonly impactAtMs: number;
}

export interface SkillMapComponent {
  Cast(caster: PlayerUnit, command: SkillCastCommand): SkillCastState;
  InterruptByMovement(caster: PlayerUnit): boolean;
}

/** 一张地图只有一个技能调度桶；业务Unit持状态，但不成为Update目标。 / One skill scheduler exists per map; Units own state without becoming Update targets. */
@component()
@lifecycle({ awake: true, destroy: true })
export class SkillMapComponent extends Component<[map: MapComponent]> {
  protected map!: MapComponent;
  protected readonly activeCasterUnitIds = new Set<number>();
  protected readonly projectiles = new Map<bigint, SkillProjectile>();

}
