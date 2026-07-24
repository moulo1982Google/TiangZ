//! 提供独立于业务端点的进程存活与就绪探针。 / Provides process liveness and readiness probes independently from business endpoints.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use crate::config::HealthObservabilityConfig;

pub(crate) struct ProcessHealthState {
    live: AtomicBool,
    runtime_ready: AtomicBool,
    endpoints_ready: AtomicBool,
    stopping: AtomicBool,
}

impl ProcessHealthState {
    /// 创建启动中状态：宿主存活，但 TS Runtime 与业务端点尚未全部 ready。
    ///
    /// Creates the starting state: the host is live, while TS Runtime and business endpoints
    /// are not ready yet.
    pub(crate) fn starting() -> Self {
        Self {
            live: AtomicBool::new(true),
            runtime_ready: AtomicBool::new(false),
            endpoints_ready: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
        }
    }

    /// 标记全部 TS Scene 已完成启动屏障。 / Marks every TS Scene as having completed the startup barrier.
    pub(crate) fn mark_runtime_ready(&self) {
        self.runtime_ready.store(true, Ordering::Release);
    }

    /// 标记全部业务监听端点已绑定成功。 / Marks every business listener endpoint as successfully bound.
    pub(crate) fn mark_endpoints_ready(&self) {
        self.endpoints_ready.store(true, Ordering::Release);
    }

    /// 进入停机后立即撤销 ready，但在 V8 线程真正退出前仍保持 live。
    ///
    /// Withdraws readiness immediately when shutdown begins, while keeping liveness true until
    /// the V8 thread actually exits.
    pub(crate) fn mark_stopping(&self) {
        self.stopping.store(true, Ordering::Release);
    }

    /// 标记 V8 业务线程已经退出；此后存活与就绪探针都返回失败。
    ///
    /// Marks the V8 business thread as stopped. Both liveness and readiness fail afterwards.
    pub(crate) fn mark_runtime_stopped(&self) {
        self.live.store(false, Ordering::Release);
        self.runtime_ready.store(false, Ordering::Release);
    }

    fn is_live(&self) -> bool {
        self.live.load(Ordering::Acquire)
    }

    fn is_ready(&self) -> bool {
        self.is_live()
            && self.runtime_ready.load(Ordering::Acquire)
            && self.endpoints_ready.load(Ordering::Acquire)
            && !self.stopping.load(Ordering::Acquire)
    }
}

pub(crate) struct HealthServer {
    shutdown: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl HealthServer {
    /// 绑定健康检查端口并启动轻量 HTTP 循环；绑定失败会中止进程启动。
    ///
    /// Binds the health endpoint and starts a lightweight HTTP loop. Bind failure aborts process
    /// startup instead of silently disabling observability.
    pub(crate) async fn start(
        config: &HealthObservabilityConfig,
        process_name: String,
        state: Arc<ProcessHealthState>,
    ) -> Result<Self> {
        let address = format!("{}:{}", config.ip, config.port);
        let listener = TcpListener::bind(&address)
            .await
            .with_context(|| format!("failed to bind process health endpoint {address}"))?;
        let (shutdown, mut shutdown_rx) = watch::channel(false);
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    changed = shutdown_rx.changed() => {
                        if changed.is_err() || *shutdown_rx.borrow() { break; }
                    }
                    accepted = listener.accept() => {
                        match accepted {
                            Ok((stream, _)) => {
                                let state = Arc::clone(&state);
                                let process_name = process_name.clone();
                                tokio::spawn(async move {
                                    if let Err(error) = serve_connection(stream, &process_name, &state).await {
                                        tracing::debug!(target: "tiangz::health", %error, "health connection failed");
                                    }
                                });
                            }
                            Err(error) => {
                                tracing::error!(target: "tiangz::health", %error, "health listener failed");
                                break;
                            }
                        }
                    }
                }
            }
        });
        tracing::info!(target: "tiangz::health", %address, "process health endpoint listening");
        Ok(Self { shutdown, task })
    }

    /// 关闭监听并等待 accept 循环退出，不会终止已经进入写回阶段的短连接。
    ///
    /// Closes the listener and waits for the accept loop. Short connections already writing a
    /// response are not forcefully aborted.
    pub(crate) async fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = self.task.await;
    }
}

async fn serve_connection(
    mut stream: TcpStream,
    process_name: &str,
    state: &ProcessHealthState,
) -> Result<()> {
    let mut request = [0_u8; 1024];
    let length = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut request))
        .await
        .context("health request timed out")??;
    let path = std::str::from_utf8(&request[..length])
        .ok()
        .and_then(|text| text.lines().next())
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("");
    let (status, body) = probe_response(path, process_name, state);
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len(),
    );
    stream.write_all(response.as_bytes()).await?;
    stream.shutdown().await?;
    Ok(())
}

fn probe_response(
    path: &str,
    process_name: &str,
    state: &ProcessHealthState,
) -> (&'static str, String) {
    match path {
        "/live" if state.is_live() => (
            "200 OK",
            json!({ "status": "live", "process": process_name }).to_string(),
        ),
        "/live" => (
            "503 Service Unavailable",
            json!({ "status": "stopped", "process": process_name }).to_string(),
        ),
        "/ready" if state.is_ready() => (
            "200 OK",
            json!({ "status": "ready", "process": process_name }).to_string(),
        ),
        "/ready" => (
            "503 Service Unavailable",
            json!({ "status": "not-ready", "process": process_name }).to_string(),
        ),
        _ => (
            "404 Not Found",
            json!({ "status": "not-found", "process": process_name }).to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_requires_runtime_endpoints_and_non_stopping_state() {
        let state = ProcessHealthState::starting();
        assert!(probe_response("/live", "test", &state).0.starts_with("200"));
        assert!(
            probe_response("/ready", "test", &state)
                .0
                .starts_with("503")
        );
        state.mark_runtime_ready();
        state.mark_endpoints_ready();
        assert!(
            probe_response("/ready", "test", &state)
                .0
                .starts_with("200")
        );
        state.mark_stopping();
        assert!(
            probe_response("/ready", "test", &state)
                .0
                .starts_with("503")
        );
        assert!(probe_response("/live", "test", &state).0.starts_with("200"));
        state.mark_runtime_stopped();
        assert!(probe_response("/live", "test", &state).0.starts_with("503"));
    }
}
