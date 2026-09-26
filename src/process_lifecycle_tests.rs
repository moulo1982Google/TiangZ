//! 真实 Process、V8 与 Socket 的隔离生命周期验证；仅后端退出原因可控。 / Isolated lifecycle checks with the real process, V8 and sockets; only backend completion is controlled.

use super::*;
use crate::transport_backend::{EndpointTask, IoBackend};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use tokio::time::timeout;

enum ExitKind {
    Error,
    Panic,
    UnexpectedSuccess,
}

struct ControlledBackend {
    actual: Arc<dyn IoBackend>,
    exit: Mutex<Option<oneshot::Receiver<ExitKind>>>,
    started: AtomicUsize,
    resources: Mutex<Option<(ConnectionWriters, Arc<ProcessQueueStats>)>>,
}

impl IoBackend for ControlledBackend {
    fn name(&self) -> &'static str {
        "controlled-test"
    }

    /// 仍绑定生产 listener，只让第一个端点的完成原因由用例控制。 / Binds production listeners and controls only the first endpoint's completion cause.
    fn start_endpoint(&self, context: EndpointContext) -> Result<EndpointTask> {
        *self.resources.lock().unwrap() = Some((context.writers.clone(), context.stats.clone()));
        let scene = context.scene.name.clone();
        let mut actual = self.actual.start_endpoint(context)?;
        self.started.fetch_add(1, Ordering::Relaxed);
        let Some(exit) = self.exit.lock().unwrap().take() else {
            return Ok(actual);
        };
        let (stop, mut stopped) = watch::channel(false);
        Ok(EndpointTask::new(
            scene,
            stop,
            tokio::spawn(async move {
                tokio::select! {
                    reason = exit => match reason.unwrap() {
                        ExitKind::Error => bail!("controlled accept failure"),
                        ExitKind::Panic => panic!("controlled endpoint panic"),
                        ExitKind::UnexpectedSuccess => Ok(()),
                    },
                    _ = stopped.changed() => { actual.request_stop(); actual.await },
                    result = &mut actual => result,
                }
            }),
        ))
    }
}

/// 构造隔离 V8 入口夹具及其有效哈希，不依赖仓库 dist 或 Node/codegen。 / Creates isolated V8 entrypoints and valid fixture hashes without repository dist or Node/codegen.
fn runtime_fixture(pending_stop: bool) -> tempfile::TempDir {
    let mut model = String::from(
        r#"
        for (const name of ['__etsStartProcess', '__etsUpdateBinary', '__etsDispatchHostEvents',
            '__etsBeginHotfix', '__etsCommitHotfix', '__etsAbortHotfix']) globalThis[name] = () => '{}';
        globalThis.__etsUpdateBinary = sample => sample ? '{}' : '0';
        globalThis.__etsDispatchHostEvents = () => globalThis.__hostTakeEventBatch();
    "#,
    );
    model.push_str(if pending_stop {
        "globalThis.__etsStopProcess = () => new Promise(() => {});"
    } else {
        "globalThis.__etsStopProcess = () => 'stopped';"
    });
    runtime_fixture_with_model(model)
}

/// 复用真实指纹夹具，只由用例指定 JS 边界断言。 / Reuses validated fixture fingerprints with test-specific JS boundary assertions.
pub(super) fn runtime_fixture_with_model(model: String) -> tempfile::TempDir {
    let fixture = tempfile::tempdir().unwrap();
    let dist = fixture.path().join("dist");
    let data = dist.join("game-config");
    std::fs::create_dir_all(&data).unwrap();
    let hash = |bytes: &[u8]| format!("{:x}", Sha256::digest(bytes));
    let identity = hash(b"process-lifecycle-fixture");
    let pair = hash(b"{}\0{}");
    let mut data_manifest = json!({
        "formatVersion": 2, "schemaFingerprint": identity, "clientSchemaFingerprint": identity,
        "dataFingerprint": pair, "hotDataFingerprint": pair, "coldDataFingerprint": pair,
        "reloadPolicies": { "hot": [], "cold": [] }
    });
    for (field, name) in [
        ("server", "server"),
        ("serverHot", "server.hot"),
        ("serverCold", "server.cold"),
        ("client", "client"),
        ("clientHot", "client.hot"),
        ("clientCold", "client.cold"),
    ] {
        std::fs::write(data.join(format!("{name}.json")), "{}").unwrap();
        data_manifest[format!("{field}File")] = json!(format!("{name}.json"));
        data_manifest[format!("{field}Hash")] = json!(hash(b"{}"));
    }
    let data_manifest = data_manifest.to_string();
    std::fs::write(data.join("game-config.manifest.json"), &data_manifest).unwrap();
    let hotfix_source = "void 0;";
    let model_hash = hash(model.as_bytes());
    let hotfix_hash = hash(hotfix_source.as_bytes());
    let config_hash = hash(data_manifest.as_bytes());
    let model_manifest = json!({
        "formatVersion": 1, "modelFingerprint": model_hash,
        "modelSourceHash": identity, "protocolFingerprint": identity, "stableCoreApiHash": identity,
        "nativeSchemaHash": identity, "gameConfigSchemaFingerprint": identity,
        "moduleGraphHash": "", "buildMode": "modules"
    });
    let release = hash(
        [
            "fixture",
            &hotfix_hash,
            &config_hash,
            &model_hash,
            &identity,
            &identity,
            &identity,
            &identity,
            &identity,
            "",
            "modules",
        ]
        .join(":")
        .as_bytes(),
    );
    let mut hotfix_manifest = model_manifest.clone();
    hotfix_manifest["bundleVersion"] = json!(format!("fixture+{release}"));
    hotfix_manifest["releaseId"] = json!(release);
    hotfix_manifest["hotfixHash"] = json!(hotfix_hash);
    hotfix_manifest["gameConfigHash"] = json!(config_hash);
    for (name, content) in [
        ("model.js", model),
        ("hotfix.js", hotfix_source.to_owned()),
        ("model.manifest.json", model_manifest.to_string()),
        ("hotfix.manifest.json", hotfix_manifest.to_string()),
    ] {
        std::fs::write(dist.join(name), content).unwrap();
    }
    RuntimeBundles::load(fixture.path())
        .expect("lifecycle fixture must pass actual bundle validation");
    fixture
}

