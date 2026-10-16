//! 崩溃诊断的单元测试与子进程测试；会安装全局钩子的用例都在重新执行的子进程里运行。 / Unit and child-process tests for crash diagnostics; cases that install global hooks run in a re-executed child.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::exit_status::{describe_unix_wait_status, describe_windows_exit_code, exception_name};
use super::recent_logs::{MAX_LINE_BYTES, TRUNCATED_SUFFIX, truncate_line};
use super::report::{
    FileClass, civil_from_days, classify, enforce_retention_in, file_stamp, file_stem,
    format_exit_record, parse_owned_name, write_field, write_panic_details, write_recent_logs,
    write_report_header, write_utc_timestamp,
};
use super::*;
use crate::config::{ProcessLogFileConfig, ProcessLogRotation};

fn settings_in(directory: &Path) -> CrashSettings {
    CrashSettings {
        process_name: "map:1".to_string(),
        file_label: crate::logging::sanitize_file_name("map:1"),
        directory: directory.to_path_buf(),
        recent_log_lines: 3,
        mini_dump: true,
        core_dump: false,
        max_reports: 4,
        max_dumps: 2,
        enabled_by: EnabledBy::Config,
    }
}

#[test]
fn environment_override_parses_on_off_and_flags_other_values() {
    assert_eq!(EnvOverride::parse(None), EnvOverride::Absent);
    assert_eq!(EnvOverride::parse(Some("  ")), EnvOverride::Absent);
    assert_eq!(EnvOverride::parse(Some(" ON ")), EnvOverride::On);
    assert_eq!(EnvOverride::parse(Some("off")), EnvOverride::Off);
    assert_eq!(
        EnvOverride::parse(Some("yes")),
        EnvOverride::Invalid("yes".to_string())
    );
}

#[test]
fn environment_takes_precedence_over_config_and_default_is_off() {
    let root = Path::new("project");
    let logging = ProcessLoggingConfig::default();
    let disabled = CrashDiagnosticsConfig::default();
    let enabled = CrashDiagnosticsConfig {
        enabled: true,
        ..CrashDiagnosticsConfig::default()
    };
    let resolve = |crash: &CrashDiagnosticsConfig, environment: EnvOverride| {
        CrashSettings::resolve_with(root, "map", &logging, crash, &environment)
    };
    assert!(resolve(&disabled, EnvOverride::Absent).is_none());
    assert_eq!(
        resolve(&enabled, EnvOverride::Absent).unwrap().enabled_by,
        EnabledBy::Config
    );
    assert_eq!(
        resolve(&disabled, EnvOverride::On).unwrap().enabled_by,
        EnabledBy::Environment
    );
    assert!(resolve(&enabled, EnvOverride::Off).is_none());
    // 无法识别的取值被忽略，回到配置。 / An unrecognized value is ignored and the config decides.
    assert!(resolve(&disabled, EnvOverride::Invalid("x".into())).is_none());
    assert!(resolve(&enabled, EnvOverride::Invalid("x".into())).is_some());
    let settings = resolve(&enabled, EnvOverride::Absent).unwrap();
    assert_eq!(settings.recent_log_lines, 200);
    assert_eq!((settings.max_reports, settings.max_dumps), (50, 5));
    assert!(!settings.mini_dump && !settings.core_dump);
}

#[test]
fn crash_directory_defaults_to_log_directory_sibling() {
    let root = Path::new("project");
    let crash = CrashDiagnosticsConfig::default();
    let default_logging = ProcessLoggingConfig::default();
    assert_eq!(
        resolve_crash_directory(root, &default_logging, &crash),
        root.join("crash")
    );
    let nested = ProcessLoggingConfig {
        file: Some(ProcessLogFileConfig {
            enabled: true,
            directory: "var/log/game".to_string(),
            rotation: ProcessLogRotation::Daily,
        }),
        ..ProcessLoggingConfig::default()
    };
    assert_eq!(
        resolve_crash_directory(root, &nested, &crash),
        root.join("var/log").join("crash")
    );
    let explicit = CrashDiagnosticsConfig {
        directory: Some("diagnostics/crash".to_string()),
        ..CrashDiagnosticsConfig::default()
    };
    assert_eq!(
        resolve_crash_directory(root, &nested, &explicit),
        root.join("diagnostics/crash")
    );
    let absolute = std::env::temp_dir().join("tiangz-crash");
    let absolute_config = CrashDiagnosticsConfig {
        directory: Some(absolute.display().to_string()),
        ..CrashDiagnosticsConfig::default()
    };
    assert_eq!(
        resolve_crash_directory(root, &nested, &absolute_config),
        absolute
    );
}

