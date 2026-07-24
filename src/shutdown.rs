//! Shares the cross-platform parent-to-child shutdown control used by Watcher supervision.

use std::ffi::OsStr;
use std::io::BufRead;

use anyhow::{Context, Result};

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
