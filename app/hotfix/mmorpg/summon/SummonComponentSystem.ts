import {
  BuffComponent,
  CombatComponent,
  DamageSchool,
  MapAoiComponent,
  MapComponent,
  MonsterComponent,
  MonsterUnit,
  MoveSpeedMetersPerSecondToNumeric,
  NativeData,
  NativeUnitRef,
  NpcUnit,
  NumericComponent,
  NumericRegenerationComponent,
  NumericType,
  PlayerUnit,
  PositionComponent,
  SkillComponent,
  SkillMapComponent,
  SpatialMode,
  SummonComponent,
  SummonedUnit,
  TimeSystem,
  UnitComponent,
  applyEntityExtensions,
  systemFor,
  type OwnedSummonDefinition,
  type OwnedSummonTransferState,
  OwnedUnitCommand,
  type OwnedUnitCommandValue,
  OwnedUnitReaction,
  type OwnedUnitReactionValue,
  type SummonOwnedUnitRequest,
  type SummonOwnerUnit,
  type SummonRuntimeState,
} from "#tiangz/model";

const SUMMON_UNIT_ID_MAX = 0xffff_ffff;
const SUMMON_THINK_INTERVAL_MS = 250;

/** 中立Unit召唤物生命周期与简单跟随/协战；游戏特有宠物规则由模块提供定义。 / Neutral Unit-summon lifecycle and basic follow/assist; modules provide game-specific pet definitions. */
@systemFor(SummonComponent)
export class SummonComponentSystem extends SummonComponent {
  protected override Awake(map: MapComponent, aoi: MapAoiComponent): void {
    this.map = map;
    this.aoi = aoi;
    this.units = this.DomainScene().GetComponent(UnitComponent);
  }

  SummonOwnedUnit(owner: SummonOwnerUnit, request: SummonOwnedUnitRequest): SummonedUnit {
    this.RequireMapUnit(owner);
    validateOwnershipSlot(request.ownershipSlot);
    validateAbilityId(request.createdByAbilityId, "createdByAbilityId");
    const definition = freezeDefinition(request.definition);
    const reaction = request.reaction ?? definition.initialReaction;
    validateReaction(reaction);
    const autoCastAbilityIds = normalizeAutoCastAbilityIds(
      definition,
      request.autoCastAbilityIds,
    );
    if (owner.GetComponent(NativeUnitRef).alive === 0) {
      throw new Error(`dead owner ${owner.UnitId} cannot create a summon`);
    }

    const unitId = this.AllocateUnitId();
    const summon = this.units.Create(unitId, SummonedUnit, {
      mapId: this.map.MapId,
      mapInstanceId: this.map.MapInstanceId,
      summonDefinitionId: definition.id,
      ownerUnitId: owner.UnitId,
      ownerPersistentId: owner instanceof PlayerUnit ? owner.CharacterId : 0n,
      ownershipSlot: request.ownershipSlot,
      createdByAbilityId: request.createdByAbilityId,
      name: definition.name,
      modelId: definition.modelId,
    });
    try {
      this.ComposeSummon(summon, owner, definition);
    } catch (error) {
      this.units.Remove(unitId);
      throw error;
    }

    const changes = [...this.aoi.Attach(summon, 0, false, true)];
    const key = ownerSlotKey(owner.UnitId, request.ownershipSlot);
    const existingId = this.summonUnitIdByOwnerSlot.get(key);
    if (existingId !== undefined) {
      const existing = this.summons.get(existingId);
      if (existing) changes.push(...this.RemoveSummon(existing));
    }
    this.summons.set(unitId, summon);
    this.runtime.set(unitId, {
      summon,
      ownerUnitId: owner.UnitId,
      ownershipSlot: request.ownershipSlot,
      definition,
      targetMonsterUnitId: 0,
      nextThinkAtMs: 0,
      nextAttackAtMs: 0,
      navigationSequence: 0,
      followOwner: true,
      reaction,
      autoCastAbilityIds,
    });
    this.summonUnitIdByOwnerSlot.set(key, unitId);
    this.PublishVisibilityChanges(changes, "summon-create");
    this.DomainScene().logger.info("owned summon created", {
      summonUnitId: unitId,
      summonDefinitionId: definition.id,
      ownerUnitId: owner.UnitId,
      ownershipSlot: request.ownershipSlot,
      replacedUnitId: existingId ?? 0,
    });
    return summon;
  }

