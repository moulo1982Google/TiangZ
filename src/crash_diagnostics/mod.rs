//! 可配置的崩溃诊断：panic 报告、最近日志、V8 内存耗尽、原生转储与 Watcher 退出记录。
//!
//! 由 `process.diagnostics.crash.enabled` 或环境变量 `TIANGZ_CRASH_DIAGNOSTICS=on|off` 控制；关闭时不安装
//! 任何钩子、不创建日志环形缓冲，进程行为与旧版本一致。设计见 `docs/design/crash-diagnostics.md`。
//!
//! Configurable crash diagnostics: panic reports, recent logs, V8 out-of-memory, native dumps and
//! Watcher exit records.
//!
//! Controlled by `process.diagnostics.crash.enabled` or `TIANGZ_CRASH_DIAGNOSTICS=on|off`; when
//! disabled no hook or log ring is installed and the process behaves as before. See
//! `docs/design/crash-diagnostics.md`.

mod exit_status;
mod recent_logs;
mod report;
#[cfg(test)]
mod tests;
#[cfg(unix)]
mod unix;
mod v8_handlers;
#[cfg(windows)]
mod windows;

use std::cell::Cell;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use crate::config::{
    CrashDiagnosticsConfig, ProcessConfig, ProcessEnvironment, ProcessLoggingConfig,
};

pub(crate) use recent_logs::{RecentLogBuffer, RecentLogLayer};
pub(crate) use report::{ExitRecord, RestartDecision, write_exit_record};
pub(crate) use v8_handlers::{record_heap_statistics, register_isolate};

/// 应急覆盖开关的环境变量名；取值 `on` 或 `off`，优先于配置。 / Emergency override variable; `on` or `off`, taking precedence over the config.
pub(crate) const ENABLE_ENV: &str = "TIANGZ_CRASH_DIAGNOSTICS";
/// 自测触发环境变量；只在诊断已启用时生效，生产勿设。 / Self-test trigger; effective only while diagnostics are enabled, never set in production.
pub(crate) const SELF_TEST_ENV: &str = "TIANGZ_CRASH_SELF_TEST";

/// 环境变量覆盖的解析结果。 / Parsed environment override.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum EnvOverride {
    Absent,
    On,
    Off,
    /// 无法识别的取值；与 DBProxy 约定一致，进程启动失败。 / Unrecognized value; startup fails, matching the DBProxy contract.
    Invalid(String),
}

impl EnvOverride {
    /// 解析 `on|off`（忽略大小写与空白）；未设置或为空为 Absent，其他值为 Invalid。 / Parses `on|off` ignoring case and whitespace; unset or empty is Absent, anything else is Invalid.
    pub(crate) fn parse(value: Option<&str>) -> Self {
        match value.map(|value| value.trim().to_ascii_lowercase()) {
            None => Self::Absent,
            Some(value) if value.is_empty() => Self::Absent,
            Some(value) if value == "on" => Self::On,
            Some(value) if value == "off" => Self::Off,
            Some(value) => Self::Invalid(value),
        }
    }

    fn from_environment() -> Self {
        Self::parse(std::env::var(ENABLE_ENV).ok().as_deref())
    }

    /// 读取环境变量；取值无法识别时返回错误，使进程不启动。 / Reads the variable; an unrecognized value is an error so the process does not start.
    fn checked_from_environment() -> anyhow::Result<Self> {
        match Self::from_environment() {
            Self::Invalid(value) => {
                anyhow::bail!("{ENABLE_ENV}={value} is invalid; use on or off")
            }
            parsed => Ok(parsed),
        }
    }
}

/// 开关来源，写入启动日志便于排查。 / Where the switch came from, logged at startup for troubleshooting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EnabledBy {
    Config,
    Environment,
}

/// 已解析的一份崩溃诊断设置；目录已是绝对或以根目录为基准的路径。 / Resolved crash settings with the directory already joined to the project root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CrashSettings {
    pub(crate) process_name: String,
    pub(crate) file_label: String,
    pub(crate) directory: PathBuf,
    pub(crate) recent_log_lines: usize,
    pub(crate) mini_dump: bool,
    pub(crate) core_dump: bool,
    pub(crate) max_reports: usize,
    pub(crate) max_dumps: usize,
    pub(crate) enabled_by: EnabledBy,
}

impl CrashSettings {
    /// 按“环境变量 > 配置 > 默认关闭”解析一个 Process 的设置；关闭时返回 None。 / Resolves one Process with env > config > disabled; returns None when disabled.
    pub(crate) fn resolve(root: &Path, process: &ProcessConfig) -> Option<Self> {
        Self::resolve_with(
            root,
            &process.name,
            &process.logging,
            &process.diagnostics.crash,
            &EnvOverride::from_environment(),
        )
    }

