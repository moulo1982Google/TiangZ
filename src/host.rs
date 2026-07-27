//! 实现 Rust 所有权与 I/O 到单 V8 业务线程之间的窄二进制桥。 / Implements the narrow binary bridge between Rust ownership/I/O and the single V8 business thread.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;
use std::task::Poll;
use std::time::Duration;

use crate::transport::{call_remote_scene, send_remote_scene};
use anyhow::{Context, Result, bail};
use bytes::Bytes;
use deno_core::convert::Uint8Array;
use deno_core::error::AnyError;
use deno_core::{
    FsModuleLoader, JsBuffer, JsRuntime, ModuleSpecifier, PollEventLoopOptions, RuntimeOptions,
    op2, v8,
};
use deno_error::JsErrorBox;
use futures_util::{StreamExt, future::poll_fn, stream};
use tokio::runtime::Handle;

const HOST_CALL_MAX_FRAME_LEN: usize = 1024 * 1024;
const HOST_OUTBOUND_MAX_TARGETS: usize = 4096;
const HOST_OUTBOUND_MAX_BATCHES: usize = 65_536;
const HOST_OUTBOUND_MAX_PACKED_LEN: usize = 64 * 1024 * 1024;
const HOST_SCENE_MAX_ROUTES: usize = 4096;
const HOST_SCENE_MAX_OPERATIONS: usize = 65_536;
const HOST_SCENE_OPERATION_META_BYTES: usize = 17;
const HOST_SCENE_MAX_IN_FLIGHT: usize = 256;
const BACKPRESSURE_RETRY_MS: u64 = 1;

thread_local! {
    static NEXT_HOST_EVENT_BATCH: RefCell<Option<Vec<u8>>> = const { RefCell::new(None) };
    static OUTBOUND_BINARY_BATCHES: RefCell<Vec<BinaryOutboundBatch>> = const { RefCell::new(Vec::new()) };
    static CLOSE_CONNECTION_REQUESTS: RefCell<Vec<u64>> = const { RefCell::new(Vec::new()) };
    static HOST_SCENE_ROUTES: RefCell<Vec<HostSceneRoute>> = const { RefCell::new(Vec::new()) };
    static HOST_SCENE_RUNTIME: RefCell<Option<Handle>> = const { RefCell::new(None) };
    static HOST_SCENE_COMPLETION_SINK: RefCell<Option<HostSceneCompletionSink>> = const { RefCell::new(None) };
}

#[derive(Debug)]
pub struct BinaryOutboundBatch {
    pub connection_ids: Vec<u64>,
    pub frame: Bytes,
}

#[derive(Debug)]
pub struct HostSceneCompletion {
    pub operation_id: u32,
    pub result: std::result::Result<Vec<u8>, String>,
}

pub type HostSceneCompletionSink =
    Arc<dyn Fn(HostSceneCompletion) -> std::result::Result<(), HostSceneCompletion> + Send + Sync>;

pub struct JsEntrypoints {
    start_process: v8::Global<v8::Function>,
    stop_process: v8::Global<v8::Function>,
    update: v8::Global<v8::Function>,
    dispatch_host_events: v8::Global<v8::Function>,
    begin_hotfix: v8::Global<v8::Function>,
    commit_hotfix: v8::Global<v8::Function>,
    abort_hotfix: v8::Global<v8::Function>,
}

#[derive(Clone, Debug)]
struct HostSceneRoute {
    source_name: String,
    target_name: String,
    target_ip: String,
    target_port: u16,
}

#[derive(Debug)]
struct HostSceneOperation {
    operation_id: u32,
    route: Option<HostSceneRoute>,
    kind: u8,
    timeout_ms: u32,
    frame: Bytes,
}

