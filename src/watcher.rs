//! 启动分配给本机的进程，并监管其有界优雅停机。 / Starts machine-assigned processes and supervises their bounded graceful shutdown.

use std::collections::HashSet;
use std::env;
use std::io::Write;
use std::net::UdpSocket;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};

use crate::config::{StartMachineConfig, load_runtime_config};

struct ManagedChild {
    name: String,
    child: Child,
    control: Option<ChildStdin>,
    stop_timeout: Duration,
}

/// 启动分配给本机的全部进程，并监管优雅停机。
///
/// Windows 与 Unix 子进程都通过私有 stdin 管道接收停机通知。
/// Watcher 会先通知全部子进程，再按各自宽限时间等待；超时后才强制终止。
///
/// Starts every process assigned to the local machine and supervises graceful shutdown.
///
/// A private stdin pipe carries shutdown to children on both Windows and Unix.
/// All children are notified before waiting begins; each receives its own
/// configured grace period, after which force termination is the final fallback.
pub async fn run_start_machine(root: &Path, start_machine_path: PathBuf) -> Result<()> {
    let config_text = std::fs::read_to_string(&start_machine_path)
        .with_context(|| format!("failed to read {}", start_machine_path.display()))?;
    let start_machine: StartMachineConfig = serde_json::from_str(&config_text)
        .with_context(|| format!("failed to parse {}", start_machine_path.display()))?;

    let local_ips = get_local_ips();
    tracing::info!(target: "tiangz::watcher",
        "start machine from {}, local ips: {}",
        start_machine_path.display(),
        local_ips.iter().cloned().collect::<Vec<_>>().join(", ")
    );

    let start_dir = start_machine_path
        .parent()
        .context("StartMachine.json has no parent directory")?;
    let mut processes = Vec::<PathBuf>::new();
    for machine in &start_machine.machines {
        if !is_this_machine(&machine.inner_ip, &local_ips) {
            continue;
        }

        tracing::info!(target: "tiangz::watcher",
            "matched machine {} ({})",
            machine.name.as_deref().unwrap_or("<unnamed>"),
            machine.inner_ip
        );
        for process in &machine.processes {
            let path = PathBuf::from(process);
            let resolved = if path.is_absolute() {
                path
            } else {
                start_dir.join(path)
            };
            processes.push(resolved);
        }
    }

    if processes.is_empty() {
        bail!(
            "not found this machine ip config in {}; local ips: {}",
            start_machine_path.display(),
            local_ips.iter().cloned().collect::<Vec<_>>().join(", ")
        );
    }

    let exe = env::current_exe().context("failed to get current executable")?;
    let mut children = Vec::<ManagedChild>::new();
    for process_config in processes {
        let arg = to_process_arg(root, &process_config);
        let process_config = load_runtime_config(&process_config)
            .with_context(|| format!("failed to load child config {}", process_config.display()))?;
        tracing::info!(target: "tiangz::watcher", config = %arg.display(), "starting process config");
        let mut child = Command::new(&exe)
            .arg(&arg)
            .current_dir(root)
            .env("TIANGZ_WATCHER_CONTROL", "stdin")
            .stdin(Stdio::piped())
            .spawn()
            .with_context(|| format!("failed to start {}", arg.display()))?;
        children.push(ManagedChild {
            name: process_config.process.name,
            control: child.stdin.take(),
            child,
            stop_timeout: Duration::from_millis(process_config.process.lifecycle.stop_timeout_ms),
        });
    }

    wait_for_shutdown_signal().await?;
    tracing::info!(target: "tiangz::watcher", child_count = children.len(), "stopping child processes");
    for child in &mut children {
        request_graceful_shutdown(child);
    }
    for child in &mut children {
        wait_for_child_shutdown(child).await?;
    }
    Ok(())
}

/// 发送 Watcher 控制消息后立即关闭管道。
///
/// 在等待任何子进程前先通知全部子进程，避免某个慢速 Repository 保存
/// 消耗其他进程的宽限时间。写入失败通常表示子进程已退出，因此这里不直接判失败；
/// 最终结果由 `wait_for_child_shutdown` 判定。
///
/// Sends the Watcher control message and closes the pipe immediately after it.
///
/// All children are notified before any child is awaited, so one process with a
/// slow repository save cannot consume another process's grace period. Failure
/// to write is not fatal here because it commonly means the child already
/// exited; `wait_for_child_shutdown` determines the authoritative result.
fn request_graceful_shutdown(child: &mut ManagedChild) {
    if let Some(mut control) = child.control.take()
        && let Err(error) = control.write_all(b"shutdown\n")
    {
        tracing::warn!(target: "tiangz::watcher", process = %child.name, %error, "failed to write child shutdown control");
    }
}

