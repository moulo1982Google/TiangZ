//! 选择 Watcher 或单进程模式，并将已校验配置接入运行时。 / Selects Watcher or single-process mode and wires validated configuration into the runtime.

use std::env;
use std::path::{Path, PathBuf};

use anyhow::Result;

use crate::config::{is_start_machine_path, load_runtime_config, resolve_startup_path};
use crate::process::run_runtime_config;
use crate::watcher::run_start_machine;

mod allocator;
mod aoi;
mod config;
mod dbproxy;
mod game;
mod game_config;
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
    let startup_path =
        first_arg.unwrap_or_else(|| "configs/local/cluster/StartMachine.json".to_string());
    let root = resolve_runtime_root();
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

/// 解析运行时资源根目录，避免把构建机路径带入发布包。
///
/// 优先使用当前工作目录，因为正式部署会把它设置为包含 `dist/` 和
/// `configs/` 的发布目录；其次从可执行文件向上查找，兼容本地直接运行
/// `target/debug` 或 `target/release` 的场景。编译期目录只作为开发环境的
/// 最后兜底，不能作为发布包的正常路径来源。
///
/// Resolves the runtime asset root without leaking the build-machine path into
/// release artifacts. The current directory is preferred for deployed bundles,
/// then executable ancestors are searched for local Cargo layouts. The compile
/// time directory is only a final development fallback.
fn resolve_runtime_root() -> PathBuf {
    if let Ok(current_dir) = env::current_dir()
        && looks_like_runtime_root(&current_dir)
    {
        return current_dir;
    }

    if let Ok(executable) = env::current_exe() {
        let mut candidate = executable.parent().map(Path::to_path_buf);
        while let Some(path) = candidate {
            if looks_like_runtime_root(&path) {
                return path;
            }
            candidate = path.parent().map(Path::to_path_buf);
        }
    }

    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn looks_like_runtime_root(path: &Path) -> bool {
    path.join("dist").is_dir() && path.join("configs").is_dir()
}