  CaptureOwnedState(owner: PlayerUnit): readonly OwnedSummonTransferState[] {
    this.RequireMapUnit(owner);
    return [...this.runtime.values()]
      .filter((state) => state.ownerUnitId === owner.UnitId)
      .sort((left, right) => left.ownershipSlot - right.ownershipSlot)
      .map((state) => ({
        ownershipSlot: state.ownershipSlot,
        createdByAbilityId: state.summon.CreatedByAbilityId,
        // Copy the frozen value object so the transfer snapshot cannot retain
        // mutable or identity-bearing state from the source map.
        definition: freezeDefinition(state.definition),
        reaction: state.reaction,
        autoCastAbilityIds: [...state.autoCastAbilityIds].sort((left, right) => left - right),
      }));
  }

  RestoreOwnedState(
    owner: PlayerUnit,
    states: readonly OwnedSummonTransferState[],
  ): readonly SummonedUnit[] {
    this.RequireMapUnit(owner);
    const seenSlots = new Set<number>();
    const validated = states.map((state) => {
      validateOwnershipSlot(state.ownershipSlot);
      validateAbilityId(state.createdByAbilityId, "createdByAbilityId");
      validateReaction(state.reaction);
      const autoCastAbilityIds = normalizeAutoCastAbilityIds(
        state.definition,
        state.autoCastAbilityIds,
      );
      if (seenSlots.has(state.ownershipSlot)) {
        throw new Error(`duplicate summon ownership slot: ${state.ownershipSlot}`);
      }
      seenSlots.add(state.ownershipSlot);
      if (this.summonUnitIdByOwnerSlot.has(ownerSlotKey(owner.UnitId, state.ownershipSlot))) {
        throw new Error(`summon ownership slot is already occupied: ${state.ownershipSlot}`);
      }
      return {
        ownershipSlot: state.ownershipSlot,
        createdByAbilityId: state.createdByAbilityId,
        definition: freezeDefinition(state.definition),
        reaction: state.reaction,
        autoCastAbilityIds: [...autoCastAbilityIds],
      };
    });
    const restored: SummonedUnit[] = [];
    try {
      for (const state of validated) {
        restored.push(this.SummonOwnedUnit(owner, {
          ownershipSlot: state.ownershipSlot,
          createdByAbilityId: state.createdByAbilityId,
          definition: state.definition,
          reaction: state.reaction,
          autoCastAbilityIds: state.autoCastAbilityIds,
        }));
      }
    } catch (error) {
      // 恢复中途失败时撤销本批已经创建的Unit，避免Prepare抛错后留下部分召唤物。
      // If restoration fails midway, remove every Unit created by this batch so
      // a throwing Prepare cannot leave a partially restored summon set.
      const changes = restored.flatMap((summon) => this.RemoveSummon(summon));
      this.PublishVisibilityChanges(changes, "summon-restore-rollback");
      throw error;
    }
    return restored;
  }

  DismissOwnedUnit(owner: SummonOwnerUnit, ownershipSlot: number): boolean {
    this.RequireMapUnit(owner);
    validateOwnershipSlot(ownershipSlot);
    const unitId = this.summonUnitIdByOwnerSlot.get(ownerSlotKey(owner.UnitId, ownershipSlot));
    const summon = unitId === undefined ? undefined : this.summons.get(unitId);
    if (!summon) return false;
    this.PublishVisibilityChanges(this.RemoveSummon(summon), "summon-dismiss");
    return true;
  }

  GetOwnedUnit(owner: SummonOwnerUnit, ownershipSlot: number): SummonedUnit | undefined {
    this.RequireMapUnit(owner);
    validateOwnershipSlot(ownershipSlot);
    const unitId = this.summonUnitIdByOwnerSlot.get(ownerSlotKey(owner.UnitId, ownershipSlot));
    return unitId === undefined ? undefined : this.summons.get(unitId);
  }

  Get(summonUnitId: number): SummonedUnit | undefined {
    return this.summons.get(summonUnitId);
  }

  GetAll(): readonly SummonedUnit[] {
    return [...this.summons.values()];
  }

