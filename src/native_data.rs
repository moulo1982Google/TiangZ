use std::cell::RefCell;
use std::collections::HashMap;

use deno_core::convert::Uint8Array;
use deno_core::op2;
use deno_error::JsErrorBox;

#[cfg(test)]
use crate::generated::native_data::{EntityData, get_unit_number, set_unit_number};
use crate::generated::native_data::{
    NativeEntityData, UnitData, create_entity, get_entity_number, set_entity_number,
};

const INDEX_BITS: u32 = 20;
const INDEX_MASK: u32 = (1 << INDEX_BITS) - 1;
const MAX_GENERATION: u32 = (1 << (32 - INDEX_BITS)) - 1;
const NATIVE_UNIT_RECORD_BYTES: usize = 42;
const CELL_SIZE: f32 = 12.0;
const MIN_UNIT_CELL: i32 = -63;
const MAX_UNIT_CELL: i32 = 62;

thread_local! {
    static STORE: RefCell<NativeEntityStore> = RefCell::new(NativeEntityStore::default());
}

#[derive(Default)]
struct NativeDataMetrics {
    scalar_gets: u64,
    scalar_sets: u64,
    batch_calls: u64,
    encoded_frames: u64,
    encoded_items: u64,
    encoded_bytes: u64,
}

struct EntitySlot {
    generation: u32,
    value: Option<NativeEntityData>,
}

#[derive(Default)]
struct NativeEntityStore {
    slots: Vec<EntitySlot>,
    free: Vec<usize>,
    units_by_map: HashMap<u32, Vec<u32>>,
    metrics: NativeDataMetrics,
}

impl NativeEntityStore {
    fn create(&mut self, value: NativeEntityData) -> Result<u32, JsErrorBox> {
        let unit_map_id = value.as_unit().map(|unit| unit.map_id);
        let index = if let Some(index) = self.free.pop() {
            self.slots[index].value = Some(value);
            index
        } else {
            if self.slots.len() >= INDEX_MASK as usize {
                return Err(JsErrorBox::generic("native Entity arena is full"));
            }
            let index = self.slots.len();
            self.slots.push(EntitySlot {
                generation: 1,
                value: Some(value),
            });
            index
        };
        let handle = encode_handle(index, self.slots[index].generation);
        if let Some(map_id) = unit_map_id {
            self.units_by_map.entry(map_id).or_default().push(handle);
        }
        Ok(handle)
    }

    fn get(&self, handle: u32) -> Result<&NativeEntityData, JsErrorBox> {
        let (index, generation) = decode_handle(handle)?;
        let slot = self.slots.get(index).ok_or_else(|| stale_handle(handle))?;
        if slot.generation != generation {
            return Err(stale_handle(handle));
        }
        slot.value.as_ref().ok_or_else(|| stale_handle(handle))
    }

    fn get_mut(&mut self, handle: u32) -> Result<&mut NativeEntityData, JsErrorBox> {
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
        let value = slot.value.take().ok_or_else(|| stale_handle(handle))?;
        if let Some(map_id) = value.as_unit().map(|unit| unit.map_id) {
            if let Some(handles) = self.units_by_map.get_mut(&map_id) {
                handles.retain(|candidate| *candidate != handle);
                if handles.is_empty() {
                    self.units_by_map.remove(&map_id);
                }
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
        self.slots
            .iter()
            .filter(|slot| {
                slot.value
                    .as_ref()
                    .and_then(NativeEntityData::as_unit)
                    .is_some()
            })
            .count() as u32
    }

    fn live_entities(&self) -> u32 {
        (self.slots.len() - self.free.len()) as u32
    }

    #[cfg(test)]
    fn get_unit(&self, handle: u32) -> Result<&UnitData, JsErrorBox> {
        self.get(handle)?
            .as_unit()
            .ok_or_else(|| wrong_entity_type(handle, "Unit"))
    }

    fn get_unit_mut(&mut self, handle: u32) -> Result<&mut UnitData, JsErrorBox> {
        self.get_mut(handle)?
            .as_unit_mut()
            .ok_or_else(|| wrong_entity_type(handle, "Unit"))
    }
}

#[op2(fast)]
pub(crate) fn op_native_entity_create(
    entity_type: u32,
    #[buffer] values: &[f64],
) -> Result<u32, JsErrorBox> {
    let value = create_entity(entity_type, values).map_err(JsErrorBox::generic)?;
    STORE.with(|slot| slot.borrow_mut().create(value))
}

#[op2(fast)]
pub(crate) fn op_native_entity_destroy(handle: u32) -> Result<(), JsErrorBox> {
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
        let unit = store.get_unit_mut(handle)?;
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
        let unit = store.get_unit_mut(handle)?;
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

#[op2(fast)]
pub(crate) fn op_native_entity_get_number(handle: u32, field: u32) -> Result<f64, JsErrorBox> {
    native_entity_get_number(handle, field)
}

fn native_entity_get_number(handle: u32, field: u32) -> Result<f64, JsErrorBox> {
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        store.metrics.scalar_gets += 1;
        get_entity_number(store.get(handle)?, field)
            .ok_or_else(|| JsErrorBox::generic(format!("unknown native Entity field: {field}")))
    })
}

#[op2(fast)]
pub(crate) fn op_native_entity_set_number(
    handle: u32,
    field: u32,
    value: f64,
) -> Result<(), JsErrorBox> {
    native_entity_set_number(handle, field, value)
}

fn native_entity_set_number(handle: u32, field: u32, value: f64) -> Result<(), JsErrorBox> {
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        store.metrics.scalar_sets += 1;
        set_entity_number(store.get_mut(handle)?, field, value).map_err(JsErrorBox::generic)
    })
}

