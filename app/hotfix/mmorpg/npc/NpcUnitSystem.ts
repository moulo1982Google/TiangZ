import {
  NativeUnitRef,
  NpcUnit,
  NormalizeNpcRuntimeContentPatch,
  NumericComponent,
  PositionComponent,
  type AwakeNpcUnit,
  type NpcSnapshot,
  type NpcRuntimeContentPatch,
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
    this.basePresentationModelId = normalizeOptionalPresentationId(
      request.presentationModelId,
      "NPC presentation model",
    );
    this.basePresentationLoadoutId = normalizeOptionalPresentationId(
      request.presentationLoadoutId,
      "NPC presentation loadout",
    );
    this.npcPresentationStateId = request.presentationStateId ?? 0;
    this.baseQuestStarterConfigIds = freezePositiveIds(request.questStarterConfigIds, "quest starter");
    this.baseQuestEnderConfigIds = freezePositiveIds(request.questEnderConfigIds, "quest ender");
    this.baseShopItemConfigIds = freezePositiveIds(request.shopItemConfigIds, "shop item");
    this.trainerId = request.trainerId;
    this.baseShopEnabled = request.shopEnabled;
    this.baseRepairEnabled = request.repairEnabled;
    this.baseConversationEnabled = request.conversationEnabled ?? false;
    this.baseTrainingEnabled = request.trainingEnabled ?? request.trainerId > 0;
    this.baseRecoveryEnabled = request.recoveryEnabled ?? false;
    this.RebuildRuntimeContent(false);
  }

  /** 为迟到 AOI 观察者保存或清除持续动画状态。 / Stores or clears a persistent animation state for late AOI observers. */
  SetPresentationState(presentationStateId: number): void {
    if (!Number.isSafeInteger(presentationStateId) || presentationStateId < 0) {
      throw new Error(`NPC presentation state must not be negative: ${presentationStateId}`);
    }
    this.npcPresentationStateId = presentationStateId;
  }

  ApplyRuntimeContentPatch(ownerId: string, patch: NpcRuntimeContentPatch): boolean {
    const owner = requirePatchOwner(ownerId);
    const normalized = NormalizeNpcRuntimeContentPatch(patch);
    const previous = this.runtimeContentPatches.get(owner);
    if (previous) {
      if (JSON.stringify(previous) === JSON.stringify(normalized)) return false;
      throw new Error(`NPC runtime content patch ${owner} is already active with different content`);
    }
    this.runtimeContentPatches.set(owner, normalized);
    try {
      this.RebuildRuntimeContent(true);
    } catch (error) {
      this.runtimeContentPatches.delete(owner);
      throw error;
    }
    return true;
  }

  RemoveRuntimeContentPatch(ownerId: string): boolean {
    const owner = requirePatchOwner(ownerId);
    if (!this.runtimeContentPatches.delete(owner)) return false;
    this.RebuildRuntimeContent(true);
    return true;
  }

  /** 生成AOI进入所需的NPC快照；不暴露Native句柄和服务端交互规则。 / Builds the NPC AOI snapshot without exposing Native handles or server interaction rules. */
  Snapshot(): NpcSnapshot {
    const position = this.GetComponent(PositionComponent).snapshot();
    const native = this.GetComponent(NativeUnitRef);
    return {
      unitId: this.UnitId,
      npcConfigId: this.npcConfigId,
      name: this.name,
      questConfigIds: [...new Set([
        ...this.questStarterConfigIds,
        ...this.questEnderConfigIds,
      ])],
      shopEnabled: this.shopEnabled,
      questStarterConfigIds: [...this.questStarterConfigIds],
      questEnderConfigIds: [...this.questEnderConfigIds],
      shopItemConfigIds: [...this.shopItemConfigIds],
      trainerId: this.trainerId,
      questEnabled: this.questEnabled,
      conversationEnabled: this.conversationEnabled,
      trainingEnabled: this.trainingEnabled,
      repairEnabled: this.repairEnabled,
      recoveryEnabled: this.recoveryEnabled,
      presentationModelId: this.presentationModelId,
      presentationStateId: this.npcPresentationStateId,
      presentationLoadoutId: this.presentationLoadoutId,
      extensionCapabilities: [...this.extensionCapabilities],
      runtimeProfileRevision: this.runtimeProfileRevision,
      ...position,
      speedCellsPerSecond: native.speedCellsPerSecond,
      facing: native.facing,
      alive: native.alive !== 0,
      // 服务型NPC通常没有Numeric；模块组合了战斗/资源能力时，同一快照自动公开允许AOI复制的数值。
      // Service-only NPCs normally have no Numeric component. When a module
      // composes combat/resource capabilities, the same snapshot exposes the
      // Numeric values allowed by the AOI replication policy.
      numerics: this.TryGetComponent(NumericComponent)?.Snapshot() ?? [],
    };
  }

  /** NativeUnitRef由Core沿Unit所有权链销毁；NPC系统只清理自身业务字段。 / Core destroys NativeUnitRef through Unit ownership; the system only clears business fields. */
  protected override OnDestroy(): void {}

  private RebuildRuntimeContent(incrementRevision: boolean): void {
    const starters = new Set(this.baseQuestStarterConfigIds);
    const enders = new Set(this.baseQuestEnderConfigIds);
    const shopItems = new Set(this.baseShopItemConfigIds);
    const extensionCapabilities = new Set<string>();
    const modelIds = new Set<string>();
    const loadoutIds = new Set<string>();
    let questEnabled = starters.size > 0 || enders.size > 0;
    let conversationEnabled = this.baseConversationEnabled;
    let shopEnabled = this.baseShopEnabled;
    let trainingEnabled = this.baseTrainingEnabled;
    let repairEnabled = this.baseRepairEnabled;
    let recoveryEnabled = this.baseRecoveryEnabled;
    for (const patch of this.runtimeContentPatches.values()) {
      for (const value of patch.questStarterConfigIds ?? []) starters.add(value);
      for (const value of patch.questEnderConfigIds ?? []) enders.add(value);
      for (const value of patch.shopItemConfigIds ?? []) shopItems.add(value);
      for (const value of patch.extensionCapabilities ?? []) extensionCapabilities.add(value);
      if (patch.questEnabled) questEnabled = true;
      if (patch.conversationEnabled) conversationEnabled = true;
      if (patch.shopEnabled) shopEnabled = true;
      if (patch.trainingEnabled) trainingEnabled = true;
      if (patch.repairEnabled) repairEnabled = true;
      if (patch.recoveryEnabled) recoveryEnabled = true;
      if (patch.presentationModelId) modelIds.add(patch.presentationModelId);
      if (patch.presentationLoadoutId) loadoutIds.add(patch.presentationLoadoutId);
    }
    if (modelIds.size > 1) throw new Error("NPC runtime content has conflicting model overrides");
    if (loadoutIds.size > 1) throw new Error("NPC runtime content has conflicting loadout overrides");
    if (trainingEnabled && this.trainerId <= 0) {
      throw new Error("NPC runtime content cannot enable training without a trainer profile");
    }
    this.questStarterConfigIds = Object.freeze([...starters].sort((left, right) => left - right));
    this.questEnderConfigIds = Object.freeze([...enders].sort((left, right) => left - right));
    this.shopItemConfigIds = Object.freeze([...shopItems].sort((left, right) => left - right));
    this.questEnabled = questEnabled || starters.size > 0 || enders.size > 0;
    this.conversationEnabled = conversationEnabled;
    this.shopEnabled = shopEnabled;
    this.trainingEnabled = trainingEnabled;
    this.repairEnabled = repairEnabled;
    this.recoveryEnabled = recoveryEnabled;
    this.presentationModelId = [...modelIds][0] ?? this.basePresentationModelId;
    this.presentationLoadoutId = [...loadoutIds][0] ?? this.basePresentationLoadoutId;
    this.extensionCapabilities = Object.freeze([...extensionCapabilities].sort((left, right) => left.localeCompare(right, "en")));
    if (incrementRevision) {
      this.runtimeProfileRevision = this.runtimeProfileRevision >= 0xffff_ffff
        ? 1
        : this.runtimeProfileRevision + 1;
    }
  }
}

function normalizeOptionalPresentationId(value: string | undefined, label: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 128) {
    throw new Error(`${label} must be 1..128 characters when present`);
  }
  return normalized;
}

function freezePositiveIds(values: readonly number[], label: string): readonly number[] {
  if (!Array.isArray(values)) throw new Error(`NPC runtime ${label} IDs must be an array`);
  const result = [...new Set(values)];
  for (const value of result) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`NPC runtime ${label} ID must be positive`);
  }
  return Object.freeze(result.sort((left, right) => left - right));
}

function requirePatchOwner(ownerId: string): string {
  const owner = ownerId?.trim();
  if (!owner || owner.length > 160) throw new Error("NPC runtime content patch owner must be 1..160 characters");
  return owner;
}
