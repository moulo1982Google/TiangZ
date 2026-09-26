//! 验证控制名额的真实 V8 转交、队列退出及独立完成通路。 / Verifies actual V8 handoff, receiver teardown and independent completions.

use super::control_ingress::{ControlAdmission, PublishedControls};
use super::*;
use crate::host::event_buffer::HostEventPayload;

fn channel(capacity: usize) -> (ProcessEventSender, ProcessEventReceiver) {
    let (control_sender, control_receiver) = mpsc::sync_channel(4);
    let (data_sender, data_receiver) = mpsc::sync_channel(4);
    let (wake_sender, wake_receiver) = mpsc::sync_channel(1);
    let stats = Arc::new(ProcessQueueStats {
        control_admission: ControlAdmission::with_capacity(capacity),
        ..ProcessQueueStats::default()
    });
    let receiver = ProcessEventReceiver::new(
        control_receiver,
        data_receiver,
        wake_receiver,
        Arc::clone(&stats.control_admission),
    );
    (
        ProcessEventSender {
            control_sender,
            data_sender,
            wake_sender,
            stats,
        },
        receiver,
    )
}

fn disconnect(id: u64) -> ProcessEvent {
    ProcessEvent::Disconnect {
        control_reservation: None,
        scene_index: 0,
        connection_id: id,
    }
}

fn pack(receiver: &mut ProcessEventReceiver, stats: &ProcessQueueStats) -> HostEventPayload {
    let mut batch = HostEventBatch::new();
    while let Ok(event) = receiver.try_recv() {
        stats.dequeue(event.kind(), event.ingress_class());
        assert!(batch.try_push(event, stats).unwrap().is_none());
    }
    batch.into_payload(stats)
}

