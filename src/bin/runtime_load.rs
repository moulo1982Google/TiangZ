use std::collections::HashMap;
use std::env;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

#[path = "../allocator.rs"]
mod allocator;

use anyhow::{Context, Result, bail};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Barrier;

const REQUEST_MSGCODE: u16 = 15_002;
const RESPONSE_MSGCODE: u16 = 15_003;
const MAX_FRAME_LEN: usize = 1024 * 1024;

#[derive(Clone, Debug)]
struct Options {
    host: String,
    port: u16,
    duration: Duration,
    warmup: Duration,
    concurrency: usize,
    connections: usize,
    payload_bytes: usize,
    delay_ms: u32,
    drain_timeout: Duration,
}

#[derive(Clone, Copy)]
struct Timing {
    measurement_start: Instant,
    send_deadline: Instant,
}

struct PendingRequest {
    started_at: Instant,
    measured: bool,
    seq: u32,
}

#[derive(Default)]
struct ConnectionResult {
    latencies_micros: Vec<u64>,
    peak_in_flight: usize,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    let options = Arc::new(parse_options(env::args().skip(1).collect())?);
    let barrier = Arc::new(Barrier::new(options.connections + 1));
    let timing = Arc::new(OnceLock::<Timing>::new());
    let payload = Arc::new(
        (0..options.payload_bytes)
            .map(|index| (index & 0xff) as u8)
            .collect::<Vec<_>>(),
    );

    let base_window = options.concurrency / options.connections;
    let extra_windows = options.concurrency % options.connections;
    let mut tasks = Vec::with_capacity(options.connections);
    for index in 0..options.connections {
        let window = base_window + usize::from(index < extra_windows);
        let options = Arc::clone(&options);
        let barrier = Arc::clone(&barrier);
        let timing = Arc::clone(&timing);
        let payload = Arc::clone(&payload);
        tasks.push(tokio::spawn(async move {
            run_connection(options, window, barrier, timing, payload).await
        }));
    }

    barrier.wait().await;
    let measurement_start = Instant::now() + options.warmup;
    timing
        .set(Timing {
            measurement_start,
            send_deadline: measurement_start + options.duration,
        })
        .map_err(|_| anyhow::anyhow!("load-test timing was initialized twice"))?;
    barrier.wait().await;

    let overall_timeout = options.warmup + options.duration + options.drain_timeout;
    let results = tokio::time::timeout(overall_timeout, async {
        let mut results = Vec::with_capacity(tasks.len());
        for task in tasks {
            results.push(task.await.context("load connection task panicked")??);
        }
        Result::<Vec<ConnectionResult>>::Ok(results)
    })
    .await
    .context("runtime load test timed out")??;

    let mut latencies = results
        .into_iter()
        .flat_map(|result| result.latencies_micros)
        .collect::<Vec<_>>();
    let peak_in_flight = options.concurrency;
    latencies.sort_unstable();
    let requests = latencies.len();
    let requests_per_second = requests as f64 / options.duration.as_secs_f64();

    println!("Runtime localhost load test (Rust client)");
    println!(
        "target={}:{} duration={}s warmup={}s connections={} concurrency={} payload={}B delay={}ms",
        options.host,
        options.port,
        options.duration.as_secs_f64(),
        options.warmup.as_secs_f64(),
        options.connections,
        options.concurrency,
        options.payload_bytes,
        options.delay_ms,
    );
    println!(
        "requests={requests} req/s={requests_per_second:.0} errors=0 peak_in_flight={peak_in_flight}"
    );
    println!(
        "latency_ms p50={:.3} p95={:.3} p99={:.3} max={:.3}",
        percentile(&latencies, 0.50) as f64 / 1000.0,
        percentile(&latencies, 0.95) as f64 / 1000.0,
        percentile(&latencies, 0.99) as f64 / 1000.0,
        latencies.last().copied().unwrap_or_default() as f64 / 1000.0,
    );
    Ok(())
}

