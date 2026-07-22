use std::collections::HashMap;
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hash, Hasher};
use std::io::ErrorKind;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use bytes::Bytes;
use tokio::net::UdpSocket;
use tokio::sync::{mpsc, watch};

use super::{
    CONNECTION_OUTBOUND_FRAME_CAPACITY, ConnectionKind, ConnectionWriter, EndpointContext,
    MAX_FRAME_LEN, validate_frame_access,
};
use crate::process::ProcessEvent;
use tiangz_transport::kcp::{KcpConfig, KcpProfile, KcpSession};
use tiangz_transport::kcp_wire::{
    ACCEPT, ACCEPT_BYTES, CHALLENGE, CHALLENGE_BYTES, CLOSE, CLOSE_BYTES, CONNECT, DATA,
    DATA_HEADER_BYTES, HELLO, HELLO_BYTES, PROTOCOL_VERSION, read_u32, read_u64, write_u32,
    write_u64,
};

const COOKIE_BUCKET_SECONDS: u64 = 10;
const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const SESSION_CAPACITY: usize = 65_536;
const OUTBOUND_CAPACITY: usize = 8_192;

struct KcpServerSession {
    connection_id: u64,
    local_conn: u32,
    remote_conn: u32,
    peer: SocketAddr,
    kcp: KcpSession,
    last_activity: Instant,
    queued_bytes: Arc<AtomicUsize>,
    shutdown_tx: watch::Sender<bool>,
}

enum OutboundEvent {
    Frame { local_conn: u32, frame: Bytes },
    Closed { local_conn: u32 },
}

pub(crate) fn start_kcp_endpoint(context: EndpointContext) -> Result<()> {
    let bind_addr = format!("{}:{}", context.scene.ip, context.scene.port);
    let socket = std::net::UdpSocket::bind(&bind_addr).with_context(|| {
        format!(
            "scene {} failed to bind UDP {bind_addr}",
            context.scene.name
        )
    })?;
    socket.set_nonblocking(true)?;
    let socket = UdpSocket::from_std(socket)?;
    println!(
        "scene {} ({}) listening on {} protocol=Kcp audience={:?} io_backend=epoll",
        context.scene.name, context.scene.scene_type, bind_addr, context.scene.audience
    );
    tokio::spawn(async move {
        if let Err(error) = run_kcp_endpoint(socket, context).await {
            eprintln!("KCP endpoint stopped: {error:?}");
        }
    });
    Ok(())
}