/// 安装 V8 host op 使用的 Tokio Handle 与完成事件接收端。
///
/// 这是单个运行时的进程级状态，必须在任何 TS Scene call/send op 执行前配置。
/// 进程运行期间不支持重新配置，否则完成事件可能被路由到错误队列。
///
/// Installs the Tokio handle and completion sink used by V8 host ops.
///
/// This is process-global state for one runtime and must be configured before
/// any TS Scene call/send op executes. Reconfiguration while a process is live
/// would route completions to the wrong queue and is unsupported.
pub fn configure_host_scene_bridge(runtime: Handle, completion_sink: HostSceneCompletionSink) {
    HOST_SCENE_ROUTES.with(|slot| slot.borrow_mut().clear());
    HOST_SCENE_RUNTIME.with(|slot| *slot.borrow_mut() = Some(runtime));
    HOST_SCENE_COMPLETION_SINK.with(|slot| *slot.borrow_mut() = Some(completion_sink));
}

#[op2(nofast)]
fn op_host_log(
    level: u32,
    #[string] source_target: String,
    #[string] category: String,
    #[string] message: String,
    #[string] attributes: String,
) {
    macro_rules! emit {
        ($macro:ident) => {
            tracing::$macro!(
                target: "tiangz::typescript",
                process = crate::logging::process_name(),
                source_target = %source_target,
                category = %category,
                attributes = %attributes,
                "{message}"
            )
        };
    }
    match level {
        0 => emit!(trace),
        1 => emit!(debug),
        2 => emit!(info),
        3 => emit!(warn),
        _ => emit!(error),
    }
}

#[op2]
async fn op_host_sleep(ms: u32) {
    tokio::time::sleep(Duration::from_millis(ms as u64)).await;
}

