import {
  ActionType,
  BuffApplyStatus,
  BuffComponent,
  CombatComponent,
  DamageSchool,
  GameErrCode,
  GlobalIdSystem,
  MapComponent,
  MonsterComponent,
  MonsterUnit,
  NativeData,
  NativeUnitRef,
  PlayerUnit,
  PositionComponent,
  RpcError,
  SkillCastPhase,
  SkillComponent,
  SkillAutoAttackPolicy,
  SkillDelivery,
  SkillEffectTarget,
  SkillEvents,
  SkillMapComponent,
  SkillMovementPolicy,
  SkillTargetRelation,
  TimeSystem,
  SystemErrCode,
  UnitComponent,
  type ActionDefinition,
  type DamageResult,
  type SkillCastCommand,
  type SkillCastState,
  type SkillDefinition,
  type SkillEffectDefinition,
  type SkillProjectile,
  type Unit,
  systemFor,
} from "#tiangz/model";
import { ExecuteAction } from "../action/ActionExecutor";
import { GetSkillDefinition } from "./SkillCatalog";

/**
 * 地图级技能状态机。Handler只提交Cast命令；这里统一校验目标/距离/冷却，10Hz推进读条与弹道，
 * 并通过Action和Buff入口结算。整个判定与提交路径同步执行，不在中间await。
 *
 * Map-level skill state machine. Handlers only submit Cast commands. This
 * component validates target/range/cooldowns, advances casts and projectiles
 * at 10 Hz, then resolves through Action and Buff boundaries. Validation and
 * commit are synchronous and contain no await interleaving point.
 */
@systemFor(SkillMapComponent)
export class SkillMapComponentSystem extends SkillMapComponent {
  protected override Awake(map: MapComponent): void {
    this.map = map;
  }

  /** 地图销毁时丢弃未命中的弹道；不得跨Map保留Cast引用。 / Drops pending projectiles on map disposal and never retains casts across maps. */
  protected override OnDestroy(): void {
    this.activeCasterUnitIds.clear();
    this.projectiles.clear();
  }

  Cast(caster: PlayerUnit, command: SkillCastCommand): SkillCastState {
    this.requireCaster(caster);
    const definition = this.getDefinition(command.skillId);
    const skill = caster.GetComponent(SkillComponent);
    const now = TimeSystem.Instance.ServerNow;
    if (skill.IsCasting()) {
      throw new RpcError(GameErrCode.SkillBusy, `Unit ${caster.UnitId} is already casting`);
    }
    const readyAt = skill.ReadyAt(definition.id);
    if (now < readyAt) {
      throw new RpcError(GameErrCode.SkillCooldown, `skill ${definition.id} ready at ${readyAt}`);
    }
    const target = this.resolveTarget(caster, command.targetUnitId, definition);
    this.validateTarget(caster, target, definition);
    const vetoReason = this.DomainScene().Events.Check(SkillEvents.BeforeCast, {
      caster,
      target,
      definition,
    });
    if (vetoReason !== SystemErrCode.Success) {
      throw new RpcError(vetoReason, `skill ${definition.id} rejected by BeforeCast`);
    }
    this.validateRequiredAbsentBuff(target, definition);

    const cast = {
      castId: GlobalIdSystem.Instance.Next(),
      skillId: definition.id,
      targetUnitId: target.UnitId,
      startedAtMs: now,
      finishAtMs: now + definition.castTimeMs,
      definition,
    };
    let state = skill.Accept(cast, definition.cooldownMs, definition.globalCooldownMs);

    if (
      definition.castTimeMs > 0 &&
      definition.movementPolicy === SkillMovementPolicy.InterruptWhileCasting
    ) {
      // 读条开始必须立即终止旧的移动租约；之后新的非零输入会走InterruptByMovement。
      // Starting a cast must stop the previous movement lease immediately;
      // any later non-zero input interrupts through InterruptByMovement.
      NativeData.ResetMovement(caster.GetComponent(NativeUnitRef).Handle);
    }

    this.applyAutoAttackPolicy(caster, definition, "start");
    this.publishCastState(caster, state);

    if (definition.castTimeMs === 0) {
      this.launchOrResolve(caster, target, definition, cast.castId, now);
      this.applyAutoAttackPolicy(caster, definition, "complete");
      state = skill.Complete(cast.castId);
      this.publishCastState(caster, state);
    } else {
      this.activeCasterUnitIds.add(caster.UnitId);
    }
    return state;
  }

  InterruptByMovement(caster: PlayerUnit): boolean {
    this.requireCaster(caster);
    const skill = caster.GetComponent(SkillComponent);
    const active = skill.ActiveCast();
    if (!active) return false;
    const definition = active.definition;
    if (definition.movementPolicy !== SkillMovementPolicy.InterruptWhileCasting) return false;
    const state = skill.Interrupt("movement");
    if (!state) return false;
    this.activeCasterUnitIds.delete(caster.UnitId);
    this.publishCastState(caster, state);
    return true;
  }