async fn run_kcp_endpoint(socket: UdpSocket, context: EndpointContext) -> Result<()> {
    let mut datagram = vec![0_u8; 2048];
    let mut sessions = HashMap::<u32, KcpServerSession>::new();
    let mut session_by_peer = HashMap::<(SocketAddr, u32), u32>::new();
    let cookie_state = RandomState::new();
    let started_at = Instant::now();
    let (outbound_tx, mut outbound_rx) = mpsc::channel::<OutboundEvent>(OUTBOUND_CAPACITY);
    let mut tick = tokio::time::interval(Duration::from_millis(10));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            received = socket.recv_from(&mut datagram) => {
                // Windows surfaces an ICMP port-unreachable from a closed UDP peer as WSAECONNRESET.
                let (length, peer) = match received {
                    Ok(received) => received,
                    Err(error) if error.kind() == ErrorKind::ConnectionReset => continue,
                    Err(error) => return Err(error.into()),
                };
                context.stats.transport_read_completed(0, length);
                handle_datagram(
                    &socket,
                    &context,
                    &cookie_state,
                    started_at,
                    peer,
                    &datagram[..length],
                    &mut sessions,
                    &mut session_by_peer,
                    &outbound_tx,
                ).await?;
            }
            Some(outbound) = outbound_rx.recv() => {
                match outbound {
                    OutboundEvent::Frame { local_conn, frame } => {
                        if let Some(session) = sessions.get_mut(&local_conn) {
                            let frame_len = frame.len();
                            if let Err(error) = validate_frame_access(ConnectionKind::External, &frame)
                                .and_then(|_| session.kcp.send(&frame))
                            {
                                eprintln!("KCP conn {} outbound frame rejected: {error:?}", session.connection_id);
                            } else {
                                session.last_activity = Instant::now();
                            }
                            session.queued_bytes.fetch_sub(frame_len, Ordering::Relaxed);
                        }
                    }
                    OutboundEvent::Closed { local_conn } => {
                        remove_session(
                            &socket,
                            local_conn,
                            &context,
                            &mut sessions,
                            &mut session_by_peer,
                            true,
                        ).await?;
                    }
                }
            }
            _ = tick.tick() => {}
        }

        let now = elapsed_ms(started_at);
        let mut expired = Vec::new();
        for session in sessions.values_mut() {
            session.kcp.update(now);
            flush_kcp_output(&socket, session, &context).await?;
            if session.last_activity.elapsed() >= SESSION_IDLE_TIMEOUT {
                expired.push(session.local_conn);
            }
        }
        for local_conn in expired {
            remove_session(
                &socket,
                local_conn,
                &context,
                &mut sessions,
                &mut session_by_peer,
                true,
            )
            .await?;
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_datagram(
    socket: &UdpSocket,
    context: &EndpointContext,
    cookie_state: &RandomState,
    started_at: Instant,
    peer: SocketAddr,
    packet: &[u8],
    sessions: &mut HashMap<u32, KcpServerSession>,
    session_by_peer: &mut HashMap<(SocketAddr, u32), u32>,
    outbound_tx: &mpsc::Sender<OutboundEvent>,
) -> Result<()> {
    if packet.len() < 2 || packet[1] != PROTOCOL_VERSION {
        return Ok(());
    }
    match packet[0] {
        HELLO if packet.len() == HELLO_BYTES => {
            let client_conn = read_u32(packet, 2);
            let nonce = read_u64(packet, 6);
            if client_conn == 0 {
                return Ok(());
            }
            let bucket = cookie_bucket();
            let cookie = make_cookie(cookie_state, peer, client_conn, nonce, bucket);
            let mut response = [0_u8; CHALLENGE_BYTES];
            response[0] = CHALLENGE;
            response[1] = PROTOCOL_VERSION;
            write_u32(&mut response, 2, client_conn);
            write_u64(&mut response, 6, nonce);
            write_u32(&mut response, 14, bucket);
            write_u64(&mut response, 18, cookie);
            socket.send_to(&response, peer).await?;
            context.stats.transport_write_completed(0, response.len());
        }
        CONNECT if packet.len() == CHALLENGE_BYTES => {
            let client_conn = read_u32(packet, 2);
            let nonce = read_u64(packet, 6);
            let bucket = read_u32(packet, 14);
            let cookie = read_u64(packet, 18);
            if !valid_cookie(cookie_state, peer, client_conn, nonce, bucket, cookie) {
                return Ok(());
            }
            if let Some(&local_conn) = session_by_peer.get(&(peer, client_conn)) {
                send_accept(socket, context, peer, local_conn, client_conn).await?;
                return Ok(());
            }
            if sessions.len() >= SESSION_CAPACITY {
                return Ok(());
            }
            let connection_id = context.next_connection_id.fetch_add(1, Ordering::Relaxed);
            let local_conn = allocate_local_conn(connection_id, sessions)?;
            let profile = KcpProfile::Outer;
            let kcp = KcpSession::new(local_conn, KcpConfig::for_profile(profile))?;
            let (write_tx, write_rx) = mpsc::channel::<Bytes>(CONNECTION_OUTBOUND_FRAME_CAPACITY);
            let queued_bytes = Arc::new(AtomicUsize::new(0));
            let (shutdown_tx, shutdown_rx) = watch::channel(false);
            context
                .writers
                .lock()
                .expect("connection writer map poisoned")
                .insert(
                    connection_id,
                    ConnectionWriter {
                        sender: write_tx,
                        queued_bytes: Arc::clone(&queued_bytes),
                        shutdown_tx: shutdown_tx.clone(),
                    },
                );
            spawn_outbound_forwarder(local_conn, write_rx, shutdown_rx, outbound_tx.clone());
            sessions.insert(
                local_conn,
                KcpServerSession {
                    connection_id,
                    local_conn,
                    remote_conn: client_conn,
                    peer,
                    kcp,
                    last_activity: Instant::now(),
                    queued_bytes,
                    shutdown_tx,
                },
            );
            session_by_peer.insert((peer, client_conn), local_conn);
            send_accept(socket, context, peer, local_conn, client_conn).await?;
        }
        DATA if packet.len() >= DATA_HEADER_BYTES + 24 => {
            let remote_conn = read_u32(packet, 2);
            let local_conn = read_u32(packet, 6);
            let Some(session) = sessions.get_mut(&local_conn) else {
                return Ok(());
            };
            if session.remote_conn != remote_conn || session.peer != peer {
                return Ok(());
            }
            session.kcp.input(&packet[DATA_HEADER_BYTES..])?;
            session.kcp.update(elapsed_ms(started_at));
            session.last_activity = Instant::now();
            while let Some(frame) = session.kcp.receive()? {
                if !(2..=MAX_FRAME_LEN).contains(&frame.len()) {
                    bail!("invalid KCP frame length: {}", frame.len());
                }
                validate_frame_access(ConnectionKind::External, &frame)?;
                context
                    .event_tx
                    .send(
                        ProcessEvent::Frame {
                            scene_index: context.scene_index,
                            connection_id: session.connection_id,
                            frame: frame.into(),
                        },
                        None,
                    )
                    .await
                    .map_err(anyhow::Error::msg)?;
            }
            flush_kcp_output(socket, session, context).await?;
        }
        CLOSE if packet.len() == CLOSE_BYTES => {
            let remote_conn = read_u32(packet, 2);
            let local_conn = read_u32(packet, 6);
            let Some(session) = sessions.get(&local_conn) else {
                return Ok(());
            };
            if session.remote_conn == remote_conn && session.peer == peer {
                remove_session(
                    socket,
                    local_conn,
                    context,
                    sessions,
                    session_by_peer,
                    false,
                )
                .await?;
            }
        }
        _ => {}
    }
    Ok(())
}

async fn send_accept(
    socket: &UdpSocket,
    context: &EndpointContext,
    peer: SocketAddr,
    server_conn: u32,
    client_conn: u32,
) -> Result<()> {
    let mut response = [0_u8; ACCEPT_BYTES];
    response[0] = ACCEPT;
    response[1] = PROTOCOL_VERSION;
    write_u32(&mut response, 2, server_conn);
    write_u32(&mut response, 6, client_conn);
    socket.send_to(&response, peer).await?;
    context.stats.transport_write_completed(0, response.len());
    Ok(())
}

async fn flush_kcp_output(
    socket: &UdpSocket,
    session: &mut KcpServerSession,
    context: &EndpointContext,
) -> Result<()> {
    while let Some(datagram) = session.kcp.take_output() {
        let mut packet = Vec::with_capacity(DATA_HEADER_BYTES + datagram.len());
        packet.push(DATA);
        packet.push(PROTOCOL_VERSION);
        packet.extend_from_slice(&session.local_conn.to_le_bytes());
        packet.extend_from_slice(&session.remote_conn.to_le_bytes());
        packet.extend_from_slice(&datagram);
        socket.send_to(&packet, session.peer).await?;
        context.stats.transport_write_completed(0, packet.len());
    }
    Ok(())
}

fn spawn_outbound_forwarder(
    local_conn: u32,
    mut write_rx: mpsc::Receiver<Bytes>,
    mut shutdown_rx: watch::Receiver<bool>,
    outbound_tx: mpsc::Sender<OutboundEvent>,
) {
    tokio::spawn(async move {
        loop {
            let frame = tokio::select! {
                changed = shutdown_rx.changed() => {
                    if changed.is_err() || *shutdown_rx.borrow() { break; }
                    continue;
                }
                frame = write_rx.recv() => {
                    let Some(frame) = frame else { break; };
                    frame
                }
            };
            if outbound_tx
                .send(OutboundEvent::Frame { local_conn, frame })
                .await
                .is_err()
            {
                break;
            }
        }
        let _ = outbound_tx.send(OutboundEvent::Closed { local_conn }).await;
    });
}

async fn remove_session(
    socket: &UdpSocket,
    local_conn: u32,
    context: &EndpointContext,
    sessions: &mut HashMap<u32, KcpServerSession>,
    session_by_peer: &mut HashMap<(SocketAddr, u32), u32>,
    notify_peer: bool,
) -> Result<()> {
    let Some(session) = sessions.remove(&local_conn) else {
        return Ok(());
    };
    session_by_peer.remove(&(session.peer, session.remote_conn));
    context
        .writers
        .lock()
        .expect("connection writer map poisoned")
        .remove(&session.connection_id);
    let _ = session.shutdown_tx.send(true);
    if notify_peer {
        let mut packet = [0_u8; CLOSE_BYTES];
        packet[0] = CLOSE;
        packet[1] = PROTOCOL_VERSION;
        write_u32(&mut packet, 2, session.local_conn);
        write_u32(&mut packet, 6, session.remote_conn);
        socket.send_to(&packet, session.peer).await?;
        context.stats.transport_write_completed(0, packet.len());
    }
    context
        .event_tx
        .send(
            ProcessEvent::Disconnect {
                scene_index: context.scene_index,
                connection_id: session.connection_id,
            },
            None,
        )
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(())
}

fn allocate_local_conn(
    connection_id: u64,
    sessions: &HashMap<u32, KcpServerSession>,
) -> Result<u32> {
    let mut candidate = (connection_id as u32).wrapping_add(100).max(100);
    for _ in 0..u16::MAX {
        if !sessions.contains_key(&candidate) {
            return Ok(candidate);
        }
        candidate = candidate.wrapping_add(1).max(100);
    }
    bail!("failed to allocate KCP server connection id")
}

fn valid_cookie(
    state: &RandomState,
    peer: SocketAddr,
    client_conn: u32,
    nonce: u64,
    bucket: u32,
    cookie: u64,
) -> bool {
    let now = cookie_bucket();
    (bucket == now || bucket.wrapping_add(1) == now)
        && make_cookie(state, peer, client_conn, nonce, bucket) == cookie
}

fn make_cookie(
    state: &RandomState,
    peer: SocketAddr,
    client_conn: u32,
    nonce: u64,
    bucket: u32,
) -> u64 {
    let mut hasher = state.build_hasher();
    peer.hash(&mut hasher);
    client_conn.hash(&mut hasher);
    nonce.hash(&mut hasher);
    bucket.hash(&mut hasher);
    hasher.finish()
}

fn cookie_bucket() -> u32 {
    (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        / COOKIE_BUCKET_SECONDS) as u32
}

fn elapsed_ms(started_at: Instant) -> u32 {
    started_at.elapsed().as_millis() as u32
}
