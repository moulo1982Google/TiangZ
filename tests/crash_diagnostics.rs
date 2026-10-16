//! 用真实宿主二进制与自测入口验证崩溃诊断：panic 报告、原生异常转储、V8 OOM 与 Watcher 退出记录。
//! Verifies crash diagnostics with the real host binary and its self-test entry: panic reports,
//! native-exception dumps, V8 OOM and Watcher exit records.

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

struct Fixture {
    root: tempfile::TempDir,
}

impl Fixture {
    fn new(crash: Value) -> Self {
        Self::with_environment(crash, "development")
    }

    fn with_environment(crash: Value, environment: &str) -> Self {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("dist")).unwrap();
        std::fs::create_dir(root.path().join("configs")).unwrap();
        let config = json!({
            "process": {
                "name": "crash_probe",
                "environment": environment,
                "diagnostics": { "crash": crash }
            },
            "scenes": [{
                "name": "probe",
                "sceneType": "MapHost",
                "ip": "127.0.0.1",
                "port": 47999
            }]
        });
        std::fs::write(
            root.path().join("configs").join("probe.json"),
            serde_json::to_vec_pretty(&config).unwrap(),
        )
        .unwrap();
        std::fs::write(
            root.path().join("configs").join("StartMachine.json"),
            serde_json::to_vec_pretty(&json!({
                "machines": [{ "name": "local", "innerIp": "127.0.0.1", "processes": ["probe.json"] }]
            }))
            .unwrap(),
        )
        .unwrap();
        Self { root }
    }

    fn crash_dir(&self) -> PathBuf {
        self.root.path().join("crash")
    }

    /// 运行宿主并在 60 秒后强制结束，避免崩溃界面或挂起阻塞测试。 / Runs the host and force-kills it after 60 seconds so crash UI or hangs never block the suite.
    fn run(&self, config: &str, environment: &[(&str, &str)]) -> Output {
        suppress_windows_error_ui();
        let mut command = Command::new(env!("CARGO_BIN_EXE_TiangZ"));
        command
            .arg(Path::new("configs").join(config))
            .arg(format!("--runtime-root={}", self.root.path().display()))
            .current_dir(self.root.path())
            .env_remove("TIANGZ_CRASH_DIAGNOSTICS")
            .env_remove("TIANGZ_CRASH_SELF_TEST")
            .env_remove("RUST_LOG")
            // 保持 stdin 打开：Watcher 把 stdin 结束当作停机命令。 / Keep stdin open: the Watcher treats stdin EOF as a shutdown command.
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in environment {
            command.env(key, value);
        }
        let mut child = command.spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(60);
        while child.try_wait().unwrap().is_none() {
            if Instant::now() >= deadline {
                let _ = child.kill();
                let output = child.wait_with_output().unwrap();
                panic!(
                    "host did not exit within 60s\n{}\n{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        child.wait_with_output().unwrap()
    }

    fn files(&self) -> Vec<PathBuf> {
        let Ok(entries) = std::fs::read_dir(self.crash_dir()) else {
            return Vec::new();
        };
        let mut files = entries
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        files.sort();
        files
    }

    fn reports(&self, prefix: &str, kind: Option<&str>) -> Vec<(String, String)> {
        self.files()
            .into_iter()
            .filter_map(|path| {
                let name = path.file_name()?.to_str()?.to_string();
                (name.starts_with(prefix) && name.ends_with(".txt"))
                    .then(|| (name, std::fs::read_to_string(&path).unwrap()))
            })
            .filter(|(_, text)| kind.is_none_or(|kind| text.contains(&format!("kind: {kind}\n"))))
            .collect()
    }
}

fn describe(output: &Output) -> String {
    format!(
        "status {:?}\nstdout:\n{}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

#[cfg(windows)]
fn suppress_windows_error_ui() {
    use windows_sys::Win32::System::Diagnostics::Debug::{
        SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX, SetErrorMode,
    };
    // 子进程继承错误模式，崩溃时不弹出 Windows 错误报告对话框。 / Children inherit the error mode, so crashes show no WER dialog.
    unsafe { SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX) };
}

#[cfg(not(windows))]
fn suppress_windows_error_ui() {}

#[test]
fn self_test_is_ignored_while_diagnostics_are_disabled() {
    let fixture = Fixture::new(json!({ "enabled": false, "directory": "crash" }));
    let output = fixture.run("probe.json", &[("TIANGZ_CRASH_SELF_TEST", "panic")]);
    // 进程越过自测继续启动，随后因夹具没有 dist 包而失败；不能留下任何崩溃文件。
    // The process moves past the self-test and then fails on the empty dist; no crash file may appear.
    assert!(!output.status.success(), "{}", describe(&output));
    assert!(
        !String::from_utf8_lossy(&output.stderr).contains("deliberate panic"),
        "{}",
        describe(&output)
    );
    assert!(fixture.files().is_empty(), "{:?}", fixture.files());
}

#[test]
fn self_test_outside_development_or_test_refuses_to_start() {
    let fixture = Fixture::with_environment(
        json!({ "enabled": true, "directory": "crash" }),
        "production",
    );
    let output = fixture.run("probe.json", &[("TIANGZ_CRASH_SELF_TEST", "panic")]);
    assert!(!output.status.success(), "{}", describe(&output));
    assert_ne!(output.status.code(), Some(101), "{}", describe(&output));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("only run in development or test"),
        "{}",
        describe(&output)
    );
    assert!(
        fixture
            .reports("crash-crash_probe-", Some("panic"))
            .is_empty(),
        "{:?}",
        fixture.files()
    );
}

#[test]
fn thread_panic_self_test_reports_once_and_rate_limits_the_rest() {
    let fixture = Fixture::new(json!({ "enabled": true, "directory": "crash" }));
    let output = fixture.run("probe.json", &[("TIANGZ_CRASH_SELF_TEST", "thread-panic")]);
    let stderr = String::from_utf8_lossy(&output.stderr);
    // 线程 panic 被 join 吸收后进程继续启动，随后因夹具没有 dist 而以普通错误退出。
    // Joined thread panics let startup continue; it then fails on the empty dist with an ordinary error.
    assert_ne!(output.status.code(), Some(101), "{}", describe(&output));
    let reports = fixture.reports("crash-crash_probe-", Some("panic"));
    assert_eq!(
        reports.len(),
        1,
        "{:?}\n{}",
        fixture.files(),
        describe(&output)
    );
    assert!(
        reports[0].1.contains("\nsuppressed_since_last: 0\n"),
        "{}",
        reports[0].1
    );
    assert_eq!(
        stderr
            .matches("crash report suppressed by the rate limit")
            .count(),
        2,
        "{}",
        describe(&output)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("thread panics contained"),
        "{}",
        describe(&output)
    );
}

#[test]
fn panic_self_test_writes_report_through_real_host() {
    let fixture = Fixture::new(json!({ "enabled": true, "directory": "crash" }));
    let output = fixture.run("probe.json", &[("TIANGZ_CRASH_SELF_TEST", "panic")]);
    assert_eq!(output.status.code(), Some(101), "{}", describe(&output));
    let reports = fixture.reports("crash-crash_probe-", Some("panic"));
    assert_eq!(
        reports.len(),
        1,
        "{:?}\n{}",
        fixture.files(),
        describe(&output)
    );
    let (_, text) = &reports[0];
    for expected in [
        "process: crash_probe",
        "format_version: 1",
        &format!("version: {}", env!("CARGO_PKG_VERSION")),
        "message: TiangZ crash self-test: deliberate panic",
        "\nbacktrace:\n",
        "trigger_self_test",
        "run_self_test_if_requested",
        "crash self-test requested; crashing deliberately",
        "crash diagnostics enabled",
    ] {
        assert!(text.contains(expected), "missing {expected:?} in\n{text}");
    }
}

#[test]
fn environment_override_enables_diagnostics_without_config() {
    let fixture = Fixture::new(json!({ "directory": "crash" }));
    let output = fixture.run(
        "probe.json",
        &[
            ("TIANGZ_CRASH_DIAGNOSTICS", "on"),
            ("TIANGZ_CRASH_SELF_TEST", "panic"),
        ],
    );
    assert_eq!(output.status.code(), Some(101), "{}", describe(&output));
    let reports = fixture.reports("crash-crash_probe-", Some("panic"));
    assert_eq!(reports.len(), 1, "{:?}", fixture.files());
    assert!(
        reports[0].1.contains("enabled_by=Environment"),
        "{}",
        reports[0].1
    );

    let disabled = Fixture::new(json!({ "enabled": true, "directory": "crash" }));
    let output = disabled.run(
        "probe.json",
        &[
            ("TIANGZ_CRASH_DIAGNOSTICS", "off"),
            ("TIANGZ_CRASH_SELF_TEST", "panic"),
        ],
    );
    assert!(!output.status.success());
    assert!(disabled.files().is_empty(), "{:?}", disabled.files());

    // 取值无法识别时与 DBProxy 一致：启动失败、不写任何文件。 / An unrecognized value fails startup like DBProxy and writes nothing.
    let invalid = Fixture::new(json!({ "enabled": true, "directory": "crash" }));
    let output = invalid.run("probe.json", &[("TIANGZ_CRASH_DIAGNOSTICS", "yes")]);
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("use on or off"),
        "{}",
        describe(&output)
    );
    assert!(invalid.files().is_empty(), "{:?}", invalid.files());
}

#[test]
fn v8_oom_self_test_writes_report_through_real_host() {
    let fixture = Fixture::new(json!({ "enabled": true, "directory": "crash" }));
    let output = fixture.run("probe.json", &[("TIANGZ_CRASH_SELF_TEST", "oom")]);
    assert!(!output.status.success(), "{}", describe(&output));
    let oom = fixture.reports("crash-crash_probe-", Some("v8-oom"));
    assert_eq!(oom.len(), 1, "{:?}\n{}", fixture.files(), describe(&output));
    assert!(oom[0].1.contains("oom_type: heap"), "{}", oom[0].1);
    assert_eq!(
        fixture
            .reports("crash-crash_probe-", Some("v8-near-heap-limit"))
            .len(),
        1
    );
    let kinds = fixture
        .reports("crash-crash_probe-", None)
        .into_iter()
        .filter_map(|(_, text)| {
            text.lines()
                .find_map(|line| line.strip_prefix("kind: ").map(str::to_string))
        })
        .collect::<Vec<_>>();
    println!("oom exit: {:?}; report kinds: {kinds:?}", output.status);
}

#[cfg(windows)]
#[test]
fn access_violation_self_test_writes_minidump_through_real_host() {
    let fixture = Fixture::new(json!({
        "enabled": true,
        "directory": "crash",
        "miniDump": true
    }));
    let output = fixture.run(
        "probe.json",
        &[("TIANGZ_CRASH_SELF_TEST", "access-violation")],
    );
    assert_eq!(
        output.status.code().map(|code| code as u32),
        Some(0xC000_0005),
        "{}",
        describe(&output)
    );
    let dumps = fixture
        .files()
        .into_iter()
        .filter(|path| path.extension().is_some_and(|extension| extension == "dmp"))
        .collect::<Vec<_>>();
    assert_eq!(dumps.len(), 1, "{:?}", fixture.files());
    let bytes = std::fs::read(&dumps[0]).unwrap();
    assert_eq!(&bytes[..4], b"MDMP");
    println!("real-host minidump size: {} bytes", bytes.len());
    let native = fixture.reports("crash-crash_probe-", Some("native-exception"));
    assert_eq!(native.len(), 1, "{:?}", fixture.files());
    assert!(
        native[0]
            .1
            .contains("exception_code: 0xC0000005 (EXCEPTION_ACCESS_VIOLATION)"),
        "{}",
        native[0].1
    );
    assert!(
        native[0]
            .1
            .contains(dumps[0].file_name().unwrap().to_str().unwrap()),
        "{}",
        native[0].1
    );
}

#[test]
fn watcher_writes_exit_record_for_crashed_child() {
    let fixture = Fixture::new(json!({ "enabled": true, "directory": "crash", "maxReports": 10 }));
    let output = fixture.run("StartMachine.json", &[("TIANGZ_CRASH_SELF_TEST", "panic")]);
    // 子进程没有配置重启，崩溃后 Watcher 整组收束并以错误退出。 / Without restart config the Watcher stops the group and exits with an error.
    assert!(!output.status.success(), "{}", describe(&output));
    let exits = fixture.reports("crash-crash_probe-", Some("child-exit"));
    assert_eq!(
        exits.len(),
        1,
        "{:?}\n{}",
        fixture.files(),
        describe(&output)
    );
    let (name, text) = &exits[0];
    let panics = fixture.reports("crash-crash_probe-", Some("panic"));
    assert_eq!(panics.len(), 1, "{:?}", fixture.files());
    for expected in [
        "process: crash_probe",
        "exit code 101 (Rust panic",
        "restart: no (restart not configured",
        panics[0].0.as_str(),
    ] {
        assert!(
            text.contains(expected),
            "missing {expected:?} in {name}\n{text}"
        );
    }
    // 退出记录中的 pid 与崩溃报告文件名中的 pid 一致。 / The exit record pid matches the crash report file name.
    let pid = text
        .lines()
        .find_map(|line| line.strip_prefix("pid: "))
        .unwrap();
    assert!(
        panics[0]
            .0
            .starts_with(&format!("crash-crash_probe-{pid}-"))
    );
}
