//! 启动资源目录选择，显式路径错误时禁止回退其他工程。 / Runtime asset selection; an invalid explicit path never falls back to another project.

use std::env;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

/// 解析配置与可选资源目录，不改变无参数启动入口。 / Parses config and optional asset root while preserving the default startup entry.
pub fn startup_options(
    arguments: impl IntoIterator<Item = String>,
) -> Result<(String, Option<PathBuf>)> {
    let mut config = None;
    let mut root = None;
    for argument in arguments {
        if let Some(value) = argument.strip_prefix("--runtime-root=") {
            if value.is_empty() || root.is_some() {
                bail!("--runtime-root requires one nonempty path and may only be specified once");
            }
            root = Some(PathBuf::from(value));
        } else if argument.starts_with('-') || config.is_some() {
            bail!(
                "unexpected startup argument: {argument}; use [config.json] [--runtime-root=path]"
            );
        } else {
            config = Some(argument);
        }
    }
    Ok((
        config.unwrap_or_else(|| "configs/local/cluster/StartMachine.json".to_owned()),
        root,
    ))
}

/// 显式路径优先且失败即拒绝；未指定时保留工作目录、可执行文件祖先和开发兜底顺序。
/// Explicit roots fail closed; otherwise retain current directory, executable ancestors and development fallback.
pub fn resolve_runtime_root(explicit: Option<&Path>) -> Result<PathBuf> {
    if let Some(path) = explicit {
        if !looks_like_runtime_root(path) {
            bail!(
                "explicit runtime root must contain dist/ and configs/: {}",
                path.display()
            );
        }
        return std::path::absolute(path).context("failed to resolve explicit runtime root");
    }
    if let Ok(current_dir) = env::current_dir()
        && looks_like_runtime_root(&current_dir)
    {
        return Ok(current_dir);
    }
    if let Ok(executable) = env::current_exe() {
        let mut candidate = executable.parent().map(Path::to_path_buf);
        while let Some(path) = candidate {
            if looks_like_runtime_root(&path) {
                return Ok(path);
            }
            candidate = path.parent().map(Path::to_path_buf);
        }
    }
    Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

fn looks_like_runtime_root(path: &Path) -> bool {
    path.join("dist").is_dir() && path.join("configs").is_dir()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_and_explicit_startup_arguments() {
        assert_eq!(
            startup_options([]).unwrap().0,
            "configs/local/cluster/StartMachine.json"
        );
        let (config, root) = startup_options([
            "--runtime-root=game release".to_owned(),
            "configs/run.json".to_owned(),
        ])
        .unwrap();
        assert_eq!(config, "configs/run.json");
        assert_eq!(root.unwrap(), PathBuf::from("game release"));
        for args in [
            vec!["--runtime-root="],
            vec!["a.json", "b.json"],
            vec!["--runtime-root=a", "--runtime-root=b"],
            vec!["--runtime-rooot=a"],
        ] {
            assert!(startup_options(args.into_iter().map(str::to_owned)).is_err());
        }
    }

    #[test]
    fn explicit_root_never_falls_back_to_the_build_workspace() {
        let dir = tempfile::tempdir().unwrap();
        assert!(resolve_runtime_root(Some(dir.path())).is_err());
        std::fs::create_dir(dir.path().join("dist")).unwrap();
        assert!(resolve_runtime_root(Some(dir.path())).is_err());
        std::fs::create_dir(dir.path().join("configs")).unwrap();
        assert_eq!(
            resolve_runtime_root(Some(dir.path())).unwrap(),
            std::path::absolute(dir.path()).unwrap()
        );
        std::fs::remove_dir(dir.path().join("configs")).unwrap();
        std::fs::write(dir.path().join("configs"), "not a directory").unwrap();
        assert!(resolve_runtime_root(Some(dir.path())).is_err());
    }
}
