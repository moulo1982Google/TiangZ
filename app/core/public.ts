/**
 * TiangZ业务代码的稳定公共入口。未从本文件导出的Core符号均属于Internal，
 * 业务不得通过深层路径绕过此边界。
 *
 * Stable public entrypoint for TiangZ business code. Core symbols not exported
 * here are Internal and must not be reached through deep imports.
 */

export { isPromiseLike } from "./async";
export type { MaybePromise } from "./async";

export { BroadcastHub } from "./broadcast/BroadcastHub";
export { ClientAudience } from "./broadcast/ClientAudience";
export { ClientBroadcast } from "./broadcast/ClientBroadcast";
export type { ClientRouteResolver } from "./broadcast/ClientBroadcast";
export { defineEventBroadcast, defineLatestBroadcast } from "./broadcast/types";
export type {
  BroadcastAudience,
  BroadcastDescriptor,
  BroadcastHubOptions,
  BroadcastKey,
  BroadcastMetricsSnapshot,
  BroadcastRoute,
  BroadcastTransport,
  EventBroadcastDescriptor,
  EncodedAudienceBatch,
  EncodedRouteFrame,
  LatestBroadcastDescriptor,
} from "./broadcast/types";

export { Logger } from "./logging/Logger";
export type { LogCategory, LogFields, LogLevel } from "./logging/Logger";

export { readU16BE, utf8Decode, utf8Encode } from "./protocol/binary";
export { encodePacket } from "./protocol/frame";
export { message } from "./protocol/message";
export type {
  Codec,
  IActorLocationMessage,
  IActorLocationRequest,
  IActorLocationResponse,
  IActorMessage,
  IActorRequest,
  IActorResponse,
  IMessage,
  IRequest,
  IResponse,
  MessageDescriptor,
  MessageRouting,
  TransferRoutingPolicy,
} from "./protocol/message";
export type { ProtocolContext } from "./protocol/registry";
export { RpcError } from "./protocol/RpcError";
export { rpc } from "./protocol/rpc";
export type { RpcDescriptor, RpcRouting } from "./protocol/rpc";
export { SystemErrCode } from "./protocol/SystemErrCode";

export { LocationDirectory } from "./location/LocationDirectory";
export type {
  LocationMutationState,
  LocationRecord,
} from "./location/LocationDirectory";

export { unitMessageHandler, unitRpcHandler } from "./process/unitHandlers";
export type { UnitMessageHandler, UnitRpcHandler } from "./process/unitHandlers";
export { entryScene } from "./process/registry";
export { messageHandler, rpcHandler } from "./process/sceneHandlers";
export type { SceneMessageHandler, SceneRpcHandler } from "./process/sceneHandlers";
export {
  sessionMessageHandler,
  sessionRpcHandler,
} from "./process/sessionHandlers";
export type {
  SessionMessageHandler,
  SessionRpcHandler,
} from "./process/sessionHandlers";
export { SceneMessageHelper } from "./process/SceneMessageHelper";
export { EntryScene } from "./process/types";
export type {
  CustomMetricSnapshot,
  CustomMetricKind,
  ProcessConfig,
  ProcessDbProxyConfig,
  ProcessLifecycleConfig,
  ProcessNetworkConfig,
  ProcessNativeDataObservabilityConfig,
  ProcessObservabilityConfig,
  ProcessPersistenceConfig,
  ProcessRuntimeConfig,
  ProcessSchedulingConfig,
  RuntimeEntrySceneConfig,
  SceneConfig,
  SceneMailboxType,
  SceneMetricsSnapshot,
} from "./process/types";

export { HostDbProxyTransport } from "./persistence/HostDbProxyTransport";
export { DbProxyEntityRepository } from "./persistence/VersionedEntityRepository";
export type {
  VersionedEntityCodec,
  VersionedEntityLoadResult,
  VersionedEntitySaveResult,
} from "./persistence/VersionedEntityRepository";

export { StateReplicationSystem } from "./replication/StateReplicationSystem";
export type {
  EncodedStateDelta,
  StateReplicationSource,
} from "./replication/StateReplicationSystem";

export { ChildEntity, Component, Entity, Scene } from "./runtime/entities";
export type {
  ChildEntityAwakeArgs,
  ChildEntityCtor,
  ComponentCtor,
  EntityTransferSnapshot,
  IDeserialize,
  ITransfer,
  OwnedTimerOptions,
} from "./runtime/entities";
export {
  GlobalIdSystem,
  requireGlobalId,
} from "./runtime/IdSystem";
export type {
  GlobalId,
  GlobalIdConfig,
} from "./runtime/IdSystem";
export { CoroutineLockSystem, SceneLockScope } from "./runtime/CoroutineLockSystem";
export type {
  CoroutineLockDomain,
  CoroutineLockKey,
  CoroutineLockOptions,
} from "./runtime/CoroutineLockSystem";
export {
  defineSyncEvent,
  defineVetoEvent,
  SceneEventScope,
  syncEventHandler,
  vetoEventHandler,
} from "./runtime/SceneEventSystem";
export type {
  EventPublishResult,
  SceneEventHandlerOptions,
  SyncEventDescriptor,
  SyncSceneEventHandler,
  VetoEventDescriptor,
  VetoSceneEventHandler,
} from "./runtime/SceneEventSystem";
export { SceneTaskScope } from "./runtime/SceneTaskSystem";
export type {
  SpawnTaskBody,
  SpawnTaskContext,
  SpawnTaskId,
  SceneTaskSignal,
} from "./runtime/SceneTaskSystem";
export {
  CommitPreparedTransfer,
  TransferStagingRegistry,
} from "./runtime/EntityTransfer";
export type {
  PreparedTransferOptions,
  TransferCommitResult,
  TransferPrepareResult,
  TransferStagingSnapshot,
  TransferStage,
} from "./runtime/EntityTransfer";
export { Game } from "./runtime/Game";
export type { GameUpdateConfig } from "./runtime/Game";
export { hotfixFor, systemFor } from "./hotReload/HotfixSystem";
export { actor, component, lifecycle, scene, transferable } from "./runtime/metadata";
export type { LifecycleOptions } from "./runtime/metadata";
export { TimerSystem } from "./runtime/TimerSystem";
export type {
  TimerCancelledContext,
  TimerCancelReason,
  TimerId,
  TimerOptions,
} from "./runtime/TimerSystem";
export { TimeSystem } from "./runtime/TimeSystem";
export type {
  ActorId,
  ActorRef,
  EntityId,
  InstanceId,
  PersistentEntityId,
  MailboxType,
  SceneId,
  SceneRef,
  SceneType,
} from "./runtime/types";
export { ActorUnit, Unit, UnitComponent } from "./runtime/Unit";
export type { UnitAwakeArgs, UnitCtor } from "./runtime/Unit";
export { Session, SessionComponent } from "./runtime/Session";
export type {
  IFrameFlush,
  ILateUpdate,
  IUpdate,
  IUpdate10Hz,
  IUpdate5Hz,
  IUpdate1Hz,
} from "./runtime/UpdateSystem";
