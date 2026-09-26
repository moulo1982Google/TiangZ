//! 验证真实 V8 在驻留满额时仍交付预留回复，且最后所有者决定释放。 / Verifies reserved replies progress at capacity in real V8 and only the final owner releases stores.

use super::*;
use crate::host::event_admission::{EVENT_OVERHEAD, EventAdmission};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_event_budget_retained_replies_do_not_block_completions_or_disconnects() {
    const ENV: &str = "TIANGZ_TEST_HOST_EVENT_BUDGET";
    const TEST: &str = "process::host_event_budget_tests::host_event_budget_retained_replies_do_not_block_completions_or_disconnects";
    if std::env::var(ENV).as_deref() != Ok("v8") {
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", TEST, "--nocapture"])
            .env(ENV, "v8")
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
    std::thread::spawn(|| {
        const SIZE: usize = 1024 * 1024;
        let event_loop = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let _entered = event_loop.enter();
        let capacity = 2 * (SIZE + EVENT_OVERHEAD) + 2 + EVENT_OVERHEAD;
        let stats = Arc::new(ProcessQueueStats { host_events: EventAdmission::with_capacity(capacity), ..Default::default() });
        let (control_sender, control_receiver) = mpsc::sync_channel(8);
        let (data_sender, data_receiver) = mpsc::sync_channel(8);
        let (wake_sender, wake_receiver) = mpsc::sync_channel(1);
        let sender = ProcessEventSender { control_sender, data_sender, wake_sender, stats: Arc::clone(&stats) };
        let mut receiver = ProcessEventReceiver::new(control_receiver, data_receiver, wake_receiver,
            Arc::clone(&stats.control_admission), Arc::clone(&stats.host_events));
        let mut runtime = create_runtime(false, 0).unwrap();
        runtime.op_state().borrow_mut().put(control_ingress::PublishedControls::new(Arc::clone(&stats.control_admission)));
        configure_host_scene_bridge(event_loop.handle().clone(), Arc::new(|_| panic!("rejected batch executed")),
            Arc::clone(&stats.outbound_buffers), Arc::clone(&stats.host_scene_batches), Arc::clone(&stats.host_events));
        runtime.execute_script("test:host-event-budget", r#"
            for (const name of ['__etsStartProcess', '__etsStopProcess', '__etsBeginHotfix', '__etsCommitHotfix', '__etsAbortHotfix']) globalThis[name] = () => '';
            globalThis.__etsTakeReleasedControlIngress = () => 0;
            globalThis.__etsUpdateBinary = () => '0';
            globalThis.held = []; globalThis.order = [];
            globalThis.__etsDispatchHostEvents = () => {
                const bytes = __hostTakeEventBatch(), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                let offset = 4;
                for (let i = 0; i < view.getUint32(0, true); i++) {
                    const kind = bytes[offset], id = view.getUint32(offset + 1, true), size = view.getUint32(offset + 9, true);
                    order.push([kind, id]); offset += 13;
                    if (kind === 3) {
                        if (size !== 1024 * 1024 || bytes[offset] !== id || bytes[offset + size - 1] !== id) throw Error('executed reply corrupted');
                        held.push(bytes.subarray(offset, offset + 1));
                    }
                    offset += size;
                }
                if (offset !== bytes.length) throw Error('bad mixed framing');
            };
            const route = __hostRegisterSceneRoute('source', 'target', '127.0.0.1', 1);
            globalThis.rejectNewCall = () => {
                const bytes = new Uint8Array(23), view = new DataView(bytes.buffer);
                view.setUint32(0, 1, true); view.setUint32(4, 7, true); view.setUint32(8, route, true);
                bytes[12] = 1; view.setUint32(13, 1000, true); view.setUint32(17, 2, true);
                let rejected = false;
                try { __hostSubmitSceneOperations(bytes, __hostSceneNowMs()); }
                catch (error) { rejected = String(error).includes('[scene-overloaded]') && String(error).includes('event byte budget'); }
                if (!rejected) throw Error('new call must reject before execution while old replies are retained');
            };
        "#).unwrap();
        let entrypoints = crate::host::load_js_entrypoints(&mut runtime).unwrap();
        // 先预留两个已接受调用，再制造持有旧回复的业务。 / Reserve two accepted calls before simulating business retention of the first reply.
        let first = stats.host_events.try_reserve(SIZE).unwrap();
        let second = stats.host_events.try_reserve(SIZE).unwrap();
        let frame = || ProcessEvent::Frame { backing_reservation: None, control_reservation: None,
            scene_index: 0, connection_id: 3, internal: false, frame: Bytes::from_static(&[1, 2]) };
        event_loop.block_on(sender.send(frame(), None)).unwrap();
        assert_eq!(stats.host_events.snapshot().used_bytes, capacity as u64);
        assert!(event_loop.block_on(sender.send(frame(), None)).is_err());
        sender.try_send_completion(HostSceneCompletion { backing_reservation: Some(first), operation_id: 1, result: Ok(vec![1; SIZE]) }).unwrap();
        sender.try_send_control(ProcessEvent::Disconnect { backing_reservation: None, control_reservation: None, scene_index: 0, connection_id: 4 }).unwrap();
        let mut batch = HostEventBatch::new();
        for _ in 0..3 { let event = receiver.try_recv().unwrap(); assert!(push_received_event(&mut batch, &mut receiver, event, &stats).unwrap()); }
        call_js_push_host_events(&mut runtime, &entrypoints, batch.into_payload(&stats)).unwrap();
        assert_eq!(stats.ingress_buffers.snapshot().used_bytes, 0, "original Rust frame was released instead of pinned as a fake guard");
        runtime.execute_script("test:old-reply-new-call", "rejectNewCall(); if (held[0][0] !== 1) throw Error('old reply lost');").unwrap();
        assert_eq!(stats.host_scene_batches.snapshot().reserved_slots, 0);
        // 满额时交付第二个已经执行的成功结果，不重新申请/丢弃。 / Deliver the second executed success at capacity without reacquisition or loss.
        sender.try_send_completion(HostSceneCompletion { backing_reservation: Some(second), operation_id: 2, result: Ok(vec![2; SIZE]) }).unwrap();
        let mut batch = HostEventBatch::new();
        let event = receiver.try_recv_control().unwrap();
        assert!(push_received_event(&mut batch, &mut receiver, event, &stats).unwrap());
        call_js_push_host_events(&mut runtime, &entrypoints, batch.into_payload(&stats)).unwrap();
        runtime.execute_script("test:retained-order", "rejectNewCall(); if (JSON.stringify(order) !== '[[3,1],[2,4],[1,3],[3,2]]' || held[1][0] !== 2) throw Error('mixed event order or completion changed');").unwrap();
        assert_eq!(stats.host_events.snapshot().used_bytes, capacity as u64);
        assert_eq!(stats.host_events.disconnect_snapshot().reserved, 1);
        let retained = runtime.execute_script("test:native-owner", "held[0]").unwrap();
        let backing = {
            deno_core::scope!(scope, &mut runtime);
            let value = deno_core::v8::Local::new(scope, &retained);
            let array = deno_core::v8::Local::<deno_core::v8::Uint8Array>::try_from(value).unwrap();
            array.buffer(scope).unwrap().get_backing_store()
        };
        drop(retained); drop(entrypoints); drop(runtime);
        assert_eq!(stats.host_events.snapshot().used_bytes, (SIZE + EVENT_OVERHEAD + 2 + EVENT_OVERHEAD) as u64);
        assert_eq!(stats.host_events.disconnect_snapshot().reserved, 1, "mixed-store guard survives isolate with its Native owner");
        let fresh = EventAdmission::with_capacity(capacity);
        let fresh_guard = fresh.try_reserve(1).unwrap();
        drop(backing);
        assert_eq!(stats.host_events.snapshot().used_bytes, 0);
        assert_eq!(stats.host_events.disconnect_snapshot().reserved, 0);
        assert_eq!(fresh.snapshot().used_bytes, (EVENT_OVERHEAD + 1) as u64);
        assert!(stats.host_events.try_reserve(SIZE).is_some());
        drop(fresh_guard);
        assert_eq!(stats.depth.load(Ordering::Relaxed), 0);
    }).join().unwrap();
}
