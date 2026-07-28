//! 对比通用 Handle Arena、类型分池和 Unit 冷热分池的纯数据布局成本。
//! Compares generic Handle Arena, typed pools, and split Unit hot/cold pools.

#[allow(clippy::large_enum_variant)]
#[path = "../generated/native_data.rs"]
mod generated_native_data;

use std::hint::black_box;
use std::mem::size_of;
use std::time::Instant;

use generated_native_data::{
    ENTITY_TYPE_ITEM, ENTITY_TYPE_UNIT, ItemData, NativeEntityData, UnitColdData, UnitData,
    UnitHotData, UnitSplitData, create_entity,
};
use serde::Serialize;

#[cfg(feature = "mimalloc-allocator")]
use mimalloc::MiMalloc;

#[cfg(feature = "mimalloc-allocator")]
#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

#[derive(Clone, Copy)]
struct Options {
    units: usize,
    items_per_unit: usize,
    iterations: usize,
    warmup: usize,
    rounds: usize,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            units: 50_000,
            items_per_unit: 10,
            iterations: 200,
            warmup: 20,
            rounds: 5,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    units: usize,
    items_per_unit: usize,
    iterations: usize,
    warmup: usize,
    rounds: usize,
    sizes: TypeSizes,
    cases: Vec<CaseResult>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TypeSizes {
    native_entity_data: usize,
    unit_data: usize,
    item_data: usize,
    unit_hot_data: usize,
    unit_cold_data: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaseResult {
    name: &'static str,
    median_ms: f64,
    min_ms: f64,
    max_ms: f64,
    million_unit_updates_per_second: f64,
    nanoseconds_per_unit_update: f64,
    estimated_storage_bytes: u64,
    checksum: u64,
}

struct ArenaSlot {
    generation: u32,
    value: Option<NativeEntityData>,
}

struct ArenaStore {
    slots: Vec<ArenaSlot>,
    unit_handles: Vec<usize>,
}

struct TypedStore {
    units: Vec<UnitData>,
    items: Vec<ItemData>,
}

struct SplitStore {
    unit_hot: Vec<UnitHotData>,
    unit_cold: Vec<UnitColdData>,
    items: Vec<ItemData>,
}

fn main() {
    let options = parse_options();
    let cases = vec![
        benchmark_arena(options),
        benchmark_typed(options),
        benchmark_split(options),
    ];
    let report = Report {
        units: options.units,
        items_per_unit: options.items_per_unit,
        iterations: options.iterations,
        warmup: options.warmup,
        rounds: options.rounds,
        sizes: TypeSizes {
            native_entity_data: size_of::<NativeEntityData>(),
            unit_data: size_of::<UnitData>(),
            item_data: size_of::<ItemData>(),
            unit_hot_data: size_of::<UnitHotData>(),
            unit_cold_data: size_of::<UnitColdData>(),
        },
        cases,
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&report).expect("serialize benchmark report")
    );
}

fn benchmark_arena(options: Options) -> CaseResult {
    let mut store = create_arena(options.units, options.items_per_unit);
    for iteration in 0..options.warmup {
        black_box(tick_arena(&mut store, iteration as u32));
    }
    let (samples, checksum) = measure(options, |iteration| tick_arena(&mut store, iteration));
    let storage = store.slots.capacity() * size_of::<ArenaSlot>()
        + store.unit_handles.capacity() * size_of::<usize>();
    summarize("handle-arena", options, samples, storage, checksum)
}

fn benchmark_typed(options: Options) -> CaseResult {
    let mut store = create_typed(options.units, options.items_per_unit);
    for iteration in 0..options.warmup {
        black_box(tick_typed(&mut store, iteration as u32));
    }
    let (samples, checksum) = measure(options, |iteration| tick_typed(&mut store, iteration));
    let storage = store.units.capacity() * size_of::<UnitData>()
        + store.items.capacity() * size_of::<ItemData>();
    summarize("typed-pools", options, samples, storage, checksum)
}

fn benchmark_split(options: Options) -> CaseResult {
    let mut store = create_split(options.units, options.items_per_unit);
    for iteration in 0..options.warmup {
        black_box(tick_split(&mut store, iteration as u32));
    }
    let (samples, checksum) = measure(options, |iteration| tick_split(&mut store, iteration));
    let storage = store.unit_hot.capacity() * size_of::<UnitHotData>()
        + store.unit_cold.capacity() * size_of::<UnitColdData>()
        + store.items.capacity() * size_of::<ItemData>();
    summarize("unit-hot-cold-pools", options, samples, storage, checksum)
}

fn measure(options: Options, mut tick: impl FnMut(u32) -> u64) -> (Vec<f64>, u64) {
    let mut samples = Vec::with_capacity(options.rounds);
    let mut checksum = 0_u64;
    for round in 0..options.rounds {
        let start = Instant::now();
        for iteration in 0..options.iterations {
            checksum ^= black_box(tick((round * options.iterations + iteration) as u32));
        }
        samples.push(start.elapsed().as_secs_f64() * 1_000.0);
    }
    (samples, checksum)
}

fn summarize(
    name: &'static str,
    options: Options,
    mut samples: Vec<f64>,
    storage: usize,
    checksum: u64,
) -> CaseResult {
    samples.sort_by(f64::total_cmp);
    let median_ms = samples[samples.len() / 2];
    let updates = options.units as f64 * options.iterations as f64;
    let updates_per_second = updates / (median_ms / 1_000.0);
    CaseResult {
        name,
        median_ms,
        min_ms: samples[0],
        max_ms: samples[samples.len() - 1],
        million_unit_updates_per_second: updates_per_second / 1_000_000.0,
        nanoseconds_per_unit_update: 1_000_000_000.0 / updates_per_second,
        estimated_storage_bytes: storage as u64,
        checksum,
    }
}

fn create_arena(units: usize, items_per_unit: usize) -> ArenaStore {
    let mut slots = Vec::with_capacity(units.saturating_mul(items_per_unit + 1));
    let mut unit_handles = Vec::with_capacity(units);
    for index in 0..units {
        unit_handles.push(slots.len());
        slots.push(ArenaSlot {
            generation: 1,
            value: Some(make_unit(index)),
        });
        for item_index in 0..items_per_unit {
            slots.push(ArenaSlot {
                generation: 1,
                value: Some(make_item(index, item_index)),
            });
        }
    }
    ArenaStore {
        slots,
        unit_handles,
    }
}

fn create_typed(units: usize, items_per_unit: usize) -> TypedStore {
    let mut unit_pool = Vec::with_capacity(units);
    let mut item_pool = Vec::with_capacity(units.saturating_mul(items_per_unit));
    for index in 0..units {
        unit_pool.push(expect_unit(make_unit(index)));
        for item_index in 0..items_per_unit {
            item_pool.push(expect_item(make_item(index, item_index)));
        }
    }
    TypedStore {
        units: unit_pool,
        items: item_pool,
    }
}

fn create_split(units: usize, items_per_unit: usize) -> SplitStore {
    let mut unit_hot = Vec::with_capacity(units);
    let mut unit_cold = Vec::with_capacity(units);
    let mut items = Vec::with_capacity(units.saturating_mul(items_per_unit));
    for index in 0..units {
        let split = UnitSplitData::from(expect_unit(make_unit(index)));
        unit_hot.push(split.hot);
        unit_cold.push(split.cold);
        for item_index in 0..items_per_unit {
            items.push(expect_item(make_item(index, item_index)));
        }
    }
    SplitStore {
        unit_hot,
        unit_cold,
        items,
    }
}

fn make_unit(index: usize) -> NativeEntityData {
    let id = u32::try_from(index + 1).expect("unit id exceeds u32");
    create_entity(
        ENTITY_TYPE_UNIT,
        &[
            id as f64,
            (id + 1_000_000) as f64,
            1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            2.0,
            10.0,
            1.0,
            1.0,
            0.0,
            1.0,
            0.0,
        ],
    )
    .expect("create benchmark Unit")
}

fn make_item(unit_index: usize, item_index: usize) -> NativeEntityData {
    let ordinal = unit_index
        .checked_mul(10_000)
        .and_then(|value| value.checked_add(item_index + 1))
        .expect("item id overflow");
    let id = u32::try_from(ordinal).expect("item id exceeds u32");
    create_entity(
        ENTITY_TYPE_ITEM,
        &[id as f64, (id + 1) as f64, 1001.0, 1.0, 2.0, 1.0, 1.0],
    )
    .expect("create benchmark Item")
}

fn expect_unit(value: NativeEntityData) -> UnitData {
    match value {
        NativeEntityData::Unit(unit) => unit,
        NativeEntityData::Item(_) => unreachable!("expected Unit"),
    }
}

fn expect_item(value: NativeEntityData) -> ItemData {
    match value {
        NativeEntityData::Item(item) => item,
        NativeEntityData::Unit(_) => unreachable!("expected Item"),
    }
}

fn tick_arena(store: &mut ArenaStore, iteration: u32) -> u64 {
    let mut checksum = 0_u64;
    for handle in &store.unit_handles {
        let slot = &mut store.slots[*handle];
        debug_assert_eq!(slot.generation, 1);
        let NativeEntityData::Unit(unit) = slot.value.as_mut().expect("live arena slot") else {
            unreachable!("Unit handle points to another Entity type");
        };
        update_unit(unit, iteration);
        checksum = checksum.wrapping_add(unit_checksum(unit));
    }
    checksum
}

fn tick_typed(store: &mut TypedStore, iteration: u32) -> u64 {
    let mut checksum = 0_u64;
    for unit in &mut store.units {
        update_unit(unit, iteration);
        checksum = checksum.wrapping_add(unit_checksum(unit));
    }
    checksum
}

fn tick_split(store: &mut SplitStore, iteration: u32) -> u64 {
    let mut checksum = 0_u64;
    for unit in &mut store.unit_hot {
        update_hot_unit(unit, iteration);
        checksum = checksum.wrapping_add(hot_unit_checksum(unit));
    }
    checksum
}

fn update_unit(unit: &mut UnitData, iteration: u32) {
    unit.input_changed ^= 1;
    unit.sequence = unit.sequence.wrapping_add(1);
    unit.cell_x = unit.cell_x.wrapping_add(i32::from(unit.input_x));
    unit.target_cell_x = unit.cell_x.wrapping_add(i32::from(unit.input_x));
    unit.x += unit.speed_cells_per_second * 0.05;
    unit.move_start_tick = iteration;
    unit.move_end_tick = iteration.wrapping_add(1);
    unit.moving = 1;
    unit.facing = 2;
}

fn update_hot_unit(unit: &mut UnitHotData, iteration: u32) {
    unit.input_changed ^= 1;
    unit.sequence = unit.sequence.wrapping_add(1);
    unit.cell_x = unit.cell_x.wrapping_add(i32::from(unit.input_x));
    unit.target_cell_x = unit.cell_x.wrapping_add(i32::from(unit.input_x));
    unit.x += unit.speed_cells_per_second * 0.05;
    unit.move_start_tick = iteration;
    unit.move_end_tick = iteration.wrapping_add(1);
    unit.moving = 1;
    unit.facing = 2;
}

fn unit_checksum(unit: &UnitData) -> u64 {
    u64::from(unit.entity.id)
        ^ u64::from(unit.sequence)
        ^ u64::from(unit.x.to_bits())
        ^ (unit.cell_x as u32 as u64)
}

fn hot_unit_checksum(unit: &UnitHotData) -> u64 {
    u64::from(unit.id)
        ^ u64::from(unit.sequence)
        ^ u64::from(unit.x.to_bits())
        ^ (unit.cell_x as u32 as u64)
}

fn parse_options() -> Options {
    let mut options = Options::default();
    let mut args = std::env::args().skip(1);
    while let Some(argument) = args.next() {
        let mut value = || {
            args.next()
                .unwrap_or_else(|| panic!("{argument} requires a value"))
        };
        match argument.as_str() {
            "--units" => options.units = parse_positive(&value(), "units"),
            "--items-per-unit" => {
                options.items_per_unit = value().parse().expect("items-per-unit must be usize")
            }
            "--iterations" => options.iterations = parse_positive(&value(), "iterations"),
            "--warmup" => options.warmup = value().parse().expect("warmup must be usize"),
            "--rounds" => options.rounds = parse_positive(&value(), "rounds"),
            "--help" => {
                eprintln!(
                    "native_storage_perf [--units N] [--items-per-unit N] [--iterations N] [--warmup N] [--rounds N]"
                );
                std::process::exit(0);
            }
            _ => panic!("unknown argument: {argument}"),
        }
    }
    options
}

fn parse_positive(value: &str, name: &str) -> usize {
    let parsed: usize = value
        .parse()
        .unwrap_or_else(|_| panic!("{name} must be usize"));
    assert!(parsed > 0, "{name} must be greater than zero");
    parsed
}
