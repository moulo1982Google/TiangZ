//! Scene 的独立 HTTP 入口：Rust 负责解析、限长、鉴权、并发与超时，请求作为进程事件进入 Scene mailbox，
//! TS Handler 的结果经 `op_host_http_respond` 交回。面向工具与运维接口，不承载游戏帧协议。
//! Separate Scene HTTP ingress: Rust owns parsing, limits, auth, concurrency, and timeouts; each
//! request enters the Scene mailbox as a process event and the TS handler result returns through
//! `op_host_http_respond`. Intended for tools and operations, not the game frame protocol.

use std::cell::RefCell;
use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use bytes::Bytes;
use deno_core::{JsBuffer, op2};
use deno_error::JsErrorBox;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{self, HeaderName, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::Serialize;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, oneshot, watch};
use tokio::task::JoinHandle;

use crate::config::{SceneConfig, SceneHttpConfig};
use crate::health::ProcessHealthState;
use crate::process::{ProcessEvent, ProcessEventSender};

/// 单个响应体上限；工具接口不应返回更大的内容。 / Per-response body limit; tool endpoints should not return more.
pub const MAX_HTTP_RESPONSE_BODY_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_HEADERS: usize = 64;
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);
/// 进程队列满时最多等待这么久再返回 503，避免 HTTP 请求长期占住背压。
/// Longest wait for a full process queue before answering 503, so HTTP never parks on backpressure.
const ENQUEUE_DEADLINE: Duration = Duration::from_millis(100);
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

/// 等待 TS 回复的请求表；端点任务与 V8 线程共享。停机时清空，使等待方得到 503。
/// Requests awaiting a TS reply, shared by endpoint tasks and the V8 thread. Cleared on shutdown so
/// waiters answer 503.
#[derive(Clone, Default)]
pub(crate) struct HttpPendingRequests {
    inner: Arc<Mutex<HashMap<u64, oneshot::Sender<HttpReply>>>>,
}

impl HttpPendingRequests {
    fn register(&self, request_id: u64) -> oneshot::Receiver<HttpReply> {
        let (sender, receiver) = oneshot::channel();
        self.lock().insert(request_id, sender);
        receiver
    }

    fn remove(&self, request_id: u64) {
        self.lock().remove(&request_id);
    }

    /// 交付回复；请求已超时或已停机时返回 false，回复被丢弃。
    /// Delivers a reply; returns false when the request already timed out or shut down.
    fn complete(&self, request_id: u64, reply: HttpReply) -> bool {
        let sender = self.lock().remove(&request_id);
        sender.is_some_and(|sender| sender.send(reply).is_ok())
    }

    fn clear(&self) {
        self.lock().clear();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u64, oneshot::Sender<HttpReply>>> {
        self.inner.lock().expect("http pending map poisoned")
    }
}

/// 在 V8 业务线程安装回复表；必须早于任何 TS HTTP Handler 执行。
/// Installs the reply table on the V8 business thread before any TS HTTP handler runs.
pub(crate) fn configure(pending: HttpPendingRequests) {
    HTTP_PENDING.with(|slot| *slot.borrow_mut() = Some(pending));
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
    let pending = HTTP_PENDING
        .with(|slot| slot.borrow().clone())
        .ok_or_else(|| JsErrorBox::generic("HTTP ingress is not configured for this Process"))?;
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

deno_core::extension!(http_endpoint_host, ops = [op_host_http_respond]);

pub fn init() -> deno_core::Extension {
    http_endpoint_host::init()
}

/// 启动时捕获 op 引用并冻结；Stable 包装在 `app/core/process/httpHandlers.ts`。
/// Captures the op at bootstrap and freezes it; the Stable wrapper lives in `app/core/process/httpHandlers.ts`.
pub const BOOTSTRAP_SOURCE: &str = r#"(() => {
const respondOp = globalThis.Deno.core.ops.op_host_http_respond;
Object.defineProperty(globalThis, "__hostHttp", {
  value: Object.freeze({
    respond: (requestId, status, headersJson, body) => respondOp(requestId, status, headersJson, body),
  }),
  writable: false,
  configurable: false,
});
})();"#;

