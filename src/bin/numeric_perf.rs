//! 测量Numeric普通写入、派生重算和批量重算上限的纯Rust微基准。 / Pure Rust microbenchmark for ordinary Numeric writes, derived recomputation, and the batched upper bound.

#[path = "../game/numeric_formula.rs"]
#[allow(dead_code)]
mod numeric_formula;

use std::collections::HashMap;
use std::env;
use std::hint::black_box;
use std::time::{Duration, Instant};

use numeric_formula::derive_base_add_pct;
use serde::Serialize;

#[cfg(feature = "mimalloc-allocator")]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

const CURRENT_HP: u32 = 1;
const MAX_HP: u32 = 1_000;
const MAX_HP_BASE: u32 = 10_001;
const MAX_HP_ADD: u32 = 10_002;
const MAX_HP_PCT: u32 = 10_003;

#[derive(Clone, Copy)]
struct Options {
    entities: usize,
    warmup: Duration,
    duration: Duration,
    rounds: usize,
    json: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            entities: 10_000,
            warmup: Duration::from_millis(500),
            duration: Duration::from_secs(2),
            rounds: 5,
            json: false,
        }
    }
}

#[derive(Default)]
struct NumericState {
    values: HashMap<u32, i64>,
    dirty: HashMap<u32, u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaseReport {
    name: &'static str,
    source_writes_per_second: f64,
    nanoseconds_per_source_write: f64,
    derived_recomputes_per_second: f64,
    nanoseconds_per_entity_cycle: f64,
    checksum: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    entities: usize,
    warmup_ms: u128,
    duration_ms: u128,
    rounds: usize,
    cases: Vec<CaseReport>,
}

type Tick = fn(&mut [NumericState], u64) -> i64;

fn main() {
    let options = parse_options();
    println!("TiangZ Numeric derivation microbenchmark");
    println!(
        "entities={} warmup_ms={} duration_ms={} rounds={}",
        options.entities,
        options.warmup.as_millis(),
        options.duration.as_millis(),
        options.rounds,
    );
    println!(
        "scope=Rust HashMap<i64> mutation + dirty revision + Base/Add/Pct derivation (no V8/protobuf/socket)"
    );

    let cases: [(&str, usize, usize, Tick); 4] = [
        ("ordinary-write", 1, 0, tick_ordinary),
        ("derived-one-source", 1, 1, tick_derived_one),
        ("derived-three-writes", 3, 3, tick_derived_three),
        ("derived-batched-once", 3, 1, tick_derived_batch),
    ];
    let reports = cases
        .into_iter()
        .map(|(name, writes, recomputes, tick)| run_case(options, name, writes, recomputes, tick))
        .collect::<Vec<_>>();

    println!();
    println!(
        "{:<24} {:>15} {:>14} {:>15} {:>14}",
        "case", "source writes/s", "ns/source", "recomputes/s", "ns/entity",
    );
    for result in &reports {
        println!(
            "{:<24} {:>15.0} {:>14.2} {:>15.0} {:>14.2}",
            result.name,
            result.source_writes_per_second,
            result.nanoseconds_per_source_write,
            result.derived_recomputes_per_second,
            result.nanoseconds_per_entity_cycle,
        );
    }
    if options.json {
        println!(
            "RESULT_JSON {}",
            serde_json::to_string(&Report {
                entities: options.entities,
                warmup_ms: options.warmup.as_millis(),
                duration_ms: options.duration.as_millis(),
                rounds: options.rounds,
                cases: reports,
            })
            .expect("serialize Numeric benchmark report")
        );
    }
}

fn run_case(
    options: Options,
    name: &'static str,
    writes_per_entity: usize,
    recomputes_per_entity: usize,
    tick: Tick,
) -> CaseReport {
    let mut states = create_states(options.entities);
    run_for(&mut states, options.warmup, tick);
    let mut samples = Vec::with_capacity(options.rounds);
    let mut checksum = 0_i64;
    for _ in 0..options.rounds {
        let (elapsed, cycles, value) = run_for(&mut states, options.duration, tick);
        samples.push((elapsed.as_secs_f64(), cycles));
        checksum ^= value;
    }
    let mut entity_cycle_rates = samples
        .into_iter()
        .map(|(seconds, cycles)| cycles as f64 * options.entities as f64 / seconds)
        .collect::<Vec<_>>();
    entity_cycle_rates.sort_by(f64::total_cmp);
    let entity_cycles_per_second = entity_cycle_rates[entity_cycle_rates.len() / 2];
    let source_writes_per_second = entity_cycles_per_second * writes_per_entity as f64;
    let recomputes_per_second = entity_cycles_per_second * recomputes_per_entity as f64;
    black_box(checksum);
    CaseReport {
        name,
        source_writes_per_second,
        nanoseconds_per_source_write: 1e9 / source_writes_per_second,
        derived_recomputes_per_second: recomputes_per_second,
        nanoseconds_per_entity_cycle: 1e9 / entity_cycles_per_second,
        checksum,
    }
}

fn create_states(count: usize) -> Vec<NumericState> {
    (0..count)
        .map(|_| {
            let mut state = NumericState::default();
            state.values.extend([
                (CURRENT_HP, 100),
                (MAX_HP, 1_000),
                (MAX_HP_BASE, 1_000),
                (MAX_HP_ADD, 0),
                (MAX_HP_PCT, 0),
            ]);
            state
        })
        .collect()
}

fn run_for(states: &mut [NumericState], duration: Duration, tick: Tick) -> (Duration, u64, i64) {
    let start = Instant::now();
    let mut cycles = 0_u64;
    let mut checksum = 0_i64;
    while start.elapsed() < duration {
        checksum ^= black_box(tick(states, cycles));
        cycles += 1;
    }
    (start.elapsed(), cycles, checksum)
}

fn tick_ordinary(states: &mut [NumericState], cycle: u64) -> i64 {
    let mut revision = cycle.saturating_mul(states.len() as u64);
    for (index, state) in states.iter_mut().enumerate() {
        revision += 1;
        commit(
            state,
            CURRENT_HP,
            cycle.wrapping_add(index as u64) as i64,
            revision,
        );
    }
    last_value(states, CURRENT_HP)
}

fn tick_derived_one(states: &mut [NumericState], cycle: u64) -> i64 {
    let mut revision = cycle.saturating_mul(states.len() as u64 * 2);
    for (index, state) in states.iter_mut().enumerate() {
        revision += 1;
        commit(
            state,
            MAX_HP_ADD,
            cycle.wrapping_add(index as u64) as i64,
            revision,
        );
        revision += 1;
        recompute(state, revision);
    }
    last_value(states, MAX_HP)
}

fn tick_derived_three(states: &mut [NumericState], cycle: u64) -> i64 {
    let mut revision = cycle.saturating_mul(states.len() as u64 * 6);
    for (index, state) in states.iter_mut().enumerate() {
        for (numeric_type, value) in source_values(cycle, index) {
            revision += 1;
            commit(state, numeric_type, value, revision);
            revision += 1;
            recompute(state, revision);
        }
    }
    last_value(states, MAX_HP)
}

fn tick_derived_batch(states: &mut [NumericState], cycle: u64) -> i64 {
    let mut revision = cycle.saturating_mul(states.len() as u64 * 4);
    for (index, state) in states.iter_mut().enumerate() {
        for (numeric_type, value) in source_values(cycle, index) {
            revision += 1;
            commit(state, numeric_type, value, revision);
        }
        revision += 1;
        recompute(state, revision);
    }
    last_value(states, MAX_HP)
}

fn source_values(cycle: u64, index: usize) -> [(u32, i64); 3] {
    [
        (MAX_HP_BASE, 1_000 + (cycle & 31) as i64),
        (MAX_HP_ADD, cycle.wrapping_add(index as u64) as i64),
        (MAX_HP_PCT, (cycle % 100) as i64),
    ]
}

fn recompute(state: &mut NumericState, revision: u64) {
    let value = derive_base_add_pct(
        value(state, MAX_HP_BASE),
        value(state, MAX_HP_ADD),
        value(state, MAX_HP_PCT),
    )
    .expect("benchmark values must fit i64");
    commit(state, MAX_HP, value, revision);
}

fn commit(state: &mut NumericState, numeric_type: u32, value: i64, revision: u64) {
    if state.values.get(&numeric_type).copied().unwrap_or(0) == value {
        return;
    }
    state.values.insert(numeric_type, value);
    state.dirty.insert(numeric_type, revision.max(1));
}

fn value(state: &NumericState, numeric_type: u32) -> i64 {
    state.values.get(&numeric_type).copied().unwrap_or(0)
}

fn last_value(states: &[NumericState], numeric_type: u32) -> i64 {
    states
        .last()
        .map(|state| value(state, numeric_type))
        .unwrap_or(0)
}

fn parse_options() -> Options {
    let mut options = Options::default();
    let mut args = env::args().skip(1);
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--entities" => options.entities = parse_positive(&mut args, "--entities") as usize,
            "--warmup-ms" => {
                options.warmup = Duration::from_millis(parse_positive(&mut args, "--warmup-ms"))
            }
            "--duration-ms" => {
                options.duration = Duration::from_millis(parse_positive(&mut args, "--duration-ms"))
            }
            "--rounds" => options.rounds = parse_positive(&mut args, "--rounds") as usize,
            "--json" => options.json = true,
            _ => panic!("unknown argument: {argument}"),
        }
    }
    options
}

fn parse_positive(args: &mut impl Iterator<Item = String>, name: &str) -> u64 {
    args.next()
        .unwrap_or_else(|| panic!("{name} requires a value"))
        .parse::<u64>()
        .unwrap_or_else(|_| panic!("{name} must be a positive integer"))
        .max(1)
}
