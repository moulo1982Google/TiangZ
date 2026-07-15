use std::cell::RefCell;
use std::collections::VecDeque;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use bytes::Bytes;
use deno_core::convert::Uint8Array;
use deno_core::error::AnyError;
use deno_core::{JsBuffer, JsRuntime, PollEventLoopOptions, RuntimeOptions, op2};
use deno_error::JsErrorBox;
use serde::Deserialize;

use crate::transport::{call_remote_scene, send_remote_scene};

const HOST_CALL_MAX_FRAME_LEN: usize = 1024 * 1024;
const HOST_OUTBOUND_MAX_TARGETS: usize = 4096;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostCallRequest {
    source: HostCallScene,
    target: HostCallScene,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostCallScene {
    name: String,
    ip: String,
    port: u16,
}

thread_local! {
    static LAST_JS_RESULT: RefCell<Option<String>> = const { RefCell::new(None) };
    static NEXT_EVENT_META: RefCell<Option<Vec<u8>>> = const { RefCell::new(None) };
    static NEXT_BINARY_ARGS: RefCell<VecDeque<Vec<u8>>> = const { RefCell::new(VecDeque::new()) };
    static OUTBOUND_BINARY_BATCHES: RefCell<Vec<BinaryOutboundBatch>> = const { RefCell::new(Vec::new()) };
}

#[derive(Debug)]
pub struct BinaryOutboundBatch {
    pub connection_ids: Vec<u64>,
    pub frame: Bytes,
}

#[op2(nofast)]
fn op_host_log(#[string] message: String) {
    println!("{message}");
}

#[op2]
async fn op_host_sleep(ms: u32) {
    tokio::time::sleep(Duration::from_millis(ms as u64)).await;
}

#[op2(nofast)]
fn op_host_set_result(#[string] result: String) {
    LAST_JS_RESULT.with(|slot| {
        *slot.borrow_mut() = Some(result);
    });
}

#[op2]
fn op_host_take_binary_arg() -> Uint8Array {
    let bytes = NEXT_BINARY_ARGS.with(|slot| slot.borrow_mut().pop_front().unwrap_or_default());
    bytes.into()
}

#[op2]
fn op_host_take_event_meta() -> Uint8Array {
    let bytes = NEXT_EVENT_META.with(|slot| slot.borrow_mut().take().unwrap_or_default());
    bytes.into()
}

#[op2]
fn op_host_push_outbound(connection_id: u32, #[buffer] frame: JsBuffer) -> Result<(), JsErrorBox> {
    push_outbound_batch(vec![connection_id as u64], frame)
}

#[op2]
fn op_host_push_outbound_batch(
    #[buffer] connection_id_bytes: JsBuffer,
    #[buffer] frame: JsBuffer,
) -> Result<(), JsErrorBox> {
    let connection_ids = decode_connection_ids(&connection_id_bytes)
        .map_err(|error| JsErrorBox::generic(error.to_string()))?;
    push_outbound_batch(connection_ids, frame)
}

fn push_outbound_batch(connection_ids: Vec<u64>, frame: JsBuffer) -> Result<(), JsErrorBox> {
    if connection_ids.is_empty() {
        return Err(JsErrorBox::generic("outbound batch has no targets"));
    }
    if connection_ids.len() > HOST_OUTBOUND_MAX_TARGETS {
        return Err(JsErrorBox::generic(format!(
            "outbound batch has too many targets: {}",
            connection_ids.len()
        )));
    }
    if !(2..=HOST_CALL_MAX_FRAME_LEN).contains(&frame.len()) {
        return Err(JsErrorBox::generic(format!(
            "invalid outbound frame length: {}",
            frame.len()
        )));
    }

    OUTBOUND_BINARY_BATCHES.with(|slot| {
        slot.borrow_mut().push(BinaryOutboundBatch {
            connection_ids,
            frame: Bytes::from(frame.to_vec()),
        });
    });
    Ok(())
}

fn decode_connection_ids(bytes: &[u8]) -> Result<Vec<u64>> {
    if bytes.is_empty() || bytes.len() % 4 != 0 {
        bail!("connection id buffer must contain uint32 little-endian values");
    }
    let count = bytes.len() / 4;
    if count > HOST_OUTBOUND_MAX_TARGETS {
        bail!("outbound batch has too many targets: {count}");
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|chunk| u32::from_le_bytes(chunk.try_into().unwrap()) as u64)
        .collect())
}

