//! Scene 的独立 HTTP 入口：Rust 负责解析、限长、鉴权、并发与超时，请求作为进程事件进入 Scene mailbox，
//! TS Handler 的结果经 `op_host_http_respond` 交回。面向工具与运维接口，不承载游戏帧协议。
//! Separate Scene HTTP ingress: Rust owns parsing, limits, auth, concurrency, and timeouts; each
//! request enters the Scene mailbox as a process event and the TS handler result returns through
//! `op_host_http_respond`. Intended for tools and operations, not the game frame protocol.

use std::cell::RefCell;
use std::collections::HashMap;
use std::convert::Infallible;
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::Poll;
use std::time::Duration;

use anyhow::{Context, Result};
use bytes::Bytes;
use deno_core::{JsBuffer, op2};
use deno_error::JsErrorBox;
use futures_util::FutureExt;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{self, HeaderName, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, oneshot, watch};
use tokio::task::JoinSet;

use crate::config::{SceneConfig, SceneHttpConfig};
use crate::health::ProcessHealthState;
use crate::process::{ProcessEvent, ProcessEventSender};

/// 单个响应体上限；工具接口不应返回更大的内容。 / Per-response body limit; tool endpoints should not return more.
pub const MAX_HTTP_RESPONSE_BODY_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_HEADERS: usize = 64;
/// 读请求头期限；hyper 也用它关闭 keep-alive 空闲连接。 / Header read bound; hyper also closes idle keep-alive connections with it.
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);
/// 写出连续无进展的期限。 / Bound on a write making no progress.
const WRITE_STALL_TIMEOUT: Duration = Duration::from_secs(10);
/// 每连接读缓冲软上限（hyper 可多读一次），请求头远超时返回 431；与 maxConnections 一起限定连接内存。
/// Soft per-connection read buffer cap (hyper may overshoot by one read); far larger heads get 431.
/// Together with maxConnections it bounds connection memory.
const MAX_CONNECTION_READ_BUFFER_BYTES: usize = 64 * 1024;
const CORS_MAX_AGE_SECONDS: &str = "600";
const CORS_ALLOW_METHODS: &str = "GET, POST, PUT, PATCH, DELETE";
const CORS_DEFAULT_ALLOW_HEADERS: &str = "authorization, content-type";

thread_local! {
    static HTTP_PENDING: RefCell<Option<HttpPendingRequests>> = const { RefCell::new(None) };
}

/// TS Handler 交回的完整响应。 / Complete response handed back by a TS handler.
#[derive(Debug)]
pub(crate) struct HttpReply {
    status: StatusCode,
    headers: Vec<(HeaderName, HeaderValue)>,
    body: Bytes,
}

/// 执行许可独立于 HTTP 等待方；只有真实完成、丢弃未执行工作或 Runtime 退出才释放。
/// 请求号在本表内分配，不占用游戏连接号。
/// Execution permits outlive HTTP waiters until real completion, queued discard, or runtime exit.
/// Request ids are allocated here and never consume game connection ids.
#[derive(Clone, Default)]
pub(crate) struct HttpPendingRequests {
    inner: Arc<Mutex<PendingTable>>,
}

#[derive(Default)]
struct PendingTable {
    entries: HashMap<u64, PendingRequest>,
    /// 最近分配的请求号；在 1..=u32::MAX 内回绕，跳过仍在表内的号。
    /// Last allocated id; wraps within 1..=u32::MAX and skips ids still in the table.
    last_id: u32,
}

impl PendingTable {
    /// 表内条目受并发许可限制，远少于 u32 号空间，因此总能找到空闲号。
    /// Entries are bounded by admission permits, far below the u32 space, so a free id always exists.
    fn allocate_id(&mut self) -> u64 {
        loop {
            self.last_id = self.last_id.checked_add(1).unwrap_or(1);
            let candidate = u64::from(self.last_id);
            if !self.entries.contains_key(&candidate) {
                return candidate;
            }
        }
    }
}

struct PendingRequest {
    sender: Option<oneshot::Sender<HttpReply>>,
    _permit: OwnedSemaphorePermit,
}

/// 入队前取消释放整个登记；成功入队后取消只关闭回复，不能取消业务或归还许可。
/// Cancellation removes an unsent registration, but only detaches the reply after enqueue.
struct ResponseWaiter {
    pending: HttpPendingRequests,
    request_id: u64,
    submitted: bool,
}

impl Drop for ResponseWaiter {
    fn drop(&mut self) {
        if self.submitted {
            if let Some(entry) = self.pending.lock().entries.get_mut(&self.request_id) {
                entry.sender.take();
            }
        } else {
            self.pending.discard(self.request_id);
        }
    }
}

impl HttpPendingRequests {
    /// 分配请求号并登记；号与登记在同一把锁内完成，不会与在途请求重号。
    /// Allocates an id and registers under one lock, so it never collides with a live request.
    fn register(
        &self,
        permit: OwnedSemaphorePermit,
    ) -> (u64, oneshot::Receiver<HttpReply>, ResponseWaiter) {
        let (sender, receiver) = oneshot::channel();
        let mut table = self.lock();
        let request_id = table.allocate_id();
        table.entries.insert(
            request_id,
            PendingRequest {
                sender: Some(sender),
                _permit: permit,
            },
        );
        drop(table);
        (
            request_id,
            receiver,
            ResponseWaiter {
                pending: self.clone(),
                request_id,
                submitted: false,
            },
        )
    }

    /// 只查询回复方是否仍在等待，不改变执行所有权。 / Queries the live waiter without changing execution ownership.
    fn is_pending(&self, request_id: u64) -> bool {
        self.lock()
            .entries
            .get(&request_id)
            .and_then(|entry| entry.sender.as_ref())
            .is_some_and(|sender| !sender.is_closed())
    }

    /// 仅用于保证不会执行的排队工作；不得用于取消运行中的 Handler。
    /// Only for queued work guaranteed never to execute, not for cancelling a running handler.
    fn discard(&self, request_id: u64) -> bool {
        self.lock().entries.remove(&request_id).is_some()
    }

    /// 交付回复；请求已超时或已停机时返回 false，回复被丢弃。
    /// Delivers a reply; returns false when the request already timed out or shut down.
    fn complete(&self, request_id: u64, reply: HttpReply) -> bool {
        let entry = self.lock().entries.remove(&request_id);
        entry.is_some_and(|entry| {
            entry
                .sender
                .is_some_and(|sender| sender.send(reply).is_ok())
        })
    }

    /// 监听停止只关闭回复，不提前释放仍可能执行的业务。 / Listener shutdown closes replies without releasing execution permits.
    fn close_response_senders(&self) {
        for entry in self.lock().entries.values_mut() {
            entry.sender.take();
        }
    }

