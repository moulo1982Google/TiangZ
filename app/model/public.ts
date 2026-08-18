/**
 * Model 的唯一公共入口。Hotfix 只能从这里取得稳定类型，禁止深层导入 Model 文件。
 * 该模块随 Process 启动后永久固定；修改它必须重新部署并重启 Process。
 *
 * The only public Model entrypoint. Hotfix code must resolve stable types here
 * instead of deep-importing Model files. This module is immutable for the
 * lifetime of a Process; changing it requires deployment and Process restart.
 */
export * from "../core/public";

export * from "../generated/model/server/demo/protocol/messages";
export {
  ClientMessages,
  GateMessages,
  MapMessages,
} from "../generated/model/server/demo/protocol/messageDescriptors";
export { ClientBroadcasts } from "../generated/model/server/demo/protocol/broadcastDescriptors";
export {
  GateProtocol,
  LoginMgrProtocol,
  LoginProtocol,
  MapProtocol,
  MapTransferProtocol,
  MapInstanceProtocol,
  DynamicMapProtocol,
  MapHostControlProtocol,
  LocationProtocol,
} from "../generated/model/server/demo/protocol/rpcs";
export {
  MapCapacityBenchProtocol,
  StateSyncBenchProtocol,
} from "../generated/model/server/bench/protocol/rpcs";
export type {
  C2G_MapCapacityEnter,
  C2M_MapCapacityPlace,
  C2M_StateSyncBench,
  G2C_MapCapacityEnter,
  M2C_MapCapacityPlace,
  M2C_StateSyncBench,
} from "../generated/model/server/bench/protocol/messages";