#[op2]
async fn op_host_scene_call(
    #[string] target_json: String,
    #[buffer] frame: JsBuffer,
    timeout_ms: u32,
) -> Result<Uint8Array, JsErrorBox> {
    let timeout_ms = timeout_ms.max(1);
    let call = async move {
        let request: HostCallRequest = serde_json::from_str(&target_json)
            .with_context(|| format!("invalid scene call request: {target_json}"))?;
        let frame = frame.to_vec();
        if frame.len() < 2 || frame.len() > HOST_CALL_MAX_FRAME_LEN {
            bail!("invalid scene call frame length: {}", frame.len());
        }

        if is_same_scene(&request.source, &request.target) {
            bail!(
                "scene {} cannot synchronously call itself",
                request.source.name
            );
        }

        let timeout = Duration::from_millis(timeout_ms as u64);
        call_remote_scene(
            request.source.name,
            request.target.name,
            request.target.ip,
            request.target.port,
            frame,
            timeout,
        )
        .await
        .map(Uint8Array::from)
        .map_err(anyhow::Error::msg)
    };

    match tokio::time::timeout(Duration::from_millis(timeout_ms as u64), call).await {
        Ok(result) => result.map_err(|error| JsErrorBox::generic(format!("{error:#}"))),
        Err(_) => Err(JsErrorBox::generic(format!(
            "scene call timed out after {timeout_ms}ms"
        ))),
    }
}

#[op2]
async fn op_host_scene_send(
    #[string] target_json: String,
    #[buffer] frame: JsBuffer,
    timeout_ms: u32,
) -> Result<(), JsErrorBox> {
    let timeout_ms = timeout_ms.max(1);
    let send = async move {
        let request: HostCallRequest = serde_json::from_str(&target_json)
            .with_context(|| format!("invalid scene send request: {target_json}"))?;
        let frame = frame.to_vec();
        if frame.len() < 2 || frame.len() > HOST_CALL_MAX_FRAME_LEN {
            bail!("invalid scene send frame length: {}", frame.len());
        }

        if is_same_scene(&request.source, &request.target) {
            bail!("scene {} cannot send to itself", request.source.name);
        }

        let timeout = Duration::from_millis(timeout_ms as u64);
        send_remote_scene(
            request.source.name,
            request.target.name,
            request.target.ip,
            request.target.port,
            frame,
            timeout,
        )
        .await
        .map_err(anyhow::Error::msg)
    };

    match tokio::time::timeout(Duration::from_millis(timeout_ms as u64), send).await {
        Ok(result) => result.map_err(|error| JsErrorBox::generic(format!("{error:#}"))),
        Err(_) => Err(JsErrorBox::generic(format!(
            "scene send timed out after {timeout_ms}ms"
        ))),
    }
}

fn is_same_scene(source: &HostCallScene, target: &HostCallScene) -> bool {
    source.name == target.name || (source.ip == target.ip && source.port == target.port)
}

deno_core::extension!(
    ets_runtime_host,
    ops = [
        op_host_log,
        op_host_sleep,
        op_host_set_result,
        op_host_take_event_meta,
        op_host_take_binary_arg,
        op_host_push_outbound,
        op_host_push_outbound_batch,
        op_host_scene_call,
        op_host_scene_send
    ],
);

