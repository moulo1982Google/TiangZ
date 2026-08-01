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

export { GateSession } from "./demo/gate/GateSession";
export { LocationComponent } from "./demo/location/LocationComponent";
export { MapInstanceDirectoryComponent } from "./demo/location/MapInstanceDirectoryComponent";
export { LocationProxy } from "./demo/location/LocationProxy";
export { MessageHelper } from "./demo/location/MessageHelper";
export {
  GatePlayerRoute,
  type GateActorRouteState,
  type GatePlayerMapLocation,
  type GatePlayerRouteState,
} from "./demo/gate/GatePlayerRoute";
export { ItemComponent } from "./demo/item/ItemComponent";
export { Item, type AwakeItem, type ItemView } from "./demo/item/Item";
export { NativeItemRef } from "../generated/model/native/NativeItemRef";
export { MapComponent } from "./demo/map/MapComponent";
export { MapAoiComponent } from "./demo/map/MapAoiComponent";
export { MapScene } from "./demo/map/MapScene";
export {
  PlayerUnit,
  type AwakePlayerUnit,
  type MatchPlayerGate,
  type MovePlayer,
  type PlayerSnapshot,
} from "./demo/map/PlayerUnit";
export { PositionComponent } from "./demo/map/PositionComponent";
export { UnitGateComponent } from "./demo/map/UnitGateComponent";
export { MapHostComponent } from "./demo/mapHost/MapHostComponent";
export {
  MapHostEndpointFromScene,
  SceneConfigFromMapHostEndpoint,
  SceneConfigFromMapInstance,
} from "./demo/mapHost/MapHostEndpoint";
export { DynamicMapLifecycleComponent } from "./demo/mapHost/DynamicMapLifecycleComponent";
export { MapHostRegistrationComponent } from "./demo/mapHost/MapHostRegistrationComponent";
export { MapManagerComponent } from "./demo/mapManager/MapManagerComponent";
export { DynamicMapProxy } from "./demo/mapHost/DynamicMapProxy";
export { NumericComponent } from "./demo/numeric/NumericComponent";
export {
  AllNumericTypes,
  IsDerivedNumericType,
  NumericType,
  type NumericType as NumericTypeValue,
} from "./demo/numeric/NumericType";
export { NativeOps } from "../generated/model/native/NativeOps";
export { LoginComponent } from "./demo/login/LoginComponent";
export { SelectStickyGate } from "./demo/login/GateSelector";
export { PlayerPersistenceComponent } from "./demo/persistence/PlayerPersistenceComponent";
export { NativeData } from "./demo/native/NativeData";
export { NativeUnitRef } from "../generated/model/native/NativeUnitRef";
export { GameErrCode } from "./game/protocol/GameErrCode";
export {
  GameConfigRegistry,
  GameConfigSchemaFingerprint,
  GameConfigs,
  type ItemConfig as ItemConfigData,
  type MapConfig as MapConfigData,
  type PlayerConfig as PlayerConfigData,
} from "../generated/model/config";
export { GateScene } from "./demo/scenes/GateScene";
export { LoginScene } from "./demo/scenes/LoginScene";
export { LocationScene } from "./demo/scenes/LocationScene";
export { MapHostScene } from "./demo/scenes/MapHostScene";
export { MapManagerScene } from "./demo/scenes/MapManagerScene";
