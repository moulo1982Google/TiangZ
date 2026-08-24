//! 在持久内部连接上多路复用远程 Scene 调用，并实施有界背压。 / Multiplexes remote Scene calls over persistent inner connections with bounded backpressure.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::io::IoSlice;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use bytes::Bytes;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, tcp::OwnedReadHalf, tcp::OwnedWriteHalf};
use tokio::sync::{mpsc, oneshot};
#[cfg(test)]
use tokio::time::timeout;
use tokio::time::{Instant, sleep_until, timeout_at};

const MAX_FRAME_LEN: usize = 1024 * 1024;
const ACTOR_LOCATION_ENVELOPE_MSGCODE: u16 = 29_999;
const ACTOR_LOCATION_ENVELOPE_HEADER_LEN: usize = 14;
const ACTOR_LOCATION_BATCH_ENVELOPE_MSGCODE: u16 = 29_997;
const TRACE_ENVELOPE_MSGCODE: u16 = 29_996;
const TRACE_ENVELOPE_HEADER_LEN: usize = 27;
const TARGET_INGRESS_OVERLOAD_MSGCODE: u16 = 29_998;
const TARGET_INGRESS_OVERLOAD_FRAME_LEN: usize = 6;
const TRANSPORT_QUEUE_CAPACITY: usize = 4096;
const TRANSPORT_CALL_QUEUE_CAPACITY: usize = 1024;
const TRANSPORT_SEND_QUEUE_CAPACITY: usize =
    TRANSPORT_QUEUE_CAPACITY - TRANSPORT_CALL_QUEUE_CAPACITY;
const CONNECTION_QUEUE_CAPACITY: usize = 4096;
const CONNECTION_CALL_QUEUE_CAPACITY: usize = 1024;
const CONNECTION_SEND_QUEUE_CAPACITY: usize =
    CONNECTION_QUEUE_CAPACITY - CONNECTION_CALL_QUEUE_CAPACITY;
const MAX_CONSECUTIVE_CALLS: usize = 32;
const MAX_DIAGNOSTIC_KEYS: usize = 4096;
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
    call_sender: mpsc::Sender<TransportCommand>,
    send_sender: mpsc::Sender<TransportCommand>,
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
    manager_queue_overloads: AtomicU64,
    connection_queue_overloads: AtomicU64,
    call_writer_queue_overloads: AtomicU64,
    send_writer_queue_overloads: AtomicU64,
    target_ingress_queue_overloads: AtomicU64,
    diagnostics: Mutex<HashMap<TransportDiagnosticKey, TransportDiagnosticCounters>>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct RemoteTransportMetricsSnapshot {
    pub(crate) active_connections: u64,
    pub(crate) opened_connections: u64,
    pub(crate) pending_calls: u64,
    pub(crate) max_pending_calls: u64,
    pub(crate) overload_rejections: u64,
    pub(crate) timed_out_calls: u64,
    pub(crate) disconnected_calls: u64,
    pub(crate) late_responses: u64,
    pub(crate) idle_closes: u64,
    pub(crate) overload_stages: Vec<RemoteTransportOverloadSnapshot>,
    pub(crate) diagnostics: Vec<RemoteTransportDiagnosticSnapshot>,
}

