//! 把TypeScript协议Span批量导出到OTLP；导出故障不得阻塞或改变游戏请求结果。 / Batch-exports TypeScript protocol spans to OTLP; exporter failures must not block or alter gameplay outcomes.

use anyhow::{Context as _, Result};
use deno_core::op2;
use deno_error::JsErrorBox;
use opentelemetry::trace::{
    Span as _, SpanContext, SpanId, SpanKind, Status, TraceContextExt, TraceFlags, TraceId,
    TraceState, Tracer as _, TracerProvider as _,
};
use opentelemetry::{Context, KeyValue, Value};
use opentelemetry_otlp::{Protocol, WithExportConfig};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::trace::{SdkTracerProvider, Span};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::sync::OnceLock;

use crate::config::TracingObservabilityConfig;

static TRACE_PROVIDER: OnceLock<SdkTracerProvider> = OnceLock::new();

thread_local! {
    static ACTIVE_SPANS: RefCell<HashMap<u32, Span>> = RefCell::new(HashMap::new());
    static NEXT_SPAN_HANDLE: Cell<u32> = const { Cell::new(1) };
}

pub struct TelemetryGuard {
    provider: Option<SdkTracerProvider>,
}

/// 初始化当前OS进程的批量OTLP exporter；未启用时不创建线程或网络客户端。 / Initializes the process batch OTLP exporter; disabled tracing creates no worker or network client.
pub fn init(
    process_name: &str,
    config: Option<&TracingObservabilityConfig>,
) -> Result<TelemetryGuard> {
    let Some(config) = config.filter(|config| config.enabled) else {
        return Ok(TelemetryGuard { provider: None });
    };
    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(config.otlp_endpoint.clone())
        .build()
        .context("failed to build OTLP span exporter")?;
    let resource = Resource::builder()
        .with_service_name(format!("tiangz-{process_name}"))
        .with_attribute(KeyValue::new("service.namespace", "tiangz"))
        .with_attribute(KeyValue::new("process.name", process_name.to_string()))
        .build();
    let provider = SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .with_resource(resource)
        .build();
    TRACE_PROVIDER
        .set(provider.clone())
        .map_err(|_| anyhow::anyhow!("OTLP tracer provider is already initialized"))?;
    Ok(TelemetryGuard {
        provider: Some(provider),
    })
}

impl Drop for TelemetryGuard {
    fn drop(&mut self) {
        if let Some(provider) = self.provider.take()
            && let Err(error) = provider.shutdown()
        {
            tracing::warn!(target: "tiangz::telemetry", %error, "OTLP tracer shutdown failed");
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StartedSpan {
    handle: u32,
    trace_id: String,
    span_id: String,
}

/// 开始一个由TS显式管理生命周期的Span，并返回SDK实际分配的W3C标识。 / Starts a TS-managed span and returns the W3C IDs allocated by the SDK.
#[op2]
#[string]
pub fn op_host_start_trace_span(
    #[string] name: String,
    #[string] kind: String,
    #[string] parent_trace_id: String,
    #[string] parent_span_id: String,
    #[string] attributes: String,
) -> std::result::Result<String, JsErrorBox> {
    start_trace_span(name, kind, parent_trace_id, parent_span_id, attributes)
        .map_err(|error| JsErrorBox::generic(error.to_string()))
}

fn start_trace_span(
    name: String,
    kind: String,
    parent_trace_id: String,
    parent_span_id: String,
    attributes: String,
) -> Result<String> {
    let Some(provider) = TRACE_PROVIDER.get() else {
        return Ok(String::new());
    };
    let parent = parse_parent_context(&parent_trace_id, &parent_span_id)?;
    let tracer = provider.tracer("tiangz-typescript");
    let mut builder = tracer.span_builder(name).with_kind(parse_span_kind(&kind)?);
    let attributes = parse_attributes(&attributes)?;
    if !attributes.is_empty() {
        builder = builder.with_attributes(attributes);
    }
    let span = builder.start_with_context(&tracer, &parent);
    let span_context = span.span_context().clone();
    let handle = reserve_span_handle()?;
    ACTIVE_SPANS.with(|spans| spans.borrow_mut().insert(handle, span));
    serde_json::to_string(&StartedSpan {
        handle,
        trace_id: span_context.trace_id().to_string(),
        span_id: span_context.span_id().to_string(),
    })
    .context("failed to encode started trace span")
}

/// 结束指定Span；未知句柄表示迟到完成并被忽略。 / Ends one span; an unknown handle is a stale completion and is ignored.
#[op2(fast)]
pub fn op_host_end_trace_span(handle: u32, failed: bool, #[string] detail: String) {
    let Some(mut span) = ACTIVE_SPANS.with(|spans| spans.borrow_mut().remove(&handle)) else {
        return;
    };
    if failed {
        span.set_status(Status::error(detail));
    } else {
        span.set_status(Status::Ok);
    }
    span.end();
}

fn parse_parent_context(trace_id: &str, span_id: &str) -> Result<Context> {
    if trace_id.is_empty() && span_id.is_empty() {
        return Ok(Context::new());
    }
    let trace_id = TraceId::from_hex(trace_id).context("invalid parent traceId")?;
    let span_id = SpanId::from_hex(span_id).context("invalid parent spanId")?;
    Ok(Context::new().with_remote_span_context(SpanContext::new(
        trace_id,
        span_id,
        TraceFlags::SAMPLED,
        true,
        TraceState::default(),
    )))
}

fn parse_span_kind(value: &str) -> Result<SpanKind> {
    match value {
        "server" => Ok(SpanKind::Server),
        "client" => Ok(SpanKind::Client),
        "internal" => Ok(SpanKind::Internal),
        _ => anyhow::bail!("invalid trace span kind: {value}"),
    }
}

fn parse_attributes(value: &str) -> Result<Vec<KeyValue>> {
    let object = serde_json::from_str::<serde_json::Value>(value)
        .context("invalid trace span attributes")?;
    let object = object
        .as_object()
        .context("trace span attributes must be an object")?;
    Ok(object
        .iter()
        .filter_map(|(key, value)| json_attribute(key, value))
        .collect())
}

fn json_attribute(key: &str, value: &serde_json::Value) -> Option<KeyValue> {
    let value = match value {
        serde_json::Value::String(value) => Value::String(value.clone().into()),
        serde_json::Value::Bool(value) => Value::Bool(*value),
        serde_json::Value::Number(value) if value.is_i64() => Value::I64(value.as_i64()?),
        serde_json::Value::Number(value) => Value::F64(value.as_f64()?),
        _ => return None,
    };
    Some(KeyValue::new(key.to_string(), value))
}

fn reserve_span_handle() -> Result<u32> {
    ACTIVE_SPANS.with(|spans| {
        let spans = spans.borrow();
        for _ in 0..u32::MAX {
            let handle = NEXT_SPAN_HANDLE.get();
            NEXT_SPAN_HANDLE.set(handle.wrapping_add(1).max(1));
            if handle != 0 && !spans.contains_key(&handle) {
                return Ok(handle);
            }
        }
        anyhow::bail!("trace span handle space is exhausted")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attributes_keep_only_otlp_scalars() {
        let values =
            parse_attributes(r#"{"scene":"map_1","rpcId":7,"ok":true,"nested":{}}"#).unwrap();
        assert_eq!(values.len(), 3);
    }

    #[test]
    fn parent_ids_are_strict() {
        assert!(parse_parent_context("", "").is_ok());
        assert!(parse_parent_context("bad", "also-bad").is_err());
    }
}
