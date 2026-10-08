//! 异步结果唤醒：宿主线程交出 V8 异步 op 的结果后，让空闲的 Process 主循环立即推进一轮 JS。
//! Async-result wakeups: after a host thread hands off a V8 async op result, the idle Process loop pumps JS immediately.
//!
//! deno_core 在一个 tokio 本地任务里推进在途异步 op，结果完成只唤醒该任务；主循环空闲时停在事件队列等待，
//! 不会运行该任务，因此结果要等下一个 idle tick 才交付。这里复用主循环已有的容量为 1 的唤醒通道（与网络帧、
//! 跨进程 RPC 完成相同），另加一个“有异步结果待交付”标志，让主循环在队列为空时也结束等待。
//! 唤醒不执行 JS，也不跨线程访问 V8；JS 仍只在 V8 线程按原顺序运行。
//!
//! deno_core drives in-flight async ops inside a tokio local task, so a finished result only wakes that task;
//! an idle Process loop waits on its event queue and never runs it, delaying delivery until the next idle tick.
//! This reuses the loop's capacity-1 wake channel (shared with network frames and inner RPC completions) plus an
//! "async result pending" flag so the loop stops waiting even when its queues are empty. Waking never runs JS or
//! touches V8 from another thread; JS still runs only on the V8 thread in its original order.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock, mpsc};

/// 一个 Process 主循环的异步结果信号。 / The async-result signal of one Process loop.
pub(crate) struct AsyncResultSignal {
    ready: AtomicBool,
    wake: mpsc::SyncSender<()>,
}

impl AsyncResultSignal {
    /// 绑定主循环的唤醒通道；通道容量为 1，多次通知自然合并。 / Binds the loop wake channel; its capacity of 1 coalesces notifications.
    pub(crate) fn new(wake: mpsc::SyncSender<()>) -> Arc<Self> {
        Arc::new(Self {
            ready: AtomicBool::new(false),
            wake,
        })
    }

    /// 结果已可取后调用：先置标志再唤醒，保证主循环醒来时能看到标志；可从任意线程调用，不阻塞。
    /// Call after the result is observable: set the flag before waking so the loop sees it; callable from any thread, never blocks.
    pub(crate) fn notify(&self) {
        self.ready.store(true, Ordering::Release);
        let _ = self.wake.try_send(());
    }

    /// 主循环取走待交付标志；返回 true 表示应立即推进一轮 JS。 / The loop takes the pending flag; true means pump JS now.
    pub(crate) fn take(&self) -> bool {
        self.ready.swap(false, Ordering::AcqRel)
    }
}

static CURRENT: RwLock<Option<Arc<AsyncResultSignal>>> = RwLock::new(None);

/// 安装当前 Process 的信号；一个操作系统进程只运行一个 Process 主循环。
/// Installs the current Process signal; one OS process runs a single Process loop.
pub(crate) fn install(signal: Arc<AsyncResultSignal>) {
    *CURRENT.write().unwrap_or_else(|error| error.into_inner()) = Some(signal);
}

/// 通知当前 Process 有异步结果可交付；未安装时（预检、单元测试）什么也不做。
/// Notifies the current Process that an async result is ready; a no-op when none is installed (preflight, unit tests).
pub(crate) fn notify_async_result() {
    if let Some(signal) = CURRENT
        .read()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
    {
        signal.notify();
    }
}

/// 析构时通知异步结果；在宿主任务里先于结果发送端声明，任务正常结束或 panic 时都“先可取、后叫醒”。
/// Notifies on drop. Declare it before the result sender in a host task so both normal completion and panic make the
/// result observable before waking (locals drop in reverse declaration order).
pub(crate) struct NotifyOnDrop;

impl Drop for NotifyOnDrop {
    fn drop(&mut self) {
        notify_async_result();
    }
}

/// 测试专用：串行化安装全局信号的测试，并返回新信号及其唤醒接收端。
/// Test only: serializes tests that install the global signal and returns a fresh signal with its wake receiver.
#[cfg(test)]
pub(crate) fn install_for_test() -> (
    std::sync::MutexGuard<'static, ()>,
    Arc<AsyncResultSignal>,
    mpsc::Receiver<()>,
) {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let guard = LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let (sender, receiver) = mpsc::sync_channel(1);
    let signal = AsyncResultSignal::new(sender);
    install(Arc::clone(&signal));
    (guard, signal, receiver)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notify_sets_flag_before_waking_and_coalesces() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let signal = AsyncResultSignal::new(sender);
        assert!(!signal.take());
        signal.notify();
        signal.notify();
        assert!(receiver.try_recv().is_ok());
        assert!(receiver.try_recv().is_err(), "wakes must coalesce");
        assert!(signal.take());
        assert!(!signal.take(), "the flag is consumed once");
    }
}
