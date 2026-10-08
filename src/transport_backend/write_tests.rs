use super::lifecycle::{drain_writer, next_write_batch, stopped};
use super::*;
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use tokio::io::AsyncReadExt;

/// 使用生产准入函数预留帧，测试后核对资源基线。 / Reserves frames through production admission and verifies the resource baseline afterwards.
fn queued(
    frames: Vec<Bytes>,
) -> (
    ConnectionWriter,
    mpsc::Receiver<ConnectionWriteBatch>,
    watch::Receiver<bool>,
) {
    let (sender, receiver) = mpsc::channel(4);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let writer = ConnectionWriter {
        process_buffer_budget: super::BufferBudget::new(64 * 1024 * 1024),
        sender,
        shutdown_tx,
        queued_bytes: Arc::new(AtomicUsize::new(0)),
        queued_frames: Arc::new(AtomicUsize::new(0)),
    };
    try_queue_connection_batch(&writer, ConnectionWriteBatch::from_frames(frames)).unwrap();
    (writer, receiver, shutdown_rx)
}

#[tokio::test]
async fn expired_queue_budget_never_polls_a_ready_write() {
    let (writer, mut receiver, _) = queued(vec![Bytes::from_static(b"queued")]);
    let mut batch = receiver.recv().await.unwrap();
    Arc::get_mut(batch.reservation.as_mut().unwrap())
        .unwrap()
        .admitted_at -= Duration::from_secs(2);
    let polled = AtomicBool::new(false);
    let error = batch
        .write_within(Duration::from_secs(1), async {
            polled.store(true, Ordering::SeqCst);
            Ok(())
        })
        .await
        .unwrap_err();
    assert!(error.to_string().contains("before writing"));
    assert!(!polled.load(Ordering::SeqCst));
    drop(batch);
    assert_eq!(writer.queued_bytes.load(Ordering::Relaxed), 0);
    assert_eq!(writer.queued_frames.load(Ordering::Relaxed), 0);
    assert_eq!(writer.process_buffer_budget.snapshot().used_bytes, 0);
}

#[tokio::test]
async fn partial_vectored_write_expires_and_releases_batch_and_stream() {
    let (writer, mut receiver, _) = queued(vec![Bytes::from(vec![7; 4096])]);
    let batch = receiver.recv().await.unwrap();
    let (mut stream, mut peer) = tokio::io::duplex(64);
    let error = batch
        .write_within(
            Duration::from_millis(40),
            super::epoll::write_raw_frames_vectored(&mut stream, &batch.frames),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("partial"));
    // 队列已取出仍持有预算，超时销毁批次后才释放。 / Dequeuing retains the reservation until timeout cleanup drops the batch.
    assert_eq!(writer.queued_bytes.load(Ordering::Relaxed), 4096);
    drop(batch);
    drop(stream);
    let mut received = Vec::new();
    peer.read_to_end(&mut received).await.unwrap();
    assert_eq!(
        received.len(),
        64,
        "the production writer actually sent a partial frame"
    );
    assert_eq!(&received[..4], &4096_u32.to_be_bytes());
    assert_eq!(writer.queued_bytes.load(Ordering::Relaxed), 0);
    assert_eq!(writer.queued_frames.load(Ordering::Relaxed), 0);
    assert_eq!(writer.process_buffer_budget.snapshot().used_bytes, 0);
}

#[tokio::test]
async fn close_budget_caps_in_flight_write_and_all_remaining_batches() {
    let (writer, mut receiver, mut shutdown) = queued(vec![Bytes::from(vec![7; 4096])]);
    try_queue_connection_frame(&writer, Bytes::from_static(b"final notice")).unwrap();
    writer.shutdown_tx.send(true).unwrap();
    let (mut stream, mut peer) = tokio::io::duplex(64);
    let error = drain_writer(
        async move {
            while let Some(batch) = next_write_batch(&mut receiver, &mut shutdown).await {
                batch
                    .write_within(
                        Duration::from_secs(60),
                        super::epoll::write_raw_frames_vectored(&mut stream, &batch.frames),
                    )
                    .await?;
            }
            Ok(())
        },
        writer.shutdown_tx.clone(),
        Duration::from_millis(40),
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("close budget"));
    assert!(writer.sender.is_closed());
    assert_eq!(writer.queued_bytes.load(Ordering::Relaxed), 0);
    assert_eq!(writer.queued_frames.load(Ordering::Relaxed), 0);
    assert_eq!(writer.process_buffer_budget.snapshot().used_bytes, 0);
    let mut received = Vec::new();
    peer.read_to_end(&mut received).await.unwrap();
    assert_eq!(received.len(), 64);
}

#[tokio::test]
async fn closing_queue_preserves_order_and_rejects_new_batches() {
    let (writer, mut receiver, mut shutdown) = queued(vec![Bytes::from_static(b"first")]);
    try_queue_connection_frame(&writer, Bytes::from_static(b"last")).unwrap();
    writer.shutdown_tx.send(true).unwrap();
    let first = next_write_batch(&mut receiver, &mut shutdown)
        .await
        .unwrap();
    assert_eq!(first.frames[0], b"first"[..]);
    assert_eq!(
        try_queue_connection_frame(&writer, Bytes::from_static(b"too late")),
        Err(ConnectionQueueError::Closed)
    );
    let last = next_write_batch(&mut receiver, &mut shutdown)
        .await
        .unwrap();
    assert_eq!(last.frames[0], b"last"[..]);
    assert!(
        next_write_batch(&mut receiver, &mut shutdown)
            .await
            .is_none()
    );
    drop((first, last));
    assert_eq!(writer.queued_bytes.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn writer_panic_also_notifies_reader() {
    let (shutdown, mut receiver) = watch::channel(false);
    let task = tokio::spawn(drain_writer(
        async {
            panic!("injected writer panic");
        },
        shutdown,
        Duration::from_secs(1),
    ));
    assert!(task.await.unwrap_err().is_panic());
    tokio::time::timeout(Duration::from_secs(1), stopped(&mut receiver))
        .await
        .unwrap();
    assert!(*receiver.borrow());
}
