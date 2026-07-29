//! 加载部署 JSON，并在任何监听器或 V8 启动前校验运行时不变量。 / Loads deployment JSON and enforces runtime invariants before any listener or V8 starts.

use std::collections::{BTreeMap, HashSet};
use std::net::IpAddr;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

const MAX_URING_READ_BUFFER_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    pub process: ProcessConfig,
    pub scenes: Vec<SceneConfig>,
    #[serde(default)]
    pub known_scenes: Vec<SceneConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessConfig {
    pub name: String,
    #[serde(default)]
    pub identity: ProcessIdentityConfig,
    #[serde(default)]
    pub logging: ProcessLoggingConfig,
    #[serde(default)]
    pub network: ProcessNetworkConfig,
    #[serde(default)]
    pub game: ProcessGameConfig,
    #[serde(default)]
    pub scheduling: ProcessSchedulingConfig,
    #[serde(default)]
    pub lifecycle: ProcessLifecycleConfig,
    #[serde(default)]
    pub debug: Option<ProcessDebugConfig>,
    #[serde(default)]
    pub observability: Option<ProcessObservabilityConfig>,
    #[serde(default, flatten)]
    pub extensions: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessIdentityConfig {
    #[serde(default = "default_origin_server_id")]
    pub origin_server_id: u16,
    #[serde(default)]
    pub worker_id: u8,
}

impl Default for ProcessIdentityConfig {
    fn default() -> Self {
        Self {
            origin_server_id: default_origin_server_id(),
            worker_id: 0,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessLoggingConfig {
    #[serde(default)]
    pub level: ProcessLogLevel,
    #[serde(default)]
    pub format: ProcessLogFormat,
    #[serde(default = "default_true")]
    pub console: bool,
    #[serde(default)]
    pub filter: Option<String>,
    #[serde(default)]
    pub file: Option<ProcessLogFileConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessLifecycleConfig {
    #[serde(default = "default_stop_timeout_ms")]
    pub stop_timeout_ms: u64,
    #[serde(default = "default_hotfix_reload_timeout_ms")]
    pub hotfix_reload_timeout_ms: u64,
}

impl Default for ProcessLifecycleConfig {
    fn default() -> Self {
        Self {
            stop_timeout_ms: default_stop_timeout_ms(),
            hotfix_reload_timeout_ms: default_hotfix_reload_timeout_ms(),
        }
    }
}

impl Default for ProcessLoggingConfig {
    fn default() -> Self {
        Self {
            level: ProcessLogLevel::default(),
            format: ProcessLogFormat::default(),
            console: true,
            filter: None,
            file: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ProcessLogLevel {
    Trace,
    Debug,
    #[default]
    Info,
    Warn,
    Error,
}

impl ProcessLogLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Trace => "trace",
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ProcessLogFormat {
    #[default]
    Pretty,
    Json,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessLogFileConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_log_directory")]
    pub directory: String,
    #[serde(default)]
    pub rotation: ProcessLogRotation,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ProcessLogRotation {
    Hourly,
    #[default]
    Daily,
    Never,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum IoBackendKind {
    #[default]
    Epoll,
    IoUring,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessNetworkConfig {
    #[serde(default, alias = "backend")]
    pub io_backend: IoBackendKind,
    #[serde(default = "default_uring_entries")]
    pub uring_entries: u32,
    #[serde(default = "default_uring_read_buffer_bytes")]
    pub uring_read_buffer_bytes: usize,
}

impl Default for ProcessNetworkConfig {
    fn default() -> Self {
        Self {
            io_backend: IoBackendKind::default(),
            uring_entries: default_uring_entries(),
            uring_read_buffer_bytes: default_uring_read_buffer_bytes(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessGameConfig {
    #[serde(default = "default_fixed_update_ms")]
    pub fixed_update_ms: u64,
    #[serde(default = "default_max_catch_up_steps")]
    pub max_catch_up_steps: usize,
}

impl Default for ProcessGameConfig {
    fn default() -> Self {
        Self {
            fixed_update_ms: default_fixed_update_ms(),
            max_catch_up_steps: default_max_catch_up_steps(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProcessSchedulingMode {
    LowLatency,
    Throughput,
    #[default]
    Adaptive,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSchedulingConfig {
    #[serde(default)]
    pub mode: ProcessSchedulingMode,
    pub idle_tick_ms: Option<u64>,
    pub max_events_per_update: Option<usize>,
    pub coalesce_micros: Option<u64>,
    pub event_queue_capacity: Option<usize>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessObservabilityConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latency: Option<LatencyObservabilityConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health: Option<HealthObservabilityConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthObservabilityConfig {
    #[serde(default = "default_health_ip")]
    pub ip: String,
    pub port: u16,
    #[serde(default = "default_health_stale_after_ms")]
    pub stale_after_ms: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyObservabilityConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_latency_sample_rate")]
    pub sample_rate: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartMachineConfig {
    pub machines: Vec<MachineConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineConfig {
    pub name: Option<String>,
    pub inner_ip: String,
    pub processes: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneConfig {
    pub name: String,
    pub scene_type: String,
    pub ip: String,
    pub port: u16,
    #[serde(default, alias = "transport")]
    pub protocol: EndpointProtocol,
    #[serde(default)]
    pub audience: EndpointAudience,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum EndpointAudience {
    #[default]
    Mixed,
    Inner,
    Outer,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum EndpointProtocol {
    #[default]
    Auto,
    #[serde(alias = "raw")]
    Tcp,
    #[serde(rename = "websocket")]
    WebSocket,
    Kcp,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessDebugConfig {
    #[serde(default = "default_inspector_ip")]
    pub inspector_ip: String,
    pub inspector_port: u16,
    #[serde(default)]
    pub break_on_start: bool,
    #[serde(default)]
    pub allow_remote: bool,
}

fn default_inspector_ip() -> String {
    "127.0.0.1".to_string()
}

fn default_origin_server_id() -> u16 {
    1
}

fn default_health_ip() -> String {
    "127.0.0.1".to_string()
}

fn default_health_stale_after_ms() -> u64 {
    15_000
}

fn default_true() -> bool {
    true
}

fn default_log_directory() -> String {
    "logs".to_string()
}

fn default_latency_sample_rate() -> u32 {
    1
}

fn default_uring_entries() -> u32 {
    1024
}

fn default_uring_read_buffer_bytes() -> usize {
    64 * 1024
}

fn default_fixed_update_ms() -> u64 {
    // 默认 20Hz 游戏逻辑帧；网络事件仍会即时唤醒 Runtime Pump。
    50
}

fn default_stop_timeout_ms() -> u64 {
    10_000
}

fn default_hotfix_reload_timeout_ms() -> u64 {
    30_000
}

fn default_max_catch_up_steps() -> usize {
    2
}

/// 根据项目根目录解析 CLI 路径，并将目录展开为 `StartMachine.json`。
///
/// 本函数不执行 I/O，不能用它证明目标存在；加载与校验保持分离，
/// 以便诊断信息保留原始启动路径。
///
/// Resolves a CLI path against the project root and expands directories to `StartMachine.json`.
///
/// This function performs no I/O and must not be used as proof that the target
/// exists; loading and validation remain separate so diagnostics retain the
/// original startup path.
pub fn resolve_startup_path(root: &Path, startup_path: String) -> PathBuf {
    let path = PathBuf::from(startup_path);
    let resolved = if path.is_absolute() {
        path
    } else {
        root.join(path)
    };

    if resolved.is_dir() {
        return resolved.join("StartMachine.json");
    }
    resolved
}

/// 判断解析后的启动路径是否选择 Watcher 模式。 / Returns whether a resolved startup path selects Watcher mode.
pub fn is_start_machine_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("StartMachine.json"))
}

/// 加载一份进程配置、应用默认值并完成校验。
///
/// 返回结果保证已填充 `known_scenes`。调用方不应直接反序列化
/// `RuntimeConfig`，否则会绕过端点唯一性和生命周期超时边界等部署不变量。
///
/// Loads, applies defaults, and validates one process configuration.
///
/// The returned `known_scenes` is guaranteed to be populated. Callers should
/// not deserialize `RuntimeConfig` directly because that bypasses deployment
/// invariants such as unique endpoints and lifecycle timeout bounds.
pub fn load_runtime_config(resolved_config: &Path) -> Result<RuntimeConfig> {
    let config_text = std::fs::read_to_string(resolved_config)
        .with_context(|| format!("failed to read {}", resolved_config.display()))?;
    let mut config: RuntimeConfig = serde_json::from_str(&config_text)
        .with_context(|| format!("failed to parse {}", resolved_config.display()))?;

    if config.scenes.is_empty() {
        bail!("process must start at least one scene");
    }
    if config.known_scenes.is_empty() {
        config.known_scenes = config.scenes.clone();
    }
    validate_runtime_config(&config)?;
    Ok(config)
}

fn validate_runtime_config(config: &RuntimeConfig) -> Result<()> {
    if config.process.name.trim().is_empty() {
        bail!("process.name must not be empty");
    }
    if config.process.identity.origin_server_id == 0
        || config.process.identity.origin_server_id > 16_383
    {
        bail!("process identity.originServerId must be between 1 and 16383");
    }
    if config.process.identity.worker_id > 127 {
        bail!("process identity.workerId must be between 0 and 127");
    }
    let log_file_enabled = config
        .process
        .logging
        .file
        .as_ref()
        .is_some_and(|file| file.enabled);
    if !config.process.logging.console && !log_file_enabled {
        bail!("process logging must enable console or file output");
    }
    if config
        .process
        .logging
        .filter
        .as_ref()
        .is_some_and(|filter| filter.trim().is_empty())
    {
        bail!("process logging.filter must not be empty");
    }
    if config
        .process
        .logging
        .file
        .as_ref()
        .is_some_and(|file| file.enabled && file.directory.trim().is_empty())
    {
        bail!("process logging.file.directory must not be empty");
    }
    if config.process.game.fixed_update_ms == 0 {
        bail!("process game.fixedUpdateMs must be greater than 0");
    }
    if config.process.game.fixed_update_ms > 10_000 {
        bail!("process game.fixedUpdateMs must not exceed 10000");
    }
    if config.process.game.max_catch_up_steps == 0 {
        bail!("process game.maxCatchUpSteps must be greater than 0");
    }
    if config.process.game.max_catch_up_steps > 100 {
        bail!("process game.maxCatchUpSteps must not exceed 100");
    }
    if !(100..=120_000).contains(&config.process.lifecycle.stop_timeout_ms) {
        bail!("process lifecycle.stopTimeoutMs must be between 100 and 120000");
    }
    if !(100..=120_000).contains(&config.process.lifecycle.hotfix_reload_timeout_ms) {
        bail!("process lifecycle.hotfixReloadTimeoutMs must be between 100 and 120000");
    }
    if !config.process.network.uring_entries.is_power_of_two()
        || !(64..=32_768).contains(&config.process.network.uring_entries)
    {
        bail!("process network.uringEntries must be a power of two between 64 and 32768");
    }
    if !(4 * 1024..=MAX_URING_READ_BUFFER_BYTES)
        .contains(&config.process.network.uring_read_buffer_bytes)
    {
        bail!(
            "process network.uringReadBufferBytes must be between 4096 and {MAX_URING_READ_BUFFER_BYTES}"
        );
    }
    if config.process.scheduling.idle_tick_ms == Some(0) {
        bail!("process scheduling.idleTickMs must be greater than 0");
    }
    if config.process.scheduling.max_events_per_update == Some(0) {
        bail!("process scheduling.maxEventsPerUpdate must be greater than 0");
    }
    if config
        .process
        .scheduling
        .coalesce_micros
        .is_some_and(|value| value > 10_000)
    {
        bail!("process scheduling.coalesceMicros must not exceed 10000");
    }
    if config
        .process
        .scheduling
        .max_events_per_update
        .is_some_and(|value| value > 4096)
    {
        bail!("process scheduling.maxEventsPerUpdate must not exceed 4096");
    }
    if config
        .process
        .scheduling
        .event_queue_capacity
        .is_some_and(|value| !(64..=65_536).contains(&value))
    {
        bail!("process scheduling.eventQueueCapacity must be between 64 and 65536");
    }
    if let Some(latency) = config
        .process
        .observability
        .as_ref()
        .and_then(|observability| observability.latency.as_ref())
        && latency.sample_rate == 0
    {
        bail!("process observability.latency.sampleRate must not be 0");
    }

    let mut scene_names = HashSet::new();
    let mut scene_endpoints = HashSet::new();
    for scene in &config.scenes {
        if scene.name.trim().is_empty() || scene.scene_type.trim().is_empty() {
            bail!("scene name and sceneType must not be empty");
        }
        if scene.port == 0 {
            bail!("scene {} port must not be 0", scene.name);
        }
        scene
            .ip
            .parse::<IpAddr>()
            .with_context(|| format!("scene {} has invalid ip: {}", scene.name, scene.ip))?;
        if !scene_names.insert(scene.name.clone()) {
            bail!("duplicate scene name {}", scene.name);
        }
        if !scene_endpoints.insert((scene.ip.clone(), scene.port)) {
            bail!("duplicate scene endpoint {}:{}", scene.ip, scene.port);
        }
        if scene.protocol == EndpointProtocol::Kcp {
            if scene.audience == EndpointAudience::Mixed {
                bail!(
                    "scene {} must set audience=inner or audience=outer when protocol=kcp",
                    scene.name
                );
            }
            if !cfg!(feature = "kcp") {
                bail!(
                    "scene {} selects protocol=kcp; rebuild Runtime with --features kcp",
                    scene.name
                );
            }
            if scene.audience == EndpointAudience::Inner {
                bail!(
                    "scene {} selects inner KCP, which is not available until the authenticated inner handshake is implemented",
                    scene.name
                );
            }
        }
        if scene.protocol == EndpointProtocol::WebSocket
            && scene.audience == EndpointAudience::Inner
        {
            bail!(
                "scene {} cannot use websocket for an inner endpoint",
                scene.name
            );
        }
        if config.process.network.io_backend == IoBackendKind::IoUring
            && scene.protocol != EndpointProtocol::Tcp
        {
            bail!(
                "scene {} must set protocol=tcp when process network.ioBackend=io-uring",
                scene.name
            );
        }
    }

    let health = config
        .process
        .observability
        .as_ref()
        .and_then(|observability| observability.health.as_ref());
    if let Some(health) = health {
        health.ip.parse::<IpAddr>().with_context(|| {
            format!(
                "process {} has invalid observability.health.ip: {}",
                config.process.name, health.ip
            )
        })?;
        if health.port == 0 {
            bail!("process observability.health.port must not be 0");
        }
        if health.stale_after_ms < 10_000 {
            bail!("process observability.health.staleAfterMs must be at least 10000");
        }
        if config.scenes.iter().any(|scene| scene.port == health.port) {
            bail!(
                "process health port {} conflicts with a scene port",
                health.port
            );
        }
    }

    if let Some(debug) = &config.process.debug {
        let inspector_ip = debug.inspector_ip.parse::<IpAddr>().with_context(|| {
            format!(
                "process {} has invalid debug.inspectorIp: {}",
                config.process.name, debug.inspector_ip
            )
        })?;
        if debug.inspector_port == 0 {
            bail!("process debug.inspectorPort must not be 0");
        }
        if !inspector_ip.is_loopback() && !debug.allow_remote {
            bail!(
                "process inspector {} is not loopback; set debug.allowRemote=true explicitly to expose it",
                debug.inspector_ip
            );
        }
        if config
            .scenes
            .iter()
            .any(|scene| scene.port == debug.inspector_port)
        {
            bail!(
                "process inspector port {} conflicts with a scene port",
                debug.inspector_port
            );
        }
        if health.is_some_and(|health| health.port == debug.inspector_port) {
            bail!(
                "process health port {} conflicts with inspector port",
                debug.inspector_port
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scene(name: &str, port: u16) -> SceneConfig {
        SceneConfig {
            name: name.to_string(),
            scene_type: "Log".to_string(),
            ip: "127.0.0.1".to_string(),
            port,
            protocol: EndpointProtocol::Auto,
            audience: EndpointAudience::Mixed,
        }
    }

    fn process(inspector_port: Option<u16>) -> ProcessConfig {
        ProcessConfig {
            name: "test".to_string(),
            identity: ProcessIdentityConfig::default(),
            logging: ProcessLoggingConfig::default(),
            network: ProcessNetworkConfig::default(),
            game: ProcessGameConfig::default(),
            scheduling: ProcessSchedulingConfig::default(),
            lifecycle: ProcessLifecycleConfig::default(),
            debug: inspector_port.map(|inspector_port| ProcessDebugConfig {
                inspector_ip: default_inspector_ip(),
                inspector_port,
                break_on_start: false,
                allow_remote: false,
            }),
            observability: None,
            extensions: BTreeMap::new(),
        }
    }

    #[test]
    fn parses_io_backend_and_requires_tcp_endpoints() {
        let process: ProcessConfig = serde_json::from_str(
            r#"{
                "name": "gate1",
                "network": {
                    "ioBackend": "io-uring",
                    "uringEntries": 2048,
                    "uringReadBufferBytes": 131072
                }
            }"#,
        )
        .unwrap();
        assert_eq!(process.network.io_backend, IoBackendKind::IoUring);
        assert_eq!(process.network.uring_entries, 2048);
        assert_eq!(process.network.uring_read_buffer_bytes, 131072);

        let config = RuntimeConfig {
            process,
            scenes: vec![scene("gate", 7201)],
            known_scenes: vec![],
        };
        assert!(validate_runtime_config(&config).is_err());
    }

    #[test]
    fn accepts_legacy_network_and_scene_names() {
        let config: RuntimeConfig = serde_json::from_str(
            r#"{
                "process": { "name": "legacy", "network": { "backend": "epoll" } },
                "scenes": [{
                    "name": "gate", "sceneType": "Gate",
                    "ip": "127.0.0.1", "port": 7201, "transport": "raw"
                }]
            }"#,
        )
        .unwrap();
        assert_eq!(config.process.network.io_backend, IoBackendKind::Epoll);
        assert_eq!(config.scenes[0].protocol, EndpointProtocol::Tcp);
    }

    #[test]
    fn requires_kcp_feature_when_disabled() {
        let mut kcp_scene = scene("gate", 7201);
        kcp_scene.protocol = EndpointProtocol::Kcp;
        kcp_scene.audience = EndpointAudience::Outer;
        let config = RuntimeConfig {
            process: process(None),
            scenes: vec![kcp_scene],
            known_scenes: vec![],
        };
        let result = validate_runtime_config(&config);
        if cfg!(feature = "kcp") {
            assert!(result.is_ok());
        } else {
            assert!(result.unwrap_err().to_string().contains("--features kcp"));
        }
    }

    #[test]
    fn kcp_endpoint_requires_explicit_audience() {
        let mut kcp_scene = scene("gate", 7201);
        kcp_scene.protocol = EndpointProtocol::Kcp;
        let config = RuntimeConfig {
            process: process(None),
            scenes: vec![kcp_scene],
            known_scenes: vec![],
        };
        let error = validate_runtime_config(&config).unwrap_err().to_string();
        assert!(error.contains("audience=inner or audience=outer"));
    }

    #[test]
    fn rejects_inspector_scene_port_conflict() {
        let config = RuntimeConfig {
            process: process(Some(7100)),
            scenes: vec![scene("log", 7100)],
            known_scenes: vec![],
        };
        assert!(validate_runtime_config(&config).is_err());
    }

    #[test]
    fn rejects_duplicate_scene_names() {
        let config = RuntimeConfig {
            process: process(None),
            scenes: vec![scene("map", 7100), scene("map", 7101)],
            known_scenes: vec![],
        };
        assert!(validate_runtime_config(&config).is_err());
    }

    #[test]
    fn parses_process_scheduling_overrides() {
        let process: ProcessConfig = serde_json::from_str(
            r#"{
                "name": "map1",
                "scheduling": {
                    "mode": "throughput",
                    "idleTickMs": 25,
                    "maxEventsPerUpdate": 1024,
                    "coalesceMicros": 500,
                    "eventQueueCapacity": 8192
                }
            }"#,
        )
        .unwrap();

        assert!(matches!(
            process.scheduling.mode,
            ProcessSchedulingMode::Throughput
        ));
        assert_eq!(process.scheduling.idle_tick_ms, Some(25));
        assert_eq!(process.scheduling.max_events_per_update, Some(1024));
        assert_eq!(process.scheduling.coalesce_micros, Some(500));
        assert_eq!(process.scheduling.event_queue_capacity, Some(8192));
    }

    #[test]
    fn validates_process_event_queue_capacity_bounds() {
        for capacity in [64, 65_536] {
            let mut process = process(None);
            process.scheduling.event_queue_capacity = Some(capacity);
            let config = RuntimeConfig {
                process,
                scenes: vec![scene("map", 7100)],
                known_scenes: vec![],
            };
            assert!(validate_runtime_config(&config).is_ok());
        }

        for capacity in [63, 65_537] {
            let mut process = process(None);
            process.scheduling.event_queue_capacity = Some(capacity);
            let config = RuntimeConfig {
                process,
                scenes: vec![scene("map", 7100)],
                known_scenes: vec![],
            };
            let error = validate_runtime_config(&config).unwrap_err().to_string();
            assert!(error.contains("eventQueueCapacity"));
        }
    }

    #[test]
    fn parses_process_logging_config() {
        let process: ProcessConfig = serde_json::from_str(
            r#"{
                "name": "map1",
                "logging": {
                    "level": "debug",
                    "format": "json",
                    "console": false,
                    "filter": "TiangZ=debug,tokio=warn",
                    "file": {
                        "directory": "logs/server",
                        "rotation": "hourly"
                    }
                }
            }"#,
        )
        .unwrap();
        assert_eq!(process.logging.level, ProcessLogLevel::Debug);
        assert_eq!(process.logging.format, ProcessLogFormat::Json);
        assert!(!process.logging.console);
        assert_eq!(
            process.logging.filter.as_deref(),
            Some("TiangZ=debug,tokio=warn")
        );
        let file = process.logging.file.unwrap();
        assert!(file.enabled);
        assert_eq!(file.directory, "logs/server");
        assert_eq!(file.rotation, ProcessLogRotation::Hourly);
    }

    #[test]
    fn parses_and_validates_health_endpoint() {
        let process: ProcessConfig = serde_json::from_str(
            r#"{
                "name": "map1",
                "observability": {
                    "health": { "ip": "127.0.0.1", "port": 7601 }
                }
            }"#,
        )
        .unwrap();
        let health = process
            .observability
            .as_ref()
            .unwrap()
            .health
            .as_ref()
            .unwrap();
        assert_eq!(health.ip, "127.0.0.1");
        assert_eq!(health.port, 7601);
        assert_eq!(health.stale_after_ms, 15_000);
        let serialized = serde_json::to_value(&process).unwrap();
        assert!(serialized["observability"].get("latency").is_none());

        let valid = RuntimeConfig {
            process: process.clone(),
            scenes: vec![scene("map", 7100)],
            known_scenes: vec![],
        };
        assert!(validate_runtime_config(&valid).is_ok());

        let conflict = RuntimeConfig {
            process,
            scenes: vec![scene("map", 7601)],
            known_scenes: vec![],
        };
        assert!(validate_runtime_config(&conflict).is_err());
    }

    #[test]
    fn parses_game_update_overrides_and_defaults() {
        let overridden: ProcessConfig = serde_json::from_str(
            r#"{
                "name": "map1",
                "game": {
                    "fixedUpdateMs": 100,
                    "maxCatchUpSteps": 3
                },
                "lifecycle": {
                    "stopTimeoutMs": 30000,
                    "hotfixReloadTimeoutMs": 45000
                }
            }"#,
        )
        .unwrap();
        assert_eq!(overridden.game.fixed_update_ms, 100);
        assert_eq!(overridden.game.max_catch_up_steps, 3);
        assert_eq!(overridden.lifecycle.stop_timeout_ms, 30_000);
        assert_eq!(overridden.lifecycle.hotfix_reload_timeout_ms, 45_000);

        let defaults: ProcessConfig = serde_json::from_str(r#"{ "name": "map2" }"#).unwrap();
        assert_eq!(defaults.game.fixed_update_ms, 50);
        assert_eq!(defaults.game.max_catch_up_steps, 2);
        assert_eq!(defaults.lifecycle.stop_timeout_ms, 10_000);
        assert_eq!(defaults.lifecycle.hotfix_reload_timeout_ms, 30_000);
    }

    #[test]
    fn preserves_application_specific_process_config() {
        let process: ProcessConfig = serde_json::from_str(
            r#"{
                "name": "map1",
                "nativeData": {
                    "debugScalarAccess": true,
                    "scalarAccessWarnThreshold": 2048
                }
            }"#,
        )
        .unwrap();
        let serialized = serde_json::to_value(process).unwrap();
        assert_eq!(serialized["nativeData"]["debugScalarAccess"], true);
        assert_eq!(serialized["nativeData"]["scalarAccessWarnThreshold"], 2048);
    }

    #[test]
    fn rejects_invalid_game_update_config() {
        let mut process = process(None);
        process.game.fixed_update_ms = 0;
        let config = RuntimeConfig {
            process,
            scenes: vec![scene("map", 7100)],
            known_scenes: vec![],
        };
        assert!(validate_runtime_config(&config).is_err());
    }

    #[test]
    fn rejects_invalid_process_identity() {
        let mut zero_origin = process(None);
        zero_origin.identity.origin_server_id = 0;
        let config = RuntimeConfig {
            process: zero_origin,
            scenes: vec![scene("map", 7100)],
            known_scenes: vec![],
        };
        assert!(validate_runtime_config(&config).is_err());

        let mut high_worker = process(None);
        high_worker.identity.worker_id = 128;
        let config = RuntimeConfig {
            process: high_worker,
            scenes: vec![scene("map", 7100)],
            known_scenes: vec![],
        };
        assert!(validate_runtime_config(&config).is_err());
    }

    #[test]
    fn rejects_invalid_stop_timeout() {
        let mut process = process(None);
        process.lifecycle.stop_timeout_ms = 99;
        let config = RuntimeConfig {
            process,
            scenes: vec![scene("map", 7100)],
            known_scenes: vec![],
        };
        assert!(validate_runtime_config(&config).is_err());
    }

    #[test]
    fn rejects_invalid_hotfix_reload_timeout() {
        let mut process = process(None);
        process.lifecycle.hotfix_reload_timeout_ms = 99;
        let config = RuntimeConfig {
            process,
            scenes: vec![scene("map", 7100)],
            known_scenes: vec![],
        };
        assert!(validate_runtime_config(&config).is_err());
    }

    #[test]
    fn rejects_remote_inspector_without_explicit_opt_in() {
        let mut process = process(Some(9231));
        process.debug.as_mut().unwrap().inspector_ip = "0.0.0.0".to_string();
        let config = RuntimeConfig {
            process,
            scenes: vec![scene("log", 7100)],
            known_scenes: vec![],
        };
        assert!(validate_runtime_config(&config).is_err());
    }
}