#[derive(Debug, Clone)]
pub(crate) struct RemoteTransportOverloadSnapshot {
    pub(crate) stage: &'static str,
    pub(crate) rejections: u64,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct RemoteTransportDiagnosticSnapshot {
    pub(crate) msgcode: u16,
    pub(crate) source: String,
    pub(crate) target: String,
    pub(crate) traffic: &'static str,
    pub(crate) stage: &'static str,
    pub(crate) overloads: u64,
    pub(crate) timeouts: u64,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum TransportTrafficClass {
    Call,
    Send,
}

impl TransportTrafficClass {
    fn label(self) -> &'static str {
        match self {
            Self::Call => "call",
            Self::Send => "send",
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct TransportDiagnosticKey {
    msgcode: u16,
    source: String,
    target: String,
    traffic: TransportTrafficClass,
    stage: &'static str,
}

#[derive(Clone, Copy, Debug, Default)]
struct TransportDiagnosticCounters {
    overloads: u64,
    timeouts: u64,
}

#[derive(Clone, Debug)]
struct TransportContext {
    msgcode: u16,
    source: String,
    target: String,
    traffic: TransportTrafficClass,
}

impl TransportContext {
    fn new(source: String, target: String, frame: &[u8], traffic: TransportTrafficClass) -> Self {
        Self {
            msgcode: metric_msgcode(frame),
            source,
            target,
            traffic,
        }
    }
}

#[derive(Clone, Copy)]
enum RemoteTransportOverloadStage {
    Manager,
    Connection,
    CallWriter,
    SendWriter,
    TargetIngress,
}

impl RemoteTransportMetrics {
    fn snapshot(&self) -> RemoteTransportMetricsSnapshot {
        let mut diagnostics = self
            .diagnostics
            .lock()
            .expect("remote transport diagnostic lock poisoned")
            .iter()
            .map(|(key, counters)| RemoteTransportDiagnosticSnapshot {
                msgcode: key.msgcode,
                source: key.source.clone(),
                target: key.target.clone(),
                traffic: key.traffic.label(),
                stage: key.stage,
                overloads: counters.overloads,
                timeouts: counters.timeouts,
            })
            .collect::<Vec<_>>();
        diagnostics.sort_by(|left, right| {
            left.source
                .cmp(&right.source)
                .then_with(|| left.target.cmp(&right.target))
                .then_with(|| left.msgcode.cmp(&right.msgcode))
                .then_with(|| left.stage.cmp(right.stage))
                .then_with(|| left.traffic.cmp(right.traffic))
        });
        RemoteTransportMetricsSnapshot {
            active_connections: self.active_connections.load(Ordering::Relaxed) as u64,
            opened_connections: self.opened_connections.load(Ordering::Relaxed),
            pending_calls: self.pending_calls.load(Ordering::Relaxed) as u64,
            max_pending_calls: self.max_pending_calls.load(Ordering::Relaxed) as u64,
            overload_rejections: self.overload_rejections.load(Ordering::Relaxed),
            timed_out_calls: self.timed_out_calls.load(Ordering::Relaxed),
            disconnected_calls: self.disconnected_calls.load(Ordering::Relaxed),
            late_responses: self.late_responses.load(Ordering::Relaxed),
            idle_closes: self.idle_closes.load(Ordering::Relaxed),
            overload_stages: vec![
                RemoteTransportOverloadSnapshot {
                    stage: "manager_queue",
                    rejections: self.manager_queue_overloads.load(Ordering::Relaxed),
                },
                RemoteTransportOverloadSnapshot {
                    stage: "connection_queue",
                    rejections: self.connection_queue_overloads.load(Ordering::Relaxed),
                },
                RemoteTransportOverloadSnapshot {
                    stage: "call_writer_queue",
                    rejections: self.call_writer_queue_overloads.load(Ordering::Relaxed),
                },
                RemoteTransportOverloadSnapshot {
                    stage: "send_writer_queue",
                    rejections: self.send_writer_queue_overloads.load(Ordering::Relaxed),
                },
                RemoteTransportOverloadSnapshot {
                    stage: "target_ingress_queue",
                    rejections: self.target_ingress_queue_overloads.load(Ordering::Relaxed),
                },
            ],
            diagnostics,
        }
    }

    fn rejected(&self, stage: RemoteTransportOverloadStage, context: &TransportContext) {
        self.overload_rejections.fetch_add(1, Ordering::Relaxed);
        let counter = match stage {
            RemoteTransportOverloadStage::Manager => &self.manager_queue_overloads,
            RemoteTransportOverloadStage::Connection => &self.connection_queue_overloads,
            RemoteTransportOverloadStage::CallWriter => &self.call_writer_queue_overloads,
            RemoteTransportOverloadStage::SendWriter => &self.send_writer_queue_overloads,
            RemoteTransportOverloadStage::TargetIngress => &self.target_ingress_queue_overloads,
        };
        counter.fetch_add(1, Ordering::Relaxed);
        self.record_diagnostic(context, stage.label(), true, false);
    }

    fn timed_out(&self, context: &TransportContext, stage: &'static str) {
        self.timed_out_calls.fetch_add(1, Ordering::Relaxed);
        self.record_diagnostic(context, stage, false, true);
    }

    fn record_diagnostic(
        &self,
        context: &TransportContext,
        stage: &'static str,
        overload: bool,
        timeout: bool,
    ) {
        let key = TransportDiagnosticKey {
            msgcode: context.msgcode,
            source: context.source.clone(),
            target: context.target.clone(),
            traffic: context.traffic,
            stage,
        };
        let mut diagnostics = self
            .diagnostics
            .lock()
            .expect("remote transport diagnostic lock poisoned");
        if diagnostics.len() >= MAX_DIAGNOSTIC_KEYS && !diagnostics.contains_key(&key) {
            return;
        }
        let counters = diagnostics.entry(key).or_default();
        if overload {
            counters.overloads = counters.overloads.saturating_add(1);
        }
        if timeout {
            counters.timeouts = counters.timeouts.saturating_add(1);
        }
    }

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

impl RemoteTransportHandle {
    fn snapshot(&self) -> RemoteTransportMetricsSnapshot {
        self.metrics.snapshot()
    }
}

struct TransportCommand {
    context: TransportContext,
    address: String,
    frame: Bytes,
    deadline: Instant,
    completion: CommandCompletion,
}

struct ConnectionCommand {
    context: TransportContext,
    frame: Bytes,
    deadline: Instant,
    completion: CommandCompletion,
}

enum CommandCompletion {
    Call(oneshot::Sender<CallResult>),
    Send(oneshot::Sender<SendResult>),
}

impl CommandCompletion {
    fn traffic_class(&self) -> TransportTrafficClass {
        match self {
            Self::Call(_) => TransportTrafficClass::Call,
            Self::Send(_) => TransportTrafficClass::Send,
        }
    }
}

struct PendingCall {
    context: TransportContext,
    deadline: Instant,
    response_tx: oneshot::Sender<CallResult>,
}

struct SocketSession {
    generation: u64,
    call_outbound_tx: mpsc::Sender<Bytes>,
    send_outbound_tx: mpsc::Sender<Bytes>,
}

#[derive(Clone)]
struct ConnectionHandle {
    sender: mpsc::Sender<ConnectionCommand>,
}

impl RemoteTransportOverloadStage {
    fn label(self) -> &'static str {
        match self {
            Self::Manager => "manager_queue",
            Self::Connection => "connection_queue",
            Self::CallWriter => "call_writer_queue",
            Self::SendWriter => "send_writer_queue",
            Self::TargetIngress => "target_ingress_queue",
        }
    }
}

enum SocketEvent {
    Response { generation: u64, frame: Vec<u8> },
    Closed { generation: u64, error: String },
}

/// 只初始化一次进程级远程 Scene 传输管理器。 / Initializes the process-wide remote Scene transport manager exactly once.
pub fn init_remote_transport() {
    if REMOTE_TRANSPORT.get().is_some() {
        return;
    }

    let (call_tx, call_rx) = mpsc::channel(TRANSPORT_CALL_QUEUE_CAPACITY);
    let (send_tx, send_rx) = mpsc::channel(TRANSPORT_SEND_QUEUE_CAPACITY);
    let metrics = Arc::new(RemoteTransportMetrics::default());
    let handle = RemoteTransportHandle {
        call_sender: call_tx,
        send_sender: send_tx,
        metrics: Arc::clone(&metrics),
    };
    if REMOTE_TRANSPORT.set(handle).is_ok() {
        tokio::spawn(run_transport_manager(
            call_rx,
            send_rx,
            Arc::clone(&metrics),
        ));
        tokio::spawn(log_transport_metrics(metrics));
    }
}

pub(crate) fn snapshot_remote_transport() -> Option<RemoteTransportMetricsSnapshot> {
    REMOTE_TRANSPORT.get().map(|transport| transport.snapshot())
}

/// 发送一个多路复用内部 RPC，并且只等待其 rpcId 对应的完成事件。
///
/// 本 Future 等待时，同一 TCP 连接上的其他调用仍可继续。
/// 取消会移除等待者，但无法撤回已经写给对端的数据帧。
///
/// Sends one multiplexed inner RPC and waits only for its rpcId completion.
///
/// Other calls on the same TCP connection continue while this future is
/// pending. Cancellation removes the pending waiter but cannot recall a frame
/// already written to the peer.
pub async fn call_remote_scene(
    source_name: String,
    target_name: String,
    target_ip: String,
    target_port: u16,
    frame: Bytes,
    call_timeout: Duration,
) -> CallResult {
    let Some(transport) = REMOTE_TRANSPORT.get().cloned() else {
        return Err("remote scene transport is not initialized".to_string());
    };
    let address = format!("{target_ip}:{target_port}");
    let deadline = Instant::now() + call_timeout;
    let (response_tx, response_rx) = oneshot::channel();

    let command = TransportCommand {
        context: TransportContext::new(
            source_name,
            target_name,
            &frame,
            TransportTrafficClass::Call,
        ),
        address,
        frame,
        deadline,
        completion: CommandCompletion::Call(response_tx),
    };
    match transport.call_sender.try_send(command) {
        Ok(()) => {}
        Err(mpsc::error::TrySendError::Full(command)) => {
            transport
                .metrics
                .rejected(RemoteTransportOverloadStage::Manager, &command.context);
            return Err(format!(
                "[scene-overloaded] remote call queue is full for {} -> {}",
                command.context.source, command.context.target
            ));
        }
        Err(mpsc::error::TrySendError::Closed(_)) => {
            return Err("remote scene transport is stopped".to_string());
        }
    }

    response_rx
        .await
        .map_err(|_| "remote scene connection dropped the call".to_string())?
}

/// 将单向内部消息入队，不分配响应等待者。 / Queues a one-way inner message without allocating a response waiter.
pub async fn send_remote_scene(
    source_name: String,
    target_name: String,
    target_ip: String,
    target_port: u16,
    frame: Bytes,
    send_timeout: Duration,
) -> SendResult {
    let Some(transport) = REMOTE_TRANSPORT.get().cloned() else {
        return Err("remote scene transport is not initialized".to_string());
    };
    let address = format!("{target_ip}:{target_port}");
    let deadline = Instant::now() + send_timeout;
    let (result_tx, result_rx) = oneshot::channel();
    let command = TransportCommand {
        context: TransportContext::new(
            source_name,
            target_name,
            &frame,
            TransportTrafficClass::Send,
        ),
        address,
        frame,
        deadline,
        completion: CommandCompletion::Send(result_tx),
    };

    match transport.send_sender.try_send(command) {
        Ok(()) => {}
        Err(mpsc::error::TrySendError::Full(command)) => {
            transport
                .metrics
                .rejected(RemoteTransportOverloadStage::Manager, &command.context);
            return Err(format!(
                "[scene-overloaded] remote send queue is full for {} -> {}",
                command.context.source, command.context.target
            ));
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
    mut call_rx: mpsc::Receiver<TransportCommand>,
    mut send_rx: mpsc::Receiver<TransportCommand>,
    metrics: Arc<RemoteTransportMetrics>,
) {
    let mut connections = HashMap::<String, ConnectionHandle>::new();
    let mut call_open = true;
    let mut send_open = true;
    let mut consecutive_calls = 0_usize;

    while call_open || send_open {
        let force_send = consecutive_calls >= MAX_CONSECUTIVE_CALLS && send_open;
        if force_send {
            match send_rx.try_recv() {
                Ok(command) => {
                    consecutive_calls = 0;
                    dispatch_transport_command(&mut connections, command, &metrics);
                    continue;
                }
                Err(mpsc::error::TryRecvError::Disconnected) => send_open = false,
                Err(mpsc::error::TryRecvError::Empty) => {}
            }
        }
        // 强制公平分支可能刚好观察到最后一个发送者关闭；再次检查可避免进入无可用分支的 select。
        // The forced-fairness probe may observe the final sender closing; recheck before entering
        // a select whose every branch would otherwise be disabled.
        if !call_open && !send_open {
            break;
        }
        let command = tokio::select! {
            biased;
            command = call_rx.recv(), if call_open => {
                match command {
                    Some(command) => {
                        consecutive_calls = consecutive_calls.saturating_add(1);
                        Some(command)
                    }
                    None => {
                        call_open = false;
                        None
                    }
                }
            }
            command = send_rx.recv(), if send_open => {
                match command {
                    Some(command) => {
                        consecutive_calls = 0;
                        Some(command)
                    }
                    None => {
                        send_open = false;
                        None
                    }
                }
            }
        };
        let Some(command) = command else {
            continue;
        };
        dispatch_transport_command(&mut connections, command, &metrics);
    }
}

fn dispatch_transport_command(
    connections: &mut HashMap<String, ConnectionHandle>,
    command: TransportCommand,
    metrics: &Arc<RemoteTransportMetrics>,
) {
    let traffic = command.completion.traffic_class();
    // Call与Send必须拥有独立Socket；只拆队列仍会让目标reader在数据背压时阻塞后续RPC。
    // Call and Send require separate sockets. Queue-only separation still lets target-side data
    // backpressure block later RPC frames in the same reader.
    let key = format!(
        "{}->{}:{}",
        command.context.source,
        command.address,
        traffic.label()
    );
    let target_name = command.context.target.clone();
    let context = command.context.clone();
    let connection = connections
        .entry(key)
        .or_insert_with(|| {
            let (call_tx, call_rx) = mpsc::channel(CONNECTION_CALL_QUEUE_CAPACITY);
            let (send_tx, send_rx) = mpsc::channel(CONNECTION_SEND_QUEUE_CAPACITY);
            tokio::spawn(run_connection(
                target_name.clone(),
                command.address.clone(),
                call_rx,
                send_rx,
                Arc::clone(metrics),
            ));
            let sender = match traffic {
                TransportTrafficClass::Call => {
                    drop(send_tx);
                    call_tx
                }
                TransportTrafficClass::Send => {
                    drop(call_tx);
                    send_tx
                }
            };
            ConnectionHandle { sender }
        })
        .clone();

    let connection_command = ConnectionCommand {
        context,
        frame: command.frame,
        deadline: command.deadline,
        completion: command.completion,
    };
    match connection.sender.try_send(connection_command) {
        Ok(()) => {}
        Err(mpsc::error::TrySendError::Full(command)) => {
            metrics.rejected(RemoteTransportOverloadStage::Connection, &command.context);
            fail_completion(
                command.completion,
                format!(
                    "[scene-overloaded] {} connection queue for {} is full",
                    traffic.label(),
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

async fn run_connection(
    target_name: String,
    address: String,
    mut call_rx: mpsc::Receiver<ConnectionCommand>,
    mut send_rx: mpsc::Receiver<ConnectionCommand>,
    metrics: Arc<RemoteTransportMetrics>,
) {
    let (event_tx, mut event_rx) = mpsc::channel(CONNECTION_QUEUE_CAPACITY);
    let mut session: Option<SocketSession> = None;
    let mut generation = 0_u64;
    let mut pending = HashMap::<u32, PendingCall>::new();
    let mut deadlines = BinaryHeap::<Reverse<(Instant, u32)>>::new();
    let mut last_activity = Instant::now();
    let mut call_open = true;
    let mut send_open = true;
    let mut consecutive_calls = 0_usize;

    loop {
        prune_deadlines(&pending, &mut deadlines);
        let next_deadline = deadlines
            .peek()
            .map(|entry| entry.0.0)
            .unwrap_or_else(|| Instant::now() + Duration::from_secs(24 * 60 * 60));
        let idle_deadline = last_activity + INNER_CONNECTION_IDLE_TIMEOUT;

        // Socket响应必须先于持续就绪的命令队列被消费，否则远端已经返回的RPC仍会在本地假超时。
        // Consume one already-queued socket event before ready command queues, otherwise an RPC
        // that already returned remotely can still time out locally under sustained ingress.
        match event_rx.try_recv() {
            Ok(event) => {
                handle_socket_event(
                    event,
                    &target_name,
                    &mut session,
                    &mut pending,
                    &mut last_activity,
                    &metrics,
                );
                continue;
            }
            Err(mpsc::error::TryRecvError::Disconnected) => {
                close_session(&mut session, &metrics);
                fail_all(
                    &mut pending,
                    &format!("scene {target_name} socket event worker stopped"),
                    &metrics,
                );
            }
            Err(mpsc::error::TryRecvError::Empty) => {}
        }
        if !pending.is_empty() && next_deadline <= Instant::now() {
            expire_pending(&mut pending, &mut deadlines, &metrics);
            continue;
        }

        let force_send = consecutive_calls >= MAX_CONSECUTIVE_CALLS && send_open;
        if force_send {
            match send_rx.try_recv() {
                Ok(command) => {
                    consecutive_calls = 0;
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
                    )
                    .await;
                    continue;
                }
                Err(mpsc::error::TryRecvError::Disconnected) => send_open = false,
                Err(mpsc::error::TryRecvError::Empty) => {}
            }
        }
        if !call_open && !send_open {
            close_session(&mut session, &metrics);
            fail_all(
                &mut pending,
                "remote scene connection worker stopped",
                &metrics,
            );
            return;
        }
        tokio::select! {
            biased;
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
            command = call_rx.recv(), if call_open => {
                match command {
                    Some(command) => {
                        consecutive_calls = consecutive_calls.saturating_add(1);
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
                    None => call_open = false,
                }
            }
            command = send_rx.recv(), if send_open => {
                match command {
                    Some(command) => {
                        consecutive_calls = 0;
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
                    None => send_open = false,
                }
            }
            _ = sleep_until(idle_deadline), if session.is_some() && pending.is_empty() => {
                close_session(&mut session, &metrics);
                metrics.idle_closes.fetch_add(1, Ordering::Relaxed);
            }
        }
        if !call_open && !send_open {
            close_session(&mut session, &metrics);
            fail_all(
                &mut pending,
                "remote scene connection worker stopped",
                &metrics,
            );
            return;
        }
    }
}

// Connection state is intentionally local to one worker task; passing the
// pieces explicitly prevents a mutable transport singleton.
#[allow(clippy::too_many_arguments)]
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
        context,
        frame,
        deadline,
        completion,
    } = command;

    if deadline <= Instant::now() {
        metrics.timed_out(&context, "before_send");
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
                metrics.timed_out(&context, "connection");
                fail_completion(
                    completion,
                    format!("connect scene {target_name} at {address} timed out"),
                );
                return;
            }
        }
    }

    match completion {
        CommandCompletion::Call(response_tx) => {
            let rpc_id = rpc_id.expect("call command must carry rpcId");
            pending.insert(
                rpc_id,
                PendingCall {
                    context: context.clone(),
                    deadline,
                    response_tx,
                },
            );
            deadlines.push(Reverse((deadline, rpc_id)));
            metrics.pending_added();
            let outbound_tx = session
                .as_ref()
                .expect("session just connected")
                .call_outbound_tx
                .clone();
            match outbound_tx.try_send(frame) {
                Ok(()) => *last_activity = Instant::now(),
                Err(mpsc::error::TrySendError::Full(_)) => {
                    metrics.rejected(RemoteTransportOverloadStage::CallWriter, &context);
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
        CommandCompletion::Send(result_tx) => {
            let outbound_tx = session
                .as_ref()
                .expect("session just connected")
                .send_outbound_tx
                .clone();
            match outbound_tx.try_send(frame) {
                Ok(()) => {
                    *last_activity = Instant::now();
                    let _ = result_tx.send(Ok(()));
                }
                Err(mpsc::error::TrySendError::Full(_)) => {
                    metrics.rejected(RemoteTransportOverloadStage::SendWriter, &context);
                    let _ = result_tx.send(Err(format!(
                        "[scene-overloaded] scene {target_name} broadcast queue is full"
                    )));
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    close_session(session, metrics);
                    let message = format!("scene {target_name} connection writer is stopped");
                    let _ = result_tx.send(Err(message.clone()));
                    fail_all(pending, &message, metrics);
                }
            }
        }
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
            if let Some(rpc_id) = parse_target_ingress_overload(&frame) {
                if let Some(call) = pending.remove(&rpc_id) {
                    metrics.pending_removed(1);
                    metrics.rejected(RemoteTransportOverloadStage::TargetIngress, &call.context);
                    *last_activity = Instant::now();
                    let _ = call.response_tx.send(Err(format!(
                        "[scene-overloaded] scene {target_name} control ingress queue is full"
                    )));
                } else {
                    metrics.late_responses.fetch_add(1, Ordering::Relaxed);
                }
                return;
            }
            match extract_rpc_id(&frame) {
                Ok(rpc_id) => {
                    if let Some(call) = pending.remove(&rpc_id) {
                        metrics.pending_removed(1);
                        *last_activity = Instant::now();
                        let _ = call.response_tx.send(Ok(frame));
                    } else {
                        metrics.late_responses.fetch_add(1, Ordering::Relaxed);
                        tracing::warn!(
                            target: "tiangz::transport",
                            scene = %target_name,
                            rpc_id,
                            "scene returned unknown or expired rpcId"
                        );
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
    let (call_outbound_tx, call_outbound_rx) = mpsc::channel(CONNECTION_CALL_QUEUE_CAPACITY);
    let (send_outbound_tx, send_outbound_rx) = mpsc::channel(CONNECTION_SEND_QUEUE_CAPACITY);
    tokio::spawn(read_responses(reader, generation, event_tx.clone()));
    tokio::spawn(write_requests(
        writer,
        generation,
        call_outbound_rx,
        send_outbound_rx,
        event_tx,
    ));
    SocketSession {
        generation,
        call_outbound_tx,
        send_outbound_tx,
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
    mut call_rx: mpsc::Receiver<Bytes>,
    mut send_rx: mpsc::Receiver<Bytes>,
    event_tx: mpsc::Sender<SocketEvent>,
) {
    let mut frames = Vec::<Bytes>::with_capacity(INNER_WRITE_BATCH_FRAME_CAPACITY);
    let mut call_open = true;
    let mut send_open = true;
    let mut consecutive_calls = 0_usize;
    while let Some((frame, _)) = next_writer_frame(
        &mut call_rx,
        &mut send_rx,
        &mut call_open,
        &mut send_open,
        &mut consecutive_calls,
    )
    .await
    {
        frames.clear();
        let mut packet_bytes = 4 + frame.len();
        frames.push(frame);
        while frames.len() < INNER_WRITE_BATCH_FRAME_CAPACITY
            && packet_bytes < INNER_WRITE_BATCH_BYTE_CAPACITY
        {
            let Some((frame, _)) = try_next_writer_frame(
                &mut call_rx,
                &mut send_rx,
                &mut call_open,
                &mut send_open,
                &mut consecutive_calls,
            ) else {
                break;
            };
            packet_bytes += 4 + frame.len();
            frames.push(frame);
        }
        if let Err(error) = write_frames_vectored(&mut writer, &frames).await {
            let _ = event_tx
                .send(SocketEvent::Closed { generation, error })
                .await;
            return;
        }
    }
}

async fn next_writer_frame(
    call_rx: &mut mpsc::Receiver<Bytes>,
    send_rx: &mut mpsc::Receiver<Bytes>,
    call_open: &mut bool,
    send_open: &mut bool,
    consecutive_calls: &mut usize,
) -> Option<(Bytes, TransportTrafficClass)> {
    loop {
        if !*call_open && !*send_open {
            return None;
        }
        let force_send = *consecutive_calls >= MAX_CONSECUTIVE_CALLS && *send_open;
        if force_send {
            match send_rx.try_recv() {
                Ok(frame) => {
                    *consecutive_calls = 0;
                    return Some((frame, TransportTrafficClass::Send));
                }
                Err(mpsc::error::TryRecvError::Disconnected) => *send_open = false,
                Err(mpsc::error::TryRecvError::Empty) => {}
            }
        }
        if !*call_open && !*send_open {
            return None;
        }
        let selected = tokio::select! {
            biased;
            frame = call_rx.recv(), if *call_open => {
                match frame {
                    Some(frame) => {
                        *consecutive_calls = consecutive_calls.saturating_add(1);
                        Some((frame, TransportTrafficClass::Call))
                    }
                    None => {
                        *call_open = false;
                        None
                    }
                }
            }
            frame = send_rx.recv(), if *send_open => {
                match frame {
                    Some(frame) => {
                        *consecutive_calls = 0;
                        Some((frame, TransportTrafficClass::Send))
                    }
                    None => {
                        *send_open = false;
                        None
                    }
                }
            }
        };
        if selected.is_some() {
            return selected;
        }
    }
}

fn try_next_writer_frame(
    call_rx: &mut mpsc::Receiver<Bytes>,
    send_rx: &mut mpsc::Receiver<Bytes>,
    call_open: &mut bool,
    send_open: &mut bool,
    consecutive_calls: &mut usize,
) -> Option<(Bytes, TransportTrafficClass)> {
    if !*call_open && !*send_open {
        return None;
    }
    let force_send = *consecutive_calls >= MAX_CONSECUTIVE_CALLS && *send_open;
    let primary = if force_send {
        TransportTrafficClass::Send
    } else {
        TransportTrafficClass::Call
    };
    let secondary = match primary {
        TransportTrafficClass::Call => TransportTrafficClass::Send,
        TransportTrafficClass::Send => TransportTrafficClass::Call,
    };
    for traffic in [primary, secondary] {
        let result = match traffic {
            TransportTrafficClass::Call if *call_open => call_rx.try_recv(),
            TransportTrafficClass::Send if *send_open => send_rx.try_recv(),
            _ => continue,
        };
        match result {
            Ok(frame) => {
                match traffic {
                    TransportTrafficClass::Call => {
                        *consecutive_calls = consecutive_calls.saturating_add(1)
                    }
                    TransportTrafficClass::Send => *consecutive_calls = 0,
                }
                return Some((frame, traffic));
            }
            Err(mpsc::error::TryRecvError::Empty) => {}
            Err(mpsc::error::TryRecvError::Disconnected) => match traffic {
                TransportTrafficClass::Call => *call_open = false,
                TransportTrafficClass::Send => *send_open = false,
            },
        }
    }
    None
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

async fn write_frames_vectored(
    writer: &mut OwnedWriteHalf,
    frames: &[Bytes],
) -> Result<(), String> {
    let lengths = frames
        .iter()
        .map(|frame| {
            u32::try_from(frame.len())
                .map(u32::to_be_bytes)
                .map_err(|_| "scene frame too large".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut slices = Vec::with_capacity(frames.len() * 2);
    for (length, frame) in lengths.iter().zip(frames) {
        slices.push(IoSlice::new(length));
        slices.push(IoSlice::new(frame));
    }
    let mut remaining = slices.as_mut_slice();
    while !remaining.is_empty() {
        let written = writer
            .write_vectored(remaining)
            .await
            .map_err(|error| error.to_string())?;
        if written == 0 {
            return Err("scene connection writer made no progress".to_string());
        }
        IoSlice::advance_slices(&mut remaining, written);
    }
    Ok(())
}

/// 返回内部帧携带的RPC标识；无标识的单向帧可进入数据流保留队列。
/// Returns the RPC identifier carried by an inner frame. One-way frames without one may use the
/// data ingress reservation.
pub(crate) fn inner_frame_rpc_id(frame: &[u8]) -> Option<u32> {
    extract_rpc_id(frame).ok().filter(|rpc_id| *rpc_id != 0)
}

/// 构造不进入TypeScript业务层的目标入口过载响应。 / Builds a target-ingress overload response that bypasses TypeScript business dispatch.
pub(crate) fn build_target_ingress_overload(rpc_id: u32) -> Bytes {
    let mut frame = [0_u8; TARGET_INGRESS_OVERLOAD_FRAME_LEN];
    frame[..2].copy_from_slice(&TARGET_INGRESS_OVERLOAD_MSGCODE.to_be_bytes());
    frame[2..].copy_from_slice(&rpc_id.to_le_bytes());
    Bytes::copy_from_slice(&frame)
}

fn parse_target_ingress_overload(frame: &[u8]) -> Option<u32> {
    if frame.len() != TARGET_INGRESS_OVERLOAD_FRAME_LEN
        || u16::from_be_bytes(frame[..2].try_into().ok()?) != TARGET_INGRESS_OVERLOAD_MSGCODE
    {
        return None;
    }
    Some(u32::from_le_bytes(frame[2..].try_into().ok()?))
}

fn extract_rpc_id(frame: &[u8]) -> Result<u32, String> {
    if frame.len() < 2 {
        return Err("scene frame is shorter than msgcode".to_string());
    }

    let msgcode = u16::from_be_bytes([frame[0], frame[1]]);
    if msgcode == TRACE_ENVELOPE_MSGCODE {
        if frame.len() < TRACE_ENVELOPE_HEADER_LEN + 2 {
            return Err("trace envelope is truncated".to_string());
        }
        return extract_rpc_id(&frame[TRACE_ENVELOPE_HEADER_LEN..]);
    }
    if msgcode == ACTOR_LOCATION_BATCH_ENVELOPE_MSGCODE {
        return Err("actor location batch is a one-way data frame".to_string());
    }
    if msgcode == ACTOR_LOCATION_ENVELOPE_MSGCODE {
        if frame.len() < ACTOR_LOCATION_ENVELOPE_HEADER_LEN + 2 {
            return Err("actor location envelope is truncated".to_string());
        }
        let rpc_id = u32::from_le_bytes(frame[10..14].try_into().unwrap());
        return if rpc_id == 0 {
            Err("actor location RPC frame has zero rpcId".to_string())
        } else {
            Ok(rpc_id)
        };
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

fn metric_msgcode(frame: &[u8]) -> u16 {
    if frame.len() >= TRACE_ENVELOPE_HEADER_LEN + 2
        && u16::from_be_bytes([frame[0], frame[1]]) == TRACE_ENVELOPE_MSGCODE
    {
        return metric_msgcode(&frame[TRACE_ENVELOPE_HEADER_LEN..]);
    }
    if frame.len() >= ACTOR_LOCATION_ENVELOPE_HEADER_LEN + 2
        && u16::from_be_bytes([frame[0], frame[1]]) == ACTOR_LOCATION_ENVELOPE_MSGCODE
    {
        return u16::from_be_bytes([
            frame[ACTOR_LOCATION_ENVELOPE_HEADER_LEN],
            frame[ACTOR_LOCATION_ENVELOPE_HEADER_LEN + 1],
        ]);
    }
    frame
        .get(..2)
        .map(|bytes| u16::from_be_bytes([bytes[0], bytes[1]]))
        .unwrap_or_default()
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
            metrics.timed_out(&call.context, "pending_call");
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
        tracing::info!(target: "tiangz::metrics",
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

    #[test]
    fn extracts_rpc_id_from_fixed_actor_location_header() {
        let mut frame = vec![0_u8; ACTOR_LOCATION_ENVELOPE_HEADER_LEN + 2];
        frame[..2].copy_from_slice(&ACTOR_LOCATION_ENVELOPE_MSGCODE.to_be_bytes());
        frame[2..10].copy_from_slice(&42_u64.to_le_bytes());
        frame[10..14].copy_from_slice(&77_u32.to_le_bytes());
        assert_eq!(extract_rpc_id(&frame).unwrap(), 77);
    }

    #[test]
    fn trace_envelope_preserves_rpc_multiplexing_and_business_msgcode() {
        let business = vec![0, 41, 0xd0, 0x05, 0x4d];
        let mut frame = vec![0_u8; TRACE_ENVELOPE_HEADER_LEN];
        frame[..2].copy_from_slice(&TRACE_ENVELOPE_MSGCODE.to_be_bytes());
        frame[2] = 1;
        frame[18] = 1;
        frame.extend_from_slice(&business);

        assert_eq!(extract_rpc_id(&frame).unwrap(), 77);
        assert_eq!(metric_msgcode(&frame), 41);
    }

    #[test]
    fn trace_envelope_preserves_actor_location_rpc_id() {
        let mut actor = vec![0_u8; ACTOR_LOCATION_ENVELOPE_HEADER_LEN + 2];
        actor[..2].copy_from_slice(&ACTOR_LOCATION_ENVELOPE_MSGCODE.to_be_bytes());
        actor[2..10].copy_from_slice(&42_u64.to_le_bytes());
        actor[10..14].copy_from_slice(&77_u32.to_le_bytes());
        actor[14..16].copy_from_slice(&41_u16.to_be_bytes());
        let mut frame = vec![0_u8; TRACE_ENVELOPE_HEADER_LEN];
        frame[..2].copy_from_slice(&TRACE_ENVELOPE_MSGCODE.to_be_bytes());
        frame[2] = 1;
        frame[18] = 1;
        frame.extend_from_slice(&actor);

        assert_eq!(extract_rpc_id(&frame).unwrap(), 77);
        assert_eq!(metric_msgcode(&frame), 41);
    }

    #[test]
    fn rejects_truncated_trace_envelope() {
        let mut frame = vec![0_u8; TRACE_ENVELOPE_HEADER_LEN + 1];
        frame[..2].copy_from_slice(&TRACE_ENVELOPE_MSGCODE.to_be_bytes());
        assert!(extract_rpc_id(&frame).unwrap_err().contains("truncated"));
    }

    #[test]
    fn zero_rpc_id_marks_actor_location_frame_as_one_way_data() {
        let mut frame = vec![0_u8; ACTOR_LOCATION_ENVELOPE_HEADER_LEN + 2];
        frame[..2].copy_from_slice(&ACTOR_LOCATION_ENVELOPE_MSGCODE.to_be_bytes());
        frame[2..10].copy_from_slice(&42_u64.to_le_bytes());
        frame[10..14].copy_from_slice(&0_u32.to_le_bytes());

        assert!(extract_rpc_id(&frame).unwrap_err().contains("zero rpcId"));
        assert_eq!(inner_frame_rpc_id(&frame), None);
    }

    #[test]
    fn actor_location_batch_is_always_one_way_data() {
        let mut frame = vec![0_u8; 6];
        frame[..2].copy_from_slice(&ACTOR_LOCATION_BATCH_ENVELOPE_MSGCODE.to_be_bytes());
        frame[2..].copy_from_slice(&1_u32.to_le_bytes());

        assert_eq!(inner_frame_rpc_id(&frame), None);
    }

    #[test]
    fn overload_diagnostics_are_dimensioned_without_creating_pending_calls() {
        let metrics = RemoteTransportMetrics::default();
        let context = TransportContext::new(
            "gate-1".to_string(),
            "map-1".to_string(),
            &test_frame(41),
            TransportTrafficClass::Call,
        );
        metrics.rejected(RemoteTransportOverloadStage::Manager, &context);
        metrics.timed_out(&context, "pending_call");

        let snapshot = metrics.snapshot();
        assert_eq!(metrics.pending_calls.load(Ordering::Relaxed), 0);
        assert_eq!(snapshot.overload_rejections, 1);
        assert_eq!(snapshot.timed_out_calls, 1);
        assert_eq!(snapshot.diagnostics.len(), 2);
        assert!(snapshot.diagnostics.iter().any(|diagnostic| {
            diagnostic.msgcode == 1
                && diagnostic.source == "gate-1"
                && diagnostic.target == "map-1"
                && diagnostic.traffic == "call"
                && diagnostic.stage == "manager_queue"
                && diagnostic.overloads == 1
        }));
    }

    #[test]
    fn target_ingress_overload_completes_pending_call_without_timeout() {
        let rpc_id = 43_u32;
        let (call_outbound_tx, _call_outbound_rx) = mpsc::channel(1);
        let (send_outbound_tx, _send_outbound_rx) = mpsc::channel(1);
        let mut session = Some(SocketSession {
            generation: 7,
            call_outbound_tx,
            send_outbound_tx,
        });
        let (response_tx, response_rx) = oneshot::channel();
        let context = TransportContext::new(
            "gate-1".to_string(),
            "map-1".to_string(),
            &test_frame(rpc_id as u8),
            TransportTrafficClass::Call,
        );
        let mut pending = HashMap::from([(
            rpc_id,
            PendingCall {
                context,
                deadline: Instant::now() + Duration::from_secs(1),
                response_tx,
            },
        )]);
        let metrics = RemoteTransportMetrics::default();
        metrics.pending_added();
        let mut last_activity = Instant::now();

        handle_socket_event(
            SocketEvent::Response {
                generation: 7,
                frame: build_target_ingress_overload(rpc_id).to_vec(),
            },
            "map-1",
            &mut session,
            &mut pending,
            &mut last_activity,
            &metrics,
        );

        let result = response_rx.blocking_recv().unwrap();
        assert!(
            result
                .unwrap_err()
                .contains("control ingress queue is full")
        );
        assert!(pending.is_empty());
        assert_eq!(metrics.pending_calls.load(Ordering::Relaxed), 0);
        assert_eq!(metrics.overload_rejections.load(Ordering::Relaxed), 1);
        assert_eq!(metrics.timed_out_calls.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn writer_fairness_serves_send_after_consecutive_calls() {
        let (call_tx, mut call_rx) = mpsc::channel(64);
        let (send_tx, mut send_rx) = mpsc::channel(8);
        for index in 0..(MAX_CONSECUTIVE_CALLS + 1) {
            call_tx.try_send(Bytes::from(vec![index as u8])).unwrap();
        }
        send_tx.try_send(Bytes::from_static(b"send")).unwrap();
        drop(call_tx);
        drop(send_tx);

        let mut call_open = true;
        let mut send_open = true;
        let mut consecutive_calls = 0;
        for _ in 0..MAX_CONSECUTIVE_CALLS {
            let (_, traffic) = try_next_writer_frame(
                &mut call_rx,
                &mut send_rx,
                &mut call_open,
                &mut send_open,
                &mut consecutive_calls,
            )
            .expect("call frame should be available");
            assert_eq!(traffic, TransportTrafficClass::Call);
        }
        let (frame, traffic) = try_next_writer_frame(
            &mut call_rx,
            &mut send_rx,
            &mut call_open,
            &mut send_open,
            &mut consecutive_calls,
        )
        .expect("send frame should be available after fairness threshold");
        assert_eq!(traffic, TransportTrafficClass::Send);
        assert_eq!(frame, Bytes::from_static(b"send"));
    }

    /// 验证公平探测观察到最后一个队列关闭时正常退出，而不是进入全分支禁用的select。
    /// Verifies that observing the final closed queue during the fairness probe exits cleanly
    /// instead of entering a select with every branch disabled.
    #[tokio::test]
    async fn writer_exits_when_force_send_observes_last_closed_queue() {
        let (call_tx, mut call_rx) = mpsc::channel(1);
        let (send_tx, mut send_rx) = mpsc::channel(1);
        drop(call_tx);
        drop(send_tx);

        let mut call_open = false;
        let mut send_open = true;
        let mut consecutive_calls = MAX_CONSECUTIVE_CALLS;
        let selected = next_writer_frame(
            &mut call_rx,
            &mut send_rx,
            &mut call_open,
            &mut send_open,
            &mut consecutive_calls,
        )
        .await;

        assert!(selected.is_none());
        assert!(!send_open);
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
        let worker = run_test_connection(
            "test_scene".to_string(),
            address,
            command_rx,
            Arc::clone(&metrics),
        );

        let (send_tx, send_rx) = oneshot::channel();
        command_tx
            .send(test_connection_command(
                vec![0x4e, 0x26, 0x0a, 0x00],
                Instant::now() + Duration::from_secs(1),
                CommandCompletion::Send(send_tx),
            ))
            .await
            .unwrap();
        send_rx.await.unwrap().unwrap();
        assert_eq!(metrics.pending_calls.load(Ordering::Relaxed), 0);

        let (response_tx, response_rx) = oneshot::channel();
        command_tx
            .send(test_connection_command(
                test_frame(31),
                Instant::now() + Duration::from_secs(1),
                CommandCompletion::Call(response_tx),
            ))
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
        let worker = run_test_connection(
            "test_scene".to_string(),
            address,
            command_rx,
            Arc::clone(&metrics),
        );
        let (response1_tx, mut response1_rx) = oneshot::channel();
        let (response2_tx, response2_rx) = oneshot::channel();
        let deadline = Instant::now() + Duration::from_secs(2);
        command_tx
            .send(test_connection_command(
                test_frame(1),
                deadline,
                CommandCompletion::Call(response1_tx),
            ))
            .await
            .unwrap();
        command_tx
            .send(test_connection_command(
                test_frame(2),
                deadline,
                CommandCompletion::Call(response2_tx),
            ))
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
        let worker = run_test_connection(
            "test_scene".to_string(),
            address,
            command_rx,
            Arc::clone(&metrics),
        );
        let (response1_tx, response1_rx) = oneshot::channel();
        let (response2_tx, response2_rx) = oneshot::channel();
        command_tx
            .send(test_connection_command(
                test_frame(11),
                Instant::now() + Duration::from_millis(80),
                CommandCompletion::Call(response1_tx),
            ))
            .await
            .unwrap();
        command_tx
            .send(test_connection_command(
                test_frame(12),
                Instant::now() + Duration::from_secs(1),
                CommandCompletion::Call(response2_tx),
            ))
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

    /// 验证重复响应只完成一次等待者，后续副本被计为迟到响应。 / Verifies that a duplicate response completes one waiter and its copy is counted as late.
    #[tokio::test]
    async fn duplicate_response_is_ignored_after_first_completion() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_test_handshake(&mut stream).await;
            let frame = read_test_frame(&mut stream).await;
            write_test_frame(&mut stream, &frame).await;
            write_test_frame(&mut stream, &frame).await;
            tokio::time::sleep(Duration::from_millis(50)).await;
        });

        let (command_tx, command_rx) = mpsc::channel(8);
        let metrics = Arc::new(RemoteTransportMetrics::default());
        let worker = run_test_connection(
            "test_scene".to_string(),
            address,
            command_rx,
            Arc::clone(&metrics),
        );
        let (response_tx, response_rx) = oneshot::channel();
        command_tx
            .send(test_connection_command(
                test_frame(21),
                Instant::now() + Duration::from_secs(1),
                CommandCompletion::Call(response_tx),
            ))
            .await
            .unwrap();

        assert!(response_rx.await.unwrap().is_ok());
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(metrics.pending_calls.load(Ordering::Relaxed), 0);
        assert_eq!(metrics.late_responses.load(Ordering::Relaxed), 1);

        drop(command_tx);
        worker.await.unwrap();
        server.await.unwrap();
    }

    /// 验证同一连接上的重复在途 rpcId 被拒绝，但原调用仍可正常完成。 / Verifies that a duplicate in-flight rpcId is rejected without disturbing the original call.
    #[tokio::test]
    async fn duplicate_pending_rpc_id_is_rejected() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_test_handshake(&mut stream).await;
            let frame = read_test_frame(&mut stream).await;
            tokio::time::sleep(Duration::from_millis(30)).await;
            write_test_frame(&mut stream, &frame).await;
        });

        let (command_tx, command_rx) = mpsc::channel(8);
        let metrics = Arc::new(RemoteTransportMetrics::default());
        let worker = run_test_connection(
            "test_scene".to_string(),
            address,
            command_rx,
            Arc::clone(&metrics),
        );
        let deadline = Instant::now() + Duration::from_secs(1);
        let (first_tx, first_rx) = oneshot::channel();
        let (duplicate_tx, duplicate_rx) = oneshot::channel();
        command_tx
            .send(test_connection_command(
                test_frame(22),
                deadline,
                CommandCompletion::Call(first_tx),
            ))
            .await
            .unwrap();
        command_tx
            .send(test_connection_command(
                test_frame(22),
                deadline,
                CommandCompletion::Call(duplicate_tx),
            ))
            .await
            .unwrap();

        assert!(
            duplicate_rx
                .await
                .unwrap()
                .unwrap_err()
                .contains("duplicate pending rpcId")
        );
        assert!(first_rx.await.unwrap().is_ok());
        assert_eq!(metrics.pending_calls.load(Ordering::Relaxed), 0);

        drop(command_tx);
        worker.await.unwrap();
        server.await.unwrap();
    }

    /// 验证连接断开会一次性拒绝其全部 RPC 等待者。 / Verifies that disconnecting a connection rejects all of its RPC waiters.
    #[tokio::test]
    async fn disconnect_rejects_all_pending_calls() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_test_handshake(&mut stream).await;
            let _ = read_test_frame(&mut stream).await;
            let _ = read_test_frame(&mut stream).await;
        });

        let (command_tx, command_rx) = mpsc::channel(8);
        let metrics = Arc::new(RemoteTransportMetrics::default());
        let worker = run_test_connection(
            "test_scene".to_string(),
            address,
            command_rx,
            Arc::clone(&metrics),
        );
        let deadline = Instant::now() + Duration::from_secs(1);
        let (first_tx, first_rx) = oneshot::channel();
        let (second_tx, second_rx) = oneshot::channel();
        for (rpc_id, response_tx) in [(23, first_tx), (24, second_tx)] {
            command_tx
                .send(test_connection_command(
                    test_frame(rpc_id),
                    deadline,
                    CommandCompletion::Call(response_tx),
                ))
                .await
                .unwrap();
        }

        assert!(
            first_rx
                .await
                .unwrap()
                .unwrap_err()
                .contains("connection closed")
        );
        assert!(
            second_rx
                .await
                .unwrap()
                .unwrap_err()
                .contains("connection closed")
        );
        assert_eq!(metrics.pending_calls.load(Ordering::Relaxed), 0);
        assert_eq!(metrics.disconnected_calls.load(Ordering::Relaxed), 2);

        drop(command_tx);
        worker.await.unwrap();
        server.await.unwrap();
    }

    fn test_frame(rpc_id: u8) -> Vec<u8> {
        vec![0, 1, 0xd0, 0x05, rpc_id]
    }

    fn test_connection_command(
        frame: impl Into<Bytes>,
        deadline: Instant,
        completion: CommandCompletion,
    ) -> ConnectionCommand {
        let frame = frame.into();
        let context = TransportContext::new(
            "test_source".to_string(),
            "test_scene".to_string(),
            &frame,
            completion.traffic_class(),
        );
        ConnectionCommand {
            context,
            frame,
            deadline,
            completion,
        }
    }

    fn run_test_connection(
        target_name: String,
        address: String,
        mut command_rx: mpsc::Receiver<ConnectionCommand>,
        metrics: Arc<RemoteTransportMetrics>,
    ) -> tokio::task::JoinHandle<()> {
        let (call_tx, call_rx) = mpsc::channel(8);
        let (send_tx, send_rx) = mpsc::channel(8);
        tokio::spawn(async move {
            let worker = tokio::spawn(run_connection(
                target_name,
                address,
                call_rx,
                send_rx,
                Arc::clone(&metrics),
            ));
            while let Some(command) = command_rx.recv().await {
                let result = match command.completion.traffic_class() {
                    TransportTrafficClass::Call => call_tx.send(command).await,
                    TransportTrafficClass::Send => send_tx.send(command).await,
                };
                if result.is_err() {
                    break;
                }
            }
            drop(call_tx);
            drop(send_tx);
            worker.await.expect("test connection worker panicked");
        })
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