/// 已启动的全部 Scene HTTP 监听；停机时先停止接收再让等待中的请求得到 503。
/// All started Scene HTTP listeners; shutdown stops accepting first, then answers waiting requests 503.
pub(crate) struct HttpEndpoints {
    shutdown: watch::Sender<bool>,
    tasks: Vec<JoinHandle<()>>,
    pending: HttpPendingRequests,
}

impl HttpEndpoints {
    /// 停止接收新请求、让已建立的连接在当前请求后关闭，并释放所有等待中的请求。
    /// Stops accepting, lets open connections close after their current request, and releases waiters.
    pub(crate) async fn stop(self) {
        let _ = self.shutdown.send(true);
        self.pending.clear();
        for task in self.tasks {
            let _ = task.await;
        }
    }
}

/// 所有 HTTP 端点共享的进程入口：事件队列、编号来源、回复表与就绪状态。
/// Process ingress shared by every HTTP endpoint: event queue, id source, reply table, and readiness.
#[derive(Clone)]
pub(crate) struct HttpIngress {
    pub(crate) event_tx: ProcessEventSender,
    /// 与连接号共用，保证请求号不与任何连接冲突。 / Shared with connection ids so request ids never collide.
    pub(crate) next_request_id: Arc<AtomicU64>,
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
    let (shutdown, _) = watch::channel(false);
    let mut tasks = Vec::new();
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
        });
        tasks.push(tokio::spawn(run_listener(
            listener,
            state,
            shutdown.subscribe(),
        )));
    }
    Ok(HttpEndpoints {
        shutdown,
        tasks,
        pending: ingress.pending.clone(),
    })
}

async fn run_listener(
    listener: TcpListener,
    state: Arc<EndpointState>,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() { break; }
            }
            accepted = listener.accept() => match accepted {
                Ok((stream, peer)) => {
                    tokio::spawn(serve_connection(stream, peer, Arc::clone(&state), shutdown.clone()));
                }
                Err(error) => {
                    // 文件句柄耗尽等错误是暂时的；短暂退避后继续，不让监听永久停止。
                    // Errors such as descriptor exhaustion are transient; back off briefly instead of
                    // stopping the listener for good.
                    tracing::warn!(target: "tiangz::http", scene = %state.scene_name, %error, "http accept failed");
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
        }
    }
}

async fn serve_connection(
    stream: TcpStream,
    peer: SocketAddr,
    state: Arc<EndpointState>,
    mut shutdown: watch::Receiver<bool>,
) {
    let service = service_fn(move |request| {
        let state = Arc::clone(&state);
        async move { Ok::<_, Infallible>(handle_request(request, peer, &state).await) }
    });
    let connection = http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(HEADER_READ_TIMEOUT)
        .serve_connection(TokioIo::new(stream), service);
    tokio::pin!(connection);
    let result = tokio::select! {
        result = connection.as_mut() => result,
        _ = shutdown.changed() => {
            connection.as_mut().graceful_shutdown();
            connection.await
        }
    };
    if let Err(error) = result {
        tracing::debug!(target: "tiangz::http", %peer, %error, "http connection closed with error");
    }
}

async fn handle_request(
    request: Request<Incoming>,
    peer: SocketAddr,
    state: &EndpointState,
) -> Response<Full<Bytes>> {
    let allowed_origin = allowed_origin(&state.config, request.headers());
    let mut response =
        if request.method() == Method::OPTIONS && !state.config.cors_allow_origins.is_empty() {
            preflight_response(request.headers(), allowed_origin.is_some())
        } else {
            dispatch_request(request, peer, state).await
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
    let body = match Limited::new(body, limit).collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(error) if error.is::<http_body_util::LengthLimitError>() => {
            return error_response(StatusCode::PAYLOAD_TOO_LARGE, "body too large");
        }
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "unreadable body"),
    };
    let payload = match encode_request(&parts, peer, &body, state.expected_authorization.is_some())
    {
        Ok(payload) => payload,
        Err(error) => {
            tracing::warn!(target: "tiangz::http", scene = %state.scene_name, %error, "failed to encode http request");
            return error_response(StatusCode::BAD_REQUEST, "bad request");
        }
    };
    forward_to_scene(state, payload, permit).await
}

