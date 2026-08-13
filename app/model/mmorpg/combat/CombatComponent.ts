/** MMORPG compatibility facade; range, threat, and map scheduling stay outside the reusable component. / MMORPG兼容门面；距离、仇恨和地图调度不进入可复用组件。 */
export {
  AutoAttackPhase,
  CombatComponent,
  DamageSchool,
  type AutoAttackPhaseValue,
  type AutoAttackState,
  type DamageAbsorberState,
  type DamageAbsorption,
  type DamageRequest,
  type DamageResult,
  type DamageSchoolValue,
  type HealingResult,
  type HealingPlan,
} from "../../domains/combat/CombatComponent";