#[tokio::test]
async fn control_ingress_receiver_drop_wakes_prequeue_disconnect_and_releases_queued_guard() {
    let (sender, receiver) = channel(1);
    sender.send(disconnect(1), None).await.unwrap();
    let mut waiting = Box::pin(sender.send(disconnect(2), None));
    assert!(futures_util::poll!(&mut waiting).is_pending());
    drop(receiver);
    assert!(waiting.await.unwrap_err().contains("stopped"));
    assert_eq!(sender.stats.control_admission.snapshot().reserved, 0);
    assert_eq!(sender.stats.control_admission.snapshot().waits, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn control_ingress_real_v8_retains_slots_until_ack_and_completion_bypasses_full_quota() {
    const CASE_ENV: &str = "TIANGZ_TEST_CONTROL_INGRESS_V8";
    const TEST_NAME: &str = "process::control_ingress_tests::control_ingress_real_v8_retains_slots_until_ack_and_completion_bypasses_full_quota";
    if std::env::var(CASE_ENV).as_deref() != Ok("v8") {
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", TEST_NAME, "--nocapture"])
            .env(CASE_ENV, "v8")
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let output = tokio::time::timeout(Duration::from_secs(20), command.output())
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
    // 独立 V8 线程拥有 current-thread 驱动，网络生产者仍由测试 Tokio 驱动。 / The dedicated V8 thread owns its current-thread loop while Tokio drives producers.
    std::thread::spawn(|| {
        let event_loop = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let (sender, mut receiver) = channel(2);
        let admission = Arc::clone(&sender.stats.control_admission);
        let mut runtime = create_runtime(false, 0).unwrap();
        runtime.op_state().borrow_mut().put(PublishedControls::new(Arc::clone(&admission)));
        runtime.execute_script("test:control-ingress.js", r#"
            for (const name of ['__etsStartProcess', '__etsStopProcess', '__etsBeginHotfix', '__etsCommitHotfix', '__etsAbortHotfix']) globalThis[name] = () => '';
            globalThis.__etsUpdateBinary = () => '0';
            globalThis.ack = 0; globalThis.skipBatch = false; globalThis.receivedCompletions = 0;
            globalThis.__etsDispatchHostEvents = () => {
                if (globalThis.skipBatch) return;
                const bytes = globalThis.__hostTakeEventBatch(), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                let offset = 4;
                for (let i = 0; i < view.getUint32(0, true); i++) {
                    if (bytes[offset] === 3) globalThis.receivedCompletions++;
                    offset += 13 + view.getUint32(offset + 9, true);
                }
            };
        "#).unwrap();
        let error = crate::host::load_js_entrypoints(&mut runtime).err().expect("old Model must fail immediately");
        assert!(error.to_string().contains("__etsTakeReleasedControlIngress"));
        runtime.execute_script("test:control-ack.js", "globalThis.__etsTakeReleasedControlIngress = () => { const n = globalThis.ack; globalThis.ack = 0; return n; };").unwrap();
        let entrypoints = crate::host::load_js_entrypoints(&mut runtime).unwrap();
        event_loop.block_on(async {
            sender.send(disconnect(1), None).await.unwrap();
            sender.send(disconnect(2), None).await.unwrap();
        });
        let payload = pack(&mut receiver, &sender.stats);
        assert_eq!(admission.snapshot().reserved, 2);
        call_js_push_host_events(&mut runtime, &entrypoints, payload).unwrap();
        call_js_update_binary(&event_loop, &mut runtime, &entrypoints, false, false).unwrap();
        assert_eq!(admission.snapshot().reserved, 2, "packing and V8 copy must not release controls");
        assert_eq!(sender.try_send_control(disconnect(3)), Err(ProcessIngressTrySendError::Overloaded));
        let mut waiting = Box::pin(sender.send(disconnect(4), None));
        event_loop.block_on(async { assert!(futures_util::poll!(&mut waiting).is_pending()); });
        sender.try_send_completion(HostSceneCompletion { operation_id: 5, result: Ok(vec![1, 2]) }).unwrap();
        call_js_push_host_events(&mut runtime, &entrypoints, pack(&mut receiver, &sender.stats)).unwrap();
        runtime.execute_script("test:completion.js", "if (receivedCompletions !== 1) throw new Error('completion was blocked'); globalThis.ack = 3;").unwrap();
        assert!(call_js_update_binary(&event_loop, &mut runtime, &entrypoints, false, false).is_err());
        assert_eq!(admission.snapshot().reserved, 2, "invalid ack cannot partially release");
        runtime.execute_script("test:release-one.js", "globalThis.ack = 1;").unwrap();
        call_js_update_binary(&event_loop, &mut runtime, &entrypoints, false, false).unwrap();
        event_loop.block_on(waiting).unwrap();
        assert_eq!(admission.snapshot().reserved, 2);
        call_js_push_host_events(&mut runtime, &entrypoints, pack(&mut receiver, &sender.stats)).unwrap();
        runtime.execute_script("test:release-all.js", "globalThis.ack = 2;").unwrap();
        call_js_update_binary(&event_loop, &mut runtime, &entrypoints, false, false).unwrap();
        assert_eq!(admission.snapshot().reserved, 0);
        event_loop.block_on(sender.send(disconnect(6), None)).unwrap();
        let published_before_skip = sender.stats.host_backing_store.snapshot().created_total;
        runtime.execute_script("test:skip.js", "globalThis.skipBatch = true;").unwrap();
        call_js_push_host_events(&mut runtime, &entrypoints, pack(&mut receiver, &sender.stats)).unwrap();
        assert_eq!(admission.snapshot().reserved, 0, "unconsumed TLS batch must be dropped");
        assert_eq!(sender.stats.host_backing_store.snapshot().created_total, published_before_skip, "unconsumed TLS payload is not a V8 store");
        runtime.execute_script("test:take.js", "globalThis.skipBatch = false;").unwrap();
        event_loop.block_on(async {
            sender.send(disconnect(7), None).await.unwrap();
            sender.send(disconnect(8), None).await.unwrap();
        });
        call_js_push_host_events(&mut runtime, &entrypoints, pack(&mut receiver, &sender.stats)).unwrap();
        let mut stopped_wait = Box::pin(sender.send(disconnect(9), None));
        event_loop.block_on(async { assert!(futures_util::poll!(&mut stopped_wait).is_pending()); });
        drop(entrypoints); drop(runtime);
        assert_eq!(sender.stats.host_backing_store.snapshot().bytes, 0);
        assert_eq!(sender.stats.host_backing_store.snapshot().buffers, 0);
        assert_eq!(admission.snapshot().reserved, 0, "isolate drop releases published guards");
        assert!(event_loop.block_on(stopped_wait).unwrap_err().contains("stopped"));
        assert_eq!(admission.snapshot().peak, 2);
        assert_eq!(sender.stats.depth.load(Ordering::Relaxed), 0);
    }).join().unwrap();
}
