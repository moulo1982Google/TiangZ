//! Installs structured, non-blocking process logging and exposes host-side drop observability.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{Context, Result};
use tracing_appender::non_blocking::{ErrorCounter, NonBlocking, NonBlockingBuilder, WorkerGuard};
use tracing_subscriber::EnvFilter;
use tracing_subscriber::fmt::writer::{BoxMakeWriter, MakeWriterExt};

use crate::config::{
    ProcessLogFileConfig, ProcessLogFormat, ProcessLogRotation, ProcessLoggingConfig,
};

static PROCESS_NAME: OnceLock<String> = OnceLock::new();
static DROP_COUNTERS: OnceLock<Vec<ErrorCounter>> = OnceLock::new();

pub struct LoggingGuard {
    _workers: Vec<WorkerGuard>,
}

/// Returns the process label installed during logging initialization.
pub fn process_name() -> &'static str {
    PROCESS_NAME.get().map(String::as_str).unwrap_or("unknown")
}

/// Returns lines dropped by the non-blocking writer since process start.
pub fn dropped_lines() -> usize {
    DROP_COUNTERS
        .get()
        .map(|counters| counters.iter().map(ErrorCounter::dropped_lines).sum())
        .unwrap_or(0)
}

/// Computes a conservative TS prefilter so V8 avoids formatting disabled log levels.
pub fn typescript_min_level(config: &ProcessLoggingConfig) -> u8 {
    resolve_typescript_min_level(config, std::env::var("RUST_LOG").ok().as_deref())
}

fn resolve_typescript_min_level(
    config: &ProcessLoggingConfig,
    environment_filter: Option<&str>,
) -> u8 {
    let filter = environment_filter
        .map(str::to_owned)
        .or_else(|| config.filter.clone());
    match filter.as_deref().and_then(simple_level_code) {
        Some(level) => level,
        None if filter.is_some() => 0,
        None => level_code(config.level),
    }
}

fn simple_level_code(value: &str) -> Option<u8> {
    match value.trim().to_ascii_lowercase().as_str() {
        "trace" => Some(0),
        "debug" => Some(1),
        "info" => Some(2),
        "warn" => Some(3),
        "error" => Some(4),
        "off" => Some(5),
        _ => None,
    }
}

fn level_code(level: crate::config::ProcessLogLevel) -> u8 {
    match level {
        crate::config::ProcessLogLevel::Trace => 0,
        crate::config::ProcessLogLevel::Debug => 1,
        crate::config::ProcessLogLevel::Info => 2,
        crate::config::ProcessLogLevel::Warn => 3,
        crate::config::ProcessLogLevel::Error => 4,
    }
}

/// Installs the process-global tracing subscriber and returns guards that must outlive the runtime.
///
/// Dropping the guard flushes buffered output. This function may be called only
/// once per OS process; tests that need isolated subscribers should use local
/// dispatch rather than repeatedly invoking it.
pub fn init(
    root: &Path,
    process_name: &str,
    config: &ProcessLoggingConfig,
) -> Result<LoggingGuard> {
    let _ = PROCESS_NAME.set(process_name.to_string());
    let mut workers = Vec::new();
    let mut drop_counters = Vec::new();
    let console = config.console.then(|| {
        let (writer, guard, counter) = non_blocking(std::io::stdout(), "tiangz-log-console");
        workers.push(guard);
        drop_counters.push(counter);
        writer
    });
    let file = config
        .file
        .as_ref()
        .filter(|file| file.enabled)
        .map(|file| create_file_writer(root, process_name, file))
        .transpose()?;
    let file = file.map(|(writer, guard, counter)| {
        workers.push(guard);
        drop_counters.push(counter);
        writer
    });
    let writer =
        combine_writers(console, file).context("logging must enable console or file output")?;
    let filter_text = std::env::var("RUST_LOG")
        .ok()
        .or_else(|| config.filter.clone())
        .unwrap_or_else(|| config.level.as_str().to_string());
    let filter = EnvFilter::try_new(&filter_text)
        .with_context(|| format!("invalid logging filter: {filter_text}"))?;

    match config.format {
        ProcessLogFormat::Pretty => tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_writer(writer)
            .with_target(true)
            .try_init()
            .map_err(|error| anyhow::anyhow!("failed to initialize logging subscriber: {error}"))?,
        ProcessLogFormat::Json => tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_writer(writer)
            .with_target(true)
            .json()
            .flatten_event(true)
            .try_init()
            .map_err(|error| anyhow::anyhow!("failed to initialize logging subscriber: {error}"))?,
    }

    let _ = DROP_COUNTERS.set(drop_counters);

    Ok(LoggingGuard { _workers: workers })
}

