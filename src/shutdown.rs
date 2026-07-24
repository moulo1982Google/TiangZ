//! 提供 Watcher 监管使用的跨平台父进程到子进程停机控制。 / Shares the cross-platform parent-to-child shutdown control used by Watcher supervision.

use std::ffi::OsStr;
use std::io::BufRead;

use anyhow::{Context, Result};

/// 等待父 Watcher 安装的私有 stdin 停机管道。
///
/// 直接启动不会设置 `TIANGZ_WATCHER_CONTROL`，因此该 Future 会保持 pending，
/// 终端信号继续拥有控制权。受监管进程把一行消息和 EOF 都视为停机请求：
/// EOF 表示父进程已经消失，继续运行会产生无人管理的进程。
/// 启用此模式时，进程宿主以外的代码不得消费 stdin。
///
/// Waits for the private stdin shutdown pipe installed by a parent Watcher.
///
/// Direct launches do not set `TIANGZ_WATCHER_CONTROL`, so this future remains
/// pending and terminal signals retain control. A supervised process treats
/// both a line and EOF as a shutdown request: EOF means its parent disappeared,
/// and continuing would leave an unmanaged runtime. Code outside the process
/// host must never consume stdin while this mode is enabled.
pub async fn wait_for_parent_control() -> Result<()> {
    if std::env::var_os("TIANGZ_WATCHER_CONTROL").as_deref() != Some(OsStr::new("stdin")) {
        std::future::pending::<()>().await;
        return Ok(());
    }

    let (sender, receiver) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let result = std::io::stdin().lock().read_line(&mut line).map(|_| ());
        let _ = sender.send(result);
    });
    receiver
        .await
        .context("parent shutdown pipe task stopped")?
        .context("failed to read parent shutdown pipe")
}