  /** 10Hz桶只扫描活动施法者ID和本地图弹道；空闲Unit不进入循环，也不创建Timer。 / The 10 Hz bucket scans active caster ids and map projectiles only; idle Units never enter the loop and no per-cast timers exist. */
  Update10Hz(): void {
    if (this.map.IsStopping) return;
    const now = TimeSystem.Instance.ServerNow;
    for (const unitId of [...this.activeCasterUnitIds]) {
      const caster = this.units.Get<PlayerUnit>(unitId);
      if (!caster) {
        this.activeCasterUnitIds.delete(unitId);
        continue;
      }
      const skill = caster.GetComponent(SkillComponent);
      const cast = skill.ActiveCast();
      if (!cast) {
        this.activeCasterUnitIds.delete(unitId);
        continue;
      }
      if (now < cast.finishAtMs) continue;
      this.activeCasterUnitIds.delete(unitId);
      try {
        const definition = cast.definition;
        const target = this.resolveTarget(caster, cast.targetUnitId, definition);
        this.validateTargetAlive(target);
        if (definition.revalidateOnComplete) this.validateTargetRange(caster, target, definition);
        this.validateRequiredAbsentBuff(target, definition);
        this.launchOrResolve(caster, target, definition, cast.castId, now);
        this.applyAutoAttackPolicy(caster, definition, "complete");
        this.publishCastState(caster, skill.Complete(cast.castId));
      } catch (error) {
        const state = skill.Interrupt(error instanceof RpcError ? "cast-invalid" : "cast-error");
        if (state) this.publishCastState(caster, state);
        this.DomainScene().logger.warn("skill cast interrupted", {
          unitId: caster.UnitId,
          skillId: cast.skillId,
          error,
        });
      }
    }

    for (const projectile of [...this.projectiles.values()]) {
      if (now < projectile.impactAtMs) continue;
      this.projectiles.delete(projectile.castId);
      const caster = this.units.Get<PlayerUnit>(projectile.sourceUnitId);
      if (!caster) continue;
      try {
        const definition = projectile.definition;
        const target = this.resolveTarget(caster, projectile.targetUnitId, definition);
        this.validateTargetAlive(target);
        this.resolveEffects(caster, target, definition, projectile.castId);
      } catch (error) {
        this.DomainScene().logger.debug("skill projectile lost target", {
          castId: projectile.castId.toString(),
          skillId: projectile.skillId,
          targetUnitId: projectile.targetUnitId,
          error,
        });
      }
    }
  }

  private launchOrResolve(
    caster: PlayerUnit,
    target: Unit<any[]>,
    definition: SkillDefinition,
    castId: bigint,
    now: number,
  ): void {
    if (definition.delivery === SkillDelivery.Direct) {
      this.resolveEffects(caster, target, definition, castId);
      return;
    }
    const distance = this.distance(caster, target);
    const travelMs = Math.max(100, Math.ceil(
      distance / definition.projectileSpeedMetersPerSecond * 1_000,
    ));
    const projectile: SkillProjectile = {
      castId,
      skillId: definition.id,
      sourceUnitId: caster.UnitId,
      targetUnitId: target.UnitId,
      launchedAtMs: now,
      impactAtMs: now + travelMs,
      definition,
    };
    this.projectiles.set(castId, projectile);
    this.spawnPublish("publish-skill-projectile", () => this.map.PublishSkillProjectile(caster, target, projectile));
  }

  private resolveEffects(
    caster: PlayerUnit,
    primaryTarget: Unit<any[]>,
    definition: SkillDefinition,
    castId: bigint,
  ): void {
    let damage = 0n;
    let damageSchool: import("#tiangz/model").DamageSchoolValue = DamageSchool.Physical;
    let killed = false;
    for (const effect of definition.effects) {
      const target = effect.target === SkillEffectTarget.Caster ? caster : primaryTarget;
      if (effect.action.type === ActionType.AddBuff) {
        const configId = Number(effect.action.parameters[0]);
        const result = target.GetComponent(BuffComponent).ApplyBuff(configId, {
          ...effect.buffOptions,
          sourceUnitId: caster.UnitId,
          sourceAbilityId: definition.id,
        });
        if (result.status === BuffApplyStatus.Rejected) {
          throw new RpcError(
            GameErrCode.SkillBlockedByBuff,
            `BuffConfig ${configId} rejected skill ${definition.id}: ${result.reason}`,
          );
        }
        continue;
      }

      const result = this.executeEffect(caster, target, definition, effect);
      if (result) {
        damage += result.finalDamage;
        damageSchool = result.damageSchool;
        killed ||= result.killed;
      }
      if (killed) break;
    }
    this.spawnPublish("publish-skill-impact", () => this.map.PublishSkillImpact(caster, primaryTarget, {
      castId,
      skillId: definition.id,
      sourceUnitId: caster.UnitId,
      targetUnitId: primaryTarget.UnitId,
      damage,
      damageSchool,
      killed,
    }));
  }

