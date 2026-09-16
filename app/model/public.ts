/** 纯模块宿主的稳定入口，不装配游戏实现。
 * Stable entry for a module-only host without game implementations.
 */
export * from "../core/public";
export * from "./domains/public";
export {
  DbProxyClient, DbProxyErrorCode, DbProxyRemoteError, CloneDbProxyCommitEffects,
} from "@tiangz/dbproxy-sdk";
export type {
  DbProxySnapshotWrite, DbProxyMultiTransactionalWrite, DbProxyBatchSnapshotWriteResult,
  DbProxyTransactionalRecordWrite, DbProxyTransactionalWrite, DbProxyCommitEffects,
  DbProxyAppendRecord, DbProxyOutboxEvent,
} from "@tiangz/dbproxy-sdk";