    /// 仅在 Runtime 已终止、事件不可能再执行后调用。 / Call only after runtime termination makes further execution impossible.
    pub(crate) fn clear(&self) {
        self.lock().entries.clear();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, PendingTable> {
        self.inner.lock().expect("http pending map poisoned")
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.lock().entries.len()
    }
}

/// 在 V8 业务线程安装回复表；必须早于任何 TS HTTP Handler 执行。
/// Installs the reply table on the V8 business thread before any TS HTTP handler runs.
pub(crate) fn configure(pending: HttpPendingRequests) {
    HTTP_PENDING.with(|slot| *slot.borrow_mut() = Some(pending));
}

fn configured_pending() -> Result<HttpPendingRequests, JsErrorBox> {
    HTTP_PENDING
        .with(|slot| slot.borrow().clone())
        .ok_or_else(|| JsErrorBox::generic("HTTP ingress is not configured for this Process"))
}

/// 排队请求开始前查询等待方；false 时由 TS 丢弃未开始节点。 / Checks the waiter before queued work starts; TS discards unstarted work on false.
#[op2(fast)]
fn op_host_http_is_pending(request_id: u32) -> Result<bool, JsErrorBox> {
    Ok(configured_pending()?.is_pending(request_id as u64))
}

/// 终结未执行节点，重复调用返回 false。 / Settles an unexecuted node; repeated calls return false.
#[op2(fast)]
fn op_host_http_discard(request_id: u32) -> Result<bool, JsErrorBox> {
    Ok(configured_pending()?.discard(request_id as u64))
}

/// 交回一个 HTTP 请求的结果。输入非法时抛错且请求保持等待，TS 可以改发 500；
/// 请求已超时时返回 false。
/// Hands back the result of one HTTP request. Invalid input throws and leaves the request waiting
/// so TS can answer 500 instead; returns false when the request already timed out.
#[op2]
fn op_host_http_respond(
    request_id: u32,
    status: u32,
    #[string] headers_json: String,
    #[buffer] body: JsBuffer,
) -> Result<bool, JsErrorBox> {
    let reply = build_reply(status, &headers_json, &body).map_err(JsErrorBox::type_error)?;
    let pending = configured_pending()?;
    Ok(pending.complete(request_id as u64, reply))
}

fn build_reply(status: u32, headers_json: &str, body: &[u8]) -> Result<HttpReply, String> {
    let status = u16::try_from(status)
        .ok()
        .filter(|status| (200..=599).contains(status))
        .and_then(|status| StatusCode::from_u16(status).ok())
        .ok_or_else(|| format!("HTTP status {status} must be between 200 and 599"))?;
    if body.len() > MAX_HTTP_RESPONSE_BODY_BYTES {
        return Err(format!(
            "HTTP response body of {} bytes exceeds {MAX_HTTP_RESPONSE_BODY_BYTES}",
            body.len()
        ));
    }
    if matches!(status, StatusCode::NO_CONTENT | StatusCode::NOT_MODIFIED) && !body.is_empty() {
        return Err(format!("HTTP status {status} must not carry a body"));
    }
    let pairs: Vec<(String, String)> = serde_json::from_str(headers_json)
        .map_err(|_| "HTTP response headers must be a JSON array of [name, value]".to_string())?;
    if pairs.len() > MAX_RESPONSE_HEADERS {
        return Err(format!(
            "HTTP response has more than {MAX_RESPONSE_HEADERS} headers"
        ));
    }
    let mut headers = Vec::with_capacity(pairs.len());
    for (name, value) in pairs {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| format!("invalid HTTP response header name {name:?}"))?;
        if is_reserved_response_header(&name) {
            return Err(format!(
                "HTTP response header {name} is managed by the host"
            ));
        }
        let value = HeaderValue::from_str(&value)
            .map_err(|_| format!("invalid value for HTTP response header {name}"))?;
        headers.push((name, value));
    }
    Ok(HttpReply {
        status,
        headers,
        body: Bytes::copy_from_slice(body),
    })
}

/// 分帧、连接管理与跨域头由宿主负责，业务不能改写。
/// Framing, connection management, and CORS headers belong to the host; business code cannot set them.
fn is_reserved_response_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "content-length"
            | "transfer-encoding"
            | "connection"
            | "keep-alive"
            | "upgrade"
            | "te"
            | "trailer"
            | "proxy-connection"
    ) || name.as_str().starts_with("access-control-")
}

deno_core::extension!(
    http_endpoint_host,
    ops = [
        op_host_http_respond,
        op_host_http_is_pending,
        op_host_http_discard
    ]
);

pub fn init() -> deno_core::Extension {
    http_endpoint_host::init()
}

/// 启动时捕获 op 引用并冻结；Stable 包装在 `app/core/process/httpHandlers.ts`。
/// Captures the op at bootstrap and freezes it; the Stable wrapper lives in `app/core/process/httpHandlers.ts`.
pub const BOOTSTRAP_SOURCE: &str = r#"(() => {
const respondOp = globalThis.Deno.core.ops.op_host_http_respond;
const isPendingOp = globalThis.Deno.core.ops.op_host_http_is_pending;
const discardOp = globalThis.Deno.core.ops.op_host_http_discard;
Object.defineProperty(globalThis, "__hostHttp", {
  value: Object.freeze({
    respond: (requestId, status, headersJson, body) => respondOp(requestId, status, headersJson, body),
    isPending: (requestId) => isPendingOp(requestId),
    discard: (requestId) => discardOp(requestId),
  }),
  writable: false,
  configurable: false,
});
})();"#;

/// 已启动的全部 Scene HTTP 监听；停机时先停止接收再让等待中的请求得到 503。
/// All started Scene HTTP listeners; shutdown stops accepting first, then answers waiting requests 503.
pub(crate) struct HttpEndpoints {
    shutdown: watch::Sender<Option<tokio::time::Instant>>,
    tasks: JoinSet<Result<(), String>>,
    failure: Option<String>,
    pending: HttpPendingRequests,
}

impl HttpEndpoints {
    /// 同步通知全部监听停止；重复调用仅收紧绝对期限。 / Signals all listeners synchronously; repeated calls only tighten the deadline.
    pub(crate) fn request_stop(&self, deadline: tokio::time::Instant) {
        self.shutdown.send_if_modified(|current| {
            if current.is_none_or(|previous| deadline < previous) {
                *current = Some(deadline);
                true
            } else {
                false
            }
        });
    }

    /// 正常停机或无端点时保持等待；首个异常保留给 stop 返回。 / Stays pending on normal shutdown or no endpoints; retains the first failure for stop.
    pub(crate) async fn wait_failure(&mut self) -> String {
        loop {
            if let Some(error) = &self.failure {
                return error.clone();
            }
            match self.tasks.join_next().await {
                Some(result) => self.observe_listener(result),
                None => std::future::pending::<()>().await,
            }
        }
    }

    fn observe_listener(&mut self, result: Result<Result<(), String>, tokio::task::JoinError>) {
        let error = match result {
            Ok(Err(error)) => Some(error),
            Err(error) => Some(format!("HTTP listener task failed: {error}")),
            Ok(Ok(())) if self.shutdown.borrow().is_none() => {
                Some("HTTP listener exited unexpectedly".to_string())
            }
            Ok(Ok(())) => None,
        };
        if self.failure.is_none() {
            self.failure = error;
        }
    }

    /// 停止接收并有界排空所有连接；不释放仍在 TS 中运行的执行许可。
    /// Stops accepting and drains all connections within a bound, preserving active TS permits.
    pub(crate) async fn stop(mut self, timeout: Duration) -> Result<()> {
        self.request_stop(tokio::time::Instant::now() + timeout);
        while let Some(result) = self.tasks.join_next().await {
            self.observe_listener(result);
        }
        self.pending.close_response_senders();
        match self.failure {
            Some(error) => Err(anyhow::anyhow!(error)),
            None => Ok(()),
        }
    }
}

/// 所有 HTTP 端点共享的进程入口：事件队列、回复表（兼请求号来源）与就绪状态。
/// Process ingress shared by every HTTP endpoint: event queue, reply table (also the id source), and readiness.
#[derive(Clone)]
pub(crate) struct HttpIngress {
    pub(crate) event_tx: ProcessEventSender,
    pub(crate) pending: HttpPendingRequests,
    pub(crate) health: Arc<ProcessHealthState>,
}

struct EndpointState {
    scene_index: u32,
    scene_name: String,
    config: SceneHttpConfig,
    expected_authorization: Option<String>,
    ingress: HttpIngress,
    in_flight: Arc<Semaphore>,
    /// 存活连接许可；accept 后、创建连接任务前获取，随连接任务结束释放。
    /// Live-connection permits, taken after accept and before spawning, released when the task ends.
    connections: Arc<Semaphore>,
    write_stall_timeout: Duration,
    shutdown: watch::Receiver<Option<tokio::time::Instant>>,
}

/// 为配置了 `http` 的 Scene 绑定监听。绑定失败或令牌环境变量缺失会中止进程启动。
/// Binds listeners for Scenes that configure `http`. Bind failures or a missing token variable abort
/// process startup.
pub(crate) fn start_http_endpoints(
    scenes: &[SceneConfig],
    ingress: &HttpIngress,
) -> Result<HttpEndpoints> {
    start_http_endpoints_with_env(scenes, ingress, &|name| std::env::var(name).ok())
}

