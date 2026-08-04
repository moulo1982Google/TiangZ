import {
  GameConfigs,
  GameErrCode,
  MapAoiComponent,
  MapComponent,
  MonsterComponent,
  MonsterUnit,
  NativeData,
  NativeUnitRef,
  NumericComponent,
  NumericType,
  PlayerUnit,
  PositionComponent,
  RpcError,
  SpatialMode,
  TimeSystem,
  UnitComponent,
  type M2C_AttackMonster,
  type MonsterAreaConfigData,
  type MonsterConfigData,
  systemFor,
} from "#tiangz/model";
import { MonsterBehaviorTree } from "./MonsterBehaviorTree";

const MONSTER_AGGRO_RANGE_METERS = 12;
const PLAYER_ATTACK_DAMAGE = 25n;
const BASIC_ATTACK_RANGE_METERS = 2;
const MONSTER_ID_MAX = 0xffff_ffff;
const monsterBehaviorTree = new MonsterBehaviorTree();

/**
 * 第一版怪物业务：固定刷点、简单追击、普通攻击、死亡尸体和重生。
 * 怪物只作为AOI Subject，不会成为Observer，也不参与动态避障。
 *
 * Version-one monster rules: fixed slots, simple chase, basic attacks, corpse
 * lifetime, and respawn. Monsters are AOI Subjects only and never participate
 * in dynamic avoidance.
 */
@systemFor(MonsterComponent)
export class MonsterComponentSystem extends MonsterComponent {
  /** 读取本地图冷刷点，并在地图创建时生成初始怪物。 / Loads cold spawn points and creates initial monsters when the map is created. */
  protected override Awake(map: MapComponent, aoi: MapAoiComponent): void {
    this.map = map;
    this.aoi = aoi;
    const areas = GameConfigs.MonsterAreaConfig.GetAll()
      .filter((area) => area.mapConfigId === map.MapId)
      .sort((left, right) => left.id - right.id);
    for (const config of areas) {
      if (this.slots.has(config.id)) {
        throw new Error(`duplicate monster spawn slot: ${config.id}`);
      }
      const slot = {
        config,
        monster: null,
        deadAtMs: 0,
        respawnAtMs: 0,
      };
      this.slots.set(config.id, slot);
      if (config.initialSpawn) this.Spawn(slot);
    }
    this.DomainScene().logger.info("monster component ready", {
      mapId: map.MapId,
      spawnSlots: areas.length,
      initialMonsters: this.monsters.size,
    });
  }

  /** 地图固定Tick驱动怪物AI；不为每只怪物创建一个长期Timer。 / Drives monster AI from the map fixed tick instead of creating one long-lived timer per monster. */
  Update(): void {
    const now = TimeSystem.Instance.ServerNow;
    for (const slot of this.slots.values()) {
      const monster = slot.monster;
      if (!monster) {
        if (slot.respawnAtMs > 0 && now >= slot.respawnAtMs) this.Spawn(slot);
        continue;
      }
      const native = monster.GetComponent(NativeUnitRef);
      if (native.alive === 0) {
        const corpseMs = slot.config.corpseLifetimeSeconds * 1_000;
        if (now >= slot.deadAtMs + corpseMs) this.RemoveDeadMonster(slot);
        continue;
      }
      const config = slot.config.monsterConfigId_ref
        ?? GameConfigs.MonsterConfig.Get(slot.config.monsterConfigId);
      this.TickMonster(monster, config, now);
    }
  }

  /** 玩家近战攻击一个怪物；伤害、距离和死亡都在同一地图入口完成。 / Resolves one player melee attack, including range, damage, and death on this map. */
  Attack(attacker: PlayerUnit, monsterId: number): M2C_AttackMonster {
    this.RequireMapUnit(attacker);
    const monster = this.monsters.get(monsterId);
    if (!monster) throw new RpcError(GameErrCode.MonsterNotFound, `monster not found: ${monsterId}`);
    const monsterNative = monster.GetComponent(NativeUnitRef);
    if (monsterNative.alive === 0) throw new RpcError(GameErrCode.MonsterDead, `monster is dead: ${monsterId}`);

    const attackerPosition = attacker.GetComponent(PositionComponent);
    const monsterPosition = monster.GetComponent(PositionComponent);
    if (distanceSquared(attackerPosition.x, attackerPosition.z, monsterPosition.x, monsterPosition.z)
      > BASIC_ATTACK_RANGE_METERS * BASIC_ATTACK_RANGE_METERS) {
      throw new RpcError(GameErrCode.MonsterTooFar, `monster is too far: ${monsterId}`);
    }

    const numeric = monster.GetComponent(NumericComponent);
    const currentHp = numeric[NumericType.CurrentHp];
    const remainingHp = currentHp > PLAYER_ATTACK_DAMAGE
      ? currentHp - PLAYER_ATTACK_DAMAGE
      : 0n;
    numeric[NumericType.CurrentHp] = remainingHp;
    const killed = remainingHp === 0n;
    if (killed) this.Kill(monster);
    return { monsterId, damage: Number(PLAYER_ATTACK_DAMAGE), remainingHp, killed };
  }

