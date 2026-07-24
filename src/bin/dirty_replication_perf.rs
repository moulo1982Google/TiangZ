use std::collections::HashMap;
use std::env;
use std::hint::black_box;
use std::time::{Duration, Instant};

#[cfg(feature = "mimalloc-allocator")]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

const DEFAULT_ENTITIES: usize = 1_000;
const DEFAULT_WARMUP_MS: u64 = 500;
const DEFAULT_DURATION_MS: u64 = 2_000;
const CHANGED_FIELDS: usize = 3;

#[derive(Clone, Copy)]
struct Options {
    entities: usize,
    warmup: Duration,
    duration: Duration,
}

#[derive(Default)]
struct NumericState {
    values: HashMap<u32, i32>,
    dirty: HashMap<u32, u64>,
}

struct PlayerInfo {
    x: f32,
    y: f32,
    speed_cells_per_second: f32,
    alive: bool,
    dirty_mask: u64,
    revision: u64,
    member_revisions: [u64; 64],
}

impl Default for PlayerInfo {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            speed_cells_per_second: 0.0,
            alive: false,
            dirty_mask: 0,
            revision: 0,
            member_revisions: [0; 64],
        }
    }
}

#[derive(Default)]
struct ItemState {
    config_id: u32,
    count: u32,
    quality: u32,
    level: u32,
    version: u32,
}

struct Measurement {
    name: &'static str,
    elapsed: Duration,
    cycles: u64,
    changes: u64,
    items: u64,
    frames: u64,
    bytes: u64,
    checksum: u64,
}

fn main() {
    let options = parse_options();
    println!("TiangZ state synchronization microbenchmark");
    println!(
        "entities={} warmup_ms={} duration_ms={} changed_fields={}",
        options.entities,
        options.warmup.as_millis(),
        options.duration.as_millis(),
        CHANGED_FIELDS,
    );
    println!("scope=Rust mutation + dirty tracking + protobuf encode + Ack (no socket)");

    let benchmarks: [fn(Options, Duration) -> Measurement; 3] =
        [bench_numeric, bench_player_info, bench_item];
    for benchmark in benchmarks {
        black_box(benchmark(options, options.warmup));
    }

    println!();
    println!(
        "{:<20} {:>13} {:>13} {:>12} {:>11} {:>11} {:>12}",
        "模式", "changes/s", "items/s", "frames/s", "MiB/s", "B/item", "ns/item",
    );
    for benchmark in benchmarks {
        print_result(benchmark(options, options.duration));
    }
}

fn bench_numeric(options: Options, duration: Duration) -> Measurement {
    let mut states = (0..options.entities)
        .map(|_| NumericState::default())
        .collect::<Vec<_>>();
    let mut revision = 0_u64;
    let mut frame = Vec::with_capacity(options.entities * 40 + 16);
    run_for("Numeric dynamic", duration, |cycle| {
        for (index, state) in states.iter_mut().enumerate() {
            for numeric_type in [1_u32, 3, 5] {
                revision = revision.wrapping_add(1).max(1);
                let value = cycle
                    .wrapping_add(index as u64)
                    .wrapping_add(numeric_type as u64) as i32;
                state.values.insert(numeric_type, value);
                state.dirty.insert(numeric_type, revision);
            }
        }

        let through_revision = revision;
        frame.clear();
        frame.extend_from_slice(&10_017_u16.to_be_bytes());
        put_u32_field(&mut frame, 1, cycle as u32);
        let mut item_count = 0_u64;
        for (index, state) in states.iter().enumerate() {
            for (&numeric_type, &dirty_revision) in &state.dirty {
                if dirty_revision > through_revision {
                    continue;
                }
                let unit_id = index as u32 + 1;
                let value = state.values[&numeric_type];
                let item_len = u32_field_len(1, unit_id)
                    + u32_field_len(2, numeric_type)
                    + sint32_field_len(3, value);
                put_key(&mut frame, 2, 2);
                put_varint(&mut frame, item_len as u64);
                put_u32_field(&mut frame, 1, unit_id);
                put_u32_field(&mut frame, 2, numeric_type);
                put_sint32_field(&mut frame, 3, value);
                item_count += 1;
            }
        }
        for state in &mut states {
            state.dirty.retain(|_, value| *value > through_revision);
        }
        Work {
            changes: options.entities as u64 * CHANGED_FIELDS as u64,
            items: item_count,
            frames: 1,
            bytes: frame.len() as u64,
            checksum: checksum(&frame),
        }
    })
}

