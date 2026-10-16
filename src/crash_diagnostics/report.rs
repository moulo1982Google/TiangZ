//! 崩溃报告与退出记录的文件命名、格式（与 DBProxy 共用 format_version 1）、同步写入和保留上限。
//!
//! File naming, format (format_version 1 shared with DBProxy), synchronous writing and retention
//! for crash reports and child exit records.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::CrashSettings;
use super::exit_status::describe_exit_status;
use super::recent_logs::RecentLogBuffer;

/// 报告格式版本；键名或顺序变化时递增。 / Report format version; bump when keys or their order change.
pub(crate) const REPORT_FORMAT_VERSION: u32 = 1;

/// 写入 `YYYY-MM-DDTHH:MM:SS.mmmZ` 形式的 UTC 时间；不依赖外部时间库。 / Writes UTC as `YYYY-MM-DDTHH:MM:SS.mmmZ` without an external time crate.
pub(crate) fn write_utc_timestamp(out: &mut impl std::fmt::Write, time: SystemTime) {
    let (year, month, day, hour, minute, second, millis) = utc_parts(time);
    let _ = write!(
        out,
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z"
    );
}

/// 返回 ISO 8601 UTC 文本。 / Returns ISO 8601 UTC text.
pub(crate) fn iso8601(time: SystemTime) -> String {
    let mut text = String::with_capacity(24);
    write_utc_timestamp(&mut text, time);
    text
}

/// 返回 `YYYYMMDDTHHMMSS.mmmZ`，用于文件名排序与去重。 / Returns `YYYYMMDDTHHMMSS.mmmZ` for sortable, collision-resistant file names.
pub(crate) fn file_stamp(time: SystemTime) -> String {
    let (year, month, day, hour, minute, second, millis) = utc_parts(time);
    format!("{year:04}{month:02}{day:02}T{hour:02}{minute:02}{second:02}.{millis:03}Z")
}

fn utc_parts(time: SystemTime) -> (i64, u32, u32, u32, u32, u32, u32) {
    let since_epoch = time.duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO);
    let seconds = since_epoch.as_secs() as i64;
    let days = seconds.div_euclid(86_400);
    let second_of_day = seconds.rem_euclid(86_400) as u32;
    let (year, month, day) = civil_from_days(days);
    (
        year,
        month,
        day,
        second_of_day / 3_600,
        second_of_day % 3_600 / 60,
        second_of_day % 60,
        since_epoch.subsec_millis(),
    )
}

/// 把 1970-01-01 起的天数换算为公历日期（Howard Hinnant 算法）。 / Converts days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's algorithm).
pub(crate) fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_index + 2) / 5 + 1) as u32;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    } as u32;
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// 返回 `crash-<进程名>-<pid>-<UTC>` 文件名主干。 / Returns the `crash-<process>-<pid>-<UTC>` file stem.
pub(crate) fn file_stem(label: &str, pid: u32, time: SystemTime) -> String {
    format!("crash-{label}-{pid}-{}", file_stamp(time))
}

/// 以 `create_new` 创建不覆盖旧文件的诊断文件；同名存在时依次追加 `-2`…`-16`。 / Creates a diagnostics file with `create_new`, appending `-2`…`-16` when the name exists.
pub(crate) fn create_unique_file(
    directory: &Path,
    stem: &str,
    extension: &str,
) -> io::Result<(PathBuf, File)> {
    create_private_dir(directory)?;
    for attempt in 1..=16u32 {
        let name = if attempt == 1 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem}-{attempt}.{extension}")
        };
        let path = directory.join(name);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        match options.open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "too many crash files with the same timestamp",
    ))
}

/// 创建崩溃目录；Unix 上新建目录权限为 0o700，Windows 继承父目录 ACL。
///
/// 转储与报告可能含令牌、连接串和玩家数据，因此 Unix 上只允许属主访问；已存在的目录不改权限。
///
/// Creates the crash directory; on Unix new directories get 0o700, while Windows inherits the
/// parent ACL. Dumps and reports may contain tokens, connection strings and player data, so Unix
/// restricts them to the owner; existing directories keep their permissions.
pub(crate) fn create_private_dir(directory: &Path) -> io::Result<()> {
    if directory.is_dir() {
        return Ok(());
    }
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(directory)
}

