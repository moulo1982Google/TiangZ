//! 提供 Watcher 与 Process 共用的跨平台父子控制协议。 / Shares the cross-platform parent-child control protocol used by Watcher and Process.

use std::ffi::OsStr;
use std::io::BufRead;
use std::path::PathBuf;

use anyhow::{Result, bail};
use tokio::sync::mpsc;

/// 父进程可以要求子进程优雅停机，或从一个不可变候选目录在线加载 Hotfix。
///
/// A parent can request graceful shutdown or an online Hotfix reload from an immutable candidate
/// directory. This protocol is intentionally line based so Watcher, tests, and shell tooling use
/// the same cross-platform transport without opening another administrative port.
#[derive(Debug, Clone, Eq, PartialEq)]
pub(crate) enum ParentControlCommand {
    Shutdown,
    Reload(PathBuf),
    ReloadConfig(PathBuf),
}

pub(crate) type ParentControlMessage = std::result::Result<ParentControlCommand, String>;

/// 当 `TIANGZ_WATCHER_CONTROL=stdin` 时启动唯一的阻塞读取线程。
///
/// EOF 等价于 `shutdown`，因为受监管子进程失去父进程后不可继续成为孤儿。调用方必须只
/// 创建一个 Receiver；其他代码不得再读取 stdin。
///
/// Starts the single blocking reader thread when `TIANGZ_WATCHER_CONTROL=stdin`. EOF is treated as
/// shutdown because a supervised child must not outlive its parent. The caller must create only one
/// receiver, and no other code may consume stdin afterwards.
pub(crate) fn spawn_parent_control_receiver()
-> Option<mpsc::UnboundedReceiver<ParentControlMessage>> {
    if std::env::var_os("TIANGZ_WATCHER_CONTROL").as_deref() != Some(OsStr::new("stdin")) {
        return None;
    }

    Some(spawn_stdin_control_receiver())
}

/// 为顶层 Watcher 启动运维 stdin；Watcher 自己不需要父进程环境变量。 / Starts operator stdin for a top-level Watcher, which does not require a parent-control environment variable.
pub(crate) fn spawn_stdin_control_receiver() -> mpsc::UnboundedReceiver<ParentControlMessage> {
    let (sender, receiver) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut lines = stdin.lock().lines();
        loop {
            match lines.next() {
                Some(Ok(line)) if line.trim().is_empty() => continue,
                Some(Ok(line)) => {
                    if sender.send(parse_parent_control(&line)).is_err() {
                        break;
                    }
                }
                Some(Err(error)) => {
                    let _ = sender.send(Err(format!("failed to read parent control: {error}")));
                    break;
                }
                None => {
                    let _ = sender.send(Ok(ParentControlCommand::Shutdown));
                    break;
                }
            }
        }
    });
    receiver
}

/// 等待下一条父进程命令；未启用私有 stdin 控制时永久 pending。
///
/// Waits for the next parent command and remains pending forever when private stdin control is not
/// enabled. Keeping this behavior lets direct terminal launches retain Ctrl+C ownership.
pub(crate) async fn receive_parent_control(
    receiver: &mut Option<mpsc::UnboundedReceiver<ParentControlMessage>>,
) -> Result<ParentControlCommand> {
    let Some(receiver) = receiver.as_mut() else {
        std::future::pending::<()>().await;
        unreachable!("pending parent control future returned")
    };
    match receiver.recv().await {
        Some(Ok(command)) => Ok(command),
        Some(Err(error)) => bail!(error),
        None => Ok(ParentControlCommand::Shutdown),
    }
}

fn parse_parent_control(line: &str) -> ParentControlMessage {
    let command = line.trim();
    if command.eq_ignore_ascii_case("shutdown") {
        return Ok(ParentControlCommand::Shutdown);
    }
    if let Some(path) = command.strip_prefix("reload ").map(str::trim)
        && !path.is_empty()
    {
        return Ok(ParentControlCommand::Reload(PathBuf::from(path)));
    }
    if let Some(path) = command.strip_prefix("reload-config ").map(str::trim)
        && !path.is_empty()
    {
        return Ok(ParentControlCommand::ReloadConfig(PathBuf::from(path)));
    }
    Err(format!(
        "unknown parent control command: {command}; expected shutdown, reload <candidate-directory>, or reload-config <candidate-directory>"
    ))
}

#[cfg(test)]
mod tests {
    use super::{ParentControlCommand, parse_parent_control};
    use std::path::PathBuf;

    #[test]
    fn parses_shutdown_and_reload_without_losing_spaces() {
        assert_eq!(
            parse_parent_control("shutdown\n").unwrap(),
            ParentControlCommand::Shutdown
        );
        assert_eq!(
            parse_parent_control("reload E:\\build output\\candidate v2\n").unwrap(),
            ParentControlCommand::Reload(PathBuf::from("E:\\build output\\candidate v2"))
        );
        assert_eq!(
            parse_parent_control("reload-config E:\\config output\\candidate v3\n").unwrap(),
            ParentControlCommand::ReloadConfig(PathBuf::from("E:\\config output\\candidate v3"))
        );
        assert!(parse_parent_control("reload").is_err());
    }
}
