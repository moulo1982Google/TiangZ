import {
  NativeUnitRef,
  NumericComponent,
  PositionComponent,
  SummonedUnit,
  type AwakeSummonedUnit,
  type SummonedUnitSnapshot,
  systemFor,
} from "#tiangz/model";

/** 召唤Unit只保存中立身份，实时位置和数值继续来自标准组件。 / Summoned Units keep neutral identity while standard components own live position and numerics. */
@systemFor(SummonedUnit)
export class SummonedUnitSystem extends SummonedUnit {
  protected override Awake(request: AwakeSummonedUnit): void {
    this.mapId = request.mapId;
    this.mapInstanceId = request.mapInstanceId;
    this.summonDefinitionId = request.summonDefinitionId;
    this.ownerUnitId = request.ownerUnitId;
    this.ownerPersistentId = request.ownerPersistentId;
    this.ownershipSlot = request.ownershipSlot;
    this.createdByAbilityId = request.createdByAbilityId;
    this.summonName = request.name;
    this.summonModelId = request.modelId;
  }

  Snapshot(): SummonedUnitSnapshot {
    const position = this.GetComponent(PositionComponent).snapshot();
    const native = this.GetComponent(NativeUnitRef);
    return {
      unitId: this.UnitId,
      summonDefinitionId: this.summonDefinitionId,
      ownerUnitId: this.ownerUnitId,
      ownerPersistentId: this.ownerPersistentId,
      ownershipSlot: this.ownershipSlot,
      createdByAbilityId: this.createdByAbilityId,
      name: this.summonName,
      modelId: this.summonModelId,
      ...position,
      speedCellsPerSecond: native.speedCellsPerSecond,
      facing: native.facing,
      alive: native.alive !== 0,
      numerics: this.GetComponent(NumericComponent).Snapshot(),
    };
  }

  protected override OnDestroy(): void {}
}
