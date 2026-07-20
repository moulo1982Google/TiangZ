use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, tcp::OwnedReadHalf, tcp::OwnedWriteHalf};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Instant, sleep_until, timeout_at};
#[cfg(test)]
use tokio::time::timeout;

const MAX_FRAME_LEN: usize = 1024 * 1024;
const TRANSPORT_QUEUE_CAPACITY: usize = 1024;
const CONNECTION_QUEUE_CAPACITY: usize = 1024;
pub(crate) const INNER_HANDSHAKE_MAGIC: u32 = u32::from_be_bytes(*b"ETSI");
const DEFAULT_INNER_TOKEN: &str = "ets-local-inner-token";
const MAX_INNER_TOKEN_LEN: usize = 1024;
const INNER_CONNECTION_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const INNER_WRITE_BATCH_FRAME_CAPACITY: usize = 64;
const INNER_WRITE_BATCH_BYTE_CAPACITY: usize = 256 * 1024;

type CallResult = std::result::Result<Vec<u8>, String>;
type SendResult = std::result::Result<(), String>;

static REMOTE_TRANSPORT: OnceLock<RemoteTransportHandle> = OnceLock::new();

#[derive(Clone)]
struct RemoteTransportHandle {
    sender: mpsc::Sender<TransportCommand>,
    metrics: Arc<RemoteTransportMetrics>,
}

#[derive(Default)]
struct RemoteTransportMetrics {
    active_connections: AtomicUsize,
    opened_connections: AtomicU64,
    pending_calls: AtomicUsize,
    max_pending_calls: AtomicUsize,
    overload_rejections: AtomicU64,
    timed_out_calls: AtomicU64,
    disconnected_calls: AtomicU64,
    late_responses: AtomicU64,
    idle_closes: AtomicU64,
}

impl RemoteTransportMetrics {
    fn pending_added(&self) {
        let pending = self.pending_calls.fetch_add(1, Ordering::Relaxed) + 1;
        self.max_pending_calls.fetch_max(pending, Ordering::Relaxed);
    }

    fn pending_removed(&self, count: usize) {
        let _ = self
            .pending_calls
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                Some(value.saturating_sub(count))
            });
    }
}

struct TransportCommand {
    source_name: String,
    target_name: String,
    address: String,
    frame: Vec<u8>,
    deadline: Instant,
    completion: CommandCompletion,
}

struct ConnectionCommand {
    frame: Vec<u8>,
    deadline: Instant,
    completion: CommandCompletion,
}

enum CommandCompletion {
    Call(oneshot::Sender<CallResult>),
    Send(oneshot::Sender<SendResult>),
}

struct PendingCall {
    deadline: Instant,
    response_tx: oneshot::Sender<CallResult>,
}

struct SocketSession {
    generation: u64,
    outbound_tx: mpsc::Sender<Vec<u8>>,
}

enum SocketEvent {
    Response { generation: u64, frame: Vec<u8> },
    Closed { generation: u64, error: String },
}

pub fn init_remote_transport() {
    if REMOTE_TRANSPORT.get().is_some() {
        return;
    }

    let (tx, rx) = mpsc::channel(TRANSPORT_QUEUE_CAPACITY);
    let metrics = Arc::new(RemoteTransportMetrics::default());
    let handle = RemoteTransportHandle {
        sender: tx,
        metrics: Arc::clone(&metrics),
    };
    if REMOTE_TRANSPORT.set(handle).is_ok() {
        tokio::spawn(run_transport_manager(rx, Arc::clone(&metrics)));
        tokio::spawn(log_transport_metrics(metrics));
    }
}