  private executeEffect(
    caster: PlayerUnit,
    target: Unit<any[]>,
    definition: SkillDefinition,
    effect: SkillEffectDefinition,
  ): DamageResult | undefined {
    if (effect.action.type === ActionType.DealDamage && target instanceof MonsterUnit) {
      const amount = effect.action.parameters[0];
      const school = Number(effect.action.parameters[1]) as import("#tiangz/model").DamageSchoolValue;
      return this.DomainScene().GetComponent(MonsterComponent).ApplyPlayerDamage(caster, target, {
        amount,
        sourceUnitId: caster.UnitId,
        abilityId: definition.id,
        damageSchool: school,
      });
    }
    return ExecuteAction(target, effect.action, {
      sourceUnitId: caster.UnitId,
      sourceAbilityId: definition.id,
      reason: `skill:${definition.id}`,
    }).damage;
  }

  private resolveTarget(
    caster: PlayerUnit,
    targetUnitId: number,
    definition: SkillDefinition,
  ): Unit<any[]> {
    if (definition.relation === SkillTargetRelation.Friendly) {
      if (targetUnitId === 0 || targetUnitId === caster.UnitId) return caster;
      const player = this.units.Get<PlayerUnit>(targetUnitId);
      if (player) return player;
      throw new RpcError(GameErrCode.SkillTargetInvalid, `friendly target not found: ${targetUnitId}`);
    }
    const monster = this.units.Get<MonsterUnit>(targetUnitId);
    if (!monster) throw new RpcError(GameErrCode.SkillTargetInvalid, `enemy target not found: ${targetUnitId}`);
    return monster;
  }

  private validateTarget(caster: PlayerUnit, target: Unit<any[]>, definition: SkillDefinition): void {
    this.validateTargetAlive(target);
    this.validateTargetRange(caster, target, definition);
  }

  private validateTargetAlive(target: Unit<any[]>): void {
    if (target.GetComponent(NativeUnitRef).alive === 0) {
      throw new RpcError(GameErrCode.SkillTargetInvalid, `target is dead: ${target.UnitId}`);
    }
  }

  private validateTargetRange(caster: PlayerUnit, target: Unit<any[]>, definition: SkillDefinition): void {
    if (this.distance(caster, target) > definition.rangeMeters) {
      throw new RpcError(GameErrCode.SkillTargetTooFar, `target is outside ${definition.rangeMeters}m`);
    }
  }

  /**
   * 按配置处理技能与平A时间线；只在策略真正改变状态时发布一次，不把“法术/物理”当隐式规则。
   * Applies the configured skill/auto-attack relation and publishes only when
   * the selected policy changes state; damage school never implies this rule.
   */
  private applyAutoAttackPolicy(
    caster: PlayerUnit,
    definition: SkillDefinition,
    phase: "start" | "complete",
  ): void {
    const combat = caster.GetComponent(CombatComponent);
    const shouldReset =
      (phase === "start" && definition.autoAttackPolicy === SkillAutoAttackPolicy.ResetOnStart) ||
      (phase === "complete" && definition.autoAttackPolicy === SkillAutoAttackPolicy.ResetOnComplete);
    const shouldCancel = phase === "start" && definition.autoAttackPolicy === SkillAutoAttackPolicy.Cancel;
    if (!shouldReset && !shouldCancel) return;
    const state = shouldCancel
      ? combat.ToggleAutoAttack(0, false)
      : combat.ResetAutoAttackSwing();
    this.spawnPublish("publish-skill-auto-attack-policy", () => this.map.PublishAutoAttackState(caster, state));
  }

  /** Veto负责可扩展的提前错误，结算前仍保留同一不变量，避免未来入口绕过事件链。 / Veto reports extensible errors early while this invariant remains before resolution so future entrypoints cannot bypass it. */
  private validateRequiredAbsentBuff(target: Unit<any[]>, definition: SkillDefinition): void {
    if (definition.requiredAbsentBuffConfigId > 0 && target.GetComponent(BuffComponent).HasBuffConfig(definition.requiredAbsentBuffConfigId)) {
      throw new RpcError(
        GameErrCode.SkillBlockedByBuff,
        `target has blocking BuffConfig ${definition.requiredAbsentBuffConfigId}`,
      );
    }
  }

  private distance(left: Unit<any[]>, right: Unit<any[]>): number {
    const a = left.GetComponent(PositionComponent);
    const b = right.GetComponent(PositionComponent);
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  }

  private getDefinition(skillId: number): SkillDefinition {
    try {
      return GetSkillDefinition(skillId);
    } catch (error) {
      throw new RpcError(GameErrCode.SkillNotFound, error instanceof Error ? error.message : String(error));
    }
  }

  private publishCastState(caster: PlayerUnit, state: SkillCastState): void {
    this.spawnPublish("publish-skill-cast-state", () => this.map.PublishSkillCastState(caster, state));
  }

  private spawnPublish(name: string, publish: () => Promise<void>): void {
    this.DomainScene().Tasks.Spawn(name, publish);
  }

  private requireCaster(caster: PlayerUnit): void {
    if (this.units.Get<PlayerUnit>(caster.UnitId) !== caster || caster.GetComponent(NativeUnitRef).alive === 0) {
      throw new RpcError(GameErrCode.PlayerDead, `invalid caster: ${caster.UnitId}`);
    }
  }

  private get units(): UnitComponent {
    return this.DomainScene().GetComponent(UnitComponent);
  }
}
