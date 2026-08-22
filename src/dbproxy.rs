//! 把独立DBProxy Rust客户端暴露为V8可等待的窄Host Bridge。 / Exposes the independent DBProxy Rust client as a narrow awaitable V8 host bridge.
//!
//! 令牌、TCP连接和连接池只存在于Rust。TS只接收通用快照结果，不能取得凭据、
//! 保存连接句柄或直接依赖DBProxy存储crate。
//! Tokens, TCP connections, and pools stay in Rust. TypeScript only receives generic snapshot
//! results and cannot access credentials, retain connection handles, or depend on storage crates.

use std::cell::RefCell;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

use anyhow::{Context, Result};
use deno_core::{JsBuffer, op2};
use deno_error::JsErrorBox;
use serde::{Deserialize, Serialize};
use tiangz_dbproxy_client::{
    ClientConfig, ClientConnectionOutcome, ClientError, ClientObserver, ClientRequestOutcome,
    DbProxyClientPool, RemoteError,
};
use tiangz_dbproxy_core::{
    MultiRecordTransactionReceipt, MultiRecordTransactionalWrite,
    MultiRecordTransactionalWriteOutcome, RecordKey, Revision, SnapshotWrite, SnapshotWriteOutcome,
    TransactionRecordReceipt, TransactionalRecordWrite, TransactionalWrite,
    TransactionalWriteOutcome,
};
use tiangz_dbproxy_protocol::{ProtocolError, wire};
use tokio::{runtime::Handle, sync::Mutex};

use crate::config::ProcessConfig;
use crate::health::{
    DbProxyClientObservabilitySnapshot, DbProxyEndpointObservabilitySnapshot,
    DbProxyFailoverObservabilitySnapshot,
};

const MAX_DBPROXY_ENDPOINTS: usize = 8;

thread_local! {
    static DBPROXY_BRIDGE: RefCell<Option<DbProxyBridge>> = const { RefCell::new(None) };
}

// 仅供Debug故障验收：事务已经由DBProxy提交后，主动丢弃Host响应，让TS走回执恢复路径。
// Debug-only fault injection: after DBProxy commits, drop the Host response so TS must recover the receipt.
static TEST_DBPROXY_RESPONSE_DROPPED: AtomicBool = AtomicBool::new(false);

fn maybe_drop_test_response(kind: &str) -> std::result::Result<(), JsErrorBox> {
    if !cfg!(debug_assertions) {
        return Ok(());
    }
    let configured = std::env::var("TIANGZ_TEST_DBPROXY_DROP_RESPONSE_ONCE").ok();
    if configured.as_deref() != Some("any") && configured.as_deref() != Some(kind) {
        return Ok(());
    }
    if !TEST_DBPROXY_RESPONSE_DROPPED.swap(true, Ordering::SeqCst) {
        tracing::warn!(
            target: "tiangz::test",
            kind,
            "DBProxy response dropped after durable commit by test fault injection"
        );
        return Err(JsErrorBox::generic(format!(
            "test fault injection dropped DBProxy {kind} response after commit"
        )));
    }
    Ok(())
}

#[derive(Clone)]
struct DbProxyBridge {
    config: ClientConfig,
    pool_size: usize,
    pool: Arc<Mutex<Option<DbProxyClientPool>>>,
    host_runtime: Handle,
    metrics: Arc<DbProxyClientMetrics>,
}

struct DbProxyClientMetrics {
    endpoints: Arc<[String]>,
    last_successful_endpoint: AtomicUsize,
    connection_attempts: [AtomicU64; MAX_DBPROXY_ENDPOINTS],
    connection_failures: [AtomicU64; MAX_DBPROXY_ENDPOINTS],
    connection_duration_micros: [AtomicU64; MAX_DBPROXY_ENDPOINTS],
    request_attempts: [AtomicU64; MAX_DBPROXY_ENDPOINTS],
    request_failures: [AtomicU64; MAX_DBPROXY_ENDPOINTS],
    request_duration_micros: [AtomicU64; MAX_DBPROXY_ENDPOINTS],
    failovers: [AtomicU64; MAX_DBPROXY_ENDPOINTS * MAX_DBPROXY_ENDPOINTS],
}

impl DbProxyClientMetrics {
    fn new(endpoints: Vec<String>) -> Self {
        debug_assert!(!endpoints.is_empty() && endpoints.len() <= MAX_DBPROXY_ENDPOINTS);
        Self {
            endpoints: endpoints.into(),
            last_successful_endpoint: AtomicUsize::new(MAX_DBPROXY_ENDPOINTS),
            connection_attempts: std::array::from_fn(|_| AtomicU64::new(0)),
            connection_failures: std::array::from_fn(|_| AtomicU64::new(0)),
            connection_duration_micros: std::array::from_fn(|_| AtomicU64::new(0)),
            request_attempts: std::array::from_fn(|_| AtomicU64::new(0)),
            request_failures: std::array::from_fn(|_| AtomicU64::new(0)),
            request_duration_micros: std::array::from_fn(|_| AtomicU64::new(0)),
            failovers: std::array::from_fn(|_| AtomicU64::new(0)),
        }
    }

