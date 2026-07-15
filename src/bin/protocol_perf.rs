use std::cell::RefCell;
use std::collections::HashMap;
use std::time::Instant;

#[path = "../allocator.rs"]
mod allocator;

use anyhow::{Context, Result};
use deno_core::{JsRuntime, RuntimeOptions, op2};

thread_local! {
    static PERF_RESULT_JSON: RefCell<Option<String>> = const { RefCell::new(None) };
}

static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
const DEFAULT_SWEEP_SIZES: &[usize] = &[64, 256, 1024, 4096, 16384];

#[op2(fast)]
fn op_now_ns() -> f64 {
    START.get_or_init(Instant::now).elapsed().as_nanos() as f64
}

#[op2(fast)]
fn op_report_result(#[string] json: String) {
    PERF_RESULT_JSON.with(|slot| {
        *slot.borrow_mut() = Some(json);
    });
}

deno_core::extension!(protocol_perf_ext, ops = [op_now_ns, op_report_result],);

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let iterations = parse_arg(&args, 1, 20_000)?;
    let payload_sizes = parse_payload_sizes(&args, 2)?;
    let warmup = parse_arg(&args, 3, 2_000)?;

    let event_loop = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("failed to create benchmark event loop")?;
    let _event_loop_guard = event_loop.enter();
    let mut runtime = JsRuntime::new(RuntimeOptions {
        extensions: vec![protocol_perf_ext::init()],
        ..Default::default()
    });

    runtime
        .execute_script(
            "ets-runtime:protocol-perf.js",
            benchmark_script(iterations, &payload_sizes, warmup),
        )
        .context("failed to run protocol benchmark")?;

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

    include_str!("protocol_perf.js")
        .replace("__ITERATIONS__", &iterations.to_string())
        .replace("__PAYLOAD_SIZES__", &payload_sizes_js)
        .replace("__WARMUP__", &warmup.to_string())
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

    println!("protocol perf");
    println!("  iterations : {iterations}");
    println!("  warmup     : {warmup}");
    println!("  payloads   : {payload_sizes} bytes");
    println!("  request    : 1 iteration = 1 pingpong request");
    println!("  chain      : msgcode -> descriptor -> decode -> handler -> response encode");
    println!();
    println!(
        "{:>8} {:>8} {:>8} {:<24} {:>12} {:>12} {:>12} {:>10} {:>12}",
        "payload",
        "reqfrm",
        "respfrm",
        "case",
        "elapsed ms",
        "ns/op",
        "req/sec",
        "vs prev",
        "MiB/sec"
    );
    println!("{}", "-".repeat(116));

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
            "{:>8} {:>8} {:>8} {:<24} {:>12.2} {:>12.1} {:>12.0} {:>10} {:>12.1}",
            item["payloadSize"].as_u64().unwrap_or_default(),
            item["requestFrameLength"].as_u64().unwrap_or_default(),
            item["responseFrameLength"].as_u64().unwrap_or_default(),
            name,
            item["elapsedMs"].as_f64().unwrap_or_default(),
            item["nsPerOp"].as_f64().unwrap_or_default(),
            req_per_sec,
            vs_previous_text,
            item["mibPerSec"].as_f64().unwrap_or_default(),
        );
    }

    Ok(())
}