  GetControlState(summonUnitId: number): import("#tiangz/model").OwnedUnitControlState | undefined {
    const state = this.runtime.get(summonUnitId);
    return state
      ? {
          reaction: state.reaction,
          autoCastAbilityIds: [...state.autoCastAbilityIds].sort((left, right) => left - right),
        }
      : undefined;
  }

  CommandOwnedUnit(
    owner: PlayerUnit,
    summonUnitId: number,
    command: OwnedUnitCommandValue,
    targetUnitId: number,
    abilityId: number = 0,
  ): boolean {
    this.RequireMapUnit(owner);
    const state = this.runtime.get(summonUnitId);
    if (!state || state.ownerUnitId !== owner.UnitId) return false;
    switch (command) {
      case OwnedUnitCommand.Follow:
        state.followOwner = true;
        state.targetMonsterUnitId = 0;
        return true;
      case OwnedUnitCommand.Stay:
        state.followOwner = false;
        state.targetMonsterUnitId = 0;
        NativeData.ResetMovement(state.summon.GetComponent(NativeUnitRef).Handle);
        return true;
      case OwnedUnitCommand.Attack: {
        const target = this.DomainScene().GetComponent(MonsterComponent).Get(targetUnitId);
        if (
          !target
          || target.GetComponent(NativeUnitRef).alive === 0
          || !this.DomainScene().GetComponent(MonsterComponent).CanPlayerAttack(owner, target)
        ) return false;
        state.targetMonsterUnitId = target.UnitId;
        return true;
      }
      case OwnedUnitCommand.Dismiss:
        this.PublishVisibilityChanges(this.RemoveSummon(state.summon), "summon-command-dismiss");
        return true;
      case OwnedUnitCommand.SetPassive:
        state.reaction = OwnedUnitReaction.Passive;
        state.targetMonsterUnitId = 0;
        NativeData.ResetMovement(state.summon.GetComponent(NativeUnitRef).Handle);
        return true;
      case OwnedUnitCommand.SetDefensive:
        state.reaction = OwnedUnitReaction.Defensive;
        return true;
      case OwnedUnitCommand.SetAggressive:
        state.reaction = OwnedUnitReaction.Aggressive;
        state.nextThinkAtMs = 0;
        return true;
      case OwnedUnitCommand.CastAbility:
        return this.TryCastOwnedAbility(state, targetUnitId, abilityId);
      case OwnedUnitCommand.EnableAbilityAutoCast:
        if (!hasOwnedAbility(state.definition, abilityId)) return false;
        state.autoCastAbilityIds.add(abilityId);
        return true;
      case OwnedUnitCommand.DisableAbilityAutoCast:
        if (!hasOwnedAbility(state.definition, abilityId)) return false;
        state.autoCastAbilityIds.delete(abilityId);
        return true;
      default:
        return false;
    }
  }

  AssistOwnerAgainst(owner: PlayerUnit, target: MonsterUnit): void {
    this.RequireMapUnit(owner);
    this.RequireMapUnit(target);
    for (const state of this.runtime.values()) {
      if (
        state.ownerUnitId === owner.UnitId
        && state.definition.assistOwner
        && state.reaction !== OwnedUnitReaction.Passive
      ) {
        state.targetMonsterUnitId = target.UnitId;
      }
    }
  }

  OwnerLeaving(owner: SummonOwnerUnit): readonly import("#tiangz/model").AoiVisibilityDelta[] {
    this.RequireMapUnit(owner);
    const changes: import("#tiangz/model").AoiVisibilityDelta[] = [];
    for (const state of [...this.runtime.values()]) {
      if (state.ownerUnitId === owner.UnitId) changes.push(...this.RemoveSummon(state.summon));
    }
    return changes;
  }

  /** 与怪物AI相同使用地图固定桶，不创建每召唤物Timer。 / Shares the map fixed bucket with monster AI instead of one Timer per summon. */
  Update5Hz(): void {
    if (this.map.IsStopping) return;
    const now = TimeSystem.Instance.ServerNow;
    for (const state of this.runtime.values()) this.TickSummon(state, now);
  }

