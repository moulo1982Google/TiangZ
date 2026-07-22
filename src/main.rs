use std::env;
use std::path::PathBuf;

use anyhow::Result;

use crate::config::{is_start_machine_path, load_runtime_config, resolve_startup_path};
use crate::process::run_runtime_config;
use crate::watcher::run_start_machine;

mod allocator;
mod config;
mod generated;
mod host;
mod inspector;
mod native_data;
mod process;
mod transport;
mod transport_backend;
mod watcher;

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    let startup_path = env::args()
        .nth(1)
        .unwrap_or_else(|| "configs/local/StartMachine.json".to_string());
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let resolved_config = resolve_startup_path(&root, startup_path);
    if is_start_machine_path(&resolved_config) {
        run_start_machine(&root, resolved_config).await?;
        return Ok(());
    }

    let config = load_runtime_config(&resolved_config)?;
    run_runtime_config(&root, &resolved_config, config).await
}