#[op2]
pub(crate) fn op_native_map_update_movement(
    map_id: u32,
    server_tick: u32,
    fixed_update_ms: u32,
    message_code: u32,
) -> Result<Uint8Array, JsErrorBox> {
    if fixed_update_ms == 0 {
        return Err(JsErrorBox::generic(
            "fixed update milliseconds must be greater than zero",
        ));
    }
    let message_code = u16::try_from(message_code)
        .map_err(|_| JsErrorBox::generic("movement message code exceeds uint16"))?;
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        store.metrics.batch_calls += 1;
        let records = update_map(&mut store, map_id, server_tick, fixed_update_ms as f32)?;
        let frame = encode_entity_move_frame(message_code, server_tick, &records);
        store.metrics.encoded_frames += 1;
        store.metrics.encoded_items += records.len() as u64;
        store.metrics.encoded_bytes += frame.len() as u64;

        let mut result = Vec::with_capacity(4 + frame.len());
        result.extend_from_slice(&(records.len() as u32).to_le_bytes());
        result.extend_from_slice(&frame);
        Ok(result.into())
    })
}

fn update_map(
    store: &mut NativeEntityStore,
    map_id: u32,
    server_tick: u32,
    fixed_update_ms: f32,
) -> Result<Vec<[u8; NATIVE_UNIT_RECORD_BYTES]>, JsErrorBox> {
    let handles = store.units_by_map.get(&map_id).cloned().unwrap_or_default();
    let mut records = Vec::with_capacity(handles.len());
    for handle in handles {
        let unit = store.get_unit_mut(handle)?;
        let state_changed = update_movement(unit, server_tick, fixed_update_ms);
        if unit.moving != 0 || state_changed {
            records.push(encode_snapshot(unit, state_changed));
        }
    }
    Ok(records)
}

#[op2]
pub(crate) fn op_native_data_take_metrics() -> Uint8Array {
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        let live_entities = store.live_entities();
        let live_units = store.live_units();
        let metrics = std::mem::take(&mut store.metrics);
        let mut bytes = Vec::with_capacity(56);
        bytes.extend_from_slice(&metrics.scalar_gets.to_le_bytes());
        bytes.extend_from_slice(&metrics.scalar_sets.to_le_bytes());
        bytes.extend_from_slice(&metrics.batch_calls.to_le_bytes());
        bytes.extend_from_slice(&live_entities.to_le_bytes());
        bytes.extend_from_slice(&live_units.to_le_bytes());
        bytes.extend_from_slice(&metrics.encoded_frames.to_le_bytes());
        bytes.extend_from_slice(&metrics.encoded_items.to_le_bytes());
        bytes.extend_from_slice(&metrics.encoded_bytes.to_le_bytes());
        bytes.into()
    })
}

fn encode_entity_move_frame(
    message_code: u16,
    server_tick: u32,
    records: &[[u8; NATIVE_UNIT_RECORD_BYTES]],
) -> Vec<u8> {
    let mut frame = Vec::with_capacity(2 + 8 + records.len() * 24);
    frame.extend_from_slice(&message_code.to_be_bytes());
    write_uint32_field(&mut frame, 1, server_tick);
    for record in records {
        write_tag(&mut frame, 2, 2);
        write_varint(&mut frame, cell_movement_encoded_len(record) as u32);
        encode_cell_movement(&mut frame, record);
    }
    frame
}

