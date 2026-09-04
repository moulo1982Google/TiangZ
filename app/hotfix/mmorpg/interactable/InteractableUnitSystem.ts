import {
  InteractableUnit,
  NormalizeInteractableRuntimeContentPatch,
  NativeUnitRef,
  PositionComponent,
  type AwakeInteractableUnit,
  type InteractableSnapshot,
  type InteractableRuntimeContentPatch,
  systemFor,
} from "#tiangz/model";

/** 可交互物体只保存稳定身份；位置快照始终读取当前Native状态。 / Interactables retain stable identity while snapshots read current Native state. */
@systemFor(InteractableUnit)
export class InteractableUnitSystem extends InteractableUnit {
  protected override Awake(request: AwakeInteractableUnit): void {
    this.mapId = request.mapId;
    this.mapInstanceId = request.mapInstanceId;
    this.interactableConfigId = request.interactableConfigId;
    this.name = request.name;
    this.presentationModelId = request.presentationModelId;
    this.interactionEnabled = request.interactionEnabled;
    this.interactionActionId = request.interactionActionId ?? 0;
    this.useRangeMeters = request.useRangeMeters;
    this.respawnDelayMs = request.respawnDelayMs;
    this.lootTableId = request.lootTableId ?? 0;
    this.questObjectiveTargetConfigId = request.questObjectiveTargetConfigId ?? 0;
    this.proficiencyId = request.proficiencyId ?? 0;
    this.requiredProficiencyRank = request.requiredProficiencyRank ?? 0;
    this.proficiencyGain = request.proficiencyGain ?? 0;
    this.rewards = request.rewards.map((reward) => Object.freeze({ ...reward }));
    this.baseQuestStarterConfigIds = Object.freeze([...(request.questStarterConfigIds ?? [])]);
    this.questStarterConfigIds = this.baseQuestStarterConfigIds;
  }

  ApplyRuntimeContentPatch(ownerId: string, patch: InteractableRuntimeContentPatch): boolean {
    const owner = requirePatchOwner(ownerId);
    const normalized = NormalizeInteractableRuntimeContentPatch(patch);
    const previous = this.runtimeContentPatches.get(owner);
    if (previous) {
      if (JSON.stringify(previous) === JSON.stringify(normalized)) return false;
      throw new Error(`interactable runtime content patch ${owner} is already active with different content`);
    }
    this.runtimeContentPatches.set(owner, normalized);
    this.RebuildRuntimeContent();
    return true;
  }

  RemoveRuntimeContentPatch(ownerId: string): boolean {
    const owner = requirePatchOwner(ownerId);
    if (!this.runtimeContentPatches.delete(owner)) return false;
    this.RebuildRuntimeContent();
    return true;
  }

  Snapshot(): InteractableSnapshot {
    const position = this.GetComponent(PositionComponent).snapshot();
    const native = this.GetComponent(NativeUnitRef);
    return {
      unitId: this.UnitId,
      interactableConfigId: this.interactableConfigId,
      name: this.name,
      presentationModelId: this.presentationModelId,
      ...position,
      speedCellsPerSecond: native.speedCellsPerSecond,
      facing: native.facing,
      alive: native.alive !== 0,
      questStarterConfigIds: [...this.questStarterConfigIds],
      runtimeProfileRevision: this.runtimeProfileRevision,
    };
  }

  protected override OnDestroy(): void {}

  private RebuildRuntimeContent(): void {
    const questStarterConfigIds = new Set(this.baseQuestStarterConfigIds);
    for (const patch of this.runtimeContentPatches.values()) {
      for (const value of patch.questStarterConfigIds ?? []) questStarterConfigIds.add(value);
    }
    this.questStarterConfigIds = Object.freeze(
      [...questStarterConfigIds].sort((left, right) => left - right),
    );
    this.runtimeProfileRevision = this.runtimeProfileRevision >= 0xffff_ffff
      ? 1
      : this.runtimeProfileRevision + 1;
  }
}

function requirePatchOwner(ownerId: string): string {
  const owner = ownerId?.trim();
  if (!owner || owner.length > 160) {
    throw new Error("interactable runtime content patch owner must be 1..160 characters");
  }
  return owner;
}
