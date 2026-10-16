//! V8 内存耗尽、接近堆上限与致命错误回调：同步写崩溃报告，不扩容、不改变终止语义。 / V8 OOM, near-heap-limit and fatal-error callbacks that write crash reports synchronously without raising limits or changing termination.

use std::ffi::{CStr, c_char, c_void};
use std::io::{self, Write};
use std::sync::Once;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use deno_core::v8;

use super::{report, state, write_report};

/// 最近一次堆统计；OOM 回调拿不到 Isolate，只能引用这里的快照。 / Most recent heap statistics; the OOM callback has no Isolate and reads this snapshot.
struct HeapSnapshot {
    sampled_at_ms: AtomicU64,
    used: AtomicU64,
    total: AtomicU64,
    limit: AtomicU64,
    external: AtomicU64,
    malloced: AtomicU64,
}

static LAST_HEAP: HeapSnapshot = HeapSnapshot {
    sampled_at_ms: AtomicU64::new(0),
    used: AtomicU64::new(0),
    total: AtomicU64::new(0),
    limit: AtomicU64::new(0),
    external: AtomicU64::new(0),
    malloced: AtomicU64::new(0),
};

static FATAL_HANDLER: Once = Once::new();

/// 每个 Isolate 一份的接近堆上限状态；与 Isolate 同生命周期，进程内数量有界。 / Per-Isolate near-heap-limit state that lives as long as the Isolate; bounded per process.
struct NearHeapLimitState {
    isolate: v8::UnsafeRawIsolatePtr,
    reported: AtomicBool,
}

/// 记录周期性采样得到的堆统计；未启用崩溃诊断时立即返回。 / Records periodically sampled heap statistics; returns at once when crash diagnostics are disabled.
pub(crate) fn record_heap_statistics(statistics: &v8::HeapStatistics) {
    if state().is_none() {
        return;
    }
    store_heap_statistics(statistics);
}

fn store_heap_statistics(statistics: &v8::HeapStatistics) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0);
    LAST_HEAP
        .used
        .store(statistics.used_heap_size() as u64, Ordering::Relaxed);
    LAST_HEAP
        .total
        .store(statistics.total_heap_size() as u64, Ordering::Relaxed);
    LAST_HEAP
        .limit
        .store(statistics.heap_size_limit() as u64, Ordering::Relaxed);
    LAST_HEAP
        .external
        .store(statistics.external_memory() as u64, Ordering::Relaxed);
    LAST_HEAP
        .malloced
        .store(statistics.malloced_memory() as u64, Ordering::Relaxed);
    LAST_HEAP.sampled_at_ms.store(now, Ordering::Relaxed);
}

/// 为一个 Isolate 注册 OOM 与接近堆上限回调，并一次性注册进程级 V8 致命错误回调。
///
/// 未启用崩溃诊断时不注册任何回调，V8 保持原有行为。接近堆上限回调只写一次报告并返回
/// 当前上限，不擅自扩容；OOM 回调返回后由 V8 照常终止进程。
///
/// Registers OOM and near-heap-limit callbacks for one Isolate and, once per process, the V8
/// fatal-error callback.
///
/// Nothing is registered when crash diagnostics are disabled, so V8 keeps its default behavior.
/// The near-heap-limit callback reports once and returns the current limit without raising it;
/// after the OOM callback returns, V8 terminates the process as before.
pub(crate) fn register_isolate(isolate: &mut v8::Isolate) {
    if state().is_none() {
        return;
    }
    FATAL_HANDLER.call_once(|| v8::V8::set_fatal_error_handler(v8_fatal_error));
    isolate.set_oom_error_handler(v8_oom_error);
    // 回调数据与 Isolate 同寿；进程内 Isolate 数量有界，因此有意不回收这一小块内存。
    // Callback data must outlive the Isolate; Isolates per process are bounded, so this small block is intentionally kept.
    let data = Box::into_raw(Box::new(NearHeapLimitState {
        // SAFETY: 指针只在该 Isolate 自己的线程、在其回调里使用。 / Used only on this Isolate's thread inside its callback.
        isolate: unsafe { isolate.as_raw_isolate_ptr() },
        reported: AtomicBool::new(false),
    }));
    isolate.add_near_heap_limit_callback(v8_near_heap_limit, data.cast::<c_void>());
}

/// 写入堆统计键（heap_sampled_utc 与各项字节数）；尚无采样时只写 `heap_sampled_utc: none`。 / Writes heap keys (heap_sampled_utc and byte counts); only `heap_sampled_utc: none` before any sample.
fn write_heap_snapshot(out: &mut dyn Write) -> io::Result<()> {
    let sampled_at = LAST_HEAP.sampled_at_ms.load(Ordering::Relaxed);
    if sampled_at == 0 {
        return writeln!(out, "heap_sampled_utc: none");
    }
    let sampled = UNIX_EPOCH + std::time::Duration::from_millis(sampled_at);
    writeln!(out, "heap_sampled_utc: {}", report::iso8601(sampled))?;
    for (key, value) in [
        ("used_heap_size", &LAST_HEAP.used),
        ("total_heap_size", &LAST_HEAP.total),
        ("heap_size_limit", &LAST_HEAP.limit),
        ("external_memory", &LAST_HEAP.external),
        ("malloced_memory", &LAST_HEAP.malloced),
    ] {
        writeln!(out, "{key}: {}", value.load(Ordering::Relaxed))?;
    }
    Ok(())
}