/// 写一行 `键: 值`；值中的换行变成以两个空格开头的续行。 / Writes one `key: value` line; newlines in the value become continuation lines indented by two spaces.
pub(crate) fn write_field(out: &mut dyn Write, key: &str, value: &str) -> io::Result<()> {
    writeln!(out, "{key}: {}", value.trim_end().replace('\n', "\n  "))
}

/// 写入约定的报告头：`TiangZ crash report` 后接 format_version、process、version、pid、platform、time_utc、kind。
///
/// Writes the contract header: `TiangZ crash report` followed by format_version, process,
/// version, pid, platform, time_utc and kind.
pub(crate) fn write_report_header(
    out: &mut dyn Write,
    process_name: &str,
    kind: &str,
    pid: u32,
    now: SystemTime,
) -> io::Result<()> {
    writeln!(out, "TiangZ crash report")?;
    writeln!(out, "format_version: {REPORT_FORMAT_VERSION}")?;
    write_field(out, "process", process_name)?;
    writeln!(out, "version: {}", crate::version::current())?;
    writeln!(out, "pid: {pid}")?;
    writeln!(
        out,
        "platform: {}-{}",
        std::env::consts::OS,
        std::env::consts::ARCH
    )?;
    writeln!(out, "time_utc: {}", iso8601(now))?;
    writeln!(out, "kind: {kind}")
}

/// 写入报告末尾的最近日志段：空行加 `recent_logs: <行数> of <容量>`，或 disabled / unavailable。
///
/// Writes the trailing recent-log section: a blank line plus `recent_logs: <lines> of <capacity>`,
/// or disabled / unavailable.
pub(crate) fn write_recent_logs(
    out: &mut dyn Write,
    recent: Option<&RecentLogBuffer>,
) -> io::Result<()> {
    writeln!(out)?;
    let Some(recent) = recent else {
        return writeln!(out, "recent_logs: disabled (recentLogLines = 0)");
    };
    let result = recent.with_lines(|lines| -> io::Result<()> {
        writeln!(out, "recent_logs: {} of {}", lines.len(), recent.capacity())?;
        for line in lines {
            writeln!(out, "{line}")?;
        }
        Ok(())
    });
    match result {
        Some(result) => result,
        None => writeln!(out, "recent_logs: unavailable (buffer busy at crash time)"),
    }
}

/// 同步写入一份崩溃报告并执行保留清理；任何 I/O 失败都只打一行 stderr，绝不 panic。
///
/// `stem` 为 None 时按当前时间生成；原生异常传入与 `.dmp` 相同的主干。`details` 写入 kind 之后的键。
///
/// Synchronously writes one crash report and enforces retention; any I/O failure prints one stderr
/// line and never panics.
///
/// With `stem` None the current time is used; native exceptions pass the `.dmp` stem. `details`
/// writes the keys after `kind`.
pub(crate) fn write_crash_report(
    settings: &CrashSettings,
    recent: Option<&RecentLogBuffer>,
    kind: &str,
    stem: Option<String>,
    retention: Option<&RetentionCounter>,
    details: &mut dyn FnMut(&mut dyn Write) -> io::Result<()>,
) -> Option<PathBuf> {
    let now = SystemTime::now();
    let pid = std::process::id();
    let stem = stem.unwrap_or_else(|| file_stem(&settings.file_label, pid, now));
    let (path, file) = match create_unique_file(&settings.directory, &stem, "txt") {
        Ok(created) => created,
        Err(error) => {
            let _ = writeln!(
                io::stderr(),
                "[tiangz] could not write a crash report ({kind}) in {}: {error}",
                settings.directory.display()
            );
            return None;
        }
    };
    let mut out = io::BufWriter::new(file);
    let written = (|| {
        write_report_header(&mut out, &settings.process_name, kind, pid, now)?;
        details(&mut out)?;
        write_recent_logs(&mut out, recent)?;
        out.flush()?;
        out.get_ref().sync_all()
    })();
    after_write(settings, retention, FileClass::Report);
    let _ = match written {
        Ok(()) => writeln!(
            io::stderr(),
            "[tiangz] crash report ({kind}) written to {}",
            path.display()
        ),
        Err(error) => writeln!(
            io::stderr(),
            "[tiangz] crash report ({kind}) partially written to {}: {error}",
            path.display()
        ),
    };
    Some(path)
}