    fn snapshot(&self) -> DbProxyClientObservabilitySnapshot {
        let endpoints = self
            .endpoints
            .iter()
            .enumerate()
            .map(|(index, endpoint)| DbProxyEndpointObservabilitySnapshot {
                endpoint: endpoint.clone(),
                selected: self.last_successful_endpoint.load(Ordering::Relaxed) == index,
                connection_attempts: self.connection_attempts[index].load(Ordering::Relaxed),
                connection_failures: self.connection_failures[index].load(Ordering::Relaxed),
                connection_duration_seconds: self.connection_duration_micros[index]
                    .load(Ordering::Relaxed) as f64
                    / 1_000_000.0,
                request_attempts: self.request_attempts[index].load(Ordering::Relaxed),
                request_failures: self.request_failures[index].load(Ordering::Relaxed),
                request_duration_seconds: self.request_duration_micros[index]
                    .load(Ordering::Relaxed) as f64
                    / 1_000_000.0,
            })
            .collect();
        let mut failovers = Vec::new();
        for from in 0..self.endpoints.len() {
            for to in 0..self.endpoints.len() {
                if from == to {
                    continue;
                }
                failovers.push(DbProxyFailoverObservabilitySnapshot {
                    from_endpoint: self.endpoints[from].clone(),
                    to_endpoint: self.endpoints[to].clone(),
                    count: self.failovers[from * MAX_DBPROXY_ENDPOINTS + to]
                        .load(Ordering::Relaxed),
                });
            }
        }
        DbProxyClientObservabilitySnapshot {
            endpoints,
            failovers,
        }
    }
}

impl ClientObserver for DbProxyClientMetrics {
    fn connection_attempt(
        &self,
        endpoint_index: usize,
        elapsed: Duration,
        outcome: ClientConnectionOutcome,
    ) {
        if endpoint_index >= self.endpoints.len() {
            return;
        }
        self.connection_attempts[endpoint_index].fetch_add(1, Ordering::Relaxed);
        self.connection_duration_micros[endpoint_index].fetch_add(
            elapsed.as_micros().min(u128::from(u64::MAX)) as u64,
            Ordering::Relaxed,
        );
        if outcome == ClientConnectionOutcome::Connected {
            self.last_successful_endpoint
                .store(endpoint_index, Ordering::Relaxed);
        } else {
            self.connection_failures[endpoint_index].fetch_add(1, Ordering::Relaxed);
        }
    }

    fn endpoint_failover(&self, from_endpoint_index: usize, to_endpoint_index: usize) {
        if from_endpoint_index >= self.endpoints.len() || to_endpoint_index >= self.endpoints.len()
        {
            return;
        }
        self.failovers[from_endpoint_index * MAX_DBPROXY_ENDPOINTS + to_endpoint_index]
            .fetch_add(1, Ordering::Relaxed);
        tracing::warn!(
            target: "tiangz::dbproxy",
            from_endpoint = %self.endpoints[from_endpoint_index],
            to_endpoint = %self.endpoints[to_endpoint_index],
            "DBProxy client switched endpoint"
        );
    }

    fn request_attempt(
        &self,
        endpoint_index: usize,
        operation: &'static str,
        elapsed: Duration,
        outcome: ClientRequestOutcome,
    ) {
        if endpoint_index >= self.endpoints.len() {
            return;
        }
        self.request_attempts[endpoint_index].fetch_add(1, Ordering::Relaxed);
        self.request_duration_micros[endpoint_index].fetch_add(
            elapsed.as_micros().min(u128::from(u64::MAX)) as u64,
            Ordering::Relaxed,
        );
        if outcome != ClientRequestOutcome::Success {
            self.request_failures[endpoint_index].fetch_add(1, Ordering::Relaxed);
            tracing::debug!(
                target: "tiangz::dbproxy",
                endpoint = %self.endpoints[endpoint_index],
                operation,
                ?outcome,
                duration_ms = elapsed.as_secs_f64() * 1000.0,
                "DBProxy client request attempt failed"
            );
        }
    }
}

impl DbProxyBridge {
    async fn pool(&self) -> std::result::Result<DbProxyClientPool, ClientError> {
        let mut pool = self.pool.lock().await;
        if let Some(existing) = pool.as_ref() {
            return Ok(existing.clone());
        }
        tracing::info!(
            target: "tiangz::dbproxy",
            endpoint = %self.config.endpoint,
            pool_size = self.pool_size,
            "connecting DBProxy client pool"
        );
        let connected = DbProxyClientPool::connect(self.config.clone(), self.pool_size).await?;
        tracing::info!(
            target: "tiangz::dbproxy",
            endpoint = %self.config.endpoint,
            pool_size = self.pool_size,
            "DBProxy client pool connected"
        );
        *pool = Some(connected.clone());
        Ok(connected)
    }

    async fn invalidate(&self) {
        *self.pool.lock().await = None;
    }

