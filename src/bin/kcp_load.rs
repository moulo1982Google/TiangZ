#[cfg(feature = "kcp")]
#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    use std::net::SocketAddr;
    use std::time::{Duration, Instant};

    use anyhow::{Context, bail};
    use tiangz_transport::KcpClient;
    use tokio::task::JoinSet;

    let mut args = std::env::args().skip(1);
    let address = args
        .next()
        .unwrap_or_else(|| "127.0.0.1:7000".to_string())
        .parse::<SocketAddr>()?;
    let connections = parse_arg(args.next(), 128_usize, "connections")?;
    let warmup_seconds = parse_arg(args.next(), 5_u64, "warmup seconds")?;
    let duration_seconds = parse_arg(args.next(), 20_u64, "duration seconds")?;
    if connections == 0 || duration_seconds == 0 {
        bail!("connections and duration seconds must be greater than zero");
    }

    let mut connecting = JoinSet::new();
    for _ in 0..connections {
        connecting.spawn(async move { KcpClient::connect(address).await });
    }
    let mut clients = Vec::with_capacity(connections);
    while let Some(result) = connecting.join_next().await {
        clients.push(result.context("KCP connect task failed")??);
    }

    let measurement_start = Instant::now() + Duration::from_secs(warmup_seconds);
    let deadline = measurement_start + Duration::from_secs(duration_seconds);
    let mut workers = JoinSet::new();
    for mut client in clients {
        workers.spawn(async move {
            const REQUEST: [u8; 5] = [0x27, 0x12, 0xd0, 0x05, 0x01];
            let mut latencies_us = Vec::new();
            let mut errors = 0_u64;
            while Instant::now() < deadline {
                let started_at = Instant::now();
                match client.request(&REQUEST, Duration::from_secs(2)).await {
                    Ok(response)
                        if response.len() >= 2
                            && u16::from_be_bytes([response[0], response[1]]) == 10_003 =>
                    {
                        if started_at >= measurement_start {
                            latencies_us.push(started_at.elapsed().as_micros() as u64);
                        }
                    }
                    _ => errors += 1,
                }
            }
            let _ = client.close().await;
            (latencies_us, errors)
        });
    }

    let mut latencies_us = Vec::new();
    let mut errors = 0_u64;
    while let Some(result) = workers.join_next().await {
        let (mut worker_latencies, worker_errors) = result.context("KCP worker failed")?;
        latencies_us.append(&mut worker_latencies);
        errors += worker_errors;
    }
    latencies_us.sort_unstable();
    let requests = latencies_us.len() as u64;
    println!("KCP LoginMgr RPC load");
    println!(
        "target={address} connections={connections} warmup={warmup_seconds}s duration={duration_seconds}s"
    );
    println!(
        "requests={requests} req/s={:.0} errors={errors}",
        requests as f64 / duration_seconds as f64
    );
    println!(
        "latency_ms p50={:.3} p95={:.3} p99={:.3} max={:.3}",
        percentile(&latencies_us, 0.50) as f64 / 1_000.0,
        percentile(&latencies_us, 0.95) as f64 / 1_000.0,
        percentile(&latencies_us, 0.99) as f64 / 1_000.0,
        latencies_us.last().copied().unwrap_or_default() as f64 / 1_000.0,
    );
    Ok(())
}

#[cfg(feature = "kcp")]
fn parse_arg<T>(value: Option<String>, default: T, label: &str) -> anyhow::Result<T>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    match value {
        Some(value) => value
            .parse()
            .map_err(|error| anyhow::anyhow!("invalid {label}: {error}")),
        None => Ok(default),
    }
}

#[cfg(feature = "kcp")]
fn percentile(sorted: &[u64], quantile: f64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let index = ((sorted.len() - 1) as f64 * quantile).ceil() as usize;
    sorted[index]
}

#[cfg(not(feature = "kcp"))]
fn main() {
    eprintln!("kcp_load requires --features kcp");
    std::process::exit(2);
}
