use std::collections::HashMap;
use std::hint::black_box;
use std::time::{Duration, Instant};

#[cfg(feature = "mimalloc-allocator")]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

const ITERATIONS: usize = 2_000_000;

#[derive(Default)]
struct DynamicNumeric {
    values: HashMap<u32, i32>,
    dirty: HashMap<u32, i32>,
}

#[derive(Default)]
struct FixedStats {
    values: [i32; 5],
    dirty_mask: u64,
}

fn main() {
    println!("TiangZ dirty replication microbenchmark");
    println!("iterations={ITERATIONS}, fields=5, changed_per_iteration=3");
    print_result("dynamic HashMap", bench_dynamic());
    print_result("fixed u64 mask", bench_fixed());
}

fn bench_dynamic() -> Duration {
    let mut value = DynamicNumeric::default();
    let started = Instant::now();
    for iteration in 0..ITERATIONS {
        let iteration = black_box(iteration as i32);
        for field in black_box([1_u32, 3, 5]) {
            let next = iteration + field as i32;
            value.values.insert(field, next);
            value.dirty.insert(field, next);
        }
        let mut checksum = 0_i64;
        for (&field, &field_value) in &value.dirty {
            checksum += i64::from(field) + i64::from(field_value);
        }
        black_box(checksum);
        value.dirty.clear();
    }
    started.elapsed()
}

fn bench_fixed() -> Duration {
    let mut value = FixedStats::default();
    let started = Instant::now();
    for iteration in 0..ITERATIONS {
        let iteration = black_box(iteration as i32);
        for field in black_box([0_usize, 2, 4]) {
            value.values[field] = iteration + field as i32;
            value.dirty_mask |= 1_u64 << (field + 1);
        }
        let mut mask = black_box(value.dirty_mask);
        let mut checksum = 0_i64;
        while mask != 0 {
            let member_id = mask.trailing_zeros() as usize;
            mask &= mask - 1;
            checksum += i64::from(value.values[member_id - 1]);
        }
        black_box(checksum);
        value.dirty_mask = 0;
    }
    started.elapsed()
}

fn print_result(name: &str, elapsed: Duration) {
    let operations_per_second = ITERATIONS as f64 / elapsed.as_secs_f64();
    let nanoseconds = elapsed.as_nanos() as f64 / ITERATIONS as f64;
    println!(
        "{name:<18} {:>12.0} iterations/s {:>10.2} ns/iteration elapsed={:.3}s",
        operations_per_second,
        nanoseconds,
        elapsed.as_secs_f64(),
    );
}