fn start_http_endpoints_with_env(
    scenes: &[SceneConfig],
    ingress: &HttpIngress,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<HttpEndpoints> {
    let (shutdown, _) = watch::channel(None);
    // 全部预检和绑定成功后才启动任务，失败时局部 listener 同步释放。
    // Spawn only after every validation and bind succeeds; failure drops all local listeners synchronously.
    let mut prepared = Vec::new();
    for (scene_index, scene) in scenes.iter().enumerate() {
        let Some(config) = &scene.http else {
            continue;
        };
        let expected_authorization = match &config.auth_token_env {
            Some(name) => {
                let token = env(name).with_context(|| {
                    format!(
                        "scene {} http.authTokenEnv is set but environment variable {name} is missing",
                        scene.name
                    )
                })?;
                if token.is_empty() {
                    anyhow::bail!(
                        "scene {} http.authTokenEnv variable {name} is empty",
                        scene.name
                    );
                }
                Some(format!("Bearer {token}"))
            }
            None => None,
        };
        let address = format!("{}:{}", config.bind_ip(scene), config.port);
        let listener = std::net::TcpListener::bind(&address)
            .with_context(|| format!("scene {} failed to bind http {address}", scene.name))?;
        listener.set_nonblocking(true)?;
        let listener = TcpListener::from_std(listener)?;
        tracing::info!(
            target: "tiangz::http",
            scene = %scene.name,
            %address,
            auth = expected_authorization.is_some(),
            "scene http endpoint listening"
        );
        let state = Arc::new(EndpointState {
            scene_index: scene_index as u32,
            scene_name: scene.name.clone(),
            config: config.clone(),
            expected_authorization,
            ingress: ingress.clone(),
            in_flight: Arc::new(Semaphore::new(config.max_in_flight)),
            connections: Arc::new(Semaphore::new(config.max_connections())),
            write_stall_timeout: WRITE_STALL_TIMEOUT,
            shutdown: shutdown.subscribe(),
        });
        prepared.push((listener, state));
    }
    let mut tasks = JoinSet::new();
    for (listener, state) in prepared {
        tasks.spawn(run_listener(listener, state, shutdown.subscribe()));
    }
    Ok(HttpEndpoints {
        shutdown,
        tasks,
        failure: None,
        pending: ingress.pending.clone(),
    })
}

async fn run_listener(
    listener: TcpListener,
    state: Arc<EndpointState>,
    mut shutdown: watch::Receiver<Option<tokio::time::Instant>>,
) -> Result<(), String> {
    let mut connections = JoinSet::new();
    // 保留连接集合在 unwind 边界外，监听异常也必须 abort 并 join 子任务。
    // Keep the connection set outside the unwind boundary so listener failure still aborts and joins children.
    let outcome = std::panic::AssertUnwindSafe(async {
      loop {
        tokio::select! {
            biased;
            deadline = wait_for_shutdown(&mut shutdown) => break Ok(deadline),
            result = connections.join_next(), if !connections.is_empty() => {
                if let Some(Err(error)) = result { break Err(format!("connection task failed: {error}")); }
            },
            accepted = listener.accept() => match accepted {
                Ok((stream, peer)) => {
                    // 先准入再建任务；满额时立即关闭，不占用任务、缓冲或等待名额。
                    // Admit before spawning; at capacity close at once without a task, buffers, or a wait slot.
                    let Ok(permit) = Arc::clone(&state.connections).try_acquire_owned() else {
                        tracing::debug!(target: "tiangz::http", scene = %state.scene_name, %peer, "http connection limit reached; closing");
                        drop(stream);
                        continue;
                    };
                    connections.spawn(serve_connection(stream, peer, Arc::clone(&state), shutdown.clone(), permit));
                }
                Err(error) if matches!(error.kind(), std::io::ErrorKind::Interrupted | std::io::ErrorKind::ConnectionAborted) => {},
                Err(error) => {
                    break Err(format!("accept failed: {error}"));
                }
            }
        }
      }
    }).catch_unwind().await;
    let outcome = match outcome {
        Ok(result) => result,
        Err(_) => Err("listener panicked".to_string()),
    };
    let mut deadline = outcome
        .as_ref()
        .copied()
        .unwrap_or_else(|_| tokio::time::Instant::now());
    drop(listener);
    loop {
        tokio::select! {
            biased;
            changed = shutdown.changed() => {
                if changed.is_err() {
                    deadline = tokio::time::Instant::now();
                    drain_connections(&mut connections, deadline).await;
                    break;
                }
                if let Some(tighter) = *shutdown.borrow_and_update() { deadline = deadline.min(tighter); }
            }
            _ = drain_connections(&mut connections, deadline) => break,
        }
    }
    outcome
        .map(|_| ())
        .map_err(|error| format!("HTTP scene {}: {error}", state.scene_name))
}

/// 排空后必须 join 已取消任务，不能把计数归零当作 Socket 已关闭。 / Join cancelled tasks after draining; empty counters alone do not prove sockets are closed.
async fn drain_connections(connections: &mut JoinSet<()>, deadline: tokio::time::Instant) {
    // 所有 listener 同时开始排空；超时后 abort 并 join，确保 Socket 真正释放。
    // Listeners drain concurrently; abort and join after the deadline so sockets are really released.
    let drain = async { while connections.join_next().await.is_some() {} };
    if tokio::time::timeout_at(deadline, drain).await.is_err() {
        connections.abort_all();
        while connections.join_next().await.is_some() {}
    }
}

/// 新建的接收者也必须看到已经发生的停机。 / Newly cloned receivers must also observe shutdown that already happened.
async fn wait_for_shutdown(
    shutdown: &mut watch::Receiver<Option<tokio::time::Instant>>,
) -> tokio::time::Instant {
    loop {
        if let Some(deadline) = *shutdown.borrow_and_update() {
            return deadline;
        }
        if shutdown.changed().await.is_err() {
            return tokio::time::Instant::now();
        }
    }
}

/// 连接许可持有到本任务结束；读头（含 keep-alive 空闲）、读体与写出都有期限，连接不会无限存活。
/// Holds the connection permit until the task ends; header reads (including keep-alive idle), body
/// reads, and writes are all bounded, so no connection lives indefinitely.
async fn serve_connection(
    stream: TcpStream,
    peer: SocketAddr,
    state: Arc<EndpointState>,
    mut shutdown: watch::Receiver<Option<tokio::time::Instant>>,
    _connection_permit: OwnedSemaphorePermit,
) {
    let io = WriteStallGuard::new(stream, state.write_stall_timeout);
    let service = service_fn(move |request| {
        let state = Arc::clone(&state);
        async move { Ok::<_, Infallible>(handle_request(request, peer, &state).await) }
    });
    let connection = http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(HEADER_READ_TIMEOUT)
        .max_buf_size(MAX_CONNECTION_READ_BUFFER_BYTES)
        .serve_connection(TokioIo::new(io), service);
    tokio::pin!(connection);
    let result = tokio::select! {
        result = connection.as_mut() => result,
        _ = wait_for_shutdown(&mut shutdown) => {
            connection.as_mut().graceful_shutdown();
            connection.await
        }
    };
    if let Err(error) = result {
        tracing::debug!(target: "tiangz::http", %peer, %error, "http connection closed with error");
    }
}

/// 写出连续无进展超过期限即报错断开，防止不读回复的客户端永久占用连接与回复缓冲。
/// Fails a write that makes no progress within the bound, so a client that never reads its reply
/// cannot hold the connection and reply buffer forever.
struct WriteStallGuard<S> {
    inner: S,
    stall_timeout: Duration,
    stalled_since: Option<Pin<Box<tokio::time::Sleep>>>,
}

impl<S> WriteStallGuard<S> {
    fn new(inner: S, stall_timeout: Duration) -> Self {
        Self {
            inner,
            stall_timeout,
            stalled_since: None,
        }
    }

    /// 有进展即清除计时；Pending 时从首次阻塞起计时。 / Progress clears the timer; Pending counts from the first stall.
    fn guard<T>(
        &mut self,
        cx: &mut std::task::Context<'_>,
        result: Poll<std::io::Result<T>>,
    ) -> Poll<std::io::Result<T>> {
        if result.is_ready() {
            self.stalled_since = None;
            return result;
        }
        let stall_timeout = self.stall_timeout;
        let timer = self
            .stalled_since
            .get_or_insert_with(|| Box::pin(tokio::time::sleep(stall_timeout)));
        if timer.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "HTTP response write stalled",
            )));
        }
        Poll::Pending
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for WriteStallGuard<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for WriteStallGuard<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let this = self.get_mut();
        let result = Pin::new(&mut this.inner).poll_write(cx, buf);
        this.guard(cx, result)
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        bufs: &[std::io::IoSlice<'_>],
    ) -> Poll<std::io::Result<usize>> {
        let this = self.get_mut();
        let result = Pin::new(&mut this.inner).poll_write_vectored(cx, bufs);
        this.guard(cx, result)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_flush(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        let result = Pin::new(&mut this.inner).poll_flush(cx);
        this.guard(cx, result)
    }

    fn poll_shutdown(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        let result = Pin::new(&mut this.inner).poll_shutdown(cx);
        this.guard(cx, result)
    }
}

