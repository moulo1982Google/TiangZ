import { Component, component } from "../../../core/public";

/** 怪物出生与Evade回巢共享的米制坐标。 / Meter-based position shared by monster spawn and Evade return. */
export interface MonsterSpawnPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
}

/**
 * 怪物工厂与外置内容模块之间的中立刷点边界。默认值来自MonsterAreaConfig；一个游戏模块可在Unit
 * 发布前替换它，之后出生、追击距离与回巢始终读取同一份资料。
 *
 * Neutral spawn boundary between the monster factory and external content.
 * Defaults come from MonsterAreaConfig; one game module may replace them before
 * publication, after which spawn, leash distance, and return-home share one value.
 */
@component()
export class MonsterSpawnProfileComponent extends Component {
  private point: Readonly<MonsterSpawnPoint> | undefined;
  private ownerId = "";

  get Point(): Readonly<MonsterSpawnPoint> {
    if (!this.point) throw new Error("monster spawn profile is not initialized");
    return this.point;
  }

  Initialize(point: MonsterSpawnPoint): void {
    if (this.point) throw new Error("monster spawn profile is already initialized");
    this.point = freezeSpawnPoint(point);
  }

  Override(ownerId: string, point: MonsterSpawnPoint): void {
    if (!this.point) throw new Error("monster spawn profile is not initialized");
    const owner = ownerId?.trim();
    if (!owner) throw new Error("monster spawn profile owner id must not be empty");
    if (this.ownerId) {
      throw new Error(`monster spawn profile already belongs to ${this.ownerId}`);
    }
    this.point = freezeSpawnPoint(point);
    this.ownerId = owner;
  }
}

function freezeSpawnPoint(point: MonsterSpawnPoint): Readonly<MonsterSpawnPoint> {
  if (!point || typeof point !== "object") throw new Error("monster spawn point must be an object");
  for (const [label, value] of Object.entries(point)) {
    if (!Number.isFinite(value)) throw new Error(`monster spawn ${label} must be finite: ${value}`);
  }
  return Object.freeze({ x: point.x, y: point.y, z: point.z, yaw: point.yaw });
}