/// 写入 panic 报告主体：thread、message、location、suppressed_since_last（TiangZ 新增），空行后
/// `backtrace:` 与强制捕获的回溯。
///
/// Writes the panic body: thread, message, location, suppressed_since_last (a TiangZ addition),
/// then a blank line, `backtrace:` and a force-captured backtrace.
pub(crate) fn write_panic_details(
    out: &mut dyn Write,
    message: &str,
    location: Option<String>,
    suppressed_since_last: u64,
) -> io::Result<()> {
    let thread = std::thread::current();
    write_field(
        out,
        "thread",
        &format!(
            "{} ({:?})",
            thread.name().unwrap_or("<unnamed>"),
            thread.id()
        ),
    )?;
    write_field(out, "message", message)?;
    write_field(out, "location", location.as_deref().unwrap_or("unknown"))?;
    writeln!(out, "suppressed_since_last: {suppressed_since_last}")?;
    writeln!(out)?;
    writeln!(out, "backtrace:")?;
    let backtrace = std::backtrace::Backtrace::force_capture().to_string();
    writeln!(out, "{}", backtrace.trim_end())
}

/// 子进程退出后自动重启的判定结果，写入退出记录。 / Restart decision after a child exit, recorded in the exit record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RestartDecision {
    /// 已安排重启。 / A restart was scheduled.
    Scheduled { policy: String, delay_ms: u128 },
    /// 未配置重启，整组将收束。 / No restart configured; the group will stop.
    NotConfigured,
    /// 有界重启预算耗尽，整组将收束。 / The bounded budget is exhausted; the group will stop.
    BudgetExhausted,
    /// 停机阶段的退出，不重启。 / Exit during shutdown; no restart.
    DuringShutdown,
}

/// Watcher 观察到的一次子进程退出。 / One child exit observed by the Watcher.
pub(crate) struct ExitRecord<'a> {
    pub(crate) process_name: &'a str,
    pub(crate) pid: u32,
    pub(crate) started_at: SystemTime,
    pub(crate) exited_at: SystemTime,
    pub(crate) status: ExitStatus,
    pub(crate) restart: RestartDecision,
}

/// 在子进程的崩溃目录写入 `kind: child-exit` 记录，并列出同一 pid 已产生的报告与转储。
///
/// Writes a `kind: child-exit` record into the child's crash directory, listing reports and dumps
/// that pid produced.
pub(crate) fn write_exit_record(
    settings: &CrashSettings,
    record: &ExitRecord<'_>,
) -> Option<PathBuf> {
    let stem = file_stem(&settings.file_label, record.pid, record.exited_at);
    let (path, file) = create_unique_file(&settings.directory, &stem, "txt").ok()?;
    let related = related_files(&settings.directory, &settings.file_label, record.pid, &path);
    let mut out = io::BufWriter::new(file);
    let _ = (|| {
        out.write_all(format_exit_record(record, &related).as_bytes())?;
        out.flush()?;
        out.get_ref().sync_all()
    })();
    after_write(settings, None, FileClass::Report);
    Some(path)
}

/// 生成退出记录文本；头部中的 pid 与 time_utc 指子进程及其退出时间。 / Formats exit-record text; header pid and time_utc refer to the child and its exit.
pub(crate) fn format_exit_record(record: &ExitRecord<'_>, related: &[String]) -> String {
    let mut out = Vec::new();
    let uptime = record
        .exited_at
        .duration_since(record.started_at)
        .unwrap_or(Duration::ZERO);
    let restart = match &record.restart {
        RestartDecision::Scheduled { policy, delay_ms } => {
            format!("scheduled ({policy}, in {delay_ms}ms)")
        }
        RestartDecision::NotConfigured => "no (restart not configured; group stops)".to_string(),
        RestartDecision::BudgetExhausted => {
            "no (restart budget exhausted; group stops)".to_string()
        }
        RestartDecision::DuringShutdown => "no (exited during shutdown)".to_string(),
    };
    let related = if related.is_empty() {
        "none".to_string()
    } else {
        related.join("\n")
    };
    let _ = (|| -> io::Result<()> {
        write_report_header(
            &mut out,
            record.process_name,
            "child-exit",
            record.pid,
            record.exited_at,
        )?;
        writeln!(out, "reporter: watcher pid {}", std::process::id())?;
        writeln!(out, "started_utc: {}", iso8601(record.started_at))?;
        writeln!(out, "exited_utc: {}", iso8601(record.exited_at))?;
        writeln!(out, "uptime_ms: {}", uptime.as_millis())?;
        write_field(&mut out, "exit_status", &record.status.to_string())?;
        write_field(
            &mut out,
            "exit_decoded",
            &describe_exit_status(&record.status),
        )?;
        writeln!(out, "restart: {restart}")?;
        write_field(&mut out, "related_files", &related)?;
        writeln!(out)?;
        writeln!(
            out,
            "recent_logs: unavailable (written by the Watcher; see the child's own reports)"
        )
    })();
    String::from_utf8_lossy(&out).into_owned()
}

