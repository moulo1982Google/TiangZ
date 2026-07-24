use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use serde_json::json;
use sysinfo::{Pid, ProcessesToUpdate, System};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{Semaphore, mpsc};
use tokio::time::{Instant, sleep_until};

const MAX_FRAME_LEN: usize = 1024 * 1024;
const GET_LOGIN_ADDR_REQ: u16 = 10002;
const GET_LOGIN_ADDR_RESP: u16 = 10003;
const LOGIN_REQ: u16 = 10004;
const LOGIN_RESP: u16 = 10005;
const LOGIN_GATE_REQ: u16 = 10008;
const LOGIN_GATE_RESP: u16 = 10009;
const ENTER_MAP_REQ: u16 = 10010;
const ENTER_MAP_RESP: u16 = 10011;
const MAP_READY: u16 = 10012;
const MAP_MOVE: u16 = 10013;
const MAP_PROBE_REQ: u16 = 10014;
const MAP_PROBE_RESP: u16 = 10015;
const ENTITY_MOVE: u16 = 10016;
const ENTITY_NUMERIC: u16 = 10017;
const ENTITY_STATE: u16 = 10018;
const CLIENT_PING: u16 = 10024;
const ITEM_CHANGED: u16 = 10021;
const STATE_SYNC_BENCH_REQ: u16 = 15006;
const STATE_SYNC_BENCH_RESP: u16 = 15007;
const CLIENT_PING_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, PartialEq, Eq)]
enum StateSyncMode {
    Off,
    Numeric,
    PlayerInfo,
    Item,
    Mixed,
}

impl StateSyncMode {
    fn parse(value: &str) -> Result<Self> {
        match value.to_ascii_lowercase().as_str() {
            "off" => Ok(Self::Off),
            "numeric" => Ok(Self::Numeric),
            "player" | "playerinfo" => Ok(Self::PlayerInfo),
            "item" => Ok(Self::Item),
            "mixed" => Ok(Self::Mixed),
            _ => bail!("invalid --state-sync-mode {value}"),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Numeric => "numeric",
            Self::PlayerInfo => "playerInfo",
            Self::Item => "item",
            Self::Mixed => "mixed",
        }
    }

    fn request_mode(self, sequence: u32) -> u32 {
        match self {
            Self::Numeric => 1,
            Self::PlayerInfo => 2,
            Self::Item => 3,
            Self::Mixed => sequence.saturating_sub(1) % 3 + 1,
            Self::Off => 0,
        }
    }
}

#[derive(Clone)]
struct Options {
    host: String,
    manager_port: u16,
    players: usize,
    setup_concurrency: usize,
    warmup: Duration,
    duration: Duration,
    timeout: Duration,
    move_rate: u64,
    movement_hold_messages: u32,
    probe_rate: u64,
    probe_concurrency: usize,
    state_sync_mode: StateSyncMode,
    state_sync_rate: u64,
    state_sync_concurrency: usize,
    label: String,
}

struct Address {
    ip: String,
    port: u16,
}

struct LoginResult {
    token: String,
    gate: Address,
}

struct PlayerConnection {
    frame_rx: mpsc::UnboundedReceiver<Result<Vec<u8>>>,
    reader_task: tokio::task::JoinHandle<()>,
    writer_tx: mpsc::Sender<Vec<u8>>,
    writer_task: tokio::task::JoinHandle<()>,
    entity_move_pushes: Arc<AtomicU64>,
    state_pushes: StatePushCounters,
    next_rpc_id: u32,
    unit_id: u32,
}

#[derive(Clone)]
struct StatePushCounters {
    numeric_frames: Arc<AtomicU64>,
    numeric_items: Arc<AtomicU64>,
    numeric_bytes: Arc<AtomicU64>,
    player_info_frames: Arc<AtomicU64>,
    player_info_items: Arc<AtomicU64>,
    player_info_bytes: Arc<AtomicU64>,
    item_frames: Arc<AtomicU64>,
    item_items: Arc<AtomicU64>,
    item_bytes: Arc<AtomicU64>,
}

impl StatePushCounters {
    fn new() -> Self {
        Self {
            numeric_frames: Arc::new(AtomicU64::new(0)),
            numeric_items: Arc::new(AtomicU64::new(0)),
            numeric_bytes: Arc::new(AtomicU64::new(0)),
            player_info_frames: Arc::new(AtomicU64::new(0)),
            player_info_items: Arc::new(AtomicU64::new(0)),
            player_info_bytes: Arc::new(AtomicU64::new(0)),
            item_frames: Arc::new(AtomicU64::new(0)),
            item_items: Arc::new(AtomicU64::new(0)),
            item_bytes: Arc::new(AtomicU64::new(0)),
        }
    }

    fn snapshot(&self) -> StatePushSnapshot {
        StatePushSnapshot {
            numeric_frames: self.numeric_frames.load(Ordering::Relaxed),
            numeric_items: self.numeric_items.load(Ordering::Relaxed),
            numeric_bytes: self.numeric_bytes.load(Ordering::Relaxed),
            player_info_frames: self.player_info_frames.load(Ordering::Relaxed),
            player_info_items: self.player_info_items.load(Ordering::Relaxed),
            player_info_bytes: self.player_info_bytes.load(Ordering::Relaxed),
            item_frames: self.item_frames.load(Ordering::Relaxed),
            item_items: self.item_items.load(Ordering::Relaxed),
            item_bytes: self.item_bytes.load(Ordering::Relaxed),
        }
    }
}

#[derive(Clone, Copy, Default)]
struct StatePushSnapshot {
    numeric_frames: u64,
    numeric_items: u64,
    numeric_bytes: u64,
    player_info_frames: u64,
    player_info_items: u64,
    player_info_bytes: u64,
    item_frames: u64,
    item_items: u64,
    item_bytes: u64,
}