#[test]
fn utc_formatting_matches_known_instants() {
    assert_eq!(civil_from_days(0), (1970, 1, 1));
    assert_eq!(civil_from_days(-1), (1969, 12, 31));
    assert_eq!(civil_from_days(11_016), (2000, 2, 29));
    let instant = UNIX_EPOCH + Duration::from_millis(1_791_966_615_123);
    let mut text = String::new();
    write_utc_timestamp(&mut text, instant);
    assert_eq!(text, "2026-10-14T08:30:15.123Z");
    assert_eq!(file_stamp(instant), "20261014T083015.123Z");
    assert_eq!(
        file_stem("gate", 42, instant),
        "crash-gate-42-20261014T083015.123Z"
    );
}

#[test]
fn recent_log_buffer_keeps_only_the_newest_lines() {
    let buffer = RecentLogBuffer::new(3);
    for index in 0..10 {
        buffer.push(&format!("line {index}"));
    }
    let lines = buffer
        .with_lines(|lines| lines.iter().cloned().collect::<Vec<_>>())
        .unwrap();
    assert_eq!(lines, ["line 7", "line 8", "line 9"]);
    assert_eq!(buffer.capacity(), 3);
    assert_eq!(RecentLogBuffer::new(0).capacity(), 1);
}

#[test]
fn long_lines_are_truncated_on_a_character_boundary() {
    let mut line = "日".repeat(MAX_LINE_BYTES);
    truncate_line(&mut line);
    assert!(line.len() <= MAX_LINE_BYTES);
    assert!(line.ends_with(TRUNCATED_SUFFIX));
    let mut short = "short".to_string();
    truncate_line(&mut short);
    assert_eq!(short, "short");
}

#[test]
fn recent_log_layer_formats_events_that_pass_filtering() {
    use tracing_subscriber::layer::SubscriberExt;

    let buffer = RecentLogBuffer::new(2);
    let subscriber = tracing_subscriber::registry()
        .with(tracing_subscriber::filter::LevelFilter::INFO)
        .with(RecentLogLayer::new(buffer.clone()));
    tracing::subscriber::with_default(subscriber, || {
        tracing::debug!(target: "tiangz::test", "filtered out");
        tracing::info!(target: "tiangz::test", answer = 42, name = "alpha", "first event");
        tracing::warn!(target: "tiangz::test", "second event");
        tracing::error!(target: "tiangz::test", "third event");
    });
    let lines = buffer
        .with_lines(|lines| lines.iter().cloned().collect::<Vec<_>>())
        .unwrap();
    assert_eq!(lines.len(), 2, "{lines:?}");
    assert!(
        lines[0].contains(" WARN tiangz::test: second event"),
        "{lines:?}"
    );
    assert!(
        lines[1].contains("ERROR tiangz::test: third event"),
        "{lines:?}"
    );

    let fields = RecentLogBuffer::new(1);
    let subscriber = tracing_subscriber::registry().with(RecentLogLayer::new(fields.clone()));
    tracing::subscriber::with_default(subscriber, || {
        tracing::info!(target: "tiangz::test", answer = 42, name = "alpha", "with fields");
    });
    let line = fields.with_lines(|lines| lines[0].clone()).unwrap();
    assert!(
        line.ends_with("INFO tiangz::test: with fields answer=42 name=alpha"),
        "{line}"
    );
}

