use std::cell::RefCell;
use std::collections::HashMap;

use deno_core::convert::Uint8Array;
use deno_core::op2;
use deno_error::JsErrorBox;

use crate::generated::native_data::{EntityData, UnitData};

const INDEX_BITS: u32 = 20;
const INDEX_MASK: u32 = (1 << INDEX_BITS) - 1;
const MAX_GENERATION: u32 = (1 << (32 - INDEX_BITS)) - 1;
const NATIVE_UNIT_RECORD_BYTES: usize = 42;
const CELL_SIZE: f32 = 12.0;
const DEFAULT_MOVE_SPEED_CELLS_PER_SECOND: f32 = 10.0;
const MIN_UNIT_CELL: i32 = -63;
const MAX_UNIT_CELL: i32 = 62;

thread_local! {
    static STORE: RefCell<NativeUnitStore> = RefCell::new(NativeUnitStore::default());
}

#[derive(Default)]
struct NativeDataMetrics {
    scalar_gets: u64,
    scalar_sets: u64,
    batch_calls: u64,
}

struct UnitSlot {
    generation: u32,
    value: Option<UnitData>,
}

#[derive(Default)]
struct NativeUnitStore {
    slots: Vec<UnitSlot>,
    free: Vec<usize>,
    units_by_map: HashMap<u32, Vec<u32>>,
    metrics: NativeDataMetrics,
}

impl NativeUnitStore {
    fn create(&mut self, value: UnitData) -> Result<u32, JsErrorBox> {
        let map_id = value.map_id;
        let index = if let Some(index) = self.free.pop() {
            self.slots[index].value = Some(value);
            index
        } else {
            if self.slots.len() >= INDEX_MASK as usize {
                return Err(JsErrorBox::generic("native Unit arena is full"));
            }
            let index = self.slots.len();
            self.slots.push(UnitSlot {
                generation: 1,
                value: Some(value),
            });
            index
        };
        let handle = encode_handle(index, self.slots[index].generation);
        self.units_by_map.entry(map_id).or_default().push(handle);
        Ok(handle)
    }

    fn get(&self, handle: u32) -> Result<&UnitData, JsErrorBox> {
        let (index, generation) = decode_handle(handle)?;
        let slot = self.slots.get(index).ok_or_else(|| stale_handle(handle))?;
        if slot.generation != generation {
            return Err(stale_handle(handle));
        }
        slot.value.as_ref().ok_or_else(|| stale_handle(handle))
    }

    fn get_mut(&mut self, handle: u32) -> Result<&mut UnitData, JsErrorBox> {
        let (index, generation) = decode_handle(handle)?;
        let slot = self
            .slots
            .get_mut(index)
            .ok_or_else(|| stale_handle(handle))?;
        if slot.generation != generation {
            return Err(stale_handle(handle));
        }
        slot.value.as_mut().ok_or_else(|| stale_handle(handle))
    }

    fn destroy(&mut self, handle: u32) -> Result<(), JsErrorBox> {
        let (index, generation) = decode_handle(handle)?;
        let slot = self
            .slots
            .get_mut(index)
            .ok_or_else(|| stale_handle(handle))?;
        if slot.generation != generation {
            return Err(stale_handle(handle));
        }
        let unit = slot.value.take().ok_or_else(|| stale_handle(handle))?;
        if let Some(handles) = self.units_by_map.get_mut(&unit.map_id) {
            handles.retain(|candidate| *candidate != handle);
            if handles.is_empty() {
                self.units_by_map.remove(&unit.map_id);
            }
        }
        slot.generation = if slot.generation >= MAX_GENERATION {
            1
        } else {
            slot.generation + 1
        };
        self.free.push(index);
        Ok(())
    }

    fn live_units(&self) -> u32 {
        (self.slots.len() - self.free.len()) as u32
    }
}