    /// 与 [`CrashSettings::resolve`] 相同，但由调用方提供环境变量结果，便于测试。 / Same as [`CrashSettings::resolve`] with an injected override for tests.
    pub(crate) fn resolve_with(
        root: &Path,
        process_name: &str,
        logging: &ProcessLoggingConfig,
        crash: &CrashDiagnosticsConfig,
        environment: &EnvOverride,
    ) -> Option<Self> {
        let enabled_by = match environment {
            EnvOverride::On => EnabledBy::Environment,
            EnvOverride::Off => return None,
            EnvOverride::Absent | EnvOverride::Invalid(_) if crash.enabled => EnabledBy::Config,
            EnvOverride::Absent | EnvOverride::Invalid(_) => return None,
        };
        Some(Self {
            process_name: process_name.to_string(),
            file_label: crate::logging::sanitize_file_name(process_name),
            directory: resolve_crash_directory(root, logging, crash),
            recent_log_lines: crash.recent_log_lines,
            mini_dump: crash.mini_dump,
            core_dump: crash.core_dump,
            max_reports: crash.max_reports,
            max_dumps: crash.max_dumps,
            enabled_by,
        })
    }
}

/// 解析崩溃目录：显式目录按日志目录同样规则（相对工程根）解析；省略时为日志目录同级的 `crash`。
///
/// Resolves the crash directory: an explicit directory resolves like the log directory (relative
/// to the project root); when omitted it is the `crash` sibling of the log directory.
pub(crate) fn resolve_crash_directory(
    root: &Path,
    logging: &ProcessLoggingConfig,
    crash: &CrashDiagnosticsConfig,
) -> PathBuf {
    let join_root = |value: &str| {
        let configured = PathBuf::from(value);
        if configured.is_absolute() {
            configured
        } else {
            root.join(configured)
        }
    };
    if let Some(directory) = &crash.directory {
        return join_root(directory);
    }
    let log_directory = logging
        .file
        .as_ref()
        .map(|file| file.directory.as_str())
        .unwrap_or("logs");
    join_root(log_directory)
        .parent()
        .map(|parent| parent.join("crash"))
        .unwrap_or_else(|| root.join("crash"))
}

/// 已安装的进程级状态。 / Installed process-wide state.
pub(crate) struct CrashState {
    pub(crate) settings: CrashSettings,
    pub(crate) recent: Option<Arc<RecentLogBuffer>>,
    pub(crate) retention: report::RetentionCounter,
    panic_limiter: PanicRateLimiter,
}

static STATE: OnceLock<CrashState> = OnceLock::new();

thread_local! {
    static IN_PANIC_REPORT: Cell<bool> = const { Cell::new(false) };
}

/// 非主线程 panic 报告的最小间隔；被 catch_unwind 兜住的 panic 可能高频发生。 / Minimum interval between non-main-thread panic reports; contained panics may repeat quickly.
pub(crate) const PANIC_REPORT_INTERVAL: Duration = Duration::from_secs(10);

/// panic 报告限流：非主线程 10 秒内最多 1 份，跳过的次数写入下一份报告。
///
/// 主线程 panic 会结束进程，永远写报告；其余线程（tokio 任务、Native worker、KCP 回调等）的 panic
/// 多数会被 catch_unwind 兜住、进程继续服务，若每次都同步符号化回溯并落盘会拖慢工作线程。
///
/// Panic-report limiter: at most one non-main-thread report per 10 seconds, with skipped counts
/// written into the next report. Main-thread panics end the process and are always reported;
/// panics elsewhere (tokio tasks, native workers, KCP callbacks) are mostly contained, and
/// symbolizing and syncing every one would stall worker threads.
pub(crate) struct PanicRateLimiter {
    started: Instant,
    /// 上次写报告的时刻（相对 started 的毫秒数加 1；0 表示从未写过）。 / Last report time in ms since start plus one; 0 means never.
    last_report_ms: AtomicU64,
    suppressed: AtomicU64,
}

impl PanicRateLimiter {
    /// 创建从未写过报告的限流器。 / Creates a limiter that has never reported.
    pub(crate) fn new() -> Self {
        Self {
            started: Instant::now(),
            last_report_ms: AtomicU64::new(0),
            suppressed: AtomicU64::new(0),
        }
    }

