use super::*;
use tiangz_transport::buffer_budget::BufferBudget;
use tokio::net::TcpSocket;

async fn socket_pair() -> (TcpStream, TcpStream) {
    let listener = TcpSocket::new_v4().unwrap();
    listener.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    let listener = listener.listen(1).unwrap();
    let client = TcpSocket::new_v4().unwrap();
    let client = client
        .connect(listener.local_addr().unwrap())
        .await
        .unwrap();
    let (peer, _) = listener.accept().await.unwrap();
    (client, peer)
}

// A bounded async byte stream guarantees a partial write. Windows loopback can accept MiBs despite small SO_SNDBUF/SO_RCVBUF values.
fn bounded_session(
    generation: u64,
) -> (
    SocketSession,
    tokio::io::DuplexStream,
    mpsc::Receiver<SocketEvent>,
) {
    let (writer, peer) = tokio::io::duplex(16);
    let (call_outbound_tx, call_rx) = mpsc::channel(4);
    let (send_outbound_tx, send_rx) = mpsc::channel(4);
    let (event_tx, event_rx) = mpsc::channel(2);
    let writer_task = tokio::spawn(write_requests(
        writer, generation, call_rx, send_rx, event_tx,
    ));
    let reader_task = tokio::spawn(std::future::pending());
    (
        SocketSession {
            generation,
            call_outbound_tx,
            send_outbound_tx,
            tasks: vec![reader_task, writer_task],
        },
        peer,
        event_rx,
    )
}

async fn released(budget: &BufferBudget) {
    timeout(Duration::from_secs(2), async {
        while budget.snapshot().used_bytes != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("queued or in-flight payload leaked its reservation");
}

#[tokio::test]
async fn inner_writer_releases_successful_batch_while_connection_remains_idle() {
    let (client, mut peer) = socket_pair().await;
    let (event_tx, _event_rx) = mpsc::channel(2);
    let session = start_socket_session(client, 1, event_tx);
    let budget = BufferBudget::new(8);
    session
        .call_outbound_tx
        .send(WriterFrame {
            frame: budget.try_copy_bytes(&[7; 8]).unwrap(),
            deadline: Instant::now() + Duration::from_secs(1),
        })
        .await
        .unwrap();
    let mut received = [0; 12];
    timeout(Duration::from_secs(2), peer.read_exact(&mut received))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(received, [0, 0, 0, 8, 7, 7, 7, 7, 7, 7, 7, 7]);
    released(&budget).await;
    assert!(
        !session.tasks[1].is_finished(),
        "writer should be waiting for its next batch"
    );
    drop(session);
    assert_eq!(
        timeout(Duration::from_secs(2), peer.read(&mut received))
            .await
            .unwrap()
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn inner_writer_deadline_releases_blocked_and_queued_frames() {
    let (session, _peer, mut event_rx) = bounded_session(19);
    let budget = BufferBudget::new(2 * MAX_FRAME_LEN);
    let frame = vec![4; MAX_FRAME_LEN];
    for _ in 0..2 {
        session
            .call_outbound_tx
            .send(WriterFrame {
                frame: budget.try_copy_bytes(&frame).unwrap(),
                deadline: Instant::now() + Duration::from_millis(40),
            })
            .await
            .unwrap();
    }
    match timeout(Duration::from_secs(3), event_rx.recv())
        .await
        .unwrap()
        .unwrap()
    {
        SocketEvent::Closed { generation, error } => {
            assert_eq!(generation, 19);
            assert!(error.contains("write timed out"), "{error}");
        }
        _ => panic!("expected a terminal writer event"),
    }
    released(&budget).await;
    drop(session);
}

#[tokio::test]
async fn dropping_inner_session_cancels_a_partial_write_and_returns_all_reservations() {
    let (session, mut peer, _event_rx) = bounded_session(3);
    let tasks = session
        .tasks
        .iter()
        .map(|task| task.abort_handle())
        .collect::<Vec<_>>();
    let budget = BufferBudget::new(2 * MAX_FRAME_LEN);
    let frame = vec![6; MAX_FRAME_LEN];
    for _ in 0..2 {
        session
            .send_outbound_tx
            .send(WriterFrame {
                frame: budget.try_copy_bytes(&frame).unwrap(),
                deadline: Instant::now() + Duration::from_secs(10),
            })
            .await
            .unwrap();
    }
    let mut header = [0; 4];
    timeout(Duration::from_secs(2), peer.read_exact(&mut header))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(u32::from_be_bytes(header), MAX_FRAME_LEN as u32);
    assert!(budget.snapshot().used_bytes > 0);
    drop(session);
    released(&budget).await;
    timeout(Duration::from_secs(2), async {
        while tasks.iter().any(|task| !task.is_finished()) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn expired_inner_writer_frame_closes_without_writing_a_prefix_or_leaking_queue() {
    let (session, mut peer, mut event_rx) = bounded_session(21);
    let budget = BufferBudget::new(16);
    for expired in [true, false] {
        session
            .call_outbound_tx
            .send(WriterFrame {
                frame: budget.try_copy_bytes(&[2; 8]).unwrap(),
                deadline: if expired {
                    Instant::now() - Duration::from_millis(1)
                } else {
                    Instant::now() + Duration::from_secs(1)
                },
            })
            .await
            .unwrap();
    }
    match timeout(Duration::from_secs(1), event_rx.recv())
        .await
        .unwrap()
        .unwrap()
    {
        SocketEvent::Closed { error, .. } => assert!(error.contains("before write")),
        _ => panic!("expired queued frame must terminate its stream"),
    }
    released(&budget).await;
    assert_eq!(peer.read(&mut [0; 4]).await.unwrap(), 0);
    drop(session);
}
