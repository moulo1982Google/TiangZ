//! 隔离原生 TCP 任务的显式诊断，不初始化 V8，不改变正式构建。 / Explicit native TCP task diagnostics without V8 or production-build changes.

use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::atomic::AtomicBool;
use std::thread;

use anyhow::{Context, ensure};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::task::JoinSet;
use tokio::time::{Instant as AsyncInstant, sleep, timeout};

use super::*;
use crate::config::{EndpointAudience, EndpointProtocol, ProcessNetworkConfig, SceneConfig};
use crate::transport::{INNER_HANDSHAKE_MAGIC, inner_token};
use crate::transport_backend::{
    EndpointTask, MAX_FRAME_LEN, create_io_backend, try_queue_connection_frame,
};

const QUEUE_CAPACITY: usize = 64;
const PRESSURE_FRAMES: usize = QUEUE_CAPACITY * 2;
// 只测试传输层，不作为业务协议范例。 / Transport-only message codes, not a business protocol example.
const DATA_CODE: u16 = 24_000;
const CLOSE_CODE: u16 = 24_001;

struct Fixture {
    address: SocketAddr,
    writers: ConnectionWriters,
    stats: Arc<ProcessQueueStats>,
    next_id: Arc<AtomicU64>,
    paused: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    listener: EndpointTask,
    consumer: thread::JoinHandle<Result<Consumed>>,
}

#[derive(Default, serde::Serialize)]
struct Consumed {
    frames: usize,
    control_frames: usize,
    disconnects: usize,
}

#[derive(Default, serde::Serialize)]
struct Completed {
    connections: usize,
    frames: usize,
    endings: [usize; 4],
}

impl Fixture {
    /// 使用与进程入口相同的双队列和唤醒方式；容量缩小以确定性触发背压。 / Use the process's two queues and wakeup path, with a small capacity to force backpressure.
    async fn start() -> Result<Self> {
        let control_capacity = (QUEUE_CAPACITY / PROCESS_CONTROL_QUEUE_DIVISOR).max(1);
        let (control_sender, control_receiver) = mpsc::sync_channel(control_capacity);
        let (data_sender, data_receiver) = mpsc::sync_channel(QUEUE_CAPACITY - control_capacity);
        let (wake_sender, wake_receiver) = mpsc::sync_channel(1);
        let stats = Arc::new(ProcessQueueStats::new(QUEUE_CAPACITY));
        let writers = ConnectionWriters::default();
        let next_id = Arc::new(AtomicU64::new(1));
        let paused = Arc::new(AtomicBool::new(true));
        let stop = Arc::new(AtomicBool::new(false));
        // 与端点测试相同：先取空闲端口再交给正式后端监听。 / As in endpoint tests, reserve a free port and hand it to the production backend.
        let address = std::net::TcpListener::bind("127.0.0.1:0")?.local_addr()?;
        let context = EndpointContext {
            shutdown_timeout: Duration::from_millis(500),
            write_timeout: Duration::from_millis(500),
            scene_index: 0,
            scene: SceneConfig {
                name: "tcp-diagnostic".into(),
                scene_type: "Probe".into(),
                inner_ip: "127.0.0.1".into(),
                bind_ip: None,
                outer_ip: None,
                outer_port: None,
                port: address.port(),
                protocol: EndpointProtocol::Tcp,
                audience: EndpointAudience::Inner,
                static_map_ids: None,
                accept_dynamic_maps: None,
                http: None,
            },
            event_tx: ProcessEventSender {
                control_sender,
                data_sender,
                wake_sender,
                stats: Arc::clone(&stats),
            },
            writers: Arc::clone(&writers),
            next_connection_id: Arc::clone(&next_id),
            stats: Arc::clone(&stats),
        };
        let listener =
            create_io_backend(&ProcessNetworkConfig::default())?.start_endpoint(context)?;
        let event_rx = ProcessEventReceiver::new(
            control_receiver,
            data_receiver,
            wake_receiver,
            Arc::clone(&stats.control_admission),
            Arc::clone(&stats.host_events),
        );
        let consumer = {
            let writers = Arc::clone(&writers);
            let stats = Arc::clone(&stats);
            let paused = Arc::clone(&paused);
            let stop = Arc::clone(&stop);
            thread::spawn(move || consume(event_rx, writers, stats, paused, stop))
        };
        Ok(Self {
            address,
            writers,
            stats,
            next_id,
            paused,
            stop,
            listener,
            consumer,
        })
    }

