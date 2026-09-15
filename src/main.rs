//! 选择 Watcher 或单进程模式，并将已校验配置接入运行时。 / Selects Watcher or single-process mode and wires validated configuration into the runtime.

use std::env;

use anyhow::Result;

use crate::config::{is_start_machine_path, load_runtime_config, resolve_startup_path};
use crate::process::run_runtime_config;
use crate::runtime_paths::{resolve_runtime_root, startup_options};
use crate::watcher::run_start_machine;

mod allocator;
mod aoi;
mod config;
mod data_pack;
mod dbproxy;
mod event_stream;
mod game;
mod game_config;
mod generated;
mod health;
mod host;
mod hotfix;
mod inspector;
mod logging;
mod native_data;
mod module_native {
    include!(concat!(env!("OUT_DIR"), "/module_native.rs"));
}
mod process;
mod runtime_paths;
mod shutdown;
mod telemetry;
mod transport;
mod transport_backend;
mod version;
mod watcher;

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    let first_arg = env::args().nth(1);
    if matches!(first_arg.as_deref(), Some("--version" | "-V")) {
        println!("{}", version::display());
        return Ok(());
    }
    let (startup_path, explicit_root) = startup_options(env::args().skip(1))?;
    let root = resolve_runtime_root(explicit_root.as_deref())?;
    let resolved_config = resolve_startup_path(&root, startup_path);
    if is_start_machine_path(&resolved_config) {
        let _logging = logging::init(
            &root,
            "watcher",
            &crate::config::ProcessLoggingConfig::default(),
        )?;
        tracing::info!(target: "tiangz::runtime", runtime_root = %root.display(), "resolved runtime assets");
        run_start_machine(&root, resolved_config).await?;
        return Ok(());
    }

    let config = load_runtime_config(&resolved_config)?;
    let _logging = logging::init(&root, &config.process.name, &config.process.logging)?;
    tracing::info!(target: "tiangz::runtime", runtime_root = %root.display(), "resolved runtime assets");
    let _telemetry = telemetry::init(
        &config.process.name,
        config
            .process
            .observability
            .as_ref()
            .and_then(|observability| observability.tracing.as_ref()),
    )?;
    run_runtime_config(&root, &resolved_config, config).await
}