  /** 清理死亡或失去所有者的临时Unit。 / Cleans temporary Units that died or lost their owner. */
  Update1Hz(): void {
    if (this.map.IsStopping) return;
    const changes: import("#tiangz/model").AoiVisibilityDelta[] = [];
    for (const state of [...this.runtime.values()]) {
      const owner = this.units.Get<SummonOwnerUnit>(state.ownerUnitId);
      if (!owner || state.summon.GetComponent(NativeUnitRef).alive === 0) {
        changes.push(...this.RemoveSummon(state.summon));
      }
    }
    this.PublishVisibilityChanges(changes, "summon-expired");
  }

  protected override OnDestroy(): void {
    for (const summon of [...this.summons.values()]) {
      try {
        if (this.aoi.IsAttached(summon)) this.aoi.Detach(summon);
      } catch {
        // Map teardown may already have released AOI.
      }
      if (this.units.Get(summon.UnitId) === summon) this.units.Remove(summon.UnitId);
    }
    this.summons.clear();
    this.runtime.clear();
    this.summonUnitIdByOwnerSlot.clear();
  }

  private ComposeSummon(
    summon: SummonedUnit,
    owner: SummonOwnerUnit,
    definition: Readonly<OwnedSummonDefinition>,
  ): void {
    const native = summon.AddComponent(NativeUnitRef, {
      id: summon.UnitId,
      instanceId: summon.InstanceId,
      mapId: this.map.NativeMapKey,
      x: 0,
      y: 0,
    });
    const position = summon.AddComponent(
      PositionComponent,
      native,
      this.map.SpatialProfile.widthCells,
      this.map.SpatialProfile.depthCells,
      this.map.SpatialProfile.cellSizeMeters,
    );
    const ownerPosition = owner.GetComponent(PositionComponent);
    if (this.map.SpatialProfile.spatialMode === SpatialMode.Grid2D) {
      position.SetGridCell(
        ownerPosition.cellX,
        ownerPosition.cellZ,
        ownerPosition.y,
        ownerPosition.yaw,
      );
    } else {
      const projected = this.map.ProjectPosition({
        x: ownerPosition.x,
        y: ownerPosition.y,
        z: ownerPosition.z,
      });
      if (!projected) throw new Error(`summon owner ${owner.UnitId} is outside NavMesh`);
      position.SetNavMeshWorldPosition(projected.x, projected.y, projected.z, ownerPosition.yaw);
    }
    position.SpeedMetersPerSecond = definition.moveSpeed;
    const ownerLevel = owner.TryGetComponent(NumericComponent)?.[NumericType.Level] ?? 1n;
    summon.AddComponent(NumericComponent, {
      [NumericType.CurrentHp]: BigInt(definition.maxHp),
      [NumericType.CurrentMp]: BigInt(definition.maxMp),
      [NumericType.Level]: ownerLevel > 0n ? ownerLevel : 1n,
      [NumericType.MaxHpBase]: BigInt(definition.maxHp),
      [NumericType.MaxMpBase]: BigInt(definition.maxMp),
      [NumericType.AttackBase]: BigInt(definition.attackDamage),
      [NumericType.AttackSpeedAdd]: BigInt(definition.attackIntervalMs),
      [NumericType.MoveSpeedBase]: MoveSpeedMetersPerSecondToNumeric(definition.moveSpeed),
    });
    if (definition.resourceRegenAmount !== undefined) {
      summon.AddComponent(NumericRegenerationComponent, {
        currentNumericType: NumericType.CurrentMp,
        maximumNumericType: NumericType.MaxMp,
        amount: BigInt(definition.resourceRegenAmount),
        intervalMs: definition.resourceRegenIntervalMs!,
        delayAfterDecreaseMs: definition.resourceRegenDelayAfterSpendMs!,
      });
    }
    summon.AddComponent(CombatComponent);
    summon.AddComponent(BuffComponent);
    summon.AddComponent(SkillComponent, definition.abilities.map((ability) => ability.abilityId));
    applyEntityExtensions(summon);
  }

