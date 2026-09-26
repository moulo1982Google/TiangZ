//! 验证真实 Process/V8 的打包字节边界及跨批次事件所有权。 / Verifies real Process/V8 batch byte boundaries and cross-batch event ownership.

use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_batches_bound_real_v8_delivery_during_running_and_shutdown() {
    const CASE_ENV: &str = "TIANGZ_TEST_HOST_BATCH_CASE";
    const TEST_NAME: &str = "process::host_batch_tests::host_batches_bound_real_v8_delivery_during_running_and_shutdown";
    let selected = match std::env::var(CASE_ENV) {
        Ok(case) => case.parse::<usize>().unwrap(),
        Err(std::env::VarError::NotPresent) => {
            let mut failures = Vec::new();
            for case in 0..2 {
                let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
                command
                    .args(["--exact", TEST_NAME, "--nocapture"])
                    .env(CASE_ENV, case.to_string())
                    .kill_on_drop(true);
                #[cfg(windows)]
                command.creation_flags(0x0800_0000);
                let output = tokio::time::timeout(Duration::from_secs(30), command.output())
                    .await
                    .expect("Host batch child exceeded its watchdog")
                    .unwrap();
                let stdout = String::from_utf8_lossy(&output.stdout);
                if !output.status.success()
                    || !stdout.contains("test result: ok. 1 passed; 0 failed;")
                {
                    failures.push(format!(
                        "case {case}: {}\n{stdout}\n{}",
                        output.status,
                        String::from_utf8_lossy(&output.stderr)
                    ));
                }
            }
            assert!(failures.is_empty(), "{}", failures.join("\n"));
            return;
        }
        Err(error) => panic!("invalid Host batch fixture environment: {error}"),
    };
    assert!(selected < 2);
    let during_stop = selected == 1;
    let model = format!(
        r#"
        const duringStop = {during_stop};
        let received = 0, batches = 0, stopping = false, finish;
        const retained = [];
        for (const name of ['__etsStartProcess', '__etsBeginHotfix', '__etsCommitHotfix', '__etsAbortHotfix'])
            globalThis[name] = () => '{{}}';
        globalThis.__etsDispatchHostEvents = () => {{
            const bytes = globalThis.__hostTakeEventBatch();
            retained.push(bytes.subarray(4, 5));
            if (bytes.byteLength > 64 * 1024 * 1024) throw new Error('Host batch exceeds 64 MiB: ' + bytes.byteLength);
            if (stopping !== duringStop) throw new Error('completion delivered in wrong lifecycle phase');
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const count = view.getUint32(0, true);
            let offset = 4;
            for (let i = 0; i < count; ++i) {{
                const id = view.getUint32(offset + 1, true), size = view.getUint32(offset + 9, true);
                if (bytes[offset] !== 3 || id !== received + 1 || view.getUint32(offset + 5, true) !== 0 || size !== 1024 * 1024)
                    throw new Error('completion identity/order/size changed');
                offset += 13;
                for (let j = 0; j < size; ++j) if (bytes[offset + j] !== id) throw new Error('completion payload changed');
                offset += size;
                received++;
            }}
            if (offset !== bytes.length) throw new Error('invalid batch framing');
            batches++;
        }};
        function verify() {{
            if (received !== 80 || batches < 2) throw new Error('missing completion or split: ' + received + '/' + batches);
            if (retained.length !== batches || retained.some(view => view[0] !== 3)) throw new Error('retained view changed');
        }}
        globalThis.__etsStopProcess = () => {{
            stopping = true;
            if (!duringStop) {{ verify(); return 'stopped'; }}
            return new Promise(resolve => finish = resolve);
        }};
        globalThis.__etsTakeReleasedControlIngress = () => 0;
        globalThis.__etsUpdateBinary = sample => {{
            if (duringStop && stopping && received === 80) {{ verify(); finish('stopped'); }}
            return sample ? '{{}}' : '0';
        }};
    "#
    );
    let fixture = lifecycle_tests::runtime_fixture_with_model(model);
    let (control_sender, control_receiver) = mpsc::sync_channel(128);
    let (_data_sender, data_receiver) = mpsc::sync_channel(1);
    let (_wake_sender, wake_receiver) = mpsc::sync_channel(1);
    let stats = Arc::new(ProcessQueueStats::new(129));
    let queue = |event: ProcessEvent| {
        stats.queued(event.kind(), event.ingress_class());
        control_sender.try_send(event).unwrap();
    };
    if during_stop {
        queue(ProcessEvent::Shutdown);
    }
    for id in 1..=80 {
        queue(ProcessEvent::HostSceneCompletion(HostSceneCompletion {
            backing_reservation: Some(stats.host_events.try_reserve(1024 * 1024).unwrap()),
            operation_id: id,
            result: Ok(vec![id as u8; 1024 * 1024]),
        }));
    }
    if !during_stop {
        queue(ProcessEvent::Shutdown);
    }
    let event_rx = ProcessEventReceiver::new(
        control_receiver,
        data_receiver,
        wake_receiver,
        Arc::clone(&stats.control_admission),
        Arc::clone(&stats.host_events),
    );
    let (_runtime_control, runtime_control_rx) = mpsc::channel();
    let process: ProcessConfig = serde_json::from_value(json!({
        "name": "host-batch-fixture", "identity": { "originServerId": 91, "workerId": 0 },
        "scheduling": { "mode": "throughput", "coalesceMicros": 0 },
        "lifecycle": { "stopTimeoutMs": 5000 }
    }))
    .unwrap();
    let root = fixture.path().to_owned();
    let bundles = RuntimeBundles::load(&root).unwrap();
    let runtime_handle = tokio::runtime::Handle::current();
    let thread_stats = Arc::clone(&stats);
    tokio::task::spawn_blocking(move || {
        run_process_runtime(
            root,
            process,
            vec![],
            vec![],
            bundles,
            vec![],
            event_rx,
            runtime_control_rx,
            Arc::new(Mutex::new(HashMap::new())),
            thread_stats,
            runtime_handle,
            Arc::new(|_| Ok(())),
            Arc::new(ProcessHealthState::starting(Duration::from_secs(10))),
        )
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(stats.host_completions.load(Ordering::Relaxed), 80);
    assert_eq!(stats.depth.load(Ordering::Relaxed), 0);
    assert_eq!(stats.host_event_batch_splits.load(Ordering::Relaxed), 1);
    let backing = stats.host_backing_store.snapshot();
    assert_eq!(backing.created_total, 2);
    assert_eq!(backing.max_bytes, 8 + 80 * (13 + 1024 * 1024));
    assert_eq!(
        backing.bytes, 0,
        "isolate exit releases both retained batch views"
    );
    assert_eq!(backing.buffers, 0);
    assert_eq!(
        stats.max_host_event_batch_bytes.load(Ordering::Relaxed),
        4 + 63 * (13 + 1024 * 1024)
    );
}

fn data_frame(id: u64) -> ProcessEvent {
    ProcessEvent::Frame {
        backing_reservation: None,
        control_reservation: None,
        scene_index: 2,
        connection_id: id,
        internal: false,
        frame: Bytes::from_static(&[0x9c, 0x40, 0xd0, 0x05, 0x01]),
    }
}

fn disconnect(id: u64) -> ProcessEvent {
    ProcessEvent::Disconnect {
        backing_reservation: None,
        control_reservation: None,
        scene_index: 2,
        connection_id: id,
    }
}

fn event_id(event: &ProcessEvent) -> u64 {
    match event {
        ProcessEvent::Frame { connection_id, .. }
        | ProcessEvent::Disconnect { connection_id, .. } => *connection_id,
        _ => panic!("unexpected event"),
    }
}

#[tokio::test]
async fn host_batch_returned_heads_are_included_in_queue_high_water() {
    let (sender, mut receiver) = ingress_buffer_tests::channel(15, 2);
    sender.send(data_frame(1), None).await.unwrap();
    let data = receiver.try_recv().unwrap();
    receiver.return_front(data);
    sender.send(disconnect(2), None).await.unwrap();
    let control = receiver.try_recv_control().unwrap();
    receiver.return_front(control);
    for id in [3, 4] {
        sender.send(data_frame(id), None).await.unwrap();
    }
    for id in [5, 6] {
        sender.send(disconnect(id), None).await.unwrap();
    }
    assert_eq!(
        sender.stats.capacity, 4,
        "configured capacity describes the two mpsc queues"
    );
    assert_eq!(sender.stats.depth.load(Ordering::Relaxed), 6);
    assert_eq!(sender.stats.max_depth.load(Ordering::Relaxed), 6);
    assert_eq!(sender.stats.ingress_buffers.snapshot().used_bytes, 15);
    drop(receiver);
    assert_eq!(sender.stats.ingress_buffers.snapshot().used_bytes, 0);
}

#[tokio::test]
async fn host_batch_refill_stops_before_copy_and_retains_ingress_until_next_batch() {
    let (sender, mut receiver) = ingress_buffer_tests::channel(5, 8);
    let stats = &sender.stats;
    let mut batch = HostEventBatch::with_limit(40); // 4 + 2 * (13 + 5).
    for id in 1..=3 {
        sender.send(data_frame(id), None).await.unwrap();
        let event = receiver.try_recv().unwrap();
        assert_eq!(
            push_received_event(&mut batch, &mut receiver, event, stats).unwrap(),
            id != 3
        );
        assert_eq!(
            stats.ingress_buffers.snapshot().used_bytes,
            if id == 3 { 5 } else { 0 }
        );
    }
    assert_eq!(stats.depth.load(Ordering::Relaxed), 1);
    assert_eq!(stats.inbound_frames.load(Ordering::Relaxed), 2);
    let bytes = batch.into_payload(stats).bytes;
    assert_eq!(bytes.len(), 40);
    assert_eq!(u32::from_le_bytes(bytes[..4].try_into().unwrap()), 2);
    assert_eq!(u32::from_le_bytes(bytes[5..9].try_into().unwrap()), 1);
    assert_eq!(u32::from_le_bytes(bytes[23..27].try_into().unwrap()), 2);
    let mut next = HostEventBatch::with_limit(40);
    let event = receiver.recv_timeout(Duration::ZERO).unwrap();
    assert_eq!(event_id(&event), 3);
    assert!(push_received_event(&mut next, &mut receiver, event, stats).unwrap());
    assert_eq!(stats.depth.load(Ordering::Relaxed), 0);
    assert_eq!(stats.ingress_buffers.snapshot().used_bytes, 0);
    assert_eq!(next.into_payload(stats).bytes.len(), 22);
    assert_eq!(stats.host_event_batch_splits.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn host_batch_returns_restore_fairness_and_data_head_never_blocks_control() {
    let (sender, mut receiver) = ingress_buffer_tests::channel(10, 64);
    sender.send(data_frame(100), None).await.unwrap();
    let event = receiver.try_recv().unwrap();
    receiver.return_front(event);
    assert_eq!(sender.stats.ingress_buffers.snapshot().used_bytes, 5);
    assert!(matches!(
        receiver.try_recv_control(),
        Err(mpsc::TryRecvError::Empty)
    ));
    for id in 1..=33 {
        sender.send(disconnect(id), None).await.unwrap();
    }
    for id in 1..=32 {
        let event = receiver.try_recv().unwrap();
        assert_eq!(event_id(&event), id);
        if id == 32 {
            receiver.return_front(event);
            assert_eq!(receiver.consecutive_control, 31);
            assert!(receiver.pending_data.is_some() && receiver.pending_control.is_some());
            let retry = receiver.try_recv().unwrap();
            assert_eq!(
                event_id(&retry),
                32,
                "a returned control event must not consume fairness twice"
            );
            sender.stats.dequeue(retry.kind(), retry.ingress_class());
        } else {
            sender.stats.dequeue(event.kind(), event.ingress_class());
        }
    }
    let event = receiver.try_recv().unwrap();
    assert_eq!(
        event_id(&event),
        100,
        "data progresses after 32 actual control deliveries"
    );
    receiver.return_front(event);
    assert_eq!(receiver.consecutive_control, 32);
    // pendingIngress uses only this lane; a retained data frame must not deadlock completion/control.
    let event = receiver.try_recv_control().unwrap();
    assert_eq!(event_id(&event), 33);
    sender.stats.dequeue(event.kind(), event.ingress_class());
    let event = receiver.try_recv().unwrap();
    assert_eq!(event_id(&event), 100);
    sender.stats.dequeue(event.kind(), event.ingress_class());
    drop(event);
    assert_eq!(sender.stats.depth.load(Ordering::Relaxed), 0);
    assert_eq!(sender.stats.ingress_buffers.snapshot().used_bytes, 0);
}

#[tokio::test]
async fn host_batch_returned_heads_keep_fifo_after_new_events_and_release_on_receiver_drop() {
    let (sender, mut receiver) = ingress_buffer_tests::channel(15, 2);
    sender.send(data_frame(1), None).await.unwrap();
    let event = receiver.try_recv().unwrap();
    receiver.return_front(event);
    sender.send(data_frame(2), None).await.unwrap();
    sender.send(disconnect(3), None).await.unwrap();
    let control = receiver.try_recv_control().unwrap();
    receiver.return_front(control);
    sender.send(disconnect(4), None).await.unwrap();
    for id in [3, 4, 1] {
        let event = receiver.try_recv().unwrap();
        assert_eq!(event_id(&event), id);
        sender.stats.dequeue(event.kind(), event.ingress_class());
    }
    let event = receiver.try_recv().unwrap();
    assert_eq!(event_id(&event), 2);
    receiver.return_front(event);
    drop(sender);
    let event = receiver.recv_timeout(Duration::ZERO).unwrap();
    assert_eq!(
        event_id(&event),
        2,
        "closed senders do not discard a returned head"
    );
    receiver.return_front(event);
    drop(receiver);

    let (sender, mut receiver) = ingress_buffer_tests::channel(5, 1);
    sender.send(data_frame(5), None).await.unwrap();
    let event = receiver.try_recv().unwrap();
    receiver.return_front(event);
    drop(receiver);
    assert_eq!(sender.stats.ingress_buffers.snapshot().used_bytes, 0);
}

#[tokio::test]
async fn host_batch_hotfix_deferred_frames_keep_original_guard_and_order() {
    let (sender, mut receiver) = ingress_buffer_tests::channel(10, 8);
    let mut deferred = VecDeque::new();
    for id in 1..=2 {
        let mut event = data_frame(id);
        if let ProcessEvent::Frame { internal, .. } = &mut event {
            *internal = true;
        }
        sender.try_send_control(event).unwrap();
        let event = receiver.try_recv_control().unwrap();
        sender.stats.dequeue(event.kind(), event.ingress_class());
        deferred.push_back(event);
    }
    let mut batch = HostEventBatch::with_limit(22);
    assert!(
        batch
            .try_push(deferred.pop_front().unwrap(), &sender.stats)
            .unwrap()
            .is_none()
    );
    let returned = batch
        .try_push(deferred.pop_front().unwrap(), &sender.stats)
        .unwrap()
        .unwrap();
    assert_eq!(sender.stats.ingress_buffers.snapshot().used_bytes, 5);
    deferred.push_front(returned);
    let bytes = batch.into_payload(&sender.stats).bytes;
    assert_eq!(bytes[4], 5, "Inner RPC remains control ingress");
    assert_eq!(event_id(deferred.front().unwrap()), 2);
    drop(deferred);
    assert_eq!(sender.stats.ingress_buffers.snapshot().used_bytes, 0);
}