export { GateSession } from "./mmorpg/gate/GateSession";
export { LocationComponent } from "./mmorpg/location/LocationComponent";
export { MapInstanceDirectoryComponent } from "./mmorpg/location/MapInstanceDirectoryComponent";
export { LocationProxy } from "./mmorpg/location/LocationProxy";
export { MessageHelper } from "./mmorpg/location/MessageHelper";
export {
  GatePlayerRoute,
  type GateActorRouteState,
  type GatePlayerMapLocation,
  type GatePlayerRouteState,
} from "./mmorpg/gate/GatePlayerRoute";
export {
  ItemComponent,
  type InventoryConsumePlan,
  type InventoryGrant,
  type InventoryGrantPlan,
  type InventoryReplacePlan,
  type InventoryGrantResult,
} from "./mmorpg/item/ItemComponent";
export { Item, type AwakeItem, type ItemView, type ItemNativeData } from "./mmorpg/item/Item";
export { ItemEvents, type BeforeUseItemEvent } from "./mmorpg/item/ItemEvents";
export {
  CanClaimRegularLoot,
  CopyLootItems,
  ToInventoryGrants,
  ToLootDropSnapshots,
  type LootContainer,
  type LootDrop,
} from "./mmorpg/loot/LootContainer";
export { Quest, type AwakeQuest, type QuestObjectiveState, type QuestState } from "./mmorpg/quest/Quest";
export {
  QuestComponent,
  type QuestObjectiveIndexEntry,
  type QuestRewardResult,
  type QuestTransferState,
} from "./mmorpg/quest/QuestComponent";
export { QuestEvents, type BeforeAcceptQuestEvent, type QuestProgressEvent } from "./mmorpg/quest/QuestEvents";
export { MonsterEvents, type MonsterKilledEvent } from "./mmorpg/monster/MonsterEvents";
export type { RewardDefinition, RewardResult } from "./mmorpg/reward/Reward";
export type { RewardPlan } from "./domains/reward/RewardPlan";
export { NativeItemRef } from "../generated/model/native/NativeItemRef";
export {
  ActionType,
  type ActionDefinition,
  type ActionExecutionContext,
  type ActionTypeValue,
} from "./mmorpg/action/ActionType";
export {
  Buff,
  type AwakeBuff,
  type BuffPublicState,
  type BuffRefreshRequest,
  type BuffTransferState,
} from "./mmorpg/buff/Buff";
export {
  BuffApplyStatus,
  BuffComponent,
  type BuffAddOptions,
  type BuffApplyResult,
  type BuffApplyStatusValue,
} from "./mmorpg/buff/BuffComponent";
export {
  SkillCastPhase,
  SkillComponent,
  type ActiveSkillCast,
  type ItemCooldownCommitResult,
  type ItemCooldownPlan,
  type ItemCooldownTransferState,
  type SkillCastCommand,
  type SkillCastPhaseValue,
  type SkillCastState,
  type SkillCooldownTransferState,
  type SkillTransferState,
} from "./mmorpg/skill/SkillComponent";
export {
  SkillMapComponent,
  type SkillProjectile,
} from "./mmorpg/skill/SkillMapComponent";
export {
  SkillAutoAttackPolicy,
  SkillDelivery,
  SkillEffectTarget,
  SkillMovementPolicy,
  SkillTargetRelation,
  type SkillAutoAttackPolicyValue,
  type SkillDefinition,
  type SkillDeliveryValue,
  type SkillEffectDefinition,
  type SkillEffectTargetValue,
  type SkillMovementPolicyValue,
  type SkillTargetRelationValue,
} from "./mmorpg/skill/SkillDefinition";
export { SkillEvents, type BeforeCastSkillEvent } from "./mmorpg/skill/SkillEvents";
export { MapComponent } from "./mmorpg/map/MapComponent";
export { MapAoiComponent } from "./mmorpg/map/MapAoiComponent";
export { MapScene } from "./mmorpg/map/MapScene";
export {
  PlayerUnit,
  type AwakePlayerUnit,
  type FindNavigationPath,
  type NavigatePlayerTo,
  type NavigatePlayerInput,
  type MatchPlayerGate,
  type MovePlayer,
  type PlayerSnapshot,
} from "./mmorpg/map/PlayerUnit";
export { PositionComponent } from "./mmorpg/map/PositionComponent";
export { UnitGateComponent } from "./mmorpg/map/UnitGateComponent";
export { MapHostComponent } from "./mmorpg/mapHost/MapHostComponent";
export {
  MapHostEndpointFromScene,
  SceneConfigFromMapHostEndpoint,
  SceneConfigFromMapInstance,
} from "./mmorpg/mapHost/MapHostEndpoint";
export { DynamicMapLifecycleComponent } from "./mmorpg/mapHost/DynamicMapLifecycleComponent";
export { MapHostRegistrationComponent } from "./mmorpg/mapHost/MapHostRegistrationComponent";
export { MapManagerComponent } from "./mmorpg/mapManager/MapManagerComponent";
export { DynamicMapProxy } from "./mmorpg/mapHost/DynamicMapProxy";
export { NumericComponent, type NumericInitialValues } from "./domains/numeric/NumericComponent";
export { CurrencyComponent } from "./domains/currency/CurrencyComponent";
export { BaseNumericType } from "./domains/numeric/NumericType";
export {
  AllNumericTypes,
  IsDerivedNumericType,
  MoveSpeedMetersPerSecondToNumeric,
  NUMERIC_MOVE_SPEED_SCALE,
  NumericType,
  type NumericType as NumericTypeValue,
} from "./mmorpg/numeric/NumericType";
export { NativeOps } from "../generated/model/native/NativeOps";
export { LoginComponent } from "./mmorpg/login/LoginComponent";
export {
  CreateCharacterRepository,
  CharacterAccountAlreadyExistsError,
  type AccountCredential,
  type CharacterCatalog,
  type CharacterRecord,
  type CharacterRepository,
} from "./mmorpg/login/CharacterRepository";
export {
  CreatePasswordCredential,
  VerifyPassword,
  type PasswordCredential,
} from "./mmorpg/login/PasswordHash";
export { DecodeLoginToken, EncodeLoginToken, type LoginTokenClaims } from "./mmorpg/login/LoginToken";
export { SelectStickyGate, SelectStickyScene } from "./mmorpg/login/GateSelector";
export { PlayerPersistenceComponent } from "./mmorpg/persistence/PlayerPersistenceComponent";
export {
  ProgressionComponent,
  type ProgressionRewardResult,
  type ProgressionTransferState,
  type StarterDungeonEntryResult,
} from "./mmorpg/progression/ProgressionComponent";
export {
  STARTER_DUNGEON_BOSS_CONFIG_ID,
  STARTER_DUNGEON_BOSS_EXPERIENCE,
  STARTER_DUNGEON_COOLDOWN_MS,
  STARTER_DUNGEON_EXIT_MAP_INSTANCE_ID,
  STARTER_DUNGEON_MAP_CONFIG_ID,
} from "./mmorpg/dungeon/StarterDungeon";
export type { PlayerSaveData } from "./mmorpg/persistence/PlayerRepository";
export {
  NativeData,
  type NativeRaycastHit,
  type NativeVec3,
} from "./mmorpg/native/NativeData";
export { NativeUnitRef } from "../generated/model/native/NativeUnitRef";
export { GameErrCode } from "./game/protocol/GameErrCode";
export {
  GameConfigRegistry,
  GameConfigSchemaFingerprint,
  GameConfigs,
  BuffConflictPolicy,
  BuffRefreshStatePolicy,
  BuffRefreshTickPolicy,
  BuffStackScope,
  SpatialMode,
  type ItemConfig as ItemConfigData,
  type BuffConfig as BuffConfigData,
  type MapConfig as MapConfigData,
  type PlayerConfig as PlayerConfigData,
  type MonsterConfig as MonsterConfigData,
  type MonsterAreaConfig as MonsterAreaConfigData,
  type DropTableConfig as DropTableConfigData,
  type SkillConfig as SkillConfigData,
  type SkillEffectConfig as SkillEffectConfigData,
  QuestObjectiveType,
  QuestStatus,
  type QuestConfig as QuestConfigData,
  type QuestObjectiveConfig as QuestObjectiveConfigData,
} from "../generated/model/config";
export {
  MonsterComponent,
  type MonsterRuntimeState,
  type MonsterSpawnSlot,
} from "./mmorpg/monster/MonsterComponent";
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
} from "./mmorpg/combat/CombatComponent";
export { CombatStateComponent } from "./mmorpg/combat/CombatStateComponent";
export {
  MonsterUnit,
  type AwakeMonsterUnit,
  type MonsterSnapshot,
} from "./mmorpg/monster/MonsterUnit";
export {
  NpcUnit,
  type AwakeNpcUnit,
  type NpcSnapshot,
} from "./mmorpg/npc/NpcUnit";
export {
  NpcComponent,
  STARTER_NPC_CONFIG_ID,
  STARTER_NPC_INTERACT_RANGE_METERS,
  STARTER_NPC_NAME,
  STARTER_NPC_QUEST_CONFIG_IDS,
  STARTER_NPC_UNIT_ID,
  STARTER_SHOP_NPC_CONFIG_ID,
  STARTER_SHOP_NPC_NAME,
  STARTER_SHOP_NPC_UNIT_ID,
} from "./mmorpg/npc/NpcComponent";
export { NpcShopComponent } from "./mmorpg/shop/NpcShopComponent";
export {
  PlayerTradeCloseReason,
  PlayerTradeComponent,
  PlayerTradePhase,
  type PlayerTradeOfferState,
  type PlayerTradeSession,
} from "./mmorpg/trade/PlayerTradeComponent";
export { GateScene } from "./mmorpg/scenes/GateScene";
export { LoginScene } from "./mmorpg/scenes/LoginScene";
export { LocationScene } from "./mmorpg/scenes/LocationScene";
export { MapHostScene } from "./mmorpg/scenes/MapHostScene";
export { MapManagerScene } from "./mmorpg/scenes/MapManagerScene";
