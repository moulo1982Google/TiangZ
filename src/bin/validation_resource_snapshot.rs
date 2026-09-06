//! 演练专用只读进程快照，不读取命令行或环境变量。 / Read-only drill diagnostics, without arguments or environment data.

use serde::Serialize;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessSample {
    pid: u32,
    name: String,
    rss_bytes: u64,
    cpu_percent: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    processes: Vec<ProcessSample>,
    cpu_processes: Vec<ProcessSample>,
    cpu_sample_seconds: f64,
    logical_cpus: usize,
}

fn machine_cpu_percent(process_cpu: f32, logical_cpus: usize) -> f32 {
    if !process_cpu.is_finite() || logical_cpus == 0 {
        return 0.0;
    }
    (process_cpu / logical_cpus as f32).clamp(0.0, 100.0)
}

fn interval_cpu_percent(before_ms: u64, after_ms: u64, seconds: f64, cpus: usize) -> f32 {
    if seconds <= 0.0 || !seconds.is_finite() {
        return 0.0;
    }
    machine_cpu_percent(
        (after_ms.saturating_sub(before_ms) as f64 / seconds / 10.0) as f32,
        cpus,
    )
}

fn bounded_snapshot(mut samples: Vec<ProcessSample>, seconds: f64, cpus: usize) -> Snapshot {
    samples.sort_by(|a, b| {
        b.cpu_percent
            .total_cmp(&a.cpu_percent)
            .then(a.pid.cmp(&b.pid))
    });
    let cpu_processes = samples.iter().take(8).cloned().collect();
    samples.sort_by(|a, b| b.rss_bytes.cmp(&a.rss_bytes).then(a.pid.cmp(&b.pid)));
    samples.truncate(12);
    Snapshot {
        processes: samples,
        cpu_processes,
        cpu_sample_seconds: seconds,
        logical_cpus: cpus,
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut system = System::new();
    let kind = ProcessRefreshKind::nothing().with_cpu().with_memory();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
    // Windows 新枚举进程的 CPU 累计值尚未初始化，先预热一次再取差分。
    // Prime newly enumerated Windows process counters before taking explicit deltas.
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
    let before: HashMap<_, _> = system
        .processes()
        .iter()
        .map(|(pid, p)| ((*pid, p.start_time()), p.accumulated_cpu_time()))
        .collect();
    let started = Instant::now();
    std::thread::sleep(Duration::from_secs(1).max(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL));
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
    let cpus = std::thread::available_parallelism()?.get();
    let seconds = started.elapsed().as_secs_f64();
    let samples = system
        .processes()
        .values()
        .map(|p| ProcessSample {
            pid: p.pid().as_u32(),
            name: p.name().to_string_lossy().chars().take(128).collect(),
            rss_bytes: p.memory(),
            cpu_percent: before.get(&(p.pid(), p.start_time())).map_or(0.0, |first| {
                interval_cpu_percent(*first, p.accumulated_cpu_time(), seconds, cpus)
            }),
        })
        .collect();
    println!(
        "{}",
        serde_json::to_string(&bounded_snapshot(samples, seconds, cpus))?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_is_machine_normalized_and_finite() {
        assert_eq!(machine_cpu_percent(200.0, 8), 25.0);
        for value in [f32::NAN, f32::INFINITY, -1.0] {
            assert_eq!(machine_cpu_percent(value, 8), 0.0);
        }
        assert_eq!(machine_cpu_percent(200.0, 0), 0.0);
        assert_eq!(machine_cpu_percent(1000.0, 8), 100.0);
        assert_eq!(interval_cpu_percent(37_000_000, 37_002_000, 1.0, 8), 25.0);
        assert_eq!(interval_cpu_percent(100, 10, 1.0, 8), 0.0);
        assert_eq!(interval_cpu_percent(100, 110, 0.0, 8), 0.0);
    }

    #[test]
    fn evidence_is_bounded_and_sorted_by_current_cpu_and_memory() {
        let samples = (0..30)
            .map(|pid| ProcessSample {
                pid,
                name: format!("p{pid}"),
                rss_bytes: u64::from(pid),
                cpu_percent: (30 - pid) as f32,
            })
            .collect();
        let snapshot = bounded_snapshot(samples, 1.0, 8);
        assert_eq!(snapshot.processes.len(), 12);
        assert_eq!(snapshot.cpu_processes.len(), 8);
        assert_eq!(snapshot.processes[0].pid, 29);
        assert_eq!(snapshot.cpu_processes[0].pid, 0);
    }
}