#[test]
fn report_follows_the_shared_format_version_1_key_order() {
    let buffer = RecentLogBuffer::new(2);
    buffer.push("older");
    buffer.push("newest log line");
    let mut text = Vec::new();
    write_report_header(&mut text, "map:1", "panic", 4242, UNIX_EPOCH).unwrap();
    let capture =
        report::PanicCapture::capture("boom\nsecond line", Some("src/x.rs:1:2".to_string()));
    write_panic_details(&mut text, &capture, 3, None).unwrap();
    write_recent_logs(&mut text, Some(&buffer)).unwrap();
    let text = String::from_utf8(text).unwrap();
    let mut deferred = Vec::new();
    write_panic_details(&mut deferred, &capture, 0, Some("runtime thread panicked")).unwrap();
    let deferred = String::from_utf8(deferred).unwrap();
    assert!(
        deferred.contains(
            "\nsuppressed_since_last: 0\ndeferred: true\ndeferred_reason: runtime thread panicked\n\nbacktrace:\n"
        ),
        "{deferred}"
    );
    let header = format!(
        "TiangZ crash report\nformat_version: 1\nprocess: map:1\nversion: {}\npid: 4242\nplatform: {}-{}\ntime_utc: 1970-01-01T00:00:00.000Z\nkind: panic\nthread: ",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    assert!(text.starts_with(&header), "{text}");
    for expected in [
        "\nmessage: boom\n  second line\nlocation: src/x.rs:1:2\nsuppressed_since_last: 3\n\nbacktrace:\n",
        "\n\nrecent_logs: 2 of 2\nolder\nnewest log line\n",
    ] {
        assert!(text.contains(expected), "missing {expected:?} in\n{text}");
    }
    let mut disabled = Vec::new();
    write_recent_logs(&mut disabled, None).unwrap();
    assert_eq!(
        String::from_utf8(disabled).unwrap(),
        "\nrecent_logs: disabled (recentLogLines = 0)\n"
    );
    let mut field = Vec::new();
    write_field(&mut field, "detail", "a\nb\n").unwrap();
    assert_eq!(String::from_utf8(field).unwrap(), "detail: a\n  b\n");
}

#[test]
fn crash_report_file_is_created_without_overwriting_and_retained() {
    let directory = tempfile::tempdir().unwrap();
    let settings = settings_in(directory.path());
    let mut paths = Vec::new();
    for index in 0..6 {
        let path = report::write_crash_report(&settings, None, "test", None, None, &mut |out| {
            writeln!(out, "body: {index}")
        })
        .unwrap();
        paths.push(path);
    }
    let names = file_names(directory.path());
    // maxReports = 4：最旧的两份被删除，最新的一份一定保留。 / maxReports = 4 removes the two oldest and always keeps the newest.
    assert_eq!(names.len(), 4, "{names:?}");
    assert!(paths.last().unwrap().exists());
    let name = paths[0].file_name().unwrap().to_str().unwrap().to_string();
    assert!(
        name.starts_with(&format!("crash-map_1-{}-", std::process::id())),
        "{name}"
    );
    // 同一主干重复写入时依次追加 -2、-3。 / Repeated writes with one stem append -2, -3.
    let stem = "crash-map_1-1-20261014T083015.123Z".to_string();
    let first =
        report::write_crash_report(&settings, None, "t", Some(stem.clone()), None, &mut |_| {
            Ok(())
        });
    let second =
        report::write_crash_report(&settings, None, "t", Some(stem.clone()), None, &mut |_| {
            Ok(())
        });
    assert!(first.unwrap().ends_with(format!("{stem}.txt")));
    assert!(second.unwrap().ends_with(format!("{stem}-2.txt")));
}

fn file_names(directory: &Path) -> Vec<String> {
    let mut names = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect::<Vec<_>>();
    names.sort();
    names
}

#[test]
fn owned_names_require_label_pid_and_stamp() {
    assert_eq!(
        parse_owned_name("crash-map-12-20261014T083015.123Z.txt", "map"),
        Some(12)
    );
    assert_eq!(
        parse_owned_name("crash-map-1-12-20261014T083015.123Z.txt", "map"),
        None
    );
    assert_eq!(
        parse_owned_name("crash-map-1-12-20261014T083015.123Z.txt", "map-1"),
        Some(12)
    );
    assert_eq!(parse_owned_name("crash-map-x-20261014T0.txt", "map"), None);
    assert_eq!(
        parse_owned_name("crash-gate-12-20261014T1.txt", "map"),
        None
    );
}

#[test]
fn retention_is_per_label_per_class_and_ignores_unrelated_files() {
    let directory = tempfile::tempdir().unwrap();
    let base = SystemTime::now() - Duration::from_secs(3_600);
    let create = |name: &str, age_rank: u64| {
        let path = directory.path().join(name);
        let file = std::fs::File::create(&path).unwrap();
        file.set_modified(base + Duration::from_secs(age_rank))
            .unwrap();
        path
    };
    let stamp = "20261014T083015.123Z";
    let oldest_report = create(&format!("crash-a-1-{stamp}.txt"), 1);
    create(&format!("crash-a-2-{stamp}.txt"), 2);
    create(&format!("crash-a-3-{stamp}.txt"), 3);
    let oldest_dump = create(&format!("crash-a-1-{stamp}.dmp"), 1);
    create(&format!("crash-a-2-{stamp}.dmp"), 6);
    create(&format!("crash-a-3-{stamp}.dmp"), 7);
    let oldest_core = create("core.111", 1);
    create("core.123", 5);
    create("core.124", 6);
    // 另一个进程名的文件不受本进程上限影响。 / Another label's files are not counted against this label.
    let other = create(&format!("crash-a-1-9-{stamp}.txt"), 0);
    let unrelated = create("notes.txt", 0);
    let removed = enforce_retention_in(directory.path(), "a", 2, 2).unwrap();
    assert_eq!(
        removed,
        report::RetentionOutcome {
            removed: 3,
            reports: 2,
            dumps: 2
        }
    );
    assert!(!oldest_report.exists() && !oldest_dump.exists() && !oldest_core.exists());
    assert!(other.exists() && unrelated.exists());
    assert_eq!(file_names(directory.path()).len(), 8);
    let txt = format!("crash-x-1-{stamp}.txt");
    let dmp = format!("crash-x-1-{stamp}.dmp");
    assert_eq!(classify(&txt, "x"), Some(FileClass::Report));
    assert_eq!(classify(&dmp, "x"), Some(FileClass::Dump));
    assert_eq!(classify("core", "x"), Some(FileClass::Core));
    assert_eq!(classify(&txt, "y"), None);
    assert_eq!(classify("model.dmp", "x"), None);
}

#[test]
fn windows_exit_codes_decode_common_ntstatus_values() {
    for (code, expected) in [
        (0xC000_0005, "NTSTATUS 0xC0000005 (STATUS_ACCESS_VIOLATION"),
        (0xC000_00FD, "NTSTATUS 0xC00000FD (STATUS_STACK_OVERFLOW"),
        (
            0xC000_0409,
            "NTSTATUS 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN",
        ),
        (0xC000_0374, "NTSTATUS 0xC0000374 (STATUS_HEAP_CORRUPTION"),
        (0xC0DE_0001, "NTSTATUS 0xC0DE0001 (unrecognized NTSTATUS"),
        (101, "exit code 101 (Rust panic on the main thread"),
        (
            1,
            "exit code 1 (process returned an error; for a TiangZ Process usually a panic on the process-runtime thread",
        ),
        (0, "exit code 0 (success"),
        (7, "exit code 7"),
    ] {
        let decoded = describe_windows_exit_code(code);
        assert!(decoded.starts_with(expected), "{code:#x}: {decoded}");
    }
    assert_eq!(
        exception_name(0xC000_0005),
        Some("EXCEPTION_ACCESS_VIOLATION")
    );
    assert_eq!(exception_name(0x1234), None);
}

#[test]
fn unix_wait_status_decodes_signal_and_core_flag() {
    assert!(describe_unix_wait_status(11 | 0x80).starts_with("signal 11 (SIGSEGV"));
    assert!(describe_unix_wait_status(11 | 0x80).contains("core dumped"));
    assert!(describe_unix_wait_status(6).contains("SIGABRT"));
    assert!(describe_unix_wait_status(6).contains("no core dump"));
    assert!(describe_unix_wait_status(9).contains("SIGKILL"));
    assert!(describe_unix_wait_status(101 << 8).starts_with("exit code 101 (Rust panic"));
    assert!(describe_unix_wait_status(0).starts_with("exit code 0 (success"));
    assert!(describe_unix_wait_status(0x137f).starts_with("stopped or continued"));
}

#[cfg(windows)]
#[test]
fn platform_exit_status_uses_ntstatus_on_windows() {
    use std::os::windows::process::ExitStatusExt;
    let status = std::process::ExitStatus::from_raw(0xC000_0005);
    assert!(exit_status::describe_exit_status(&status).contains("STATUS_ACCESS_VIOLATION"));
}

#[cfg(unix)]
#[test]
fn platform_exit_status_uses_signals_on_unix() {
    use std::os::unix::process::ExitStatusExt;
    let status = std::process::ExitStatus::from_raw(11 | 0x80);
    let decoded = exit_status::describe_exit_status(&status);
    assert!(
        decoded.contains("SIGSEGV") && decoded.contains("core dumped"),
        "{decoded}"
    );
}

#[cfg(windows)]
fn crash_status() -> std::process::ExitStatus {
    use std::os::windows::process::ExitStatusExt;
    std::process::ExitStatus::from_raw(0xC000_00FD)
}

#[cfg(unix)]
fn crash_status() -> std::process::ExitStatus {
    use std::os::unix::process::ExitStatusExt;
    std::process::ExitStatus::from_raw(11 | 0x80)
}

#[test]
fn exit_record_uses_child_exit_kind_with_decoding_restart_and_related_files() {
    let started = UNIX_EPOCH + Duration::from_secs(1_000);
    let record = ExitRecord {
        process_name: "gate",
        pid: 77,
        started_at: started,
        exited_at: started + Duration::from_millis(1_500),
        status: crash_status(),
        restart: RestartDecision::Scheduled {
            policy: "persistent".to_string(),
            delay_ms: 1_000,
        },
    };
    let text = format_exit_record(
        &record,
        &[
            "crash-gate-77-a.txt".to_string(),
            "crash-gate-77-a.dmp".to_string(),
        ],
    );
    assert!(
        text.starts_with("TiangZ crash report\nformat_version: 1\nprocess: gate\n"),
        "{text}"
    );
    for expected in [
        "\npid: 77\n",
        "\ntime_utc: 1970-01-01T00:16:41.500Z\nkind: child-exit\nreporter: watcher pid ",
        "\nstarted_utc: 1970-01-01T00:16:40.000Z\n",
        "\nuptime_ms: 1500\n",
        "\nrestart: scheduled (persistent, in 1000ms)\n",
        "\nrelated_files: crash-gate-77-a.txt\n  crash-gate-77-a.dmp\n",
        "\n\nrecent_logs: unavailable (",
    ] {
        assert!(text.contains(expected), "missing {expected:?} in\n{text}");
    }
    #[cfg(windows)]
    assert!(
        text.contains("exit_decoded: NTSTATUS 0xC00000FD (STATUS_STACK_OVERFLOW"),
        "{text}"
    );
    #[cfg(unix)]
    assert!(text.contains("exit_decoded: signal 11 (SIGSEGV"), "{text}");
    let none = format_exit_record(
        &ExitRecord {
            restart: RestartDecision::NotConfigured,
            ..record
        },
        &[],
    );
    assert!(
        none.contains("\nrestart: no (restart not configured"),
        "{none}"
    );
    assert!(none.contains("\nrelated_files: none\n"), "{none}");
}

#[test]
fn exit_record_file_lists_files_from_the_same_pid() {
    let directory = tempfile::tempdir().unwrap();
    let mut settings = settings_in(directory.path());
    settings.file_label = "gate".to_string();
    let stamp = "20261014T083015.123Z";
    for name in [
        format!("crash-gate-77-{stamp}.txt"),
        format!("crash-gate-77-{stamp}.dmp"),
        format!("crash-gate-78-{stamp}.txt"),
    ] {
        std::fs::write(directory.path().join(name), "x").unwrap();
    }
    let path = write_exit_record(
        &settings,
        &ExitRecord {
            process_name: "gate",
            pid: 77,
            started_at: SystemTime::now(),
            exited_at: SystemTime::now(),
            status: crash_status(),
            restart: RestartDecision::DuringShutdown,
        },
    )
    .unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(
        path.file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("crash-gate-77-")
    );
    assert!(text.contains(&format!("crash-gate-77-{stamp}.txt")));
    assert!(text.contains(&format!("crash-gate-77-{stamp}.dmp")));
    assert!(!text.contains("crash-gate-78-"));
    assert!(
        text.contains("restart: no (exited during shutdown)"),
        "{text}"
    );
}

#[test]
fn panic_reports_are_rate_limited_except_on_the_main_thread() {
    let limiter = PanicRateLimiter::new();
    let interval = Duration::from_secs(3_600);
    assert_eq!(limiter.admit(false, interval), Some(0));
    assert_eq!(limiter.admit(false, interval), None);
    assert_eq!(limiter.admit(false, interval), None);
    // 主线程 panic 总是写报告，并带上此前被跳过的次数。 / A main-thread panic always reports and carries the skipped count.
    assert_eq!(limiter.admit(true, interval), Some(2));
    assert_eq!(limiter.admit(false, interval), None);
    assert_eq!(limiter.admit(false, Duration::ZERO), Some(1));
}

#[test]
fn self_test_requires_known_mode_and_development_or_test_environment() {
    let development = Some(ProcessEnvironment::Development);
    let test = Some(ProcessEnvironment::Test);
    assert!(
        parse_self_test(None, Some(ProcessEnvironment::Production))
            .unwrap()
            .is_none()
    );
    assert_eq!(
        parse_self_test(Some(" PANIC "), development).unwrap(),
        Some(SelfTestMode::Panic)
    );
    assert_eq!(
        parse_self_test(Some("stack-overflow"), test).unwrap(),
        Some(SelfTestMode::StackOverflow)
    );
    for mode in ["thread-panic", "abort", "access-violation", "oom"] {
        assert!(parse_self_test(Some(mode), test).unwrap().is_some());
    }
    let unknown = parse_self_test(Some("segv"), development).unwrap_err();
    assert!(unknown.to_string().contains("not one of"), "{unknown}");
    for environment in [ProcessEnvironment::Staging, ProcessEnvironment::Production] {
        let error = parse_self_test(Some("panic"), Some(environment)).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("only run in development or test"),
            "{error}"
        );
    }
    // 省略 environment 时缺省为 development，但不能据此放行自测。 / An omitted environment defaults to development but must not unlock self-tests.
    let omitted = parse_self_test(Some("panic"), None).unwrap_err();
    assert!(omitted.to_string().contains("not stated"), "{omitted}");
}

