import {
  Component,
  ClientAudience,
  Game,
  type Logger,
  type Unit,
  UnitComponent,
  component,
} from "../../../core/public";
import { NativeUnitRef } from "../../../generated/model/native/NativeUnitRef";
import type { MapInstanceDefinition } from "./MapInstance";
import { MapScene } from "./MapScene";
import { NativeData, type NativeAoiRelation, type NativeAoiVisibilityChange } from "../native/NativeData";
import { GameConfigs, SpatialMode } from "../../../generated/model/config";

export interface IAoiVisibilityFilter {
  /**
   * 同步判断 Observer 是否能看见 Subject；禁止 Promise、RPC、数据库、发消息或修改 Entity。
   * Synchronously decides whether an observer can see a subject. Promise, RPC, database access,
   * messaging, and Entity mutation are forbidden here.
   */
  CanObserve(observer: Unit<any[]>, subject: Unit<any[]>): boolean;
}

export interface AoiVisibilityDelta {
  readonly observerId: number;
  readonly subjectId: number;
  readonly visible: boolean;
}

/**
 * 地图业务可见性入口。业务从 MapComponent.Audience 取得本组件，只选择逻辑受众或使关系失效；
 * 不得直接调用 NativeData、保存 EntityIndex，或自行维护一份可见集合。
 *
 * Map-local business visibility entrypoint. Obtain it through MapComponent.Audience to select a
 * logical audience or invalidate relations; never call NativeData, retain EntityIndex values, or
 * maintain a second visibility set in business code.
 */
@component()
export class MapAoiComponent extends Component<[definition: MapInstanceDefinition]> {
  private nativeMapKey = 0;
  private logger!: Logger;
  private readonly filters = new Set<IAoiVisibilityFilter>();
  private readonly attachedUnitIds = new Set<number>();

  /** 从冷配置创建地图实例私有 AOI；Enter/Detach 与同步频率独立。 / Creates a map AOI from cold config with independent visibility and sync ranges. */
  protected override Awake(definition: MapInstanceDefinition): void {
    this.nativeMapKey = this.DomainScene().InstanceId;
    this.logger = this.DomainScene<MapScene>().logger.child({
      mapId: definition.mapConfigId,
      mapInstanceId: definition.mapInstanceId.toString(),
      system: "aoi",
    });
    const config = GameConfigs.MapConfig.Get(definition.mapConfigId);
    const aoi = config.aoiConfigId_ref;
    if (!aoi) throw new Error(`map ${config.id} has no AOI config`);
    const fixedUpdateMs = Game.Instance.FixedUpdateMs;
    const ticksPerSecond = 1_000 / fixedUpdateMs;
    const syncTiers = GameConfigs.AoiSyncTierConfig.GetAll()
      .filter((tier) => tier.aoiConfigId === aoi.id)
      .sort((left, right) => left.rangeGrids - right.rangeGrids)
      .map((tier) => {
        const intervalTicks = ticksPerSecond / tier.syncHz;
        if (!Number.isSafeInteger(intervalTicks) || intervalTicks <= 0) {
          throw new Error(
            `AOI sync ${tier.syncHz}Hz must divide Process fixed tick ${ticksPerSecond}Hz exactly`,
          );
        }
        return {
          radiusGrids: (tier.rangeGrids - 1) / 2,
          intervalTicks,
        };
      });
    if (config.spatialMode === SpatialMode.Grid2D) {
      NativeData.CreateGrid2DSpatial(
        this.nativeMapKey,
        config.widthCells,
        config.depthCells,
        config.cellSizeMeters,
      );
    } else if (config.spatialMode === SpatialMode.NavMesh3D) {
      NativeData.CreateNavMesh3DSpatial(
        this.nativeMapKey,
        config.widthCells,
        config.depthCells,
        config.cellSizeMeters,
        config.navigationAsset,
        config.navigationHash,
      );
    } else {
      throw new Error(`map ${config.id} has unsupported spatial mode: ${config.spatialMode}`);
    }
    try {
      NativeData.CreateAoi(
        this.nativeMapKey,
        config.cellSizeMeters * aoi.gridSizeCells,
        (aoi.enterRangeGrids - 1) / 2,
        (aoi.detachRangeGrids - 1) / 2,
        syncTiers,
      );
    } catch (error) {
      NativeData.ReleaseSpatial(this.nativeMapKey);
      throw error;
    }
  }