fn create_file_writer(
    root: &Path,
    process_name: &str,
    config: &ProcessLogFileConfig,
) -> Result<(NonBlocking, WorkerGuard, ErrorCounter)> {
    let configured = PathBuf::from(&config.directory);
    let directory = if configured.is_absolute() {
        configured
    } else {
        root.join(configured)
    };
    std::fs::create_dir_all(&directory)
        .with_context(|| format!("failed to create log directory {}", directory.display()))?;
    let prefix = format!("{}.log", sanitize_file_name(process_name));
    let appender = match config.rotation {
        ProcessLogRotation::Hourly => tracing_appender::rolling::hourly(directory, prefix),
        ProcessLogRotation::Daily => tracing_appender::rolling::daily(directory, prefix),
        ProcessLogRotation::Never => tracing_appender::rolling::never(directory, prefix),
    };
    Ok(non_blocking(appender, "tiangz-log-file"))
}

fn non_blocking(
    writer: impl std::io::Write + Send + 'static,
    thread_name: &str,
) -> (NonBlocking, WorkerGuard, ErrorCounter) {
    let (writer, guard) = NonBlockingBuilder::default()
        .lossy(true)
        .thread_name(thread_name)
        .finish(writer);
    let counter = writer.error_counter();
    (writer, guard, counter)
}

fn combine_writers(
    console: Option<NonBlocking>,
    file: Option<NonBlocking>,
) -> Option<BoxMakeWriter> {
    match (console, file) {
        (Some(console), Some(file)) => Some(BoxMakeWriter::new(console.and(file))),
        (Some(console), None) => Some(BoxMakeWriter::new(console)),
        (None, Some(file)) => Some(BoxMakeWriter::new(file)),
        (None, None) => None,
    }
}

fn sanitize_file_name(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ => character,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_name_is_safe_for_log_file() {
        assert_eq!(sanitize_file_name("map:1/test"), "map_1_test");
    }

    #[test]
    fn typescript_level_uses_config_for_the_common_case() {
        let config = ProcessLoggingConfig {
            level: crate::config::ProcessLogLevel::Warn,
            ..ProcessLoggingConfig::default()
        };
        assert_eq!(resolve_typescript_min_level(&config, None), 3);
    }

    #[test]
    fn complex_filter_keeps_typescript_prefilter_conservative() {
        let config = ProcessLoggingConfig {
            filter: Some("info,tiangz::typescript=debug".to_string()),
            ..ProcessLoggingConfig::default()
        };
        assert_eq!(resolve_typescript_min_level(&config, None), 0);
    }

    #[test]
    fn file_writer_flushes_structured_event_on_guard_drop() {
        let directory = tempfile::tempdir().unwrap();
        let config = ProcessLoggingConfig {
            console: false,
            format: ProcessLogFormat::Json,
            file: Some(ProcessLogFileConfig {
                enabled: true,
                directory: "logs".to_string(),
                rotation: ProcessLogRotation::Never,
            }),
            ..ProcessLoggingConfig::default()
        };
        let guard = init(directory.path(), "logging-test", &config).unwrap();
        tracing::warn!(target: "tiangz::test", answer = 42, "structured logging test");
        drop(guard);

        let output =
            std::fs::read_to_string(directory.path().join("logs").join("logging-test.log"))
                .unwrap();
        assert!(output.contains("structured logging test"), "{output:?}");
        assert!(output.contains("\"answer\":42"), "{output:?}");
    }
}