/// 解析 `crash-<label>-<pid>-<YYYYMMDDT…>` 形式的文件名，返回 pid；不匹配时返回 None。
///
/// 要求 label 之后紧跟纯数字 pid 与 8 位日期加 `T`，避免 `map` 与 `map-1` 这类名字互相误认。
///
/// Parses `crash-<label>-<pid>-<YYYYMMDDT…>` file names and returns the pid, or None when the name
/// does not match. A numeric pid and an 8-digit date plus `T` must follow the label, so names such
/// as `map` and `map-1` never claim each other's files.
pub(crate) fn parse_owned_name(name: &str, label: &str) -> Option<u32> {
    let rest = name
        .strip_prefix("crash-")?
        .strip_prefix(label)?
        .strip_prefix('-')?;
    let (pid, stamp) = rest.split_once('-')?;
    if pid.is_empty() || !pid.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let stamp = stamp.as_bytes();
    if stamp.len() < 9 || !stamp[..8].iter().all(u8::is_ascii_digit) || stamp[8] != b'T' {
        return None;
    }
    pid.parse().ok()
}

/// 列出崩溃目录中由同一进程名与 pid 产生的其他诊断文件。 / Lists other diagnostics files from the same process label and pid.
pub(crate) fn related_files(
    directory: &Path,
    label: &str,
    pid: u32,
    exclude: &Path,
) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut names = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path() != exclude)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| parse_owned_name(name, label) == Some(pid))
        .collect::<Vec<_>>();
    names.sort();
    names
}

/// 诊断目录中的文件类别。 / Category of a file in the diagnostics directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FileClass {
    /// 本进程名的文本报告与退出记录，受 maxReports 约束。 / This label's text reports and exit records, bounded by maxReports.
    Report,
    /// 本进程名的 MiniDump，受 maxDumps 约束。 / This label's MiniDumps, bounded by maxDumps.
    Dump,
    /// 无法归属进程的 core 文件，目录级受 maxDumps 约束。 / Core files that cannot be attributed, bounded per directory by maxDumps.
    Core,
}

/// 只识别本功能写出的文件名；其他文件与其他进程名的文件不会被清理。 / Recognizes only names this feature writes; other files and other labels are never removed.
pub(crate) fn classify(name: &str, label: &str) -> Option<FileClass> {
    if name == "core" || name.starts_with("core.") || name.starts_with("core-") {
        return Some(FileClass::Core);
    }
    parse_owned_name(name, label)?;
    if name.ends_with(".txt") {
        Some(FileClass::Report)
    } else if name.ends_with(".dmp") {
        Some(FileClass::Dump)
    } else {
        None
    }
}

/// 按修改时间删除最旧的文件，使本进程名的报告与转储、目录中的 core 文件分别不超过上限；返回删除数量。
///
/// 上限按进程名计算（多个 Process 共用目录时互不挤占），core 文件无法归属进程名，按目录计算。
/// 并发删除同一文件的失败被忽略。
///
/// Removes the oldest files by modification time so this label's reports and dumps, and the
/// directory's core files, each stay within their limits; returns how many were removed.
///
/// Limits are per process label (Processes sharing a directory do not evict each other); core
/// files cannot be attributed and are bounded per directory. Failures from concurrent removal are ignored.
pub(crate) fn enforce_retention(settings: &CrashSettings) -> io::Result<RetentionOutcome> {
    enforce_retention_in(
        &settings.directory,
        &settings.file_label,
        settings.max_reports,
        settings.max_dumps,
    )
}