fn bench_player_info(options: Options, duration: Duration) -> Measurement {
    let mut states = (0..options.entities)
        .map(|_| PlayerInfo {
            alive: true,
            ..PlayerInfo::default()
        })
        .collect::<Vec<_>>();
    let mut frame = Vec::with_capacity(options.entities * 40 + 16);
    run_for("PlayerInfo fixed", duration, |cycle| {
        for (index, state) in states.iter_mut().enumerate() {
            set_player_f32(
                state,
                1,
                cycle.wrapping_add(index as u64) as f32 * 0.25,
                |s| &mut s.x,
            );
            set_player_f32(
                state,
                2,
                cycle.wrapping_add(index as u64) as f32 * 0.5,
                |s| &mut s.y,
            );
            set_player_f32(state, 3, 10.0 + (cycle as u32 & 7) as f32, |s| {
                &mut s.speed_cells_per_second
            });
        }

        frame.clear();
        frame.extend_from_slice(&10_018_u16.to_be_bytes());
        put_u32_field(&mut frame, 1, cycle as u32);
        let mut item_count = 0_u64;
        for (index, state) in states.iter_mut().enumerate() {
            let mask = state.dirty_mask;
            if mask == 0 {
                continue;
            }
            let revision = state.revision;
            let mut item = Vec::with_capacity(36);
            put_u32_field(&mut item, 1, index as u32 + 1);
            put_u32_field(&mut item, 2, mask as u32);
            put_u32_field(&mut item, 3, (mask >> 32) as u32);
            if mask & (1 << 1) != 0 {
                put_f32_field(&mut item, 4, state.x);
            }
            if mask & (1 << 2) != 0 {
                put_f32_field(&mut item, 5, state.y);
            }
            if mask & (1 << 3) != 0 {
                put_f32_field(&mut item, 6, state.speed_cells_per_second);
            }
            if mask & (1 << 4) != 0 {
                put_bool_field(&mut item, 7, state.alive);
            }
            put_message_field(&mut frame, 2, &item);
            ack_player(state, mask, revision);
            item_count += 1;
        }
        Work {
            changes: options.entities as u64 * CHANGED_FIELDS as u64,
            items: item_count,
            frames: 1,
            bytes: frame.len() as u64,
            checksum: checksum(&frame),
        }
    })
}

fn bench_item(options: Options, duration: Duration) -> Measurement {
    let mut states = (0..options.entities)
        .map(|_| ItemState {
            config_id: 1_001,
            count: 1_000_000,
            level: 1,
            version: 1,
            ..ItemState::default()
        })
        .collect::<Vec<_>>();
    let mut frame = Vec::with_capacity(48);
    run_for("Item immediate", duration, |_cycle| {
        let mut bytes = 0_u64;
        let mut combined_checksum = 0_u64;
        for (index, state) in states.iter_mut().enumerate() {
            state.count = state.count.wrapping_sub(1);
            state.version = state.version.wrapping_add(1).max(1);
            frame.clear();
            frame.extend_from_slice(&10_021_u16.to_be_bytes());
            let mut item = Vec::with_capacity(32);
            put_u32_field(&mut item, 1, index as u32 + 1);
            put_u32_field(&mut item, 2, state.config_id);
            put_u32_field(&mut item, 3, state.count);
            put_u32_field(&mut item, 4, state.quality);
            put_u32_field(&mut item, 5, state.level);
            put_u32_field(&mut item, 6, state.version);
            put_message_field(&mut frame, 1, &item);
            bytes += frame.len() as u64;
            combined_checksum = combined_checksum.wrapping_add(checksum(&frame));
        }
        Work {
            changes: options.entities as u64 * 2,
            items: options.entities as u64,
            frames: options.entities as u64,
            bytes,
            checksum: combined_checksum,
        }
    })
}

struct Work {
    changes: u64,
    items: u64,
    frames: u64,
    bytes: u64,
    checksum: u64,
}

fn run_for(
    name: &'static str,
    duration: Duration,
    mut cycle: impl FnMut(u64) -> Work,
) -> Measurement {
    let started = Instant::now();
    let mut cycles = 0_u64;
    let mut changes = 0_u64;
    let mut items = 0_u64;
    let mut frames = 0_u64;
    let mut bytes = 0_u64;
    let mut checksum_value = 0_u64;
    while started.elapsed() < duration {
        let work = cycle(cycles + 1);
        cycles += 1;
        changes += work.changes;
        items += work.items;
        frames += work.frames;
        bytes += work.bytes;
        checksum_value = checksum_value.wrapping_add(work.checksum);
    }
    black_box(checksum_value);
    Measurement {
        name,
        elapsed: started.elapsed(),
        cycles,
        changes,
        items,
        frames,
        bytes,
        checksum: checksum_value,
    }
}

fn set_player_f32(
    state: &mut PlayerInfo,
    member_id: usize,
    value: f32,
    field: impl FnOnce(&mut PlayerInfo) -> &mut f32,
) {
    let target = field(state);
    if target.to_bits() == value.to_bits() {
        return;
    }
    *target = value;
    mark_player_dirty(state, member_id);
}

fn mark_player_dirty(state: &mut PlayerInfo, member_id: usize) {
    state.revision = state.revision.wrapping_add(1).max(1);
    state.dirty_mask |= 1_u64 << member_id;
    state.member_revisions[member_id] = state.revision;
}