    /// 成功和失败都回收监听器、连接及消费线程，超时由外围进程再次约束。 / Clean up on success and failure; an external timeout also bounds the entire process.
    async fn finish(self) -> Result<Consumed> {
        // 正式停止顺序：先停准入，再让连接排空。 / Production stop order: stop admission, then drain connections.
        self.listener.request_stop();
        for writer in self.writers.lock().unwrap().values() {
            let _ = writer.shutdown_tx.send(true);
        }
        self.paused.store(false, Ordering::Relaxed);
        // 让断线事件先被消费，再停止接收线程。 / Allow disconnect events to drain before stopping the receiver.
        for _ in 0..100 {
            if self.writers.lock().unwrap().is_empty()
                && self.stats.depth.load(Ordering::Relaxed) == 0
            {
                break;
            }
            sleep(Duration::from_millis(10)).await;
        }
        let listener_result = timeout(Duration::from_secs(5), self.listener)
            .await
            .context("endpoint did not stop")?;
        self.stop.store(true, Ordering::Relaxed);
        let consumed = self
            .consumer
            .join()
            .map_err(|_| anyhow::anyhow!("consumer panicked"))??;
        listener_result.context("endpoint stopped with an error")?;
        ensure!(
            self.writers.lock().unwrap().is_empty(),
            "connection writers not reclaimed"
        );
        ensure!(
            self.stats.depth.load(Ordering::Relaxed) == 0,
            "ingress queue not drained"
        );
        Ok(consumed)
    }
}

/// 用真实事件接收器和发送队列回显，保留控制/数据分流与精确断线计数。 / Echo through real ingress and outbound queues, checking classification and exactly-once disconnects.
fn consume(
    mut events: ProcessEventReceiver,
    writers: ConnectionWriters,
    stats: Arc<ProcessQueueStats>,
    paused: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
) -> Result<Consumed> {
    let mut result = Consumed::default();
    let mut disconnected = HashSet::new();
    while !stop.load(Ordering::Relaxed) {
        if paused.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(1));
            continue;
        }
        let event = match events.recv_timeout(Duration::from_millis(20)) {
            Ok(event) => event,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        stats.dequeue(event.kind(), event.ingress_class());
        match event {
            ProcessEvent::Frame {
                internal,
                scene_index,
                connection_id,
                frame,
                ..
            } => {
                ensure!(
                    internal && scene_index == 0,
                    "wrong connection classification"
                );
                ensure!(
                    !disconnected.contains(&connection_id),
                    "frame after disconnect"
                );
                let writer = writers
                    .lock()
                    .unwrap()
                    .get(&connection_id)
                    .cloned()
                    .context("frame arrived without a writer")?;
                let close = u16::from_be_bytes([frame[0], frame[1]]) == CLOSE_CODE;
                result.control_frames +=
                    usize::from(crate::transport::inner_frame_rpc_id(&frame).is_some());
                try_queue_connection_frame(&writer, frame).map_err(anyhow::Error::msg)?;
                result.frames += 1;
                if close {
                    writer.shutdown_tx.send(true)?;
                }
            }
            ProcessEvent::Disconnect {
                scene_index,
                connection_id,
                ..
            } => {
                ensure!(scene_index == 0, "wrong disconnect scene");
                ensure!(disconnected.insert(connection_id), "duplicate disconnect");
                result.disconnects += 1;
                stats.disconnects.fetch_add(1, Ordering::Release);
            }
            _ => anyhow::bail!("unexpected non-transport event"),
        }
    }
    Ok(result)
}