#[op2]
fn op_host_take_event_batch() -> Uint8Array {
    let bytes = NEXT_HOST_EVENT_BATCH.with(|slot| slot.borrow_mut().take().unwrap_or_default());
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

#[op2]
fn op_host_push_outbound_packed(#[buffer] packed: JsBuffer) -> Result<(), JsErrorBox> {
    let batches = decode_packed_outbound(Bytes::from(packed.to_vec()))
        .map_err(|error| JsErrorBox::generic(error.to_string()))?;
    OUTBOUND_BINARY_BATCHES.with(|slot| slot.borrow_mut().extend(batches));
    Ok(())
}

#[op2(fast)]
fn op_host_close_connection(connection_id: u32) -> Result<(), JsErrorBox> {
    if connection_id == 0 {
        return Err(JsErrorBox::generic(
            "connection id must be greater than zero",
        ));
    }
    CLOSE_CONNECTION_REQUESTS.with(|slot| slot.borrow_mut().push(connection_id as u64));
    Ok(())
}

/// 消费 TS 在本次宿主 Update 中发出的连接关闭请求。 / Drains connection-close requests emitted by TS during the current host update.
pub fn take_close_connection_requests() -> Vec<u64> {
    CLOSE_CONNECTION_REQUESTS.with(|slot| std::mem::take(&mut *slot.borrow_mut()))
}

#[op2(nofast)]
fn op_host_register_scene_route(
    #[string] source_name: String,
    #[string] target_name: String,
    #[string] target_ip: String,
    target_port: u16,
) -> Result<u32, JsErrorBox> {
    if source_name.is_empty() || target_name.is_empty() || target_ip.is_empty() || target_port == 0
    {
        return Err(JsErrorBox::generic("invalid host scene route"));
    }
    if source_name == target_name {
        return Err(JsErrorBox::generic(format!(
            "scene {source_name} cannot synchronously call itself"
        )));
    }
    HOST_SCENE_ROUTES.with(|slot| {
        let mut routes = slot.borrow_mut();
        if routes.len() >= HOST_SCENE_MAX_ROUTES {
            return Err(JsErrorBox::generic("host scene route limit reached"));
        }
        routes.push(HostSceneRoute {
            source_name,
            target_name,
            target_ip,
            target_port,
        });
        Ok(routes.len() as u32)
    })
}

#[op2]
fn op_host_submit_scene_operations(#[buffer] packed: JsBuffer) -> Result<u32, JsErrorBox> {
    let operations = decode_packed_scene_operations(Bytes::from(packed.to_vec()))
        .map_err(|error| JsErrorBox::generic(error.to_string()))?;
    let operation_count = operations.len() as u32;
    let runtime = HOST_SCENE_RUNTIME
        .with(|slot| slot.borrow().clone())
        .ok_or_else(|| JsErrorBox::generic("host scene runtime is not configured"))?;
    let completion_sink = HOST_SCENE_COMPLETION_SINK
        .with(|slot| slot.borrow().clone())
        .ok_or_else(|| JsErrorBox::generic("host scene completion sink is not configured"))?;

    runtime.spawn(async move {
        let mut pending = stream::iter(operations)
            .map(|operation| async move {
                let timeout = Duration::from_millis(operation.timeout_ms.max(1) as u64);
                match (operation.kind, operation.route) {
                    (1, Some(route)) => Some(HostSceneCompletion {
                        operation_id: operation.operation_id,
                        result: call_remote_scene(
                            route.source_name,
                            route.target_name,
                            route.target_ip,
                            route.target_port,
                            operation.frame,
                            timeout,
                        )
                        .await,
                    }),
                    (2, Some(route)) => {
                        let source_name = route.source_name.clone();
                        let target_name = route.target_name.clone();
                        if let Err(error) = send_remote_scene(
                            route.source_name,
                            route.target_name,
                            route.target_ip,
                            route.target_port,
                            operation.frame,
                            timeout,
                        )
                        .await
                        {
                            tracing::error!(
                                target: "tiangz::scene",
                                source = %source_name,
                                target_scene = %target_name,
                                error = %error,
                                "one-way scene send failed"
                            );
                        }
                        None
                    }
                    (3, None) => {
                        tokio::time::sleep(Duration::from_millis(operation.timeout_ms as u64))
                            .await;
                        Some(HostSceneCompletion {
                            operation_id: operation.operation_id,
                            result: Ok(Vec::new()),
                        })
                    }
                    _ => Some(HostSceneCompletion {
                        operation_id: operation.operation_id,
                        result: Err("invalid host scene operation route".to_string()),
                    }),
                }
            })
            .buffer_unordered(HOST_SCENE_MAX_IN_FLIGHT);
        while let Some(completion) = pending.next().await {
            let Some(mut completion) = completion else {
                continue;
            };
            loop {
                match completion_sink(completion) {
                    Ok(()) => break,
                    Err(returned) => {
                        completion = returned;
                        tokio::time::sleep(Duration::from_millis(BACKPRESSURE_RETRY_MS)).await;
                    }
                }
            }
        }
    });
    Ok(operation_count)
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
    if bytes.is_empty() || !bytes.len().is_multiple_of(4) {
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

fn decode_packed_outbound(packet: Bytes) -> Result<Vec<BinaryOutboundBatch>> {
    if !(4..=HOST_OUTBOUND_MAX_PACKED_LEN).contains(&packet.len()) {
        bail!("invalid packed outbound length: {}", packet.len());
    }

    let mut offset = 0;
    let batch_count = read_packed_u32(&packet, &mut offset)? as usize;
    if batch_count == 0 || batch_count > HOST_OUTBOUND_MAX_BATCHES {
        bail!("invalid packed outbound batch count: {batch_count}");
    }

    let mut batches = Vec::with_capacity(batch_count);
    for _ in 0..batch_count {
        let target_count = read_packed_u32(&packet, &mut offset)? as usize;
        if target_count == 0 || target_count > HOST_OUTBOUND_MAX_TARGETS {
            bail!("invalid packed outbound target count: {target_count}");
        }
        let target_bytes = target_count
            .checked_mul(4)
            .context("packed outbound target byte count overflow")?;
        let target_end = offset
            .checked_add(target_bytes)
            .filter(|end| *end <= packet.len())
            .context("truncated packed outbound connection ids")?;
        let connection_ids = packet[offset..target_end]
            .chunks_exact(4)
            .map(|chunk| u32::from_le_bytes(chunk.try_into().unwrap()) as u64)
            .collect();
        offset = target_end;

        let frame_len = read_packed_u32(&packet, &mut offset)? as usize;
        if !(2..=HOST_CALL_MAX_FRAME_LEN).contains(&frame_len) {
            bail!("invalid packed outbound frame length: {frame_len}");
        }
        let frame_end = offset
            .checked_add(frame_len)
            .filter(|end| *end <= packet.len())
            .context("truncated packed outbound frame")?;
        let frame = packet.slice(offset..frame_end);
        offset = frame_end;
        batches.push(BinaryOutboundBatch {
            connection_ids,
            frame,
        });
    }

    if offset != packet.len() {
        bail!(
            "packed outbound has {} trailing bytes",
            packet.len() - offset
        );
    }
    Ok(batches)
}

fn read_packed_u32(packet: &[u8], offset: &mut usize) -> Result<u32> {
    let end = offset
        .checked_add(4)
        .filter(|end| *end <= packet.len())
        .context("truncated packed outbound uint32")?;
    let value = u32::from_le_bytes(packet[*offset..end].try_into().unwrap());
    *offset = end;
    Ok(value)
}

fn decode_packed_scene_operations(packet: Bytes) -> Result<Vec<HostSceneOperation>> {
    if !(4..=HOST_OUTBOUND_MAX_PACKED_LEN).contains(&packet.len()) {
        bail!("invalid packed scene operation length: {}", packet.len());
    }
    let mut offset = 0;
    let operation_count = read_packed_u32(&packet, &mut offset)? as usize;
    if operation_count == 0 || operation_count > HOST_SCENE_MAX_OPERATIONS {
        bail!("invalid host scene operation count: {operation_count}");
    }
    let routes = HOST_SCENE_ROUTES.with(|slot| slot.borrow().clone());
    let mut operations = Vec::with_capacity(operation_count);
    for _ in 0..operation_count {
        if packet.len().saturating_sub(offset) < HOST_SCENE_OPERATION_META_BYTES {
            bail!("truncated host scene operation metadata");
        }
        let operation_id = read_packed_u32(&packet, &mut offset)?;
        let route_id = read_packed_u32(&packet, &mut offset)? as usize;
        let kind = packet[offset];
        offset += 1;
        let timeout_ms = read_packed_u32(&packet, &mut offset)?;
        let frame_len = read_packed_u32(&packet, &mut offset)? as usize;
        if !(1..=3).contains(&kind) || (operation_id == 0 && kind != 2) {
            bail!("invalid host scene operation id or kind");
        }
        let route = if kind == 3 {
            if route_id != 0 || frame_len != 0 {
                bail!("host sleep operation cannot contain route or frame");
            }
            None
        } else {
            Some(
                route_id
                    .checked_sub(1)
                    .and_then(|index| routes.get(index))
                    .cloned()
                    .context("unknown host scene route")?,
            )
        };
        if kind != 3 && !(2..=HOST_CALL_MAX_FRAME_LEN).contains(&frame_len) {
            bail!("invalid host scene frame length: {frame_len}");
        }
        let frame_end = offset
            .checked_add(frame_len)
            .filter(|end| *end <= packet.len())
            .context("truncated host scene frame")?;
        operations.push(HostSceneOperation {
            operation_id,
            route,
            kind,
            timeout_ms,
            frame: packet.slice(offset..frame_end),
        });
        offset = frame_end;
    }
    if offset != packet.len() {
        bail!("packed host scene operations have trailing bytes");
    }
    Ok(operations)
}

deno_core::extension!(
    ets_runtime_host,
    ops = [
        op_host_log,
        op_host_sleep,
        op_host_take_event_batch,
        op_host_push_outbound,
        op_host_push_outbound_batch,
        op_host_push_outbound_packed,
        op_host_close_connection,
        op_host_register_scene_route,
        op_host_submit_scene_operations
    ],
);

/// 创建带 TiangZ host op 的 V8 运行时，但不加载或执行业务代码。 / Creates a V8 runtime with TiangZ host ops; it does not load or execute business code.
pub fn create_runtime(inspector: bool, host_log_min_level: u8) -> Result<JsRuntime, AnyError> {
    let mut runtime = JsRuntime::new(RuntimeOptions {
        extensions: vec![
            ets_runtime_host::init(),
            crate::generated::native_ops::init(),
        ],
        inspector,
        module_loader: Some(Rc::new(FsModuleLoader)),
        ..Default::default()
    });

    runtime.execute_script(
        "ets-runtime:bootstrap.js",
        r#"
        const core = globalThis.Deno.core;
        const u32 = (value, name) => {
          if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
            throw new RangeError(`${name} must be uint32`);
          }
          return value;
        };
        const stringify = (value) => {
          if (typeof value === "string") return value;
          if (value instanceof Error) return value.stack || value.message;
          try {
            return JSON.stringify(value, (_, nested) =>
              typeof nested === "bigint" ? nested.toString() : nested);
          } catch (_) {
            return String(value);
          }
        };
        globalThis.__hostLog = (level, target, category, message, attributes = "{}") => {
          if (level < (globalThis.__hostLogMinLevel ?? 0)) return;
          core.ops.op_host_log(
            u32(level, "level"),
            String(target),
            String(category),
            String(message),
            String(attributes),
          );
        };
        globalThis.__hostSleep = (ms) => core.ops.op_host_sleep(u32(ms, "ms"));
        globalThis.__hostTakeEventBatch = () => core.ops.op_host_take_event_batch();
        globalThis.__hostPushOutbound = (connectionId, frame) =>
          core.ops.op_host_push_outbound(u32(connectionId, "connectionId"), frame);
        globalThis.__hostPushOutboundBatch = (connectionIdBytes, frame) =>
          core.ops.op_host_push_outbound_batch(connectionIdBytes, frame);
        globalThis.__hostPushOutboundPacked = (packed) =>
          core.ops.op_host_push_outbound_packed(packed);
        globalThis.__hostCloseConnection = (connectionId) =>
          core.ops.op_host_close_connection(u32(connectionId, "connectionId"));
        globalThis.__hostRegisterSceneRoute = (sourceName, targetName, targetIp, targetPort) =>
          core.ops.op_host_register_scene_route(
            String(sourceName), String(targetName), String(targetIp), u32(targetPort, "targetPort"),
          );
        globalThis.__hostSubmitSceneOperations = (packed) =>
          core.ops.op_host_submit_scene_operations(packed);
        globalThis.__etsDispatchHostEvents = () =>
          globalThis.__etsPushHostEventsBinary(globalThis.__hostTakeEventBatch());
        const consoleWrite = (level, args) => {
          if (level < (globalThis.__hostLogMinLevel ?? 0)) return;
          __hostLog(level, "console", "application", args.map(stringify).join(" "));
        };
        globalThis.console = {
          trace: (...args) => consoleWrite(0, args),
          debug: (...args) => consoleWrite(1, args),
          log: (...args) => consoleWrite(2, args),
          info: (...args) => consoleWrite(2, args),
          warn: (...args) => consoleWrite(3, args),
          error: (...args) => consoleWrite(4, args),
        };
        "#,
    )?;
    runtime.execute_script(
        "ets-runtime:logging-config.js",
        format!("globalThis.__hostLogMinLevel = {host_log_min_level};"),
    )?;
    runtime.execute_script(
        "ets-runtime:native-ops.js",
        crate::generated::native_ops::BOOTSTRAP_SOURCE,
    )?;

    Ok(runtime)
}

/// 一次性解析并缓存必需的 JS 全局入口，避免每帧求值脚本。 / Resolves and caches required global JS entrypoints once to avoid per-tick script evaluation.
pub fn load_js_entrypoints(runtime: &mut JsRuntime) -> Result<JsEntrypoints> {
    Ok(JsEntrypoints {
        start_process: get_global_function(runtime, "__etsStartProcess")?,
        stop_process: get_global_function(runtime, "__etsStopProcess")?,
        update: get_global_function(runtime, "__etsUpdateBinary")?,
        dispatch_host_events: get_global_function(runtime, "__etsDispatchHostEvents")?,
        begin_hotfix: get_global_function(runtime, "__etsBeginHotfix")?,
        commit_hotfix: get_global_function(runtime, "__etsCommitHotfix")?,
        abort_hotfix: get_global_function(runtime, "__etsAbortHotfix")?,
    })
}

/// 加载并执行一个 ESM 根模块；Model 使用 main，Hotfix generation 使用 side module。 / Loads and evaluates an ESM root; Model is main while Hotfix generations are side modules.
pub fn load_es_module(
    js_event_loop: &tokio::runtime::Runtime,
    runtime: &mut JsRuntime,
    specifier: &ModuleSpecifier,
    main: bool,
) -> Result<()> {
    let _guard = js_event_loop.enter();
    js_event_loop.block_on(async {
        let module_id = if main {
            runtime.load_main_es_module(specifier).await
        } else {
            runtime.load_side_es_module(specifier).await
        }
        .with_context(|| format!("failed to load ES module {specifier}"))?;
        let evaluation = runtime.mod_evaluate(module_id);
        runtime
            .run_event_loop(PollEventLoopOptions::default())
            .await
            .with_context(|| format!("failed to run ES module {specifier}"))?;
        evaluation
            .await
            .with_context(|| format!("failed to evaluate ES module {specifier}"))?;
        Ok(())
    })
}

/// 打开 TS Hotfix 暂存区；调用后只允许加载候选模块，不能投递业务帧。 / Opens TS Hotfix staging; only candidate evaluation is allowed until commit or abort.
pub fn call_js_begin_hotfix(
    js_event_loop: &tokio::runtime::Runtime,
    runtime: &mut JsRuntime,
    entrypoints: &JsEntrypoints,
    manifest_json: &str,
) -> Result<String> {
    let arg = v8_string_arg(runtime, manifest_json)?;
    call_js_function_string(js_event_loop, runtime, &entrypoints.begin_hotfix, &[arg])
}

/// 原子提交已经完成模块求值的 Hotfix 候选。 / Atomically commits a fully evaluated Hotfix candidate.
pub fn call_js_commit_hotfix(
    js_event_loop: &tokio::runtime::Runtime,
    runtime: &mut JsRuntime,
    entrypoints: &JsEntrypoints,
) -> Result<String> {
    call_js_function_string(js_event_loop, runtime, &entrypoints.commit_hotfix, &[])
}

/// 候选加载失败时清空 TS 暂存区，避免污染下一次尝试。 / Clears TS staging after candidate failure so the next attempt starts cleanly.
pub fn call_js_abort_hotfix(
    js_event_loop: &tokio::runtime::Runtime,
    runtime: &mut JsRuntime,
    entrypoints: &JsEntrypoints,
    reason: &str,
) -> Result<String> {
    let arg = v8_string_arg(runtime, reason)?;
    call_js_function_string(js_event_loop, runtime, &entrypoints.abort_hotfix, &[arg])
}

fn get_global_function(
    runtime: &mut JsRuntime,
    function_name: &str,
) -> Result<v8::Global<v8::Function>> {
    deno_core::scope!(scope, runtime);
    let key = v8::String::new(scope, function_name)
        .with_context(|| format!("failed to allocate JS function name: {function_name}"))?;
    let value = scope
        .get_current_context()
        .global(scope)
        .get(scope, key.into())
        .with_context(|| format!("JS entrypoint not found: {function_name}"))?;
    let function = v8::Local::<v8::Function>::try_from(value)
        .map_err(|_| anyhow::anyhow!("JS entrypoint is not a function: {function_name}"))?;
    Ok(v8::Global::new(scope, function))
}

fn v8_string_arg(runtime: &mut JsRuntime, value: &str) -> Result<v8::Global<v8::Value>> {
    deno_core::scope!(scope, runtime);
    let value = v8::String::new(scope, value).context("failed to allocate JS string argument")?;
    let value: v8::Local<v8::Value> = value.into();
    Ok(v8::Global::new(scope, value))
}

fn v8_bool_arg(runtime: &mut JsRuntime, value: bool) -> v8::Global<v8::Value> {
    deno_core::scope!(scope, runtime);
    let value: v8::Local<v8::Value> = v8::Boolean::new(scope, value).into();
    v8::Global::new(scope, value)
}

fn call_js_function_string(
    js_event_loop: &tokio::runtime::Runtime,
    runtime: &mut JsRuntime,
    function: &v8::Global<v8::Function>,
    args: &[v8::Global<v8::Value>],
) -> Result<String> {
    let _guard = js_event_loop.enter();
    #[allow(
        deprecated,
        reason = "deno_core provides this combined call/event-loop helper"
    )]
    let value = js_event_loop
        .block_on(runtime.call_with_args_and_await(function, args))
        .context("failed to call cached JS entrypoint")?;
    deno_core::scope!(scope, runtime);
    let value = value.open(scope);
    let value = value
        .to_string(scope)
        .context("JS entrypoint result cannot be converted to string")?;
    Ok(value.to_rust_string_lossy(scope))
}