#[op2(fast)]
pub(crate) fn op_native_unit_create(
    unit_id: u32,
    instance_id: u32,
    map_id: u32,
    x: f32,
    y: f32,
) -> Result<u32, JsErrorBox> {
    if unit_id == 0 || instance_id == 0 || map_id == 0 {
        return Err(JsErrorBox::generic(
            "native Unit ids must be greater than zero",
        ));
    }
    let cell_x = world_to_cell(x);
    let cell_y = world_to_cell(y);
    if !can_occupy_cell(cell_x, cell_y) {
        return Err(JsErrorBox::generic("native Unit starts outside map"));
    }
    STORE.with(|slot| {
        slot.borrow_mut().create(UnitData {
            entity: EntityData {
                id: unit_id,
                instance_id,
            },
            map_id,
            x,
            y,
            cell_x,
            cell_y,
            target_cell_x: cell_x,
            target_cell_y: cell_y,
            move_start_tick: 0,
            move_end_tick: 0,
            moving: 0,
            speed_cells_per_second: DEFAULT_MOVE_SPEED_CELLS_PER_SECOND,
            input_x: 0,
            input_y: 0,
            input_changed: 0,
            sequence: 0,
        })
    })
}

#[op2(fast)]
pub(crate) fn op_native_unit_destroy(handle: u32) -> Result<(), JsErrorBox> {
    STORE.with(|slot| slot.borrow_mut().destroy(handle))
}

#[op2(fast)]
pub(crate) fn op_native_unit_set_movement_input(
    handle: u32,
    input_x: i8,
    input_y: i8,
    sequence: u32,
) -> Result<bool, JsErrorBox> {
    if !(-1..=1).contains(&input_x) || !(-1..=1).contains(&input_y) {
        return Err(JsErrorBox::generic(
            "native movement input must be between -1 and 1",
        ));
    }
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        store.metrics.scalar_sets += 1;
        let unit = store.get_mut(handle)?;
        if sequence <= unit.sequence {
            return Ok(false);
        }
        unit.input_changed |= u32::from(unit.input_x != input_x || unit.input_y != input_y);
        unit.input_x = input_x;
        unit.input_y = input_y;
        unit.sequence = sequence;
        Ok(true)
    })
}

#[op2(fast)]
pub(crate) fn op_native_unit_reset_movement(handle: u32) -> Result<(), JsErrorBox> {
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        store.metrics.scalar_sets += 1;
        let unit = store.get_mut(handle)?;
        unit.input_x = 0;
        unit.input_y = 0;
        unit.input_changed = 0;
        unit.sequence = 0;
        unit.target_cell_x = unit.cell_x;
        unit.target_cell_y = unit.cell_y;
        unit.move_start_tick = 0;
        unit.move_end_tick = 0;
        unit.moving = 0;
        unit.x = cell_to_world(unit.cell_x);
        unit.y = cell_to_world(unit.cell_y);
        Ok(())
    })
}

#[op2]
pub(crate) fn op_native_unit_snapshot(handle: u32) -> Result<Uint8Array, JsErrorBox> {
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        store.metrics.scalar_gets += 1;
        let bytes = encode_snapshot(store.get(handle)?, false);
        Ok(bytes.to_vec().into())
    })
}

#[op2]
pub(crate) fn op_native_map_fixed_update(
    map_id: u32,
    server_tick: u32,
    fixed_update_ms: u32,
) -> Result<Uint8Array, JsErrorBox> {
    if fixed_update_ms == 0 {
        return Err(JsErrorBox::generic(
            "fixed update milliseconds must be greater than zero",
        ));
    }
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        store.metrics.batch_calls += 1;
        let handles = store.units_by_map.get(&map_id).cloned().unwrap_or_default();
        let mut records = Vec::with_capacity(handles.len());
        for handle in handles {
            let unit = store.get_mut(handle)?;
            let state_changed = update_movement(unit, server_tick, fixed_update_ms as f32);
            if unit.moving != 0 || state_changed {
                records.push(encode_snapshot(unit, state_changed));
            }
        }

        let mut bytes = Vec::with_capacity(4 + records.len() * NATIVE_UNIT_RECORD_BYTES);
        bytes.extend_from_slice(&(records.len() as u32).to_le_bytes());
        for record in records {
            bytes.extend_from_slice(&record);
        }
        Ok(bytes.into())
    })
}

#[op2]
pub(crate) fn op_native_data_take_metrics() -> Uint8Array {
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        let live_units = store.live_units();
        let metrics = std::mem::take(&mut store.metrics);
        let mut bytes = Vec::with_capacity(28);
        bytes.extend_from_slice(&metrics.scalar_gets.to_le_bytes());
        bytes.extend_from_slice(&metrics.scalar_sets.to_le_bytes());
        bytes.extend_from_slice(&metrics.batch_calls.to_le_bytes());
        bytes.extend_from_slice(&live_units.to_le_bytes());
        bytes.into()
    })
}

