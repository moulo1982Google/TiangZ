import {
  GameConfigs,
  MonsterUnit,
  NativeUnitRef,
  NumericComponent,
  PositionComponent,
  type AwakeMonsterUnit,
  type MonsterSnapshot,
  systemFor,
} from "#tiangz/model";

/** 怪物Unit只保存稳定身份，表现快照由当前Native和Numeric状态即时构造。 / Keeps stable monster identity while building presentation snapshots from current Native and Numeric state. */
@systemFor(MonsterUnit)
export class MonsterUnitSystem extends MonsterUnit {
  /** 初始化刷怪点归属；不要在这里读取刷怪表或创建其他Unit。 / Initializes spawn ownership; do not load the spawn table or create other Units here. */
  protected override Awake(request: AwakeMonsterUnit): void {
    this.mapId = request.mapId;
    this.mapInstanceId = request.mapInstanceId;
    this.areaId = request.areaId;
    this.monsterConfigId = request.monsterConfigId;
  }

  /** 生成AOI进入和客户端渲染需要的怪物快照；不暴露Rust句柄。 / Builds the monster snapshot required by AOI entry and client rendering without exposing Native handles. */
  Snapshot(): MonsterSnapshot {
    const config = GameConfigs.MonsterConfig.Get(this.monsterConfigId);
    const position = this.GetComponent(PositionComponent).snapshot();
    const native = this.GetComponent(NativeUnitRef);
    return {
      unitId: this.UnitId,
      monsterConfigId: this.monsterConfigId,
      modelId: config.modelId,
      ...position,
      speedCellsPerSecond: native.speedCellsPerSecond,
      facing: native.facing,
      alive: native.alive !== 0,
      numerics: this.GetComponent(NumericComponent).Snapshot(),
    };
  }

  /** 组件销毁由Core按Unit所有权链完成；这里不重复释放Native子组件。 / Core destroys child components through the Unit ownership chain; this method does not double-release them. */
  protected override OnDestroy(): void {}
}