pub fn create_runtime(inspector: bool) -> Result<JsRuntime, AnyError> {
    let mut runtime = JsRuntime::new(RuntimeOptions {
        extensions: vec![ets_runtime_host::init()],
        inspector,
        ..Default::default()
    });

    runtime.execute_script(
        "ets-runtime:bootstrap.js",
        r#"
        const core = globalThis.Deno.core;
        globalThis.__hostLog = (message) => core.ops.op_host_log(String(message));
        globalThis.__hostSleep = (ms) => core.ops.op_host_sleep(ms);
        globalThis.__hostSetResult = (result) => core.ops.op_host_set_result(String(result));
        globalThis.__hostTakeEventMeta = () => core.ops.op_host_take_event_meta();
        globalThis.__hostTakeBinaryArg = () => core.ops.op_host_take_binary_arg();
        globalThis.__hostPushOutbound = (connectionId, frame) =>
          core.ops.op_host_push_outbound(connectionId >>> 0, frame);
        globalThis.__hostPushOutboundBatch = (connectionIdBytes, frame) =>
          core.ops.op_host_push_outbound_batch(connectionIdBytes, frame);
        globalThis.__hostSceneCall = (targetJson, frame, timeoutMs) =>
          core.ops.op_host_scene_call(String(targetJson), frame, timeoutMs >>> 0);
        globalThis.__hostSceneSend = (targetJson, frame, timeoutMs) =>
          core.ops.op_host_scene_send(String(targetJson), frame, timeoutMs >>> 0);
        globalThis.console = {
          log: (...args) => __hostLog(args.map((value) => {
            if (typeof value === "string") return value;
            try { return JSON.stringify(value); } catch (_) { return String(value); }
          }).join(" ")),
          error: (...args) => __hostLog("[error] " + args.map(String).join(" ")),
        };
        "#,
    )?;

    Ok(runtime)
}

pub fn call_js_string(
    js_event_loop: &tokio::runtime::Runtime,
    runtime: &mut JsRuntime,
    function_name: &str,
    json_arg: &str,
) -> Result<String> {
    let function_name = serde_json::to_string(function_name)?;
    let json_arg = serde_json::to_string(json_arg)?;
    LAST_JS_RESULT.with(|slot| {
        *slot.borrow_mut() = None;
    });
    let source = format!(
        "Promise.resolve(globalThis[{function_name}]({json_arg})).then((result) => globalThis.__hostSetResult(result))"
    );
    {
        let _guard = js_event_loop.enter();
        runtime
            .execute_script("ets-runtime:host-call.js", source)
            .context("failed to call JS")?;
    }
    js_event_loop
        .block_on(runtime.run_event_loop(PollEventLoopOptions::default()))
        .context("failed to run JS event loop after host call")?;
    LAST_JS_RESULT
        .with(|slot| slot.borrow_mut().take())
        .context("JS did not set a result")
}

pub fn push_binary_args(args: Vec<Vec<u8>>) {
    NEXT_BINARY_ARGS.with(|slot| {
        *slot.borrow_mut() = args.into();
    });
}

pub fn call_js_push_host_events(
    runtime: &mut JsRuntime,
    event_meta: Vec<u8>,
    binary_args: Vec<Vec<u8>>,
) -> Result<()> {
    NEXT_EVENT_META.with(|slot| {
        *slot.borrow_mut() = Some(event_meta);
    });
    push_binary_args(binary_args);
    runtime
        .execute_script(
            "ets-runtime:push-host-events.js",
            "globalThis.__etsPushHostEventsBinary(globalThis.__hostTakeEventMeta())",
        )
        .context("failed to push host events to JS")?;
    Ok(())
}

pub fn call_js_update_binary(
    js_event_loop: &tokio::runtime::Runtime,
    runtime: &mut JsRuntime,
) -> Result<(String, Vec<BinaryOutboundBatch>)> {
    OUTBOUND_BINARY_BATCHES.with(|slot| slot.borrow_mut().clear());
    let metrics_json = call_js_string(js_event_loop, runtime, "__etsUpdateBinary", "{}")?;
    let outbound = OUTBOUND_BINARY_BATCHES.with(|slot| slot.borrow_mut().drain(..).collect());
    Ok((metrics_json, outbound))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_little_endian_connection_ids() {
        let bytes = [1, 0, 0, 0, 0x78, 0x56, 0x34, 0x12];
        assert_eq!(decode_connection_ids(&bytes).unwrap(), vec![1, 0x1234_5678]);
    }

    #[test]
    fn rejects_invalid_connection_id_buffer() {
        assert!(decode_connection_ids(&[]).is_err());
        assert!(decode_connection_ids(&[1, 2, 3]).is_err());
    }
}
