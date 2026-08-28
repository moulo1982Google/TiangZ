#![recursion_limit = "256"]

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use serde_json::json;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use sysinfo::{Pid, ProcessesToUpdate, System};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpSocket, TcpStream};
use tokio::sync::{Semaphore, mpsc, watch};
use tokio::time::{Instant, sleep, sleep_until};

const MAX_FRAME_LEN: usize = 1024 * 1024;
const GET_LOGIN_ADDR_REQ: u16 = 10002;
const GET_LOGIN_ADDR_RESP: u16 = 10003;
const LOGIN_REQ: u16 = 10004;
const LOGIN_RESP: u16 = 10005;
const REGISTER_REQ: u16 = 10059;
const REGISTER_RESP: u16 = 10060;
const PERF_PASSWORD: &str = "PerfPass123";
const LOGIN_GATE_REQ: u16 = 10008;
const LOGIN_GATE_RESP: u16 = 10009;
const ENTER_MAP_REQ: u16 = 10010;
const ENTER_MAP_RESP: u16 = 10011;
const MAP_READY: u16 = 10012;
const MAP_SNAPSHOT_READY_REQ: u16 = 10029;
const MAP_SNAPSHOT_READY_RESP: u16 = 10030;
const MAP_MOVE: u16 = 10013;
const MAP_PROBE_REQ: u16 = 10014;
const MAP_PROBE_RESP: u16 = 10015;
const ENTITY_MOVE: u16 = 10016;
const ENTITY_NAVIGATE: u16 = 10036;
const NAVIGATE_INPUT_REQ: u16 = 10037;
const NAVIGATE_INPUT_RESP: u16 = 10038;
const ENTITY_NUMERIC: u16 = 10017;
const ENTITY_STATE: u16 = 10018;
const CLIENT_PING: u16 = 10024;
const ITEM_CHANGED: u16 = 10021;
const STATE_SYNC_BENCH_REQ: u16 = 15006;
const STATE_SYNC_BENCH_RESP: u16 = 15007;
const MAP_CAPACITY_PLACE_REQ: u16 = 15008;
const MAP_CAPACITY_PLACE_RESP: u16 = 15009;
const MAP_CAPACITY_ENTER_REQ: u16 = 15010;
const MAP_CAPACITY_ENTER_RESP: u16 = 15011;
const USE_ITEM_REQ: u16 = 10019;
const USE_ITEM_RESP: u16 = 10020;
const CAST_SKILL_REQ: u16 = 10047;
const CAST_SKILL_RESP: u16 = 10048;
const CLIENT_PING_INTERVAL: Duration = Duration::from_secs(5);
const GRID_CROSSING_PLAYER_MODULUS: u32 = 5;
const GRID_CROSSING_SECONDS: u64 = 2;
const ACCOUNT_NOT_REGISTERED: u32 = 10_036;
const MAX_MOVEMENT_LATENCY_SAMPLES_PER_PLAYER: u64 = 1_024;

#[derive(Clone, Copy, PartialEq, Eq)]
enum SpatialMode {
    Grid2d,
    Navmesh3d,
}

impl SpatialMode {
    fn parse(value: u32) -> Result<Self> {
        match value {
            1 => Ok(Self::Grid2d),
            2 => Ok(Self::Navmesh3d),
            _ => bail!("unsupported spatial mode {value}"),
        }
    }