  private TickSummon(state: SummonRuntimeState, now: number): void {
    if (now < state.nextThinkAtMs) return;
    state.nextThinkAtMs = now + SUMMON_THINK_INTERVAL_MS;
    const summon = state.summon;
    summon.TryGetComponent(NumericRegenerationComponent)?.Tick(now);
    const owner = this.units.Get<SummonOwnerUnit>(state.ownerUnitId);
    const native = summon.GetComponent(NativeUnitRef);
    if (!owner || native.alive === 0 || owner.GetComponent(NativeUnitRef).alive === 0) {
      NativeData.ResetMovement(native.Handle);
      return;
    }

    const monsters = this.DomainScene().GetComponent(MonsterComponent);
    const playerOwner = owner instanceof PlayerUnit ? owner : undefined;
    let target = playerOwner && state.targetMonsterUnitId > 0
      ? monsters.Get(state.targetMonsterUnitId)
      : undefined;
    if (
      target
      && (
        target.GetComponent(NativeUnitRef).alive === 0
        || !monsters.CanPlayerAttack(playerOwner!, target)
        || distanceBetween(summon, target) > state.definition.teleportDistance
      )
    ) {
      target = undefined;
      state.targetMonsterUnitId = 0;
    }

    if (!target && playerOwner && state.reaction === OwnedUnitReaction.Aggressive) {
      target = this.FindAggressiveTarget(state, playerOwner, monsters);
      state.targetMonsterUnitId = target?.UnitId ?? 0;
    }

    if (target) {
      if (summon.GetComponent(SkillComponent).IsCasting()) {
        NativeData.ResetMovement(native.Handle);
        return;
      }
      if (this.TryCastAutomaticAbility(state, target)) {
        NativeData.ResetMovement(native.Handle);
        return;
      }
      const distance = distanceBetween(summon, target);
      if (distance > state.definition.attackRange) {
        this.MoveToward(state, target.GetComponent(PositionComponent));
        return;
      }
      NativeData.ResetMovement(native.Handle);
      if (now < state.nextAttackAtMs) return;
      state.nextAttackAtMs = now + state.definition.attackIntervalMs;
      monsters.ApplyPlayerDamage(playerOwner!, target, {
        amount: BigInt(state.definition.attackDamage),
        sourceUnitId: summon.UnitId,
        abilityId: state.definition.attackAbilityId,
        damageSchool: state.definition.attackDamageSchool,
      });
      return;
    }

    if (!state.followOwner) {
      NativeData.ResetMovement(native.Handle);
      return;
    }

    const ownerPosition = owner.GetComponent(PositionComponent);
    const followDistance = distanceBetween(summon, owner);
    if (followDistance > state.definition.teleportDistance) {
      this.RelocateToOwner(summon, ownerPosition);
      return;
    }
    if (followDistance > state.definition.followDistance) {
      this.MoveToward(state, ownerPosition);
      return;
    }
    NativeData.ResetMovement(native.Handle);
  }

  private TryCastAutomaticAbility(state: SummonRuntimeState, target: MonsterUnit): boolean {
    for (const ability of state.definition.abilities) {
      if (!state.autoCastAbilityIds.has(ability.abilityId)) continue;
      if (this.TryCastOwnedAbility(state, target.UnitId, ability.abilityId)) return true;
    }
    return false;
  }

  private TryCastOwnedAbility(
    state: SummonRuntimeState,
    targetUnitId: number,
    abilityId: number,
  ): boolean {
    if (!hasOwnedAbility(state.definition, abilityId)) return false;
    try {
      this.DomainScene().GetComponent(SkillMapComponent).Cast(state.summon, {
        skillId: abilityId,
        targetUnitId,
      });
      return true;
    } catch {
      return false;
    }
  }

  private MoveToward(
    state: SummonRuntimeState,
    target: Readonly<{ x: number; y: number; z: number }>,
  ): void {
    const summon = state.summon;
    const native = summon.GetComponent(NativeUnitRef);
    state.navigationSequence += 1;
    if (this.map.SpatialProfile.spatialMode === SpatialMode.Grid2D) {
      const cellSize = this.map.SpatialProfile.cellSizeMeters;
      NativeData.SetGridMovementTarget(
        native.Handle,
        Math.round(target.x / cellSize),
        Math.round(target.z / cellSize),
        state.navigationSequence,
      );
      return;
    }
    NativeData.SetNavigationTarget(
      this.map.NativeMapKey,
      native.Handle,
      { x: target.x, y: target.y, z: target.z },
      state.navigationSequence,
    );
  }