    /// 决定本次是否写报告；允许时返回此前被跳过的次数并清零。 / Decides whether to report now; when allowed returns and resets the skipped count.
    pub(crate) fn admit(&self, always: bool, interval: Duration) -> Option<u64> {
        let now = self.started.elapsed().as_millis() as u64 + 1;
        let last = self.last_report_ms.load(Ordering::Relaxed);
        let due = last == 0 || now.saturating_sub(last) >= interval.as_millis() as u64;
        if !always
            && (!due
                || self
                    .last_report_ms
                    .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
                    .is_err())
        {
            self.suppressed.fetch_add(1, Ordering::Relaxed);
            return None;
        }
        if always {
            self.last_report_ms.store(now, Ordering::Relaxed);
        }
        Some(self.suppressed.swap(0, Ordering::Relaxed))
    }
}

/// 返回已安装的状态；未启用时为 None。 / Returns the installed state, or None when disabled.
pub(crate) fn state() -> Option<&'static CrashState> {
    STATE.get()
}

/// 用已安装的设置写一份崩溃报告；未启用时什么也不做。 / Writes a crash report with the installed settings; does nothing when disabled.
pub(crate) fn write_report(
    kind: &str,
    details: &mut dyn FnMut(&mut dyn Write) -> io::Result<()>,
) -> Option<PathBuf> {
    write_report_with_stem(kind, None, details)
}

/// 与 [`write_report`] 相同，但可指定文件名主干（原生异常让 `.txt` 与 `.dmp` 同名）。 / Same as [`write_report`] with an explicit stem so native `.txt` and `.dmp` share a name.
pub(crate) fn write_report_with_stem(
    kind: &str,
    stem: Option<String>,
    details: &mut dyn FnMut(&mut dyn Write) -> io::Result<()>,
) -> Option<PathBuf> {
    let crash = state()?;
    report::write_crash_report(
        &crash.settings,
        crash.recent.as_deref(),
        kind,
        stem,
        Some(&crash.retention),
        details,
    )
}

/// 启动期准备：先于日志初始化解析设置并创建环形缓冲，日志初始化后再调用 [`CrashDiagnostics::install`]。
///
/// Startup bundle: resolves settings and creates the log ring before logging is initialized; call
/// [`CrashDiagnostics::install`] after logging is up.
pub(crate) struct CrashDiagnostics {
    settings: Option<CrashSettings>,
    recent: Option<Arc<RecentLogBuffer>>,
}

impl CrashDiagnostics {
    /// 为普通 Process 解析设置；开关环境变量取值无效时返回错误。 / Resolves settings for a regular Process; an invalid switch variable is an error.
    pub(crate) fn for_process(root: &Path, process: &ProcessConfig) -> anyhow::Result<Self> {
        let environment = EnvOverride::checked_from_environment()?;
        let settings = CrashSettings::resolve_with(
            root,
            &process.name,
            &process.logging,
            &process.diagnostics.crash,
            &environment,
        );
        Ok(Self::new(settings))
    }

    /// Watcher 没有自己的 Process 配置，只能由环境变量 `on` 启用，使用默认目录与上限。
    ///
    /// The Watcher has no Process config of its own; only the `on` environment value enables it,
    /// with default directory and limits.
    pub(crate) fn for_watcher(root: &Path) -> anyhow::Result<Self> {
        let environment = EnvOverride::checked_from_environment()?;
        let settings = CrashSettings::resolve_with(
            root,
            "watcher",
            &ProcessLoggingConfig::default(),
            &CrashDiagnosticsConfig::default(),
            &environment,
        );
        Ok(Self::new(settings))
    }

    fn new(settings: Option<CrashSettings>) -> Self {
        let recent = settings
            .as_ref()
            .filter(|settings| settings.recent_log_lines > 0)
            .map(|settings| RecentLogBuffer::new(settings.recent_log_lines));
        Self { settings, recent }
    }

    /// 返回要挂到 tracing subscriber 上的最近日志 Layer；关闭时为 None（零开销）。 / Returns the recent-log layer for the subscriber; None (zero cost) when disabled.
    pub(crate) fn recent_log_layer(&self) -> Option<RecentLogLayer> {
        self.recent.clone().map(RecentLogLayer::new)
    }