    /// 连接边界不确定时只重连并重放一次；调用方提供的幂等ID保持不变。
    /// Reconnects and replays once after an ambiguous connection failure while preserving the caller's idempotency ID.
    async fn execute<T, F, Fut>(&self, operation: F) -> std::result::Result<T, ClientError>
    where
        T: Send + 'static,
        F: Fn(DbProxyClientPool) -> Fut + Send + 'static,
        Fut: Future<Output = std::result::Result<T, ClientError>> + Send + 'static,
    {
        let bridge = self.clone();
        self.host_runtime
            .spawn(async move { bridge.execute_on_host(operation).await })
            .await
            .map_err(|_| ClientError::UnexpectedResponse("DBProxy host task terminated"))?
    }

    /// 在Rust多线程Host Runtime执行连接和I/O；V8线程只等待结果，不承载网络驱动。
    /// Runs connections and I/O on the multithreaded Rust host runtime while V8 only awaits the result.
    async fn execute_on_host<T, F, Fut>(&self, operation: F) -> std::result::Result<T, ClientError>
    where
        F: Fn(DbProxyClientPool) -> Fut,
        Fut: Future<Output = std::result::Result<T, ClientError>>,
    {
        let pool = self.pool().await?;
        match operation(pool).await {
            Err(error) if is_reconnectable(&error) => {
                self.invalidate().await;
                let pool = self.pool().await?;
                operation(pool).await
            }
            result => result,
        }
    }
}

/// 为当前Process线程安装DBProxy配置。配置缺失时Bridge保持禁用；启用时令牌必须来自环境变量。
/// Installs DBProxy settings for the current Process thread. The bridge stays disabled when omitted;
/// enabled configurations must resolve their token from an environment variable.
pub fn configure(process: &ProcessConfig, host_runtime: Handle) -> Result<()> {
    DBPROXY_BRIDGE.with(|slot| *slot.borrow_mut() = None);
    let Some(settings) = process.persistence.db_proxy.as_ref() else {
        return Ok(());
    };
    let auth_token = std::env::var(&settings.auth_token_env).with_context(|| {
        format!(
            "DBProxy is configured for process {} but environment variable {} is missing",
            process.name, settings.auth_token_env
        )
    })?;
    let endpoints = settings.endpoint_candidates();
    let metrics = Arc::new(DbProxyClientMetrics::new(endpoints));
    let mut config = ClientConfig::new(
        settings.endpoint.clone(),
        auth_token,
        format!("tiangz:{}", process.name),
    );
    config = config
        .with_endpoints(settings.failover_endpoints.clone())
        .with_observer(metrics.clone());
    config.connect_timeout = Duration::from_millis(settings.connect_timeout_ms);
    config.request_timeout = Duration::from_millis(settings.request_timeout_ms);
    config.max_frame_bytes = settings.max_frame_bytes;
    let endpoint_count = settings.endpoint_candidates().len();
    DBPROXY_BRIDGE.with(|slot| {
        *slot.borrow_mut() = Some(DbProxyBridge {
            config,
            pool_size: settings.client_pool_size,
            pool: Arc::new(Mutex::new(None)),
            host_runtime,
            metrics,
        });
    });
    tracing::info!(
        target: "tiangz::dbproxy",
        process = %process.name,
        endpoint = %settings.endpoint,
        endpoint_count,
        client_pool_size = settings.client_pool_size,
        "DBProxy host bridge configured"
    );
    Ok(())
}

/// 返回当前Process的DBProxy客户端累计指标；未启用持久化时不生成时间序列。
/// Return cumulative DBProxy client metrics for this Process; disabled persistence emits no series.
pub(crate) fn metrics_snapshot() -> Option<DbProxyClientObservabilitySnapshot> {
    DBPROXY_BRIDGE.with(|slot| {
        slot.borrow()
            .as_ref()
            .map(|bridge| bridge.metrics.snapshot())
    })
}

/// 在Process进入ready前建立完整连接池；未配置持久化时保持空操作。
/// Establishes the complete client pool before the Process becomes ready and
/// remains a no-op when persistence is not configured.
pub async fn warm() -> std::result::Result<(), ClientError> {
    let bridge = DBPROXY_BRIDGE.with(|slot| slot.borrow().clone());
    let Some(bridge) = bridge else {
        return Ok(());
    };
    bridge.execute(|_| async { Ok(()) }).await
}

fn bridge() -> std::result::Result<DbProxyBridge, JsErrorBox> {
    DBPROXY_BRIDGE
        .with(|slot| slot.borrow().clone())
        .ok_or_else(|| JsErrorBox::generic("DBProxy is not configured for this Process"))
}