impl StatePushSnapshot {
    fn saturating_sub(self, earlier: Self) -> Self {
        Self {
            numeric_frames: self.numeric_frames.saturating_sub(earlier.numeric_frames),
            numeric_items: self.numeric_items.saturating_sub(earlier.numeric_items),
            numeric_bytes: self.numeric_bytes.saturating_sub(earlier.numeric_bytes),
            player_info_frames: self
                .player_info_frames
                .saturating_sub(earlier.player_info_frames),
            player_info_items: self
                .player_info_items
                .saturating_sub(earlier.player_info_items),
            player_info_bytes: self
                .player_info_bytes
                .saturating_sub(earlier.player_info_bytes),
            item_frames: self.item_frames.saturating_sub(earlier.item_frames),
            item_items: self.item_items.saturating_sub(earlier.item_items),
            item_bytes: self.item_bytes.saturating_sub(earlier.item_bytes),
        }
    }
}

#[derive(Clone, Copy)]
struct Timing {
    measurement_start: Instant,
    send_deadline: Instant,
}

#[derive(Clone, Copy)]
enum PendingKind {
    Probe,
    StateSync { mode: u32 },
}

struct PendingRequest {
    started_at: Instant,
    sequence: u32,
    measured: bool,
    kind: PendingKind,
}

#[derive(Default)]
struct PlayerResult {
    latencies_micros: Vec<u64>,
    probe_errors: u64,
    move_errors: u64,
    move_sent: u64,
    move_skipped: u64,
    entity_move_pushes: u64,
    state_sync_latencies_micros: Vec<u64>,
    state_sync_errors: u64,
    state_sync_sent: u64,
    numeric_pushes: u64,
    numeric_items: u64,
    numeric_bytes: u64,
    player_info_pushes: u64,
    player_info_items: u64,
    player_info_bytes: u64,
    item_pushes: u64,
    item_items: u64,
    item_bytes: u64,
}