/// 合成合法 protobuf 包体；不带 rpc_id 的消息走数据队列。 / Produce a valid protobuf body; messages without rpc_id use data ingress.
fn frame(code: u16, size: usize, seed: usize, rpc: bool) -> Vec<u8> {
    let mut frame = code.to_be_bytes().to_vec();
    if rpc {
        frame.extend_from_slice(&[0xd0, 0x05, 1]);
    }
    frame.push(0x0a);
    let mut length = size;
    while length >= 128 {
        frame.push((length as u8 & 0x7f) | 0x80);
        length >>= 7;
    }
    frame.push(length as u8);
    frame.extend((0..size).map(|index| (index.wrapping_add(seed) % 251) as u8));
    frame
}

/// 分段发送真实内网握手，使用当前 token 但不将其写入日志。 / Fragment the real inner handshake without logging the current token.
async fn connect(address: SocketAddr) -> Result<TcpStream> {
    let mut stream = TcpStream::connect(address).await?;
    stream.set_nodelay(true)?;
    let token = inner_token();
    stream
        .write_all(&INNER_HANDSHAKE_MAGIC.to_be_bytes()[..2])
        .await?;
    sleep(Duration::from_millis(1)).await;
    stream
        .write_all(&INNER_HANDSHAKE_MAGIC.to_be_bytes()[2..])
        .await?;
    stream.write_u16(u16::try_from(token.len())?).await?;
    for chunk in token.as_bytes().chunks(3) {
        stream.write_all(chunk).await?;
        tokio::task::yield_now().await;
    }
    Ok(stream)
}

/// 拆开发送长度前缀及包体；TCP 允许合并分段，因此不声称每次 read 都被拆开。 / Split prefix and payload writes; TCP may coalesce them into a single read.
async fn send_frame(stream: &mut TcpStream, frame: &[u8], fragmented: bool) -> Result<()> {
    let prefix = u32::try_from(frame.len())?.to_be_bytes();
    if fragmented {
        stream.write_all(&prefix[..1]).await?;
        tokio::task::yield_now().await;
        stream.write_all(&prefix[1..]).await?;
        for chunk in frame.chunks(257) {
            stream.write_all(chunk).await?;
            tokio::task::yield_now().await;
        }
    } else {
        stream.write_all(&prefix).await?;
        stream.write_all(frame).await?;
    }
    Ok(())
}

/// 逐字节核对回包，拒绝长度异常、截断及错误响应。 / Check exact response bytes and reject invalid lengths, truncation or error replies.
async fn receive_frame(stream: &mut TcpStream, expected: &[u8]) -> Result<()> {
    let length = stream.read_u32().await? as usize;
    ensure!(
        length == expected.len(),
        "response length mismatch: {length}"
    );
    let mut received = vec![0; length];
    stream.read_exact(&mut received).await?;
    ensure!(received == expected, "response bytes mismatch");
    Ok(())
}

/// 正常关闭必须收到 EOF；损坏输入允许对端复位，但不允许额外数据或其他错误。 / Require EOF on clean close; malformed input may reset the connection, never return more data.
async fn closed(stream: &mut TcpStream, malformed: bool) -> Result<()> {
    match stream.read(&mut [0]).await {
        Ok(0) => Ok(()),
        Err(error) if malformed && error.kind() == std::io::ErrorKind::ConnectionReset => Ok(()),
        other => anyhow::bail!("unexpected close result: {other:?}"),
    }
}

