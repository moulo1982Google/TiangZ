use super::*;
use crate::config::{EndpointAudience, EndpointProtocol, ProcessNetworkConfig, SceneConfig};
use crate::transport_backend::admission::ConnectionAdmission;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::timeout,
};

struct EndpointFixture {
    task: crate::transport_backend::EndpointTask,
    address: std::net::SocketAddr,
    writers: ConnectionWriters,
    admission: Arc<ConnectionAdmission>,
    _control: mpsc::Receiver<ProcessEvent>,
    _data: mpsc::Receiver<ProcessEvent>,
    _wake: mpsc::Receiver<()>,
}

/// 通过生产 backend 启动端点，隔离 Tokio 测试运行时持有其任务生命周期。 / Starts the production backend within an isolated Tokio test runtime.
fn endpoint(audience: EndpointAudience, protocol: EndpointProtocol) -> EndpointFixture {
    let network = ProcessNetworkConfig::default();
    endpoint_with_admission(
        audience,
        protocol,
        Arc::new(ConnectionAdmission::new(
            network.max_accepted_connections,
            network.max_pending_handshakes,
        )),
    )
}

/// 多个真实端点使用相同准入所有者，复现生产 Process 的共享范围。 / Shares one admission owner across real endpoints, matching the production process scope.
fn endpoint_with_admission(
    audience: EndpointAudience,
    protocol: EndpointProtocol,
    admission: Arc<ConnectionAdmission>,
) -> EndpointFixture {
    let address = if protocol == EndpointProtocol::Kcp {
        std::net::UdpSocket::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
    } else {
        std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
    };
    let stats = Arc::new(ProcessQueueStats {
        admission: admission.clone(),
        ..ProcessQueueStats::new(16)
    });
    let writers = Arc::new(Mutex::new(HashMap::new()));
    let (control_sender, control) = mpsc::sync_channel(8);
    let (data_sender, data) = mpsc::sync_channel(8);
    let (wake_sender, wake) = mpsc::sync_channel(1);
    let scene = SceneConfig {
        name: "audience-test".into(),
        scene_type: "Fixture".into(),
        inner_ip: "127.0.0.1".into(),
        bind_ip: None,
        outer_ip: None,
        outer_port: None,
        port: address.port(),
        protocol,
        audience,
        static_map_ids: None,
        accept_dynamic_maps: None,
    };
    let task = create_io_backend(&ProcessNetworkConfig::default())
        .unwrap()
        .start_endpoint(EndpointContext {
            shutdown_timeout: Duration::from_millis(500),
            write_timeout: Duration::from_millis(500),
            scene_index: 0,
            scene,
            event_tx: ProcessEventSender {
                control_sender,
                data_sender,
                wake_sender,
                stats: stats.clone(),
            },
            writers: writers.clone(),
            next_connection_id: Arc::new(AtomicU64::new(1)),
            stats,
        })
        .unwrap();
    EndpointFixture {
        task,
        address,
        writers,
        admission,
        _control: control,
        _data: data,
        _wake: wake,
    }
}

/// 只发准入前导，不向业务队列投递消息。 / Sends only the admission preamble, without business frames.
async fn preamble(fixture: &EndpointFixture, internal: bool) -> TcpStream {
    let mut client = TcpStream::connect(fixture.address).await.unwrap();
    if internal {
        let token = crate::transport::inner_token();
        client
            .write_u32(crate::transport::INNER_HANDSHAKE_MAGIC)
            .await
            .unwrap();
        client.write_u16(token.len() as u16).await.unwrap();
        client.write_all(token.as_bytes()).await.unwrap();
    } else {
        client.write_u32(2).await.unwrap();
    }
    client
}

/// 确认拒绝发生在 writer 登记和业务投递之前。 / Verifies rejection precedes writer registration and business delivery.
async fn assert_rejected(mut client: TcpStream, fixture: &EndpointFixture) {
    let result = timeout(Duration::from_millis(400), client.read(&mut [0u8])).await;
    assert!(
        matches!(result, Ok(Ok(0)))
            || matches!(result, Ok(Err(ref error)) if error.kind() == std::io::ErrorKind::ConnectionReset),
        "endpoint must close a disallowed connection: {result:?}"
    );
    assert!(fixture.writers.lock().unwrap().is_empty());
    assert!(fixture._data.try_recv().is_err());
    assert!(fixture._control.try_recv().is_err());
    wait_admission(&fixture.admission, 0, 0).await;
}