/// 许可在回复或超时前一直持有，所以 `maxInFlight` 也限制了排队中的请求。
/// The permit is held until reply or timeout, so `maxInFlight` also bounds queued requests.
async fn forward_to_scene(
    state: &EndpointState,
    payload: Bytes,
    permit: OwnedSemaphorePermit,
) -> Response<Full<Bytes>> {
    let _permit = permit;
    let ingress = &state.ingress;
    let request_id = ingress.next_request_id.fetch_add(1, Ordering::Relaxed);
    if request_id > u32::MAX as u64 {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "request id space exhausted",
        );
    }
    let receiver = ingress.pending.register(request_id);
    let event = ProcessEvent::HttpRequest {
        scene_index: state.scene_index,
        request_id,
        payload,
    };
    let deadline = tokio::time::Instant::now() + ENQUEUE_DEADLINE;
    if let Err(error) = ingress.event_tx.send(event, Some(deadline)).await {
        ingress.pending.remove(request_id);
        tracing::debug!(target: "tiangz::http", scene = %state.scene_name, %error, "http request rejected by process queue");
        return error_response(StatusCode::SERVICE_UNAVAILABLE, "overloaded");
    }
    let timeout = Duration::from_millis(state.config.request_timeout_ms);
    match tokio::time::timeout(timeout, receiver).await {
        Ok(Ok(reply)) => reply_response(reply),
        Ok(Err(_)) => error_response(StatusCode::SERVICE_UNAVAILABLE, "stopping"),
        Err(_) => {
            ingress.pending.remove(request_id);
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
        let mut receiver = pending.register(7);
        let reply = || build_reply(200, "[]", b"").unwrap();
        assert!(pending.complete(7, reply()));
        assert!(!pending.complete(7, reply()));
        assert_eq!(receiver.try_recv().unwrap().status, StatusCode::OK);
        let receiver = pending.register(8);
        pending.clear();
        assert!(receiver.blocking_recv().is_err());
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
    fn test_ingress(
        first_request_id: u64,
    ) -> (HttpIngress, std::sync::mpsc::Receiver<ProcessEvent>) {
        let (event_tx, receiver) = test_process_event_channel(16);
        let health = Arc::new(ProcessHealthState::starting(Duration::from_secs(60)));
        health.mark_endpoints_ready();
        health.mark_runtime_ready();
        (
            HttpIngress {
                event_tx,
                next_request_id: Arc::new(AtomicU64::new(first_request_id)),
                pending: HttpPendingRequests::default(),
                health,
            },
            receiver,
        )
    }

    #[test]
    fn missing_token_variable_aborts_startup() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _guard = runtime.enter();
        let (ingress, _receiver) = test_ingress(1);
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

    fn decode_payload(payload: &[u8]) -> (serde_json::Value, Vec<u8>) {
        let meta_len = u32::from_le_bytes(payload[..4].try_into().unwrap()) as usize;
        let meta = serde_json::from_slice(&payload[4..4 + meta_len]).unwrap();
        (meta, payload[4 + meta_len..].to_vec())
    }

    #[tokio::test]
    async fn forwards_request_to_scene_and_returns_reply() {
        let port = free_port();
        let (ingress, receiver) = test_ingress(41);
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
        endpoints.stop().await;
    }

    #[tokio::test]
    async fn rejects_without_entering_scene() {
        let port = free_port();
        let (ingress, receiver) = test_ingress(1);
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
        endpoints.stop().await;
    }

    #[tokio::test]
    async fn strips_token_and_times_out_without_reply() {
        let port = free_port();
        let (ingress, receiver) = test_ingress(1);
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
        assert!(
            !pending.complete(request_id, build_reply(200, "[]", b"").unwrap()),
            "a late reply must be dropped"
        );
        endpoints.stop().await;
    }
}