    /// 安装 panic 钩子与平台原生处理，并先做一次保留清理；每个进程只应调用一次。
    ///
    /// 必须在日志初始化之后调用，以便安装结果写入日志。重复调用时第二次不生效。
    ///
    /// Installs the panic hook and native handlers and runs one retention pass; call once per process.
    ///
    /// Must run after logging is initialized so the outcome is logged; a second call has no effect.
    pub(crate) fn install(self) {
        let Some(settings) = self.settings else {
            return;
        };
        if STATE
            .set(CrashState {
                settings,
                recent: self.recent,
                retention: report::RetentionCounter::new(),
                panic_limiter: PanicRateLimiter::new(),
            })
            .is_err()
        {
            return;
        }
        let Some(crash) = state() else { return };
        let settings = &crash.settings;
        if let Err(error) = report::create_private_dir(&settings.directory) {
            tracing::warn!(target: "tiangz::crash", directory = %settings.directory.display(), %error, "failed to create crash directory; reports may be lost");
        }
        install_panic_hook();
        install_native_handlers(settings);
        if let Ok(outcome) = report::enforce_retention(settings) {
            crash.retention.calibrate(outcome);
            if outcome.removed > 0 {
                tracing::info!(target: "tiangz::crash", removed = outcome.removed, "old crash diagnostics removed by retention limits");
            }
        }
        tracing::info!(
            target: "tiangz::crash",
            directory = %settings.directory.display(),
            enabled_by = ?settings.enabled_by,
            recent_log_lines = settings.recent_log_lines,
            mini_dump = settings.mini_dump,
            core_dump = settings.core_dump,
            max_reports = settings.max_reports,
            max_dumps = settings.max_dumps,
            "crash diagnostics enabled"
        );
    }
}

fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // 写报告期间再次 panic 时跳过报告，直接交给原钩子，避免递归。
        // Skip reporting on a nested panic during report writing and go straight to the previous hook.
        let nested = IN_PANIC_REPORT
            .try_with(|flag| flag.replace(true))
            .unwrap_or(true);
        if !nested {
            let main_thread = std::thread::current().name() == Some("main");
            let admitted = state().and_then(|crash| {
                crash
                    .panic_limiter
                    .admit(main_thread, PANIC_REPORT_INTERVAL)
            });
            if let Some(suppressed) = admitted {
                let message = info
                    .payload_as_str()
                    .unwrap_or("<non-string panic payload>");
                let location = info.location().map(|location| {
                    format!(
                        "{}:{}:{}",
                        location.file(),
                        location.line(),
                        location.column()
                    )
                });
                write_report("panic", &mut |out| {
                    report::write_panic_details(out, message, location.clone(), suppressed)
                });
            } else if state().is_some() {
                let _ = writeln!(
                    io::stderr(),
                    "[tiangz] crash report suppressed by the rate limit"
                );
            }
            let _ = IN_PANIC_REPORT.try_with(|flag| flag.set(false));
        }
        previous(info);
    }));
}

#[cfg(windows)]
fn install_native_handlers(settings: &CrashSettings) {
    if settings.core_dump {
        tracing::info!(target: "tiangz::crash", "diagnostics.crash.coreDump only applies on Linux/Unix; ignored on Windows");
    }
    if let Err(error) = windows::install() {
        tracing::warn!(target: "tiangz::crash", %error, "failed to install the unhandled-exception filter");
    }
}

#[cfg(unix)]
fn install_native_handlers(settings: &CrashSettings) {
    if settings.mini_dump {
        tracing::info!(target: "tiangz::crash", "diagnostics.crash.miniDump only applies on Windows; ignored");
    }
    if settings.core_dump {
        for message in unix::enable_core_dumps() {
            tracing::info!(target: "tiangz::crash", "{message}");
        }
    }
}

#[cfg(not(any(windows, unix)))]
fn install_native_handlers(_settings: &CrashSettings) {}

/// 自测取值。 / Self-test modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SelfTestMode {
    Panic,
    /// 3 个后台线程依次 panic 并被 join 吸收；进程继续，验证限流。 / Three background threads panic in turn and are joined; the process continues, exercising the rate limit.
    ThreadPanic,
    Abort,
    AccessViolation,
    StackOverflow,
    OutOfMemory,
}

/// 解析并校验自测请求：未设置返回 None；取值未知，或部署环境不是 development/test，返回错误使启动失败。
///
/// 生产残留自测变量会让每次启动都崩溃，Watcher 自动重启会变成崩溃循环，因此只在开发与测试环境放行。
///
/// Parses and checks a self-test request: None when unset; an unknown value, or a deployment
/// environment other than development/test, is an error that fails startup. A leftover variable in
/// production would crash every start and turn Watcher restarts into a crash loop, so only
/// development and test environments are allowed.
pub(crate) fn parse_self_test(
    value: Option<&str>,
    environment: ProcessEnvironment,
) -> anyhow::Result<Option<SelfTestMode>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let mode = match value.trim().to_ascii_lowercase().as_str() {
        "panic" => SelfTestMode::Panic,
        "thread-panic" => SelfTestMode::ThreadPanic,
        "abort" => SelfTestMode::Abort,
        "access-violation" => SelfTestMode::AccessViolation,
        "stack-overflow" => SelfTestMode::StackOverflow,
        "oom" => SelfTestMode::OutOfMemory,
        other => anyhow::bail!(
            "{SELF_TEST_ENV}={other} is not one of panic, thread-panic, abort, access-violation, stack-overflow, oom"
        ),
    };
    if !matches!(
        environment,
        ProcessEnvironment::Development | ProcessEnvironment::Test
    ) {
        anyhow::bail!(
            "{SELF_TEST_ENV} is set but process.environment is {}; crash self-tests only run in development or test",
            environment.as_str()
        );
    }
    Ok(Some(mode))
}