fn encode_cell_movement(bytes: &mut Vec<u8>, record: &[u8; NATIVE_UNIT_RECORD_BYTES]) {
    write_uint32_field(bytes, 1, read_record_u32(record, 0));
    write_uint32_field(bytes, 2, read_record_u32(record, 12));
    write_sint32_field(bytes, 3, read_record_i32(record, 18));
    write_sint32_field(bytes, 4, read_record_i32(record, 22));
    write_sint32_field(bytes, 5, read_record_i32(record, 26));
    write_sint32_field(bytes, 6, read_record_i32(record, 30));
    write_uint32_field(bytes, 7, read_record_u32(record, 34));
    write_uint32_field(bytes, 8, read_record_u32(record, 38));
    if record[17] != 0 {
        write_tag(bytes, 9, 0);
        bytes.push(1);
    }
}

fn cell_movement_encoded_len(record: &[u8; NATIVE_UNIT_RECORD_BYTES]) -> usize {
    uint32_field_len(1, read_record_u32(record, 0))
        + uint32_field_len(2, read_record_u32(record, 12))
        + sint32_field_len(3, read_record_i32(record, 18))
        + sint32_field_len(4, read_record_i32(record, 22))
        + sint32_field_len(5, read_record_i32(record, 26))
        + sint32_field_len(6, read_record_i32(record, 30))
        + uint32_field_len(7, read_record_u32(record, 34))
        + uint32_field_len(8, read_record_u32(record, 38))
        + usize::from(record[17] != 0) * 2
}

fn uint32_field_len(field_number: u32, value: u32) -> usize {
    if value == 0 {
        return 0;
    }
    varint_len(field_number << 3) + varint_len(value)
}

fn sint32_field_len(field_number: u32, value: i32) -> usize {
    if value == 0 {
        return 0;
    }
    varint_len(field_number << 3) + varint_len(((value << 1) ^ (value >> 31)) as u32)
}

fn varint_len(value: u32) -> usize {
    match value {
        0..=0x7f => 1,
        0x80..=0x3fff => 2,
        0x4000..=0x1f_ffff => 3,
        0x20_0000..=0x0fff_ffff => 4,
        _ => 5,
    }
}

fn write_uint32_field(bytes: &mut Vec<u8>, field_number: u32, value: u32) {
    if value == 0 {
        return;
    }
    write_tag(bytes, field_number, 0);
    write_varint(bytes, value);
}

fn write_sint32_field(bytes: &mut Vec<u8>, field_number: u32, value: i32) {
    if value == 0 {
        return;
    }
    write_tag(bytes, field_number, 0);
    write_varint(bytes, ((value << 1) ^ (value >> 31)) as u32);
}

fn write_tag(bytes: &mut Vec<u8>, field_number: u32, wire_type: u32) {
    write_varint(bytes, (field_number << 3) | wire_type);
}