#[tokio::main]
async fn main() -> Result<()> {
    let process_pid = Pid::from_u32(std::process::id());
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::Some(&[process_pid]), false);
    let initial_cpu_time_ms = system
        .process(process_pid)
        .map(|process| process.accumulated_cpu_time())
        .unwrap_or_default();
    let options = Arc::new(parse_options(std::env::args().skip(1).collect())?);
    let setup_started = Instant::now();
    let login_address = Arc::new(get_login_address(&options).await?);
    let semaphore = Arc::new(Semaphore::new(options.setup_concurrency));
    let account_seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    let mut setup_tasks = tokio::task::JoinSet::new();
    for index in 0..options.players {
        let options = Arc::clone(&options);
        let login_address = Arc::clone(&login_address);
        let semaphore = Arc::clone(&semaphore);
        setup_tasks.spawn(async move {
            let permit = semaphore.acquire_owned().await?;
            let account = format!(
                "rust_perf_{}_{}_{}",
                std::process::id(),
                account_seed,
                index
            );
            let player = setup_player(&options, &login_address, &account).await;
            drop(permit);
            player
        });
    }

    let mut players = Vec::with_capacity(options.players);
    while let Some(result) = setup_tasks.join_next().await {
        players.push(result.context("player setup task panicked")??);
    }
    let setup_elapsed = setup_started.elapsed();

    let measurement_start = Instant::now() + options.warmup;
    let timing = Timing {
        measurement_start,
        send_deadline: measurement_start + options.duration,
    };
    let started_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
        + options.warmup.as_millis() as u64;

    let mut load_tasks = tokio::task::JoinSet::new();
    for player in players {
        let options = Arc::clone(&options);
        load_tasks.spawn(run_player(player, options, timing));
    }

    let overall_timeout = options.warmup + options.duration + options.timeout;
    let results = tokio::time::timeout(overall_timeout, async {
        let mut values = Vec::with_capacity(options.players);
        while let Some(result) = load_tasks.join_next().await {
            values.push(result.context("player load task panicked")??);
        }
        Result::<Vec<PlayerResult>>::Ok(values)
    })
    .await
    .context("map probe load test timed out")??;

    let probe_errors = results
        .iter()
        .map(|result| result.probe_errors)
        .sum::<u64>();
    let move_errors = results.iter().map(|result| result.move_errors).sum::<u64>();
    let move_sent = results.iter().map(|result| result.move_sent).sum::<u64>();
    let move_skipped = results
        .iter()
        .map(|result| result.move_skipped)
        .sum::<u64>();
    let entity_move_pushes = results
        .iter()
        .map(|result| result.entity_move_pushes)
        .sum::<u64>();
    let state_sync_errors = results
        .iter()
        .map(|result| result.state_sync_errors)
        .sum::<u64>();
    let state_sync_sent = results
        .iter()
        .map(|result| result.state_sync_sent)
        .sum::<u64>();
    let numeric_pushes = results
        .iter()
        .map(|result| result.numeric_pushes)
        .sum::<u64>();
    let numeric_items = results
        .iter()
        .map(|result| result.numeric_items)
        .sum::<u64>();
    let numeric_bytes = results
        .iter()
        .map(|result| result.numeric_bytes)
        .sum::<u64>();
    let player_info_pushes = results
        .iter()
        .map(|result| result.player_info_pushes)
        .sum::<u64>();
    let player_info_items = results
        .iter()
        .map(|result| result.player_info_items)
        .sum::<u64>();
    let player_info_bytes = results
        .iter()
        .map(|result| result.player_info_bytes)
        .sum::<u64>();
    let item_pushes = results.iter().map(|result| result.item_pushes).sum::<u64>();
    let item_items = results.iter().map(|result| result.item_items).sum::<u64>();
    let item_bytes = results.iter().map(|result| result.item_bytes).sum::<u64>();
    let mut latencies = results
        .iter()
        .flat_map(|result| result.latencies_micros.iter().copied())
        .collect::<Vec<_>>();
    latencies.sort_unstable();
    let mut state_sync_latencies = results
        .into_iter()
        .flat_map(|result| result.state_sync_latencies_micros)
        .collect::<Vec<_>>();
    state_sync_latencies.sort_unstable();
    let requests = latencies.len();
    let requests_per_second = requests as f64 / options.duration.as_secs_f64();
    let setup_per_second = options.players as f64 / setup_elapsed.as_secs_f64();
    system.refresh_processes(ProcessesToUpdate::Some(&[process_pid]), false);
    let (cpu_time_ms, rss_bytes) = system
        .process(process_pid)
        .map(|process| {
            (
                process
                    .accumulated_cpu_time()
                    .saturating_sub(initial_cpu_time_ms),
                process.memory(),
            )
        })
        .unwrap_or_default();
    let timing_json = json!({
        "count": requests,
        "perSecond": requests_per_second,
        "p50Ms": percentile(&latencies, 0.50) as f64 / 1000.0,
        "p90Ms": percentile(&latencies, 0.90) as f64 / 1000.0,
        "p95Ms": percentile(&latencies, 0.95) as f64 / 1000.0,
        "p99Ms": percentile(&latencies, 0.99) as f64 / 1000.0,
        "maxMs": latencies.last().copied().unwrap_or_default() as f64 / 1000.0,
        "errors": probe_errors,
    });
    let state_sync_json = json!({
        "mode": options.state_sync_mode.name(),
        "targetRatePerPlayer": options.state_sync_rate,
        "count": state_sync_sent,
        "perSecond": state_sync_sent as f64 / options.duration.as_secs_f64(),
        "p50Ms": percentile(&state_sync_latencies, 0.50) as f64 / 1000.0,
        "p90Ms": percentile(&state_sync_latencies, 0.90) as f64 / 1000.0,
        "p95Ms": percentile(&state_sync_latencies, 0.95) as f64 / 1000.0,
        "p99Ms": percentile(&state_sync_latencies, 0.99) as f64 / 1000.0,
        "maxMs": state_sync_latencies.last().copied().unwrap_or_default() as f64 / 1000.0,
        "errors": state_sync_errors,
        "numericPushes": numeric_pushes,
        "numericItems": numeric_items,
        "numericBytes": numeric_bytes,
        "playerInfoPushes": player_info_pushes,
        "playerInfoItems": player_info_items,
        "playerInfoBytes": player_info_bytes,
        "itemPushes": item_pushes,
        "itemItems": item_items,
        "itemBytes": item_bytes,
        "numericPushesPerSecond": numeric_pushes as f64 / options.duration.as_secs_f64(),
        "numericItemsPerSecond": numeric_items as f64 / options.duration.as_secs_f64(),
        "numericBytesPerSecond": numeric_bytes as f64 / options.duration.as_secs_f64(),
        "playerInfoPushesPerSecond": player_info_pushes as f64 / options.duration.as_secs_f64(),
        "playerInfoItemsPerSecond": player_info_items as f64 / options.duration.as_secs_f64(),
        "playerInfoBytesPerSecond": player_info_bytes as f64 / options.duration.as_secs_f64(),
        "itemPushesPerSecond": item_pushes as f64 / options.duration.as_secs_f64(),
        "itemItemsPerSecond": item_items as f64 / options.duration.as_secs_f64(),
        "itemBytesPerSecond": item_bytes as f64 / options.duration.as_secs_f64(),
    });
    let result = json!({
        "scenario": "gameplay-full-chain-rust",
        "label": options.label,
        "players": options.players,
        "setupConcurrency": options.setup_concurrency,
        "warmupSeconds": options.warmup.as_secs_f64(),
        "durationSeconds": options.duration.as_secs_f64(),
        "targetMoveRatePerPlayer": options.move_rate,
        "movementHoldMessages": options.movement_hold_messages,
        "targetProbeRatePerPlayer": options.probe_rate,
        "measurementStartedAtUnixMs": started_at_unix_ms,
        "measurementEndedAtUnixMs": started_at_unix_ms + options.duration.as_millis() as u64,
        "workload": if options.move_rate > 0 {
            format!("steady-{}hz-rust", options.move_rate)
        } else {
            format!("probe-only-{}hz-rust", options.probe_rate)
        },
        "setup": {
            "count": options.players,
            "perSecond": setup_per_second,
            "p50Ms": 0,
            "p90Ms": 0,
            "p95Ms": 0,
            "p99Ms": 0,
            "maxMs": 0,
            "elapsedSeconds": setup_elapsed.as_secs_f64(),
        },
        "movement": {
            "count": move_sent,
            "perSecond": move_sent as f64 / options.duration.as_secs_f64(),
            "p50Ms": 0,
            "p90Ms": 0,
            "p95Ms": 0,
            "p99Ms": 0,
            "maxMs": 0,
            "skippedTicks": move_skipped,
            "entityMovePushes": entity_move_pushes,
            "pushesPerSecond": entity_move_pushes as f64 / options.duration.as_secs_f64(),
            "errors": move_errors,
        },
        "probe": timing_json,
        "stateSync": state_sync_json,
        "loadGenerator": {
            "kind": "rust-tokio",
            "cpuTotalMs": cpu_time_ms,
            "rssBytes": rss_bytes,
        },
    });

    println!(
        "[full-chain-rust:{}/{}] players={} setup={:.1} users/s move={:.1}/s skipped={} pushes={:.1}/s probe={:.1}/s p50={:.2}ms p95={:.2}ms p99={:.2}ms state={}:{:.1}/s p95={:.2}ms pushes={}/{}/{} errors={}/{}/{}",
        options.label,
        if options.move_rate > 0 {
            format!("steady-{}hz", options.move_rate)
        } else {
            format!("probe-only-{}hz", options.probe_rate)
        },
        options.players,
        setup_per_second,
        move_sent as f64 / options.duration.as_secs_f64(),
        move_skipped,
        entity_move_pushes as f64 / options.duration.as_secs_f64(),
        requests_per_second,
        percentile(&latencies, 0.50) as f64 / 1000.0,
        percentile(&latencies, 0.95) as f64 / 1000.0,
        percentile(&latencies, 0.99) as f64 / 1000.0,
        options.state_sync_mode.name(),
        state_sync_sent as f64 / options.duration.as_secs_f64(),
        percentile(&state_sync_latencies, 0.95) as f64 / 1000.0,
        numeric_pushes,
        player_info_pushes,
        item_pushes,
        move_errors,
        probe_errors,
        state_sync_errors,
    );
    println!("RESULT_JSON {result}");
    Ok(())
}