#[test]
fn install_fails_when_the_crash_directory_cannot_be_created() {
    let directory = tempfile::tempdir().unwrap();
    let blocker = directory.path().join("not-a-directory");
    std::fs::write(&blocker, "x").unwrap();
    // 目录创建在设置全局状态与钩子之前失败，因此本测试进程不会被安装任何钩子。
    // Directory creation fails before global state and hooks are set, so this test process gets no hook.
    let error = CrashDiagnostics::new(Some(settings_in(&blocker.join("crash"))))
        .install()
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("failed to create crash directory"),
        "{error}"
    );
    assert!(state().is_none());
}

#[test]
fn retention_counter_scans_only_when_estimate_exceeds_limits() {
    let directory = tempfile::tempdir().unwrap();
    let settings = settings_in(directory.path());
    let counter = report::RetentionCounter::new();
    counter.calibrate(report::RetentionOutcome {
        removed: 0,
        reports: 3,
        dumps: 2,
    });
    assert!(!counter.note_written(FileClass::Report, &settings));
    assert!(counter.note_written(FileClass::Report, &settings));
    assert!(counter.note_written(FileClass::Dump, &settings));
}

const CHILD_MODE_ENV: &str = "TIANGZ_TEST_CRASH_CHILD_MODE";
const CHILD_DIR_ENV: &str = "TIANGZ_TEST_CRASH_CHILD_DIR";
const CHILD_TEST: &str = "crash_diagnostics::tests::crash_child_entry";