/// 先同时预留端口以免同一配置误用相同端口，再交给真实 Process 绑定。 / Reserves distinct ports together before handing them to the real process.
fn process_config() -> (RuntimeConfig, [u16; 3]) {
    let reservations: Vec<_> = (0..3)
        .map(|_| std::net::TcpListener::bind("127.0.0.1:0").unwrap())
        .collect();
    let ports: [u16; 3] = std::array::from_fn(|i| reservations[i].local_addr().unwrap().port());
    let config: RuntimeConfig = serde_json::from_value(json!({
        "process": { "name": "lifecycle-fixture", "identity": { "originServerId": 91, "workerId": 0 },
            "lifecycle": { "stopTimeoutMs": 100 },
            "observability": { "health": { "ip": "127.0.0.1", "port": ports[0] } } },
        "scenes": [
            { "name": "first", "sceneType": "Fixture", "innerIp": "127.0.0.1", "port": ports[1], "protocol": "tcp", "audience": "outer" },
            { "name": "second", "sceneType": "Fixture", "innerIp": "127.0.0.1", "port": ports[2], "protocol": "tcp", "audience": "outer" }
        ]
    })).unwrap();
    (config, ports)
}

/// 发出真实 HTTP 探针，单次请求和外层等待都有期限。 / Sends a real HTTP probe with per-request and outer deadlines.
async fn probe(port: u16, path: &str) -> Result<String> {
    timeout(Duration::from_millis(250), async {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await?;
        stream
            .write_all(
                format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .await?;
        let mut response = String::new();
        stream.read_to_string(&mut response).await?;
        Ok(response)
    })
    .await?
}

/// 等待可观察状态，不用固定睡眠假设 V8/任务已经完成。 / Waits for observable state instead of assuming V8/tasks completed after a fixed sleep.
async fn wait_probe(port: u16, status: &str, process: &mut tokio::task::JoinHandle<Result<()>>) {
    let observed = timeout(Duration::from_secs(5), async {
        loop {
            if probe(port, "/ready")
                .await
                .is_ok_and(|body| body.starts_with(status))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    });
    tokio::select! {
        result = process => panic!("Process exited before {status}: {result:?}"),
        result = observed => result.unwrap_or_else(|_| panic!("did not observe {status} on port {port}")),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn process_partial_start_failure_reclaims_health_and_preceding_listener_without_exiting_os_process()
 {
    let fixture = runtime_fixture(false);
    let (config, ports) = process_config();
    let _occupied = std::net::TcpListener::bind(("127.0.0.1", ports[2])).unwrap();
    let backend = Arc::new(ControlledBackend {
        actual: create_io_backend(&config.process.network).unwrap(),
        exit: Mutex::new(None),
        started: AtomicUsize::new(0),
        resources: Mutex::new(None),
    });
    let result = timeout(
        Duration::from_secs(3),
        run_runtime_config_with_backend(
            fixture.path(),
            &fixture.path().join("process.json"),
            config,
            |_| Ok(backend.clone()),
        ),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert!(
        format!("{result:#}").contains("failed to start process endpoints"),
        "{result:#}"
    );
    assert_eq!(backend.started.load(Ordering::Relaxed), 1);
    // Tokio 运行时和测试 OS 进程仍然活着，端口可重绑才证明显式回滚。
    // The Tokio runtime and OS process remain alive; rebinding proves explicit rollback.
    let _health = std::net::TcpListener::bind(("127.0.0.1", ports[0])).unwrap();
    let _first = std::net::TcpListener::bind(("127.0.0.1", ports[1])).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn process_endpoint_failure_withdraws_real_readiness_and_reclaims_all_listeners() {
    const CASE_ENV: &str = "TIANGZ_TEST_PROCESS_LIFECYCLE_CASE";
    const TEST_NAME: &str = "process::lifecycle_tests::process_endpoint_failure_withdraws_real_readiness_and_reclaims_all_listeners";
    let selected = match std::env::var(CASE_ENV) {
        Ok(value) => value
            .parse::<usize>()
            .expect("invalid lifecycle fixture case"),
        Err(std::env::VarError::NotPresent) => {
            // 每个故障场景拥有独立 V8 平台和 OS 进程；端口重绑断言仍在子进程退出前执行。
            // Each fault scenario owns one V8 platform/OS process; rebinding assertions still precede child exit.
            for case in 0..3 {
                let mut child = tokio::process::Command::new(std::env::current_exe().unwrap());
                child
                    .args(["--exact", TEST_NAME, "--nocapture"])
                    .env(CASE_ENV, case.to_string())
                    .kill_on_drop(true);
                #[cfg(windows)]
                child.creation_flags(0x0800_0000);
                let output = timeout(Duration::from_secs(15), child.output())
                    .await
                    .expect("lifecycle child exceeded its watchdog")
                    .unwrap();
                assert!(
                    output.status.success(),
                    "lifecycle case {case} exited {}\n{}\n{}",
                    output.status,
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
                assert!(
                    String::from_utf8_lossy(&output.stdout)
                        .contains("test result: ok. 1 passed; 0 failed;"),
                    "lifecycle child must actually execute its selected test: {}",
                    String::from_utf8_lossy(&output.stdout)
                );
            }
            return;
        }
        Err(error) => panic!("invalid lifecycle fixture environment: {error}"),
    };
    assert!(selected < 3, "invalid lifecycle fixture case");
    for (index, (reason, message)) in [
        (ExitKind::Error, "controlled accept failure"),
        (ExitKind::Panic, "task failed"),
        (
            ExitKind::UnexpectedSuccess,
            "network endpoint exited unexpectedly",
        ),
    ]
    .into_iter()
    .enumerate()
    {
        if index != selected {
            continue;
        }
        let fixture = runtime_fixture(true);
        let (config, ports) = process_config();
        let (fail, failed) = oneshot::channel();
        let backend = Arc::new(ControlledBackend {
            actual: create_io_backend(&config.process.network).unwrap(),
            exit: Mutex::new(Some(failed)),
            started: AtomicUsize::new(0),
            resources: Mutex::new(None),
        });
        let root = fixture.path().to_owned();
        let owned = backend.clone();
        let mut process = tokio::spawn(async move {
            run_runtime_config_with_backend(&root, &root.join("process.json"), config, |_| {
                Ok(owned)
            })
            .await
        });
        wait_probe(ports[0], "HTTP/1.1 200", &mut process).await;
        let mut active = TcpStream::connect(("127.0.0.1", ports[1])).await.unwrap();
        active.write_u32(2).await.unwrap();
        let mut handshake = TcpStream::connect(("127.0.0.1", ports[2])).await.unwrap();
        let (writers, stats) = backend.resources.lock().unwrap().clone().unwrap();
        timeout(Duration::from_secs(1), async {
            while stats.admission.snapshot().connections != 2
                || stats.admission.snapshot().handshakes != 1
                || writers.lock().unwrap().len() != 1
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(fail.send(reason).is_ok());
        wait_probe(ports[0], "HTTP/1.1 503", &mut process).await;
        assert!(
            probe(ports[0], "/live")
                .await
                .unwrap()
                .starts_with("HTTP/1.1 200")
        );
        let error = timeout(Duration::from_secs(4), process)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(format!("{error:#}").contains(message), "{error:#}");
        assert_eq!(stats.admission.snapshot().connections, 0);
        assert_eq!(stats.admission.snapshot().handshakes, 0);
        assert!(writers.lock().unwrap().is_empty());
        for socket in [&mut active, &mut handshake] {
            let read = timeout(Duration::from_secs(1), socket.read(&mut [0]))
                .await
                .unwrap();
            assert!(
                matches!(read, Ok(0))
                    || matches!(read, Err(ref error) if error.kind() == std::io::ErrorKind::ConnectionReset)
            );
        }
        for port in ports {
            let _rebound = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
        }
    }
}