/// 一次保留清理的结果：删除数量与清理后剩余的本进程名报告、转储数量。 / Result of one retention pass: removals and this label's remaining reports and dumps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RetentionOutcome {
    pub(crate) removed: usize,
    pub(crate) reports: usize,
    pub(crate) dumps: usize,
}

/// 进程内估计的本进程名文件数；只有估计超过上限时才扫描目录，避免每次写入都整目录扫描。
///
/// 估计值在每次扫描后校准；其他进程（如 Watcher 写退出记录）写入的文件会在下次扫描时计入。
///
/// In-process estimate of this label's files; the directory is scanned only when the estimate
/// exceeds a limit, so not every write scans the whole directory. The estimate is recalibrated by
/// each scan; files written by other processes (such as Watcher exit records) are counted then.
pub(crate) struct RetentionCounter {
    reports: AtomicUsize,
    dumps: AtomicUsize,
}

impl RetentionCounter {
    /// 创建估计为 0 的计数器；安装时的首次扫描会校准。 / Creates a zeroed estimate that the install-time scan calibrates.
    pub(crate) const fn new() -> Self {
        Self {
            reports: AtomicUsize::new(0),
            dumps: AtomicUsize::new(0),
        }
    }

    /// 用扫描结果校准估计。 / Calibrates the estimate from a scan.
    pub(crate) fn calibrate(&self, outcome: RetentionOutcome) {
        self.reports.store(outcome.reports, Ordering::Relaxed);
        self.dumps.store(outcome.dumps, Ordering::Relaxed);
    }

    /// 记一次写入，返回是否需要扫描清理。 / Records one write and returns whether a retention scan is needed.
    pub(crate) fn note_written(&self, class: FileClass, settings: &CrashSettings) -> bool {
        match class {
            FileClass::Report => {
                self.reports.fetch_add(1, Ordering::Relaxed) + 1 > settings.max_reports
            }
            FileClass::Dump | FileClass::Core => {
                self.dumps.fetch_add(1, Ordering::Relaxed) + 1 > settings.max_dumps
            }
        }
    }
}

/// 写入后按需清理：有计数器时只在估计超限时扫描，没有计数器（如 Watcher）时每次扫描。 / Post-write cleanup: with a counter scan only when over the estimate, without one (the Watcher) scan every time.
pub(crate) fn after_write(
    settings: &CrashSettings,
    retention: Option<&RetentionCounter>,
    class: FileClass,
) {
    let needed = retention.is_none_or(|counter| counter.note_written(class, settings));
    if !needed {
        return;
    }
    if let (Ok(outcome), Some(counter)) = (enforce_retention(settings), retention) {
        counter.calibrate(outcome);
    }
}

/// [`enforce_retention`] 的参数化实现，便于测试。 / Parameterized form of [`enforce_retention`] for tests.
pub(crate) fn enforce_retention_in(
    directory: &Path,
    label: &str,
    max_reports: usize,
    max_dumps: usize,
) -> io::Result<RetentionOutcome> {
    let mut reports = Vec::new();
    let mut dumps = Vec::new();
    let mut cores = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let Ok(entry) = entry else { continue };
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let Some(class) = classify(&name, label) else {
            continue;
        };
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let item = (
            metadata.modified().unwrap_or(UNIX_EPOCH),
            name,
            entry.path(),
        );
        match class {
            FileClass::Report => reports.push(item),
            FileClass::Dump => dumps.push(item),
            FileClass::Core => cores.push(item),
        }
    }
    let mut outcome = RetentionOutcome {
        removed: 0,
        reports: reports.len(),
        dumps: dumps.len(),
    };
    for (index, (mut items, limit)) in [
        (reports, max_reports),
        (dumps, max_dumps),
        (cores, max_dumps),
    ]
    .into_iter()
    .enumerate()
    {
        if items.len() <= limit {
            continue;
        }
        items.sort();
        let excess = items.len() - limit;
        let mut removed = 0;
        for (_, _, path) in items.into_iter().take(excess) {
            if std::fs::remove_file(path).is_ok() {
                removed += 1;
            }
        }
        outcome.removed += removed;
        match index {
            0 => outcome.reports -= removed,
            1 => outcome.dumps -= removed,
            _ => {}
        }
    }
    Ok(outcome)
}