    const fn name(self) -> &'static str {
        match self {
            Self::Grid2d => "grid2d",
            Self::Navmesh3d => "navmesh3d",
        }
    }

    const fn protocol(self) -> &'static str {
        match self {
            Self::Grid2d => "C2M_Move/G2C_EntityMove",
            Self::Navmesh3d => "C2M_NavigateInput/M2C_NavigateInput+G2C_EntityNavigate",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SpawnLayout {
    SamePoint,
    SingleGrid,
    GridUniform,
}

impl SpawnLayout {
    fn parse(value: &str) -> Result<Self> {
        match value.to_ascii_lowercase().as_str() {
            "same-point" => Ok(Self::SamePoint),
            "single-grid" => Ok(Self::SingleGrid),
            "grid-uniform" => Ok(Self::GridUniform),
            _ => bail!("invalid --spawn-layout {value}"),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::SamePoint => "same-point",
            Self::SingleGrid => "single-grid",
            Self::GridUniform => "grid-uniform",
        }
    }

    fn placement_code(self) -> Option<u32> {
        match self {
            Self::SamePoint => None,
            Self::GridUniform => Some(1),
            Self::SingleGrid => Some(2),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum EntrySyncMode {
    Full,
    AttachOnly,
    NewObserverOnly,
    ExistingObserversOnly,
}

impl EntrySyncMode {
    fn parse(value: &str) -> Result<Self> {
        match value.to_ascii_lowercase().as_str() {
            "full" => Ok(Self::Full),
            "attach-only" => Ok(Self::AttachOnly),
            "new-observer-only" => Ok(Self::NewObserverOnly),
            "existing-observers-only" => Ok(Self::ExistingObserversOnly),
            _ => bail!("invalid --entry-sync-mode {value}"),
        }
    }

    const fn name(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::AttachOnly => "attach-only",
            Self::NewObserverOnly => "new-observer-only",
            Self::ExistingObserversOnly => "existing-observers-only",
        }
    }

    const fn code(self) -> u32 {
        match self {
            Self::Full => 0,
            Self::AttachOnly => 1,
            Self::NewObserverOnly => 2,
            Self::ExistingObserversOnly => 3,
        }
    }

    const fn includes_new_observer_snapshot(self) -> bool {
        matches!(self, Self::Full | Self::NewObserverOnly)
    }
}

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
    source_ip: Option<IpAddr>,
    manager_port: u16,
    map_id: u32,
    players: usize,
    setup_concurrency: usize,
    map_entry_concurrency: Option<usize>,
    map_entry_rate: Option<f64>,
    post_setup_settle: Duration,
    warmup: Duration,
    duration: Duration,
    timeout: Duration,
    movement_timeout: Duration,
    move_rate: u64,
    movement_sequence_base: u32,
    movement_hold_messages: u32,
    spawn_layout: SpawnLayout,
    world_grids: u32,
    entry_sync_mode: EntrySyncMode,
    probe_rate: f64,
    probe_concurrency: usize,
    business_rate: f64,
    state_sync_mode: StateSyncMode,
    state_sync_rate: u64,
    state_sync_concurrency: usize,
    account_prefix: Option<String>,
    reuse_accounts: bool,
    operation_prefix: String,
    label: String,
    measurement_signal_file: Option<PathBuf>,
}

struct Address {
    ip: String,
    port: u16,
}

struct LoginResult {
    token: String,
    gate: Address,
}

struct PreparedPlayerConnection {
    frame_rx: mpsc::UnboundedReceiver<Result<Vec<u8>>>,
    reader_task: tokio::task::JoinHandle<()>,
    writer_tx: mpsc::Sender<Vec<u8>>,
    writer_task: tokio::task::JoinHandle<()>,
    entity_move_pushes: Arc<AtomicU64>,
    own_unit_id: Arc<AtomicU32>,
    grid_move_ack_rx: watch::Receiver<u32>,
    state_pushes: StatePushCounters,
    player_index: u32,
    placement_layout: Option<u32>,
}

struct PlayerConnection {
    frame_rx: mpsc::UnboundedReceiver<Result<Vec<u8>>>,
    reader_task: tokio::task::JoinHandle<()>,
    writer_tx: mpsc::Sender<Vec<u8>>,
    writer_task: tokio::task::JoinHandle<()>,
    entity_move_pushes: Arc<AtomicU64>,
    grid_move_ack_rx: watch::Receiver<u32>,
    state_pushes: StatePushCounters,
    next_rpc_id: u32,
    unit_id: u32,
    player_index: u32,
    business_item_id: u64,
    spatial_mode: SpatialMode,
    entered_map_id: u32,
    entered_map_instance_id: u64,
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
    Navigation,
    Probe,
    StateSync { mode: u32 },
    Business { response_code: u16 },
}

struct PendingRequest {
    started_at: Instant,
    sequence: u32,
    measured: bool,
    sampled: bool,
    kind: PendingKind,
}

struct PendingGridMove {
    sequence: u32,
    started_at: Instant,
    sampled: bool,
}

#[derive(Default)]
struct PlayerResult {
    latencies_micros: Vec<u64>,
    probe_errors: u64,
    move_errors: u64,
    move_sent: u64,
    move_acknowledged: u64,
    move_skipped: u64,
    movement_latencies_micros: Vec<u64>,
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
    business_latencies_micros: Vec<u64>,
    business_sent: u64,
    business_accepted: u64,
    business_rejected: u64,
    business_transport_errors: u64,
    spatial_mode: Option<SpatialMode>,
    entered_map_id: u32,
    entered_map_instance_id: u64,
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
    let mut connection_elapsed = None;
    let mut map_entry_elapsed = None;
    let players = if let Some(map_entry_concurrency) = options.map_entry_concurrency {
        let mut prepare_tasks = tokio::task::JoinSet::new();
        for index in 0..options.players {
            let account = account_name(&options, account_seed, index)?;
            let options = Arc::clone(&options);
            let login_address = Arc::clone(&login_address);
            let semaphore = Arc::clone(&semaphore);
            prepare_tasks.spawn(async move {
                let permit = semaphore.acquire_owned().await?;
                let player = prepare_player(&options, &login_address, &account, index).await;
                drop(permit);
                player
            });
        }

        let mut prepared_players = Vec::with_capacity(options.players);
        while let Some(result) = prepare_tasks.join_next().await {
            prepared_players.push(result.context("player prepare task panicked")??);
        }
        connection_elapsed = Some(setup_started.elapsed());

        let entry_started = Instant::now();
        let entry_semaphore = Arc::new(Semaphore::new(map_entry_concurrency));
        let mut entry_tasks = tokio::task::JoinSet::new();
        for (entry_index, prepared) in prepared_players.into_iter().enumerate() {
            let options = Arc::clone(&options);
            let semaphore = Arc::clone(&entry_semaphore);
            let scheduled_at = options
                .map_entry_rate
                .map(|rate| entry_started + Duration::from_secs_f64(entry_index as f64 / rate));
            entry_tasks.spawn(async move {
                // Optional open-loop release keeps the request start rate separate from
                // in-flight concurrency, so admission A/B tests do not conflate the two.
                // 可选的开环释放把请求启动速率与在途并发分开，避免Admission A/B把两者混为一谈。
                if let Some(scheduled_at) = scheduled_at {
                    sleep_until(scheduled_at).await;
                }
                let permit = semaphore.acquire_owned().await?;
                let player = enter_player(&options, prepared).await;
                drop(permit);
                player
            });
        }

        let mut players = Vec::with_capacity(options.players);
        while let Some(result) = entry_tasks.join_next().await {
            players.push(result.context("player map entry task panicked")??);
        }
        map_entry_elapsed = Some(entry_started.elapsed());
        players
    } else {
        let mut setup_tasks = tokio::task::JoinSet::new();
        for index in 0..options.players {
            let account = account_name(&options, account_seed, index)?;
            let options = Arc::clone(&options);
            let login_address = Arc::clone(&login_address);
            let semaphore = Arc::clone(&semaphore);
            setup_tasks.spawn(async move {
                let permit = semaphore.acquire_owned().await?;
                let player = setup_player(&options, &login_address, &account, index).await;
                drop(permit);
                player
            });
        }

        let mut players = Vec::with_capacity(options.players);
        while let Some(result) = setup_tasks.join_next().await {
            players.push(result.context("player setup task panicked")??);
        }
        players
    };
    let setup_elapsed = setup_started.elapsed();
    if !options.post_setup_settle.is_zero() {
        sleep(options.post_setup_settle).await;
    }

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
    if let Some(signal_file) = &options.measurement_signal_file {
        std::fs::write(signal_file, started_at_unix_ms.to_string()).with_context(|| {
            format!(
                "failed to write measurement signal {}",
                signal_file.display()
            )
        })?;
    }

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
    let move_acknowledged = results
        .iter()
        .map(|result| result.move_acknowledged)
        .sum::<u64>();
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
    let business_sent = results
        .iter()
        .map(|result| result.business_sent)
        .sum::<u64>();
    let business_accepted = results
        .iter()
        .map(|result| result.business_accepted)
        .sum::<u64>();
    let business_rejected = results
        .iter()
        .map(|result| result.business_rejected)
        .sum::<u64>();
    let business_transport_errors = results
        .iter()
        .map(|result| result.business_transport_errors)
        .sum::<u64>();
    let mut latencies = results
        .iter()
        .flat_map(|result| result.latencies_micros.iter().copied())
        .collect::<Vec<_>>();
    latencies.sort_unstable();
    let mut movement_latencies = results
        .iter()
        .flat_map(|result| result.movement_latencies_micros.iter().copied())
        .collect::<Vec<_>>();
    movement_latencies.sort_unstable();
    let mut state_sync_latencies = results
        .iter()
        .flat_map(|result| result.state_sync_latencies_micros.iter().copied())
        .collect::<Vec<_>>();
    state_sync_latencies.sort_unstable();
    // 业务延迟只统计已经收到响应的请求；业务拒绝仍然属于正常闭环响应。
    // Business latency includes only requests with a response; an application rejection is still a valid closed-loop response.
    let mut business_latencies = results
        .iter()
        .flat_map(|result| result.business_latencies_micros.iter().copied())
        .collect::<Vec<_>>();
    business_latencies.sort_unstable();
    let requests = latencies.len();
    let requests_per_second = requests as f64 / options.duration.as_secs_f64();
    let setup_per_second = options.players as f64 / setup_elapsed.as_secs_f64();
    let map_entry_per_second =
        map_entry_elapsed.map(|elapsed| options.players as f64 / elapsed.as_secs_f64());
    let movement_spatial_mode = results
        .first()
        .and_then(|result| result.spatial_mode)
        .filter(|mode| {
            results
                .iter()
                .all(|result| result.spatial_mode == Some(*mode))
        });
    let movement_spatial_mode_name = movement_spatial_mode
        .map(SpatialMode::name)
        .unwrap_or("mixed");
    let movement_protocol = movement_spatial_mode
        .map(SpatialMode::protocol)
        .unwrap_or("mixed");
    let entered_map_id = results
        .first()
        .map(|result| result.entered_map_id)
        .filter(|map_id| {
            results
                .iter()
                .all(|result| result.entered_map_id == *map_id)
        });
    let entered_map_instance_id = results
        .first()
        .map(|result| result.entered_map_instance_id)
        .filter(|instance_id| {
            results
                .iter()
                .all(|result| result.entered_map_instance_id == *instance_id)
        });
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
    let business_json = json!({
        "targetRatePerPlayer": options.business_rate,
        "count": business_sent,
        "perSecond": business_sent as f64 / options.duration.as_secs_f64(),
        "accepted": business_accepted,
        "rejected": business_rejected,
        "transportErrors": business_transport_errors,
        "p50Ms": percentile(&business_latencies, 0.50) as f64 / 1000.0,
        "p90Ms": percentile(&business_latencies, 0.90) as f64 / 1000.0,
        "p95Ms": percentile(&business_latencies, 0.95) as f64 / 1000.0,
        "p99Ms": percentile(&business_latencies, 0.99) as f64 / 1000.0,
        "maxMs": business_latencies.last().copied().unwrap_or_default() as f64 / 1000.0,
    });
    let result = json!({
        "scenario": "gameplay-full-chain-rust",
        "label": options.label,
        "players": options.players,
        "setupConcurrency": options.setup_concurrency,
        "mapEntryConcurrency": options.map_entry_concurrency,
        "mapEntryRatePerSecond": options.map_entry_rate,
        "postSetupSettleSeconds": options.post_setup_settle.as_secs_f64(),
        "warmupSeconds": options.warmup.as_secs_f64(),
        "durationSeconds": options.duration.as_secs_f64(),
        "targetMoveRatePerPlayer": options.move_rate,
        "movementSequenceBase": options.movement_sequence_base,
        "movementHoldMessages": options.movement_hold_messages,
        "spawnLayout": options.spawn_layout.name(),
        "worldGrids": options.world_grids,
        "movementProfile": if options.spawn_layout == SpawnLayout::GridUniform {
            json!({
                "localPercent": 80,
                "gridCrossingPercent": 20,
                "gridCrossingIntervalSeconds": GRID_CROSSING_SECONDS,
                "expectedGridCrossingsPerSecond": options.players as f64
                    / f64::from(GRID_CROSSING_PLAYER_MODULUS)
                    / GRID_CROSSING_SECONDS as f64,
            })
        } else {
            json!(null)
        },
        "entrySyncMode": options.entry_sync_mode.name(),
        "mapId": options.map_id,
        "targetProbeRatePerPlayer": options.probe_rate,
        "targetBusinessRatePerPlayer": options.business_rate,
        "targetMapId": options.map_id,
        "enteredMapId": entered_map_id,
        "enteredMapInstanceId": entered_map_instance_id,
        "accountMode": if options.reuse_accounts { "stable-reuse" } else { "ephemeral" },
        "measurementStartedAtUnixMs": started_at_unix_ms,
        "measurementEndedAtUnixMs": started_at_unix_ms + options.duration.as_millis() as u64,
        "workload": format!(
            "{}{}{}",
            if options.move_rate > 0 {
                format!("steady-{}hz-rust", options.move_rate)
            } else {
                format!("probe-only-{}hz-rust", options.probe_rate)
            },
            if options.business_rate > 0.0 { "+" } else { "" },
            if options.business_rate > 0.0 {
                format!("business-{}hz", options.business_rate)
            } else {
                String::new()
            },
        ),
        "setup": {
            "count": options.players,
            "perSecond": setup_per_second,
            "p50Ms": 0,
            "p90Ms": 0,
            "p95Ms": 0,
            "p99Ms": 0,
            "maxMs": 0,
            "elapsedSeconds": setup_elapsed.as_secs_f64(),
            "connectionSeconds": connection_elapsed.map(|elapsed| elapsed.as_secs_f64()),
            "mapEntrySeconds": map_entry_elapsed.map(|elapsed| elapsed.as_secs_f64()),
            "mapEntryPerSecond": map_entry_per_second,
        },
        "movement": {
            "count": move_sent,
            "perSecond": move_sent as f64 / options.duration.as_secs_f64(),
            "spatialMode": movement_spatial_mode_name,
            "protocol": movement_protocol,
            "acknowledged": move_acknowledged,
            "latencySamples": movement_latencies.len(),
            "p50Ms": percentile(&movement_latencies, 0.50) as f64 / 1000.0,
            "p90Ms": percentile(&movement_latencies, 0.90) as f64 / 1000.0,
            "p95Ms": percentile(&movement_latencies, 0.95) as f64 / 1000.0,
            "p99Ms": percentile(&movement_latencies, 0.99) as f64 / 1000.0,
            "maxMs": movement_latencies.last().copied().unwrap_or_default() as f64 / 1000.0,
            "skippedTicks": move_skipped,
            "entityMovePushes": entity_move_pushes,
            "pushesPerSecond": entity_move_pushes as f64 / options.duration.as_secs_f64(),
            "errors": move_errors,
        },
        "probe": timing_json,
        "business": business_json,
        "stateSync": state_sync_json,
        "loadGenerator": {
            "kind": "rust-tokio",
            "cpuTotalMs": cpu_time_ms,
            "rssBytes": rss_bytes,
        },
    });

    println!(
        "[full-chain-rust:{}/{}] players={} setup={:.1} users/s move={:.1}/s skipped={} pushes={:.1}/s probe={:.1}/s p50={:.2}ms p95={:.2}ms p99={:.2}ms business={:.1}/s accepted={} rejected={} transport_errors={} p95={:.2}ms state={}:{:.1}/s p95={:.2}ms pushes={}/{}/{} errors={}/{}/{}/{}",
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
        business_sent as f64 / options.duration.as_secs_f64(),
        business_accepted,
        business_rejected,
        business_transport_errors,
        percentile(&business_latencies, 0.95) as f64 / 1000.0,
        options.state_sync_mode.name(),
        state_sync_sent as f64 / options.duration.as_secs_f64(),
        percentile(&state_sync_latencies, 0.95) as f64 / 1000.0,
        numeric_pushes,
        player_info_pushes,
        item_pushes,
        move_errors,
        probe_errors,
        state_sync_errors,
        business_transport_errors,
    );
    println!("RESULT_JSON {result}");
    Ok(())
}

async fn get_login_address(options: &Options) -> Result<Address> {
    let frame = encode_rpc(GET_LOGIN_ADDR_REQ, 1, &[])?;
    let response = request_one(
        &options.host,
        options.manager_port,
        frame,
        options.timeout,
        options.source_ip,
        options.source_ip.map(|_| 10_000),
    )
    .await?;
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
    index: usize,
) -> Result<PlayerConnection> {
    let prepared = prepare_player(options, login, account, index).await?;
    enter_player(options, prepared).await
}

async fn prepare_player(
    options: &Options,
    login: &Address,
    account: &str,
    index: usize,
) -> Result<PreparedPlayerConnection> {
    let login_response = if options.reuse_accounts {
        let response = login_player(options, login, account, index, 22_000).await?;
        let error = response.u32(91)?;
        if error == ACCOUNT_NOT_REGISTERED {
            register_player(options, login, account, index).await?;
            login_player(options, login, account, index, 28_000).await?
        } else {
            response
        }
    } else {
        register_player(options, login, account, index).await?;
        login_player(options, login, account, index, 22_000).await?
    };
    let login_error = login_response.u32(91)?;
    if login_error != 0 {
        let detail = login_response.string(92).unwrap_or_default();
        bail!("Login RPC returned error {login_error}: {detail}");
    }
    let login = LoginResult {
        token: login_response.string(4)?,
        gate: Address {
            ip: login_response.string(6)?,
            port: login_response.u16(7)?,
        },
    };

    let stream = tokio::time::timeout(
        options.timeout,
        connect_tcp(
            &login.gate.ip,
            login.gate.port,
            options.source_ip,
            source_port(options.source_ip, 43_000, index)?,
        ),
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
    decode_message(&response, LOGIN_GATE_RESP, Some(2)).context("LoginGate RPC failed")?;

    let placement_layout = options.spawn_layout.placement_code();
    let player_index = u32::try_from(index).context("player index exceeds uint32")?;
    Ok(start_gate_connection(
        reader,
        writer,
        player_index,
        placement_layout,
    ))
}

async fn login_player(
    options: &Options,
    login: &Address,
    account: &str,
    index: usize,
    source_port_base: usize,
) -> Result<DecodedMessage> {
    let mut login_payload = Vec::with_capacity(account.len() + 16);
    push_string(&mut login_payload, 1, account);
    push_string(&mut login_payload, 3, PERF_PASSWORD);
    let response = request_one(
        &login.ip,
        login.port,
        encode_rpc(LOGIN_REQ, 1, &login_payload)?,
        options.timeout,
        options.source_ip,
        source_port(options.source_ip, source_port_base, index)?,
    )
    .await?;
    decode_message_allow_error(&response, LOGIN_RESP, Some(1)).context("Login RPC failed")
}

async fn register_player(
    options: &Options,
    login: &Address,
    account: &str,
    index: usize,
) -> Result<()> {
    let mut register_payload = Vec::with_capacity(account.len() + PERF_PASSWORD.len() + 16);
    push_string(&mut register_payload, 1, account);
    push_string(&mut register_payload, 2, PERF_PASSWORD);
    let response = request_one(
        &login.ip,
        login.port,
        encode_rpc(REGISTER_REQ, 1, &register_payload)?,
        options.timeout,
        options.source_ip,
        source_port(options.source_ip, 16_000, index)?,
    )
    .await?;
    decode_message(&response, REGISTER_RESP, Some(1)).context("Register RPC failed")?;
    Ok(())
}

async fn enter_player(
    options: &Options,
    prepared: PreparedPlayerConnection,
) -> Result<PlayerConnection> {
    let PreparedPlayerConnection {
        mut frame_rx,
        reader_task,
        writer_tx,
        writer_task,
        entity_move_pushes,
        own_unit_id,
        grid_move_ack_rx,
        state_pushes,
        player_index,
        placement_layout,
    } = prepared;
    let mut enter_map = Vec::with_capacity(16);
    let (enter_request_code, enter_response_code, unit_id_field) =
        if let Some(layout) = placement_layout {
            push_uint32(&mut enter_map, 1, options.map_id);
            push_uint32(&mut enter_map, 2, player_index);
            push_uint32(&mut enter_map, 3, layout);
            push_uint32(&mut enter_map, 4, options.entry_sync_mode.code());
            (MAP_CAPACITY_ENTER_REQ, MAP_CAPACITY_ENTER_RESP, 1)
        } else {
            push_uint32(&mut enter_map, 1, options.map_id);
            (ENTER_MAP_REQ, ENTER_MAP_RESP, 4)
        };
    send_client_frame(&writer_tx, encode_rpc(enter_request_code, 3, &enter_map)?).await?;
    let mut received_response = false;
    let mut received_ready = false;
    let mut inline_snapshot = false;
    let mut unit_id = 0;
    let mut business_item_id = 0_u64;
    let mut spatial_mode = placement_layout.map(|_| SpatialMode::Grid2d);
    let mut entered_map_id = placement_layout.map(|_| options.map_id).unwrap_or_default();
    let mut entered_map_instance_id = placement_layout
        .map(|_| u64::from(options.map_id))
        .unwrap_or_default();
    while !received_response || !received_ready {
        let frame = receive_gate_frame(&mut frame_rx, options.timeout, "EnterMap").await?;
        let msgcode = frame_msgcode(&frame)?;
        match msgcode {
            code if code == enter_response_code => {
                let response = decode_message(&frame, enter_response_code, Some(3))
                    .context("EnterMap RPC failed")?;
                unit_id = response.u32(unit_id_field)?;
                if placement_layout.is_some() {
                    business_item_id = response.u64(4);
                } else {
                    entered_map_id = response.u32(3)?;
                    entered_map_instance_id = response.u64(11);
                    spatial_mode = Some(SpatialMode::parse(response.u32(12)?)?);
                    business_item_id = find_item_id_by_config(&frame, 9, 1001)?.unwrap_or(0);
                }
                inline_snapshot =
                    placement_layout.is_none() && count_length_delimited_field(&frame, 7)? > 0;
                received_response = true;
            }
            MAP_READY => received_ready = true,
            _ => {}
        }
    }
    if unit_id == 0 {
        bail!("EnterMap returned an invalid unitId");
    }
    if entered_map_id == 0 || entered_map_instance_id == 0 {
        bail!("EnterMap returned an invalid map identity");
    }
    let spatial_mode = spatial_mode.context("EnterMap did not return a spatial mode")?;
    own_unit_id.store(unit_id, Ordering::Release);
    let mut next_rpc_id = 4;
    if options.entry_sync_mode.includes_new_observer_snapshot() && !inline_snapshot {
        let mut ready = Vec::with_capacity(8);
        push_uint32(&mut ready, 1, unit_id);
        send_client_frame(
            &writer_tx,
            encode_rpc(MAP_SNAPSHOT_READY_REQ, next_rpc_id, &ready)?,
        )
        .await?;
        loop {
            let frame =
                receive_gate_frame(&mut frame_rx, options.timeout, "MapSnapshotReady").await?;
            if frame_msgcode(&frame)? != MAP_SNAPSHOT_READY_RESP {
                continue;
            }
            decode_message(&frame, MAP_SNAPSHOT_READY_RESP, Some(next_rpc_id))
                .context("MapSnapshotReady RPC failed")?;
            break;
        }
        next_rpc_id += 1;
    }
    if let Some(layout) = placement_layout {
        let mut placement = Vec::with_capacity(8);
        push_uint32(&mut placement, 1, player_index);
        push_uint32(&mut placement, 2, layout);
        send_client_frame(
            &writer_tx,
            encode_rpc(MAP_CAPACITY_PLACE_REQ, next_rpc_id, &placement)?,
        )
        .await?;
        loop {
            let frame =
                receive_gate_frame(&mut frame_rx, options.timeout, "MapCapacityPlace").await?;
            if frame_msgcode(&frame)? != MAP_CAPACITY_PLACE_RESP {
                continue;
            }
            let response = decode_message(&frame, MAP_CAPACITY_PLACE_RESP, Some(next_rpc_id))
                .context("MapCapacityPlace RPC failed")?;
            if response.u32(1)? != player_index {
                bail!("map capacity placement index mismatch");
            }
            break;
        }
        next_rpc_id += 1;
    }

    Ok(PlayerConnection {
        frame_rx,
        reader_task,
        writer_tx,
        writer_task,
        entity_move_pushes,
        grid_move_ack_rx,
        state_pushes,
        next_rpc_id,
        unit_id,
        player_index,
        business_item_id,
        spatial_mode,
        entered_map_id,
        entered_map_instance_id,
    })
}

fn start_gate_connection(
    mut reader: tokio::net::tcp::OwnedReadHalf,
    writer: tokio::net::tcp::OwnedWriteHalf,
    player_index: u32,
    placement_layout: Option<u32>,
) -> PreparedPlayerConnection {
    let (writer_tx, writer_rx) = mpsc::channel(32);
    let writer_task = tokio::spawn(run_gate_writer(writer, writer_rx));
    let (frame_tx, frame_rx) = mpsc::unbounded_channel::<Result<Vec<u8>>>();
    let entity_move_pushes = Arc::new(AtomicU64::new(0));
    let reader_pushes = Arc::clone(&entity_move_pushes);
    let own_unit_id = Arc::new(AtomicU32::new(0));
    let reader_unit_id = Arc::clone(&own_unit_id);
    let (grid_move_ack_tx, grid_move_ack_rx) = watch::channel(0_u32);
    let state_pushes = StatePushCounters::new();
    let reader_state_pushes = state_pushes.clone();
    let reader_task = tokio::spawn(async move {
        loop {
            match read_frame(&mut reader).await {
                Ok(frame) => match frame_msgcode(&frame) {
                    Ok(ENTITY_MOVE) => {
                        reader_pushes.fetch_add(1, Ordering::Relaxed);
                        let unit_id = reader_unit_id.load(Ordering::Acquire);
                        if unit_id != 0 {
                            match find_grid_move_acknowledgement(&frame, unit_id) {
                                Ok(Some(sequence)) => {
                                    if sequence > *grid_move_ack_tx.borrow() {
                                        grid_move_ack_tx.send_replace(sequence);
                                    }
                                }
                                Ok(None) => {}
                                Err(error) => {
                                    let _ = frame_tx.send(Err(error));
                                    break;
                                }
                            }
                        }
                    }
                    Ok(ENTITY_NAVIGATE) => {
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
                    Ok(ENTER_MAP_RESP)
                    | Ok(MAP_CAPACITY_ENTER_RESP)
                    | Ok(MAP_READY)
                    | Ok(MAP_SNAPSHOT_READY_RESP)
                    | Ok(MAP_CAPACITY_PLACE_RESP)
                    | Ok(NAVIGATE_INPUT_RESP)
                    | Ok(MAP_PROBE_RESP)
                    | Ok(USE_ITEM_RESP)
                    | Ok(CAST_SKILL_RESP)
                    | Ok(STATE_SYNC_BENCH_RESP) => {
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

    PreparedPlayerConnection {
        frame_rx,
        reader_task,
        writer_tx,
        writer_task,
        entity_move_pushes,
        own_unit_id,
        grid_move_ack_rx,
        state_pushes,
        player_index,
        placement_layout,
    }
}

async fn receive_gate_frame(
    frame_rx: &mut mpsc::UnboundedReceiver<Result<Vec<u8>>>,
    timeout: Duration,
    phase: &str,
) -> Result<Vec<u8>> {
    tokio::time::timeout(timeout, frame_rx.recv())
        .await
        .with_context(|| format!("{phase} timed out"))?
        .context("gate reader stopped")?
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
        mut grid_move_ack_rx,
        state_pushes,
        mut next_rpc_id,
        unit_id,
        player_index,
        business_item_id,
        spatial_mode,
        entered_map_id,
        entered_map_instance_id,
    } = player;
    result.spatial_mode = Some(spatial_mode);
    result.entered_map_id = entered_map_id;
    result.entered_map_instance_id = entered_map_instance_id;
    let mut pushes_at_measurement_start = None;
    let mut state_pushes_at_measurement_start = None;
    let mut pending = HashMap::<u32, PendingRequest>::with_capacity(
        (options.probe_concurrency + options.state_sync_concurrency + 2) * 2,
    );
    let mut pending_grid_moves = VecDeque::<PendingGridMove>::new();
    let mut last_grid_acknowledgement = 0_u32;
    let mut probe_sequence = 0_u32;
    let mut state_sync_sequence = 0_u32;
    let mut business_sequence = 0_u32;
    let mut business_operation = player_index;
    let mut move_sequence = options.movement_sequence_base;
    let probe_interval =
        (options.probe_rate > 0.0).then(|| Duration::from_secs_f64(1.0 / options.probe_rate));
    let move_interval =
        (options.move_rate > 0).then(|| Duration::from_secs_f64(1.0 / options.move_rate as f64));
    let expected_measured_moves = (options.duration.as_secs_f64() * options.move_rate as f64)
        .ceil()
        .max(1.0) as u64;
    let movement_latency_sample_stride = expected_measured_moves
        .div_ceil(MAX_MOVEMENT_LATENCY_SAMPLES_PER_PLAYER)
        .max(1);
    let state_sync_interval = (options.state_sync_mode != StateSyncMode::Off
        && options.state_sync_rate > 0)
        .then(|| Duration::from_secs_f64(1.0 / options.state_sync_rate as f64));
    let business_interval =
        (options.business_rate > 0.0).then(|| Duration::from_secs_f64(1.0 / options.business_rate));
    // 每名虚拟玩家使用稳定相位错开周期请求。总QPS保持不变，但不会在每个周期边界
    // 同时向Map注入全部玩家消息，从而避免把压测器的人造脉冲误判为服务器容量。
    // Give every virtual player a stable phase. Aggregate QPS is unchanged, while periodic
    // requests are spread across each interval instead of creating a synthetic synchronized burst.
    let schedule_origin = Instant::now();
    let mut next_probe = schedule_origin + phase_offset(probe_interval, unit_id, 0x9e37_79b9);
    let mut next_move = schedule_origin + phase_offset(move_interval, unit_id, 0x85eb_ca6b);
    let mut next_state_sync =
        schedule_origin + phase_offset(state_sync_interval, unit_id, 0xc2b2_ae35);
    let mut next_business = schedule_origin + phase_offset(business_interval, unit_id, 0x27d4_eb2f);
    let movement_drain_deadline = timing.send_deadline + options.movement_timeout;

    loop {
        let now = Instant::now();
        if spatial_mode == SpatialMode::Grid2d {
            let acknowledgement = *grid_move_ack_rx.borrow_and_update();
            if acknowledgement > last_grid_acknowledgement {
                apply_grid_move_acknowledgement(
                    acknowledgement,
                    &mut last_grid_acknowledgement,
                    &mut pending_grid_moves,
                    &mut result,
                );
            }
        }
        if pushes_at_measurement_start.is_none() && now >= timing.measurement_start {
            pushes_at_measurement_start = Some(entity_move_pushes.load(Ordering::Relaxed));
            state_pushes_at_measurement_start = Some(state_pushes.snapshot());
        }
        if now >= movement_drain_deadline {
            if spatial_mode == SpatialMode::Grid2d && !pending_grid_moves.is_empty() {
                result.move_errors += pending_grid_moves.len() as u64;
                pending_grid_moves.clear();
            }
            let expired_navigation = pending
                .iter()
                .filter_map(|(rpc_id, request)| {
                    matches!(request.kind, PendingKind::Navigation).then_some(*rpc_id)
                })
                .collect::<Vec<_>>();
            for rpc_id in expired_navigation {
                pending.remove(&rpc_id);
                result.move_errors += 1;
            }
        }
        if now >= timing.send_deadline && pending.is_empty() && pending_grid_moves.is_empty() {
            break;
        }

        if now < timing.send_deadline && move_interval.is_some_and(|_| now >= next_move) {
            let interval = move_interval.expect("checked above");
            let mut due = 0_u64;
            while next_move <= now {
                next_move += interval;
                due += 1;
            }
            if spatial_mode == SpatialMode::Navmesh3d && pending_navigation_count(&pending) != 0 {
                result.move_skipped += due;
                continue;
            }
            result.move_skipped += due.saturating_sub(1);
            move_sequence = move_sequence.wrapping_add(1).max(1);
            let measured = now >= timing.measurement_start;
            if measured {
                result.move_sent += 1;
            }
            let sampled = measured
                && result
                    .move_sent
                    .is_multiple_of(movement_latency_sample_stride);
            match spatial_mode {
                SpatialMode::Grid2d => {
                    send_move(
                        &writer_tx,
                        unit_id,
                        player_index,
                        move_sequence,
                        options.movement_hold_messages,
                        options.move_rate,
                        options.spawn_layout,
                        options.world_grids,
                    )
                    .await?;
                    if measured {
                        pending_grid_moves.push_back(PendingGridMove {
                            sequence: move_sequence,
                            started_at: now,
                            sampled,
                        });
                    }
                }
                SpatialMode::Navmesh3d => {
                    send_navigation(
                        &writer_tx,
                        &mut next_rpc_id,
                        &mut pending,
                        player_index,
                        move_sequence,
                        options.move_rate,
                        measured,
                        sampled,
                    )
                    .await?;
                }
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

        if now < timing.send_deadline
            && pending_business_count(&pending) == 0
            && business_interval.is_some_and(|_| now >= next_business)
        {
            send_business(
                &writer_tx,
                &mut next_rpc_id,
                &mut pending,
                &mut business_sequence,
                &mut business_operation,
                unit_id,
                business_item_id,
                &options.operation_prefix,
                timing,
                &mut result,
            )
            .await?;
            next_business += business_interval.expect("checked above");
            continue;
        }

        if pending.is_empty() && pending_grid_moves.is_empty() {
            let wake_at = [
                move_interval.map(|_| next_move),
                probe_interval.map(|_| next_probe),
                state_sync_interval.map(|_| next_state_sync),
                business_interval.map(|_| next_business),
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
                (pending_business_count(&pending) == 0)
                    .then_some(business_interval)
                    .flatten()
                    .map(|_| next_business),
                Some(timing.send_deadline),
            ]
            .into_iter()
            .flatten()
            .min()
            .expect("send deadline is always present");
            tokio::select! {
                frame = frame_rx.recv(), if !pending.is_empty() => {
                    Some(frame.context("gate reader stopped")??)
                },
                changed = grid_move_ack_rx.changed(),
                    if spatial_mode == SpatialMode::Grid2d && !pending_grid_moves.is_empty() => {
                    changed.context("gate movement acknowledgement stopped")?;
                    None
                },
                _ = sleep_until(wake_at) => None,
            }
        } else if (spatial_mode == SpatialMode::Grid2d && !pending_grid_moves.is_empty())
            || pending_navigation_count(&pending) > 0
        {
            tokio::select! {
                frame = frame_rx.recv(), if !pending.is_empty() => {
                    Some(frame.context("gate reader stopped")??)
                },
                changed = grid_move_ack_rx.changed(),
                    if spatial_mode == SpatialMode::Grid2d && !pending_grid_moves.is_empty() => {
                    changed.context("gate movement acknowledgement stopped")?;
                    None
                },
                _ = sleep_until(movement_drain_deadline) => None,
            }
        } else {
            Some(frame_rx.recv().await.context("gate reader stopped")??)
        };
        let Some(frame) = frame else { continue };
        let msgcode = frame_msgcode(&frame)?;
        if msgcode != NAVIGATE_INPUT_RESP
            && msgcode != MAP_PROBE_RESP
            && msgcode != STATE_SYNC_BENCH_RESP
            && msgcode != USE_ITEM_RESP
            && msgcode != CAST_SKILL_RESP
        {
            continue;
        }
        let response = decode_message_allow_error(&frame, msgcode, None)?;
        let rpc_id = response.u32(90)?;
        let response_sequence = match msgcode {
            NAVIGATE_INPUT_RESP => Some(response.u32(1)?),
            STATE_SYNC_BENCH_RESP => Some(response.u32(2)?),
            MAP_PROBE_RESP => Some(response.u32(1)?),
            _ => None,
        };
        let request = pending
            .remove(&rpc_id)
            .with_context(|| format!("unknown response rpcId {rpc_id}"))?;
        let response_error = response.u32(91)?;
        if response_error != 0 {
            // 错误响应可能没有业务序号，必须先按错误码分类再做正常响应校验。
            // Error responses may omit the business sequence, so classify them before normal response validation.
            match request.kind {
                PendingKind::Navigation => {
                    result.move_errors += 1;
                }
                PendingKind::Probe => {
                    result.probe_errors += 1;
                }
                PendingKind::StateSync { .. } => {
                    result.state_sync_errors += 1;
                }
                PendingKind::Business { response_code } => {
                    if msgcode != response_code || !is_business_error_code(response_error) {
                        result.business_transport_errors += 1;
                    } else if request.measured {
                        result
                            .business_latencies_micros
                            .push(request.started_at.elapsed().as_micros() as u64);
                        result.business_rejected += 1;
                    }
                }
            }
            continue;
        }
        if let Some(response_sequence) = response_sequence
            && request.sequence != response_sequence
        {
            bail!(
                "response sequence mismatch: {response_sequence} != {}",
                request.sequence
            );
        }
        match request.kind {
            PendingKind::Navigation => {
                if msgcode != NAVIGATE_INPUT_RESP {
                    result.move_errors += 1;
                } else if request.measured {
                    result.move_acknowledged += 1;
                    if request.sampled {
                        result
                            .movement_latencies_micros
                            .push(request.started_at.elapsed().as_micros() as u64);
                    }
                }
            }
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
            PendingKind::Business { response_code } => {
                if msgcode != response_code {
                    result.business_transport_errors += 1;
                } else if request.measured {
                    result
                        .business_latencies_micros
                        .push(request.started_at.elapsed().as_micros() as u64);
                    if response.u32(91)? == 0 {
                        result.business_accepted += 1;
                    } else {
                        result.business_rejected += 1;
                    }
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

fn phase_offset(interval: Option<Duration>, unit_id: u32, salt: u32) -> Duration {
    let Some(interval) = interval else {
        return Duration::ZERO;
    };
    let mut value = unit_id ^ salt;
    value ^= value >> 16;
    value = value.wrapping_mul(0x7feb_352d);
    value ^= value >> 15;
    value = value.wrapping_mul(0x846c_a68b);
    value ^= value >> 16;
    interval.mul_f64(f64::from(value) / (f64::from(u32::MAX) + 1.0))
}

/// 按服务端累计确认序号结算Grid2D移动；只保留本玩家的少量在途记录，避免解码整份AOI对象图。
/// Settles Grid2D moves from the server's cumulative acknowledgement while retaining only this player's small in-flight queue.
fn apply_grid_move_acknowledgement(
    acknowledgement: u32,
    last_acknowledgement: &mut u32,
    pending: &mut VecDeque<PendingGridMove>,
    result: &mut PlayerResult,
) {
    if acknowledgement <= *last_acknowledgement {
        return;
    }
    *last_acknowledgement = acknowledgement;
    while pending
        .front()
        .is_some_and(|movement| movement.sequence <= acknowledgement)
    {
        let movement = pending.pop_front().expect("front was checked");
        result.move_acknowledged += 1;
        if movement.sampled {
            result
                .movement_latencies_micros
                .push(movement.started_at.elapsed().as_micros() as u64);
        }
    }
}

/// NavMesh3D移动是带回执的ActorLocation RPC；每名玩家只保留一个在途请求来限制客户端与服务端压力。
/// NavMesh3D movement is an acknowledged ActorLocation RPC with one in-flight request per player to bound load on both sides.
#[allow(clippy::too_many_arguments)]
async fn send_navigation(
    writer_tx: &mpsc::Sender<Vec<u8>>,
    next_rpc_id: &mut u32,
    pending: &mut HashMap<u32, PendingRequest>,
    direction_seed: u32,
    sequence: u32,
    move_rate: u64,
    measured: bool,
    sampled: bool,
) -> Result<()> {
    let rpc_id = *next_rpc_id;
    *next_rpc_id = next_rpc_id.wrapping_add(1).max(1);
    let turn_stride = u32::try_from(move_rate.saturating_mul(5))
        .unwrap_or(u32::MAX)
        .max(1);
    let direction = direction_seed.wrapping_add(sequence.saturating_sub(1) / turn_stride) % 4;
    let started_at = Instant::now();
    let mut payload = Vec::with_capacity(20);
    push_sint32(&mut payload, 1, 1);
    push_float(
        &mut payload,
        3,
        direction as f32 * std::f32::consts::FRAC_PI_2,
    );
    push_uint32(&mut payload, 4, sequence);
    send_client_frame(writer_tx, encode_rpc(NAVIGATE_INPUT_REQ, rpc_id, &payload)?).await?;
    pending.insert(
        rpc_id,
        PendingRequest {
            started_at,
            sequence,
            measured,
            sampled: measured && sampled,
            kind: PendingKind::Navigation,
        },
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn send_move(
    writer_tx: &mpsc::Sender<Vec<u8>>,
    unit_id: u32,
    player_index: u32,
    sequence: u32,
    hold_messages: u32,
    move_rate: u64,
    spawn_layout: SpawnLayout,
    world_grids: u32,
) -> Result<()> {
    let (input_x, input_z) = movement_input(
        unit_id,
        player_index,
        sequence,
        hold_messages,
        move_rate,
        spawn_layout,
        world_grids,
    );
    let mut payload = Vec::with_capacity(16);
    push_sint32(&mut payload, 1, input_x);
    push_sint32(&mut payload, 2, input_z);
    push_uint32(&mut payload, 3, sequence);
    send_client_frame(writer_tx, encode_message(MAP_MOVE, &payload)).await
}

fn movement_input(
    unit_id: u32,
    player_index: u32,
    sequence: u32,
    hold_messages: u32,
    move_rate: u64,
    spawn_layout: SpawnLayout,
    world_grids: u32,
) -> (i32, i32) {
    if spawn_layout == SpawnLayout::GridUniform
        && is_grid_crossing_player(player_index, world_grids)
    {
        let reports_per_leg = u32::try_from(move_rate.saturating_mul(GRID_CROSSING_SECONDS))
            .unwrap_or(u32::MAX)
            .max(1);
        let leg = sequence.saturating_sub(1) / reports_per_leg;
        let grid_x = player_index % world_grids;
        let initially_positive = grid_x + 1 < world_grids;
        let positive = if leg.is_multiple_of(2) {
            initially_positive
        } else {
            !initially_positive
        };
        return (if positive { 1 } else { -1 }, 0);
    }

    let direction_step = sequence.saturating_sub(1) / hold_messages;
    match (unit_id.wrapping_add(direction_step) % 4) as i32 {
        0 => (1, 0),
        1 => (0, 1),
        2 => (-1, 0),
        _ => (0, -1),
    }
}

fn is_grid_crossing_player(player_index: u32, world_grids: u32) -> bool {
    let grid_count = world_grids.saturating_mul(world_grids).max(1);
    let grid_index = player_index % grid_count;
    let player_slot_in_grid = player_index / grid_count;
    (grid_index + player_slot_in_grid).is_multiple_of(GRID_CROSSING_PLAYER_MODULUS)
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
            sampled: false,
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
            sampled: false,
            kind: PendingKind::StateSync { mode },
        },
    );
    Ok(())
}

/// 有道具时交替发送真实道具与技能请求；复用账号耗尽初始道具后继续发送技能，
/// 同时保留PlayerUnit有序mailbox的单飞语义。
/// Alternates real item and skill requests while an item exists, then keeps sending skills after
/// a reused account exhausts its starter item, preserving one in-flight request per mailbox.
#[allow(clippy::too_many_arguments)]
async fn send_business(
    writer_tx: &mpsc::Sender<Vec<u8>>,
    next_rpc_id: &mut u32,
    pending: &mut HashMap<u32, PendingRequest>,
    sequence: &mut u32,
    operation: &mut u32,
    unit_id: u32,
    item_id: u64,
    operation_prefix: &str,
    timing: Timing,
    result: &mut PlayerResult,
) -> Result<()> {
    let rpc_id = *next_rpc_id;
    *next_rpc_id = next_rpc_id.wrapping_add(1).max(1);
    *sequence = sequence.wrapping_add(1).max(1);
    let operation_index = *operation;
    let use_item = should_use_business_item(item_id, operation_index);
    *operation = operation.wrapping_add(1);
    let (request_code, response_code, fields) = if use_item {
        let mut fields = Vec::with_capacity(16);
        push_uint64(&mut fields, 1, item_id);
        // UseItem 的客户端幂等键必须满足业务协议约束；压测工具也要走真实请求契约。
        // The load generator must provide a valid client idempotency key just like a real client.
        let operation_id = format!("{operation_prefix}:{unit_id}:{operation_index}");
        push_string(&mut fields, 2, &operation_id);
        (USE_ITEM_REQ, USE_ITEM_RESP, fields)
    } else {
        let mut fields = Vec::with_capacity(16);
        // 3005是真言术·韧，使用自身作为目标，避免把AOI目标查找混入此基准。
        // 3005 is Power Word: Fortitude; self-targeting keeps target lookup out of this baseline.
        push_uint32(&mut fields, 1, 3005);
        push_uint32(&mut fields, 2, unit_id);
        (CAST_SKILL_REQ, CAST_SKILL_RESP, fields)
    };
    let started_at = Instant::now();
    let measured = started_at >= timing.measurement_start && started_at < timing.send_deadline;
    send_client_frame(writer_tx, encode_rpc(request_code, rpc_id, &fields)?).await?;
    if measured {
        result.business_sent += 1;
    }
    pending.insert(
        rpc_id,
        PendingRequest {
            started_at,
            sequence: *sequence,
            measured,
            sampled: false,
            kind: PendingKind::Business { response_code },
        },
    );
    Ok(())
}

fn should_use_business_item(item_id: u64, operation_index: u32) -> bool {
    item_id != 0 && operation_index.is_multiple_of(2)
}

fn pending_probe_count(pending: &HashMap<u32, PendingRequest>) -> usize {
    pending
        .values()
        .filter(|request| matches!(request.kind, PendingKind::Probe))
        .count()
}

fn pending_navigation_count(pending: &HashMap<u32, PendingRequest>) -> usize {
    pending
        .values()
        .filter(|request| matches!(request.kind, PendingKind::Navigation))
        .count()
}

fn pending_state_sync_count(pending: &HashMap<u32, PendingRequest>) -> usize {
    pending
        .values()
        .filter(|request| matches!(request.kind, PendingKind::StateSync { .. }))
        .count()
}

fn pending_business_count(pending: &HashMap<u32, PendingRequest>) -> usize {
    pending
        .values()
        .filter(|request| matches!(request.kind, PendingKind::Business { .. }))
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

async fn request_one(
    host: &str,
    port: u16,
    frame: Vec<u8>,
    timeout: Duration,
    source_ip: Option<IpAddr>,
    source_port: Option<u16>,
) -> Result<Vec<u8>> {
    tokio::time::timeout(timeout, async {
        let mut stream = connect_tcp(host, port, source_ip, source_port).await?;
        stream.set_nodelay(true)?;
        let packet = packet(&frame)?;
        stream.write_all(&packet).await?;
        read_frame_stream(&mut stream).await
    })
    .await
    .with_context(|| format!("request to {host}:{port} timed out"))?
}

/// 从指定源地址建立压测连接，用不同 loopback 地址隔离 Windows TIME_WAIT 端口池。
///
/// Connects from an optional source address so repeated benchmark rounds can use independent
/// Windows TIME_WAIT pools. This helper belongs to the load generator and must not be used by the
/// production transport to conceal real connection churn.
async fn connect_tcp(
    host: &str,
    port: u16,
    source_ip: Option<IpAddr>,
    source_port: Option<u16>,
) -> Result<TcpStream> {
    let target = tokio::net::lookup_host((host, port))
        .await?
        .next()
        .with_context(|| format!("failed to resolve {host}:{port}"))?;
    let socket = if target.is_ipv4() {
        TcpSocket::new_v4()?
    } else {
        TcpSocket::new_v6()?
    };
    if let Some(source_ip) = source_ip {
        if source_ip.is_ipv4() != target.is_ipv4() {
            bail!("source IP family does not match target {target}");
        }
        let source = SocketAddr::new(source_ip, source_port.unwrap_or(0));
        socket
            .bind(source)
            .with_context(|| format!("failed to bind benchmark source {source} for {target}"))?;
    }
    Ok(socket.connect(target).await?)
}

/// 为同一轮中的玩家分配稳定源端口；不同轮由不同 loopback IP 隔离。
///
/// Allocates deterministic source ports per player. Combined with a per-round loopback IP this
/// prevents the load generator's own TIME_WAIT sockets from exhausting Windows' dynamic pool.
fn source_port(source_ip: Option<IpAddr>, base: usize, index: usize) -> Result<Option<u16>> {
    if source_ip.is_none() {
        return Ok(None);
    }
    Ok(Some(
        u16::try_from(base + index).context("benchmark source port exceeds uint16")?,
    ))
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

fn push_uint64(buffer: &mut Vec<u8>, field: u32, value: u64) {
    if value == 0 {
        return;
    }
    push_varint(buffer, u64::from(field << 3));
    push_varint(buffer, value);
}

fn push_sint32(buffer: &mut Vec<u8>, field: u32, value: i32) {
    let zigzag = ((value << 1) ^ (value >> 31)) as u32;
    push_uint32(buffer, field, zigzag);
}

fn push_float(buffer: &mut Vec<u8>, field: u32, value: f32) {
    if value == 0.0 {
        return;
    }
    push_varint(buffer, u64::from((field << 3) | 5));
    buffer.extend_from_slice(&value.to_le_bytes());
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
    fn u64(&self, field: u32) -> u64 {
        *self.varints.get(&field).unwrap_or(&0)
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
    let message = decode_message_allow_error(frame, expected_msgcode, expected_rpc)?;
    let error = message.u32(91)?;
    if error != 0 {
        let detail = message.string(92).unwrap_or_default();
        bail!("RPC returned error {error}: {detail}");
    }
    Ok(message)
}

/// 业务压测只把 GameErrCode 范围内的错误算作正常业务拒绝；Runtime/RPC 错误必须单独计为传输失败。
/// Business load tests count only GameErrCode-range failures as normal rejections;
/// Runtime/RPC failures must remain visible as transport failures.
fn is_business_error_code(code: u32) -> bool {
    code >= 10_000
}

/// 解码RPC但保留业务错误字段，供业务压测区分“业务拒绝”和“传输失败”。
/// Decodes an RPC while retaining its business error fields so the load test can distinguish application rejection from transport failure.
fn decode_message_allow_error(
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

/// 从G2C_EntityMove中零分配提取指定玩家的累计确认序号，不构造其他AOI实体对象。
/// Extracts one player's cumulative acknowledgement from G2C_EntityMove without allocating objects for other AOI entities.
fn find_grid_move_acknowledgement(frame: &[u8], unit_id: u32) -> Result<Option<u32>> {
    let msgcode = frame_msgcode(frame)?;
    if msgcode != ENTITY_MOVE {
        bail!("unexpected msgcode {msgcode}, expected {ENTITY_MOVE}");
    }
    let mut offset = 2;
    let mut acknowledgement = None;
    while offset < frame.len() {
        let tag = read_varint(frame, &mut offset)?;
        let field = (tag >> 3) as u32;
        let wire = tag & 7;
        if field == 2 && wire == 2 {
            let length = read_varint(frame, &mut offset)? as usize;
            let end = offset
                .checked_add(length)
                .context("movement field length overflow")?;
            if end > frame.len() {
                bail!("unexpected eof in movement field");
            }
            if let Some(sequence) = decode_grid_movement_state(&frame[offset..end], unit_id)? {
                acknowledgement =
                    Some(acknowledgement.map_or(sequence, |current: u32| current.max(sequence)));
            }
            offset = end;
        } else {
            skip_protobuf_value(frame, &mut offset, wire)?;
        }
    }
    Ok(acknowledgement)
}

/// 从进图响应的重复ItemSnapshot中查找配置对应的实例ID，避免为只取一个字段构造完整快照。
/// Finds one item instance in repeated ItemSnapshot fields without constructing the full entry snapshot.
fn find_item_id_by_config(
    frame: &[u8],
    items_field: u32,
    expected_config_id: u32,
) -> Result<Option<u64>> {
    let mut offset = 2;
    while offset < frame.len() {
        let tag = read_varint(frame, &mut offset)?;
        let field = (tag >> 3) as u32;
        let wire = tag & 7;
        if field == items_field && wire == 2 {
            let length = read_varint(frame, &mut offset)? as usize;
            let end = offset
                .checked_add(length)
                .context("item field length overflow")?;
            if end > frame.len() {
                bail!("unexpected eof in item field");
            }
            let (item_id, config_id) = decode_item_identity(&frame[offset..end])?;
            if config_id == expected_config_id {
                return Ok(Some(item_id));
            }
            offset = end;
        } else {
            skip_protobuf_value(frame, &mut offset, wire)?;
        }
    }
    Ok(None)
}

fn decode_item_identity(payload: &[u8]) -> Result<(u64, u32)> {
    let mut offset = 0;
    let mut item_id = 0_u64;
    let mut config_id = 0_u32;
    while offset < payload.len() {
        let tag = read_varint(payload, &mut offset)?;
        let field = (tag >> 3) as u32;
        let wire = tag & 7;
        if wire == 0 && (field == 1 || field == 2) {
            let value = read_varint(payload, &mut offset)?;
            if field == 1 {
                item_id = value;
            } else {
                config_id = u32::try_from(value).context("item config id exceeds uint32")?;
            }
        } else {
            skip_protobuf_value(payload, &mut offset, wire)?;
        }
    }
    Ok((item_id, config_id))
}

fn decode_grid_movement_state(payload: &[u8], expected_unit_id: u32) -> Result<Option<u32>> {
    let mut offset = 0;
    let mut unit_id = 0_u32;
    let mut acknowledgement = 0_u32;
    while offset < payload.len() {
        let tag = read_varint(payload, &mut offset)?;
        let field = (tag >> 3) as u32;
        let wire = tag & 7;
        if wire == 0 && (field == 1 || field == 2) {
            let value = u32::try_from(read_varint(payload, &mut offset)?)
                .context("movement state field exceeds uint32")?;
            if field == 1 {
                unit_id = value;
            } else {
                acknowledgement = value;
            }
        } else {
            skip_protobuf_value(payload, &mut offset, wire)?;
        }
    }
    Ok((unit_id == expected_unit_id).then_some(acknowledgement))
}

fn skip_protobuf_value(bytes: &[u8], offset: &mut usize, wire: u64) -> Result<()> {
    match wire {
        0 => {
            read_varint(bytes, offset)?;
        }
        1 => advance(bytes, offset, 8)?,
        2 => {
            let length = read_varint(bytes, offset)? as usize;
            advance(bytes, offset, length)?;
        }
        5 => advance(bytes, offset, 4)?,
        _ => bail!("unsupported protobuf wire type {wire}"),
    }
    Ok(())
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
    let mut flags = HashSet::<String>::new();
    let mut index = 0;
    while index < args.len() {
        let argument = &args[index];
        if !argument.starts_with("--") {
            bail!("unexpected argument {argument}; options must start with --");
        }
        let key = argument.trim_start_matches('-').to_ascii_lowercase();
        if args
            .get(index + 1)
            .is_some_and(|value| !value.starts_with('-'))
        {
            values.insert(key, args[index + 1].clone());
            index += 2;
        } else {
            flags.insert(key);
            index += 1;
        }
    }
    let number = |name: &str, fallback: u64| -> Result<u64> {
        values
            .get(name)
            .map(|value| value.parse::<u64>())
            .transpose()
            .with_context(|| format!("invalid --{name}"))
            .map(|value| value.unwrap_or(fallback))
    };
    let rate = |name: &str, fallback: f64| -> Result<f64> {
        let value = values
            .get(name)
            .map(|value| value.parse::<f64>())
            .transpose()
            .with_context(|| format!("invalid --{name}"))?
            .unwrap_or(fallback);
        if !value.is_finite() || value < 0.0 {
            bail!("--{name} must be a finite number greater than or equal to zero");
        }
        Ok(value)
    };
    let players = number("players", 100)? as usize;
    let setup_concurrency = number("setup-concurrency", 16)? as usize;
    let map_entry_concurrency = values
        .get("map-entry-concurrency")
        .map(|value| value.parse::<usize>())
        .transpose()
        .context("invalid --map-entry-concurrency")?;
    let map_entry_rate = values
        .get("map-entry-rate")
        .map(|value| value.parse::<f64>())
        .transpose()
        .context("invalid --map-entry-rate")?;
    let probe_concurrency = number("probe-concurrency", 4)? as usize;
    let state_sync_concurrency = number("state-sync-concurrency", 4)? as usize;
    let movement_hold_messages = u32::try_from(number("movement-hold-messages", 1)?)
        .context("movement hold messages exceeds uint32")?;
    let world_grids =
        u32::try_from(number("world-grids", 10)?).context("world grids exceeds uint32")?;
    let duration = number("duration", 10)?;
    let movement_timeout = number("movement-timeout", 5_000)?;
    let account_prefix = values.get("account-prefix").cloned();
    if let Some(prefix) = &account_prefix
        && (prefix.is_empty()
            || prefix.len() > 28
            || !prefix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'))
    {
        bail!("--account-prefix must use 1-28 ASCII letters, digits, _ or -");
    }
    let reuse_accounts = flags.contains("reuse-accounts");
    if reuse_accounts && account_prefix.is_none() {
        bail!("--reuse-accounts requires --account-prefix");
    }
    let operation_prefix = values
        .get("operation-prefix")
        .cloned()
        .unwrap_or_else(|| "perf-business".to_string());
    if operation_prefix.is_empty()
        || operation_prefix.len() > 64
        || !operation_prefix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        bail!(
            "--operation-prefix must use 1-64 ASCII letters, digits, dot, underscore, colon or dash"
        );
    }
    if players == 0
        || setup_concurrency == 0
        || map_entry_concurrency == Some(0)
        || map_entry_rate.is_some_and(|value| !value.is_finite() || value <= 0.0)
        || probe_concurrency == 0
        || state_sync_concurrency == 0
        || movement_hold_messages == 0
        || world_grids == 0
        || duration == 0
        || movement_timeout == 0
    {
        bail!(
            "players, setup-concurrency, map-entry-concurrency, map-entry-rate, probe-concurrency, state-sync-concurrency, movement-hold-messages, world-grids, duration and movement-timeout must be greater than zero"
        );
    }
    if map_entry_rate.is_some() && map_entry_concurrency.is_none() {
        bail!("--map-entry-rate requires --map-entry-concurrency");
    }
    Ok(Options {
        host: values
            .get("host")
            .cloned()
            .unwrap_or_else(|| "127.0.0.1".to_string()),
        source_ip: values
            .get("source-ip")
            .map(|value| value.parse::<IpAddr>())
            .transpose()
            .context("invalid --source-ip")?,
        manager_port: u16::try_from(number("manager-port", 7000)?)
            .context("manager port exceeds uint16")?,
        map_id: u32::try_from(number("map-id", 1)?).context("map id exceeds uint32")?,
        players,
        setup_concurrency,
        map_entry_concurrency,
        map_entry_rate,
        post_setup_settle: Duration::from_secs(number("post-setup-settle", 0)?),
        warmup: Duration::from_secs(number("warmup", 2)?),
        duration: Duration::from_secs(duration),
        timeout: Duration::from_millis(number("timeout", 60_000)?),
        movement_timeout: Duration::from_millis(movement_timeout),
        move_rate: number("move-rate", 0)?,
        movement_sequence_base: u32::try_from(number("movement-sequence-base", 0)?)
            .context("movement sequence base exceeds uint32")?,
        movement_hold_messages,
        spawn_layout: SpawnLayout::parse(
            values
                .get("spawn-layout")
                .map(String::as_str)
                .unwrap_or("same-point"),
        )?,
        world_grids,
        entry_sync_mode: EntrySyncMode::parse(
            values
                .get("entry-sync-mode")
                .map(String::as_str)
                .unwrap_or("full"),
        )?,
        probe_rate: rate("probe-rate", 0.2)?,
        probe_concurrency,
        business_rate: rate("business-rate", 0.0)?,
        state_sync_mode: StateSyncMode::parse(
            values
                .get("state-sync-mode")
                .map(String::as_str)
                .unwrap_or("off"),
        )?,
        state_sync_rate: number("state-sync-rate", 0)?,
        state_sync_concurrency,
        account_prefix,
        reuse_accounts,
        operation_prefix,
        label: values
            .get("label")
            .cloned()
            .unwrap_or_else(|| "rust".to_string()),
        measurement_signal_file: values.get("measurement-signal-file").map(PathBuf::from),
    })
}

fn account_name(options: &Options, account_seed: u128, index: usize) -> Result<String> {
    let account = if let Some(prefix) = &options.account_prefix {
        let suffix = to_base36(index);
        format!("{prefix}{suffix:0>4}")
    } else {
        format!("rp{}_{}_{}", std::process::id(), account_seed, index)
    };
    if account.len() > 32 {
        bail!("generated account exceeds 32 bytes: {account}");
    }
    Ok(account)
}

fn to_base36(mut value: usize) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut encoded = Vec::with_capacity(8);
    while value > 0 {
        encoded.push(DIGITS[value % 36]);
        value /= 36;
    }
    encoded.reverse();
    String::from_utf8(encoded).expect("base36 digits are valid UTF-8")
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

    #[test]
    fn player_phase_offsets_cover_the_interval_without_reaching_its_end() {
        let interval = Duration::from_secs(1);
        let offsets: Vec<_> = (1..=1_000)
            .map(|unit_id| phase_offset(Some(interval), unit_id, 0x9e37_79b9))
            .collect();
        assert!(offsets.iter().all(|offset| *offset < interval));
        assert!(
            offsets
                .iter()
                .any(|offset| *offset < Duration::from_millis(100))
        );
        assert!(
            offsets
                .iter()
                .any(|offset| *offset > Duration::from_millis(900))
        );
        assert_eq!(phase_offset(None, 1, 0), Duration::ZERO);
    }

    #[test]
    fn probe_rate_accepts_fractional_hertz_and_defaults_to_five_seconds() {
        let defaults = parse_options(Vec::new()).unwrap();
        assert!((defaults.probe_rate - 0.2).abs() < f64::EPSILON);

        let explicit = parse_options(vec!["--probe-rate".into(), "0.5".into()]).unwrap();
        assert!((explicit.probe_rate - 0.5).abs() < f64::EPSILON);
    }

    #[test]
    fn stable_accounts_match_the_typescript_suffix_and_accept_the_reuse_flag() {
        let options = parse_options(vec![
            "--account-prefix".into(),
            "chaos7db".into(),
            "--reuse-accounts".into(),
            "--operation-prefix".into(),
            "chaos7d:1".into(),
        ])
        .unwrap();
        assert!(options.reuse_accounts);
        assert_eq!(account_name(&options, 0, 0).unwrap(), "chaos7db0000");
        assert_eq!(account_name(&options, 0, 35).unwrap(), "chaos7db000z");
        assert!(parse_options(vec!["--reuse-accounts".into()]).is_err());
    }

    #[test]
    fn movement_sequence_base_is_explicit_and_bounded() {
        assert_eq!(parse_options(Vec::new()).unwrap().movement_sequence_base, 0);
        assert_eq!(
            parse_options(vec!["--movement-sequence-base".into(), "420000".into()])
                .unwrap()
                .movement_sequence_base,
            420_000
        );
        assert!(
            parse_options(vec![
                "--movement-sequence-base".into(),
                (u64::from(u32::MAX) + 1).to_string(),
            ])
            .is_err()
        );
    }

    #[test]
    fn grid_move_acknowledgement_scans_only_the_requested_unit() {
        let mut frame = ENTITY_MOVE.to_be_bytes().to_vec();
        push_uint32(&mut frame, 1, 42);
        for (unit_id, sequence) in [(7, 10), (9, 12), (7, 11)] {
            let mut movement = Vec::new();
            push_uint32(&mut movement, 1, unit_id);
            push_uint32(&mut movement, 2, sequence);
            push_sint32(&mut movement, 3, -2);
            push_varint(&mut frame, u64::from((2_u32 << 3) | 2));
            push_varint(&mut frame, movement.len() as u64);
            frame.extend_from_slice(&movement);
        }

        assert_eq!(find_grid_move_acknowledgement(&frame, 7).unwrap(), Some(11));
        assert_eq!(find_grid_move_acknowledgement(&frame, 9).unwrap(), Some(12));
        assert_eq!(find_grid_move_acknowledgement(&frame, 8).unwrap(), None);
    }

    #[test]
    fn starter_item_lookup_ignores_other_item_snapshots() {
        let mut frame = ENTER_MAP_RESP.to_be_bytes().to_vec();
        for (item_id, config_id) in [(41_u64, 2001_u32), (99_u64, 1001_u32)] {
            let mut item = Vec::new();
            push_uint64(&mut item, 1, item_id);
            push_uint32(&mut item, 2, config_id);
            push_uint32(&mut item, 3, 5);
            push_varint(&mut frame, u64::from((9_u32 << 3) | 2));
            push_varint(&mut frame, item.len() as u64);
            frame.extend_from_slice(&item);
        }

        assert_eq!(find_item_id_by_config(&frame, 9, 1001).unwrap(), Some(99));
        assert_eq!(find_item_id_by_config(&frame, 9, 3001).unwrap(), None);
    }

    #[test]
    fn reused_accounts_without_a_starter_item_continue_with_skills() {
        assert!(!should_use_business_item(0, 0));
        assert!(!should_use_business_item(0, 1));
        assert!(should_use_business_item(99, 0));
        assert!(!should_use_business_item(99, 1));
    }

    #[test]
    fn navigation_float_uses_protobuf_fixed32_little_endian() {
        let mut payload = Vec::new();
        push_float(&mut payload, 3, std::f32::consts::FRAC_PI_2);
        assert_eq!(payload[0], (3_u8 << 3) | 5);
        assert_eq!(&payload[1..], &std::f32::consts::FRAC_PI_2.to_le_bytes());
        assert_eq!(SpatialMode::parse(1).unwrap().name(), "grid2d");
        assert_eq!(SpatialMode::parse(2).unwrap().name(), "navmesh3d");
        assert!(SpatialMode::parse(0).is_err());
    }

    #[test]
    fn map_entry_concurrency_is_optional_and_must_be_positive() {
        assert_eq!(
            parse_options(Vec::new()).unwrap().map_entry_concurrency,
            None
        );
        assert_eq!(
            parse_options(vec!["--map-entry-concurrency".into(), "3000".into()])
                .unwrap()
                .map_entry_concurrency,
            Some(3000)
        );
        assert!(parse_options(vec!["--map-entry-concurrency".into(), "0".into()]).is_err());
    }

    #[test]
    fn map_entry_rate_is_optional_and_requires_positive_two_stage_mode() {
        assert_eq!(parse_options(Vec::new()).unwrap().map_entry_rate, None);
        assert_eq!(
            parse_options(vec![
                "--map-entry-concurrency".into(),
                "512".into(),
                "--map-entry-rate".into(),
                "50".into(),
            ])
            .unwrap()
            .map_entry_rate,
            Some(50.0)
        );
        assert!(parse_options(vec!["--map-entry-rate".into(), "50".into()]).is_err());
        assert!(
            parse_options(vec![
                "--map-entry-concurrency".into(),
                "512".into(),
                "--map-entry-rate".into(),
                "0".into(),
            ])
            .is_err()
        );
    }

    #[test]
    fn uniform_profile_keeps_eighty_percent_local_and_crosses_twenty_percent() {
        let crossing = (0..3_000)
            .filter(|index| is_grid_crossing_player(*index, 10))
            .count();
        assert_eq!(crossing, 600);
        for grid_index in 0..100 {
            let crossing_in_grid = (0..30)
                .filter(|slot| is_grid_crossing_player(grid_index + slot * 100, 10))
                .count();
            assert_eq!(crossing_in_grid, 6);
        }

        assert_eq!(
            movement_input(1, 0, 1, 2, 2, SpawnLayout::GridUniform, 10),
            (1, 0)
        );
        assert_eq!(
            movement_input(1, 0, 4, 2, 2, SpawnLayout::GridUniform, 10),
            (1, 0)
        );
        assert_eq!(
            movement_input(1, 0, 5, 2, 2, SpawnLayout::GridUniform, 10),
            (-1, 0)
        );
        assert_eq!(
            movement_input(1, 109, 1, 2, 2, SpawnLayout::GridUniform, 10),
            (-1, 0)
        );
    }
}