async fn get_login_address(options: &Options) -> Result<Address> {
    let frame = encode_rpc(GET_LOGIN_ADDR_REQ, 1, &[])?;
    let response = request_one(&options.host, options.manager_port, frame, options.timeout).await?;
    let message = decode_message(&response, GET_LOGIN_ADDR_RESP, Some(1))?;
    Ok(Address {
        ip: message.string(2)?,
        port: message.u16(3)?,
    })
}

async fn setup_player(
    options: &Options,
    login: &Address,
    account: &str,
) -> Result<PlayerConnection> {
    let mut login_payload = Vec::with_capacity(account.len() + 16);
    push_string(&mut login_payload, 1, account);
    let response = request_one(
        &login.ip,
        login.port,
        encode_rpc(LOGIN_REQ, 1, &login_payload)?,
        options.timeout,
    )
    .await?;
    let login_response = decode_message(&response, LOGIN_RESP, Some(1))?;
    let login = LoginResult {
        token: login_response.string(4)?,
        gate: Address {
            ip: login_response.string(6)?,
            port: login_response.u16(7)?,
        },
    };

    let stream = tokio::time::timeout(
        options.timeout,
        TcpStream::connect((&*login.gate.ip, login.gate.port)),
    )
    .await
    .context("gate connect timed out")??;
    stream.set_nodelay(true)?;
    let (mut reader, mut writer) = stream.into_split();

    let mut gate_login = Vec::with_capacity(account.len() + login.token.len() + 16);
    push_string(&mut gate_login, 1, account);
    push_string(&mut gate_login, 2, &login.token);
    write_frame(&mut writer, &encode_rpc(LOGIN_GATE_REQ, 2, &gate_login)?).await?;
    let response = read_frame_timeout(&mut reader, options.timeout).await?;
    decode_message(&response, LOGIN_GATE_RESP, Some(2))?;

    let mut enter_map = Vec::with_capacity(16);
    push_uint32(&mut enter_map, 1, 1);
    write_frame(&mut writer, &encode_rpc(ENTER_MAP_REQ, 3, &enter_map)?).await?;
    let mut received_response = false;
    let mut received_ready = false;
    let mut unit_id = 0;
    while !received_response || !received_ready {
        let frame = read_frame_timeout(&mut reader, options.timeout).await?;
        let msgcode = frame_msgcode(&frame)?;
        match msgcode {
            ENTER_MAP_RESP => {
                unit_id = decode_message(&frame, ENTER_MAP_RESP, Some(3))?.u32(4)?;
                received_response = true;
            }
            MAP_READY => received_ready = true,
            _ => {}
        }
    }
    if unit_id == 0 {
        bail!("EnterMap returned an invalid unitId");
    }
    let (writer_tx, writer_rx) = mpsc::channel(32);
    let writer_task = tokio::spawn(run_gate_writer(writer, writer_rx));
    let (frame_tx, frame_rx) = mpsc::unbounded_channel::<Result<Vec<u8>>>();
    let entity_move_pushes = Arc::new(AtomicU64::new(0));
    let reader_pushes = Arc::clone(&entity_move_pushes);
    let state_pushes = StatePushCounters::new();
    let reader_state_pushes = state_pushes.clone();
    let reader_task = tokio::spawn(async move {
        loop {
            match read_frame(&mut reader).await {
                Ok(frame) => match frame_msgcode(&frame) {
                    Ok(ENTITY_MOVE) => {
                        reader_pushes.fetch_add(1, Ordering::Relaxed);
                    }
                    Ok(ENTITY_NUMERIC) => {
                        let item_count = match count_length_delimited_field(&frame, 2) {
                            Ok(value) => value,
                            Err(error) => {
                                let _ = frame_tx.send(Err(error));
                                break;
                            }
                        };
                        reader_state_pushes
                            .numeric_frames
                            .fetch_add(1, Ordering::Relaxed);
                        reader_state_pushes
                            .numeric_items
                            .fetch_add(item_count, Ordering::Relaxed);
                        reader_state_pushes
                            .numeric_bytes
                            .fetch_add(frame.len() as u64, Ordering::Relaxed);
                    }
                    Ok(ENTITY_STATE) => {
                        let item_count = match count_length_delimited_field(&frame, 2) {
                            Ok(value) => value,
                            Err(error) => {
                                let _ = frame_tx.send(Err(error));
                                break;
                            }
                        };
                        reader_state_pushes
                            .player_info_frames
                            .fetch_add(1, Ordering::Relaxed);
                        reader_state_pushes
                            .player_info_items
                            .fetch_add(item_count, Ordering::Relaxed);
                        reader_state_pushes
                            .player_info_bytes
                            .fetch_add(frame.len() as u64, Ordering::Relaxed);
                    }
                    Ok(ITEM_CHANGED) => {
                        reader_state_pushes
                            .item_frames
                            .fetch_add(1, Ordering::Relaxed);
                        reader_state_pushes
                            .item_items
                            .fetch_add(1, Ordering::Relaxed);
                        reader_state_pushes
                            .item_bytes
                            .fetch_add(frame.len() as u64, Ordering::Relaxed);
                    }
                    Ok(MAP_PROBE_RESP) | Ok(STATE_SYNC_BENCH_RESP) => {
                        if frame_tx.send(Ok(frame)).is_err() {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(error) => {
                        let _ = frame_tx.send(Err(error));
                        break;
                    }
                },
                Err(error) => {
                    let _ = frame_tx.send(Err(error));
                    break;
                }
            }
        }
    });

    Ok(PlayerConnection {
        frame_rx,
        reader_task,
        writer_tx,
        writer_task,
        entity_move_pushes,
        state_pushes,
        next_rpc_id: 4,
        unit_id,
    })
}

async fn run_player(
    player: PlayerConnection,
    options: Arc<Options>,
    timing: Timing,
) -> Result<PlayerResult> {
    let mut result = PlayerResult::default();
    let PlayerConnection {
        mut frame_rx,
        reader_task,
        writer_tx,
        writer_task,
        entity_move_pushes,
        state_pushes,
        mut next_rpc_id,
        unit_id,
    } = player;
    let mut pushes_at_measurement_start = None;
    let mut state_pushes_at_measurement_start = None;
    let mut pending = HashMap::<u32, PendingRequest>::with_capacity(
        (options.probe_concurrency + options.state_sync_concurrency) * 2,
    );
    let mut probe_sequence = 0_u32;
    let mut state_sync_sequence = 0_u32;
    let mut move_sequence = 0_u32;
    let probe_interval =
        (options.probe_rate > 0).then(|| Duration::from_secs_f64(1.0 / options.probe_rate as f64));
    let move_interval =
        (options.move_rate > 0).then(|| Duration::from_secs_f64(1.0 / options.move_rate as f64));
    let state_sync_interval = (options.state_sync_mode != StateSyncMode::Off
        && options.state_sync_rate > 0)
        .then(|| Duration::from_secs_f64(1.0 / options.state_sync_rate as f64));
    let mut next_probe = Instant::now();
    let mut next_move = Instant::now();
    let mut next_state_sync = Instant::now();

    loop {
        let now = Instant::now();
        if pushes_at_measurement_start.is_none() && now >= timing.measurement_start {
            pushes_at_measurement_start = Some(entity_move_pushes.load(Ordering::Relaxed));
            state_pushes_at_measurement_start = Some(state_pushes.snapshot());
        }
        if now >= timing.send_deadline && pending.is_empty() {
            break;
        }

        if now < timing.send_deadline && move_interval.is_some_and(|_| now >= next_move) {
            let interval = move_interval.expect("checked above");
            let mut due = 0_u64;
            while next_move <= now {
                next_move += interval;
                due += 1;
            }
            result.move_skipped += due.saturating_sub(1);
            move_sequence = move_sequence.wrapping_add(1).max(1);
            send_move(
                &writer_tx,
                unit_id,
                move_sequence,
                options.movement_hold_messages,
            )
            .await?;
            if now >= timing.measurement_start {
                result.move_sent += 1;
            }
            continue;
        }

        if now < timing.send_deadline
            && pending_probe_count(&pending) < options.probe_concurrency
            && probe_interval.is_some_and(|_| now >= next_probe)
        {
            send_probe(
                &writer_tx,
                &mut next_rpc_id,
                &mut pending,
                &mut probe_sequence,
                timing,
            )
            .await?;
            next_probe += probe_interval.expect("checked above");
            continue;
        }

        if now < timing.send_deadline
            && pending_state_sync_count(&pending) < options.state_sync_concurrency
            && state_sync_interval.is_some_and(|_| now >= next_state_sync)
        {
            send_state_sync(
                &writer_tx,
                &mut next_rpc_id,
                &mut pending,
                &mut state_sync_sequence,
                options.state_sync_mode,
                timing,
            )
            .await?;
            next_state_sync += state_sync_interval.expect("checked above");
            continue;
        }

        if pending.is_empty() {
            let wake_at = [
                move_interval.map(|_| next_move),
                probe_interval.map(|_| next_probe),
                state_sync_interval.map(|_| next_state_sync),
                Some(timing.send_deadline),
            ]
            .into_iter()
            .flatten()
            .min()
            .expect("send deadline is always present");
            sleep_until(wake_at).await;
            continue;
        }

        let can_send_later = now < timing.send_deadline;
        let frame = if can_send_later {
            let wake_at = [
                move_interval.map(|_| next_move),
                (pending_probe_count(&pending) < options.probe_concurrency)
                    .then_some(probe_interval)
                    .flatten()
                    .map(|_| next_probe),
                (pending_state_sync_count(&pending) < options.state_sync_concurrency)
                    .then_some(state_sync_interval)
                    .flatten()
                    .map(|_| next_state_sync),
                Some(timing.send_deadline),
            ]
            .into_iter()
            .flatten()
            .min()
            .expect("send deadline is always present");
            tokio::select! {
                frame = frame_rx.recv() => Some(frame.context("gate reader stopped")??),
                _ = sleep_until(wake_at) => None,
            }
        } else {
            Some(frame_rx.recv().await.context("gate reader stopped")??)
        };
        let Some(frame) = frame else { continue };
        let msgcode = frame_msgcode(&frame)?;
        if msgcode != MAP_PROBE_RESP && msgcode != STATE_SYNC_BENCH_RESP {
            continue;
        }
        let response = decode_message(&frame, msgcode, None)?;
        let rpc_id = response.u32(90)?;
        let response_sequence = if msgcode == STATE_SYNC_BENCH_RESP {
            response.u32(2)?
        } else {
            response.u32(1)?
        };
        let request = pending
            .remove(&rpc_id)
            .with_context(|| format!("unknown response rpcId {rpc_id}"))?;
        if request.sequence != response_sequence {
            bail!(
                "response sequence mismatch: {response_sequence} != {}",
                request.sequence
            );
        }
        match request.kind {
            PendingKind::Probe => {
                if msgcode != MAP_PROBE_RESP {
                    result.probe_errors += 1;
                } else if request.measured {
                    result
                        .latencies_micros
                        .push(request.started_at.elapsed().as_micros() as u64);
                }
            }
            PendingKind::StateSync { mode } => {
                if msgcode != STATE_SYNC_BENCH_RESP || response.u32(1)? != mode {
                    result.state_sync_errors += 1;
                } else if request.measured {
                    result.state_sync_sent += 1;
                    result
                        .state_sync_latencies_micros
                        .push(request.started_at.elapsed().as_micros() as u64);
                }
            }
        }
    }
    reader_task.abort();
    writer_task.abort();
    result.entity_move_pushes = entity_move_pushes.load(Ordering::Relaxed).saturating_sub(
        pushes_at_measurement_start.unwrap_or_else(|| entity_move_pushes.load(Ordering::Relaxed)),
    );
    let end_state_pushes = state_pushes.snapshot();
    let start_state_pushes = state_pushes_at_measurement_start.unwrap_or(end_state_pushes);
    let measured_state_pushes = end_state_pushes.saturating_sub(start_state_pushes);
    result.numeric_pushes = measured_state_pushes.numeric_frames;
    result.numeric_items = measured_state_pushes.numeric_items;
    result.numeric_bytes = measured_state_pushes.numeric_bytes;
    result.player_info_pushes = measured_state_pushes.player_info_frames;
    result.player_info_items = measured_state_pushes.player_info_items;
    result.player_info_bytes = measured_state_pushes.player_info_bytes;
    result.item_pushes = measured_state_pushes.item_frames;
    result.item_items = measured_state_pushes.item_items;
    result.item_bytes = measured_state_pushes.item_bytes;
    Ok(result)
}

async fn send_move(
    writer_tx: &mpsc::Sender<Vec<u8>>,
    unit_id: u32,
    sequence: u32,
    hold_messages: u32,
) -> Result<()> {
    let direction_step = sequence.saturating_sub(1) / hold_messages;
    let direction = (unit_id.wrapping_add(direction_step) % 4) as i32;
    let (input_x, input_y) = match direction {
        0 => (1, 0),
        1 => (0, 1),
        2 => (-1, 0),
        _ => (0, -1),
    };
    let mut payload = Vec::with_capacity(16);
    push_sint32(&mut payload, 1, input_x);
    push_sint32(&mut payload, 2, input_y);
    push_uint32(&mut payload, 3, sequence);
    send_client_frame(writer_tx, encode_message(MAP_MOVE, &payload)).await
}

async fn send_probe(
    writer_tx: &mpsc::Sender<Vec<u8>>,
    next_rpc_id: &mut u32,
    pending: &mut HashMap<u32, PendingRequest>,
    sequence: &mut u32,
    timing: Timing,
) -> Result<()> {
    let rpc_id = *next_rpc_id;
    *next_rpc_id = next_rpc_id.wrapping_add(1).max(1);
    *sequence = sequence.wrapping_add(1).max(1);
    let started_at = Instant::now();
    let mut payload = Vec::with_capacity(16);
    push_uint32(&mut payload, 1, *sequence);
    send_client_frame(writer_tx, encode_rpc(MAP_PROBE_REQ, rpc_id, &payload)?).await?;
    pending.insert(
        rpc_id,
        PendingRequest {
            started_at,
            sequence: *sequence,
            measured: started_at >= timing.measurement_start && started_at < timing.send_deadline,
            kind: PendingKind::Probe,
        },
    );
    Ok(())
}

async fn send_state_sync(
    writer_tx: &mpsc::Sender<Vec<u8>>,
    next_rpc_id: &mut u32,
    pending: &mut HashMap<u32, PendingRequest>,
    sequence: &mut u32,
    selected_mode: StateSyncMode,
    timing: Timing,
) -> Result<()> {
    let rpc_id = *next_rpc_id;
    *next_rpc_id = next_rpc_id.wrapping_add(1).max(1);
    *sequence = sequence.wrapping_add(1).max(1);
    let mode = selected_mode.request_mode(*sequence);
    let started_at = Instant::now();
    let mut payload = Vec::with_capacity(16);
    push_uint32(&mut payload, 1, mode);
    push_uint32(&mut payload, 2, *sequence);
    send_client_frame(
        writer_tx,
        encode_rpc(STATE_SYNC_BENCH_REQ, rpc_id, &payload)?,
    )
    .await?;
    pending.insert(
        rpc_id,
        PendingRequest {
            started_at,
            sequence: *sequence,
            measured: started_at >= timing.measurement_start && started_at < timing.send_deadline,
            kind: PendingKind::StateSync { mode },
        },
    );
    Ok(())
}

fn pending_probe_count(pending: &HashMap<u32, PendingRequest>) -> usize {
    pending
        .values()
        .filter(|request| matches!(request.kind, PendingKind::Probe))
        .count()
}

fn pending_state_sync_count(pending: &HashMap<u32, PendingRequest>) -> usize {
    pending
        .values()
        .filter(|request| matches!(request.kind, PendingKind::StateSync { .. }))
        .count()
}

async fn run_gate_writer(
    mut writer: tokio::net::tcp::OwnedWriteHalf,
    mut frame_rx: mpsc::Receiver<Vec<u8>>,
) {
    let mut ping = tokio::time::interval(CLIENT_PING_INTERVAL);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ping.tick().await;
    loop {
        let frame = tokio::select! {
            frame = frame_rx.recv() => {
                let Some(frame) = frame else { break };
                frame
            }
            _ = ping.tick() => encode_message(CLIENT_PING, &[]),
        };
        if write_frame(&mut writer, &frame).await.is_err() {
            break;
        }
    }
}

async fn send_client_frame(writer_tx: &mpsc::Sender<Vec<u8>>, frame: Vec<u8>) -> Result<()> {
    writer_tx.send(frame).await.context("gate writer stopped")
}

async fn request_one(host: &str, port: u16, frame: Vec<u8>, timeout: Duration) -> Result<Vec<u8>> {
    tokio::time::timeout(timeout, async {
        let mut stream = TcpStream::connect((host, port)).await?;
        stream.set_nodelay(true)?;
        let packet = packet(&frame)?;
        stream.write_all(&packet).await?;
        read_frame_stream(&mut stream).await
    })
    .await
    .with_context(|| format!("request to {host}:{port} timed out"))?
}

async fn write_frame(writer: &mut tokio::net::tcp::OwnedWriteHalf, frame: &[u8]) -> Result<()> {
    writer.write_all(&packet(frame)?).await?;
    Ok(())
}

fn packet(frame: &[u8]) -> Result<Vec<u8>> {
    let length = u32::try_from(frame.len()).context("frame too large")?;
    let mut packet = Vec::with_capacity(frame.len() + 4);
    packet.extend_from_slice(&length.to_be_bytes());
    packet.extend_from_slice(frame);
    Ok(packet)
}

async fn read_frame_timeout(
    reader: &mut tokio::net::tcp::OwnedReadHalf,
    timeout: Duration,
) -> Result<Vec<u8>> {
    tokio::time::timeout(timeout, read_frame(reader))
        .await
        .context("response timed out")?
}

async fn read_frame(reader: &mut tokio::net::tcp::OwnedReadHalf) -> Result<Vec<u8>> {
    let length = reader.read_u32().await? as usize;
    read_frame_body(reader, length).await
}

async fn read_frame_stream(stream: &mut TcpStream) -> Result<Vec<u8>> {
    let length = stream.read_u32().await? as usize;
    read_frame_body(stream, length).await
}

async fn read_frame_body(
    reader: &mut (impl AsyncReadExt + Unpin),
    length: usize,
) -> Result<Vec<u8>> {
    if !(2..=MAX_FRAME_LEN).contains(&length) {
        bail!("invalid frame length {length}");
    }
    let mut frame = vec![0_u8; length];
    reader.read_exact(&mut frame).await?;
    Ok(frame)
}

fn encode_rpc(msgcode: u16, rpc_id: u32, fields: &[u8]) -> Result<Vec<u8>> {
    if rpc_id == 0 {
        bail!("rpcId cannot be zero");
    }
    let mut frame = Vec::with_capacity(fields.len() + 12);
    frame.extend_from_slice(&msgcode.to_be_bytes());
    push_uint32(&mut frame, 90, rpc_id);
    frame.extend_from_slice(fields);
    Ok(frame)
}

fn encode_message(msgcode: u16, fields: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(fields.len() + 2);
    frame.extend_from_slice(&msgcode.to_be_bytes());
    frame.extend_from_slice(fields);
    frame
}

fn push_uint32(buffer: &mut Vec<u8>, field: u32, value: u32) {
    if value == 0 {
        return;
    }
    push_varint(buffer, u64::from(field << 3));
    push_varint(buffer, u64::from(value));
}

fn push_sint32(buffer: &mut Vec<u8>, field: u32, value: i32) {
    let zigzag = ((value << 1) ^ (value >> 31)) as u32;
    push_uint32(buffer, field, zigzag);
}

fn push_string(buffer: &mut Vec<u8>, field: u32, value: &str) {
    push_varint(buffer, u64::from((field << 3) | 2));
    push_varint(buffer, value.len() as u64);
    buffer.extend_from_slice(value.as_bytes());
}

fn push_varint(buffer: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        buffer.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    buffer.push(value as u8);
}

struct DecodedMessage {
    varints: HashMap<u32, u64>,
    strings: HashMap<u32, String>,
}

impl DecodedMessage {
    fn u32(&self, field: u32) -> Result<u32> {
        u32::try_from(*self.varints.get(&field).unwrap_or(&0))
            .with_context(|| format!("field {field} exceeds uint32"))
    }
    fn u16(&self, field: u32) -> Result<u16> {
        u16::try_from(self.u32(field)?).with_context(|| format!("field {field} exceeds uint16"))
    }
    fn string(&self, field: u32) -> Result<String> {
        self.strings
            .get(&field)
            .cloned()
            .with_context(|| format!("missing string field {field}"))
    }
}

fn decode_message(
    frame: &[u8],
    expected_msgcode: u16,
    expected_rpc: Option<u32>,
) -> Result<DecodedMessage> {
    let msgcode = frame_msgcode(frame)?;
    if msgcode != expected_msgcode {
        bail!("unexpected msgcode {msgcode}, expected {expected_msgcode}");
    }
    let mut offset = 2;
    let mut message = DecodedMessage {
        varints: HashMap::new(),
        strings: HashMap::new(),
    };
    while offset < frame.len() {
        let tag = read_varint(frame, &mut offset)?;
        let field = (tag >> 3) as u32;
        match tag & 7 {
            0 => {
                message
                    .varints
                    .insert(field, read_varint(frame, &mut offset)?);
            }
            1 => advance(frame, &mut offset, 8)?,
            2 => {
                let length = read_varint(frame, &mut offset)? as usize;
                let end = offset
                    .checked_add(length)
                    .context("field length overflow")?;
                if end > frame.len() {
                    bail!("unexpected eof in field {field}");
                }
                if let Ok(value) = std::str::from_utf8(&frame[offset..end]) {
                    message.strings.insert(field, value.to_string());
                }
                offset = end;
            }
            5 => advance(frame, &mut offset, 4)?,
            wire => bail!("unsupported protobuf wire type {wire}"),
        }
    }
    let error = message.u32(91)?;
    if error != 0 {
        bail!("RPC returned error {error}");
    }
    if let Some(expected) = expected_rpc {
        let actual = message.u32(90)?;
        if actual != expected {
            bail!("rpcId mismatch {actual} != {expected}");
        }
    }
    Ok(message)
}

fn frame_msgcode(frame: &[u8]) -> Result<u16> {
    if frame.len() < 2 {
        bail!("frame is shorter than msgcode");
    }
    Ok(u16::from_be_bytes([frame[0], frame[1]]))
}

fn count_length_delimited_field(frame: &[u8], expected_field: u32) -> Result<u64> {
    let mut offset = 2;
    let mut count = 0_u64;
    while offset < frame.len() {
        let tag = read_varint(frame, &mut offset)?;
        let field = (tag >> 3) as u32;
        match tag & 7 {
            0 => {
                read_varint(frame, &mut offset)?;
            }
            1 => advance(frame, &mut offset, 8)?,
            2 => {
                let length = read_varint(frame, &mut offset)? as usize;
                if field == expected_field {
                    count += 1;
                }
                advance(frame, &mut offset, length)?;
            }
            5 => advance(frame, &mut offset, 4)?,
            wire => bail!("unsupported protobuf wire type {wire}"),
        }
    }
    Ok(count)
}

fn read_varint(bytes: &[u8], offset: &mut usize) -> Result<u64> {
    let mut value = 0_u64;
    for shift in (0..70).step_by(7) {
        let byte = *bytes.get(*offset).context("unexpected eof in varint")?;
        *offset += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    bail!("varint is too long")
}

fn advance(bytes: &[u8], offset: &mut usize, length: usize) -> Result<()> {
    *offset = offset
        .checked_add(length)
        .context("field length overflow")?;
    if *offset > bytes.len() {
        bail!("unexpected eof while skipping field");
    }
    Ok(())
}

fn percentile(sorted: &[u64], ratio: f64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    sorted[((sorted.len() as f64 * ratio) as usize).min(sorted.len() - 1)]
}

fn parse_options(args: Vec<String>) -> Result<Options> {
    let mut values = HashMap::<String, String>::new();
    for pair in args.chunks(2) {
        if pair.len() != 2 {
            bail!("arguments must use --name value pairs");
        }
        values.insert(
            pair[0].trim_start_matches('-').to_ascii_lowercase(),
            pair[1].clone(),
        );
    }
    let number = |name: &str, fallback: u64| -> Result<u64> {
        values
            .get(name)
            .map(|value| value.parse::<u64>())
            .transpose()
            .with_context(|| format!("invalid --{name}"))
            .map(|value| value.unwrap_or(fallback))
    };
    let players = number("players", 100)? as usize;
    let setup_concurrency = number("setup-concurrency", 16)? as usize;
    let probe_concurrency = number("probe-concurrency", 4)? as usize;
    let state_sync_concurrency = number("state-sync-concurrency", 4)? as usize;
    let movement_hold_messages = u32::try_from(number("movement-hold-messages", 1)?)
        .context("movement hold messages exceeds uint32")?;
    let duration = number("duration", 10)?;
    if players == 0
        || setup_concurrency == 0
        || probe_concurrency == 0
        || state_sync_concurrency == 0
        || movement_hold_messages == 0
        || duration == 0
    {
        bail!(
            "players, setup-concurrency, probe-concurrency, state-sync-concurrency, movement-hold-messages and duration must be greater than zero"
        );
    }
    Ok(Options {
        host: values
            .get("host")
            .cloned()
            .unwrap_or_else(|| "127.0.0.1".to_string()),
        manager_port: u16::try_from(number("manager-port", 7000)?)
            .context("manager port exceeds uint16")?,
        players,
        setup_concurrency,
        warmup: Duration::from_secs(number("warmup", 2)?),
        duration: Duration::from_secs(duration),
        timeout: Duration::from_millis(number("timeout", 60_000)?),
        move_rate: number("move-rate", 0)?,
        movement_hold_messages,
        probe_rate: number("probe-rate", 20)?,
        probe_concurrency,
        state_sync_mode: StateSyncMode::parse(
            values
                .get("state-sync-mode")
                .map(String::as_str)
                .unwrap_or("off"),
        )?,
        state_sync_rate: number("state-sync-rate", 0)?,
        state_sync_concurrency,
        label: values
            .get("label")
            .cloned()
            .unwrap_or_else(|| "rust".to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_top_level_repeated_messages() {
        let mut frame = ENTITY_NUMERIC.to_be_bytes().to_vec();
        push_uint32(&mut frame, 1, 42);
        for payload in [vec![0x08, 0x01], vec![0x08, 0x02, 0x10, 0x03]] {
            push_varint(&mut frame, u64::from((2_u32 << 3) | 2));
            push_varint(&mut frame, payload.len() as u64);
            frame.extend_from_slice(&payload);
        }

        assert_eq!(count_length_delimited_field(&frame, 2).unwrap(), 2);
    }
}