pub async fn call_remote_scene(
    source_name: String,
    target_name: String,
    target_ip: String,
    target_port: u16,
    frame: Vec<u8>,
    call_timeout: Duration,
) -> CallResult {
    let Some(transport) = REMOTE_TRANSPORT.get().cloned() else {
        return Err("remote scene transport is not initialized".to_string());
    };
    let address = format!("{target_ip}:{target_port}");
    let deadline = Instant::now() + call_timeout;
    let (response_tx, response_rx) = oneshot::channel();

    let command = TransportCommand {
        source_name,
        target_name,
        address,
        frame,
        deadline,
        completion: CommandCompletion::Call(response_tx),
    };
    match transport.sender.try_send(command) {
        Ok(()) => {}
        Err(mpsc::error::TrySendError::Full(_)) => {
            transport
                .metrics
                .overload_rejections
                .fetch_add(1, Ordering::Relaxed);
            return Err("[scene-overloaded] remote transport queue is full".to_string());
        }
        Err(mpsc::error::TrySendError::Closed(_)) => {
            return Err("remote scene transport is stopped".to_string());
        }
    }

    response_rx
        .await
        .map_err(|_| "remote scene connection dropped the call".to_string())?
}

pub async fn send_remote_scene(
    source_name: String,
    target_name: String,
    target_ip: String,
    target_port: u16,
    frame: Vec<u8>,
    send_timeout: Duration,
) -> SendResult {
    let Some(transport) = REMOTE_TRANSPORT.get().cloned() else {
        return Err("remote scene transport is not initialized".to_string());
    };
    let address = format!("{target_ip}:{target_port}");
    let deadline = Instant::now() + send_timeout;
    let (result_tx, result_rx) = oneshot::channel();
    let command = TransportCommand {
        source_name,
        target_name,
        address,
        frame,
        deadline,
        completion: CommandCompletion::Send(result_tx),
    };

    match transport.sender.try_send(command) {
        Ok(()) => {}
        Err(mpsc::error::TrySendError::Full(_)) => {
            transport
                .metrics
                .overload_rejections
                .fetch_add(1, Ordering::Relaxed);
            return Err("[scene-overloaded] remote transport queue is full".to_string());
        }
        Err(mpsc::error::TrySendError::Closed(_)) => {
            return Err("remote scene transport is stopped".to_string());
        }
    }

    result_rx
        .await
        .map_err(|_| "remote scene connection dropped the send".to_string())?
}

async fn run_transport_manager(
    mut rx: mpsc::Receiver<TransportCommand>,
    metrics: Arc<RemoteTransportMetrics>,
) {
    let mut connections = HashMap::<String, mpsc::Sender<ConnectionCommand>>::new();

    while let Some(command) = rx.recv().await {
        let target_name = command.target_name.clone();
        let key = format!("{}->{}", command.source_name, command.address);
        let connection_tx = connections
            .entry(key)
            .or_insert_with(|| {
                let (connection_tx, connection_rx) = mpsc::channel(CONNECTION_QUEUE_CAPACITY);
                tokio::spawn(run_connection(
                    command.target_name.clone(),
                    command.address.clone(),
                    connection_rx,
                    Arc::clone(&metrics),
                ));
                connection_tx
            })
            .clone();

        let connection_command = ConnectionCommand {
            frame: command.frame,
            deadline: command.deadline,
            completion: command.completion,
        };
        match connection_tx.try_send(connection_command) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(command)) => {
                metrics.overload_rejections.fetch_add(1, Ordering::Relaxed);
                fail_completion(
                    command.completion,
                    format!(
                        "[scene-overloaded] connection queue for {} is full",
                        target_name
                    ),
                );
            }
            Err(mpsc::error::TrySendError::Closed(command)) => {
                fail_completion(
                    command.completion,
                    "remote scene connection worker is stopped".to_string(),
                );
            }
        }
    }
}

