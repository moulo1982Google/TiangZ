import {
  GameConfigRegistry,
  GameConfigs,
  type SkillDefinition,
  type SkillEffectDefinition,
} from "#tiangz/model";
import { ActionFromConfig } from "../action/ActionExecutor";

let cachedFingerprint = "";
let cachedDefinitions: ReadonlyMap<number, SkillDefinition> = new Map();
type SkillEffectConfigRow = ReturnType<typeof GameConfigs.SkillEffectConfig.GetAll>[number];

/**
 * 返回当前配置代的技能定义。缓存按游戏配置指纹整体重建，保证一次Cast只看到同一份规则，
 * Reload之后的新Cast自动使用新数据；不得把返回对象长期存入Unit或Component。
 *
 * Returns the skill definition for the active config generation. The index is
 * rebuilt atomically when the game-config fingerprint changes, so one Cast
 * observes one rule set while later Casts use reloaded data. Unit and Component
 * state must never retain the returned object long-term.
 */
export function GetSkillDefinition(skillId: number): SkillDefinition {
  const fingerprint = GameConfigRegistry.CurrentFingerprint;
  if (!fingerprint) throw new Error("game config data is not installed");
  if (fingerprint !== cachedFingerprint) rebuildCatalog(fingerprint);
  const definition = cachedDefinitions.get(skillId);
  if (!definition) throw new Error(`skill config not found: ${skillId}`);
  return definition;
}

/** 将Luban两张表合并为运行时只读索引；这是数据适配，不承担施法或效果结算。 / Merges the two Luban tables into a read-only runtime index without owning cast or effect resolution. */
function rebuildCatalog(fingerprint: string): void {
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
      effects: Object.freeze(effects),
    }));
  }
  cachedDefinitions = definitions;
  cachedFingerprint = fingerprint;
}