fn is_reconnectable(error: &ClientError) -> bool {
    matches!(
        error,
        ClientError::RequestTimeout
            | ClientError::ConnectionUnusable
            | ClientError::ConnectionClosed
            | ClientError::Protocol(ProtocolError::Io(_))
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostDbProxyError {
    code: u32,
    message: String,
    actual_revision: Option<String>,
}

impl From<ClientError> for HostDbProxyError {
    fn from(error: ClientError) -> Self {
        match error {
            ClientError::Remote(remote) => Self {
                code: remote.code as i32 as u32,
                message: remote.message,
                actual_revision: remote.actual_revision.map(|value| value.0.to_string()),
            },
            other => Self {
                code: wire::ErrorCode::StorageUnavailable as i32 as u32,
                message: other.to_string(),
                actual_revision: None,
            },
        }
    }
}

impl From<RemoteError> for HostDbProxyError {
    fn from(error: RemoteError) -> Self {
        Self {
            code: error.code as i32 as u32,
            message: error.message,
            actual_revision: error.actual_revision.map(|value| value.0.to_string()),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostSnapshot {
    namespace: String,
    key: String,
    schema: String,
    schema_version: u32,
    revision: String,
    payload: Vec<u8>,
    updated_at_unix_ms: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostLoadResponse {
    snapshot: Option<HostSnapshot>,
    error: Option<HostDbProxyError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostLoadMultiResponse {
    snapshots: Vec<Option<HostSnapshot>>,
    error: Option<HostDbProxyError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostWriteResponse {
    disposition: Option<&'static str>,
    revision: Option<String>,
    error: Option<HostDbProxyError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostEnqueueResponse {
    accepted: bool,
    error: Option<HostDbProxyError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostBatchWriteEntry {
    ok: bool,
    disposition: Option<&'static str>,
    revision: Option<String>,
    error: Option<HostDbProxyError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostBatchWriteResponse {
    entries: Vec<HostBatchWriteEntry>,
    error: Option<HostDbProxyError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostBatchEnqueueEntry {
    ok: bool,
    error: Option<HostDbProxyError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostBatchEnqueueResponse {
    entries: Vec<HostBatchEnqueueEntry>,
    error: Option<HostDbProxyError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostTransactionResponse {
    disposition: Option<&'static str>,
    new_revision: Option<String>,
    result: Vec<u8>,
    error: Option<HostDbProxyError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostTransactionReceipt {
    operation_id: String,
    namespace: String,
    key: String,
    new_revision: String,
    result: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostLoadTransactionResponse {
    receipt: Option<HostTransactionReceipt>,
    error: Option<HostDbProxyError>,
}

// 多记录事务的桥接结构只负责边界转换，不承担业务编排。
// These bridge structs only translate the Host boundary; they do not orchestrate business logic.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostRecordKeyInput {
    namespace: String,
    key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostSnapshotWriteInput {
    request_id: String,
    record: HostRecordKeyInput,
    schema: String,
    schema_version: u32,
    payload: Vec<u8>,
    expected_revision: Option<String>,
    updated_at_unix_ms: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostMultiRecordWriteInput {
    record: HostRecordKeyInput,
    schema: String,
    schema_version: u32,
    expected_revision: String,
    payload: Vec<u8>,
    updated_at_unix_ms: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostMultiTransactionRecordReceipt {
    namespace: String,
    key: String,
    new_revision: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostMultiTransactionResponse {
    disposition: Option<&'static str>,
    records: Vec<HostMultiTransactionRecordReceipt>,
    result: Vec<u8>,
    error: Option<HostDbProxyError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostMultiTransactionReceipt {
    operation_id: String,
    records: Vec<HostMultiTransactionRecordReceipt>,
    result: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostLoadMultiTransactionResponse {
    receipt: Option<HostMultiTransactionReceipt>,
    error: Option<HostDbProxyError>,
}

// Rust 负责解析、连接池路由和DBProxy调用，TS只等待结果并恢复原始回执。
// Rust owns parsing, pool routing, and DBProxy calls; TS only awaits and restores the original receipt.
#[op2]
#[serde]
async fn op_host_dbproxy_load(
    #[string] namespace: String,
    #[string] key: String,
) -> std::result::Result<HostLoadResponse, JsErrorBox> {
    let record =
        RecordKey::new(namespace, key).map_err(|error| JsErrorBox::generic(error.to_string()))?;
    let result = bridge()?
        .execute(move |pool| {
            let record = record.clone();
            async move { pool.load(&record).await }
        })
        .await;
    Ok(match result {
        Ok(snapshot) => HostLoadResponse {
            snapshot: snapshot.map(host_snapshot),
            error: None,
        },
        Err(error) => HostLoadResponse {
            snapshot: None,
            error: Some(error.into()),
        },
    })
}

#[op2]
#[serde]
async fn op_host_dbproxy_load_multi(
    #[string] records_json: String,
) -> std::result::Result<HostLoadMultiResponse, JsErrorBox> {
    let records = parse_record_keys(&records_json)?;
    let result = bridge()?
        .execute(move |pool| {
            let records = records.clone();
            async move { pool.load_multi(&records).await }
        })
        .await;
    Ok(match result {
        Ok(snapshots) => HostLoadMultiResponse {
            snapshots: snapshots
                .into_iter()
                .map(|snapshot| snapshot.map(host_snapshot))
                .collect(),
            error: None,
        },
        Err(error) => HostLoadMultiResponse {
            snapshots: Vec::new(),
            error: Some(error.into()),
        },
    })
}

#[allow(clippy::too_many_arguments)]
#[op2]
#[serde]
async fn op_host_dbproxy_save(
    #[string] request_id: String,
    #[string] namespace: String,
    #[string] key: String,
    #[string] schema: String,
    schema_version: u32,
    #[buffer] payload: JsBuffer,
    #[string] expected_revision: String,
    #[string] updated_at_unix_ms: String,
) -> std::result::Result<HostWriteResponse, JsErrorBox> {
    let request = SnapshotWrite {
        request_id,
        record: RecordKey::new(namespace, key)
            .map_err(|error| JsErrorBox::generic(error.to_string()))?,
        schema,
        schema_version,
        payload: payload.to_vec(),
        expected_revision: parse_optional_revision(&expected_revision)?,
        updated_at_unix_ms: parse_u64(&updated_at_unix_ms, "updatedAtUnixMs")?,
    };
    let result = bridge()?
        .execute(move |pool| {
            let request = request.clone();
            async move { pool.save(request).await }
        })
        .await;
    Ok(match result {
        Ok(SnapshotWriteOutcome::Applied { revision }) => write_response("applied", revision),
        Ok(SnapshotWriteOutcome::Duplicate { revision }) => write_response("duplicate", revision),
        Err(error) => HostWriteResponse {
            disposition: None,
            revision: None,
            error: Some(error.into()),
        },
    })
}

#[op2]
#[serde]
async fn op_host_dbproxy_save_multi(
    #[string] writes_json: String,
) -> std::result::Result<HostBatchWriteResponse, JsErrorBox> {
    let requests = parse_snapshot_writes(&writes_json)?;
    let result = bridge()?
        .execute(move |pool| {
            let requests = requests.clone();
            async move { pool.save_multi(&requests).await }
        })
        .await;
    Ok(match result {
        Ok(outcomes) => HostBatchWriteResponse {
            entries: outcomes
                .into_iter()
                .map(|outcome| match outcome {
                    Ok(SnapshotWriteOutcome::Applied { revision }) => {
                        batch_write_entry("applied", revision)
                    }
                    Ok(SnapshotWriteOutcome::Duplicate { revision }) => {
                        batch_write_entry("duplicate", revision)
                    }
                    Err(error) => HostBatchWriteEntry {
                        ok: false,
                        disposition: None,
                        revision: None,
                        error: Some(error.into()),
                    },
                })
                .collect(),
            error: None,
        },
        Err(error) => HostBatchWriteResponse {
            entries: Vec::new(),
            error: Some(error.into()),
        },
    })
}

#[allow(clippy::too_many_arguments)]
#[op2]
#[serde]
async fn op_host_dbproxy_enqueue_snapshot(
    #[string] request_id: String,
    #[string] namespace: String,
    #[string] key: String,
    #[string] schema: String,
    schema_version: u32,
    #[buffer] payload: JsBuffer,
    #[string] updated_at_unix_ms: String,
) -> std::result::Result<HostEnqueueResponse, JsErrorBox> {
    let request = SnapshotWrite {
        request_id,
        record: RecordKey::new(namespace, key)
            .map_err(|error| JsErrorBox::generic(error.to_string()))?,
        schema,
        schema_version,
        payload: payload.to_vec(),
        expected_revision: None,
        updated_at_unix_ms: parse_u64(&updated_at_unix_ms, "updatedAtUnixMs")?,
    };
    let result = bridge()?
        .execute(move |pool| {
            let request = request.clone();
            async move { pool.enqueue_snapshot(request).await }
        })
        .await;
    Ok(match result {
        Ok(()) => HostEnqueueResponse {
            accepted: true,
            error: None,
        },
        Err(error) => HostEnqueueResponse {
            accepted: false,
            error: Some(error.into()),
        },
    })
}

#[op2]
#[serde]
async fn op_host_dbproxy_enqueue_multi_snapshot(
    #[string] writes_json: String,
) -> std::result::Result<HostBatchEnqueueResponse, JsErrorBox> {
    let requests = parse_snapshot_writes(&writes_json)?;
    let result = bridge()?
        .execute(move |pool| {
            let requests = requests.clone();
            async move { pool.enqueue_multi_snapshot(&requests).await }
        })
        .await;
    Ok(match result {
        Ok(outcomes) => HostBatchEnqueueResponse {
            entries: outcomes
                .into_iter()
                .map(|outcome| match outcome {
                    Ok(()) => HostBatchEnqueueEntry {
                        ok: true,
                        error: None,
                    },
                    Err(error) => HostBatchEnqueueEntry {
                        ok: false,
                        error: Some(error.into()),
                    },
                })
                .collect(),
            error: None,
        },
        Err(error) => HostBatchEnqueueResponse {
            entries: Vec::new(),
            error: Some(error.into()),
        },
    })
}

#[allow(clippy::too_many_arguments)]
#[op2]
#[serde]
async fn op_host_dbproxy_apply_transaction(
    #[string] operation_id: String,
    #[string] namespace: String,
    #[string] key: String,
    #[string] schema: String,
    schema_version: u32,
    #[string] expected_revision: String,
    #[buffer] payload: JsBuffer,
    #[buffer] operation_result: JsBuffer,
    #[string] updated_at_unix_ms: String,
) -> std::result::Result<HostTransactionResponse, JsErrorBox> {
    let request = TransactionalWrite {
        operation_id,
        record: RecordKey::new(namespace, key)
            .map_err(|error| JsErrorBox::generic(error.to_string()))?,
        schema,
        schema_version,
        expected_revision: Revision(parse_u64(&expected_revision, "expectedRevision")?),
        payload: payload.to_vec(),
        result: operation_result.to_vec(),
        updated_at_unix_ms: parse_u64(&updated_at_unix_ms, "updatedAtUnixMs")?,
    };
    let result = bridge()?
        .execute(move |pool| {
            let request = request.clone();
            async move { pool.apply_transaction(request).await }
        })
        .await;
    let response = match result {
        Ok(TransactionalWriteOutcome::Applied {
            new_revision,
            result,
        }) => transaction_response("applied", new_revision, result),
        Ok(TransactionalWriteOutcome::Duplicate {
            new_revision,
            result,
        }) => transaction_response("duplicate", new_revision, result),
        Err(error) => HostTransactionResponse {
            disposition: None,
            new_revision: None,
            result: Vec::new(),
            error: Some(error.into()),
        },
    };
    if response.error.is_none() {
        maybe_drop_test_response("transaction")?;
    }
    Ok(response)
}

#[op2]
#[serde]
async fn op_host_dbproxy_load_transaction(
    #[string] operation_id: String,
    #[string] namespace: String,
    #[string] key: String,
) -> std::result::Result<HostLoadTransactionResponse, JsErrorBox> {
    let record =
        RecordKey::new(namespace, key).map_err(|error| JsErrorBox::generic(error.to_string()))?;
    let result = bridge()?
        .execute(move |pool| {
            let operation_id = operation_id.clone();
            let record = record.clone();
            async move { pool.load_transaction(&operation_id, &record).await }
        })
        .await;
    Ok(match result {
        Ok(receipt) => HostLoadTransactionResponse {
            receipt: receipt.map(|receipt| HostTransactionReceipt {
                operation_id: receipt.operation_id,
                namespace: receipt.record.namespace,
                key: receipt.record.key,
                new_revision: receipt.new_revision.0.to_string(),
                result: receipt.result,
            }),
            error: None,
        },
        Err(error) => HostLoadTransactionResponse {
            receipt: None,
            error: Some(error.into()),
        },
    })
}

#[op2]
#[serde]
async fn op_host_dbproxy_apply_multi_transaction(
    #[string] operation_id: String,
    #[string] writes_json: String,
    #[buffer] operation_result: JsBuffer,
) -> std::result::Result<HostMultiTransactionResponse, JsErrorBox> {
    let writes = parse_multi_record_writes(&writes_json)?;
    let request = MultiRecordTransactionalWrite {
        operation_id,
        writes,
        result: operation_result.to_vec(),
    };
    let result = bridge()?
        .execute(move |pool| {
            let request = request.clone();
            async move { pool.apply_multi_transaction(request).await }
        })
        .await;
    let response = match result {
        Ok(MultiRecordTransactionalWriteOutcome::Applied { records, result }) => {
            multi_transaction_response("applied", records, result)
        }
        Ok(MultiRecordTransactionalWriteOutcome::Duplicate { records, result }) => {
            multi_transaction_response("duplicate", records, result)
        }
        Err(error) => HostMultiTransactionResponse {
            disposition: None,
            records: Vec::new(),
            result: Vec::new(),
            error: Some(error.into()),
        },
    };
    if response.error.is_none() {
        maybe_drop_test_response("multi-transaction")?;
    }
    Ok(response)
}

#[op2]
#[serde]
async fn op_host_dbproxy_load_multi_transaction(
    #[string] operation_id: String,
    #[string] records_json: String,
) -> std::result::Result<HostLoadMultiTransactionResponse, JsErrorBox> {
    let records = parse_record_keys(&records_json)?;
    let result = bridge()?
        .execute(move |pool| {
            let operation_id = operation_id.clone();
            let records = records.clone();
            async move { pool.load_multi_transaction(&operation_id, &records).await }
        })
        .await;
    Ok(match result {
        Ok(receipt) => HostLoadMultiTransactionResponse {
            receipt: receipt.map(host_multi_transaction_receipt),
            error: None,
        },
        Err(error) => HostLoadMultiTransactionResponse {
            receipt: None,
            error: Some(error.into()),
        },
    })
}

fn parse_multi_record_writes(
    value: &str,
) -> std::result::Result<Vec<TransactionalRecordWrite>, JsErrorBox> {
    let input = serde_json::from_str::<Vec<HostMultiRecordWriteInput>>(value).map_err(|error| {
        JsErrorBox::generic(format!("invalid multi-transaction writes: {error}"))
    })?;
    input
        .into_iter()
        .map(|write| {
            Ok(TransactionalRecordWrite {
                record: RecordKey::new(write.record.namespace, write.record.key)
                    .map_err(|error| JsErrorBox::generic(error.to_string()))?,
                schema: write.schema,
                schema_version: write.schema_version,
                expected_revision: Revision(parse_u64(
                    &write.expected_revision,
                    "expectedRevision",
                )?),
                payload: write.payload,
                updated_at_unix_ms: parse_u64(&write.updated_at_unix_ms, "updatedAtUnixMs")?,
            })
        })
        .collect()
}

fn parse_record_keys(value: &str) -> std::result::Result<Vec<RecordKey>, JsErrorBox> {
    let input = serde_json::from_str::<Vec<HostRecordKeyInput>>(value).map_err(|error| {
        JsErrorBox::generic(format!("invalid multi-transaction records: {error}"))
    })?;
    input
        .into_iter()
        .map(|record| {
            RecordKey::new(record.namespace, record.key)
                .map_err(|error| JsErrorBox::generic(error.to_string()))
        })
        .collect()
}

fn parse_snapshot_writes(value: &str) -> std::result::Result<Vec<SnapshotWrite>, JsErrorBox> {
    let input = serde_json::from_str::<Vec<HostSnapshotWriteInput>>(value)
        .map_err(|error| JsErrorBox::generic(format!("invalid snapshot writes: {error}")))?;
    input
        .into_iter()
        .map(|write| {
            Ok(SnapshotWrite {
                request_id: write.request_id,
                record: RecordKey::new(write.record.namespace, write.record.key)
                    .map_err(|error| JsErrorBox::generic(error.to_string()))?,
                schema: write.schema,
                schema_version: write.schema_version,
                payload: write.payload,
                expected_revision: match write.expected_revision {
                    Some(value) => parse_optional_revision(&value)?,
                    None => None,
                },
                updated_at_unix_ms: parse_u64(&write.updated_at_unix_ms, "updatedAtUnixMs")?,
            })
        })
        .collect()
}

fn multi_transaction_response(
    disposition: &'static str,
    records: Vec<TransactionRecordReceipt>,
    result: Vec<u8>,
) -> HostMultiTransactionResponse {
    HostMultiTransactionResponse {
        disposition: Some(disposition),
        records: records
            .into_iter()
            .map(host_multi_transaction_record_receipt)
            .collect(),
        result,
        error: None,
    }
}

fn host_multi_transaction_record_receipt(
    receipt: TransactionRecordReceipt,
) -> HostMultiTransactionRecordReceipt {
    HostMultiTransactionRecordReceipt {
        namespace: receipt.record.namespace,
        key: receipt.record.key,
        new_revision: receipt.new_revision.0.to_string(),
    }
}

fn host_multi_transaction_receipt(
    receipt: MultiRecordTransactionReceipt,
) -> HostMultiTransactionReceipt {
    HostMultiTransactionReceipt {
        operation_id: receipt.operation_id,
        records: receipt
            .records
            .into_iter()
            .map(host_multi_transaction_record_receipt)
            .collect(),
        result: receipt.result,
    }
}

fn host_snapshot(snapshot: tiangz_dbproxy_core::SnapshotEnvelope) -> HostSnapshot {
    HostSnapshot {
        namespace: snapshot.record.namespace,
        key: snapshot.record.key,
        schema: snapshot.schema,
        schema_version: snapshot.schema_version,
        revision: snapshot.revision.0.to_string(),
        payload: snapshot.payload,
        updated_at_unix_ms: snapshot.updated_at_unix_ms.to_string(),
    }
}

fn write_response(disposition: &'static str, revision: Revision) -> HostWriteResponse {
    HostWriteResponse {
        disposition: Some(disposition),
        revision: Some(revision.0.to_string()),
        error: None,
    }
}

fn batch_write_entry(disposition: &'static str, revision: Revision) -> HostBatchWriteEntry {
    HostBatchWriteEntry {
        ok: true,
        disposition: Some(disposition),
        revision: Some(revision.0.to_string()),
        error: None,
    }
}

fn transaction_response(
    disposition: &'static str,
    revision: Revision,
    result: Vec<u8>,
) -> HostTransactionResponse {
    HostTransactionResponse {
        disposition: Some(disposition),
        new_revision: Some(revision.0.to_string()),
        result,
        error: None,
    }
}

fn parse_optional_revision(value: &str) -> std::result::Result<Option<Revision>, JsErrorBox> {
    if value.is_empty() {
        return Ok(None);
    }
    Ok(Some(Revision(parse_u64(value, "expectedRevision")?)))
}

fn parse_u64(value: &str, name: &str) -> std::result::Result<u64, JsErrorBox> {
    value
        .parse::<u64>()
        .map_err(|_| JsErrorBox::range_error(format!("{name} must be a uint64 decimal string")))
}

deno_core::extension!(
    dbproxy_host,
    ops = [
        op_host_dbproxy_load,
        op_host_dbproxy_load_multi,
        op_host_dbproxy_save,
        op_host_dbproxy_save_multi,
        op_host_dbproxy_enqueue_snapshot,
        op_host_dbproxy_enqueue_multi_snapshot,
        op_host_dbproxy_apply_transaction,
        op_host_dbproxy_load_transaction,
        op_host_dbproxy_apply_multi_transaction,
        op_host_dbproxy_load_multi_transaction,
    ],
);

pub fn init() -> deno_core::Extension {
    dbproxy_host::init()
}

pub const BOOTSTRAP_SOURCE: &str = r#"
(() => {
  const core = globalThis.Deno.core;
  const text = (value, name) => {
    if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
    return value;
  };
  const bytes = (value, name) => {
    if (!(value instanceof Uint8Array)) throw new TypeError(`${name} must be Uint8Array`);
    return value;
  };
  const u32 = (value, name) => {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new RangeError(`${name} must be uint32`);
    return value;
  };
  globalThis.__hostDbProxy = Object.freeze({
    load: (namespace, key) => core.ops.op_host_dbproxy_load(text(namespace, "namespace"), text(key, "key")),
    loadMulti: (records) => core.ops.op_host_dbproxy_load_multi(
      text(JSON.stringify(records), "records"),
    ),
    save: (request) => core.ops.op_host_dbproxy_save(
      text(request.requestId, "requestId"), text(request.namespace, "namespace"), text(request.key, "key"),
      text(request.schema, "schema"), u32(request.schemaVersion, "schemaVersion"), bytes(request.payload, "payload"),
      String(request.expectedRevision ?? ""), text(String(request.updatedAtUnixMs), "updatedAtUnixMs"),
    ),
    saveMulti: (writes) => core.ops.op_host_dbproxy_save_multi(
      text(JSON.stringify(writes.map((write) => ({
        ...write,
        payload: Array.from(bytes(write.payload, "payload")),
        expectedRevision: write.expectedRevision === undefined ? undefined : String(write.expectedRevision),
        updatedAtUnixMs: text(String(write.updatedAtUnixMs), "updatedAtUnixMs"),
      }))), "writes"),
    ),
    enqueueSnapshot: (request) => core.ops.op_host_dbproxy_enqueue_snapshot(
      text(request.requestId, "requestId"), text(request.namespace, "namespace"), text(request.key, "key"),
      text(request.schema, "schema"), u32(request.schemaVersion, "schemaVersion"), bytes(request.payload, "payload"),
      text(String(request.updatedAtUnixMs), "updatedAtUnixMs"),
    ),
    enqueueMultiSnapshot: (writes) => core.ops.op_host_dbproxy_enqueue_multi_snapshot(
      text(JSON.stringify(writes.map((write) => ({
        ...write,
        payload: Array.from(bytes(write.payload, "payload")),
        expectedRevision: undefined,
        updatedAtUnixMs: text(String(write.updatedAtUnixMs), "updatedAtUnixMs"),
      }))), "writes"),
    ),
    applyTransaction: (request) => core.ops.op_host_dbproxy_apply_transaction(
      text(request.operationId, "operationId"), text(request.namespace, "namespace"), text(request.key, "key"),
      text(request.schema, "schema"), u32(request.schemaVersion, "schemaVersion"),
      text(String(request.expectedRevision), "expectedRevision"), bytes(request.payload, "payload"),
      bytes(request.result, "result"), text(String(request.updatedAtUnixMs), "updatedAtUnixMs"),
    ),
    loadTransaction: (operationId, namespace, key) => core.ops.op_host_dbproxy_load_transaction(
      text(operationId, "operationId"), text(namespace, "namespace"), text(key, "key"),
    ),
    applyMultiTransaction: (request) => core.ops.op_host_dbproxy_apply_multi_transaction(
      text(request.operationId, "operationId"),
      text(JSON.stringify(request.writes.map((write) => ({
        record: write.record,
        schema: write.schema,
        schemaVersion: u32(write.schemaVersion, "schemaVersion"),
        expectedRevision: String(write.expectedRevision),
        payload: Array.from(bytes(write.payload, "payload")),
        updatedAtUnixMs: text(String(write.updatedAtUnixMs), "updatedAtUnixMs"),
      }))), "writes"),
      bytes(request.result, "result"),
    ),
    loadMultiTransaction: (operationId, records) => core.ops.op_host_dbproxy_load_multi_transaction(
      text(operationId, "operationId"),
      text(JSON.stringify(records), "records"),
    ),
  });
})();
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconnectable_errors_exclude_remote_business_rejections() {
        assert!(is_reconnectable(&ClientError::ConnectionClosed));
        assert!(!is_reconnectable(&ClientError::InvalidConfig("test")));
    }
}