/// 启动 TS ProcessRuntime，并返回面向运维的启动信息。 / Starts the TS ProcessRuntime and returns its operator-facing startup message.
pub fn call_js_start_process(
    js_event_loop: &tokio::runtime::Runtime,
    runtime: &mut JsRuntime,
    entrypoints: &JsEntrypoints,
    config_json: &str,
) -> Result<String> {
    let arg = v8_string_arg(runtime, config_json)?;
    call_js_function_string(js_event_loop, runtime, &entrypoints.start_process, &[arg])
}

/// 调用幂等的 TS 停机生命周期，并返回其完成 Future。 / Invokes the idempotent TS stop lifecycle and returns its completion future.
pub fn call_js_stop_process(
    js_event_loop: &tokio::runtime::Runtime,
    runtime: &mut JsRuntime,
    entrypoints: &JsEntrypoints,
) -> Result<String> {
    call_js_function_string(js_event_loop, runtime, &entrypoints.stop_process, &[])
}

/// 将一批打包入站数据传给 TS，Rust 不解码 protobuf。 / Transfers one packed ingress batch into TS without decoding protobuf in Rust.
pub fn call_js_push_host_events(
    runtime: &mut JsRuntime,
    entrypoints: &JsEntrypoints,
    packed_events: Vec<u8>,
) -> Result<()> {
    NEXT_HOST_EVENT_BATCH.with(|slot| {
        *slot.borrow_mut() = Some(packed_events);
    });
    deno_core::scope!(scope, runtime);
    let function = entrypoints.dispatch_host_events.open(scope);
    let receiver = v8::undefined(scope).into();
    function
        .call(scope, receiver, &[])
        .context("failed to push host events to JS")?;
    Ok(())
}