async fn run_connection(
    options: Arc<Options>,
    window: usize,
    barrier: Arc<Barrier>,
    timing: Arc<OnceLock<Timing>>,
    payload: Arc<Vec<u8>>,
) -> Result<ConnectionResult> {
    let stream = TcpStream::connect((options.host.as_str(), options.port))
        .await
        .with_context(|| format!("failed to connect {}:{}", options.host, options.port))?;
    stream.set_nodelay(true)?;
    let (mut reader, mut writer) = stream.into_split();

    barrier.wait().await;
    barrier.wait().await;
    let timing = *timing.get().context("load-test timing is missing")?;

    let mut result = ConnectionResult::default();
    let mut pending = HashMap::<u32, PendingRequest>::with_capacity(window * 2);
    let mut next_rpc_id = 1_u32;
    let mut next_seq = 1_u32;

    for _ in 0..window {
        send_request(
            &mut writer,
            &mut pending,
            &mut next_rpc_id,
            &mut next_seq,
            &payload,
            options.delay_ms,
            timing,
        )
        .await?;
    }
    result.peak_in_flight = pending.len();

    while !pending.is_empty() {
        let frame = read_frame(&mut reader).await?;
        let response = decode_response(&frame)?;
        if response.error != 0 {
            bail!(
                "RPC {} failed with system/business error {}",
                response.rpc_id,
                response.error
            );
        }
        let request = pending
            .remove(&response.rpc_id)
            .with_context(|| format!("unknown response rpcId {}", response.rpc_id))?;
        if request.seq != response.seq || response.payload_len != options.payload_bytes {
            bail!("RPC {} response payload mismatch", response.rpc_id);
        }
        if request.measured {
            result
                .latencies_micros
                .push(request.started_at.elapsed().as_micros() as u64);
        }

        if Instant::now() < timing.send_deadline {
            send_request(
                &mut writer,
                &mut pending,
                &mut next_rpc_id,
                &mut next_seq,
                &payload,
                options.delay_ms,
                timing,
            )
            .await?;
            result.peak_in_flight = result.peak_in_flight.max(pending.len());
        }
    }

    Ok(result)
}

#[allow(clippy::too_many_arguments)]
async fn send_request(
    writer: &mut tokio::net::tcp::OwnedWriteHalf,
    pending: &mut HashMap<u32, PendingRequest>,
    next_rpc_id: &mut u32,
    next_seq: &mut u32,
    payload: &[u8],
    delay_ms: u32,
    timing: Timing,
) -> Result<()> {
    let rpc_id = *next_rpc_id;
    let seq = *next_seq;
    *next_rpc_id = next_rpc_id.wrapping_add(1).max(1);
    *next_seq = next_seq.wrapping_add(1).max(1);

    let started_at = Instant::now();
    let packet = encode_request(rpc_id, seq, payload, delay_ms)?;
    writer.write_all(&packet).await?;
    pending.insert(
        rpc_id,
        PendingRequest {
            started_at,
            measured: started_at >= timing.measurement_start && started_at < timing.send_deadline,
            seq,
        },
    );
    Ok(())
}

fn encode_request(rpc_id: u32, seq: u32, payload: &[u8], delay_ms: u32) -> Result<Vec<u8>> {
    let mut frame = Vec::with_capacity(payload.len() + 32);
    frame.extend_from_slice(&REQUEST_MSGCODE.to_be_bytes());
    push_field_varint(&mut frame, 90, rpc_id);
    push_field_varint(&mut frame, 1, seq);
    if !payload.is_empty() {
        push_varint(&mut frame, (2 << 3) | 2);
        push_varint(&mut frame, payload.len() as u64);
        frame.extend_from_slice(payload);
    }
    push_field_varint(&mut frame, 3, delay_ms);

    let frame_len = u32::try_from(frame.len()).context("request frame is too large")?;
    let mut packet = Vec::with_capacity(4 + frame.len());
    packet.extend_from_slice(&frame_len.to_be_bytes());
    packet.extend_from_slice(&frame);
    Ok(packet)
}

fn push_field_varint(buffer: &mut Vec<u8>, field_number: u32, value: u32) {
    if value == 0 {
        return;
    }
    push_varint(buffer, (field_number << 3) as u64);
    push_varint(buffer, value as u64);
}

fn push_varint(buffer: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        buffer.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    buffer.push(value as u8);
}

async fn read_frame(reader: &mut tokio::net::tcp::OwnedReadHalf) -> Result<Vec<u8>> {
    let length = reader.read_u32().await? as usize;
    if !(2..=MAX_FRAME_LEN).contains(&length) {
        bail!("invalid response frame length: {length}");
    }
    let mut frame = vec![0_u8; length];
    reader.read_exact(&mut frame).await?;
    Ok(frame)
}