fn write_varint(bytes: &mut Vec<u8>, mut value: u32) {
    while value >= 0x80 {
        bytes.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    bytes.push(value as u8);
}

fn read_record_u32(record: &[u8; NATIVE_UNIT_RECORD_BYTES], offset: usize) -> u32 {
    u32::from_le_bytes(record[offset..offset + 4].try_into().unwrap())
}

fn read_record_i32(record: &[u8; NATIVE_UNIT_RECORD_BYTES], offset: usize) -> i32 {
    i32::from_le_bytes(record[offset..offset + 4].try_into().unwrap())
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
    JsErrorBox::generic(format!("native Entity handle is stale: {handle}"))
}

fn wrong_entity_type(handle: u32, expected: &str) -> JsErrorBox {
    JsErrorBox::generic(format!("native Entity handle {handle} is not a {expected}"))
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
        let mut store = NativeEntityStore::default();
        let first = store.create(NativeEntityData::Unit(unit(1))).unwrap();
        store.destroy(first).unwrap();
        let second = store.create(NativeEntityData::Unit(unit(2))).unwrap();
        assert_ne!(first, second);
        assert!(store.get(first).is_err());
        assert_eq!(store.get_unit(second).unwrap().entity.id, 2);
    }

    #[test]
    fn generated_scalar_accessors_keep_values_in_rust_store() {
        let mut store = NativeEntityStore::default();
        let handle = store.create(NativeEntityData::Unit(unit(1))).unwrap();
        let value = store.get_unit_mut(handle).unwrap();

        set_unit_number(value, crate::generated::native_data::UNIT_FIELD_X, 12.5).unwrap();
        assert_eq!(
            get_unit_number(value, crate::generated::native_data::UNIT_FIELD_X),
            Some(12.5),
        );
        assert!(
            set_unit_number(value, crate::generated::native_data::UNIT_FIELD_ID, 2.0,).is_err()
        );
        assert!(
            set_unit_number(value, crate::generated::native_data::UNIT_FIELD_CELL_X, 1.5,).is_err()
        );
    }

    #[test]
    fn fast_scalar_ops_allow_read_modify_write_without_policy_gate() {
        let handle = STORE.with(|slot| {
            let mut store = slot.borrow_mut();
            *store = NativeEntityStore::default();
            store.create(NativeEntityData::Unit(unit(10))).unwrap()
        });
        let field = crate::generated::native_data::UNIT_FIELD_X;

        let x = native_entity_get_number(handle, field).unwrap();
        native_entity_set_number(handle, field, x + 1.0).unwrap();
        assert_eq!(native_entity_get_number(handle, field).unwrap(), 1.0);

        STORE.with(|slot| {
            let store = slot.borrow();
            assert_eq!(store.metrics.scalar_gets, 2);
            assert_eq!(store.metrics.scalar_sets, 1);
            assert_eq!(store.get_unit(handle).unwrap().x, 1.0);
        });
    }

    #[test]
    fn item_uses_the_same_generation_arena_and_scalar_ops() {
        use crate::generated::native_data::{
            ENTITY_TYPE_ITEM, ITEM_FIELD_CONFIG_ID, ITEM_FIELD_COUNT,
        };

        let value =
            create_entity(ENTITY_TYPE_ITEM, &[100.0, 200.0, 3001.0, 2.0, 4.0, 1.0]).unwrap();
        let mut store = NativeEntityStore::default();
        let handle = store.create(value).unwrap();
        assert_eq!(
            get_entity_number(store.get(handle).unwrap(), ITEM_FIELD_CONFIG_ID),
            Some(3001.0)
        );
        set_entity_number(store.get_mut(handle).unwrap(), ITEM_FIELD_COUNT, 3.0).unwrap();
        assert_eq!(
            get_entity_number(store.get(handle).unwrap(), ITEM_FIELD_COUNT),
            Some(3.0)
        );
        assert!(store.get_unit(handle).is_err());
        store.destroy(handle).unwrap();
        assert!(store.get(handle).is_err());
    }

    #[test]
    fn numeric_uses_generated_field_ids_and_scalar_ops() {
        use crate::generated::native_data::{
            ENTITY_TYPE_NUMERIC, NUMERIC_FIELD_CURRENT_HP, NUMERIC_FIELD_MAX_HP,
        };

        let value = create_entity(ENTITY_TYPE_NUMERIC, &[100.0, 200.0, 100.0, 1000.0]).unwrap();
        let mut store = NativeEntityStore::default();
        let handle = store.create(value).unwrap();
        assert_eq!(
            get_entity_number(store.get(handle).unwrap(), NUMERIC_FIELD_CURRENT_HP),
            Some(100.0)
        );
        set_entity_number(
            store.get_mut(handle).unwrap(),
            NUMERIC_FIELD_CURRENT_HP,
            101.0,
        )
        .unwrap();
        assert_eq!(
            get_entity_number(store.get(handle).unwrap(), NUMERIC_FIELD_CURRENT_HP),
            Some(101.0)
        );
        assert_eq!(
            get_entity_number(store.get(handle).unwrap(), NUMERIC_FIELD_MAX_HP),
            Some(1000.0)
        );
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
    fn movement_matches_regression_fixture() {
        let fixture: MovementFixture =
            serde_json::from_str(include_str!("../native_data/movement_regression.json")).unwrap();
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
                "Rust movement regression failed at tick {}",
                step.tick
            );
        }
    }

    #[test]
    fn entity_move_frame_matches_typescript_protobuf() {
        let mut value = unit(1);
        value.sequence = 5;
        value.cell_x = 3;
        value.cell_y = 1;
        value.target_cell_x = 3;
        value.target_cell_y = 1;
        value.move_start_tick = 15;
        value.move_end_tick = 18;
        let record = encode_snapshot(&value, false);

        assert_eq!(
            encode_entity_move_frame(10_016, 18, &[record]),
            hex("272008121210080110051806200228063002380f4012"),
        );
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
            speed_cells_per_second: 10.0,
            input_x: 0,
            input_y: 0,
            input_changed: 0,
            sequence: 0,
        }
    }

    fn hex(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let text = std::str::from_utf8(pair).unwrap();
                u8::from_str_radix(text, 16).unwrap()
            })
            .collect()
    }
}
