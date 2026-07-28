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
export {
  GateProtocol,
  LoginMgrProtocol,
  LoginProtocol,
  MapProtocol,
} from "../generated/model/server/demo/protocol/rpcs";
export { StateSyncBenchProtocol } from "../generated/model/server/bench/protocol/rpcs";
export type {
  C2M_StateSyncBench,
  M2C_StateSyncBench,
} from "../generated/model/server/bench/protocol/messages";

export { GateSession } from "./demo/gate/GateSession";
export { ItemComponent } from "./demo/item/ItemComponent";
export { Item, type AwakeItem, type ItemView } from "./demo/item/Item";
export { NativeItemRef } from "../generated/model/native/NativeItemRef";
export { MapComponent } from "./demo/map/MapComponent";
export { MapScene } from "./demo/map/MapScene";
export {
  PlayerUnit,
  type AwakePlayerUnit,
  type MatchPlayerGate,
  type MovePlayer,
  type PlayerSnapshot,
  type RebindPlayerGate,
} from "./demo/map/PlayerUnit";
export { PositionComponent } from "./demo/map/PositionComponent";
export { UnitGateComponent } from "./demo/map/UnitGateComponent";
export { MapHostComponent } from "./demo/mapHost/MapHostComponent";
export { NumericComponent } from "./demo/numeric/NumericComponent";
export {
  AllNumericTypes,
  NumericType,
  type NumericType as NumericTypeValue,
} from "./demo/numeric/NumericType";
export { NativeOps } from "../generated/model/native/NativeOps";
export { LoginComponent } from "./demo/login/LoginComponent";
export { PlayerPersistenceComponent } from "./demo/persistence/PlayerPersistenceComponent";
export { NativeData } from "./demo/native/NativeData";
export { NativeUnitRef } from "../generated/model/native/NativeUnitRef";
export { GameErrCode } from "./game/protocol/GameErrCode";
export { GateScene } from "./demo/scenes/GateScene";
export { LoginScene } from "./demo/scenes/LoginScene";
export { MapHostScene } from "./demo/scenes/MapHostScene";
