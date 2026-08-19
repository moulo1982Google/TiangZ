import {
  ActionType,
  BuffApplyStatus,
  BuffComponent,
  CombatComponent,
  GameConfigRegistry,
  DamageSchool,
  GameErrCode,
  GlobalIdSystem,
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
import { BuildSkillCatalog, GetSkillDefinitionFromCatalog } from "./SkillCatalog";
import { GetSkillManaCost } from "./SkillManaCost";

// 受击调整Demo施法时间线的统一规则；业务入口不应散落硬编码的毫秒数。
// Shared Demo rule for hit-induced cast timing; business entry points must not scatter magic durations.
const CAST_DAMAGE_PUSHBACK_MS = 800;
const CHANNEL_DAMAGE_REDUCTION_MS = 800;

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
    this.pendingPublishes.clear();
    this.publishDrainActive = false;
    this.skillCatalogDefinitions = undefined;
    this.skillCatalogFingerprint = "";
  }

  Cast(caster: PlayerUnit, command: SkillCastCommand): SkillCastState {
    this.requireCaster(caster);
    const definition = this.getDefinition(command.skillId);
    const skill = caster.GetComponent(SkillComponent);
    const now = TimeSystem.Instance.ServerNow;
    if (skill.IsCasting()) {
      return this.queueCast(caster, skill, command, definition, now);
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
    const manaCost = GetSkillManaCost(definition.id);
    const numeric = caster.GetComponent(NumericComponent);
    const currentMp = numeric[NumericType.CurrentMp];
    if (currentMp < manaCost) {
      throw new RpcError(
        GameErrCode.ManaNotEnough,
        `skill ${definition.id} requires ${manaCost} mana, current ${currentMp}`,
      );
    }

    const cast = {
      castId: GlobalIdSystem.Instance.Next(),
      skillId: definition.id,
      targetUnitId: target.UnitId,
      startedAtMs: now,
      finishAtMs: now + definition.castTimeMs,
      nextTickAtMs: definition.channelTickMs > 0 ? now + definition.channelTickMs : 0,
      channelTicksCompleted: 0,
      definition,
    };
    let state = skill.Accept(cast, definition.cooldownMs, definition.globalCooldownMs);
    // 技能一旦通过目标、Veto、CD和施法状态校验就消耗蓝；后续命中失败不回滚，避免重复施法套利。
    // Mana is spent after all admission checks pass; later impact failure does
    // not refund it, preventing retries from turning a cast into a free action.
    if (manaCost > 0n) numeric[NumericType.CurrentMp] = currentMp - manaCost;

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

  /**
   * 处理Combat确认的“没有被护盾吸收”的施法受击：普通读条后移800毫秒，
   * 引导技能缩短剩余时间800毫秒。调用方必须先完成Combat结算；护盾吸收的攻击
   * 不应进入此入口。这里只调整结束时间，不重置起点、Tick计数、技能CD或公共CD，
   * 处理后立即发布新的权威状态。
   *
   * Handles a casting hit that Combat confirmed was not absorbed by a shield: a
   * regular cast is pushed back by 800 ms, while a channel loses 800 ms of
   * remaining time. Callers must resolve Combat first; shield-absorbed hits must
   * not enter this boundary. The start time, completed ticks, skill cooldown,
   * and GCD stay unchanged; the new authoritative state is published immediately.
   */
  HandleDamageDuringCast(target: PlayerUnit): boolean {
    if (this.units.Get<PlayerUnit>(target.UnitId) !== target) return false;
    const skill = target.GetComponent(SkillComponent);
    const active = skill.ActiveCast();
    if (!active || active.definition.castTimeMs <= 0) return false;
    const state = active.definition.channelTicks > 0
      ? skill.ReduceActiveCast(
        active.castId,
        CHANNEL_DAMAGE_REDUCTION_MS,
        TimeSystem.Instance.ServerNow,
      )
      : skill.ExtendActiveCast(active.castId, CAST_DAMAGE_PUSHBACK_MS);
    if (!state) return false;
    this.publishCastState(target, state);
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
      try {
        const definition = cast.definition;
        if (definition.channelTicks > 0) {
          this.advanceChannel(caster, skill, cast, now);
        }
        const currentCast = skill.ActiveCast();
        if (!currentCast || now < currentCast.finishAtMs) continue;
        if (
          definition.channelTicks > 0 &&
          currentCast.channelTicksCompleted < definition.channelTicks &&
          now < currentCast.finishAtMs
        ) {
          continue;
        }
        this.activeCasterUnitIds.delete(unitId);
        const queued = skill.TakeQueued();
        if (definition.channelTicks === 0) {
          const target = this.resolveTarget(caster, cast.targetUnitId, definition);
          this.validateTargetAlive(target);
          if (definition.revalidateOnComplete) this.validateTargetRange(caster, target, definition);
          this.validateRequiredAbsentBuff(target, definition);
          this.launchOrResolve(caster, target, definition, cast.castId, now);
        }
        this.applyAutoAttackPolicy(caster, definition, "complete");
        this.publishCastState(caster, skill.Complete(cast.castId));
        this.startQueuedCast(caster, queued);
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

  /**
   * 施法者进入队列窗口后只缓存一个下一技能；缓存不消耗CD，真正开始时会重新校验目标、距离、Veto和Buff条件。
   *
   * Once a caster enters the configured queue window, only one next skill is
   * buffered. Buffering consumes no cooldown; target, range, veto, and Buff
   * conditions are checked again when the queued cast actually starts.
   */
  private queueCast(
    caster: PlayerUnit,
    skill: SkillComponent,
    command: SkillCastCommand,
    definition: SkillDefinition,
    now: number,
  ): SkillCastState {
    const active = skill.ActiveCast();
    if (!active || definition.queueWindowMs <= 0 || active.finishAtMs - now > definition.queueWindowMs) {
      throw new RpcError(GameErrCode.SkillBusy, `Unit ${caster.UnitId} is already casting`);
    }
    if (skill.ReadyAt(definition.id) > active.finishAtMs) {
      throw new RpcError(GameErrCode.SkillCooldown, `skill ${definition.id} is not ready after the current cast`);
    }
    const target = this.resolveTarget(caster, command.targetUnitId, definition);
    this.validateTarget(caster, target, definition);
    const state = skill.Queue(command, active.finishAtMs);
    this.publishCastState(caster, state);
    return state;
  }

  /** 推进所有已经到点的引导跳数；单次最多补8跳，避免长时间停顿造成无界结算洪峰。 / Resolves due channel ticks with an eight-tick cap to avoid an unbounded catch-up burst after a stall. */
  private advanceChannel(
    caster: PlayerUnit,
    skill: SkillComponent,
    cast: import("#tiangz/model").ActiveSkillCast,
    now: number,
  ): void {
    const { definition } = cast;
    let nextTickAtMs = cast.nextTickAtMs;
    let completed = cast.channelTicksCompleted;
    let processed = 0;
    while (
      completed < definition.channelTicks &&
      now >= nextTickAtMs &&
      nextTickAtMs <= cast.finishAtMs &&
      processed < 8
    ) {
      const target = this.resolveTarget(caster, cast.targetUnitId, definition);
      this.validateTargetAlive(target);
      if (definition.revalidateOnComplete) this.validateTargetRange(caster, target, definition);
      this.resolveEffects(caster, target, definition, cast.castId);
      completed += 1;
      processed += 1;
      nextTickAtMs += definition.channelTickMs;
      this.publishCastState(caster, skill.UpdateChannel(cast.castId, nextTickAtMs, completed));
    }
  }

  /** 当前Cast完成后立即尝试启动缓存技能；失败只丢弃缓存，不回滚已经完成的技能。 / Starts the buffered skill after the current cast; a failure only drops the buffer and never rolls back the completed skill. */
  private startQueuedCast(caster: PlayerUnit, command: SkillCastCommand | undefined): void {
    if (!command) return;
    try {
      this.Cast(caster, command);
    } catch (error) {
      this.DomainScene().logger.debug("queued skill rejected at start", {
        unitId: caster.UnitId,
        skillId: command.skillId,
        targetUnitId: command.targetUnitId,
        error,
      });
      this.publishCastState(caster, caster.GetComponent(SkillComponent).State(command.skillId));
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
      const fingerprint = GameConfigRegistry.CurrentFingerprint;
      if (!fingerprint) throw new Error("game config data is not installed");
      if (
        !this.skillCatalogDefinitions ||
        this.skillCatalogFingerprint !== fingerprint
      ) {
        this.skillCatalogDefinitions = BuildSkillCatalog();
        this.skillCatalogFingerprint = fingerprint;
      }
      return GetSkillDefinitionFromCatalog(this.skillCatalogDefinitions, skillId);
    } catch (error) {
      throw new RpcError(GameErrCode.SkillNotFound, error instanceof Error ? error.message : String(error));
    }
  }

  private publishCastState(caster: PlayerUnit, state: SkillCastState): void {
    this.spawnPublish("publish-skill-cast-state", () => this.map.PublishSkillCastState(caster, state));
  }

  private spawnPublish(name: string, publish: () => Promise<void>): void {
    let delivery: Promise<void>;
    try {
      delivery = publish();
    } catch (error) {
      this.DomainScene().logger.error("skill state publish failed", { name, error });
      return;
    }
    const tracked = Promise.resolve(delivery).catch((error) => {
      this.DomainScene().logger.error("skill state publish failed", { name, error });
    });
    this.pendingPublishes.add(tracked);
    void tracked.finally(() => this.pendingPublishes.delete(tracked));
    if (this.publishDrainActive) return;

    this.publishDrainActive = true;
    try {
      this.DomainScene().Tasks.Spawn("publish-skill-state-drain", async ({ signal }) => {
        try {
          while (!signal.aborted && this.pendingPublishes.size > 0) {
            await Promise.all([...this.pendingPublishes]);
          }
        } finally {
          this.publishDrainActive = false;
        }
      });
    } catch (error) {
      this.publishDrainActive = false;
      this.DomainScene().logger.error("skill state publish drain failed to start", { error });
    }
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