/// 子进程入口：父测试设置环境变量后重新执行本测试，安装真实钩子并制造崩溃。
///
/// Child entry: the parent re-executes this test with environment variables, installs the real
/// hooks and crashes on purpose.
#[test]
fn crash_child_entry() {
    let (Ok(mode), Ok(directory)) = (std::env::var(CHILD_MODE_ENV), std::env::var(CHILD_DIR_ENV))
    else {
        return;
    };
    let mut settings = settings_in(Path::new(&directory));
    settings.recent_log_lines = 50;
    settings.max_reports = 50;
    let crash = CrashDiagnostics::new(Some(settings));
    let logging = ProcessLoggingConfig::default();
    let _guard = crate::logging::init(
        Path::new(&directory),
        "child",
        &logging,
        crash.recent_log_layer(),
    )
    .unwrap();
    crash.install().unwrap();
    // V8 延迟任务需要 Tokio 上下文；真实宿主的自测在 tokio main 里运行。 / V8 delayed tasks need a Tokio context; the real host self-test runs inside tokio main.
    let tokio = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let _entered = tokio.enter();
    tracing::warn!(target: "tiangz::test", "child marker before {mode}");
    match mode.as_str() {
        "panic" => panic!("child deliberate panic"),
        "caught-panic" => {
            let caught = std::panic::catch_unwind(|| panic!("contained panic"));
            assert!(caught.is_err());
            tracing::warn!(target: "tiangz::test", "child survived contained panic");
            std::process::exit(0);
        }
        "access-violation" => {
            let _runtime = v8_handlers::self_test_runtime(None);
            unsafe { std::ptr::write_volatile(std::ptr::without_provenance_mut::<u8>(0x10), 1) };
        }
        "oom" => v8_handlers::self_test_out_of_memory(),
        "stack-overflow" => trigger_self_test(SelfTestMode::StackOverflow),
        "runtime-thread-fatal" => {
            // 模拟 process.rs：同一条运行线程先有一次被兜住的 panic，再有致命 panic，主线程 join 到错误后退出码 1。
            // Mirrors process.rs: one contained panic then a fatal one on the runtime thread; the joiner exits with code 1.
            let worker = std::thread::Builder::new()
                .name("process-runtime".to_string())
                .spawn(|| {
                    let caught = std::panic::catch_unwind(|| panic!("contained runtime panic"));
                    if caught.is_ok() {
                        std::process::exit(3);
                    }
                    panic!("fatal runtime panic");
                })
                .unwrap();
            if worker.join().is_err() {
                report_deferred_panic("process runtime thread panicked");
                std::process::exit(1);
            }
            std::process::exit(2);
        }
        #[cfg(windows)]
        "js-access-violation" => {
            let mut runtime = deno_core::JsRuntime::new(deno_core::RuntimeOptions {
                extensions: vec![crash_test_ops::init()],
                ..Default::default()
            });
            register_isolate(runtime.v8_isolate());
            let _ = runtime.execute_script(
                "tiangz:crash-js-access-violation.js",
                "function crashFromJs() { Deno.core.ops.op_crash_test_invalid_write(); } crashFromJs();",
            );
            std::process::exit(2);
        }
        other => panic!("unknown child mode {other}"),
    }
}