  /** 注册地图级业务过滤器，通常只在地图初始化时调用一次；不能在每个Handler中重复注册。 / Registers a map-level filter once during map setup, never once per handler call. */
  AddFilter(filter: IAoiVisibilityFilter): void {
    this.filters.add(filter);
  }

  /** 移除过滤器不会自动扩大视野；调用方必须随后 Invalidate 受影响实体。 / Removing a filter does not expand visibility automatically; callers must invalidate affected entities. */
  RemoveFilter(filter: IAoiVisibilityFilter): boolean {
    return this.filters.delete(filter);
  }

  /** 完整 Unit 组件图提交后加入 AOI。新 Observer 的初始实体由客户端就绪确认后的 AoiDelta 推送。 / Attaches a fully committed Unit; the new Observer receives initial entities through AoiDelta after client readiness. */
  Attach(
    unit: Unit<any[]>,
    deliveryRouteId: number,
    observer = true,
    subject = true,
  ): readonly AoiVisibilityDelta[] {
    if (!Number.isSafeInteger(deliveryRouteId) || deliveryRouteId < 0) {
      throw new Error(`invalid AOI delivery route id: ${deliveryRouteId}`);
    }
    if (observer && deliveryRouteId === 0) {
      throw new Error(`AOI observer ${unit.UnitId} needs a delivery route`);
    }
    const proposed = NativeData.AttachAoi(
      this.nativeMapKey,
      unit.GetComponent(NativeUnitRef).Handle,
      observer,
      subject,
      deliveryRouteId,
    );
    this.ApplyFilters(proposed);
    this.attachedUnitIds.add(unit.UnitId);
    return this.CommitChanges(unit.UnitId);
  }

  /** 在 Native Unit 销毁前移出 AOI；离开的 Observer 不会收到自己的 Leave。 / Detaches before Native Unit destruction and suppresses leave messages to the departing observer itself. */
  Detach(unit: Unit<any[]>): readonly AoiVisibilityDelta[] {
    const changes = NativeData.DetachAoi(
      this.nativeMapKey,
      unit.GetComponent(NativeUnitRef).Handle,
    );
    this.attachedUnitIds.delete(unit.UnitId);
    return this.ApplyPublishedChanges(changes, unit.UnitId);
  }

  /** 刷新 FastOP 写入造成的跨 AOI Grid 变化，并运行同步业务过滤器。 / Refreshes cross-grid FastOP writes and runs synchronous business filters. */
  Refresh(): readonly AoiVisibilityDelta[] {
    const proposed = NativeData.RefreshAoi(this.nativeMapKey);
    this.ApplyFilters(proposed);
    return this.CommitChanges();
  }

  /** 当“该Unit能看见谁”改变时重算关系；调用方还必须把返回值交给MapComponent.PublishVisibilityChanges。 / Reevaluates whom this Unit can see; callers must also publish the result through MapComponent.PublishVisibilityChanges. */
  InvalidateObserver(unit: Unit<any[]>): readonly AoiVisibilityDelta[] {
    return this.InvalidateRelations(unit.UnitId, 1);
  }

  /** 当“谁能看见该Unit”改变时重算关系；调用方还必须发布返回的Enter/Leave。 / Reevaluates who can see this Unit; callers must also publish the returned enters/leaves. */
  InvalidateSubject(unit: Unit<any[]>): readonly AoiVisibilityDelta[] {
    return this.InvalidateRelations(unit.UnitId, 2);
  }

  /** 同时重算两个方向；返回值只描述变化，不会自行发送，必须由MapComponent发布。 / Reevaluates both directions; the returned changes are not sent until MapComponent publishes them. */
  Invalidate(unit: Unit<any[]>): readonly AoiVisibilityDelta[] {
    return this.InvalidateRelations(unit.UnitId, 3);
  }

  /** 返回 Observer 的自身加最终可见 UnitId，用于权威进入快照。 / Returns self plus final visible Unit ids for an authoritative entry snapshot. */
  VisibleUnitIds(observerId: number): readonly number[] {
    return [observerId, ...NativeData.VisibleAoiSubjects(this.nativeMapKey, observerId)];
  }