/// 先暂停消费直到实际发生背压，随后恢复并核对全部帧，避免只靠睡眠猜测覆盖。 / Pause until measured backpressure, then resume and validate every frame.
async fn exercise_backpressure(fixture: &Fixture) -> Result<Completed> {
    let mut stream = connect(fixture.address).await?;
    let expected = frame(DATA_CODE, 32, 0, false);
    for _ in 0..PRESSURE_FRAMES {
        send_frame(&mut stream, &expected, false).await?;
    }
    timeout(Duration::from_secs(3), async {
        while fixture.stats.backpressure_waits.load(Ordering::Relaxed) == 0 {
            sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .context("backpressure was not exercised")?;
    fixture.paused.store(false, Ordering::Relaxed);
    for _ in 0..PRESSURE_FRAMES {
        receive_frame(&mut stream, &expected).await?;
    }
    stream.shutdown().await?;
    closed(&mut stream, false).await?;
    Ok(Completed {
        connections: 1,
        frames: PRESSURE_FRAMES,
        endings: [0; 4],
    })
}

/// 每轮都先成功收发，再覆盖四条关闭分支，避免把失败建连误当作成功取消。 / Complete traffic before each of four close paths; failed connects never count as cancellation coverage.
async fn connection_cycle(address: SocketAddr, seed: usize, ending: usize) -> Result<usize> {
    let mut stream = connect(address).await?;
    for (size, rpc) in [(32, false), (32_768, false), (32, true)] {
        let expected = frame(DATA_CODE, size, seed, rpc);
        send_frame(&mut stream, &expected, true).await?;
        receive_frame(&mut stream, &expected).await?;
    }
    match ending {
        0 => stream.shutdown().await?,
        1 => {
            let notice = frame(CLOSE_CODE, 32, seed, false);
            send_frame(&mut stream, &notice, true).await?;
            receive_frame(&mut stream, &notice).await?;
        }
        2 => stream.write_u32(MAX_FRAME_LEN as u32 + 1).await?,
        3 => {
            stream.write_u32(128).await?;
            stream.write_all(&[0x5d, 0xc0, 0x0a]).await?;
            stream.shutdown().await?;
        }
        _ => unreachable!(),
    }
    closed(&mut stream, ending >= 2).await?;
    Ok(3 + usize::from(ending == 1))
}

/// 有界并发反复建立/关闭连接，所有客户端任务必须成功 join。 / Churn connections with bounded concurrency and propagate every client task failure.
async fn exercise(fixture: &Fixture, seconds: u64, concurrency: usize) -> Result<Completed> {
    let mut completed = exercise_backpressure(fixture).await?;
    let deadline = AsyncInstant::now() + Duration::from_secs(seconds);
    let mut clients = JoinSet::new();
    for worker in 0..concurrency {
        let address = fixture.address;
        clients.spawn(async move {
            let mut result = Completed::default();
            while AsyncInstant::now() < deadline {
                let ending = result.connections % 4;
                result.frames += timeout(
                    Duration::from_secs(5),
                    connection_cycle(address, worker, ending),
                )
                .await
                .context("connection cycle timed out")??;
                result.connections += 1;
                result.endings[ending] += 1;
            }
            ensure!(
                result.endings.iter().all(|count| *count > 0),
                "not all close paths exercised"
            );
            Result::<Completed>::Ok(result)
        });
    }
    while let Some(result) = clients.join_next().await {
        let result = result.context("client task panicked")??;
        completed.connections += result.connections;
        completed.frames += result.frames;
        for (count, extra) in completed.endings.iter_mut().zip(result.endings) {
            *count += extra;
        }
    }
    timeout(Duration::from_secs(5), async {
        while !fixture.writers.lock().unwrap().is_empty()
            || fixture.stats.depth.load(Ordering::Relaxed) != 0
            // writer 移除早于 Disconnect 入队；必须等消费确认，不能只看瞬时空队列。 / Writer removal precedes Disconnect enqueue; wait for consumption, not transient emptiness.
            || fixture.stats.disconnects.load(Ordering::Acquire) != completed.connections as u64
            || fixture.stats.transport_write_frames.load(Ordering::Relaxed)
                != completed.frames as u64
        {
            sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .context("transport did not drain")?;
    ensure!(
        fixture.next_id.load(Ordering::Relaxed) == completed.connections as u64 + 1,
        "accepted connection count mismatch"
    );
    ensure!(
        fixture.stats.transport_read_frames.load(Ordering::Relaxed) == completed.frames as u64,
        "read count mismatch"
    );
    Ok(completed)
}

/// 限制环境参数，防止误启动无界压测。 / Bound environment overrides to prevent accidental unbounded load.
fn setting(name: &str, default: u64, maximum: u64) -> Result<u64> {
    let value = match std::env::var(name) {
        Ok(value) => value
            .parse::<u64>()
            .with_context(|| format!("invalid {name}"))?,
        Err(std::env::VarError::NotPresent) => default,
        Err(error) => return Err(error.into()),
    };
    ensure!(
        (1..=maximum).contains(&value),
        "{name} must be 1..={maximum}"
    );
    Ok(value)
}

/// 只在显式选择时运行；成功仅代表本轮未复现，不能证明原生崩溃已修复。 / Explicit opt-in only; success means no reproduction in this run, never a native-crash fix.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "bounded native TCP diagnostics; run explicitly with --ignored --exact --nocapture"]
async fn native_tcp_lifecycle_probe() -> Result<()> {
    let seconds = setting("TIANGZ_TCP_DIAGNOSTIC_SECONDS", 5, 60)?;
    let concurrency = setting("TIANGZ_TCP_DIAGNOSTIC_CONNECTIONS", 8, 16)? as usize;
    let fixture = Fixture::start().await?;
    let stats = Arc::clone(&fixture.stats);
    let result = timeout(
        Duration::from_secs(seconds + 15),
        exercise(&fixture, seconds, concurrency),
    )
    .await
    .context("diagnostic deadline exceeded")
    .and_then(|value| value);
    let cleanup = fixture.finish().await;
    println!(
        "TCP_DIAGNOSTIC {}",
        serde_json::json!({
            "seconds": seconds, "concurrency": concurrency, "completed": result.as_ref().ok(),
            "consumed": cleanup.as_ref().ok(), "backpressureWaits": stats.backpressure_waits.load(Ordering::Relaxed),
            "readFrames": stats.transport_read_frames.load(Ordering::Relaxed),
            "writtenFrames": stats.transport_write_frames.load(Ordering::Relaxed),
            "queueDepth": stats.depth.load(Ordering::Relaxed),
            "error": result.as_ref().err().map(|error| format!("{error:#}")),
            "cleanupError": cleanup.as_ref().err().map(|error| format!("{error:#}")),
        })
    );
    let completed = result?;
    let consumed = cleanup?;
    ensure!(
        consumed.disconnects == completed.connections,
        "disconnect count mismatch"
    );
    ensure!(
        consumed.frames == completed.frames,
        "consumed frame count mismatch"
    );
    ensure!(
        consumed.control_frames == completed.connections - 1,
        "control ingress coverage mismatch"
    );
    Ok(())
}

/// 留下已收发的空闲连接再关闭 Runtime，验证监视点在取消析构前撤销。 / Cancel a live, verified connection by dropping its runtime to validate watchpoint retirement.
#[test]
#[ignore = "bounded debugger cancellation fixture; run explicitly with --ignored --exact --nocapture"]
fn native_tcp_cancelled_connection_probe() -> Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    let (stream, fixture) = runtime.block_on(async {
        let fixture = Fixture::start().await?;
        fixture.paused.store(false, Ordering::Relaxed);
        let result = timeout(Duration::from_secs(5), async {
            let mut stream = connect(fixture.address).await?;
            let payload = frame(DATA_CODE, 32, 7, false);
            send_frame(&mut stream, &payload, false).await?;
            receive_frame(&mut stream, &payload).await?;
            Result::<TcpStream>::Ok(stream)
        })
        .await
        .context("cancellation fixture did not exchange a frame")
        .and_then(|value| value);
        match result {
            Ok(stream) => Ok((stream, fixture)),
            Err(error) => {
                fixture.finish().await?;
                Err(error)
            }
        }
    })?;
    // 不走 writer.shutdown 或客户端关闭；确保由 Runtime 销毁取消挂起的连接任务。
    // Keep the peer open and avoid writer shutdown so runtime destruction cancels the pending task.
    fixture.stop.store(true, Ordering::Relaxed);
    let consumed = fixture
        .consumer
        .join()
        .map_err(|_| anyhow::anyhow!("cancellation consumer panicked"))??;
    ensure!(consumed.frames == 1, "missing pre-cancellation traffic");
    ensure!(
        consumed.disconnects == 0,
        "connection closed before cancellation"
    );
    drop(runtime);
    drop(stream);
    println!("TCP_CANCELLATION_FIXTURE verified_frames=1 runtime_dropped=true");
    Ok(())
}