async fn handle_request(
    request: Request<Incoming>,
    peer: SocketAddr,
    state: &EndpointState,
) -> Response<Full<Bytes>> {
    let allowed_origin = allowed_origin(&state.config, request.headers());
    let mut shutdown = state.shutdown.clone();
    let mut response = if request.method() == Method::OPTIONS
        && !state.config.cors_allow_origins.is_empty()
    {
        preflight_response(request.headers(), allowed_origin.is_some())
    } else {
        tokio::select! {
            biased;
            _ = wait_for_shutdown(&mut shutdown) => error_response(StatusCode::SERVICE_UNAVAILABLE, "stopping"),
            response = dispatch_request(request, peer, state) => response,
        }
    };
    let headers = response.headers_mut();
    if let Some(origin) = allowed_origin {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        if !state
            .config
            .cors_allow_origins
            .iter()
            .any(|value| value == "*")
        {
            headers.append(header::VARY, HeaderValue::from_static("origin"));
        }
    }
    headers
        .entry(header::CACHE_CONTROL)
        .or_insert(HeaderValue::from_static("no-store"));
    response
}

async fn dispatch_request(
    request: Request<Incoming>,
    peer: SocketAddr,
    state: &EndpointState,
) -> Response<Full<Bytes>> {
    if let Some(expected) = &state.expected_authorization {
        let authorized = request
            .headers()
            .get(header::AUTHORIZATION)
            .is_some_and(|actual| {
                crate::health::constant_time_equal(actual.as_bytes(), expected.as_bytes())
            });
        if !authorized {
            let mut response = error_response(StatusCode::UNAUTHORIZED, "unauthorized");
            response
                .headers_mut()
                .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
            return response;
        }
    }
    // 启动中、停机中或业务线程卡住时，TS 不会处理事件；立即 503，不让调用方白等到超时。
    // While starting, stopping, or stalled, TS will not handle events; answer 503 now instead of
    // letting the caller wait for the timeout.
    if !state.ingress.health.is_ready() {
        return error_response(StatusCode::SERVICE_UNAVAILABLE, "not ready");
    }
    let Ok(permit) = Arc::clone(&state.in_flight).try_acquire_owned() else {
        return error_response(StatusCode::SERVICE_UNAVAILABLE, "busy");
    };
    let deadline =
        tokio::time::Instant::now() + Duration::from_millis(state.config.request_timeout_ms);
    let limit = state.config.max_body_bytes;
    if request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|length| length > limit as u64)
    {
        return error_response(StatusCode::PAYLOAD_TOO_LARGE, "body too large");
    }
    let (parts, body) = request.into_parts();
    let body = match tokio::time::timeout_at(deadline, Limited::new(body, limit).collect()).await {
        Ok(Ok(collected)) => collected.to_bytes(),
        Ok(Err(error)) if error.is::<http_body_util::LengthLimitError>() => {
            return error_response(StatusCode::PAYLOAD_TOO_LARGE, "body too large");
        }
        Ok(Err(_)) => return error_response(StatusCode::BAD_REQUEST, "unreadable body"),
        Err(_) => {
            let mut response = error_response(StatusCode::REQUEST_TIMEOUT, "body timeout");
            response
                .headers_mut()
                .insert(header::CONNECTION, HeaderValue::from_static("close"));
            return response;
        }
    };
    let payload = match encode_request(&parts, peer, &body, state.expected_authorization.is_some())
    {
        Ok(payload) => payload,
        Err(error) => {
            tracing::warn!(target: "tiangz::http", scene = %state.scene_name, %error, "failed to encode http request");
            return error_response(StatusCode::BAD_REQUEST, "bad request");
        }
    };
    forward_to_scene(state, payload, permit, deadline).await
}

/// 超时只停止等待；许可转入执行表，直到 TS 完成或丢弃节点。
/// Timeout only stops waiting; the execution table holds admission until TS completes or discards.
async fn forward_to_scene(
    state: &EndpointState,
    payload: Bytes,
    permit: OwnedSemaphorePermit,
    deadline: tokio::time::Instant,
) -> Response<Full<Bytes>> {
    let ingress = &state.ingress;
    if tokio::time::Instant::now() >= deadline {
        return error_response(StatusCode::GATEWAY_TIMEOUT, "request timeout");
    }
    let (request_id, receiver, mut waiter) = ingress.pending.register(permit);
    let event = ProcessEvent::HttpRequest {
        scene_index: state.scene_index,
        request_id,
        payload,
        backing_reservation: None,
    };
    if let Err(error) = ingress.event_tx.try_send_http(event) {
        tracing::debug!(target: "tiangz::http", scene = %state.scene_name, ?error, "http request rejected by process queue");
        return error_response(StatusCode::SERVICE_UNAVAILABLE, "overloaded");
    }
    waiter.submitted = true;
    match tokio::time::timeout_at(deadline, receiver).await {
        Ok(Ok(reply)) => reply_response(reply),
        Ok(Err(_)) => error_response(StatusCode::SERVICE_UNAVAILABLE, "stopping"),
        Err(_) => {
            tracing::warn!(
                target: "tiangz::http",
                scene = %state.scene_name,
                request_id,
                timeout_ms = state.config.request_timeout_ms,
                "http handler did not reply before the deadline"
            );
            error_response(StatusCode::GATEWAY_TIMEOUT, "handler timeout")
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EncodedRequestMeta<'a> {
    method: &'a str,
    path: &'a str,
    query: &'a str,
    headers: Vec<(&'a str, &'a str)>,
    remote_address: String,
}

/// 请求编码为 `[metaLen:u32 LE][meta JSON][body]`。启用令牌鉴权时 Authorization 头不转发，令牌不进入 V8。
/// Encodes `[metaLen:u32 LE][meta JSON][body]`. With token auth the Authorization header is not
/// forwarded, so the token never enters V8.
fn encode_request(
    parts: &hyper::http::request::Parts,
    peer: SocketAddr,
    body: &[u8],
    strip_authorization: bool,
) -> Result<Bytes> {
    let headers = parts
        .headers
        .iter()
        .filter(|(name, _)| !(strip_authorization && *name == header::AUTHORIZATION))
        .filter_map(|(name, value)| value.to_str().ok().map(|value| (name.as_str(), value)))
        .collect();
    let meta = serde_json::to_vec(&EncodedRequestMeta {
        method: parts.method.as_str(),
        path: parts.uri.path(),
        query: parts.uri.query().unwrap_or(""),
        headers,
        remote_address: peer.to_string(),
    })?;
    let meta_len = u32::try_from(meta.len()).context("http request metadata too large")?;
    let mut payload = Vec::with_capacity(4 + meta.len() + body.len());
    payload.extend_from_slice(&meta_len.to_le_bytes());
    payload.extend_from_slice(&meta);
    payload.extend_from_slice(body);
    Ok(payload.into())
}

fn allowed_origin(config: &SceneHttpConfig, headers: &hyper::HeaderMap) -> Option<HeaderValue> {
    if config.cors_allow_origins.is_empty() {
        return None;
    }
    if config.cors_allow_origins.iter().any(|value| value == "*") {
        return Some(HeaderValue::from_static("*"));
    }
    let origin = headers.get(header::ORIGIN)?;
    let text = origin.to_str().ok()?;
    config
        .cors_allow_origins
        .iter()
        .any(|allowed| allowed.eq_ignore_ascii_case(text))
        .then(|| origin.clone())
}

fn preflight_response(headers: &hyper::HeaderMap, allowed: bool) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::new()));
    *response.status_mut() = StatusCode::NO_CONTENT;
    if allowed {
        let response_headers = response.headers_mut();
        response_headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static(CORS_ALLOW_METHODS),
        );
        let requested = headers
            .get(header::ACCESS_CONTROL_REQUEST_HEADERS)
            .cloned()
            .unwrap_or(HeaderValue::from_static(CORS_DEFAULT_ALLOW_HEADERS));
        response_headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, requested);
        response_headers.insert(
            header::ACCESS_CONTROL_MAX_AGE,
            HeaderValue::from_static(CORS_MAX_AGE_SECONDS),
        );
    }
    response
}

