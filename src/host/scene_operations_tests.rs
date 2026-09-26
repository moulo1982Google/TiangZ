//! 用真实 V8 验证普通 Host 操作的调度和时钟边界。 / Verifies ordinary Host operation scheduling and clock boundaries through real V8.

use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

fn operation(id: u32, kind: u8, ms: u32, frame: Bytes) -> HostSceneOperation {
    HostSceneOperation {
        operation_id: id,
        kind,
        timeout_ms: ms,
        frame,
        route: (kind != 3).then(|| HostSceneRoute {
            source_name: "source".into(),
            target_name: "target".into(),
            target_ip: "127.0.0.1".into(),
            target_port: 1,
        }),
    }
}

#[test]
fn submission_clock_rejects_invalid_and_future_samples_without_renewing_past_time() {
    let sampled = scene_operations::now_ms();
    let original = scene_operations::submitted_at(sampled).unwrap();
    std::thread::sleep(Duration::from_millis(10));
    assert_eq!(scene_operations::submitted_at(sampled).unwrap(), original);
    assert!(original.elapsed() >= Duration::from_millis(10));
    for invalid in [
        f64::NAN,
        f64::INFINITY,
        -1.0,
        0.5,
        scene_operations::now_ms() + 100000.0,
    ] {
        assert!(scene_operations::submitted_at(invalid).is_err());
    }
}

