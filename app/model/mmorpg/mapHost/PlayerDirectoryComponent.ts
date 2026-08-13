import { Component } from "../../../core/public";
import { PlayerUnit } from "../map/PlayerUnit";

export class PlayerDirectoryComponent extends Component {
  private readonly playersByCharacterId = new Map<bigint, PlayerUnit>();

  /** 添加角色重连索引；普通Actor分发仍必须使用InstanceId。 / Adds a character reconnect index; ordinary Actor dispatch still uses InstanceId. */
  Add(unit: PlayerUnit): void {
    const existing = this.Get(unit.CharacterId);
    if (existing && existing !== unit) {
      throw new Error(`player character already exists: ${unit.CharacterId}`);
    }
    this.playersByCharacterId.set(unit.CharacterId, unit);
  }

  /** 解析角色重连状态，并顺便移除已销毁的过期条目。 / Resolves character state and removes stale disposed entries opportunistically. */
  Get(characterId: bigint): PlayerUnit | undefined {
    const unit = this.playersByCharacterId.get(characterId);
    if (!unit) return undefined;
    if (unit.IsDisposed) {
      this.playersByCharacterId.delete(characterId);
      return undefined;
    }
    return unit;
  }

  /** 仅当目录仍指向同一个Unit对象时才移除，避免旧清理误删新连接。 / Removes only while the directory still points to the same Unit, preventing stale cleanup from deleting a replacement. */
  Remove(unit: PlayerUnit): boolean {
    if (this.playersByCharacterId.get(unit.CharacterId) !== unit) return false;
    return this.playersByCharacterId.delete(unit.CharacterId);
  }

  /** 仅当目录仍指向源Unit时原子替换为目标Unit，作为同进程迁移提交点。 / Atomically replaces the source Unit with the target only while the directory still points to the source, forming the in-process migration commit point. */
  Replace(source: PlayerUnit, target: PlayerUnit): boolean {
    if (source.CharacterId !== target.CharacterId || source.UnitId !== target.UnitId) {
      throw new Error("player directory replacement identity mismatch");
    }
    if (this.playersByCharacterId.get(source.CharacterId) !== source) return false;
    this.playersByCharacterId.set(target.CharacterId, target);
    return true;
  }

  /** 返回当前仍可解析的玩家快照，用于停机保存和Location恢复；调用方不得长期保存该数组。 / Returns currently resolvable players for shutdown persistence and Location recovery; callers must not retain the array. */
  GetAll(): readonly PlayerUnit[] {
    const players: PlayerUnit[] = [];
    for (const characterId of [...this.playersByCharacterId.keys()]) {
      const player = this.Get(characterId);
      if (player) players.push(player);
    }
    return players;
  }

  protected override OnDestroy(): void {
    this.playersByCharacterId.clear();
  }
}
