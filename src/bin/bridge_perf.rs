use std::cell::RefCell;
use std::collections::HashMap;
use std::time::Instant;

#[path = "../allocator.rs"]
mod allocator;

use anyhow::{Context, Result};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use deno_core::convert::Uint8Array;
use deno_core::{JsBuffer, JsRuntime, RuntimeOptions, op2};
use deno_error::JsErrorBox;

thread_local! {
    static PERF_RESULT_JSON: RefCell<Option<String>> = const { RefCell::new(None) };
}

static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
const DEFAULT_SWEEP_SIZES: &[usize] = &[64, 256, 1024, 4096, 16384];

#[op2(fast)]
fn op_now_ns() -> f64 {
    START.get_or_init(Instant::now).elapsed().as_nanos() as f64
}

#[op2]
#[string]
fn op_echo_base64(#[string] value: String) -> String {
    value
}

#[op2]
#[string]
fn op_base64_decode_encode(#[string] value: String) -> Result<String, JsErrorBox> {
    let bytes = BASE64
        .decode(value)
        .map_err(|error| JsErrorBox::generic(format!("base64 decode failed: {error}")))?;
    Ok(BASE64.encode(bytes))
}

#[op2]
fn op_buffer_copy_echo(#[buffer] input: JsBuffer) -> Uint8Array {
    input.to_vec().into()
}

#[op2(fast)]
fn op_buffer_len(#[buffer] input: &[u8]) -> u32 {
    input.len() as u32
}

#[op2(fast)]
fn op_report_result(#[string] json: String) {
    PERF_RESULT_JSON.with(|slot| {
        *slot.borrow_mut() = Some(json);
    });
}

deno_core::extension!(
    bridge_perf_ext,
    ops = [
        op_now_ns,
        op_echo_base64,
        op_base64_decode_encode,
        op_buffer_copy_echo,
        op_buffer_len,
        op_report_result
    ],
);

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let iterations = parse_arg(&args, 1, 100_000)?;
    let payload_sizes = parse_payload_sizes(&args, 2)?;
    let warmup = parse_arg(&args, 3, 5_000)?;

    let event_loop = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("failed to create benchmark event loop")?;
    let _event_loop_guard = event_loop.enter();
    let mut runtime = JsRuntime::new(RuntimeOptions {
        extensions: vec![bridge_perf_ext::init()],
        ..Default::default()
    });

    runtime
        .execute_script(
            "ets-runtime:bridge-perf.js",
            benchmark_script(iterations, &payload_sizes, warmup),
        )
        .context("failed to run bridge benchmark")?;

    let result_json = PERF_RESULT_JSON
        .with(|slot| slot.borrow_mut().take())
        .context("benchmark did not report a result")?;
    print_report(&result_json)?;
    Ok(())
}

fn parse_arg(args: &[String], index: usize, default: usize) -> Result<usize> {
    match args.get(index) {
        Some(value) => value
            .parse::<usize>()
            .with_context(|| format!("invalid numeric argument: {value}")),
        None => Ok(default),
    }
}

fn parse_payload_sizes(args: &[String], index: usize) -> Result<Vec<usize>> {
    let Some(value) = args.get(index) else {
        return Ok(DEFAULT_SWEEP_SIZES.to_vec());
    };

    if value.eq_ignore_ascii_case("sweep") {
        return Ok(DEFAULT_SWEEP_SIZES.to_vec());
    }

    value
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| {
            part.parse::<usize>()
                .with_context(|| format!("invalid payload size: {part}"))
        })
        .collect()
}

