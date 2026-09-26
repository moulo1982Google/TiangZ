//! 用真实 V8 验证普通 Host 操作的调度和时钟边界。 / Verifies ordinary Host operation scheduling and clock boundaries through real V8.

use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

fn operation(id: u32, kind: u8, ms: u32, frame: Bytes) -> HostSceneOperation {
    HostSceneOperation {
        backing_reservation: None,
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

#[test]
fn completion_reservation_failure_rolls_back_the_whole_unexecuted_batch() {
    use event_admission::{EVENT_OVERHEAD, EventAdmission};
    let capacity = HOST_CALL_MAX_FRAME_LEN + EVENT_OVERHEAD;
    let budget = EventAdmission::with_capacity(capacity);
    let mut operations = vec![
        operation(1, 3, 0, Bytes::new()),
        operation(2, 1, 1000, Bytes::new()),
    ];
    assert!(
        reserve_scene_completions(&mut operations, &budget)
            .unwrap_err()
            .to_string()
            .contains("[scene-overloaded]")
    );
    assert!(
        operations
            .iter()
            .all(|item| item.backing_reservation.is_none())
    );
    assert_eq!(budget.snapshot().used_bytes, 0);
    let mut operations = vec![
        operation(0, 2, 1000, Bytes::new()),
        operation(3, 1, 1000, Bytes::new()),
    ];
    reserve_scene_completions(&mut operations, &budget).unwrap();
    assert!(
        operations[0].backing_reservation.is_none(),
        "one-way send has no completion"
    );
    assert_eq!(budget.snapshot().used_bytes, capacity as u64);
    drop(operations);
    assert_eq!(budget.snapshot().used_bytes, 0);
}

#[tokio::test]
async fn completion_byte_guards_cover_execution_backpressure_expiry_and_cancellation() {
    use event_admission::{EVENT_OVERHEAD, EventAdmission};
    let budget = EventAdmission::new();
    let mut operations = vec![
        operation(1, 1, 1000, Bytes::new()),
        operation(2, 1, 1, Bytes::new()),
        operation(3, 3, 0, Bytes::new()),
    ];
    reserve_scene_completions(&mut operations, &budget).unwrap();
    let (sender, mut receiver) = tokio::sync::mpsc::channel(4);
    let sink: HostSceneCompletionSink = Arc::new(move |completion| {
        sender
            .try_send(completion)
            .map_err(|error| error.into_inner())
    });
    let submitted = tokio::time::Instant::now() - Duration::from_millis(10);
    scene_operations::run_with_executor(operations, sink, submitted, |job| async move {
        assert_eq!(
            job.operation.operation_id, 1,
            "expired call must never execute"
        );
        Some(HostSceneCompletion {
            backing_reservation: None,
            operation_id: 1,
            result: Ok(vec![7; 23]),
        })
    })
    .await;
    let mut held = Vec::new();
    let mut actual = 0;
    for _ in 0..3 {
        let completion = receiver.recv().await.unwrap();
        let bytes = match &completion.result {
            Ok(bytes) => bytes.len(),
            Err(error) => error.len(),
        };
        actual += bytes + EVENT_OVERHEAD;
        held.push(completion);
    }
    assert_eq!(
        budget.snapshot().used_bytes,
        actual as u64,
        "Native completion channel still owns the shrunken reservations"
    );
    drop(held);
    assert_eq!(budget.snapshot().used_bytes, 0);

    let mut operations = vec![operation(4, 1, 1000, Bytes::new())];
    reserve_scene_completions(&mut operations, &budget).unwrap();
    let observed = Arc::clone(&budget);
    let sink: HostSceneCompletionSink = Arc::new(move |completion| {
        assert_eq!(
            observed.snapshot().used_bytes,
            (completion.result.as_ref().unwrap_err().len() + EVENT_OVERHEAD) as u64
        );
        let error = completion.result.as_ref().unwrap_err();
        assert!(
            error.capacity() <= 4096,
            "truncating text must release its original oversized Native allocation"
        );
        assert!(error.ends_with(" [truncated]"));
        assert!(error.len() <= 4096);
        Err(completion)
    });
    let mut task = Box::pin(scene_operations::run_with_executor(
        operations,
        sink,
        tokio::time::Instant::now(),
        |_| async {
            Some(HostSceneCompletion {
                backing_reservation: None,
                operation_id: 4,
                result: Err("错".repeat(10000)),
            })
        },
    ));
    assert!(futures_util::poll!(&mut task).is_pending());
    assert!(budget.snapshot().used_bytes > 0);
    drop(task);
    assert_eq!(
        budget.snapshot().used_bytes,
        0,
        "cancelled blocked delivery releases its original completion"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v8_native_scene_batch_slots_are_shared_until_the_original_batch_drains() {
    const CASE_ENV: &str = "TIANGZ_TEST_NATIVE_SCENE_BATCH_CASE";
    const TEST_NAME: &str = "host::scene_operations_tests::v8_native_scene_batch_slots_are_shared_until_the_original_batch_drains";
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
    let release = Arc::new(AtomicBool::new(false));
    let completed = Arc::new(AtomicUsize::new(0));
    let allowed = Arc::clone(&release);
    let count = Arc::clone(&completed);
    let (blocked_tx, blocked_rx) = std::sync::mpsc::sync_channel(1);
    let sink: HostSceneCompletionSink = Arc::new(move |completion| {
        if !allowed.load(Ordering::SeqCst) {
            let _ = blocked_tx.try_send(());
            return Err(completion);
        }
        assert!(completion.result.is_ok());
        count.fetch_add(1, Ordering::SeqCst);
        Ok(())
    });
    let host_runtime = Handle::current();
    tokio::task::spawn_blocking(move || {
        let mut runtime = create_runtime(false, 0).unwrap();
        let batches = scene_operations::BatchAdmission::new();
        let buffers = BufferBudget::new(64 * 1024 * 1024);
        configure_host_scene_bridge(host_runtime, sink, Arc::clone(&buffers), Arc::clone(&batches), event_admission::EventAdmission::new());
        runtime.execute_script("test:native-batch-invalid", r#"
          const makeSleepBatch = (count) => {
            const packed = new Uint8Array(4 + count * 17), view = new DataView(packed.buffer);
            view.setUint32(0, count, true);
            for (let index = 0; index < count; index++) {
              view.setUint32(4 + index * 17, index + 1, true);
              packed[12 + index * 17] = 3;
            }
            return packed;
          };
          const rejectBatch = (packed, clock, expected) => {
            let rejected = false;
            try { __hostSubmitSceneOperations(packed, clock); }
            catch (error) { rejected = String(error).includes(expected); }
            if (!rejected) throw new Error('invalid batch accepted: ' + expected);
          };
          const forged = new Uint8Array(4); new DataView(forged.buffer).setUint32(0, 65536, true);
          rejectBatch(forged, __hostSceneNowMs(), 'truncated host scene operation metadata');
          const badKind = makeSleepBatch(1); badKind[12] = 4;
          rejectBatch(badKind, __hostSceneNowMs(), 'invalid host scene operation id or kind');
          const badRoute = new Uint8Array(23), routeView = new DataView(badRoute.buffer);
          routeView.setUint32(0, 1, true); routeView.setUint32(8, 1, true); badRoute[12] = 2; routeView.setUint32(17, 2, true);
          rejectBatch(badRoute, __hostSceneNowMs(), 'unknown host scene route');
          rejectBatch(makeSleepBatch(1), NaN, 'submission clock');
        "#).unwrap();
        assert_eq!(batches.snapshot().reserved_slots, 0);
        assert_eq!(buffers.snapshot().used_bytes, 0);
        assert_eq!(completed.load(Ordering::SeqCst), 0);
        runtime.execute_script("test:native-batch-full", "if (__hostSubmitSceneOperations(makeSleepBatch(65536), __hostSceneNowMs()) !== 65536) throw new Error('maximum original batch not accepted');").unwrap();
        blocked_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(completed.load(Ordering::SeqCst), 0);
        assert_eq!(batches.snapshot().reserved_slots, 65536);
        runtime.execute_script("test:native-batch-reject", r#"
          let rejected = false;
          try { __hostSubmitSceneOperations(makeSleepBatch(1), __hostSceneNowMs()); }
          catch (error) { rejected = String(error).includes('[scene-overloaded]') && String(error).includes('batch slot capacity'); }
          if (!rejected) throw new Error('new Native batch was accepted while 65536 original slots were retained');
        "#).unwrap();
        assert_eq!(batches.snapshot().reserved_slots, 65536);
        assert_eq!(batches.snapshot().rejections, 1);
        assert_eq!(buffers.snapshot().rejections, 0);
        release.store(true, Ordering::SeqCst);
        let until = std::time::Instant::now() + Duration::from_secs(3);
        while batches.snapshot().reserved_slots > 0 && std::time::Instant::now() < until {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(batches.snapshot().reserved_slots, 0);
        assert_eq!(completed.load(Ordering::SeqCst), 65536);
        runtime.execute_script("test:native-batch-recovery", "if (__hostSubmitSceneOperations(makeSleepBatch(1), __hostSceneNowMs()) !== 1) throw new Error('new batch did not recover');").unwrap();
        let until = std::time::Instant::now() + Duration::from_secs(2);
        while batches.snapshot().reserved_slots > 0 && std::time::Instant::now() < until {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(completed.load(Ordering::SeqCst), 65537);
        assert_eq!(batches.snapshot().reserved_slots, 0);
        assert_eq!(batches.snapshot().max_reserved_slots, 65536);
        assert_eq!(buffers.snapshot().used_bytes, 0);
    }).await.unwrap();
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
                    backing_reservation: None,
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
        configure_host_scene_bridge(runtime_handle, sink, retained, scene_operations::BatchAdmission::new(), event_admission::EventAdmission::new());
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