fn ack_player(state: &mut PlayerInfo, mut mask: u64, revision: u64) {
    while mask != 0 {
        let member_id = mask.trailing_zeros() as usize;
        mask &= mask - 1;
        if state.member_revisions[member_id] <= revision {
            state.dirty_mask &= !(1_u64 << member_id);
        }
    }
}

fn put_key(output: &mut Vec<u8>, field: u32, wire_type: u32) {
    put_varint(output, u64::from((field << 3) | wire_type));
}

fn put_u32_field(output: &mut Vec<u8>, field: u32, value: u32) {
    if value == 0 {
        return;
    }
    put_key(output, field, 0);
    put_varint(output, u64::from(value));
}

fn put_sint32_field(output: &mut Vec<u8>, field: u32, value: i32) {
    if value == 0 {
        return;
    }
    put_key(output, field, 0);
    put_varint(output, ((value << 1) ^ (value >> 31)) as u32 as u64);
}

fn u32_field_len(field: u32, value: u32) -> usize {
    if value == 0 {
        return 0;
    }
    varint_len(u64::from(field << 3)) + varint_len(u64::from(value))
}

fn sint32_field_len(field: u32, value: i32) -> usize {
    if value == 0 {
        return 0;
    }
    let encoded = ((value << 1) ^ (value >> 31)) as u32;
    varint_len(u64::from(field << 3)) + varint_len(u64::from(encoded))
}

fn varint_len(mut value: u64) -> usize {
    let mut length = 1;
    while value >= 0x80 {
        length += 1;
        value >>= 7;
    }
    length
}

fn put_bool_field(output: &mut Vec<u8>, field: u32, value: bool) {
    if value {
        put_key(output, field, 0);
        output.push(1);
    }
}

fn put_f32_field(output: &mut Vec<u8>, field: u32, value: f32) {
    if value == 0.0 {
        return;
    }
    put_key(output, field, 5);
    output.extend_from_slice(&value.to_le_bytes());
}

fn put_message_field(output: &mut Vec<u8>, field: u32, value: &[u8]) {
    put_key(output, field, 2);
    put_varint(output, value.len() as u64);
    output.extend_from_slice(value);
}

fn put_varint(output: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        output.push((value as u8) | 0x80);
        value >>= 7;
    }
    output.push(value as u8);
}

fn checksum(bytes: &[u8]) -> u64 {
    bytes
        .iter()
        .fold(0_u64, |value, byte| value.rotate_left(5) ^ u64::from(*byte))
}

fn print_result(result: Measurement) {
    let seconds = result.elapsed.as_secs_f64();
    let changes_per_second = result.changes as f64 / seconds;
    let items_per_second = result.items as f64 / seconds;
    let frames_per_second = result.frames as f64 / seconds;
    let mib_per_second = result.bytes as f64 / seconds / 1_048_576.0;
    let bytes_per_item = result.bytes as f64 / result.items.max(1) as f64;
    let nanoseconds_per_item = result.elapsed.as_nanos() as f64 / result.items.max(1) as f64;
    println!(
        "{:<20} {:>13.0} {:>13.0} {:>12.0} {:>11.2} {:>11.2} {:>12.2}",
        result.name,
        changes_per_second,
        items_per_second,
        frames_per_second,
        mib_per_second,
        bytes_per_item,
        nanoseconds_per_item,
    );
    black_box((result.cycles, result.checksum));
}

fn parse_options() -> Options {
    let mut options = Options {
        entities: DEFAULT_ENTITIES,
        warmup: Duration::from_millis(DEFAULT_WARMUP_MS),
        duration: Duration::from_millis(DEFAULT_DURATION_MS),
    };
    let args = env::args().skip(1).collect::<Vec<_>>();
    let mut index = 0;
    while index < args.len() {
        let (name, target) = match args[index].as_str() {
            "--entities" => ("entities", 0),
            "--warmup-ms" => ("warmup-ms", 1),
            "--duration-ms" => ("duration-ms", 2),
            "--help" | "-h" => {
                println!(
                    "Usage: cargo run --release --bin dirty_replication_perf -- \
                     [--entities N] [--warmup-ms N] [--duration-ms N]"
                );
                std::process::exit(0);
            }
            value => panic!("unknown argument: {value}"),
        };
        index += 1;
        let value = args
            .get(index)
            .unwrap_or_else(|| panic!("--{name} requires a value"))
            .parse::<u64>()
            .unwrap_or_else(|_| panic!("invalid --{name} value"));
        match target {
            0 => options.entities = usize::try_from(value).expect("entities exceeds usize"),
            1 => options.warmup = Duration::from_millis(value),
            2 => options.duration = Duration::from_millis(value),
            _ => unreachable!(),
        }
        index += 1;
    }
    assert!(options.entities > 0, "entities must be greater than zero");
    assert!(
        !options.duration.is_zero(),
        "duration must be greater than zero"
    );
    options
}