  private FindAggressiveTarget(
    state: SummonRuntimeState,
    owner: PlayerUnit,
    monsters: MonsterComponent,
  ): MonsterUnit | undefined {
    const visible = new Set(this.aoi.VisibleUnitIds(state.summon.UnitId));
    let nearest: MonsterUnit | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of monsters.GetAll()) {
      if (
        !visible.has(candidate.UnitId)
        || candidate.GetComponent(NativeUnitRef).alive === 0
        || !monsters.CanPlayerAttack(owner, candidate)
      ) continue;
      const distance = distanceBetween(state.summon, candidate);
      if (
        distance > state.definition.aggressiveAcquireRange
        || distance > nearestDistance
        || (distance === nearestDistance && nearest && candidate.UnitId >= nearest.UnitId)
      ) continue;
      nearest = candidate;
      nearestDistance = distance;
    }
    return nearest;
  }

  private RelocateToOwner(summon: SummonedUnit, owner: PositionComponent): void {
    const native = summon.GetComponent(NativeUnitRef);
    const position = summon.GetComponent(PositionComponent);
    NativeData.ResetMovement(native.Handle);
    if (this.map.SpatialProfile.spatialMode === SpatialMode.Grid2D) {
      position.SetGridCell(owner.cellX, owner.cellZ, owner.y, owner.yaw);
      return;
    }
    const projected = this.map.ProjectPosition({ x: owner.x, y: owner.y, z: owner.z });
    if (projected) {
      position.SetNavMeshWorldPosition(projected.x, projected.y, projected.z, owner.yaw);
    }
  }

  private RemoveSummon(summon: SummonedUnit): import("#tiangz/model").AoiVisibilityDelta[] {
    const changes = this.aoi.IsAttached(summon) ? [...this.aoi.Detach(summon)] : [];
    this.summons.delete(summon.UnitId);
    this.runtime.delete(summon.UnitId);
    const key = ownerSlotKey(summon.OwnerUnitId, summon.OwnershipSlot);
    if (this.summonUnitIdByOwnerSlot.get(key) === summon.UnitId) {
      this.summonUnitIdByOwnerSlot.delete(key);
    }
    if (this.units.Get(summon.UnitId) === summon) this.units.Remove(summon.UnitId);
    return changes;
  }

  private PublishVisibilityChanges(
    changes: readonly import("#tiangz/model").AoiVisibilityDelta[],
    reason: string,
  ): void {
    if (changes.length === 0) return;
    void this.map.PublishVisibilityChanges(changes).catch((error) => {
      this.DomainScene().logger.error("summon AOI publish failed", { reason, error });
    });
  }

  private AllocateUnitId(): number {
    while (this.nextSummonUnitId <= SUMMON_UNIT_ID_MAX && this.units.Get(this.nextSummonUnitId)) {
      this.nextSummonUnitId += 1;
    }
    if (this.nextSummonUnitId > SUMMON_UNIT_ID_MAX) {
      throw new Error("summoned UnitId range exhausted");
    }
    return this.nextSummonUnitId++;
  }
}

function ownerSlotKey(ownerUnitId: number, ownershipSlot: number): string {
  return `${ownerUnitId}:${ownershipSlot}`;
}

function distanceBetween(
  left: SummonedUnit,
  right: PlayerUnit | MonsterUnit | NpcUnit,
): number {
  const a = left.GetComponent(PositionComponent);
  const b = right.GetComponent(PositionComponent);
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function validateOwnershipSlot(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`summon ownershipSlot must be a non-negative safe integer: ${value}`);
  }
}

function validateAbilityId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`summon ${label} must be a non-negative safe integer: ${value}`);
  }
}