/// 若设置了 `TIANGZ_CRASH_SELF_TEST` 且诊断已启用，则主动制造对应崩溃；只用于验证，生产勿设。
///
/// 诊断关闭时只记一条警告并忽略；取值未知或环境不是 development/test 时返回错误，进程不启动。
///
/// When `TIANGZ_CRASH_SELF_TEST` is set and diagnostics are enabled, deliberately crashes for
/// verification only; never set it in production. With diagnostics disabled it only logs a
/// warning; an unknown value or a non-development/test environment returns an error so the
/// process does not start.
pub(crate) fn run_self_test_if_requested(environment: ProcessEnvironment) -> anyhow::Result<()> {
    let value = std::env::var(SELF_TEST_ENV).ok();
    if value.is_none() {
        return Ok(());
    }
    if state().is_none() {
        tracing::warn!(target: "tiangz::crash", "{SELF_TEST_ENV} is set but crash diagnostics are disabled; ignored");
        return Ok(());
    }
    let Some(mode) = parse_self_test(value.as_deref(), environment)? else {
        return Ok(());
    };
    tracing::warn!(target: "tiangz::crash", mode = ?mode, "crash self-test requested; crashing deliberately");
    if mode == SelfTestMode::ThreadPanic {
        run_thread_panics();
        tracing::warn!(target: "tiangz::crash", "crash self-test thread panics contained; startup continues");
        return Ok(());
    }
    trigger_self_test(mode)
}

/// 依次启动 3 个会 panic 的线程并 join；第一份写报告，其余在 10 秒内被限流。 / Starts and joins three panicking threads in turn; the first is reported, the rest are rate limited.
fn run_thread_panics() {
    for index in 0..3 {
        let worker = std::thread::Builder::new()
            .name(format!("tiangz-crash-self-test-{index}"))
            .spawn(move || panic!("TiangZ crash self-test: thread panic {index}"));
        if let Ok(worker) = worker {
            let _ = worker.join();
        }
    }
}

fn trigger_self_test(mode: SelfTestMode) -> ! {
    match mode {
        SelfTestMode::Panic => panic!("TiangZ crash self-test: deliberate panic"),
        SelfTestMode::ThreadPanic => {
            run_thread_panics();
            unreachable!(
                "TiangZ crash self-test: thread-panic is handled before trigger_self_test"
            );
        }
        SelfTestMode::Abort => std::process::abort(),
        SelfTestMode::AccessViolation => {
            // 先创建已注册回调的 V8，证明 V8 初始化后原生处理仍然生效。
            // Create a V8 with callbacks first to prove native handling survives V8 initialization.
            let _runtime = v8_handlers::self_test_runtime(None);
            // SAFETY: 不安全且有意为之：自测需要真实的硬件访问违规。 / Deliberately unsound: the self-test needs a real hardware access violation.
            unsafe { std::ptr::write_volatile(std::ptr::without_provenance_mut::<u8>(0x10), 1) };
            unreachable!("TiangZ crash self-test: invalid write did not fault");
        }
        SelfTestMode::StackOverflow => {
            let worker = std::thread::Builder::new()
                .name("tiangz-crash-self-test".to_string())
                .stack_size(256 * 1024)
                .spawn(|| recurse_forever(0));
            if let Ok(worker) = worker {
                let _ = worker.join();
            }
            unreachable!("TiangZ crash self-test: stack overflow did not terminate the process");
        }
        SelfTestMode::OutOfMemory => v8_handlers::self_test_out_of_memory(),
    }
}

/// 无限递归直到栈溢出；`black_box` 防止被优化为循环。 / Recurses until the stack overflows; `black_box` keeps it from becoming a loop.
fn recurse_forever(depth: u64) -> u64 {
    let frame = std::hint::black_box([depth; 64]);
    if std::hint::black_box(depth == u64::MAX) {
        return frame[0];
    }
    recurse_forever(std::hint::black_box(frame[0] + 1)) + frame[63]
}