struct ChildOutcome {
    status: std::process::ExitStatus,
    output: String,
    files: Vec<PathBuf>,
}

fn run_child(mode: &str) -> (tempfile::TempDir, ChildOutcome) {
    let directory = tempfile::tempdir().unwrap();
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", CHILD_TEST, "--nocapture", "--test-threads=1"])
        .env(CHILD_MODE_ENV, mode)
        .env(CHILD_DIR_ENV, directory.path())
        .env_remove(ENABLE_ENV);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 不创建控制台窗口；错误模式由父进程继承，见 suppress_windows_error_ui。 / No console window; error mode is inherited, see suppress_windows_error_ui.
        command.creation_flags(0x0800_0000);
        suppress_windows_error_ui();
    }
    let output = command.output().unwrap();
    let mut files = std::fs::read_dir(directory.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    files.sort();
    let outcome = ChildOutcome {
        status: output.status,
        output: format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ),
        files,
    };
    (directory, outcome)
}

/// 关闭 Windows 错误报告对话框，避免崩溃子进程卡在界面上；子进程继承该错误模式。
///
/// Suppresses the Windows error-reporting dialog so crashing children never block on UI; children inherit the error mode.
#[cfg(windows)]
fn suppress_windows_error_ui() {
    use windows_sys::Win32::System::Diagnostics::Debug::{
        SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX, SetErrorMode,
    };
    unsafe { SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX) };
}