struct DecodedResponse {
    rpc_id: u32,
    seq: u32,
    payload_len: usize,
    error: u32,
}

fn decode_response(frame: &[u8]) -> Result<DecodedResponse> {
    if frame.len() < 2 {
        bail!("response frame is shorter than msgcode");
    }
    let msgcode = u16::from_be_bytes([frame[0], frame[1]]);
    if msgcode != RESPONSE_MSGCODE {
        bail!("unexpected response msgcode {msgcode}");
    }

    let mut response = DecodedResponse {
        rpc_id: 0,
        seq: 0,
        payload_len: 0,
        error: 0,
    };
    let mut offset = 2;
    while offset < frame.len() {
        let tag = read_varint(frame, &mut offset)?;
        let field_number = tag >> 3;
        let wire_type = tag & 0x07;
        match (field_number, wire_type) {
            (90, 0) => response.rpc_id = read_varint(frame, &mut offset)? as u32,
            (91, 0) => response.error = read_varint(frame, &mut offset)? as u32,
            (1, 0) => response.seq = read_varint(frame, &mut offset)? as u32,
            (2, 2) => {
                let length = read_varint(frame, &mut offset)? as usize;
                advance(frame, &mut offset, length)?;
                response.payload_len = length;
            }
            (_, 0) => {
                read_varint(frame, &mut offset)?;
            }
            (_, 1) => advance(frame, &mut offset, 8)?,
            (_, 2) => {
                let length = read_varint(frame, &mut offset)? as usize;
                advance(frame, &mut offset, length)?;
            }
            (_, 5) => advance(frame, &mut offset, 4)?,
            _ => bail!("unsupported protobuf wire type {wire_type}"),
        }
    }
    if response.rpc_id == 0 {
        bail!("response is missing rpcId");
    }
    Ok(response)
}

fn read_varint(bytes: &[u8], offset: &mut usize) -> Result<u64> {
    let mut result = 0_u64;
    for shift in (0..70).step_by(7) {
        let byte = *bytes.get(*offset).context("unexpected eof in varint")?;
        *offset += 1;
        result |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            return Ok(result);
        }
    }
    bail!("varint is too long")
}

fn advance(bytes: &[u8], offset: &mut usize, length: usize) -> Result<()> {
    let next = offset
        .checked_add(length)
        .context("protobuf length overflow")?;
    if next > bytes.len() {
        bail!("unexpected eof in protobuf field");
    }
    *offset = next;
    Ok(())
}

fn percentile(sorted: &[u64], ratio: f64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    sorted[((sorted.len() as f64 * ratio) as usize).min(sorted.len() - 1)]
}

fn parse_options(args: Vec<String>) -> Result<Options> {
    let mut values = HashMap::<String, String>::new();
    for pair in args.chunks(2) {
        if pair.len() != 2 {
            bail!("arguments must use --name value pairs");
        }
        values.insert(
            pair[0].trim_start_matches('-').to_ascii_lowercase(),
            pair[1].clone(),
        );
    }

    let number = |name: &str, fallback: u64| -> Result<u64> {
        let value = values
            .get(name)
            .map(|value| value.parse::<u64>())
            .transpose()
            .with_context(|| format!("invalid --{name}"))?
            .unwrap_or(fallback);
        Ok(value)
    };
    let duration = number("duration", 10)?;
    let warmup = number("warmup", 2)?;
    let concurrency = number("concurrency", 128)? as usize;
    let connections = number("connections", 4)? as usize;
    if duration == 0 || concurrency == 0 || connections == 0 {
        bail!("duration, concurrency and connections must be greater than zero");
    }
    if connections > concurrency {
        bail!("connections cannot exceed concurrency");
    }

    Ok(Options {
        host: values
            .get("host")
            .cloned()
            .unwrap_or_else(|| "127.0.0.1".to_string()),
        port: u16::try_from(number("port", 7400)?).context("port exceeds uint16")?,
        duration: Duration::from_secs(duration),
        warmup: Duration::from_secs(warmup),
        concurrency,
        connections,
        payload_bytes: number("payload", 256)? as usize,
        delay_ms: u32::try_from(number("delay", 0)?).context("delay exceeds uint32")?,
        drain_timeout: Duration::from_secs(number("drain", 10)?),
    })
}