  /** 地图销毁时只释放怪物Unit，不向玩家发送额外业务事件。 / Releases monster Units during map disposal without inventing another business event. */
  protected override OnDestroy(): void {
    for (const monster of this.monsters.values()) {
      try {
        this.aoi.Detach(monster);
      } catch {
        // AOI may already be released while a failed map teardown is unwinding.
      }
      this.units.Remove(monster.UnitId);
    }
    this.monsters.clear();
    this.runtime.clear();
    this.slots.clear();
  }

  private Spawn(slot: { config: MonsterAreaConfigData; monster: MonsterUnit | null; deadAtMs: number; respawnAtMs: number }): void {
    if (slot.monster) return;
    const config = slot.config.monsterConfigId_ref ?? GameConfigs.MonsterConfig.Get(slot.config.monsterConfigId);
    const unitId = this.AllocateUnitId();
    const monster = this.units.Create(unitId, MonsterUnit, {
      mapId: this.map.MapId,
      mapInstanceId: this.map.MapInstanceId,
      areaId: slot.config.id,
      monsterConfigId: config.id,
    });
    try {
      const native = monster.AddComponent(NativeUnitRef, {
        id: unitId,
        instanceId: monster.InstanceId,
        mapId: this.map.NativeMapKey,
        x: 0,
        y: 0,
      });
      const mapConfig = GameConfigs.MapConfig.Get(this.map.MapId);
      const position = monster.AddComponent(
        PositionComponent,
        native,
        mapConfig.widthCells,
        mapConfig.depthCells,
        mapConfig.cellSizeMeters,
      );
      if (mapConfig.spatialMode === SpatialMode.Grid2D) {
        position.SetGridWorldPosition(
          slot.config.spawnX,
          slot.config.spawnY,
          slot.config.spawnZ,
          slot.config.spawnYaw,
        );
      } else {
        const projected = this.map.ProjectPosition({
          x: slot.config.spawnX,
          y: slot.config.spawnY,
          z: slot.config.spawnZ,
        });
        if (!projected) throw new Error(`monster spawn outside NavMesh: ${slot.config.id}`);
        position.SetNavMeshWorldPosition(projected.x, projected.y, projected.z, slot.config.spawnYaw);
      }
      position.SpeedCellsPerSecond = config.moveSpeed;
      monster.AddComponent(NumericComponent, {
        currentHp: BigInt(config.maxHp),
        maxHpBase: BigInt(config.maxHp),
        regenerateHp: false,
      });
      slot.monster = monster;
      slot.deadAtMs = 0;
      slot.respawnAtMs = 0;
      this.monsters.set(unitId, monster);
      this.runtime.set(unitId, {
        targetUnitId: 0,
        nextThinkAtMs: 0,
        nextAttackAtMs: 0,
        navigationSequence: 0,
      });
      const changes = this.aoi.Attach(monster, 0, false, true);
      if (changes.length > 0) {
        void this.map.PublishVisibilityChanges(changes).catch((error) => {
          this.DomainScene().logger.error("monster AOI publish failed", { error });
        });
      }
    } catch (error) {
      this.units.Remove(unitId);
      throw error;
    }
  }

