//! 保存最近若干条已格式化日志的有界环形缓冲，供崩溃报告在异步日志丢尾时补齐现场。 / Bounded ring of recently formatted log events so crash reports keep the tail that asynchronous writers may lose.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::fmt::Write as _;
use std::sync::{Arc, Mutex, TryLockError};
use std::time::{Duration, SystemTime};

use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::Layer;
use tracing_subscriber::layer::Context;

use super::report::write_utc_timestamp;

/// 单行日志保存上限；超出部分截断，保证总内存不超过 行数 × 4 KiB 量级。 / Per-line cap; longer lines are truncated so memory stays near lines × 4 KiB.
pub(crate) const MAX_LINE_BYTES: usize = 4 * 1024;
/// 截断标记，与 DBProxy 一致。 / Truncation marker, identical to DBProxy.
pub(crate) const TRUNCATED_SUFFIX: &str = " …[truncated]";

thread_local! {
    /// 每线程复用的格式化缓冲，避免每条日志重新分配。 / Per-thread formatting scratch reused across events to avoid fresh allocations.
    static SCRATCH: RefCell<String> = RefCell::new(String::with_capacity(256));
}

/// 固定容量的最近日志缓冲；锁只覆盖入队，不覆盖格式化。
///
/// 格式化在线程本地缓冲中完成，因此字段的 `Debug` 实现即使再次打日志也不会在本锁上自锁。
///
/// Fixed-capacity recent-log buffer whose lock covers only the enqueue, not formatting.
///
/// Formatting happens in a thread-local scratch buffer, so a field `Debug` implementation that
/// logs again cannot self-deadlock on this lock.
pub(crate) struct RecentLogBuffer {
    capacity: usize,
    lines: Mutex<VecDeque<String>>,
}

impl RecentLogBuffer {
    /// 创建容量至少为 1 的缓冲；容量为 0 的配置不应创建缓冲。 / Creates a buffer with capacity at least one; a zero-line config should not create a buffer.
    pub(crate) fn new(capacity: usize) -> Arc<Self> {
        let capacity = capacity.max(1);
        Arc::new(Self {
            capacity,
            lines: Mutex::new(VecDeque::with_capacity(capacity)),
        })
    }

    /// 返回固定容量。 / Returns the fixed capacity.
    pub(crate) fn capacity(&self) -> usize {
        self.capacity
    }

    /// 追加一行；满时复用最旧行的分配。锁中毒时继续使用内部数据。 / Appends one line, recycling the oldest allocation when full; a poisoned lock keeps using the data.
    pub(crate) fn push(&self, line: &str) {
        let mut lines = match self.lines.lock() {
            Ok(lines) => lines,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut slot = if lines.len() >= self.capacity {
            lines.pop_front().unwrap_or_default()
        } else {
            String::with_capacity(line.len())
        };
        slot.clear();
        slot.push_str(line);
        lines.push_back(slot);
    }

    /// 在崩溃路径读取全部行；最多等待约 50ms，拿不到锁返回 None 而不是阻塞崩溃处理。
    ///
    /// Reads every line on a crash path; waits about 50ms at most and returns None instead of
    /// blocking crash handling when the lock stays busy.
    pub(crate) fn with_lines<R>(&self, read: impl FnOnce(&VecDeque<String>) -> R) -> Option<R> {
        for attempt in 0..100 {
            match self.lines.try_lock() {
                Ok(lines) => return Some(read(&lines)),
                Err(TryLockError::Poisoned(poisoned)) => return Some(read(&poisoned.into_inner())),
                Err(TryLockError::WouldBlock) if attempt < 50 => std::thread::yield_now(),
                Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(1)),
            }
        }
        None
    }
}

/// 把每条已通过过滤的事件格式化后存入 [`RecentLogBuffer`] 的 tracing Layer。 / Tracing layer that stores every event that passed filtering into a [`RecentLogBuffer`].
pub(crate) struct RecentLogLayer {
    buffer: Arc<RecentLogBuffer>,
}

impl RecentLogLayer {
    /// 绑定共享缓冲；崩溃报告读取同一个缓冲。 / Binds the shared buffer that crash reports read.
    pub(crate) fn new(buffer: Arc<RecentLogBuffer>) -> Self {
        Self { buffer }
    }
}

impl<S: Subscriber> Layer<S> for RecentLogLayer {
    fn on_event(&self, event: &Event<'_>, _context: Context<'_, S>) {
        // 线程退出阶段或同线程重入时直接跳过，日志环形缓冲不能影响业务线程。
        // Skip during thread teardown or same-thread re-entry; the ring must never disturb callers.
        let _ = SCRATCH.try_with(|scratch| {
            let Ok(mut line) = scratch.try_borrow_mut() else {
                return;
            };
            line.clear();
            format_event(&mut line, event, SystemTime::now());
            self.buffer.push(&line);
            if line.capacity() > 2 * MAX_LINE_BYTES {
                line.shrink_to(MAX_LINE_BYTES);
            }
        });
    }
}

/// 生成 `时间 级别 target: 消息 字段=值` 单行文本，并按字符边界截断。 / Formats `time LEVEL target: message field=value` on one line, truncated at a char boundary.
pub(crate) fn format_event(line: &mut String, event: &Event<'_>, now: SystemTime) {
    let metadata = event.metadata();
    write_utc_timestamp(line, now);
    let _ = write!(line, " {:>5} {}: ", metadata.level(), metadata.target());
    event.record(&mut LineVisitor { line });
    truncate_line(line);
}

/// 截断超长行并追加省略标记；不在多字节字符中间切断。 / Truncates over-long lines with a marker, never splitting a multi-byte character.
pub(crate) fn truncate_line(line: &mut String) {
    if line.len() <= MAX_LINE_BYTES {
        return;
    }
    let mut end = MAX_LINE_BYTES - TRUNCATED_SUFFIX.len();
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    line.truncate(end);
    line.push_str(TRUNCATED_SUFFIX);
}

struct LineVisitor<'a> {
    line: &'a mut String,
}

impl Visit for LineVisitor<'_> {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.line.push_str(value);
        } else {
            let _ = write!(self.line, " {}={}", field.name(), value);
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self.line, "{value:?}");
        } else {
            let _ = write!(self.line, " {}={value:?}", field.name());
        }
        // 避免超大字段在截断前把线程本地缓冲撑得过大。 / Stop huge fields from bloating the scratch before truncation.
        if self.line.len() > 4 * MAX_LINE_BYTES {
            truncate_line(self.line);
        }
    }
}