function freezeDefinition(value: Readonly<OwnedSummonDefinition>): Readonly<OwnedSummonDefinition> {
  if (!Number.isSafeInteger(value.id) || value.id <= 0) {
    throw new Error(`summon definition id must be positive: ${value.id}`);
  }
  const name = value.name.trim();
  const modelId = value.modelId.trim();
  if (!name || !modelId) throw new Error("summon name and modelId must not be empty");
  for (const [label, number, allowZero] of [
    ["maxHp", value.maxHp, false],
    ["maxMp", value.maxMp, true],
    ["attackDamage", value.attackDamage, true],
    ["moveSpeed", value.moveSpeed, false],
    ["attackRange", value.attackRange, false],
    ["attackIntervalMs", value.attackIntervalMs, false],
    ["followDistance", value.followDistance, false],
    ["teleportDistance", value.teleportDistance, false],
    ["aggressiveAcquireRange", value.aggressiveAcquireRange, false],
  ] as const) {
    if (!Number.isFinite(number) || (allowZero ? number < 0 : number <= 0)) {
      throw new Error(`summon ${label} is invalid: ${number}`);
    }
  }
  if (![value.maxHp, value.maxMp, value.attackDamage, value.attackIntervalMs].every(Number.isSafeInteger)) {
    throw new Error("summon integral combat values must be safe integers");
  }
  if (value.teleportDistance <= value.followDistance) {
    throw new Error("summon teleportDistance must exceed followDistance");
  }
  if (
    value.aggressiveAcquireRange < value.attackRange
    || value.aggressiveAcquireRange > value.teleportDistance
  ) {
    throw new Error("summon aggressiveAcquireRange must cover attackRange without exceeding teleportDistance");
  }
  if (!Object.values(DamageSchool).includes(value.attackDamageSchool)) {
    throw new Error(`summon attackDamageSchool is invalid: ${value.attackDamageSchool}`);
  }
  const resourceRegenAmount = value.resourceRegenAmount ?? 0;
  const resourceRegenIntervalMs = value.resourceRegenIntervalMs ?? 0;
  const resourceRegenDelayAfterSpendMs = value.resourceRegenDelayAfterSpendMs ?? 0;
  for (const [label, number] of [
    ["resourceRegenAmount", resourceRegenAmount],
    ["resourceRegenIntervalMs", resourceRegenIntervalMs],
    ["resourceRegenDelayAfterSpendMs", resourceRegenDelayAfterSpendMs],
  ] as const) {
    if (!Number.isSafeInteger(number) || number < 0) {
      throw new Error(`summon ${label} must be a non-negative safe integer: ${number}`);
    }
  }
  const hasResourceRegeneration = resourceRegenAmount > 0
    || resourceRegenIntervalMs > 0
    || resourceRegenDelayAfterSpendMs > 0;
  if (hasResourceRegeneration && (
    value.maxMp <= 0 || resourceRegenAmount <= 0 || resourceRegenIntervalMs <= 0
  )) {
    throw new Error("summon resource regeneration requires maxMp, amount, and interval");
  }
  validateAbilityId(value.attackAbilityId, "attackAbilityId");
  validateReaction(value.initialReaction);
  const seenAbilities = new Set<number>();
  const abilities = value.abilities.map((ability) => {
    validateAbilityId(ability.abilityId, "abilityId");
    if (ability.abilityId === 0 || seenAbilities.has(ability.abilityId)) {
      throw new Error(`summon abilityId must be positive and unique: ${ability.abilityId}`);
    }
    if (typeof ability.autoCastByDefault !== "boolean") {
      throw new Error(`summon ability ${ability.abilityId} has invalid autoCastByDefault`);
    }
    seenAbilities.add(ability.abilityId);
    return Object.freeze({ ...ability });
  });
  return Object.freeze({
    ...value,
    name,
    modelId,
    abilities: Object.freeze(abilities),
    ...(hasResourceRegeneration ? {
      resourceRegenAmount,
      resourceRegenIntervalMs,
      resourceRegenDelayAfterSpendMs,
    } : {}),
  });
}

function validateReaction(value: number): asserts value is OwnedUnitReactionValue {
  if (!Object.values(OwnedUnitReaction).includes(value as OwnedUnitReactionValue)) {
    throw new Error(`summon reaction is invalid: ${value}`);
  }
}

function hasOwnedAbility(definition: Readonly<OwnedSummonDefinition>, abilityId: number): boolean {
  return definition.abilities.some((ability) => ability.abilityId === abilityId);
}

function normalizeAutoCastAbilityIds(
  definition: Readonly<OwnedSummonDefinition>,
  requested?: readonly number[],
): Set<number> {
  const source = requested
    ?? definition.abilities.filter((ability) => ability.autoCastByDefault).map((ability) => ability.abilityId);
  const result = new Set<number>();
  for (const abilityId of source) {
    validateAbilityId(abilityId, "autoCastAbilityId");
    if (!hasOwnedAbility(definition, abilityId) || result.has(abilityId)) {
      throw new Error(`summon auto-cast ability must be a unique catalog member: ${abilityId}`);
    }
    result.add(abilityId);
  }
  return result;
}
