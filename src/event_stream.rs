//! 部署固定的Redis消费组I/O；不解释游戏事件、不自动ACK。 / Deployment-owned Redis group I/O; no domain interpretation or automatic ACK.
use crate::config::{ProcessConfig, ProcessEventStreamConfig};
use anyhow::{Result, anyhow, bail};
use deno_core::op2;
use deno_error::JsErrorBox;
use redis::{
    aio::MultiplexedConnection,
    streams::{StreamAutoClaimReply, StreamId, StreamReadReply},
};
use serde::Serialize;
use std::{cell::RefCell, sync::Arc, time::Duration};
use tokio::{runtime::Handle, sync::Mutex};

thread_local! { static BRIDGE: RefCell<Option<Bridge>> = const { RefCell::new(None) }; }
#[derive(Clone)]
struct Bridge {
    client: redis::Client,
    config: ProcessEventStreamConfig,
    state: Arc<Mutex<State>>,
    runtime: Handle,
}
struct State {
    connection: Option<MultiplexedConnection>,
    cursor: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Delivery {
    stream_id: String,
    event: String,
}

/// 在启动前验证目标与环境变量；凭据不进入V8或错误文本。 / Validates destination and environment before startup; credentials never enter V8 or errors.
pub fn configure(process: &ProcessConfig, runtime: Handle) -> Result<()> {
    BRIDGE.with(|slot| *slot.borrow_mut() = None);
    let Some(config) = &process.persistence.event_stream else {
        return Ok(());
    };
    validate(config)?;
    let url = std::env::var(&config.redis_url_env)
        .map_err(|_| anyhow!("eventStream Redis environment variable missing"))?;
    let client = redis::Client::open(url).map_err(|_| anyhow!("invalid eventStream Redis URL"))?;
    BRIDGE.with(|slot| {
        *slot.borrow_mut() = Some(Bridge {
            client,
            config: config.clone(),
            runtime,
            state: Arc::new(Mutex::new(State {
                connection: None,
                cursor: "0-0".into(),
            })),
        })
    });
    Ok(())
}
/// 限定部署名称和回收窗口，拒绝无界或拼写错误的配置。 / Bounds deployment names and recovery windows.
pub fn validate(config: &ProcessEventStreamConfig) -> Result<()> {
    for text in [
        &config.redis_url_env,
        &config.stream,
        &config.group,
        &config.consumer,
    ] {
        if text.is_empty()
            || text.len() > 128
            || !text
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_:.-".contains(&c))
        {
            bail!("invalid eventStream name");
        }
    }
    if !(1000..=600_000).contains(&config.claim_idle_ms) {
        bail!("eventStream.claimIdleMs must be 1000..600000");
    }
    Ok(())
}
fn bridge() -> Result<Bridge, JsErrorBox> {
    BRIDGE
        .with(|s| s.borrow().clone())
        .ok_or_else(|| JsErrorBox::generic("eventStream is not configured"))
}
impl Bridge {
    async fn execute(&self, ack: Option<String>) -> Result<Vec<Delivery>, JsErrorBox> {
        let owned = self.clone();
        self.runtime
            .spawn(async move {
                let mut state = owned
                    .state
                    .try_lock()
                    .map_err(|_| JsErrorBox::generic("eventStream operation already in flight"))?;
                let operation = async {
                    if state.connection.is_none() {
                        let mut connection =
                            owned.client.get_multiplexed_async_connection().await?;
                        let create: redis::RedisResult<()> = redis::cmd("XGROUP")
                            .arg("CREATE")
                            .arg(&owned.config.stream)
                            .arg(&owned.config.group)
                            .arg("0")
                            .arg("MKSTREAM")
                            .query_async(&mut connection)
                            .await;
                        if let Err(e) = create
                            && e.code() != Some("BUSYGROUP")
                        {
                            return Err(e);
                        }
                        state.connection = Some(connection);
                    }
                    let cursor = state.cursor.clone();
                    let connection = state.connection.as_mut().unwrap();
                    if let Some(id) = ack {
                        let _: i64 = redis::cmd("XACK")
                            .arg(&owned.config.stream)
                            .arg(&owned.config.group)
                            .arg(id)
                            .query_async(connection)
                            .await?;
                        return Ok(Vec::new());
                    }
                    let reclaimed: StreamAutoClaimReply = redis::cmd("XAUTOCLAIM")
                        .arg(&owned.config.stream)
                        .arg(&owned.config.group)
                        .arg(&owned.config.consumer)
                        .arg(owned.config.claim_idle_ms)
                        .arg(cursor)
                        .arg("COUNT")
                        .arg(8)
                        .query_async(connection)
                        .await?;
                    let mut rows = reclaimed.claimed;
                    if !reclaimed.deleted_ids.is_empty() {
                        tracing::error!(
                            count = reclaimed.deleted_ids.len(),
                            "eventStream pending entries were deleted; operator recovery required"
                        );
                    }
                    // 为新消息保留配额，毒消息或 ACK 故障不能饿死后续投递。
                    // Reserve capacity for new entries so poison messages or failed ACKs cannot starve them.
                    let room = 16usize.saturating_sub(rows.len());
                    if room > 0 {
                        let read: StreamReadReply = redis::cmd("XREADGROUP")
                            .arg("GROUP")
                            .arg(&owned.config.group)
                            .arg(&owned.config.consumer)
                            .arg("COUNT")
                            .arg(room)
                            .arg("STREAMS")
                            .arg(&owned.config.stream)
                            .arg(">")
                            .query_async(connection)
                            .await?;
                        rows.extend(read.keys.into_iter().flat_map(|key| key.ids));
                    }
                    state.cursor = reclaimed.next_stream_id;
                    rows.into_iter()
                        .map(delivery)
                        .collect::<redis::RedisResult<Vec<_>>>()
                };
                match tokio::time::timeout(Duration::from_secs(3), operation).await {
                    Ok(Ok(rows)) => Ok(rows),
                    _ => {
                        state.connection = None;
                        Err(JsErrorBox::generic(
                            "eventStream I/O failed; deliveries remain pending",
                        ))
                    }
                }
            })
            .await
            .map_err(|_| JsErrorBox::generic("eventStream worker stopped"))?
    }
}
fn delivery(row: StreamId) -> redis::RedisResult<Delivery> {
    let event: String = row.get("event").unwrap_or_default();
    Ok(Delivery {
        stream_id: row.id,
        event,
    })
}
#[op2(fast)]
fn op_host_stream_configured() -> bool {
    BRIDGE.with(|s| s.borrow().is_some())
}
#[op2]
#[serde]
async fn op_host_stream_poll() -> Result<Vec<Delivery>, JsErrorBox> {
    bridge()?.execute(None).await
}
#[op2]
async fn op_host_stream_ack(#[string] id: String) -> Result<(), JsErrorBox> {
    if !valid_stream_id(&id) {
        return Err(JsErrorBox::generic("invalid stream delivery ID"));
    }
    bridge()?.execute(Some(id)).await?;
    Ok(())
}
fn valid_stream_id(id: &str) -> bool {
    id.len() <= 41
        && id.split_once('-').is_some_and(|(time, sequence)| {
            !time.is_empty()
                && !sequence.is_empty()
                && time
                    .bytes()
                    .chain(sequence.bytes())
                    .all(|c| c.is_ascii_digit())
                && time.parse::<u64>().is_ok()
                && sequence.parse::<u64>().is_ok()
        })
}
deno_core::extension!(
    event_stream_host,
    ops = [
        op_host_stream_configured,
        op_host_stream_poll,
        op_host_stream_ack
    ]
);
pub fn init() -> deno_core::Extension {
    event_stream_host::init()
}
pub const BOOTSTRAP_SOURCE: &str = r#"(() => {
const ops = globalThis.Deno.core.ops;
globalThis.__hostEventStream = Object.freeze({ configured: () => ops.op_host_stream_configured(), poll: () => ops.op_host_stream_poll(), ack: id => ops.op_host_stream_ack(id) });
})();"#;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn acknowledgements_require_exact_redis_ids() {
        assert!(valid_stream_id("123-0"));
        for id in ["", "-", "1-", "1-2-3", "1-*", "18446744073709551616-0"] {
            assert!(!valid_stream_id(id));
        }
    }
    #[test]
    fn rejects_unbounded_or_unsafe_destinations() {
        let mut c = ProcessEventStreamConfig {
            redis_url_env: "TEST_REDIS".into(),
            stream: "test.events".into(),
            group: "test".into(),
            consumer: "one".into(),
            claim_idle_ms: 5000,
        };
        assert!(validate(&c).is_ok());
        c.claim_idle_ms = 0;
        assert!(validate(&c).is_err());
        c.claim_idle_ms = 5000;
        c.stream = "bad\nstream".into();
        assert!(validate(&c).is_err());
    }
}
