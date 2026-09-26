use super::*;
use tokio::time::{Instant as TokioInstant, timeout};

pub(super) fn channel(bytes: usize, capacity: usize) -> (ProcessEventSender, ProcessEventReceiver) {
    let (control_sender, control_receiver) = mpsc::sync_channel(capacity);
    let (data_sender, data_receiver) = mpsc::sync_channel(capacity);
    let (wake_sender, wake_receiver) = mpsc::sync_channel(1);
    let network = crate::config::ProcessNetworkConfig {
        max_ingress_buffered_bytes: bytes,
        ..Default::default()
    };
    let stats = Arc::new(ProcessQueueStats::with_network_limits(
        capacity * 2,
        &network,
    ));
    (
        ProcessEventSender {
            control_sender,
            data_sender,
            wake_sender,
            stats: Arc::clone(&stats),
        },
        ProcessEventReceiver::new(
            control_receiver,
            data_receiver,
            wake_receiver,
            Arc::clone(&stats.control_admission),
        ),
    )
}

fn frame(internal: bool) -> ProcessEvent {
    ProcessEvent::Frame {
        control_reservation: None,
        scene_index: 0,
        connection_id: 1,
        internal,
        // Existing wire RPC identity: protobuf field 90 (rpcId) = 1.
        frame: Bytes::from_static(&[0x9c, 0x40, 0xd0, 0x05, 0x01]),
    }
}

fn receive(receiver: &mut ProcessEventReceiver, stats: &ProcessQueueStats) -> ProcessEvent {
    let event = receiver.try_recv().unwrap();
    stats.dequeue(event.kind(), event.ingress_class());
    event
}

#[tokio::test]
async fn ingress_bytes_are_shared_by_control_and_data_but_leave_control_notifications_available() {
    let (sender, mut receiver) = channel(10, 8);
    sender.send(frame(false), None).await.unwrap();
    sender.try_send_control(frame(true)).unwrap();
    assert_eq!(sender.stats.ingress_buffers.snapshot().used_bytes, 10);
    assert_eq!(
        sender.try_send_control(frame(true)),
        Err(ProcessIngressTrySendError::Overloaded)
    );
    assert!(
        sender
            .send(frame(false), None)
            .await
            .unwrap_err()
            .contains("byte budget")
    );
    sender.send(ProcessEvent::Shutdown, None).await.unwrap();
    sender
        .send(
            ProcessEvent::Disconnect {
                control_reservation: None,
                scene_index: 0,
                connection_id: 1,
            },
            None,
        )
        .await
        .unwrap();
    sender
        .try_send_completion(HostSceneCompletion {
            operation_id: 7,
            result: Ok(vec![1; 64]),
        })
        .unwrap();
    let snapshot = sender.stats.ingress_buffers.snapshot();
    assert_eq!((snapshot.used_bytes, snapshot.rejections), (10, 2));
    assert_eq!(sender.stats.depth.load(Ordering::Relaxed), 5);
    assert_eq!(sender.stats.backpressure_waits.load(Ordering::Relaxed), 0);

    let control = receive(&mut receiver, &sender.stats);
    let mut deferred = VecDeque::from([control]);
    assert_eq!(
        sender.stats.ingress_buffers.snapshot().used_bytes,
        10,
        "dequeued/deferred frames still own bytes"
    );
    let mut packed = HostEventBatch::new();
    assert!(
        packed
            .try_push(deferred.pop_front().unwrap(), &sender.stats)
            .unwrap()
            .is_none()
    );
    assert_eq!(sender.stats.ingress_buffers.snapshot().used_bytes, 5);
    assert_eq!(packed.len(), 1);
    sender.try_send_control(frame(true)).unwrap();
    assert_eq!(sender.stats.ingress_buffers.snapshot().used_bytes, 10);
    drop(receiver);
    assert_eq!(sender.stats.ingress_buffers.snapshot().used_bytes, 0);
}

#[tokio::test]
async fn ingress_waiting_for_queue_capacity_keeps_one_reservation_and_cancellation_returns_it() {
    let (sender, mut receiver) = channel(10, 1);
    sender.send(frame(false), None).await.unwrap();
    let waiting_sender = sender.clone();
    let waiting = tokio::spawn(async move { waiting_sender.send(frame(false), None).await });
    timeout(Duration::from_secs(1), async {
        while sender.stats.backpressure_waits.load(Ordering::Relaxed) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    // Several count-capacity retries must neither reserve again nor leak quota.
    tokio::time::sleep(Duration::from_millis(12)).await;
    assert!(!waiting.is_finished());
    assert_eq!(sender.stats.ingress_buffers.snapshot().used_bytes, 10);
    assert_eq!(sender.stats.ingress_buffers.snapshot().rejections, 0);
    waiting.abort();
    assert!(waiting.await.unwrap_err().is_cancelled());
    assert_eq!(sender.stats.ingress_buffers.snapshot().used_bytes, 5);
    drop(receive(&mut receiver, &sender.stats));
    assert_eq!(sender.stats.ingress_buffers.snapshot().used_bytes, 0);
    sender.send(frame(false), None).await.unwrap();
    drop(receiver);
    assert_eq!(sender.stats.ingress_buffers.snapshot().used_bytes, 0);
}

#[tokio::test]
async fn ingress_deadline_full_control_queue_and_stopped_receiver_return_reservations() {
    let (sender, mut receiver) = channel(15, 1);
    sender.try_send_control(frame(true)).unwrap();
    assert_eq!(
        sender.try_send_control(frame(true)),
        Err(ProcessIngressTrySendError::Overloaded)
    );
    assert_eq!(sender.stats.ingress_buffers.snapshot().used_bytes, 5);
    sender.send(frame(false), None).await.unwrap();
    assert!(
        sender
            .send(frame(false), Some(TokioInstant::now()))
            .await
            .unwrap_err()
            .contains("queue is overloaded")
    );
    assert_eq!(sender.stats.ingress_buffers.snapshot().used_bytes, 10);
    drop(receive(&mut receiver, &sender.stats));
    drop(receiver);
    assert_eq!(sender.stats.ingress_buffers.snapshot().used_bytes, 0);
    assert_eq!(
        sender.try_send_control(frame(true)),
        Err(ProcessIngressTrySendError::Stopped)
    );
    assert!(
        sender
            .send(frame(false), None)
            .await
            .unwrap_err()
            .contains("stopped")
    );
    assert_eq!(sender.stats.ingress_buffers.snapshot().used_bytes, 0);
    assert_eq!(
        sender.stats.ingress_buffers.snapshot().rejections,
        0,
        "count capacity failures are separate from byte rejection"
    );
}

#[tokio::test]
async fn ingress_packing_failure_releases_its_original_frame_bytes() {
    let (sender, mut receiver) = channel(5, 1);
    let mut invalid = frame(false);
    if let ProcessEvent::Frame { connection_id, .. } = &mut invalid {
        *connection_id = u64::MAX;
    }
    sender.send(invalid, None).await.unwrap();
    let event = receive(&mut receiver, &sender.stats);
    assert_eq!(sender.stats.ingress_buffers.snapshot().used_bytes, 5);
    assert!(
        HostEventBatch::new()
            .try_push(event, &sender.stats)
            .unwrap_err()
            .to_string()
            .contains("connection id")
    );
    assert_eq!(sender.stats.ingress_buffers.snapshot().used_bytes, 0);
}