#[tokio::test]
async fn unstarted_short_operations_expire_while_all_network_slots_are_held() {
    let mut operations: Vec<_> = (1..=256)
        .map(|id| operation(id, 1, 2000, Bytes::from_static(&[1, 2])))
        .collect();
    operations.push(operation(257, 1, 40, Bytes::from_static(&[1, 2])));
    operations.push(operation(0, 2, 40, Bytes::from_static(&[1, 2])));
    operations.push(operation(259, 3, 60, Bytes::new()));
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let started = Arc::new(AtomicUsize::new(0));
    let (started_tx, mut started_rx) = tokio::sync::mpsc::channel(256);
    let (done_tx, mut done_rx) = tokio::sync::mpsc::channel(512);
    let sink: HostSceneCompletionSink = Arc::new(move |completion| {
        done_tx
            .try_send(completion)
            .map_err(|error| error.into_inner())
    });
    let executing = Arc::clone(&gate);
    let count = Arc::clone(&started);
    let runner = scene_operations::run_with_executor(
        operations,
        sink,
        tokio::time::Instant::now(),
        move |job| {
            let gate = Arc::clone(&executing);
            let count = Arc::clone(&count);
            let started_tx = started_tx.clone();
            async move {
                assert!(
                    (1..=256).contains(&job.operation.operation_id),
                    "expired work was executed"
                );
                count.fetch_add(1, Ordering::SeqCst);
                started_tx.try_send(()).unwrap();
                let _permit = gate.acquire_owned().await.unwrap();
                Some(HostSceneCompletion {
                    operation_id: job.operation.operation_id,
                    result: Ok(Vec::new()),
                })
            }
        },
    );
    let check = async {
        for _ in 0..256 {
            started_rx.recv().await.unwrap();
        }
        for id in [257, 259] {
            let done = tokio::time::timeout(Duration::from_millis(400), done_rx.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(done.operation_id, id);
            assert_eq!(done.result.is_ok(), id == 259);
        }
        assert_eq!(started.load(Ordering::SeqCst), 256);
        gate.add_permits(256);
        let mut completed = std::collections::HashSet::new();
        for _ in 0..256 {
            let done = done_rx.recv().await.unwrap();
            assert!(done.result.is_ok());
            assert!(completed.insert(done.operation_id));
        }
        assert_eq!(completed.len(), 256);
    };
    tokio::time::timeout(Duration::from_secs(3), async {
        tokio::join!(runner, check);
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn completion_backpressure_preserves_unprocessed_slots_and_last_packet_ownership() {
    let budget = BufferBudget::new(64);
    let packet = reserve_scene_packet(&[0; 64], &budget).unwrap();
    let operations = vec![
        operation(1, 1, 1, packet.slice(4..6)),
        operation(2, 1, 1, packet.slice(6..8)),
    ];
    drop(packet);
    let allowed = Arc::new(AtomicBool::new(false));
    let permitted = Arc::clone(&allowed);
    let (attempt_tx, mut attempt_rx) = tokio::sync::mpsc::channel(1);
    let (done_tx, mut done_rx) = tokio::sync::mpsc::channel(2);
    let sink: HostSceneCompletionSink = Arc::new(move |completion| {
        if !permitted.load(Ordering::SeqCst) {
            let _ = attempt_tx.try_send(());
            return Err(completion);
        }
        done_tx
            .try_send(completion)
            .map_err(|error| error.into_inner())
    });
    let runner = scene_operations::run_with_executor(
        operations,
        sink,
        tokio::time::Instant::now() - Duration::from_secs(1),
        |_| async { panic!("expired operation reached execution") },
    );
    let check = async {
        attempt_rx.recv().await.unwrap();
        assert_eq!(
            budget.snapshot().used_bytes,
            64,
            "second unprocessed slot must retain its packet"
        );
        allowed.store(true, Ordering::SeqCst);
        for id in [1, 2] {
            let completion = done_rx.recv().await.unwrap();
            assert_eq!(completion.operation_id, id);
            assert!(completion.result.is_err());
        }
    };
    tokio::time::timeout(Duration::from_secs(3), async {
        tokio::join!(runner, check);
    })
    .await
    .unwrap();
    assert_eq!(budget.snapshot().used_bytes, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v8_host_sleeps_do_not_hold_network_execution_slots() {
    const CASE_ENV: &str = "TIANGZ_TEST_REMOTE_DEADLINE_CASE";
    const TEST_NAME: &str =
        "host::scene_operations_tests::v8_host_sleeps_do_not_hold_network_execution_slots";
    if std::env::var(CASE_ENV).as_deref() != Ok("v8") {
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", TEST_NAME, "--nocapture"])
            .env(CASE_ENV, "v8")
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let output = tokio::time::timeout(Duration::from_secs(15), command.output())
            .await
            .unwrap()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout)
                .contains("test result: ok. 1 passed; 0 failed;")
        );
        return;
    }
    let (sender, mut receiver) = tokio::sync::mpsc::channel(512);
    let sink: HostSceneCompletionSink = Arc::new(move |completion| {
        sender
            .try_send(completion)
            .map_err(|error| error.into_inner())
    });
    let runtime_handle = Handle::current();
    let budget = BufferBudget::new(64 * 1024 * 1024);
    let retained = Arc::clone(&budget);
    tokio::task::spawn_blocking(move || {
        let mut runtime = create_runtime(false, 0).unwrap();
        configure_host_scene_bridge(runtime_handle, sink, retained);
        runtime.execute_script("test:queued-sleep", r#"
          const clock = __hostSceneNowMs();
          if (!Number.isSafeInteger(clock) || clock < 0 || __hostSceneNowMs() < clock) throw new Error('invalid monotonic clock');
          const invalid = new Uint8Array(21), invalidView = new DataView(invalid.buffer);
          invalidView.setUint32(0, 1, true); invalidView.setUint32(4, 1, true); invalid[12] = 3;
          for (const sample of [NaN, Infinity, -1, 0.5, clock + 100000]) {
            let rejected = false;
            try { __hostSubmitSceneOperations(invalid, sample); }
            catch (error) { rejected = String(error).includes('submission clock'); }
            if (!rejected) throw new Error('invalid submission clock accepted');
          }
          const route = __hostRegisterSceneRoute('source', 'target', '127.0.0.1', 1);
          const packed = new Uint8Array(4 + 257 * 17 + 2), view = new DataView(packed.buffer);
          view.setUint32(0, 257, true);
          let offset = 4;
          for (let id = 1; id <= 257; id++) {
            view.setUint32(offset, id, true);
            view.setUint32(offset + 4, id === 257 ? route : 0, true);
            packed[offset + 8] = id === 257 ? 1 : 3;
            view.setUint32(offset + 9, id === 257 ? 5 : 1000, true);
            view.setUint32(offset + 13, id === 257 ? 2 : 0, true);
            offset += 17;
            if (id === 257) { packed.set([78, 33], offset); offset += 2; }
          }
          // 旧桥没有时钟，额外实参被忽略；用于保存同一行为反例。 / The old bridge ignores the extra argument, preserving the same behavioral counterexample.
          __hostSubmitSceneOperations(packed, globalThis.__hostSceneNowMs ? __hostSceneNowMs() : 0);
        "#).unwrap();
    }).await.unwrap();
    let first = tokio::time::timeout(Duration::from_millis(400), receiver.recv())
        .await
        .expect("short RPC waited behind 256 ordinary sleeps")
        .unwrap();
    assert_eq!(first.operation_id, 257);
    assert!(first.result.is_err()); // 无网络管理器或已到期都不得被普通 sleep 阻塞。 / Neither unavailable transport nor expiry may be delayed behind sleeps.
    let mut ids = std::collections::HashSet::new();
    tokio::time::timeout(Duration::from_secs(2), async {
        for _ in 0..256 {
            let completion = receiver.recv().await.unwrap();
            assert!((1..=256).contains(&completion.operation_id));
            assert!(completion.result.is_ok());
            assert!(ids.insert(completion.operation_id));
        }
    })
    .await
    .unwrap();
    assert_eq!(ids.len(), 256);
    assert_eq!(budget.snapshot().used_bytes, 0);
}