fn read_reports(files: &[PathBuf], kind: &str) -> Vec<String> {
    files
        .iter()
        .filter(|path| path.extension().is_some_and(|extension| extension == "txt"))
        .map(|path| std::fs::read_to_string(path).unwrap())
        .filter(|text| text.contains(&format!("\nkind: {kind}\n")))
        .collect()
}

#[test]
fn panic_in_child_writes_report_with_backtrace_and_recent_logs() {
    let (_directory, child) = run_child("panic");
    assert!(!child.status.success(), "{}", child.output);
    let reports = read_reports(&child.files, "panic");
    assert_eq!(
        reports.len(),
        1,
        "files {:?}\n{}",
        child.files,
        child.output
    );
    let report = &reports[0];
    for expected in [
        "\nmessage: child deliberate panic\n",
        "\nlocation: src",
        "\n\nbacktrace:\n",
        "crash_child_entry",
        "\n\nrecent_logs: ",
        "child marker before panic",
        "crash diagnostics enabled",
    ] {
        assert!(
            report.contains(expected),
            "missing {expected:?} in\n{report}"
        );
    }
    // 原 panic 钩子仍然执行：标准错误里保留默认 panic 消息。 / The previous hook still runs: stderr keeps the default panic message.
    assert!(child.output.contains("panicked at"), "{}", child.output);
}

#[test]
fn contained_panic_is_reported_and_process_continues() {
    let (_directory, child) = run_child("caught-panic");
    assert!(child.status.success(), "{}", child.output);
    let reports = read_reports(&child.files, "panic");
    assert_eq!(reports.len(), 1, "{:?}", child.files);
    assert!(reports[0].contains("\nmessage: contained panic\n"));
}

#[test]
fn v8_out_of_memory_in_child_writes_reports() {
    let (_directory, child) = run_child("oom");
    assert!(!child.status.success(), "{}", child.output);
    let oom = read_reports(&child.files, "v8-oom");
    assert_eq!(oom.len(), 1, "files {:?}\n{}", child.files, child.output);
    assert!(oom[0].contains("\noom_type: heap\n"), "{}", oom[0]);
    assert!(oom[0].contains("\nused_heap_size: "), "{}", oom[0]);
    assert!(oom[0].contains("child marker before oom"), "{}", oom[0]);
    let near = read_reports(&child.files, "v8-near-heap-limit");
    assert_eq!(near.len(), 1, "files {:?}", child.files);
    assert!(near[0].contains("\ncurrent_heap_limit: "), "{}", near[0]);
}

