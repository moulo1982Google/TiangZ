/** MMORPG compatibility facade; map-level target selection remains in SkillMapComponent. / MMORPG兼容门面；地图级目标选择仍由SkillMapComponent负责。 */
export {
  SkillCastPhase,
  SkillComponent,
  type ActiveSkillCast,
  type ItemCooldownCommitResult,
  type ItemCooldownPlan,
  type QueuedSkillCast,
  type SkillCastCommand,
  type SkillCastPhaseValue,
  type SkillCastState,
  type SkillCooldownTransferState,
  type ItemCooldownTransferState,
  type SkillTransferState,
} from "../../domains/skill/SkillComponent";