/// 执行一次 TS Update，并解析打包出站批次供传输层扇出。 / Executes one TS update and decodes its packed outbound batches for transport fan-out.
pub fn call_js_update_binary(
    js_event_loop: &tokio::runtime::Runtime,
    runtime: &mut JsRuntime,
    entrypoints: &JsEntrypoints,
    sample_metrics: bool,
) -> Result<(String, Vec<BinaryOutboundBatch>)> {
    OUTBOUND_BINARY_BATCHES.with(|slot| slot.borrow_mut().clear());
    let arg = v8_bool_arg(runtime, sample_metrics);
    let metrics_json =
        call_js_function_string(js_event_loop, runtime, &entrypoints.update, &[arg])?;
    let outbound = OUTBOUND_BINARY_BATCHES.with(|slot| slot.borrow_mut().drain(..).collect());
    Ok((metrics_json, outbound))
}

/// 轮询一次待完成 JS Promise；生命周期任务未完成时，调用方必须持续驱动。 / Polls pending JS promises once; callers must keep pumping while lifecycle work is unresolved.
pub fn pump_js_event_loop_once(
    js_event_loop: &tokio::runtime::Runtime,
    runtime: &mut JsRuntime,
) -> Result<()> {
    let _guard = js_event_loop.enter();
    let result = js_event_loop.block_on(poll_fn(|cx| {
        let result = runtime.poll_event_loop(cx, PollEventLoopOptions::default());
        Poll::Ready(match result {
            Poll::Ready(Err(error)) => {
                Err(anyhow::Error::from(error).context("failed to pump JS event loop"))
            }
            Poll::Ready(Ok(())) | Poll::Pending => Ok(()),
        })
    }));
    runtime.v8_isolate().perform_microtask_checkpoint();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_item_round_trips_through_v8_ops() {
        let mut runtime = create_runtime(false, 0).unwrap();
        runtime
            .execute_script(
                "test:native-item.js",
                r#"
                const handle = __etsNativeOps.entityCreate(
                  2,
                  new Float64Array([100, 200, 3001, 2, 0, 1, 1]),
                );
                if (__etsNativeOps.entityGetNumber(handle, 3) !== 3001) {
                  throw new Error("Item configId did not round-trip");
                }
                __etsNativeOps.entitySetNumber(handle, 4, 3);
                if (__etsNativeOps.entityGetNumber(handle, 4) !== 3) {
                  throw new Error("Item count did not round-trip");
                }
                __etsNativeOps.entityDestroy(handle);
                let rejected = false;
                try { __etsNativeOps.entityGetNumber(handle, 4); } catch (_) { rejected = true; }
                if (!rejected) throw new Error("stale Item handle was accepted");
                "ok";
                "#,
            )
            .unwrap();
    }

    #[test]
    fn generated_native_bridge_rejects_uint32_wraparound() {
        let mut runtime = create_runtime(false, 0).unwrap();
        let error = runtime
            .execute_script(
                "test:native-op-validation.js",
                r#"__etsNativeOps.entityDestroy(-1);"#,
            )
            .unwrap_err();
        assert!(error.to_string().contains("handle"));
        assert!(error.to_string().contains("integer"));
    }

    #[test]
    fn console_filters_before_formatting_arguments() {
        let mut runtime = create_runtime(false, 3).unwrap();
        runtime
            .execute_script(
                "test:console-log-filter.js",
                r#"
                let formatted = 0;
                const expensive = { toJSON() { formatted += 1; return "value"; } };
                console.debug("disabled", expensive);
                if (formatted !== 0) throw new Error("disabled console log was formatted");
                "#,
            )
            .unwrap();
    }

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

    #[test]
    fn decodes_packed_outbound_with_shared_backing_bytes() {
        let packed = vec![
            2, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 10, 11, 1, 0, 0, 0, 3, 0,
            0, 0, 3, 0, 0, 0, 20, 21, 22,
        ];
        let batches = decode_packed_outbound(Bytes::from(packed)).unwrap();
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].connection_ids, vec![1, 2]);
        assert_eq!(&batches[0].frame[..], &[10, 11]);
        assert_eq!(batches[1].connection_ids, vec![3]);
        assert_eq!(&batches[1].frame[..], &[20, 21, 22]);
    }

    #[test]
    fn rejects_truncated_or_trailing_packed_outbound() {
        assert!(decode_packed_outbound(Bytes::from_static(&[1, 0, 0, 0])).is_err());
        assert!(decode_packed_outbound(Bytes::from_static(&[0, 0, 0, 0])).is_err());
        assert!(decode_packed_outbound(Bytes::from_static(&[1, 0, 0, 0, 0])).is_err());
    }
}