/// 在真实任务调度后检查资源回收，不把客户端 connect 成功当作服务端已接受。 / Observes real task scheduling rather than assuming client connect means server admission.
async fn wait_admission(admission: &ConnectionAdmission, connections: u64, handshakes: u64) {
    timeout(Duration::from_secs(1), async {
        loop {
            let snapshot = admission.snapshot();
            if snapshot.connections == connections && snapshot.handshakes == handshakes {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "admission did not settle at {connections}/{handshakes}: {:?}",
            admission.snapshot()
        )
    });
}

/// 过载关闭新 Socket，已有其他连接仍可登记与工作。 / Checks overload closes only the new socket while existing connections remain registered.
async fn assert_capacity_rejected(mut client: TcpStream) {
    let result = timeout(Duration::from_secs(1), client.read(&mut [0u8]))
        .await
        .unwrap();
    assert!(
        matches!(result, Ok(0))
            || matches!(result, Err(ref error) if error.kind() == std::io::ErrorKind::ConnectionReset),
        "capacity rejection must close socket: {result:?}"
    );
}

#[tokio::test]
async fn process_admission_is_shared_across_tcp_and_websocket_listeners_and_recovers() {
    let admission = Arc::new(ConnectionAdmission::new(2, 1));
    let tcp = endpoint_with_admission(
        EndpointAudience::Outer,
        EndpointProtocol::Tcp,
        admission.clone(),
    );
    let websocket = endpoint_with_admission(
        EndpointAudience::Outer,
        EndpointProtocol::WebSocket,
        admission.clone(),
    );
    let mut slow = TcpStream::connect(tcp.address).await.unwrap();
    wait_admission(&admission, 1, 1).await;
    assert_capacity_rejected(TcpStream::connect(websocket.address).await.unwrap()).await;
    wait_admission(&admission, 1, 1).await;
    assert_eq!(admission.snapshot().handshake_rejections, 1);
    assert_eq!(admission.snapshot().connection_rejections, 0);

    slow.write_u32(2).await.unwrap();
    wait_registered(&tcp).await;
    wait_admission(&admission, 1, 0).await;
    let web_client = websocket_client(&websocket).await;
    wait_admission(&admission, 2, 0).await;
    assert_capacity_rejected(TcpStream::connect(tcp.address).await.unwrap()).await;
    assert_eq!(admission.snapshot().connection_rejections, 1);
    assert_eq!(tcp.writers.lock().unwrap().len(), 1);
    assert_eq!(websocket.writers.lock().unwrap().len(), 1);

    drop(slow);
    wait_admission(&admission, 1, 0).await;
    let recovered = preamble(&tcp, false).await;
    wait_registered(&tcp).await;
    wait_admission(&admission, 2, 0).await;
    tcp.task.request_stop();
    timeout(Duration::from_secs(1), tcp.task)
        .await
        .unwrap()
        .unwrap();
    wait_admission(&admission, 1, 0).await;
    drop(websocket);
    wait_admission(&admission, 0, 0).await;
    drop((recovered, web_client));
}

#[tokio::test]
async fn inner_endpoints_reject_external_tcp_before_business_registration() {
    for protocol in [EndpointProtocol::Tcp, EndpointProtocol::Auto] {
        let fixture = endpoint(EndpointAudience::Inner, protocol);
        let client = preamble(&fixture, false).await;
        assert_rejected(client, &fixture).await;
    }
}

#[tokio::test]
async fn outer_endpoints_reject_authenticated_inner_tcp_before_business_registration() {
    for protocol in [EndpointProtocol::Tcp, EndpointProtocol::Auto] {
        let fixture = endpoint(EndpointAudience::Outer, protocol);
        let client = preamble(&fixture, true).await;
        assert_rejected(client, &fixture).await;
    }
}

#[tokio::test]
async fn inner_auto_endpoint_rejects_websocket_before_http_upgrade() {
    let fixture = endpoint(EndpointAudience::Inner, EndpointProtocol::Auto);
    let mut client = TcpStream::connect(fixture.address).await.unwrap();
    client.write_all(b"GET").await.unwrap();
    assert_rejected(client, &fixture).await;
}

#[tokio::test]
async fn allowed_audiences_keep_normal_connection_lifecycle() {
    for protocol in [EndpointProtocol::Tcp, EndpointProtocol::Auto] {
        for (audience, internal) in [
            (EndpointAudience::Mixed, false),
            (EndpointAudience::Mixed, true),
            (EndpointAudience::Inner, true),
            (EndpointAudience::Outer, false),
        ] {
            let fixture = endpoint(audience, protocol);
            let client = preamble(&fixture, internal).await;
            timeout(Duration::from_secs(1), async {
                while fixture.writers.lock().unwrap().is_empty() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            drop(client);
            timeout(Duration::from_secs(1), async {
                while !fixture.writers.lock().unwrap().is_empty() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        }
    }
}

/// 完成真实 HTTP Upgrade，保留原始 Socket 以控制未完成的数据帧。 / Completes HTTP Upgrade and keeps the raw socket for incomplete-frame tests.
async fn websocket_client(fixture: &EndpointFixture) -> TcpStream {
    let mut client = TcpStream::connect(fixture.address).await.unwrap();
    client.write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n").await.unwrap();
    let mut response = Vec::new();
    timeout(Duration::from_secs(1), async {
        while !response.ends_with(b"\r\n\r\n") {
            response.push(client.read_u8().await.unwrap());
        }
    })
    .await
    .unwrap();
    assert!(response.starts_with(b"HTTP/1.1 101"));
    client
}

/// 使用零 mask 的合法客户端帧，只测试传输大小而不构造业务协议。 / Uses a valid zero-mask client frame to test transport sizes without a business protocol.
async fn websocket_header(client: &mut TcpStream, opcode: u8, length: usize) {
    client.write_all(&[opcode, 0x80 | 127]).await.unwrap();
    client.write_u64(length as u64).await.unwrap();
    client.write_all(&[0; 4]).await.unwrap();
}

/// 等待解码器主动断开，并确保没有向业务层提交不完整消息。 / Awaits decoder rejection and verifies no incomplete message reaches business ingress.
async fn assert_websocket_rejected(mut client: TcpStream, fixture: &EndpointFixture) {
    let result = timeout(Duration::from_secs(1), client.read(&mut [0u8])).await;
    assert!(
        matches!(result, Ok(Ok(0)))
            || matches!(result, Ok(Err(ref error)) if error.kind() == std::io::ErrorKind::ConnectionReset),
        "oversized websocket must close before more payload: {result:?}"
    );
    assert!(fixture.writers.lock().unwrap().is_empty());
    assert!(fixture._data.try_recv().is_err());
}

#[tokio::test]
async fn websocket_rejects_oversized_frame_header_without_reading_payload() {
    for protocol in [EndpointProtocol::WebSocket, EndpointProtocol::Auto] {
        let fixture = endpoint(EndpointAudience::Outer, protocol);
        let mut client = websocket_client(&fixture).await;
        websocket_header(
            &mut client,
            0x82,
            crate::transport_backend::MAX_FRAME_LEN + 1,
        )
        .await;
        assert_websocket_rejected(client, &fixture).await;
    }
}

#[tokio::test]
async fn websocket_rejects_oversized_fragmented_message_before_final_fragment() {
    let fixture = endpoint(EndpointAudience::Outer, EndpointProtocol::WebSocket);
    let mut client = websocket_client(&fixture).await;
    let fragment = vec![0; crate::transport_backend::MAX_FRAME_LEN / 2 + 1];
    websocket_header(&mut client, 0x02, fragment.len()).await;
    client.write_all(&fragment).await.unwrap();
    websocket_header(&mut client, 0x00, fragment.len()).await;
    client.write_all(&fragment).await.unwrap();
    assert_websocket_rejected(client, &fixture).await;
}

#[tokio::test]
async fn websocket_accepts_fragmented_message_at_exact_size_limit() {
    let fixture = endpoint(EndpointAudience::Outer, EndpointProtocol::WebSocket);
    let mut client = websocket_client(&fixture).await;
    let fragment = vec![0; crate::transport_backend::MAX_FRAME_LEN / 2];
    websocket_header(&mut client, 0x02, fragment.len()).await;
    client.write_all(&fragment).await.unwrap();
    websocket_header(&mut client, 0x80, fragment.len()).await;
    client.write_all(&fragment).await.unwrap();
    let event = timeout(Duration::from_secs(1), async {
        loop {
            if let Ok(event) = fixture._data.try_recv() {
                break event;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(
        matches!(event, ProcessEvent::Frame { frame, .. } if frame.len() == crate::transport_backend::MAX_FRAME_LEN)
    );
    assert_eq!(fixture.writers.lock().unwrap().len(), 1);
}

/// 等待生产连接完成登记，避免把未启动任务当作取消成功。 / Waits for production registration so cancellation cannot pass without starting a connection.
async fn wait_registered(fixture: &EndpointFixture) {
    timeout(Duration::from_secs(1), async {
        while fixture.writers.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn slow_tcp_reader_expires_actual_outbound_write_and_reclaims_registration() {
    let fixture = endpoint(EndpointAudience::Outer, EndpointProtocol::Tcp);
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.set_recv_buffer_size(1024).unwrap();
    let mut client = socket.connect(fixture.address).await.unwrap();
    client.write_u32(2).await.unwrap();
    wait_registered(&fixture).await;
    let writer = fixture
        .writers
        .lock()
        .unwrap()
        .values()
        .next()
        .unwrap()
        .clone();
    let frame = Bytes::from(vec![0; crate::transport_backend::MAX_FRAME_LEN]);
    try_queue_connection_frame(&writer, frame.clone()).unwrap();
    // 收到真实帧头证明写入已开始，再停止读取，直到窗口及本机发送缓存耗尽。
    // Receiving the real header proves writing started; stop reading until both TCP buffers fill.
    assert_eq!(
        timeout(Duration::from_secs(1), client.read_u32())
            .await
            .unwrap()
            .unwrap(),
        frame.len() as u32
    );
    let mut admitted = 1;
    timeout(Duration::from_secs(2), async {
        while !writer.sender.is_closed() {
            match try_queue_connection_frame(&writer, frame.clone()) {
                Ok(()) => {
                    admitted += 1;
                    assert!(
                        admitted <= 64,
                        "fixture must establish actual backpressure within 64 MiB"
                    );
                }
                Err(crate::transport_backend::ConnectionQueueError::ByteLimit) => {}
                Err(crate::transport_backend::ConnectionQueueError::Closed) => break,
                Err(error) => panic!("unexpected queue result: {error}"),
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        while !fixture.writers.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("slow write must expire without endpoint shutdown");
    assert!(admitted > 1);
    assert_eq!(writer.queued_bytes.load(Ordering::Relaxed), 0);
    assert_eq!(writer.queued_frames.load(Ordering::Relaxed), 0);
    assert!(matches!(
        fixture._control.try_recv(),
        Ok(ProcessEvent::Disconnect { .. })
    ));
}

#[tokio::test]
async fn endpoint_drop_reclaims_active_connections_and_releases_listener() {
    for protocol in [EndpointProtocol::Tcp, EndpointProtocol::WebSocket] {
        let fixture = endpoint(EndpointAudience::Outer, protocol);
        let mut client = if protocol == EndpointProtocol::Tcp {
            preamble(&fixture, false).await
        } else {
            websocket_client(&fixture).await
        };
        wait_registered(&fixture).await;
        let address = fixture.address;
        let writers = fixture.writers.clone();
        let admission = fixture.admission.clone();
        drop(fixture);
        let result = timeout(Duration::from_secs(1), client.read(&mut [0u8]))
            .await
            .unwrap();
        assert!(
            matches!(result, Ok(0))
                || matches!(result, Err(ref error) if error.kind() == std::io::ErrorKind::ConnectionReset)
        );
        assert!(writers.lock().unwrap().is_empty());
        wait_admission(&admission, 0, 0).await;
        let _rebound = std::net::TcpListener::bind(address).unwrap();
    }
}

#[tokio::test]
async fn endpoint_stop_cancels_incomplete_handshakes_and_releases_listener() {
    for protocol in [
        EndpointProtocol::Tcp,
        EndpointProtocol::Auto,
        EndpointProtocol::WebSocket,
    ] {
        let fixture = endpoint(EndpointAudience::Outer, protocol);
        let mut client = TcpStream::connect(fixture.address).await.unwrap();
        client.write_all(b"G").await.unwrap();
        wait_admission(&fixture.admission, 1, 1).await;
        fixture.task.request_stop();
        timeout(Duration::from_secs(1), fixture.task)
            .await
            .unwrap()
            .unwrap();
        let result = timeout(Duration::from_secs(1), client.read(&mut [0u8]))
            .await
            .unwrap();
        assert!(
            matches!(result, Ok(0))
                || matches!(result, Err(ref error) if error.kind() == std::io::ErrorKind::ConnectionReset)
        );
        assert!(fixture.writers.lock().unwrap().is_empty());
        wait_admission(&fixture.admission, 0, 0).await;
        let _rebound = std::net::TcpListener::bind(fixture.address).unwrap();
    }
}

#[tokio::test]
async fn endpoint_stop_drains_already_queued_tcp_notice_before_close() {
    let fixture = endpoint(EndpointAudience::Outer, EndpointProtocol::Tcp);
    let mut client = preamble(&fixture, false).await;
    wait_registered(&fixture).await;
    {
        let writers = fixture.writers.lock().unwrap();
        let writer = writers.values().next().unwrap();
        try_queue_connection_frame(writer, Bytes::from_static(&[0, 1])).unwrap();
    }
    fixture.task.request_stop();
    let mut received = Vec::new();
    timeout(Duration::from_secs(1), client.read_to_end(&mut received))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(received, [0, 0, 0, 2, 0, 1]);
    timeout(Duration::from_secs(1), fixture.task)
        .await
        .unwrap()
        .unwrap();
    assert!(fixture.writers.lock().unwrap().is_empty());
}

#[cfg(feature = "kcp")]
#[tokio::test]
async fn process_admission_counts_kcp_only_after_cookie_and_shares_tcp_capacity() {
    use tiangz_transport::kcp_wire::*;
    let admission = Arc::new(ConnectionAdmission::new(1, 1));
    let tcp = endpoint_with_admission(
        EndpointAudience::Outer,
        EndpointProtocol::Tcp,
        admission.clone(),
    );
    let kcp = endpoint_with_admission(
        EndpointAudience::Outer,
        EndpointProtocol::Kcp,
        admission.clone(),
    );
    let slow = TcpStream::connect(tcp.address).await.unwrap();
    wait_admission(&admission, 1, 1).await;
    let udp = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    udp.connect(kcp.address).await.unwrap();
    let mut hello = [0; HELLO_BYTES];
    hello[0] = HELLO;
    hello[1] = PROTOCOL_VERSION;
    write_u32(&mut hello, 2, 77);
    write_u64(&mut hello, 6, 123);
    udp.send(&hello).await.unwrap();
    let mut connect = [0; CHALLENGE_BYTES];
    assert_eq!(
        timeout(Duration::from_secs(1), udp.recv(&mut connect))
            .await
            .unwrap()
            .unwrap(),
        CHALLENGE_BYTES
    );
    assert_eq!(connect[0], CHALLENGE);
    assert_eq!(admission.snapshot().handshake_rejections, 0);
    assert!(kcp.writers.lock().unwrap().is_empty());

    connect[0] = CONNECT;
    udp.send(&connect).await.unwrap();
    timeout(Duration::from_secs(1), async {
        while admission.snapshot().connection_rejections == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(kcp.writers.lock().unwrap().is_empty());
    drop(slow);
    wait_admission(&admission, 0, 0).await;
    let mut accepted = [0; ACCEPT_BYTES];
    for _ in 0..2 {
        // 同一已认证 CONNECT 的重传必须重用现有 Session，不再申请名额。
        // A retransmitted authenticated CONNECT must reuse its session without another slot.
        udp.send(&connect).await.unwrap();
        assert_eq!(
            timeout(Duration::from_secs(1), udp.recv(&mut accepted))
                .await
                .unwrap()
                .unwrap(),
            ACCEPT_BYTES
        );
        assert_eq!(accepted[0], ACCEPT);
        wait_admission(&admission, 1, 0).await;
        assert_eq!(kcp.writers.lock().unwrap().len(), 1);
        assert_eq!(admission.snapshot().connection_rejections, 1);
    }
    assert_capacity_rejected(TcpStream::connect(tcp.address).await.unwrap()).await;
    assert_eq!(admission.snapshot().connection_rejections, 2);
    let mut close = [0; CLOSE_BYTES];
    close[0] = CLOSE;
    close[1] = PROTOCOL_VERSION;
    write_u32(&mut close, 2, 77);
    write_u32(&mut close, 6, read_u32(&accepted, 2));
    udp.send(&close).await.unwrap();
    wait_admission(&admission, 0, 0).await;

    let _client = tiangz_transport::KcpClient::connect(kcp.address)
        .await
        .unwrap();
    wait_admission(&admission, 1, 0).await;
    kcp.task.request_stop();
    timeout(Duration::from_secs(1), kcp.task)
        .await
        .unwrap()
        .unwrap();
    wait_admission(&admission, 0, 0).await;
}

#[cfg(feature = "kcp")]
#[tokio::test]
async fn kcp_endpoint_stop_releases_udp_listener() {
    let fixture = endpoint(EndpointAudience::Outer, EndpointProtocol::Kcp);
    fixture.task.request_stop();
    timeout(Duration::from_secs(1), fixture.task)
        .await
        .unwrap()
        .unwrap();
    let _rebound = std::net::UdpSocket::bind(fixture.address).unwrap();
}

#[cfg(feature = "kcp")]
#[tokio::test]
async fn invalid_kcp_session_cannot_stop_listener_or_other_sessions() {
    use futures_util::FutureExt;
    let mut fixture = endpoint(EndpointAudience::Outer, EndpointProtocol::Kcp);
    let mut bad_client = tiangz_transport::KcpClient::connect(fixture.address)
        .await
        .unwrap();
    let mut good_client = tiangz_transport::KcpClient::connect(fixture.address)
        .await
        .unwrap();
    // 直接测试传输准入：外部 KCP 不得投递内部保留 msgcode。
    // Tests transport admission directly: outer KCP cannot deliver a reserved inner msgcode.
    let invalid = crate::transport_backend::INNER_MSGCODE_START.to_be_bytes();
    assert!(
        bad_client
            .request(&invalid, Duration::from_millis(50))
            .await
            .is_err()
    );
    assert!(
        (&mut fixture.task).now_or_never().is_none(),
        "one invalid KCP session stopped its endpoint"
    );
    assert_eq!(fixture.writers.lock().unwrap().len(), 1);
    let (response, ()) = tokio::join!(
        good_client.request(&[0, 1], Duration::from_secs(1)),
        async {
            timeout(Duration::from_secs(1), async {
                loop {
                    if let Ok(ProcessEvent::Frame {
                        connection_id,
                        frame,
                        ..
                    }) = fixture._data.try_recv()
                    {
                        let writers = fixture.writers.lock().unwrap();
                        try_queue_connection_frame(writers.get(&connection_id).unwrap(), frame)
                            .unwrap();
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        }
    );
    assert_eq!(response.unwrap(), [0, 1]);
    fixture.task.request_stop();
    timeout(Duration::from_secs(1), fixture.task)
        .await
        .unwrap()
        .unwrap();
    assert!(fixture.writers.lock().unwrap().is_empty());
}