#[test]
fn fatal_runtime_thread_panic_after_a_reported_one_is_flushed_as_deferred() {
    let (_directory, child) = run_child("runtime-thread-fatal");
    assert_eq!(child.status.code(), Some(1), "{}", child.output);
    let reports = read_reports(&child.files, "panic");
    assert_eq!(
        reports.len(),
        2,
        "files {:?}\n{}",
        child.files,
        child.output
    );
    let contained = reports
        .iter()
        .find(|text| text.contains("\nmessage: contained runtime panic\n"))
        .expect("contained panic report");
    assert!(!contained.contains("\ndeferred: true\n"), "{contained}");
    let fatal = reports
        .iter()
        .find(|text| text.contains("\nmessage: fatal runtime panic\n"))
        .expect("deferred fatal panic report");
    for expected in [
        "\nthread: process-runtime (",
        "\nsuppressed_since_last: 0\ndeferred: true\ndeferred_reason: process runtime thread panicked\n\nbacktrace:\n",
        "crash_child_entry",
    ] {
        assert!(fatal.contains(expected), "missing {expected:?} in\n{fatal}");
    }
    assert!(
        child
            .output
            .contains("crash report suppressed by the rate limit"),
        "{}",
        child.output
    );
}

#[cfg(windows)]
#[deno_core::op2(fast)]
fn op_crash_test_invalid_write() {
    // SAFETY: 不安全且有意为之：在 JS 调用的 op 里制造真实访问违规。 / Deliberately unsound: a real access violation inside an op called from JS.
    unsafe { std::ptr::write_volatile(std::ptr::without_provenance_mut::<u8>(0x10), 1) };
}

#[cfg(windows)]
deno_core::extension!(crash_test_ops, ops = [op_crash_test_invalid_write]);

#[cfg(windows)]
#[test]
fn access_violation_with_js_frames_on_the_stack_reaches_the_filter() {
    let (_directory, child) = run_child("js-access-violation");
    assert_eq!(
        child.status.code().map(|code| code as u32),
        Some(0xC000_0005),
        "{:?}\n{}",
        child.status,
        child.output
    );
    let native = read_reports(&child.files, "native-exception");
    assert_eq!(native.len(), 1, "files {:?}\n{}", child.files, child.output);
    assert!(
        native[0].contains("\naccess_violation: write at 0x0000000000000010\n"),
        "{}",
        native[0]
    );
    let dumps = child
        .files
        .iter()
        .filter(|path| path.extension().is_some_and(|extension| extension == "dmp"))
        .count();
    assert_eq!(dumps, 1, "files {:?}", child.files);
}

#[cfg(windows)]
#[test]
fn stack_overflow_in_child_writes_native_record_from_writer_thread() {
    let (_directory, child) = run_child("stack-overflow");
    assert_eq!(
        child.status.code().map(|code| code as u32),
        Some(0xC000_00FD),
        "{:?}\n{}",
        child.status,
        child.output
    );
    let native = read_reports(&child.files, "native-exception");
    assert_eq!(native.len(), 1, "files {:?}\n{}", child.files, child.output);
    assert!(
        native[0].contains("\nexception_code: 0xC00000FD (EXCEPTION_STACK_OVERFLOW)\n"),
        "{}",
        native[0]
    );
    let dumps = child
        .files
        .iter()
        .filter(|path| path.extension().is_some_and(|extension| extension == "dmp"))
        .count();
    println!("stack-overflow minidumps: {dumps}");
    assert_eq!(dumps, 1, "files {:?}", child.files);
}

#[cfg(windows)]
#[test]
fn access_violation_in_child_writes_minidump_and_text_record() {
    let (_directory, child) = run_child("access-violation");
    assert_eq!(
        child.status.code().map(|code| code as u32),
        Some(0xC000_0005),
        "{:?}\n{}",
        child.status,
        child.output
    );
    let dumps = child
        .files
        .iter()
        .filter(|path| path.extension().is_some_and(|extension| extension == "dmp"))
        .collect::<Vec<_>>();
    assert_eq!(dumps.len(), 1, "files {:?}\n{}", child.files, child.output);
    let bytes = std::fs::read(dumps[0]).unwrap();
    // MDMP 文件头签名，且大小合理。 / MDMP header signature with a plausible size.
    assert_eq!(&bytes[..4], b"MDMP");
    assert!(
        bytes.len() > 64 * 1024,
        "dump unexpectedly small: {}",
        bytes.len()
    );
    println!("minidump size: {} bytes", bytes.len());
    let dump_name = dumps[0].file_name().unwrap().to_str().unwrap();
    let native = read_reports(&child.files, "native-exception");
    assert_eq!(native.len(), 1, "{:?}", child.files);
    for expected in [
        "\nthread_id: ",
        "\nexception_code: 0xC0000005 (EXCEPTION_ACCESS_VIOLATION)\nexception_address: 0x",
        "\naccess_violation: write at 0x0000000000000010\n",
        &format!("\nminidump: {dump_name}\n\nrecent_logs: "),
        "child marker before access-violation",
    ] {
        assert!(
            native[0].contains(expected),
            "missing {expected:?} in\n{}",
            native[0]
        );
    }
}