/// 等待一个子进程完成 TS 生命周期，仅在超时时强制终止。 / Waits for one child to finish its TS lifecycle and force-kills only on timeout.
async fn wait_for_child_shutdown(child: &mut ManagedChild) -> Result<()> {
    let deadline = Instant::now() + child.stop_timeout;
    loop {
        if let Some(status) = child
            .child
            .try_wait()
            .with_context(|| format!("failed to query child process {}", child.name))?
        {
            tracing::info!(target: "tiangz::watcher", process = %child.name, %status, "child process stopped");
            if !status.success() {
                bail!(
                    "child process {} stopped unsuccessfully: {status}",
                    child.name
                );
            }
            return Ok(());
        }
        if Instant::now() >= deadline {
            tracing::error!(target: "tiangz::watcher", process = %child.name, timeout_ms = child.stop_timeout.as_millis(), "child graceful shutdown timed out; forcing termination");
            child
                .child
                .kill()
                .with_context(|| format!("failed to force-stop child process {}", child.name))?;
            child
                .child
                .wait()
                .with_context(|| format!("failed to reap child process {}", child.name))?;
            bail!(
                "child process {} exceeded graceful shutdown timeout of {}ms",
                child.name,
                child.stop_timeout.as_millis()
            );
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// 接收与直接启动进程相同的运维停机信号。 / Accepts the same operator shutdown signals as a directly launched process.
async fn wait_for_shutdown_signal() -> Result<()> {
    #[cfg(windows)]
    {
        let mut ctrl_break =
            tokio::signal::windows::ctrl_break().context("failed to install CTRL_BREAK handler")?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result?,
            _ = ctrl_break.recv() => {},
            result = crate::shutdown::wait_for_parent_control() => result?,
        }
    }
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .context("failed to install SIGTERM handler")?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result?,
            _ = terminate.recv() => {},
            result = crate::shutdown::wait_for_parent_control() => result?,
        }
    }
    Ok(())
}

fn to_process_arg(root: &Path, path: &Path) -> PathBuf {
    path.strip_prefix(root).unwrap_or(path).to_path_buf()
}

fn is_this_machine(ip: &str, local_ips: &HashSet<String>) -> bool {
    ip == "127.0.0.1" || ip == "0.0.0.0" || local_ips.contains(ip)
}

fn get_local_ips() -> HashSet<String> {
    let mut ips = HashSet::new();
    ips.insert("127.0.0.1".to_string());

    if let Ok(value) = env::var("ETS_MACHINE_IP") {
        for item in value.split([',', ';', ' ']) {
            add_ip_token(&mut ips, item);
        }
    }

    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0")
        && socket.connect("8.8.8.8:80").is_ok()
        && let Ok(addr) = socket.local_addr()
    {
        ips.insert(addr.ip().to_string());
    }

    collect_command_ips(&mut ips, "hostname", &["-I"]);
    if cfg!(windows) {
        collect_command_ips(&mut ips, "ipconfig", &[]);
    } else {
        collect_command_ips(&mut ips, "ip", &["-o", "-4", "addr", "show"]);
    }

    ips
}

fn collect_command_ips(ips: &mut HashSet<String>, program: &str, args: &[&str]) {
    let Ok(output) = Command::new(program).args(args).output() else {
        return;
    };
    let text = String::from_utf8_lossy(&output.stdout);
    for token in text.split_whitespace() {
        add_ip_token(ips, token);
    }
}

fn add_ip_token(ips: &mut HashSet<String>, token: &str) {
    let token = token
        .trim_matches(|ch: char| !ch.is_ascii_hexdigit() && ch != '.' && ch != ':')
        .split('/')
        .next()
        .unwrap_or("");
    if token.parse::<std::net::IpAddr>().is_ok() {
        ips.insert(token.to_string());
    }
}