fn c_text(value: *const c_char) -> String {
    if value.is_null() {
        return "none".to_string();
    }
    // SAFETY: V8 传入以 NUL 结尾、在回调期间有效的字符串。 / V8 passes NUL-terminated strings valid for the callback.
    unsafe { CStr::from_ptr(value) }
        .to_string_lossy()
        .into_owned()
}

unsafe extern "C" fn v8_oom_error(location: *const c_char, details: &v8::OomDetails) {
    let (location_ptr, detail_ptr) = (location, details.detail);
    let oom_type = if details.is_heap_oom {
        "heap"
    } else {
        "process"
    };
    // 字符串复制也放进 catch_unwind，防止其中的 Rust panic 越过 V8 回调；注意 Rust 分配失败走 handle_alloc_error 直接 abort，catch_unwind 拦不住。
    // String copies also run inside catch_unwind so a Rust panic there cannot cross the V8 callback; a Rust allocation failure still aborts via handle_alloc_error and is not caught.
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let location = c_text(location_ptr);
        let detail = c_text(detail_ptr);
        let _ = writeln!(
            io::stderr(),
            "[tiangz] V8 out of memory ({oom_type}) at {location}: {detail}"
        );
        write_report("v8-oom", &mut |out| {
            report::write_field(out, "location", &location)?;
            writeln!(out, "oom_type: {oom_type}")?;
            report::write_field(out, "detail", &detail)?;
            write_heap_snapshot(out)
        });
    }));
}

unsafe extern "C" fn v8_near_heap_limit(
    data: *mut c_void,
    current_heap_limit: usize,
    initial_heap_limit: usize,
) -> usize {
    // SAFETY: data 来自 register_isolate 的 Box，在 Isolate 存活期间有效，且只在 Isolate 线程访问。
    // `data` comes from register_isolate's Box, lives with the Isolate and is touched only on its thread.
    let near = unsafe { &mut *data.cast::<NearHeapLimitState>() };
    if near.reported.swap(true, Ordering::Relaxed) {
        return current_heap_limit;
    }
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // SAFETY: 回调在所属 Isolate 线程同步执行，读取堆统计是只读操作。 / Runs synchronously on the owning Isolate thread; reading heap statistics is read-only.
        let isolate = unsafe { v8::Isolate::ref_from_raw_isolate_ptr_mut(&mut near.isolate) };
        let statistics = isolate.get_heap_statistics();
        store_heap_statistics(&statistics);
        write_report("v8-near-heap-limit", &mut |out| {
            writeln!(out, "current_heap_limit: {current_heap_limit}")?;
            writeln!(out, "initial_heap_limit: {initial_heap_limit}")?;
            write_heap_snapshot(out)
        });
    }));
    // 不扩容：返回当前上限，V8 照常走向 OOM。 / Never raise the limit: return the current one so V8 proceeds as before.
    current_heap_limit
}

fn v8_fatal_error(file: &str, line: i32, message: &str) {
    let location = format!("{file}:{line}");
    let message = message.to_string();
    let _ = std::panic::catch_unwind(move || {
        let _ = writeln!(
            io::stderr(),
            "[tiangz] V8 fatal error at {location}: {message}"
        );
        write_report("v8-fatal-error", &mut |out| {
            report::write_field(out, "location", &location)?;
            report::write_field(out, "message", &message)?;
            write_heap_snapshot(out)
        });
    });
}

/// 自测用：创建限制堆为 32 MiB 的独立 V8 并无限分配，验证 OOM 链路；只能在显式自测时调用。
///
/// Self-test only: creates a standalone V8 capped at a 32 MiB heap and allocates until OOM to
/// exercise the OOM path; call only from an explicit self-test.
pub(crate) fn self_test_out_of_memory() -> ! {
    let mut runtime = self_test_runtime(Some(32 * 1024 * 1024));
    let _ = runtime.execute_script(
        "tiangz:crash-self-test-oom.js",
        "const keep = []; for (;;) { keep.push(new Array(100000).fill(keep.length)); }",
    );
    panic!("TiangZ crash self-test: V8 OOM did not terminate the process");
}

/// 自测用：创建已注册崩溃回调的最小 V8，可选限制堆上限。 / Self-test only: creates a minimal V8 with crash callbacks registered and an optional heap cap.
pub(crate) fn self_test_runtime(max_heap_bytes: Option<usize>) -> deno_core::JsRuntime {
    let create_params = max_heap_bytes.map(|max| v8::CreateParams::default().heap_limits(0, max));
    let mut runtime = deno_core::JsRuntime::new(deno_core::RuntimeOptions {
        create_params,
        ..Default::default()
    });
    register_isolate(runtime.v8_isolate());
    runtime
}
