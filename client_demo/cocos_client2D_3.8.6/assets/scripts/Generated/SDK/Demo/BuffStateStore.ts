import type {
  BuffDetailView,
  BuffPublicView,
  G2C_BuffAdded,
  G2C_BuffDetail,
  G2C_BuffRemoved,
  MapEntitySnapshot,
} from "../Generated/Model/demo/protocol/messages";

/**
 * 合并公开Buff事件与受限详情状态；revision墓碑可阻止迟到包复活已移除Buff。
 * 本类只保存协议视图，不包含Cocos、Pixi或其他引擎对象，可由所有TypeScript客户端复用。
 *
 * Merges public Buff events with restricted detail state. Revision tombstones
 * prevent late packets from resurrecting removed Buffs. This store is engine agnostic.
 */
export class BuffStateStore {
  private readonly publicViews = new Map<string, BuffPublicView>();
  private readonly detailViews = new Map<string, BuffDetailView>();
  private readonly removedRevisions = new Map<string, number>();

  /** 合并AOI进入快照中的公开Buff；快照不会授予队伍详情权限。 / Merges public Buffs from an AOI entry snapshot without granting detail visibility. */
  ApplySnapshot(entity: MapEntitySnapshot): void {
    for (const buff of entity.buffs) this.applyPublic(buff);
  }

  /** 应用不可覆盖的Buff创建事件。 / Applies a non-coalescing Buff creation event. */
  ApplyAdded(message: G2C_BuffAdded): void {
    this.applyPublic(message.buff);
  }

  /** 应用可帧内覆盖的详情状态；同一Buff只保留最高revision。 / Applies coalescible detail state and keeps the highest revision per Buff. */
  ApplyDetail(message: G2C_BuffDetail): void {
    for (const buff of message.buffs) {
      const key = buffKey(buff.unitId, buff.buffInstanceId);
      if (buff.revision <= (this.removedRevisions.get(key) ?? -1)) continue;
      const current = this.detailViews.get(key);
      if (current && current.revision > buff.revision) continue;
      this.detailViews.set(key, buff);
    }
  }

  /** 应用不可覆盖的移除事件并写入墓碑，避免旧Add/Detail乱序到达后复活。 / Applies removal and records a tombstone against stale Add/Detail packets. */
  ApplyRemoved(message: G2C_BuffRemoved): void {
    const key = buffKey(message.unitId, message.buffInstanceId);
    const newestRevision = Math.max(
      this.removedRevisions.get(key) ?? -1,
      this.publicViews.get(key)?.revision ?? -1,
      this.detailViews.get(key)?.revision ?? -1,
    );
    if (message.revision < newestRevision) return;
    this.removedRevisions.set(key, message.revision);
    this.publicViews.delete(key);
    this.detailViews.delete(key);
  }

  /** 返回一个Unit当前公开Buff的副本；调用方不得修改Store内部状态。 / Returns a copy of one Unit's public Buff views. */
  PublicOf(unitId: number): readonly BuffPublicView[] {
    return [...this.publicViews.values()].filter((buff) => buff.unitId === unitId);
  }

  /** 返回当前客户端有权看到的Buff详情；无权限与尚未收到都返回undefined。 / Returns visible detail, or undefined when unauthorized or not received. */
  DetailOf(unitId: number, buffInstanceId: bigint): BuffDetailView | undefined {
    return this.detailViews.get(buffKey(unitId, buffInstanceId));
  }

  /** Unit离开AOI时清理公开与详情视图；重进时由新快照重新建立。 / Clears all views when a Unit leaves AOI. */
  RemoveUnit(unitId: number): void {
    removeUnitEntries(this.publicViews, unitId);
    removeUnitEntries(this.detailViews, unitId);
    for (const key of this.removedRevisions.keys()) {
      if (key.startsWith(`${unitId}:`)) this.removedRevisions.delete(key);
    }
  }

  /** 清理地图级客户端状态。 / Clears all map-scoped client state. */
  Clear(): void {
    this.publicViews.clear();
    this.detailViews.clear();
    this.removedRevisions.clear();
  }

  private applyPublic(buff: BuffPublicView): void {
    const key = buffKey(buff.unitId, buff.buffInstanceId);
    if (buff.revision <= (this.removedRevisions.get(key) ?? -1)) return;
    const current = this.publicViews.get(key);
    if (current && current.revision > buff.revision) return;
    this.publicViews.set(key, buff);
  }
}

function buffKey(unitId: number, buffInstanceId: bigint): string {
  return `${unitId}:${buffInstanceId}`;
}

function removeUnitEntries<T extends { readonly unitId: number }>(
  entries: Map<string, T>,
  unitId: number,
): void {
  for (const [key, value] of entries) {
    if (value.unitId === unitId) entries.delete(key);
  }
}