  /** 返回“Observer正在看谁”，适合权威查询或面向其视野对象的操作；不要用于广播Subject自身表现。 / Returns whom an observer sees for authoritative queries or visible-subject operations; do not use it to broadcast a subject's appearance. */
  VisibleSubjectsOf(observer: Unit<any[]>, includeSelf = true): ClientAudience {
    this.requireAttachedUnit(observer);
    return ClientAudience.ForUnits(
      `map:${this.DomainScene().InstanceId}:visible-subjects:${observer.UnitId}:${includeSelf}`,
      includeSelf
        ? [observer.UnitId, ...NativeData.VisibleAoiSubjects(this.nativeMapKey, observer.UnitId)]
        : NativeData.VisibleAoiSubjects(this.nativeMapKey, observer.UnitId),
    );
  }

  /** 返回“谁正在看Subject”，公开Buff、施法外观和头顶状态等广播通常使用这个方向。 / Returns who sees a subject; public Buff, cast-visual, and overhead-state broadcasts normally use this direction. */
  ObserversOf(subject: Unit<any[]>, includeSelf = true): ClientAudience {
    this.requireAttachedUnit(subject);
    return ClientAudience.ForUnits(
      `map:${this.DomainScene().InstanceId}:observers-of:${subject.UnitId}:${includeSelf}`,
      includeSelf
        ? [subject.UnitId, ...NativeData.VisibleAoiObservers(this.nativeMapKey, subject.UnitId)]
        : NativeData.VisibleAoiObservers(this.nativeMapKey, subject.UnitId),
    );
  }

  private InvalidateRelations(unitId: number, mode: 1 | 2 | 3): readonly AoiVisibilityDelta[] {
    const relations = NativeData.QueryAoiRelations(this.nativeMapKey, unitId, mode);
    this.ApplyRelationFilters(relations);
    return this.CommitChanges();
  }

  private requireAttachedUnit(unit: Unit<any[]>): void {
    if (unit.DomainScene() !== this.DomainScene()) {
      throw new Error(`AOI Unit ${unit.UnitId} belongs to another map`);
    }
    if (!this.attachedUnitIds.has(unit.UnitId)) {
      throw new Error(`AOI Unit ${unit.UnitId} is not attached`);
    }
  }

  private ApplyFilters(changes: readonly NativeAoiVisibilityChange[]): void {
    this.ApplyRelationFilters(
      changes
        .filter((change) => change.visible)
        .map(({ observerId, subjectId }) => ({ observerId, subjectId })),
    );
  }

  private ApplyRelationFilters(relations: readonly NativeAoiRelation[]): void {
    if (this.filters.size === 0) return;
    for (const relation of relations) {
      const observer = this.units.Get(relation.observerId);
      const subject = this.units.Get(relation.subjectId);
      let visible = observer !== undefined && subject !== undefined;
      if (visible) {
        for (const filter of this.filters) {
          try {
            const accepted = filter.CanObserve(observer!, subject!);
            if (typeof accepted !== "boolean") {
              throw new Error("AOI visibility filter must return boolean synchronously");
            }
            if (!accepted) {
              visible = false;
              break;
            }
          } catch (error) {
            visible = false;
            this.logger.error("AOI visibility filter failed closed", {
              observerId: relation.observerId,
              subjectId: relation.subjectId,
              filter: filter.constructor.name,
              error,
            });
            break;
          }
        }
      }
      NativeData.SetAoiVisible(
        this.nativeMapKey,
        relation.observerId,
        relation.subjectId,
        visible,
      );
    }
  }

  private CommitChanges(suppressObserverId?: number): readonly AoiVisibilityDelta[] {
    return this.ApplyPublishedChanges(
      NativeData.TakeAoiChanges(this.nativeMapKey),
      suppressObserverId,
    );
  }

  private ApplyPublishedChanges(
    changes: readonly NativeAoiVisibilityChange[],
    suppressObserverId?: number,
  ): readonly AoiVisibilityDelta[] {
    return suppressObserverId === undefined
      ? changes
      : changes.filter((change) => change.observerId !== suppressObserverId);
  }

  protected override OnDestroy(): void {
    this.attachedUnitIds.clear();
    NativeData.ReleaseAoi(this.nativeMapKey);
    NativeData.ReleaseSpatial(this.nativeMapKey);
  }

  private get units(): UnitComponent {
    return this.DomainScene().GetComponent(UnitComponent);
  }
}