fn update_movement(unit: &mut UnitData, server_tick: u32, fixed_update_ms: f32) -> bool {
    let mut state_changed = unit.input_changed != 0;
    unit.input_changed = 0;
    if unit.moving != 0 && server_tick >= unit.move_end_tick {
        unit.cell_x = unit.target_cell_x;
        unit.cell_y = unit.target_cell_y;
        unit.x = cell_to_world(unit.cell_x);
        unit.y = cell_to_world(unit.cell_y);
        unit.moving = 0;
        state_changed = true;
    }

    if unit.moving == 0 && (unit.input_x != 0 || unit.input_y != 0) {
        let target_x = unit.cell_x + unit.input_x as i32;
        let target_y = unit.cell_y + unit.input_y as i32;
        if can_occupy_cell(target_x, target_y) {
            unit.target_cell_x = target_x;
            unit.target_cell_y = target_y;
            unit.move_start_tick = server_tick;
            unit.move_end_tick = server_tick
                + step_duration_ticks(
                    unit.input_x,
                    unit.input_y,
                    unit.speed_cells_per_second,
                    fixed_update_ms,
                );
            unit.moving = 1;
        } else {
            unit.input_x = 0;
            unit.input_y = 0;
        }
        state_changed = true;
    }

    state_changed
}

fn encode_snapshot(unit: &UnitData, state_changed: bool) -> [u8; NATIVE_UNIT_RECORD_BYTES] {
    let mut bytes = [0_u8; NATIVE_UNIT_RECORD_BYTES];
    bytes[0..4].copy_from_slice(&unit.entity.id.to_le_bytes());
    bytes[4..8].copy_from_slice(&unit.x.round().to_le_bytes());
    bytes[8..12].copy_from_slice(&unit.y.round().to_le_bytes());
    bytes[12..16].copy_from_slice(&unit.sequence.to_le_bytes());
    bytes[16] = u8::from(state_changed);
    bytes[17] = u8::from(unit.moving != 0);
    bytes[18..22].copy_from_slice(&unit.cell_x.to_le_bytes());
    bytes[22..26].copy_from_slice(&unit.cell_y.to_le_bytes());
    bytes[26..30].copy_from_slice(&unit.target_cell_x.to_le_bytes());
    bytes[30..34].copy_from_slice(&unit.target_cell_y.to_le_bytes());
    bytes[34..38].copy_from_slice(&unit.move_start_tick.to_le_bytes());
    bytes[38..42].copy_from_slice(&unit.move_end_tick.to_le_bytes());
    bytes
}

fn cell_to_world(cell: i32) -> f32 {
    cell as f32 * CELL_SIZE
}

fn world_to_cell(world: f32) -> i32 {
    (world / CELL_SIZE).round() as i32
}

fn can_occupy_cell(x: i32, y: i32) -> bool {
    (MIN_UNIT_CELL..=MAX_UNIT_CELL).contains(&x) && (MIN_UNIT_CELL..=MAX_UNIT_CELL).contains(&y)
}

fn step_duration_ticks(
    input_x: i8,
    input_y: i8,
    speed_cells_per_second: f32,
    fixed_update_ms: f32,
) -> u32 {
    let distance = if input_x != 0 && input_y != 0 {
        std::f32::consts::SQRT_2
    } else {
        1.0
    };
    (1_000.0 * distance / speed_cells_per_second / fixed_update_ms)
        .ceil()
        .max(1.0) as u32
}

fn encode_handle(index: usize, generation: u32) -> u32 {
    (generation << INDEX_BITS) | (index as u32 + 1)
}

fn decode_handle(handle: u32) -> Result<(usize, u32), JsErrorBox> {
    let index_plus_one = handle & INDEX_MASK;
    let generation = handle >> INDEX_BITS;
    if index_plus_one == 0 || generation == 0 {
        return Err(stale_handle(handle));
    }
    Ok(((index_plus_one - 1) as usize, generation))
}