fn reply_response(reply: HttpReply) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(reply.body));
    *response.status_mut() = reply.status;
    let headers = response.headers_mut();
    for (name, value) in reply.headers {
        headers.append(name, value);
    }
    response
}

fn error_response(status: StatusCode, error: &str) -> Response<Full<Bytes>> {
    let body = serde_json::to_vec(&serde_json::json!({ "error": error })).unwrap_or_default();
    let mut response = Response::new(Full::new(Bytes::from(body)));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::{ProcessEvent, test_process_event_channel};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn reply_validation_rejects_host_managed_headers_and_bad_status() {
        assert!(build_reply(200, r#"[["content-type","text/plain"]]"#, b"ok").is_ok());
        assert!(build_reply(199, "[]", b"").is_err());
        assert!(build_reply(600, "[]", b"").is_err());
        assert!(build_reply(204, "[]", b"x").is_err());
        assert!(build_reply(200, r#"[["content-length","1"]]"#, b"").is_err());
        assert!(build_reply(200, r#"[["access-control-allow-origin","*"]]"#, b"").is_err());
        assert!(build_reply(200, r#"[["x-ok","a\r\nb"]]"#, b"").is_err());
        assert!(build_reply(200, r#"{"x":"y"}"#, b"").is_err());
        assert!(build_reply(200, "[]", &vec![0; MAX_HTTP_RESPONSE_BODY_BYTES + 1]).is_err());
    }

    #[test]
    fn pending_reply_is_delivered_once() {
        let pending = HttpPendingRequests::default();
        let permits = Arc::new(Semaphore::new(1));
        let (id, mut receiver, _waiter) =
            pending.register(permits.clone().try_acquire_owned().unwrap());
        let reply = || build_reply(200, "[]", b"").unwrap();
        assert!(pending.complete(id, reply()));
        assert!(!pending.complete(id, reply()));
        assert_eq!(receiver.try_recv().unwrap().status, StatusCode::OK);
        let (_, receiver, _waiter) = pending.register(permits.clone().try_acquire_owned().unwrap());
        pending.clear();
        assert!(receiver.blocking_recv().is_err());
        assert_eq!(permits.available_permits(), 1);
    }

    #[test]
    fn waiter_cancellation_preserves_only_submitted_execution() {
        let pending = HttpPendingRequests::default();
        let permits = Arc::new(Semaphore::new(1));
        let (id, receiver, waiter) = pending.register(permits.clone().try_acquire_owned().unwrap());
        assert!(pending.is_pending(id));
        drop(waiter);
        assert_eq!(permits.available_permits(), 1);
        assert!(receiver.blocking_recv().is_err());
        assert_eq!(pending.len(), 0);

        let (id, receiver, mut waiter) =
            pending.register(permits.clone().try_acquire_owned().unwrap());
        waiter.submitted = true;
        drop(receiver);
        assert!(
            !pending.is_pending(id),
            "closed receiver must be visible before guard cleanup"
        );
        drop(waiter);
        assert_eq!(permits.available_permits(), 0);
        assert!(!pending.complete(id, build_reply(200, "[]", b"late").unwrap()));
        assert_eq!(permits.available_permits(), 1);
        assert!(!pending.discard(id));
    }

    #[test]
    fn request_ids_wrap_within_u32_and_skip_live_requests() {
        let pending = HttpPendingRequests::default();
        let permits = Arc::new(Semaphore::new(3));
        let permit = || permits.clone().try_acquire_owned().unwrap();
        let (first, _first_receiver, _first_waiter) = pending.register(permit());
        assert_eq!(first, 1);
        pending.lock().last_id = u32::MAX - 1;
        let (last, _last_receiver, _last_waiter) = pending.register(permit());
        assert_eq!(last, u64::from(u32::MAX));
        // 回绕后跳过仍在途的 1，不重号也不报耗尽。 / After wrapping, live id 1 is skipped instead of reused or exhausted.
        let (wrapped, _wrapped_receiver, _wrapped_waiter) = pending.register(permit());
        assert_eq!(wrapped, 2);
        assert_eq!(pending.len(), 3);
    }

    #[test]
    fn closing_replies_retains_execution_until_discard_or_runtime_exit() {
        let pending = HttpPendingRequests::default();
        let permits = Arc::new(Semaphore::new(2));
        let (first_id, first, mut first_waiter) =
            pending.register(permits.clone().try_acquire_owned().unwrap());
        let (_, second, mut second_waiter) =
            pending.register(permits.clone().try_acquire_owned().unwrap());
        first_waiter.submitted = true;
        second_waiter.submitted = true;
        pending.close_response_senders();
        assert!(first.blocking_recv().is_err());
        assert!(second.blocking_recv().is_err());
        assert!(!pending.is_pending(first_id));
        assert_eq!(permits.available_permits(), 0);
        assert!(pending.discard(first_id));
        assert!(!pending.discard(first_id));
        assert_eq!(permits.available_permits(), 1);
        pending.clear();
        assert_eq!(permits.available_permits(), 2);
    }

    #[tokio::test]
    async fn bridge_preserves_invalid_reply_for_fallback_and_discards_once() {
        let pending = HttpPendingRequests::default();
        let permits = Arc::new(Semaphore::new(1));
        configure(pending.clone());
        let mut runtime = deno_core::JsRuntime::new(deno_core::RuntimeOptions {
            extensions: vec![init()],
            ..Default::default()
        });
        runtime
            .execute_script("http-bootstrap", BOOTSTRAP_SOURCE)
            .unwrap();
        // 新表从 1 开始分配，脚本中的编号与之对应。 / A fresh table allocates from 1, matching the ids in the scripts.
        let (id, mut receiver, mut waiter) =
            pending.register(permits.clone().try_acquire_owned().unwrap());
        assert_eq!(id, 1);
        waiter.submitted = true;
        runtime.execute_script("invalid-http-reply", r#"
            if (!__hostHttp.isPending(1)) throw new Error('missing waiter');
            let rejected = false;
            try { __hostHttp.respond(1, 99, '[]', new Uint8Array()); }
            catch (_) { rejected = true; }
            if (!rejected || !__hostHttp.isPending(1)) throw new Error('invalid reply lost request');
        "#).unwrap();
        assert_eq!(permits.available_permits(), 0);
        runtime.execute_script("fallback-http-reply", r#"
            if (!__hostHttp.respond(1, 500, '[]', new Uint8Array())) throw new Error('fallback lost');
            if (__hostHttp.isPending(1) || __hostHttp.discard(1)) throw new Error('entry retained');
        "#).unwrap();
        assert_eq!(
            receiver.try_recv().unwrap().status,
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(permits.available_permits(), 1);

        let (id, receiver, mut waiter) =
            pending.register(permits.clone().try_acquire_owned().unwrap());
        assert_eq!(id, 2);
        waiter.submitted = true;
        drop(receiver);
        runtime.execute_script("discard-http-request", r#"
            if (__hostHttp.isPending(2)) throw new Error('closed waiter visible');
            if (!__hostHttp.discard(2) || __hostHttp.discard(2)) throw new Error('discard not idempotent');
        "#).unwrap();
        assert_eq!(permits.available_permits(), 1);
    }

    #[tokio::test]
    async fn drain_aborts_and_joins_a_stalled_connection_task() {
        let permits = Arc::new(Semaphore::new(1));
        let permit = permits.clone().try_acquire_owned().unwrap();
        let mut connections = JoinSet::new();
        connections.spawn(async move {
            let _permit = permit;
            std::future::pending::<()>().await;
        });
        tokio::time::timeout(
            Duration::from_secs(3),
            drain_connections(
                &mut connections,
                tokio::time::Instant::now() + Duration::from_millis(20),
            ),
        )
        .await
        .unwrap();
        assert!(connections.is_empty());
        assert_eq!(
            permits.available_permits(),
            1,
            "cancelled task must actually drop its resources"
        );
    }

    fn scene_with_http(port: u16, http: serde_json::Value) -> SceneConfig {
        serde_json::from_value(serde_json::json!({
            "name": "tools",
            "sceneType": "Tools",
            "innerIp": "127.0.0.1",
            "port": 1,
            "http": http,
        }))
        .map(|mut scene: SceneConfig| {
            scene.http.as_mut().unwrap().port = port;
            scene
        })
        .unwrap()
    }

    fn test_env(name: &str) -> Option<String> {
        (name == "TEST_TOKEN").then(|| "secret".to_string())
    }

    /// 返回已就绪的测试入口与数据队列接收端。 / Returns a ready test ingress and the data-queue receiver.
    fn test_ingress() -> (HttpIngress, std::sync::mpsc::Receiver<ProcessEvent>) {
        let (event_tx, receiver) = test_process_event_channel(16);
        let health = Arc::new(ProcessHealthState::starting(Duration::from_secs(60)));
        health.mark_endpoints_ready();
        health.mark_runtime_ready();
        (
            HttpIngress {
                event_tx,
                pending: HttpPendingRequests::default(),
                health,
            },
            receiver,
        )
    }

    fn test_state(
        ingress: HttpIngress,
        shutdown: watch::Receiver<Option<tokio::time::Instant>>,
    ) -> Arc<EndpointState> {
        Arc::new(EndpointState {
            scene_index: 0,
            scene_name: "tools".into(),
            config: scene_with_http(
                1,
                serde_json::json!({
                    "port": 1, "requestTimeoutMs": 100, "maxInFlight": 1,
                }),
            )
            .http
            .unwrap(),
            expected_authorization: None,
            ingress,
            in_flight: Arc::new(Semaphore::new(1)),
            connections: Arc::new(Semaphore::new(4)),
            write_stall_timeout: WRITE_STALL_TIMEOUT,
            shutdown,
        })
    }

    async fn next_event(receiver: &std::sync::mpsc::Receiver<ProcessEvent>) -> ProcessEvent {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                match receiver.try_recv() {
                    Ok(event) => return event,
                    Err(std::sync::mpsc::TryRecvError::Empty) => tokio::task::yield_now().await,
                    Err(error) => panic!("event channel closed: {error}"),
                }
            }
        })
        .await
        .expect("HTTP event must arrive")
    }

    #[tokio::test]
    async fn aborted_forward_retains_admission_until_queued_discard() {
        let (ingress, receiver) = test_ingress();
        let (_shutdown, signal) = watch::channel(None);
        let state = test_state(ingress, signal);
        let task_state = state.clone();
        let task = tokio::spawn(async move {
            let permit = task_state.in_flight.clone().try_acquire_owned().unwrap();
            forward_to_scene(
                &task_state,
                Bytes::new(),
                permit,
                tokio::time::Instant::now() + Duration::from_secs(60),
            )
            .await
        });
        let ProcessEvent::HttpRequest { request_id, .. } = next_event(&receiver).await else {
            panic!("expected HTTP event");
        };
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(!state.ingress.pending.is_pending(request_id));
        assert_eq!(state.in_flight.available_permits(), 0);
        assert!(state.ingress.pending.discard(request_id));
        assert_eq!(state.in_flight.available_permits(), 1);
    }

    #[tokio::test]
    async fn full_or_closed_ingress_rolls_back_entire_registration() {
        let (mut ingress, _) = test_ingress();
        let (event_tx, receiver) = test_process_event_channel(1);
        ingress.event_tx = event_tx;
        ingress
            .event_tx
            .try_send_http(ProcessEvent::HttpRequest {
                scene_index: 0,
                request_id: 100,
                payload: Bytes::new(),
                backing_reservation: None,
            })
            .unwrap();
        let (_shutdown, signal) = watch::channel(None);
        let state = test_state(ingress, signal);
        let response = forward_to_scene(
            &state,
            Bytes::new(),
            state.in_flight.clone().try_acquire_owned().unwrap(),
            tokio::time::Instant::now() + Duration::from_secs(60),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(state.ingress.pending.len() == 0);
        assert_eq!(state.in_flight.available_permits(), 1);
        drop(receiver);
        let response = forward_to_scene(
            &state,
            Bytes::new(),
            state.in_flight.clone().try_acquire_owned().unwrap(),
            tokio::time::Instant::now() + Duration::from_secs(60),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(state.ingress.pending.len() == 0);
        assert_eq!(state.in_flight.available_permits(), 1);
    }

    #[tokio::test]
    async fn last_request_id_is_usable_and_then_wraps_to_one() {
        let (ingress, receiver) = test_ingress();
        ingress.pending.lock().last_id = u32::MAX - 1;
        let (_shutdown, signal) = watch::channel(None);
        let state = test_state(ingress, signal);
        for expected in [u64::from(u32::MAX), 1] {
            let task_state = state.clone();
            let task = tokio::spawn(async move {
                forward_to_scene(
                    &task_state,
                    Bytes::new(),
                    task_state.in_flight.clone().try_acquire_owned().unwrap(),
                    tokio::time::Instant::now() + Duration::from_secs(60),
                )
                .await
            });
            let ProcessEvent::HttpRequest { request_id, .. } = next_event(&receiver).await else {
                panic!("expected HTTP event");
            };
            assert_eq!(request_id, expected);
            assert!(
                state
                    .ingress
                    .pending
                    .complete(request_id, build_reply(200, "[]", b"").unwrap())
            );
            assert_eq!(task.await.unwrap().status(), StatusCode::OK);
            assert_eq!(state.in_flight.available_permits(), 1);
        }
    }

    /// 连接满额时新连接立即关闭且不进入 Scene；旧连接结束后名额恢复。
    /// At capacity a new connection closes at once without reaching the Scene; capacity returns once an old one ends.
    #[tokio::test]
    async fn connection_limit_closes_excess_connections_before_spawning() {
        let port = free_port();
        let (ingress, receiver) = test_ingress();
        let endpoints = start_http_endpoints_with_env(
            &[scene_with_http(
                port,
                serde_json::json!({
                    "port": 1, "maxInFlight": 1, "maxConnections": 1, "authTokenEnv": "TEST_TOKEN",
                }),
            )],
            &ingress,
            &test_env,
        )
        .unwrap();
        let mut holder = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        holder.write_all(b"GET / HTTP/1.1\r\nHost:").await.unwrap();
        // 等待持有者确实占住名额，避免与其 accept 竞争。 / Wait until the holder owns the slot to avoid racing its accept.
        let probe = "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n";
        let rejected = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let response = raw_request_lossy(port, probe).await;
                if response.is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        assert!(
            rejected.is_ok(),
            "excess connection must be closed without a response"
        );
        drop(holder);
        let admitted = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let response = raw_request_lossy(port, probe).await;
                if response.starts_with("HTTP/1.1 401") {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        assert!(
            admitted.is_ok(),
            "capacity must return after the holder closes"
        );
        assert!(receiver.try_recv().is_err());
        endpoints.stop(Duration::from_secs(2)).await.unwrap();
    }

    /// 对端不读时写出在期限后失败，而不是永久挂起。 / A write to a peer that never reads fails after the bound instead of hanging.
    #[tokio::test]
    async fn stalled_write_fails_after_the_bound_and_progress_resets_it() {
        // 保留不读的对端，使写出只会阻塞而不是报对端关闭。 / Keep the unread peer alive so writes block instead of failing as closed.
        let (_unread_peer, server) = tokio::io::duplex(16);
        let mut guarded = WriteStallGuard::new(server, Duration::from_millis(50));
        let started = tokio::time::Instant::now();
        let error = tokio::time::timeout(Duration::from_secs(2), guarded.write_all(&[0; 1024]))
            .await
            .expect("stalled write must not hang")
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() >= Duration::from_millis(50));

        // 慢但持续的读取方每次都推进写出，总耗时超过期限也不应失败。
        // A slow but steady reader keeps progressing, so the write succeeds even though it outlasts the bound.
        let (mut reader, server) = tokio::io::duplex(16);
        let mut guarded = WriteStallGuard::new(server, Duration::from_millis(50));
        let drain = tokio::spawn(async move {
            let mut buffer = [0; 16];
            let mut total = 0;
            while total < 256 {
                tokio::time::sleep(Duration::from_millis(10)).await;
                total += reader.read(&mut buffer).await.unwrap();
            }
        });
        let started = tokio::time::Instant::now();
        tokio::time::timeout(Duration::from_secs(2), guarded.write_all(&[1; 256]))
            .await
            .unwrap()
            .unwrap();
        assert!(started.elapsed() > Duration::from_millis(50));
        drain.await.unwrap();
    }

    /// 超出连接读缓冲的请求头被 hyper 拒绝，不会无限占用内存。 / Request heads beyond the read buffer are rejected by hyper instead of growing memory.
    #[tokio::test]
    async fn oversized_request_head_is_rejected() {
        let port = free_port();
        let (ingress, receiver) = test_ingress();
        let endpoints = start_http_endpoints(
            &[scene_with_http(port, serde_json::json!({ "port": 1 }))],
            &ingress,
        )
        .unwrap();
        // hyper 只在缓冲满后停止继续读取，单次读取可略超上限，因此用数倍长度验证拒绝。
        // hyper stops reading only once the buffer is full and one read may overshoot, so test with several times the cap.
        let huge = "a".repeat(MAX_CONNECTION_READ_BUFFER_BYTES * 4);
        let response = tokio::time::timeout(
            Duration::from_secs(2),
            raw_request_lossy(
                port,
                &format!("GET / HTTP/1.1\r\nHost: x\r\nX-Big: {huge}\r\nConnection: close\r\n\r\n"),
            ),
        )
        .await
        .expect("oversized head must close the connection promptly");
        // 服务端未读完就关闭时，平台可能以 reset 代替 431。 / Closing with unread input may surface as a reset instead of 431.
        assert!(
            response.is_empty() || response.starts_with("HTTP/1.1 431"),
            "{response}"
        );
        assert!(receiver.try_recv().is_err());
        endpoints.stop(Duration::from_secs(2)).await.unwrap();
    }

    /// 在同一个 Runtime 内检查停机后的实际 Socket 与许可。 / Checks actual sockets and permits while the same runtime remains alive.
    #[tokio::test]
    async fn incomplete_body_times_out_and_shutdown_joins_connections() {
        let (ingress, receiver) = test_ingress();
        let (shutdown, signal) = watch::channel(None);
        let state = test_state(ingress, signal.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut tasks = JoinSet::new();
        tasks.spawn(run_listener(listener, state.clone(), signal));
        let endpoints = HttpEndpoints {
            shutdown,
            tasks,
            failure: None,
            pending: state.ingress.pending.clone(),
        };
        let response = tokio::time::timeout(
            Duration::from_secs(2),
            raw_request(
                port,
                "POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 10\r\nConnection: close\r\n\r\nx",
            ),
        )
        .await
        .unwrap();
        assert!(response.starts_with("HTTP/1.1 408"), "{response}");
        assert_eq!(state.in_flight.available_permits(), 1);
        assert!(receiver.try_recv().is_err());

        // 已入队请求和半包连接都必须随停机关闭。 / Both the queued request and incomplete-header connection must close on shutdown.
        let mut idle = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        idle.write_all(b"POST / HTTP/1.1\r\nHost:").await.unwrap();
        let mut active = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        active
            .write_all(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
            .await
            .unwrap();
        let ProcessEvent::HttpRequest { request_id, .. } = next_event(&receiver).await else {
            panic!("expected HTTP event");
        };
        tokio::time::timeout(
            Duration::from_secs(3),
            endpoints.stop(Duration::from_secs(2)),
        )
        .await
        .unwrap()
        .unwrap();
        let mut bytes = Vec::new();
        tokio::time::timeout(Duration::from_secs(1), active.read_to_end(&mut bytes))
            .await
            .unwrap()
            .unwrap();
        assert!(String::from_utf8_lossy(&bytes).starts_with("HTTP/1.1 503"));
        let mut bytes = Vec::new();
        // EOF 或 reset 都表示 Socket 已关闭；允许 Hyper 先写错误响应。
        // EOF or reset both prove closure; Hyper may write an error response first.
        let _ = tokio::time::timeout(Duration::from_secs(1), idle.read_to_end(&mut bytes))
            .await
            .expect("idle socket survived stop");
        assert!(!state.ingress.pending.is_pending(request_id));
        assert_eq!(state.in_flight.available_permits(), 0);
        assert!(
            !state
                .ingress
                .pending
                .complete(request_id, build_reply(200, "[]", b"").unwrap())
        );
        assert_eq!(state.in_flight.available_permits(), 1);
    }

    #[test]
    fn missing_token_variable_aborts_startup() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _guard = runtime.enter();
        let (ingress, _receiver) = test_ingress();
        let error = start_http_endpoints_with_env(
            &[scene_with_http(
                free_port(),
                serde_json::json!({ "port": 1, "authTokenEnv": "MISSING" }),
            )],
            &ingress,
            &test_env,
        )
        .err()
        .expect("missing token must fail")
        .to_string();
        assert!(error.contains("MISSING"), "{error}");
    }

    #[tokio::test]
    async fn partial_startup_failure_releases_bound_ports_before_returning() {
        let (ingress, _receiver) = test_ingress();
        for missing_token in [false, true] {
            let port = free_port();
            let first = scene_with_http(port, serde_json::json!({ "port": 1 }));
            let second = scene_with_http(
                port,
                if missing_token {
                    serde_json::json!({ "port": 1, "authTokenEnv": "MISSING" })
                } else {
                    serde_json::json!({ "port": 1 })
                },
            );
            assert!(start_http_endpoints_with_env(&[first, second], &ingress, &test_env).is_err());
            // 不 yield：若旧 listener 被 detach，它仍持有此端口，绑定必然失败。
            // Do not yield: a detached listener would still own the port and make this bind fail.
            let rebound = std::net::TcpListener::bind(("127.0.0.1", port))
                .expect("startup failure must synchronously release earlier listeners");
            drop(rebound);
        }
    }

    #[tokio::test]
    async fn supervision_preserves_failure_and_stop_joins_other_listeners() {
        let (ingress, _receiver) = test_ingress();
        let mut endpoints = start_http_endpoints(&[], &ingress).unwrap();
        let permits = Arc::new(Semaphore::new(1));
        let permit = permits.clone().try_acquire_owned().unwrap();
        let mut shutdown = endpoints.shutdown.subscribe();
        endpoints.tasks.spawn(async move {
            let _permit = permit;
            wait_for_shutdown(&mut shutdown).await;
            Ok(())
        });
        endpoints
            .tasks
            .spawn(async { Err("injected accept failure".into()) });
        let failure = tokio::time::timeout(Duration::from_secs(1), endpoints.wait_failure())
            .await
            .unwrap();
        assert!(failure.contains("injected accept failure"));
        assert_eq!(permits.available_permits(), 0);
        let error = endpoints.stop(Duration::from_secs(1)).await.unwrap_err();
        assert!(error.to_string().contains("injected accept failure"));
        assert_eq!(permits.available_permits(), 1);
    }

    #[tokio::test]
    async fn supervision_reports_panics_and_unexpected_listener_exit() {
        let (ingress, _receiver) = test_ingress();
        for panic in [false, true] {
            let mut endpoints = start_http_endpoints(&[], &ingress).unwrap();
            endpoints.tasks.spawn(async move {
                assert!(!panic, "injected listener panic");
                Ok(())
            });
            let failure = tokio::time::timeout(Duration::from_secs(1), endpoints.wait_failure())
                .await
                .unwrap();
            assert!(
                failure.contains(if panic {
                    "task failed"
                } else {
                    "exited unexpectedly"
                }),
                "{failure}"
            );
            assert!(endpoints.stop(Duration::from_secs(1)).await.is_err());
        }
    }

    #[tokio::test]
    async fn empty_or_normally_stopped_endpoints_do_not_signal_failure() {
        let (ingress, _receiver) = test_ingress();
        let mut endpoints = start_http_endpoints(&[], &ingress).unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(10), endpoints.wait_failure())
                .await
                .is_err()
        );
        endpoints.request_stop(tokio::time::Instant::now());
        endpoints.tasks.spawn(async { Ok(()) });
        assert!(
            tokio::time::timeout(Duration::from_millis(10), endpoints.wait_failure())
                .await
                .is_err()
        );
        endpoints.stop(Duration::ZERO).await.unwrap();
    }

    #[tokio::test]
    async fn request_stop_only_tightens_shared_deadline() {
        let (ingress, _receiver) = test_ingress();
        let endpoints = start_http_endpoints(&[], &ingress).unwrap();
        let mut signal = endpoints.shutdown.subscribe();
        let now = tokio::time::Instant::now();
        endpoints.request_stop(now + Duration::from_secs(1));
        endpoints.request_stop(now + Duration::from_secs(10));
        assert_eq!(
            wait_for_shutdown(&mut signal).await,
            now + Duration::from_secs(1)
        );
        endpoints.request_stop(now);
        assert_eq!(wait_for_shutdown(&mut signal).await, now);
        endpoints.stop(Duration::from_secs(60)).await.unwrap();
        assert_eq!(
            *signal.borrow(),
            Some(now),
            "stop must not extend an earlier deadline"
        );
    }

    fn free_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    async fn raw_request(port: u16, request: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        String::from_utf8(response).unwrap()
    }

    /// 容忍写入失败和 reset，返回关闭前收到的内容。 / Tolerates write failures and resets, returning what arrived before closure.
    async fn raw_request_lossy(port: u16, request: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let _ = stream.write_all(request.as_bytes()).await;
        let mut response = Vec::new();
        let _ = stream.read_to_end(&mut response).await;
        String::from_utf8_lossy(&response).into_owned()
    }

    fn decode_payload(payload: &[u8]) -> (serde_json::Value, Vec<u8>) {
        let meta_len = u32::from_le_bytes(payload[..4].try_into().unwrap()) as usize;
        let meta = serde_json::from_slice(&payload[4..4 + meta_len]).unwrap();
        (meta, payload[4 + meta_len..].to_vec())
    }

    #[tokio::test]
    async fn forwards_request_to_scene_and_returns_reply() {
        let port = free_port();
        let (ingress, receiver) = test_ingress();
        ingress.pending.lock().last_id = 40;
        let endpoints = start_http_endpoints(
            &[scene_with_http(
                port,
                serde_json::json!({ "port": 1, "corsAllowOrigins": ["*"] }),
            )],
            &ingress,
        )
        .unwrap();
        let responder_pending = ingress.pending.clone();
        let responder = std::thread::spawn(move || {
            let event = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
            let ProcessEvent::HttpRequest {
                scene_index,
                request_id,
                payload,
                ..
            } = event
            else {
                panic!("expected http request event");
            };
            assert_eq!((scene_index, request_id), (0, 41));
            let (meta, body) = decode_payload(&payload);
            assert_eq!(meta["method"], "POST");
            assert_eq!(meta["path"], "/tools/echo");
            assert_eq!(meta["query"], "a=1&b=%20");
            assert!(
                meta["remoteAddress"]
                    .as_str()
                    .unwrap()
                    .starts_with("127.0.0.1:")
            );
            let reply = build_reply(201, r#"[["content-type","text/plain"]]"#, &body).unwrap();
            assert!(responder_pending.complete(request_id, reply));
        });
        let response = raw_request(
            port,
            "POST /tools/echo?a=1&b=%20 HTTP/1.1\r\nHost: x\r\nOrigin: http://a.test\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
        )
        .await;
        responder.join().unwrap();
        assert!(response.starts_with("HTTP/1.1 201 Created"), "{response}");
        assert!(
            response
                .to_ascii_lowercase()
                .contains("access-control-allow-origin: *")
        );
        assert!(
            response
                .to_ascii_lowercase()
                .contains("cache-control: no-store")
        );
        assert!(response.ends_with("hello"), "{response}");
        endpoints.stop(Duration::from_secs(2)).await.unwrap();
    }

    #[tokio::test]
    async fn rejects_without_entering_scene() {
        let port = free_port();
        let (ingress, receiver) = test_ingress();
        let endpoints = start_http_endpoints_with_env(
            &[scene_with_http(
                port,
                serde_json::json!({
                    "port": 1,
                    "maxBodyBytes": 4,
                    "authTokenEnv": "TEST_TOKEN",
                    "corsAllowOrigins": ["http://ok.test"],
                }),
            )],
            &ingress,
            &test_env,
        )
        .unwrap();
        let unauthorized = raw_request(
            port,
            "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(unauthorized.starts_with("HTTP/1.1 401"), "{unauthorized}");
        let too_large = raw_request(
            port,
            "POST / HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer secret\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
        )
        .await;
        assert!(too_large.starts_with("HTTP/1.1 413"), "{too_large}");
        let preflight = raw_request(
            port,
            "OPTIONS /x HTTP/1.1\r\nHost: x\r\nOrigin: http://ok.test\r\nConnection: close\r\n\r\n",
        )
        .await
        .to_ascii_lowercase();
        assert!(preflight.starts_with("http/1.1 204"), "{preflight}");
        assert!(preflight.contains("access-control-allow-origin: http://ok.test"));
        assert!(preflight.contains("access-control-allow-methods"));
        let foreign = raw_request(
            port,
            "OPTIONS /x HTTP/1.1\r\nHost: x\r\nOrigin: http://evil.test\r\nConnection: close\r\n\r\n",
        )
        .await
        .to_ascii_lowercase();
        assert!(
            !foreign.contains("access-control-allow-origin"),
            "{foreign}"
        );
        ingress.health.mark_stopping();
        let stopping = raw_request(
            port,
            "GET / HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer secret\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(stopping.starts_with("HTTP/1.1 503"), "{stopping}");
        assert!(
            receiver.try_recv().is_err(),
            "rejected requests must not reach the Scene"
        );
        endpoints.stop(Duration::from_secs(2)).await.unwrap();
    }

    #[tokio::test]
    async fn strips_token_and_times_out_without_reply() {
        let port = free_port();
        let (ingress, receiver) = test_ingress();
        let pending = ingress.pending.clone();
        let endpoints = start_http_endpoints_with_env(
            &[scene_with_http(
                port,
                serde_json::json!({
                    "port": 1,
                    "requestTimeoutMs": 100,
                    "authTokenEnv": "TEST_TOKEN",
                }),
            )],
            &ingress,
            &test_env,
        )
        .unwrap();
        let response = raw_request(
            port,
            "GET /slow HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer secret\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 504"), "{response}");
        let ProcessEvent::HttpRequest {
            request_id,
            payload,
            ..
        } = receiver.try_recv().unwrap()
        else {
            panic!("expected http request event");
        };
        let (meta, _) = decode_payload(&payload);
        let forwarded = meta["headers"].to_string().to_ascii_lowercase();
        assert!(!forwarded.contains("authorization") && !forwarded.contains("secret"));
        assert!(!pending.is_pending(request_id));
        assert_eq!(pending.len(), 1, "timeout must retain execution admission");
        assert!(
            !pending.complete(request_id, build_reply(200, "[]", b"").unwrap()),
            "a late reply must be dropped"
        );
        assert!(pending.len() == 0, "late completion must release admission");
        endpoints.stop(Duration::from_secs(2)).await.unwrap();
    }
}