async fn run_connection(
    target_name: String,
    address: String,
    mut command_rx: mpsc::Receiver<ConnectionCommand>,
    metrics: Arc<RemoteTransportMetrics>,
) {
    let (event_tx, mut event_rx) = mpsc::channel(CONNECTION_QUEUE_CAPACITY);
    let mut session: Option<SocketSession> = None;
    let mut generation = 0_u64;
    let mut pending = HashMap::<u32, PendingCall>::new();
    let mut deadlines = BinaryHeap::<Reverse<(Instant, u32)>>::new();
    let mut last_activity = Instant::now();

    loop {
        prune_deadlines(&pending, &mut deadlines);
        let next_deadline = deadlines
            .peek()
            .map(|entry| entry.0.0)
            .unwrap_or_else(|| Instant::now() + Duration::from_secs(24 * 60 * 60));
        let idle_deadline = last_activity + INNER_CONNECTION_IDLE_TIMEOUT;

        tokio::select! {
            command = command_rx.recv() => {
                let Some(command) = command else {
                    close_session(&mut session, &metrics);
                    fail_all(
                        &mut pending,
                        "remote scene connection worker stopped",
                        &metrics,
                    );
                    return;
                };
                handle_command(
                    &target_name,
                    &address,
                    command,
                    &event_tx,
                    &mut session,
                    &mut generation,
                    &mut pending,
                    &mut deadlines,
                    &mut last_activity,
                    &metrics,
                ).await;
            }
            event = event_rx.recv() => {
                if let Some(event) = event {
                    handle_socket_event(
                        event,
                        &target_name,
                        &mut session,
                        &mut pending,
                        &mut last_activity,
                        &metrics,
                    );
                }
            }
            _ = sleep_until(next_deadline), if !pending.is_empty() => {
                expire_pending(&mut pending, &mut deadlines, &metrics);
            }
            _ = sleep_until(idle_deadline), if session.is_some() && pending.is_empty() => {
                close_session(&mut session, &metrics);
                metrics.idle_closes.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

async fn handle_command(
    target_name: &str,
    address: &str,
    command: ConnectionCommand,
    event_tx: &mpsc::Sender<SocketEvent>,
    session: &mut Option<SocketSession>,
    generation: &mut u64,
    pending: &mut HashMap<u32, PendingCall>,
    deadlines: &mut BinaryHeap<Reverse<(Instant, u32)>>,
    last_activity: &mut Instant,
    metrics: &RemoteTransportMetrics,
) {
    let ConnectionCommand {
        frame,
        deadline,
        completion,
    } = command;

    if deadline <= Instant::now() {
        metrics.timed_out_calls.fetch_add(1, Ordering::Relaxed);
        fail_completion(
            completion,
            format!("scene operation to {target_name} expired before send"),
        );
        return;
    }

    let rpc_id = match &completion {
        CommandCompletion::Call(_) => match extract_rpc_id(&frame) {
            Ok(rpc_id) => Some(rpc_id),
            Err(error) => {
                fail_completion(completion, error);
                return;
            }
        },
        CommandCompletion::Send(_) => None,
    };
    if rpc_id.is_some_and(|rpc_id| pending.contains_key(&rpc_id)) {
        fail_completion(
            completion,
            format!(
                "duplicate pending rpcId {} for {target_name}",
                rpc_id.expect("checked above")
            ),
        );
        return;
    }

    if session.is_none() {
        match timeout_at(deadline, TcpStream::connect(address)).await {
            Ok(Ok(mut stream)) => {
                if let Err(error) = stream.set_nodelay(true) {
                    fail_completion(
                        completion,
                        format!(
                            "failed to enable TCP_NODELAY for {target_name} at {address}: {error}"
                        ),
                    );
                    return;
                }
                if let Err(error) = timeout_at(deadline, write_inner_handshake(&mut stream))
                    .await
                    .map_err(|_| "inner handshake timed out".to_string())
                    .and_then(|result| result)
                {
                    fail_completion(
                        completion,
                        format!("failed inner handshake with {target_name} at {address}: {error}"),
                    );
                    return;
                }
                *generation = generation.wrapping_add(1).max(1);
                *session = Some(start_socket_session(stream, *generation, event_tx.clone()));
                metrics.active_connections.fetch_add(1, Ordering::Relaxed);
                metrics.opened_connections.fetch_add(1, Ordering::Relaxed);
                *last_activity = Instant::now();
            }
            Ok(Err(error)) => {
                fail_completion(
                    completion,
                    format!("failed to connect scene {target_name} at {address}: {error}"),
                );
                return;
            }
            Err(_) => {
                fail_completion(
                    completion,
                    format!("connect scene {target_name} at {address} timed out"),
                );
                return;
            }
        }
    }

    let outbound_tx = session
        .as_ref()
        .expect("session just connected")
        .outbound_tx
        .clone();
    match completion {
        CommandCompletion::Call(response_tx) => {
            let rpc_id = rpc_id.expect("call command must carry rpcId");
            pending.insert(
                rpc_id,
                PendingCall {
                    deadline,
                    response_tx,
                },
            );
            deadlines.push(Reverse((deadline, rpc_id)));
            metrics.pending_added();
            match outbound_tx.try_send(frame) {
                Ok(()) => *last_activity = Instant::now(),
                Err(mpsc::error::TrySendError::Full(_)) => {
                    metrics.overload_rejections.fetch_add(1, Ordering::Relaxed);
                    if let Some(call) = pending.remove(&rpc_id) {
                        metrics.pending_removed(1);
                        let _ = call.response_tx.send(Err(format!(
                            "[scene-overloaded] scene {target_name} outbound queue is full"
                        )));
                    }
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    close_session(session, metrics);
                    fail_all(
                        pending,
                        &format!("scene {target_name} connection writer is stopped"),
                        metrics,
                    );
                }
            }
        }
        CommandCompletion::Send(result_tx) => match outbound_tx.try_send(frame) {
            Ok(()) => {
                *last_activity = Instant::now();
                let _ = result_tx.send(Ok(()));
            }
            Err(mpsc::error::TrySendError::Full(_)) => {
                metrics.overload_rejections.fetch_add(1, Ordering::Relaxed);
                let _ = result_tx.send(Err(format!(
                    "[scene-overloaded] scene {target_name} outbound queue is full"
                )));
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                close_session(session, metrics);
                let message = format!("scene {target_name} connection writer is stopped");
                let _ = result_tx.send(Err(message.clone()));
                fail_all(pending, &message, metrics);
            }
        },
    }
}

fn fail_completion(completion: CommandCompletion, error: String) {
    match completion {
        CommandCompletion::Call(response_tx) => {
            let _ = response_tx.send(Err(error));
        }
        CommandCompletion::Send(result_tx) => {
            let _ = result_tx.send(Err(error));
        }
    }
}

fn handle_socket_event(
    event: SocketEvent,
    target_name: &str,
    session: &mut Option<SocketSession>,
    pending: &mut HashMap<u32, PendingCall>,
    last_activity: &mut Instant,
    metrics: &RemoteTransportMetrics,
) {
    match event {
        SocketEvent::Response { generation, frame }
            if session
                .as_ref()
                .is_some_and(|session| session.generation == generation) =>
        {
            match extract_rpc_id(&frame) {
                Ok(rpc_id) => {
                    if let Some(call) = pending.remove(&rpc_id) {
                        metrics.pending_removed(1);
                        *last_activity = Instant::now();
                        let _ = call.response_tx.send(Ok(frame));
                    } else {
                        metrics.late_responses.fetch_add(1, Ordering::Relaxed);
                        eprintln!("scene {target_name} returned unknown or expired rpcId {rpc_id}");
                    }
                }
                Err(error) => {
                    close_session(session, metrics);
                    fail_all(
                        pending,
                        &format!("invalid response from {target_name}: {error}"),
                        metrics,
                    );
                }
            }
        }
        SocketEvent::Closed { generation, error }
            if session
                .as_ref()
                .is_some_and(|session| session.generation == generation) =>
        {
            close_session(session, metrics);
            fail_all(
                pending,
                &format!("scene {target_name} connection closed: {error}"),
                metrics,
            );
        }
        _ => {}
    }
}

fn start_socket_session(
    stream: TcpStream,
    generation: u64,
    event_tx: mpsc::Sender<SocketEvent>,
) -> SocketSession {
    let (reader, writer) = stream.into_split();
    let (outbound_tx, outbound_rx) = mpsc::channel(CONNECTION_QUEUE_CAPACITY);
    tokio::spawn(read_responses(reader, generation, event_tx.clone()));
    tokio::spawn(write_requests(writer, generation, outbound_rx, event_tx));
    SocketSession {
        generation,
        outbound_tx,
    }
}

async fn read_responses(
    mut reader: OwnedReadHalf,
    generation: u64,
    event_tx: mpsc::Sender<SocketEvent>,
) {
    loop {
        let frame = match read_frame(&mut reader).await {
            Ok(frame) => frame,
            Err(error) => {
                let _ = event_tx
                    .send(SocketEvent::Closed { generation, error })
                    .await;
                return;
            }
        };
        if event_tx
            .send(SocketEvent::Response { generation, frame })
            .await
            .is_err()
        {
            return;
        }
    }
}

async fn write_requests(
    mut writer: OwnedWriteHalf,
    generation: u64,
    mut outbound_rx: mpsc::Receiver<Vec<u8>>,
    event_tx: mpsc::Sender<SocketEvent>,
) {
    let mut packet = Vec::with_capacity(INNER_WRITE_BATCH_BYTE_CAPACITY);
    while let Some(frame) = outbound_rx.recv().await {
        packet.clear();
        if let Err(error) = append_frame(&mut packet, &frame) {
            let _ = event_tx
                .send(SocketEvent::Closed { generation, error })
                .await;
            return;
        }
        let mut frame_count = 1;
        while frame_count < INNER_WRITE_BATCH_FRAME_CAPACITY
            && packet.len() < INNER_WRITE_BATCH_BYTE_CAPACITY
        {
            let Ok(frame) = outbound_rx.try_recv() else {
                break;
            };
            if let Err(error) = append_frame(&mut packet, &frame) {
                let _ = event_tx
                    .send(SocketEvent::Closed { generation, error })
                    .await;
                return;
            }
            frame_count += 1;
        }
        if let Err(error) = writer.write_all(&packet).await {
            let _ = event_tx
                .send(SocketEvent::Closed {
                    generation,
                    error: error.to_string(),
                })
                .await;
            return;
        }
    }
}

async fn read_frame(reader: &mut OwnedReadHalf) -> CallResult {
    let length = reader.read_u32().await.map_err(|error| error.to_string())? as usize;
    if !(2..=MAX_FRAME_LEN).contains(&length) {
        return Err(format!("invalid scene response frame length: {length}"));
    }
    let mut frame = vec![0_u8; length];
    reader
        .read_exact(&mut frame)
        .await
        .map_err(|error| error.to_string())?;
    Ok(frame)
}

fn append_frame(packet: &mut Vec<u8>, frame: &[u8]) -> Result<(), String> {
    let length = u32::try_from(frame.len()).map_err(|_| "scene frame too large".to_string())?;
    packet.extend_from_slice(&length.to_be_bytes());
    packet.extend_from_slice(frame);
    Ok(())
}

fn extract_rpc_id(frame: &[u8]) -> Result<u32, String> {
    if frame.len() < 2 {
        return Err("scene frame is shorter than msgcode".to_string());
    }

    let mut offset = 2;
    while offset < frame.len() {
        let tag = read_varint(frame, &mut offset)?;
        let field_number = tag >> 3;
        let wire_type = (tag & 0x07) as u8;
        if field_number == 90 && wire_type == 0 {
            return u32::try_from(read_varint(frame, &mut offset)?)
                .map_err(|_| "rpcId exceeds uint32".to_string())
                .and_then(|rpc_id| {
                    if rpc_id == 0 {
                        Err("scene RPC frame has zero rpcId".to_string())
                    } else {
                        Ok(rpc_id)
                    }
                });
        }
        skip_field(frame, &mut offset, wire_type)?;
    }

    Err("scene RPC frame has no rpcId".to_string())
}

fn read_varint(bytes: &[u8], offset: &mut usize) -> Result<u64, String> {
    let mut value = 0_u64;
    for shift in (0..70).step_by(7) {
        let Some(byte) = bytes.get(*offset).copied() else {
            return Err("unexpected eof while reading varint".to_string());
        };
        *offset += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err("varint is too long".to_string())
}

fn skip_field(bytes: &[u8], offset: &mut usize, wire_type: u8) -> Result<(), String> {
    let length = match wire_type {
        0 => {
            read_varint(bytes, offset)?;
            return Ok(());
        }
        1 => 8,
        2 => usize::try_from(read_varint(bytes, offset)?)
            .map_err(|_| "length-delimited field is too large".to_string())?,
        5 => 4,
        _ => return Err(format!("unsupported protobuf wire type: {wire_type}")),
    };
    let next = offset
        .checked_add(length)
        .filter(|next| *next <= bytes.len())
        .ok_or_else(|| "unexpected eof while skipping protobuf field".to_string())?;
    *offset = next;
    Ok(())
}

fn prune_deadlines(
    pending: &HashMap<u32, PendingCall>,
    deadlines: &mut BinaryHeap<Reverse<(Instant, u32)>>,
) {
    while let Some(Reverse((deadline, rpc_id))) = deadlines.peek().copied() {
        if pending
            .get(&rpc_id)
            .is_some_and(|call| call.deadline == deadline)
        {
            break;
        }
        deadlines.pop();
    }
}

fn expire_pending(
    pending: &mut HashMap<u32, PendingCall>,
    deadlines: &mut BinaryHeap<Reverse<(Instant, u32)>>,
    metrics: &RemoteTransportMetrics,
) {
    let now = Instant::now();
    while let Some(Reverse((deadline, rpc_id))) = deadlines.peek().copied() {
        if deadline > now {
            break;
        }
        deadlines.pop();
        if let Some(call) = pending.remove(&rpc_id) {
            if call.deadline != deadline {
                pending.insert(rpc_id, call);
                continue;
            }
            metrics.pending_removed(1);
            metrics.timed_out_calls.fetch_add(1, Ordering::Relaxed);
            let _ = call
                .response_tx
                .send(Err(format!("scene RPC {rpc_id} timed out")));
        }
    }
}

fn fail_all(
    pending: &mut HashMap<u32, PendingCall>,
    message: &str,
    metrics: &RemoteTransportMetrics,
) {
    let count = pending.len();
    for (_, call) in pending.drain() {
        let _ = call.response_tx.send(Err(message.to_string()));
    }
    metrics.pending_removed(count);
    metrics
        .disconnected_calls
        .fetch_add(count as u64, Ordering::Relaxed);
}

fn close_session(session: &mut Option<SocketSession>, metrics: &RemoteTransportMetrics) {
    if session.take().is_some() {
        let _ = metrics.active_connections.fetch_update(
            Ordering::Relaxed,
            Ordering::Relaxed,
            |value| Some(value.saturating_sub(1)),
        );
    }
}

async fn log_transport_metrics(metrics: Arc<RemoteTransportMetrics>) {
    let mut interval = tokio::time::interval(Duration::from_secs(5));
    interval.tick().await;
    loop {
        interval.tick().await;
        println!(
            "[metrics:inner_transport] active={} opened={} pending={} max_pending={} overloads={} timeouts={} disconnected_calls={} late_responses={} idle_closes={}",
            metrics.active_connections.load(Ordering::Relaxed),
            metrics.opened_connections.load(Ordering::Relaxed),
            metrics.pending_calls.load(Ordering::Relaxed),
            metrics.max_pending_calls.load(Ordering::Relaxed),
            metrics.overload_rejections.load(Ordering::Relaxed),
            metrics.timed_out_calls.load(Ordering::Relaxed),
            metrics.disconnected_calls.load(Ordering::Relaxed),
            metrics.late_responses.load(Ordering::Relaxed),
            metrics.idle_closes.load(Ordering::Relaxed),
        );
    }
}

pub(crate) fn inner_token() -> String {
    std::env::var("ETS_INNER_TOKEN").unwrap_or_else(|_| DEFAULT_INNER_TOKEN.to_string())
}

async fn write_inner_handshake(stream: &mut TcpStream) -> Result<(), String> {
    let token = inner_token();
    if token.is_empty() || token.len() > MAX_INNER_TOKEN_LEN {
        return Err(format!(
            "ETS_INNER_TOKEN length must be within 1..={MAX_INNER_TOKEN_LEN}"
        ));
    }
    let token_len = u16::try_from(token.len()).map_err(|_| "inner token too long".to_string())?;
    stream
        .write_all(&INNER_HANDSHAKE_MAGIC.to_be_bytes())
        .await
        .map_err(|error| error.to_string())?;
    stream
        .write_all(&token_len.to_be_bytes())
        .await
        .map_err(|error| error.to_string())?;
    stream
        .write_all(token.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    stream.flush().await.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn extracts_rpc_id_after_other_fields() {
        let frame = vec![0, 1, 0x08, 0x2a, 0xd0, 0x05, 0x4d];
        assert_eq!(extract_rpc_id(&frame).unwrap(), 77);
    }

    #[tokio::test]
    async fn one_way_send_does_not_block_following_rpc() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_test_handshake(&mut stream).await;
            let message = read_test_frame(&mut stream).await;
            assert_eq!(&message[..2], &[0x4e, 0x26]);
            assert!(extract_rpc_id(&message).is_err());

            let call = read_test_frame(&mut stream).await;
            assert_eq!(extract_rpc_id(&call).unwrap(), 31);
            write_test_frame(&mut stream, &call).await;
        });

        let (command_tx, command_rx) = mpsc::channel(8);
        let metrics = Arc::new(RemoteTransportMetrics::default());
        let worker = tokio::spawn(run_connection(
            "test_scene".to_string(),
            address,
            command_rx,
            Arc::clone(&metrics),
        ));

        let (send_tx, send_rx) = oneshot::channel();
        command_tx
            .send(ConnectionCommand {
                frame: vec![0x4e, 0x26, 0x0a, 0x00],
                deadline: Instant::now() + Duration::from_secs(1),
                completion: CommandCompletion::Send(send_tx),
            })
            .await
            .unwrap();
        send_rx.await.unwrap().unwrap();
        assert_eq!(metrics.pending_calls.load(Ordering::Relaxed), 0);

        let (response_tx, response_rx) = oneshot::channel();
        command_tx
            .send(ConnectionCommand {
                frame: test_frame(31),
                deadline: Instant::now() + Duration::from_secs(1),
                completion: CommandCompletion::Call(response_tx),
            })
            .await
            .unwrap();
        let response = response_rx.await.unwrap().unwrap();
        assert_eq!(extract_rpc_id(&response).unwrap(), 31);
        assert_eq!(metrics.pending_calls.load(Ordering::Relaxed), 0);

        drop(command_tx);
        worker.await.unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn multiplexes_out_of_order_responses_on_one_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_test_handshake(&mut stream).await;
            let first = read_test_frame(&mut stream).await;
            let second = read_test_frame(&mut stream).await;
            assert_eq!(extract_rpc_id(&first).unwrap(), 1);
            assert_eq!(extract_rpc_id(&second).unwrap(), 2);
            write_test_frame(&mut stream, &second).await;
            tokio::time::sleep(Duration::from_millis(150)).await;
            write_test_frame(&mut stream, &first).await;
        });

        let (command_tx, command_rx) = mpsc::channel(8);
        let metrics = Arc::new(RemoteTransportMetrics::default());
        let worker = tokio::spawn(run_connection(
            "test_scene".to_string(),
            address,
            command_rx,
            Arc::clone(&metrics),
        ));
        let (response1_tx, mut response1_rx) = oneshot::channel();
        let (response2_tx, response2_rx) = oneshot::channel();
        let deadline = Instant::now() + Duration::from_secs(2);
        command_tx
            .send(ConnectionCommand {
                frame: test_frame(1),
                deadline,
                completion: CommandCompletion::Call(response1_tx),
            })
            .await
            .unwrap();
        command_tx
            .send(ConnectionCommand {
                frame: test_frame(2),
                deadline,
                completion: CommandCompletion::Call(response2_tx),
            })
            .await
            .unwrap();

        let response2 = timeout(Duration::from_secs(1), response2_rx)
            .await
            .expect("second RPC should not wait for the first")
            .unwrap()
            .unwrap();
        assert_eq!(extract_rpc_id(&response2).unwrap(), 2);
        assert!(
            timeout(Duration::from_millis(10), &mut response1_rx)
                .await
                .is_err(),
            "first RPC should still be pending"
        );
        let response1 = response1_rx.await.unwrap().unwrap();
        assert_eq!(extract_rpc_id(&response1).unwrap(), 1);
        assert_eq!(metrics.pending_calls.load(Ordering::Relaxed), 0);
        assert_eq!(metrics.max_pending_calls.load(Ordering::Relaxed), 2);

        drop(command_tx);
        worker.await.unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn missing_response_times_out_without_blocking_other_calls() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_test_handshake(&mut stream).await;
            let first = read_test_frame(&mut stream).await;
            let second = read_test_frame(&mut stream).await;
            assert_eq!(extract_rpc_id(&first).unwrap(), 11);
            assert_eq!(extract_rpc_id(&second).unwrap(), 12);
            write_test_frame(&mut stream, &second).await;
            tokio::time::sleep(Duration::from_millis(200)).await;
        });

        let (command_tx, command_rx) = mpsc::channel(8);
        let metrics = Arc::new(RemoteTransportMetrics::default());
        let worker = tokio::spawn(run_connection(
            "test_scene".to_string(),
            address,
            command_rx,
            Arc::clone(&metrics),
        ));
        let (response1_tx, response1_rx) = oneshot::channel();
        let (response2_tx, response2_rx) = oneshot::channel();
        command_tx
            .send(ConnectionCommand {
                frame: test_frame(11),
                deadline: Instant::now() + Duration::from_millis(80),
                completion: CommandCompletion::Call(response1_tx),
            })
            .await
            .unwrap();
        command_tx
            .send(ConnectionCommand {
                frame: test_frame(12),
                deadline: Instant::now() + Duration::from_secs(1),
                completion: CommandCompletion::Call(response2_tx),
            })
            .await
            .unwrap();

        let response2 = timeout(Duration::from_millis(500), response2_rx)
            .await
            .expect("second RPC should complete while the first is missing")
            .unwrap()
            .unwrap();
        assert_eq!(extract_rpc_id(&response2).unwrap(), 12);

        let response1 = timeout(Duration::from_millis(500), response1_rx)
            .await
            .expect("missing RPC should reach its own deadline")
            .unwrap();
        assert!(response1.unwrap_err().contains("timed out"));
        assert_eq!(metrics.pending_calls.load(Ordering::Relaxed), 0);
        assert_eq!(metrics.timed_out_calls.load(Ordering::Relaxed), 1);

        drop(command_tx);
        worker.await.unwrap();
        server.await.unwrap();
    }

    fn test_frame(rpc_id: u8) -> Vec<u8> {
        vec![0, 1, 0xd0, 0x05, rpc_id]
    }

    async fn read_test_frame(stream: &mut TcpStream) -> Vec<u8> {
        let length = stream.read_u32().await.unwrap() as usize;
        let mut frame = vec![0; length];
        stream.read_exact(&mut frame).await.unwrap();
        frame
    }

    async fn read_test_handshake(stream: &mut TcpStream) {
        assert_eq!(stream.read_u32().await.unwrap(), INNER_HANDSHAKE_MAGIC);
        let token_len = stream.read_u16().await.unwrap() as usize;
        let mut token = vec![0_u8; token_len];
        stream.read_exact(&mut token).await.unwrap();
        assert_eq!(token, inner_token().as_bytes());
    }

    async fn write_test_frame(stream: &mut TcpStream, frame: &[u8]) {
        stream
            .write_all(&(frame.len() as u32).to_be_bytes())
            .await
            .unwrap();
        stream.write_all(frame).await.unwrap();
        stream.flush().await.unwrap();
    }
}