fn stale_handle(handle: u32) -> JsErrorBox {
    JsErrorBox::generic(format!("native Unit handle is stale: {handle}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MovementFixture {
        fixed_update_ms: u32,
        initial_cell_x: i32,
        initial_cell_y: i32,
        steps: Vec<MovementStep>,
    }

    #[derive(Deserialize)]
    struct MovementStep {
        tick: u32,
        input: Option<MovementInput>,
        expected: ExpectedMovement,
    }

    #[derive(Deserialize)]
    struct MovementInput {
        x: i8,
        y: i8,
        sequence: u32,
    }

    #[derive(Debug, Deserialize, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct ExpectedMovement {
        acknowledged_sequence: u32,
        from_cell_x: i32,
        from_cell_y: i32,
        to_cell_x: i32,
        to_cell_y: i32,
        move_start_tick: u32,
        move_end_tick: u32,
        moving: bool,
        state_changed: bool,
    }

    #[test]
    fn stale_handle_is_rejected_after_slot_reuse() {
        let mut store = NativeUnitStore::default();
        let first = store.create(unit(1)).unwrap();
        store.destroy(first).unwrap();
        let second = store.create(unit(2)).unwrap();
        assert_ne!(first, second);
        assert!(store.get(first).is_err());
        assert_eq!(store.get(second).unwrap().entity.id, 2);
    }

    #[test]
    fn movement_finishes_current_cell_before_using_next_direction() {
        let mut value = unit(1);
        value.input_x = 1;
        value.sequence = 7;
        value.input_changed = 1;
        assert!(update_movement(&mut value, 10, 50.0));
        assert_eq!(value.target_cell_x, 1);
        assert_eq!(value.move_end_tick, 12);
        assert_eq!(value.sequence, 7);

        value.input_x = 0;
        value.input_y = 1;
        value.sequence = 8;
        value.input_changed = 1;
        assert!(update_movement(&mut value, 11, 50.0));
        assert_eq!(value.target_cell_x, 1);
        assert_eq!(value.target_cell_y, 0);

        assert!(update_movement(&mut value, 12, 50.0));
        assert_eq!(value.cell_x, 1);
        assert_eq!(value.cell_y, 0);
        assert_eq!(value.target_cell_x, 1);
        assert_eq!(value.target_cell_y, 1);
    }

    #[test]
    fn movement_matches_shared_typescript_fixture() {
        let fixture: MovementFixture =
            serde_json::from_str(include_str!("../native_data/movement_parity.json")).unwrap();
        let mut value = unit(1);
        value.cell_x = fixture.initial_cell_x;
        value.cell_y = fixture.initial_cell_y;
        value.target_cell_x = fixture.initial_cell_x;
        value.target_cell_y = fixture.initial_cell_y;
        value.x = cell_to_world(fixture.initial_cell_x);
        value.y = cell_to_world(fixture.initial_cell_y);

        for step in fixture.steps {
            if let Some(input) = step.input {
                value.input_changed |=
                    u32::from(value.input_x != input.x || value.input_y != input.y);
                value.input_x = input.x;
                value.input_y = input.y;
                value.sequence = input.sequence;
            }
            let state_changed =
                update_movement(&mut value, step.tick, fixture.fixed_update_ms as f32);
            let actual = ExpectedMovement {
                acknowledged_sequence: value.sequence,
                from_cell_x: value.cell_x,
                from_cell_y: value.cell_y,
                to_cell_x: value.target_cell_x,
                to_cell_y: value.target_cell_y,
                move_start_tick: value.move_start_tick,
                move_end_tick: value.move_end_tick,
                moving: value.moving != 0,
                state_changed,
            };
            assert_eq!(
                actual, step.expected,
                "Rust movement parity failed at tick {}",
                step.tick
            );
        }
    }

    fn unit(id: u32) -> UnitData {
        UnitData {
            entity: EntityData {
                id,
                instance_id: id,
            },
            map_id: 1,
            x: 0.0,
            y: 0.0,
            cell_x: 0,
            cell_y: 0,
            target_cell_x: 0,
            target_cell_y: 0,
            move_start_tick: 0,
            move_end_tick: 0,
            moving: 0,
            speed_cells_per_second: DEFAULT_MOVE_SPEED_CELLS_PER_SECOND,
            input_x: 0,
            input_y: 0,
            input_changed: 0,
            sequence: 0,
        }
    }
}