  private TickMonster(monster: MonsterUnit, config: MonsterConfigData, now: number): void {
    const state = this.runtime.get(monster.UnitId);
    if (!state || now < state.nextThinkAtMs) return;
    state.nextThinkAtMs = now + 250;
    const target = config.attackMode === 0
      ? undefined
      : this.FindNearestPlayer(monster, MONSTER_AGGRO_RANGE_METERS);
    const monsterPosition = monster.GetComponent(PositionComponent);
    const targetPosition = target?.GetComponent(PositionComponent);
    const distance = targetPosition
      ? Math.sqrt(distanceSquared(
        monsterPosition.x,
        monsterPosition.z,
        targetPosition.x,
        targetPosition.z,
      ))
      : Number.POSITIVE_INFINITY;
    const attackRange = Math.min(config.attackRange, BASIC_ATTACK_RANGE_METERS);
    const action = monsterBehaviorTree.Evaluate({
      mayAggro: config.attackMode !== 0,
      hasTarget: target !== undefined,
      inAttackRange: distance <= attackRange,
      canAttack: now >= state.nextAttackAtMs,
    });
    state.targetUnitId = target?.UnitId ?? 0;
    const native = monster.GetComponent(NativeUnitRef);
    switch (action) {
      case "attack":
        NativeData.ResetMovement(native.Handle);
        this.AttackPlayer(monster, target!, config.attackDamage);
        state.nextAttackAtMs = now + config.attackIntervalMs;
        return;
      case "hold":
      case "idle":
        NativeData.ResetMovement(native.Handle);
        return;
      case "chase":
        state.navigationSequence += 1;
        if (this.mapConfig.spatialMode === SpatialMode.Grid2D) {
          NativeData.SetMovementInput(
            native.Handle,
            Math.sign(targetPosition!.x - monsterPosition.x),
            Math.sign(targetPosition!.z - monsterPosition.z),
            state.navigationSequence,
          );
        } else {
          NativeData.SetNavigationTarget(
            this.map.NativeMapKey,
            native.Handle,
            { x: targetPosition!.x, y: targetPosition!.y, z: targetPosition!.z },
            state.navigationSequence,
          );
        }
        return;
    }
  }

  private AttackPlayer(monster: MonsterUnit, target: PlayerUnit, damage: number): void {
    const numeric = target.GetComponent(NumericComponent);
    const currentHp = numeric[NumericType.CurrentHp];
    numeric[NumericType.CurrentHp] = currentHp > BigInt(damage)
      ? currentHp - BigInt(damage)
      : 0n;
    if (numeric[NumericType.CurrentHp] === 0n) {
      target.GetComponent(NativeUnitRef).alive = 0;
      NativeData.ResetMovement(target.GetComponent(NativeUnitRef).Handle);
    }
  }

  private Kill(monster: MonsterUnit): void {
    const slot = this.slots.get(monster.AreaId);
    if (!slot || slot.monster !== monster) return;
    const now = TimeSystem.Instance.ServerNow;
    monster.GetComponent(NativeUnitRef).alive = 0;
    NativeData.ResetMovement(monster.GetComponent(NativeUnitRef).Handle);
    slot.deadAtMs = now;
    slot.respawnAtMs = now + Math.max(
      slot.config.respawnSeconds,
      slot.config.corpseLifetimeSeconds,
    ) * 1_000;
    const state = this.runtime.get(monster.UnitId);
    if (state) state.targetUnitId = 0;
  }

  private RemoveDeadMonster(slot: { config: MonsterAreaConfigData; monster: MonsterUnit | null; deadAtMs: number; respawnAtMs: number }): void {
    const monster = slot.monster;
    if (!monster) return;
    const changes = this.aoi.Detach(monster);
    this.monsters.delete(monster.UnitId);
    this.runtime.delete(monster.UnitId);
    slot.monster = null;
    this.units.Remove(monster.UnitId);
    if (changes.length > 0) {
      void this.map.PublishVisibilityChanges(changes).catch((error) => {
        this.DomainScene().logger.error("monster AOI publish failed", { error });
      });
    }
  }

  private FindNearestPlayer(monster: MonsterUnit, maxDistance: number): PlayerUnit | undefined {
    const position = monster.GetComponent(PositionComponent);
    const maxDistanceSquared = maxDistance * maxDistance;
    let nearest: PlayerUnit | undefined;
    let nearestDistanceSquared = maxDistanceSquared;
    for (const player of this.units.GetAll(PlayerUnit)) {
      if (player.GetComponent(NativeUnitRef).alive === 0) continue;
      const playerPosition = player.GetComponent(PositionComponent);
      const distanceSquaredValue = distanceSquared(
        position.x,
        position.z,
        playerPosition.x,
        playerPosition.z,
      );
      if (distanceSquaredValue < nearestDistanceSquared) {
        nearest = player;
        nearestDistanceSquared = distanceSquaredValue;
      }
    }
    return nearest;
  }

  private AllocateUnitId(): number {
    while (this.nextMonsterUnitId <= MONSTER_ID_MAX && this.units.Get(this.nextMonsterUnitId)) {
      this.nextMonsterUnitId += 1;
    }
    if (this.nextMonsterUnitId > MONSTER_ID_MAX) throw new Error("monster UnitId range exhausted");
    const unitId = this.nextMonsterUnitId;
    this.nextMonsterUnitId += 1;
    return unitId;
  }

  private get units(): UnitComponent {
    return this.DomainScene().GetComponent(UnitComponent);
  }

  private get mapConfig(): ReturnType<typeof GameConfigs.MapConfig.Get> {
    return GameConfigs.MapConfig.Get(this.map.MapId);
  }
}

function distanceSquared(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}
