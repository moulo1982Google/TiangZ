use std::time::Duration;

use futures_util::StreamExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;

use super::*;

const REQUEST: &[u8] = b"GET /game HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";

async fn socket_pair() -> (TcpStream, TcpStream) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = TcpStream::connect(listener.local_addr().unwrap())
        .await
        .unwrap();
    client.set_nodelay(true).unwrap();
    let (server, _) = listener.accept().await.unwrap();
    (client, server)
}

async fn websocket_fragments(first: usize, second: usize, protocol: EndpointProtocol) {
    let (mut client, server) = socket_pair().await;
    client.write_all(&REQUEST[..first]).await.unwrap();
    let mut accepted = Box::pin(accept_connection(server, protocol, EndpointAudience::Mixed));
    // 先让服务端消费当前分片，再发送余下字节；单线程运行时也必须能唤醒此定时器。
    // Let the server consume each fragment before continuing; this timer must wake on a single-thread runtime.
    assert!(
        timeout(Duration::from_millis(20), &mut accepted)
            .await
            .is_err()
    );
    client.write_all(&REQUEST[first..second]).await.unwrap();
    assert!(
        timeout(Duration::from_millis(20), &mut accepted)
            .await
            .is_err()
    );
    client.write_all(&REQUEST[second..]).await.unwrap();
    let Some(AcceptedConnection::WebSocket(mut websocket)) =
        timeout(Duration::from_secs(1), accepted)
            .await
            .unwrap()
            .unwrap()
    else {
        panic!("fragmented GET was not accepted as WebSocket");
    };
    let mut response = Vec::new();
    timeout(Duration::from_secs(1), async {
        while !response.ends_with(b"\r\n\r\n") {
            response.push(client.read_u8().await.unwrap());
        }
    })
    .await
    .unwrap();
    assert!(response.starts_with(b"HTTP/1.1 101"));
    // 收到 HTTP 101 后才发送首帧，与真实 WebSocket 客户端的顺序一致。
    // Send the first frame only after HTTP 101, as required of a WebSocket client.
    client
        .write_all(&[0x82, 0x82, 1, 2, 3, 4, 0x13, 0x36])
        .await
        .unwrap();
    let message = timeout(Duration::from_secs(1), websocket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(message, Message::Binary(vec![0x12, 0x34].into()));
}

#[tokio::test]
async fn auto_accepts_get_split_after_g() {
    websocket_fragments(1, 3, EndpointProtocol::Auto).await;
}

#[tokio::test]
async fn auto_accepts_get_split_after_ge() {
    websocket_fragments(2, 3, EndpointProtocol::Auto).await;
}

#[tokio::test]
async fn auto_accepts_complete_get_with_split_headers() {
    websocket_fragments(3, 12, EndpointProtocol::Auto).await;
}

#[tokio::test]
async fn explicit_websocket_keeps_handshake_and_first_frame() {
    websocket_fragments(1, 12, EndpointProtocol::WebSocket).await;
}

#[tokio::test]
async fn raw_tcp_keeps_split_length_and_first_frame() {
    for protocol in [EndpointProtocol::Auto, EndpointProtocol::Tcp] {
        let (mut client, server) = socket_pair().await;
        client.write_all(&[0]).await.unwrap();
        let mut accepted = Box::pin(accept_connection(server, protocol, EndpointAudience::Mixed));
        assert!(
            timeout(Duration::from_millis(20), &mut accepted)
                .await
                .is_err()
        );
        client.write_all(&[0, 0, 2, 0x12, 0x34]).await.unwrap();
        let Some(AcceptedConnection::Tcp(AcceptedTcp {
            mut reader,
            mut writer,
            kind,
            first_frame_len,
        })) = timeout(Duration::from_secs(1), accepted)
            .await
            .unwrap()
            .unwrap()
        else {
            panic!("raw TCP was not accepted");
        };
        assert_eq!(kind, ConnectionKind::External);
        assert_eq!(first_frame_len, Some(2));
        let mut frame = [0_u8; 2];
        reader.read_exact(&mut frame).await.unwrap();
        assert_eq!(frame, [0x12, 0x34]);
        writer.write_all(&frame).await.unwrap();
        client.read_exact(&mut frame).await.unwrap();
        assert_eq!(frame, [0x12, 0x34]);
    }
}

#[tokio::test]
async fn incomplete_auto_prefix_eof_finishes() {
    for prefix in [b"".as_slice(), b"G", b"GE"] {
        let (mut client, server) = socket_pair().await;
        client.write_all(prefix).await.unwrap();
        client.shutdown().await.unwrap();
        let result = timeout(
            Duration::from_secs(1),
            accept_connection(server, EndpointProtocol::Auto, EndpointAudience::Mixed),
        )
        .await
        .unwrap();
        assert!(matches!(result, Ok(None) | Err(_)));
    }
}

#[tokio::test]
async fn inner_tcp_keeps_authentication_and_next_length() {
    let (mut client, server) = socket_pair().await;
    let token = inner_token();
    client
        .write_all(&INNER_HANDSHAKE_MAGIC.to_be_bytes())
        .await
        .unwrap();
    client
        .write_all(&(token.len() as u16).to_be_bytes())
        .await
        .unwrap();
    client.write_all(token.as_bytes()).await.unwrap();
    client.write_all(&[0, 0, 0, 2, 0x4e, 0x20]).await.unwrap();
    let Some(AcceptedConnection::Tcp(AcceptedTcp {
        mut reader,
        kind,
        first_frame_len,
        ..
    })) = timeout(
        Duration::from_secs(1),
        accept_connection(server, EndpointProtocol::Auto, EndpointAudience::Mixed),
    )
    .await
    .unwrap()
    .unwrap()
    else {
        panic!("inner TCP was not accepted");
    };
    assert_eq!(kind, ConnectionKind::Internal);
    assert_eq!(first_frame_len, None);
    assert_eq!(reader.read_u32().await.unwrap(), 2);
    assert_eq!(reader.read_u16().await.unwrap(), 20_000);
}

#[tokio::test]
async fn stalled_auto_prefix_http_and_inner_auth_are_bounded_and_close_the_socket() {
    let probes: &[&[u8]] = &[b"", b"G", b"GE", b"GET", b"GET / HTTP/1.1\r\n", b"ETSI"];
    for probe in probes {
        let (mut client, server) = socket_pair().await;
        client.write_all(probe).await.unwrap();
        let result = timeout(
            Duration::from_secs(1),
            accept_until(
                server,
                EndpointProtocol::Auto,
                EndpointAudience::Mixed,
                Instant::now() + Duration::from_millis(50),
            ),
        )
        .await
        .unwrap();
        let error = match result {
            Err(error) => error,
            _ => panic!("stalled Auto handshake must time out"),
        };
        assert!(
            error
                .downcast_ref::<tokio::time::error::Elapsed>()
                .is_some(),
            "{error:#}"
        );
        let closed = timeout(Duration::from_secs(1), client.read_u8())
            .await
            .unwrap();
        assert!(
            closed.is_err(),
            "timed-out connection must release the socket"
        );
    }
}

#[tokio::test]
async fn auto_http_does_not_restart_the_deadline_after_get() {
    let (mut client, server) = socket_pair().await;
    let deadline = Instant::now() + Duration::from_millis(120);
    client.write_all(b"G").await.unwrap();
    let mut accepted = Box::pin(accept_until(
        server,
        EndpointProtocol::Auto,
        EndpointAudience::Mixed,
        deadline,
    ));
    assert!(
        timeout(Duration::from_millis(70), &mut accepted)
            .await
            .is_err()
    );
    client.write_all(b"ET / HTTP/1.1\r\n").await.unwrap();
    let result = timeout_at(deadline + Duration::from_millis(40), accepted)
        .await
        .unwrap();
    assert!(result.is_err());
}

#[tokio::test]
async fn invalid_inner_token_is_still_rejected() {
    let (mut client, server) = socket_pair().await;
    client.write_all(b"ETSI\0\x01x").await.unwrap();
    let result = timeout(
        Duration::from_secs(1),
        accept_connection(server, EndpointProtocol::Auto, EndpointAudience::Mixed),
    )
    .await
    .unwrap();
    assert!(result.is_err());
}

/// 使用真实默认入口验证显式协议也有握手期限，不能只测 Auto 专用辅助函数。 / Tests the production entry point so explicit protocols cannot bypass the handshake deadline.
async fn assert_explicit_handshake_is_bounded(protocol: EndpointProtocol) {
    let (mut client, server) = socket_pair().await;
    client.write_all(b"G").await.unwrap();
    let result = timeout(
        Duration::from_secs(6),
        accept_connection(server, protocol, EndpointAudience::Mixed),
    )
    .await
    .expect("explicit protocol handshake must finish within the same budget as Auto");
    assert!(
        result
            .err()
            .expect("stalled handshake must fail")
            .downcast_ref::<tokio::time::error::Elapsed>()
            .is_some()
    );
    assert!(
        timeout(Duration::from_secs(1), client.read_u8())
            .await
            .unwrap()
            .is_err()
    );
}

#[tokio::test]
async fn explicit_protocol_tcp_handshake_is_bounded() {
    assert_explicit_handshake_is_bounded(EndpointProtocol::Tcp).await;
}

#[tokio::test]
async fn explicit_protocol_websocket_handshake_is_bounded() {
    assert_explicit_handshake_is_bounded(EndpointProtocol::WebSocket).await;
}