fn benchmark_script(iterations: usize, payload_sizes: &[usize], warmup: usize) -> String {
    let payload_sizes_js = payload_sizes
        .iter()
        .map(usize::to_string)
        .collect::<Vec<_>>()
        .join(", ");

    format!(
        r#"
const core = globalThis.Deno.core;
const iterations = {iterations};
const payloadSizes = [{payload_sizes_js}];
const warmup = {warmup};

let guard = 0;

function makePayload(payloadSize) {{
  const payload = new Uint8Array(payloadSize);
  for (let i = 0; i < payload.length; i += 1) {{
    payload[i] = (i * 31 + 7) & 0xff;
  }}
  return payload;
}}

function bytesToBase64(bytes) {{
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {{
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    result += alphabet[(n >>> 18) & 63];
    result += alphabet[(n >>> 12) & 63];
    result += alphabet[(n >>> 6) & 63];
    result += alphabet[n & 63];
  }}

  const remaining = bytes.length - i;
  if (remaining === 1) {{
    const n = bytes[i] << 16;
    result += alphabet[(n >>> 18) & 63];
    result += alphabet[(n >>> 12) & 63];
    result += "==";
  }} else if (remaining === 2) {{
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    result += alphabet[(n >>> 18) & 63];
    result += alphabet[(n >>> 12) & 63];
    result += alphabet[(n >>> 6) & 63];
    result += "=";
  }}
  return result;
}}

function touch(value) {{
  if (typeof value === "string") {{
    guard ^= value.length;
    guard ^= value.charCodeAt(0) || 0;
    return;
  }}
  if (value && typeof value.length === "number") {{
    guard ^= value.length;
    guard ^= value[0] || 0;
    return;
  }}
  guard ^= Number(value) || 0;
}}

function bench(payloadSize, base64Length, name, bytesPerIter, fn) {{
  for (let i = 0; i < warmup; i += 1) touch(fn());
  const start = core.ops.op_now_ns();
  for (let i = 0; i < iterations; i += 1) touch(fn());
  const elapsedNs = core.ops.op_now_ns() - start;
  const opsPerSec = iterations * 1e9 / elapsedNs;
  const reqPerSec = opsPerSec;
  const mibPerSec = bytesPerIter * iterations * 1e9 / elapsedNs / 1024 / 1024;
  return {{
    payloadSize,
    base64Length,
    name,
    elapsedMs: elapsedNs / 1e6,
    nsPerOp: elapsedNs / iterations,
    opsPerSec,
    reqPerSec,
    mibPerSec,
  }};
}}

const results = [];
for (const payloadSize of payloadSizes) {{
  const payload = makePayload(payloadSize);
  const base64 = bytesToBase64(payload);
  const base64Length = base64.length;
  results.push(
    bench(payloadSize, base64Length, "base64 string echo", base64Length, () => core.ops.op_echo_base64(base64)),
    bench(payloadSize, base64Length, "base64 decode+encode", base64Length, () => core.ops.op_base64_decode_encode(base64)),
    bench(payloadSize, base64Length, "Uint8Array copy echo", payloadSize, () => core.ops.op_buffer_copy_echo(payload)),
    bench(payloadSize, base64Length, "Uint8Array len only", payloadSize, () => core.ops.op_buffer_len(payload)),
  );
}}

core.ops.op_report_result(JSON.stringify({{
  iterations,
  payloadSizes,
  warmup,
  guard,
  results,
}}));
"#
    )
}

fn print_report(result_json: &str) -> Result<()> {
    let value: serde_json::Value =
        serde_json::from_str(result_json).context("benchmark returned invalid JSON")?;
    let iterations = value["iterations"].as_u64().unwrap_or_default();
    let warmup = value["warmup"].as_u64().unwrap_or_default();
    let payload_sizes = value["payloadSizes"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_u64())
                .map(|size| size.to_string())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();

    println!("bridge perf");
    println!("  iterations : {iterations}");
    println!("  warmup     : {warmup}");
    println!("  payloads   : {payload_sizes} bytes");
    println!("  request    : 1 iteration = 1 request frame");
    println!();
    println!(
        "{:>8} {:>8} {:<24} {:>12} {:>12} {:>12} {:>12} {:>10} {:>12}",
        "payload",
        "base64",
        "case",
        "elapsed ms",
        "ns/op",
        "ops/sec",
        "req/sec",
        "vs prev",
        "MiB/sec"
    );
    println!("{}", "-".repeat(124));

    let Some(results) = value["results"].as_array() else {
        return Ok(());
    };

    let mut previous_req_by_case = HashMap::<String, f64>::new();

    for item in results {
        let name = item["name"].as_str().unwrap_or("<unknown>");
        let req_per_sec = item["reqPerSec"].as_f64().unwrap_or_default();
        let vs_previous = previous_req_by_case
            .get(name)
            .filter(|previous| **previous > 0.0)
            .map(|previous| req_per_sec / previous);
        previous_req_by_case.insert(name.to_owned(), req_per_sec);
        let vs_previous_text = vs_previous
            .map(|value| format!("{value:.2}x"))
            .unwrap_or_else(|| "-".to_owned());

        println!(
            "{:>8} {:>8} {:<24} {:>12.2} {:>12.1} {:>12.0} {:>12.0} {:>10} {:>12.1}",
            item["payloadSize"].as_u64().unwrap_or_default(),
            item["base64Length"].as_u64().unwrap_or_default(),
            name,
            item["elapsedMs"].as_f64().unwrap_or_default(),
            item["nsPerOp"].as_f64().unwrap_or_default(),
            item["opsPerSec"].as_f64().unwrap_or_default(),
            req_per_sec,
            vs_previous_text,
            item["mibPerSec"].as_f64().unwrap_or_default(),
        );
    }

    Ok(())
}
