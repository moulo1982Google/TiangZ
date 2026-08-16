import {
  NativeUnitRef,
  NpcUnit,
  PositionComponent,
  type AwakeNpcUnit,
  type NpcSnapshot,
  systemFor,
} from "#tiangz/model";

/** NPC Unit只保存稳定身份；位置和可见状态快照由当前Native组件即时构造。 / NPC Units keep stable identity while presentation snapshots read current Native state. */
@systemFor(NpcUnit)
export class NpcUnitSystem extends NpcUnit {
  /** 初始化NPC归属和可提供任务；不要在Unit Awake内创建其他Unit。 / Initializes NPC ownership and offered quests; never creates another Unit from Unit Awake. */
  protected override Awake(request: AwakeNpcUnit): void {
    this.mapId = request.mapId;
    this.mapInstanceId = request.mapInstanceId;
    this.npcConfigId = request.npcConfigId;
    this.name = request.name;
    this.questConfigIds = [...request.questConfigIds];
    this.shopEnabled = request.shopEnabled;
  }

  /** 生成AOI进入所需的NPC快照；不暴露Native句柄和服务端交互规则。 / Builds the NPC AOI snapshot without exposing Native handles or server interaction rules. */
  Snapshot(): NpcSnapshot {
    const position = this.GetComponent(PositionComponent).snapshot();
    const native = this.GetComponent(NativeUnitRef);
    return {
      unitId: this.UnitId,
      npcConfigId: this.npcConfigId,
      name: this.name,
      questConfigIds: [...this.questConfigIds],
      shopEnabled: this.shopEnabled,
      ...position,
      speedCellsPerSecond: native.speedCellsPerSecond,
      facing: native.facing,
      alive: native.alive !== 0,
      numerics: [],
    };
  }

  /** NativeUnitRef由Core沿Unit所有权链销毁；NPC系统只清理自身业务字段。 / Core destroys NativeUnitRef through Unit ownership; the system only clears business fields. */
  protected override OnDestroy(): void {}
}
