import {
  GameConfigRegistry,
  GameConfigs,
  type SkillDefinition,
  type SkillEffectDefinition,
} from "#tiangz/model";
import { ActionFromConfig } from "../action/ActionExecutor";

type SkillEffectConfigRow = ReturnType<typeof GameConfigs.SkillEffectConfig.GetAll>[number];

/**
 * 返回当前配置代的技能定义。独立调用每次构建临时索引；正式施法由地图组件按配置指纹缓存，
 * 保证一次Cast只看到同一份规则，Reload之后的新Cast自动使用新数据。
 *
 * Returns the skill definition for the active config generation. Standalone
 * calls build a temporary index; live casts use the map component's
 * fingerprinted cache so one Cast observes one rule set while later Casts use
 * reloaded data.
 */
export function GetSkillDefinition(skillId: number): SkillDefinition {
  const fingerprint = GameConfigRegistry.CurrentFingerprint;
  if (!fingerprint) throw new Error("game config data is not installed");
  return GetSkillDefinitionFromCatalog(BuildSkillCatalog(), skillId);
}

/**
 * 构建当前配置代的只读技能索引；调用者负责把索引放在自己的地图组件中缓存。
 * Builds a read-only skill index for the active config generation; callers cache it in their own map component.
 */
export function BuildSkillCatalog(): ReadonlyMap<number, SkillDefinition> {
  if (!GameConfigRegistry.CurrentFingerprint) {
    throw new Error("game config data is not installed");
  }
  return buildCatalog();
}

/** 从地图级索引读取技能定义；找不到时保持统一错误语义。 / Reads a skill definition from a map-owned index with one consistent missing-data error. */
export function GetSkillDefinitionFromCatalog(
  definitions: ReadonlyMap<number, SkillDefinition>,
  skillId: number,
): SkillDefinition {
  const definition = definitions.get(skillId);
  if (!definition) throw new Error(`skill config not found: ${skillId}`);
  return definition;
}

/** 将Luban两张表合并为运行时只读索引；这是数据适配，不承担施法或效果结算。 / Merges the two Luban tables into a read-only runtime index without owning cast or effect resolution. */
function buildCatalog(): ReadonlyMap<number, SkillDefinition> {
  const effectsBySkill = new Map<number, SkillEffectConfigRow[]>();
  for (const effect of GameConfigs.SkillEffectConfig.GetAll()) {
    const rows = effectsBySkill.get(effect.skillId) ?? [];
    effectsBySkill.set(effect.skillId, [...rows, effect]);
  }

  const definitions = new Map<number, SkillDefinition>();
  for (const config of GameConfigs.SkillConfig.GetAll()) {
    const effects = (effectsBySkill.get(config.id) ?? [])
      .slice()
      .sort((left, right) => left.order - right.order || left.id - right.id)
      .map((effect): SkillEffectDefinition => {
        const action = ActionFromConfig(effect.actionType, effect.actionParams);
        return Object.freeze({
          target: effect.target as SkillEffectDefinition["target"],
          action: Object.freeze({
            type: action.type,
            parameters: Object.freeze([...action.parameters]),
          }),
        });
      });
    if (effects.length === 0) throw new Error(`skill config ${config.id} has no effects`);
    definitions.set(config.id, Object.freeze({
      id: config.id,
      name: config.name,
      description: config.description,
      relation: config.targetRelation as SkillDefinition["relation"],
      castTimeMs: config.castTimeMs,
      cooldownMs: config.cooldownMs,
      globalCooldownMs: config.globalCooldownMs,
      rangeMeters: config.rangeMeters,
      delivery: config.delivery as SkillDefinition["delivery"],
      projectileSpeedMetersPerSecond: config.projectileSpeedMetersPerSecond,
      movementPolicy: config.movementPolicy as SkillDefinition["movementPolicy"],
      autoAttackPolicy: config.autoAttackPolicy as SkillDefinition["autoAttackPolicy"],
      revalidateOnComplete: config.revalidateOnComplete,
      requiredAbsentBuffConfigId: config.requiredAbsentBuffConfigId,
      queueWindowMs: config.queueWindowMs,
      channelTickMs: config.channelTickMs,
      channelTicks: config.channelTicks,
      effects: Object.freeze(effects),
    }));
  }
  return definitions;
}
