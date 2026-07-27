//! 选择 Watcher 或单进程模式，并将已校验配置接入运行时。 / Selects Watcher or single-process mode and wires validated configuration into the runtime.

use std::env;
use std::path::PathBuf;

use anyhow::Result;

use crate::config::{is_start_machine_path, load_runtime_config, resolve_startup_path};
use crate::process::run_runtime_config;
use crate::watcher::run_start_machine;

mod allocator;
mod config;
mod generated;
mod health;
mod host;
mod hotfix;
mod inspector;
mod logging;
mod native_data;
mod process;
mod shutdown;
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
    let startup_path = first_arg.unwrap_or_else(|| "configs/local/StartMachine.json".to_string());
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let resolved_config = resolve_startup_path(&root, startup_path);
    if is_start_machine_path(&resolved_config) {
        let _logging = logging::init(
            &root,
            "watcher",
            &crate::config::ProcessLoggingConfig::default(),
        )?;
        run_start_machine(&root, resolved_config).await?;
        return Ok(());
    }

    let config = load_runtime_config(&resolved_config)?;
    let _logging = logging::init(&root, &config.process.name, &config.process.logging)?;
    run_runtime_config(&root, &resolved_config, config).await
}
