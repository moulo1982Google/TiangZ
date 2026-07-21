use std::collections::HashSet;
use std::net::IpAddr;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

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
    pub game: ProcessGameConfig,
    #[serde(default)]
    pub scheduling: ProcessSchedulingConfig,
    #[serde(default)]
    pub debug: Option<ProcessDebugConfig>,
    #[serde(default)]
    pub observability: Option<ProcessObservabilityConfig>,
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
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessObservabilityConfig {
    #[serde(default)]
    pub latency: Option<LatencyObservabilityConfig>,
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

fn default_latency_sample_rate() -> u32 {
    1
}

fn default_fixed_update_ms() -> u64 {
    // 默认 20Hz 游戏逻辑帧；网络事件仍会即时唤醒 Runtime Pump。
    50
}

fn default_max_catch_up_steps() -> usize {
    2
}

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

pub fn is_start_machine_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("StartMachine.json"))
}

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
    if let Some(latency) = config
        .process
        .observability
        .as_ref()
        .and_then(|observability| observability.latency.as_ref())
    {
        if latency.sample_rate == 0 {
            bail!("process observability.latency.sampleRate must not be 0");
        }
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
    }

    let Some(debug) = &config.process.debug else {
        return Ok(());
    };
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
        }
    }

    fn process(inspector_port: Option<u16>) -> ProcessConfig {
        ProcessConfig {
            name: "test".to_string(),
            game: ProcessGameConfig::default(),
            scheduling: ProcessSchedulingConfig::default(),
            debug: inspector_port.map(|inspector_port| ProcessDebugConfig {
                inspector_ip: default_inspector_ip(),
                inspector_port,
                break_on_start: false,
                allow_remote: false,
            }),
            observability: None,
        }
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
                    "coalesceMicros": 500
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
    }

    #[test]
    fn parses_game_update_overrides_and_defaults() {
        let overridden: ProcessConfig = serde_json::from_str(
            r#"{
                "name": "map1",
                "game": {
                    "fixedUpdateMs": 100,
                    "maxCatchUpSteps": 3
                }
            }"#,
        )
        .unwrap();
        assert_eq!(overridden.game.fixed_update_ms, 100);
        assert_eq!(overridden.game.max_catch_up_steps, 3);

        let defaults: ProcessConfig = serde_json::from_str(r#"{ "name": "map2" }"#).unwrap();
        assert_eq!(defaults.game.fixed_update_ms, 50);
        assert_eq!(defaults.game.max_catch_up_steps, 2);
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
