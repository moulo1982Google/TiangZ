import { DbProxyClient, CreateOutboxEvent as CreateSdkEvent,
  type DbProxyRecordCommit as SdkCommit, type DbProxyEventEnvelope as SdkEnvelope,
  type DbProxyRecordKey, type DbProxySnapshotEnvelope, type DbProxyMultiTransactionalWriteResult,
  type DbProxyOutboxEvent } from "@tiangz/dbproxy-sdk";
import { HostDbProxyTransport } from "./HostDbProxyTransport";

export type DbProxyRecordCommit = SdkCommit;
export type DbProxyEventEnvelope = SdkEnvelope;

/** 使用宿主匹配的 SDK 构造事件；不允许模块手拼保留 topic。
 * Builds envelopes with the Host-linked SDK; modules must not handcraft reserved topics.
 */
export function CreateOutboxEvent(input: DbProxyEventEnvelope): DbProxyOutboxEvent { return CreateSdkEvent(input); }

/** 外置模块的通用记录事务入口；业务负责 schema、CAS、幂等身份和 inbox。
 * Generic record transactions for external modules; domain owns schemas, CAS, operation identity and inbox.
 */
export class HostDbProxyRecords {
  private readonly client = new DbProxyClient(new HostDbProxyTransport());
  /** 读取权威快照；不存在返回 undefined。 / Loads an authoritative snapshot or undefined. */
  Load(record: DbProxyRecordKey): Promise<DbProxySnapshotEnvelope | undefined> { return this.client.Load(record); }
  /** 不自动重试或重建 operationId；未知结果必须复用原请求。 / No automatic retries; uncertain results must retain request identity. */
  CommitRecords(commit: DbProxyRecordCommit): Promise<DbProxyMultiTransactionalWriteResult> { return this.client.CommitRecords(commit); }
}
