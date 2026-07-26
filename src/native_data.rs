//! 管理带世代校验的 Entity 数据、脏版本和 Rust 侧 protobuf 投影。 / Owns generation-checked Entity data, dirty revisions, and Rust-side protobuf projection.

use std::cell::RefCell;
use std::collections::HashMap;

use deno_core::convert::Uint8Array;
use deno_core::op2;
use deno_error::JsErrorBox;

#[cfg(test)]
use crate::generated::native_data::{EntityData, get_unit_number, set_unit_number};
use crate::generated::native_data::{
    NativeEntityData, UnitData, UnitDelta, ack_unit_delta, create_entity, get_entity_number,
    peek_unit_delta, set_entity_number,
};

const INDEX_BITS: u32 = 20;
const INDEX_MASK: u32 = (1 << INDEX_BITS) - 1;
const MAX_GENERATION: u32 = (1 << (32 - INDEX_BITS)) - 1;
const NATIVE_UNIT_RECORD_BYTES: usize = 46;
const CELL_SIZE: f32 = 12.0;
const MIN_UNIT_CELL: i32 = -63;
const MAX_UNIT_CELL: i32 = 62;

thread_local! {
    static STORE: RefCell<NativeEntityStore> = RefCell::new(NativeEntityStore::default());
}

#[derive(Clone, Default)]
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
struct NumericData {
    values: HashMap<u32, i32>,
    dirty: HashMap<u32, u64>,
}

#[derive(Default)]
struct NativeEntityStore {
    slots: Vec<EntitySlot>,
    free: Vec<usize>,
    units_by_map: HashMap<u32, Vec<u32>>,
    numerics_by_unit: HashMap<u32, NumericData>,
    numeric_revision: u64,
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
            self.numerics_by_unit.remove(&handle);
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

impl NativeEntityStore {
    fn next_numeric_revision(&mut self) -> u64 {
        self.numeric_revision = self.numeric_revision.wrapping_add(1);
        if self.numeric_revision == 0 {
            self.numeric_revision = 1;
        }
        self.numeric_revision
    }
}

#[op2(fast)]
/// 在 Rust Arena 中分配生成 Entity，并返回带世代校验的句柄。 / Allocates a generated Entity in the Rust Arena and returns a generation-checked handle.
pub(crate) fn op_native_entity_create(
    entity_type: u32,
    #[buffer] values: &[f64],
) -> Result<u32, JsErrorBox> {
    let value = create_entity(entity_type, values).map_err(JsErrorBox::generic)?;
    STORE.with(|slot| slot.borrow_mut().create(value))
}

#[op2(fast)]
/// 销毁一个 Arena Entity；此后通过旧句柄执行的操作会被拒绝。 / Destroys one Arena entity; later operations through the stale handle are rejected.
pub(crate) fn op_native_entity_destroy(handle: u32) -> Result<(), JsErrorBox> {
    STORE.with(|slot| slot.borrow_mut().destroy(handle))
}

#[op2(fast)]
/// 更新 Unit 移动意图，但不推进模拟，也不回调 TS。 / Updates Unit movement intent without advancing simulation or calling back into TS.
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
/// 在重连或 Session 所有权变化时清除当前及排队移动。 / Clears current and queued movement for reconnect/session ownership changes.
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
        let x = cell_to_world(unit.cell_x);
        let y = cell_to_world(unit.cell_y);
        crate::generated::native_data::set_unit_number(
            unit,
            crate::generated::native_data::UNIT_FIELD_X,
            x as f64,
        )
        .map_err(JsErrorBox::generic)?;
        crate::generated::native_data::set_unit_number(
            unit,
            crate::generated::native_data::UNIT_FIELD_Y,
            y as f64,
        )
        .map_err(JsErrorBox::generic)?;
        Ok(())
    })
}

#[op2(fast)]
/// 读取一个生成的标量字段；可观测性阈值永远不会拒绝该操作。 / Reads one generated scalar field; observability thresholds never reject the operation.
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
/// 写入一个生成标量，并由 codegen 管理的元数据标记同步字段为脏。 / Writes one generated scalar and lets codegen-managed metadata mark replicated fields dirty.
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

#[op2(fast)]
/// 为尚未拥有 Numeric 的 Unit 挂载空 Numeric 字典。 / Attaches an empty Numeric dictionary to a Unit that does not already own one.
pub(crate) fn op_native_numeric_attach(unit_handle: u32) -> Result<(), JsErrorBox> {
    native_numeric_attach(unit_handle)
}

fn native_numeric_attach(unit_handle: u32) -> Result<(), JsErrorBox> {
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        store.get_unit(unit_handle)?;
        if store.numerics_by_unit.contains_key(&unit_handle) {
            return Err(JsErrorBox::generic("native Numeric is already attached"));
        }
        store
            .numerics_by_unit
            .insert(unit_handle, NumericData::default());
        Ok(())
    })
}

#[op2(fast)]
/// Component 销毁时移除 Numeric 数值和脏版本。 / Removes Numeric values and dirty revisions during Component disposal.
pub(crate) fn op_native_numeric_detach(unit_handle: u32) -> Result<(), JsErrorBox> {
    native_numeric_detach(unit_handle)
}

fn native_numeric_detach(unit_handle: u32) -> Result<(), JsErrorBox> {
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        if store.numerics_by_unit.remove(&unit_handle).is_none() {
            return Err(JsErrorBox::generic("native Numeric is not attached"));
        }
        Ok(())
    })
}

#[op2(fast)]
/// 从 Rust 权威数据读取一个 NumericType；未设置的 key 返回零。 / Reads one NumericType from Rust authority and returns zero for an unset key.
pub(crate) fn op_native_numeric_get(
    unit_handle: u32,
    numeric_type: u32,
) -> Result<i32, JsErrorBox> {
    native_numeric_get(unit_handle, numeric_type)
}

fn native_numeric_get(unit_handle: u32, numeric_type: u32) -> Result<i32, JsErrorBox> {
    STORE.with(|slot| {
        let store = slot.borrow();
        store.get_unit(unit_handle)?;
        let numeric = store
            .numerics_by_unit
            .get(&unit_handle)
            .ok_or_else(|| JsErrorBox::generic("native Numeric is not attached"))?;
        Ok(*numeric.values.get(&numeric_type).unwrap_or(&0))
    })
}

#[op2(fast)]
/// 写入一个 NumericType；数值变化时递增其独立脏版本。 / Writes one NumericType and increments its independent dirty revision on change.
pub(crate) fn op_native_numeric_set(
    unit_handle: u32,
    numeric_type: u32,
    value: i32,
) -> Result<bool, JsErrorBox> {
    native_numeric_set(unit_handle, numeric_type, value)
}

fn native_numeric_set(unit_handle: u32, numeric_type: u32, value: i32) -> Result<bool, JsErrorBox> {
    if numeric_type == 0 {
        return Err(JsErrorBox::generic(
            "numeric type must be greater than zero",
        ));
    }
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        store.get_unit(unit_handle)?;
        let current = store
            .numerics_by_unit
            .get(&unit_handle)
            .ok_or_else(|| JsErrorBox::generic("native Numeric is not attached"))?
            .values
            .get(&numeric_type)
            .copied()
            .unwrap_or(0);
        if current == value {
            return Ok(false);
        }
        let revision = store.next_numeric_revision();
        let numeric = store.numerics_by_unit.get_mut(&unit_handle).unwrap();
        numeric.values.insert(numeric_type, value);
        numeric.dirty.insert(numeric_type, revision);
        Ok(true)
    })
}

#[op2]
/// 编码脏 Numeric 条目及版本令牌，但不清除脏状态。 / Encodes dirty Numeric entries plus revision tokens without clearing them.
pub(crate) fn op_native_map_peek_numeric_delta(
    map_id: u32,
    server_tick: u32,
    message_code: u32,
) -> Result<Uint8Array, JsErrorBox> {
    native_map_peek_numeric_delta(map_id, server_tick, message_code).map(Into::into)
}

fn native_map_peek_numeric_delta(
    map_id: u32,
    server_tick: u32,
    message_code: u32,
) -> Result<Vec<u8>, JsErrorBox> {
    let message_code = u16::try_from(message_code)
        .map_err(|_| JsErrorBox::generic("numeric message code exceeds uint16"))?;
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        let through_revision = store.numeric_revision;
        let handles = store.units_by_map.get(&map_id).cloned().unwrap_or_default();
        let mut records = Vec::new();
        for handle in handles {
            let unit_id = store.get_unit(handle)?.entity.id;
            if let Some(numeric) = store.numerics_by_unit.get(&handle) {
                for (&numeric_type, &revision) in &numeric.dirty {
                    if revision <= through_revision {
                        records.push((unit_id, numeric_type, numeric.values[&numeric_type]));
                    }
                }
            }
        }
        records.sort_unstable_by_key(|record| (record.0, record.1));
        let frame = encode_entity_numeric_frame(message_code, server_tick, &records);
        store.metrics.batch_calls += 1;
        store.metrics.encoded_frames += 1;
        store.metrics.encoded_items += records.len() as u64;
        store.metrics.encoded_bytes += frame.len() as u64;

        let mut result = Vec::with_capacity(12 + frame.len());
        result.extend_from_slice(&(records.len() as u32).to_le_bytes());
        result.extend_from_slice(&through_revision.to_le_bytes());
        result.extend_from_slice(&frame);
        Ok(result)
    })
}

#[op2(fast)]
/// 只清除当前版本仍与已投递 Peek 匹配的 Numeric 条目。 / Clears only Numeric entries whose current revisions match a delivered peek.
pub(crate) fn op_native_map_ack_numeric_delta(
    map_id: u32,
    #[buffer] revision: &[u8],
) -> Result<(), JsErrorBox> {
    native_map_ack_numeric_delta(map_id, revision)
}

fn native_map_ack_numeric_delta(map_id: u32, revision: &[u8]) -> Result<(), JsErrorBox> {
    let revision = u64::from_le_bytes(
        revision
            .try_into()
            .map_err(|_| JsErrorBox::generic("numeric revision must contain 8 bytes"))?,
    );
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        let handles = store.units_by_map.get(&map_id).cloned().unwrap_or_default();
        for handle in handles {
            if let Some(numeric) = store.numerics_by_unit.get_mut(&handle) {
                numeric
                    .dirty
                    .retain(|_, dirty_revision| *dirty_revision > revision);
            }
        }
        Ok(())
    })
}

#[op2(fast)]
/// 确认生成固定字段的已投递版本，同时保留较新的写入。 / Acknowledges generated fixed-field revisions while preserving newer writes.
pub(crate) fn op_native_map_ack_unit_delta(
    map_id: u32,
    #[buffer] revision: &[u8],
) -> Result<(), JsErrorBox> {
    native_map_ack_unit_delta(map_id, revision)
}

#[op2]
/// 将生成固定字段的脏 mask 直接编码为客户端 protobuf 帧。 / Encodes generated fixed-field dirty masks directly to a client protobuf frame.
pub(crate) fn op_native_map_peek_unit_delta(
    map_id: u32,
    server_tick: u32,
    message_code: u32,
) -> Result<Uint8Array, JsErrorBox> {
    native_map_peek_unit_delta(map_id, server_tick, message_code).map(Into::into)
}

fn native_map_peek_unit_delta(
    map_id: u32,
    server_tick: u32,
    message_code: u32,
) -> Result<Vec<u8>, JsErrorBox> {
    let message_code = u16::try_from(message_code)
        .map_err(|_| JsErrorBox::generic("unit state message code exceeds uint16"))?;
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        let handles = store.units_by_map.get(&map_id).cloned().unwrap_or_default();
        let mut records = Vec::new();
        for handle in handles {
            let unit = store.get_unit(handle)?;
            if let Some(delta) = peek_unit_delta(unit) {
                records.push(UnitDeltaRecord {
                    handle,
                    unit_id: unit.entity.id,
                    delta,
                });
            }
        }
        records.sort_unstable_by_key(|record| record.unit_id);
        let frame = encode_entity_state_frame(message_code, server_tick, &records);
        let mut revision = Vec::with_capacity(4 + records.len() * 12);
        revision.extend_from_slice(&(records.len() as u32).to_le_bytes());
        for record in &records {
            revision.extend_from_slice(&record.handle.to_le_bytes());
            revision.extend_from_slice(&record.delta.revision.to_le_bytes());
        }
        store.metrics.batch_calls += 1;
        store.metrics.encoded_frames += 1;
        store.metrics.encoded_items += records.len() as u64;
        store.metrics.encoded_bytes += frame.len() as u64;

        let mut result = Vec::with_capacity(8 + revision.len() + frame.len());
        result.extend_from_slice(&(records.len() as u32).to_le_bytes());
        result.extend_from_slice(&(revision.len() as u32).to_le_bytes());
        result.extend_from_slice(&revision);
        result.extend_from_slice(&frame);
        Ok(result)
    })
}

fn native_map_ack_unit_delta(map_id: u32, revision: &[u8]) -> Result<(), JsErrorBox> {
    if revision.len() < 4 {
        return Err(JsErrorBox::generic("unit state revision is truncated"));
    }
    let count = u32::from_le_bytes(revision[0..4].try_into().unwrap()) as usize;
    if revision.len() != 4 + count * 12 {
        return Err(JsErrorBox::generic(
            "unit state revision has an invalid length",
        ));
    }
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        for index in 0..count {
            let offset = 4 + index * 12;
            let handle = u32::from_le_bytes(revision[offset..offset + 4].try_into().unwrap());
            let through_revision =
                u64::from_le_bytes(revision[offset + 4..offset + 12].try_into().unwrap());
            if let Ok(unit) = store.get_unit_mut(handle)
                && unit.map_id == map_id
            {
                ack_unit_delta(unit, through_revision);
            }
        }
        Ok(())
    })
}

struct UnitDeltaRecord {
    handle: u32,
    unit_id: u32,
    delta: UnitDelta,
}

#[op2]
/// 推进一张地图中的全部 Unit，并返回 Rust 编码的可覆盖移动快照。 / Advances all Units in one map and returns a Rust-encoded replaceable movement snapshot.
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
/// 序列化 NativeData 生命周期累计计数器，供 TS 与 Prometheus 读取。
///
/// 这些值遵循 Prometheus Counter 的单调递增语义；调用方不得把读取动作当作清零边界。
/// Serializes lifetime NativeData counters for TS and Prometheus. Values are monotonic and a
/// read must never be treated as a reset boundary.
pub(crate) fn op_native_data_take_metrics() -> Uint8Array {
    STORE.with(|slot| {
        let store = slot.borrow();
        let live_entities = store.live_entities();
        let live_units = store.live_units();
        let metrics = store.metrics.clone();
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

fn encode_entity_numeric_frame(
    message_code: u16,
    server_tick: u32,
    records: &[(u32, u32, i32)],
) -> Vec<u8> {
    let mut frame = Vec::with_capacity(2 + 8 + records.len() * 14);
    frame.extend_from_slice(&message_code.to_be_bytes());
    write_uint32_field(&mut frame, 1, server_tick);
    for &(unit_id, numeric_type, value) in records {
        let item_len = uint32_field_len(1, unit_id)
            + uint32_field_len(2, numeric_type)
            + sint32_field_len(3, value);
        write_tag(&mut frame, 2, 2);
        write_varint(&mut frame, item_len as u32);
        write_uint32_field(&mut frame, 1, unit_id);
        write_uint32_field(&mut frame, 2, numeric_type);
        write_sint32_field(&mut frame, 3, value);
    }
    frame
}

fn encode_entity_state_frame(
    message_code: u16,
    server_tick: u32,
    records: &[UnitDeltaRecord],
) -> Vec<u8> {
    let mut frame = Vec::with_capacity(2 + 8 + records.len() * 36);
    frame.extend_from_slice(&message_code.to_be_bytes());
    write_uint32_field(&mut frame, 1, server_tick);
    for record in records {
        let mut item = Vec::with_capacity(32);
        write_uint32_field(&mut item, 1, record.unit_id);
        write_uint32_field(&mut item, 2, record.delta.dirty_mask as u32);
        write_uint32_field(&mut item, 3, (record.delta.dirty_mask >> 32) as u32);
        if let Some(value) = record.delta.x {
            write_float_field(&mut item, 4, value);
        }
        if let Some(value) = record.delta.y {
            write_float_field(&mut item, 5, value);
        }
        if let Some(value) = record.delta.speed_cells_per_second {
            write_float_field(&mut item, 6, value);
        }
        if let Some(value) = record.delta.alive {
            write_bool_field(&mut item, 7, value != 0);
        }
        write_tag(&mut frame, 2, 2);
        write_varint(&mut frame, item.len() as u32);
        frame.extend_from_slice(&item);
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
    write_uint32_field(bytes, 10, read_record_u32(record, 42));
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
        + uint32_field_len(10, read_record_u32(record, 42))
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

fn write_float_field(bytes: &mut Vec<u8>, field_number: u32, value: f32) {
    if value == 0.0 {
        return;
    }
    write_tag(bytes, field_number, 5);
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn write_bool_field(bytes: &mut Vec<u8>, field_number: u32, value: bool) {
    if !value {
        return;
    }
    write_tag(bytes, field_number, 0);
    bytes.push(1);
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
        unit.facing = facing_from_input(unit.input_x, unit.input_y);
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
    bytes[42..46].copy_from_slice(&unit.facing.to_le_bytes());
    bytes
}

fn facing_from_input(input_x: i8, input_y: i8) -> u32 {
    if input_y > 0 {
        3
    } else if input_y < 0 {
        0
    } else if input_x < 0 {
        1
    } else if input_x > 0 {
        2
    } else {
        0
    }
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
    fn metrics_snapshot_does_not_reset_prometheus_counters() {
        STORE.with(|slot| {
            let mut store = slot.borrow_mut();
            *store = NativeEntityStore::default();
            store.metrics.scalar_gets = 7;
            store.metrics.encoded_bytes = 128;
        });

        let _first = op_native_data_take_metrics();
        let _second = op_native_data_take_metrics();

        STORE.with(|slot| {
            let store = slot.borrow();
            assert_eq!(store.metrics.scalar_gets, 7);
            assert_eq!(store.metrics.encoded_bytes, 128);
        });
    }

    #[test]
    fn item_uses_the_same_generation_arena_and_scalar_ops() {
        use crate::generated::native_data::{
            ENTITY_TYPE_ITEM, ITEM_FIELD_CONFIG_ID, ITEM_FIELD_COUNT,
        };

        let value = create_entity(
            ENTITY_TYPE_ITEM,
            &[100.0, 200.0, 3001.0, 2.0, 4.0, 1.0, 1.0],
        )
        .unwrap();
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
    fn fixed_unit_delta_keeps_newer_changes_after_old_ack() {
        use crate::generated::native_data::{
            UNIT_FIELD_X, ack_unit_delta, peek_unit_delta, set_unit_number,
        };

        let mut value = unit(1);
        assert!(peek_unit_delta(&value).is_none());
        set_unit_number(&mut value, UNIT_FIELD_X, 12.0).unwrap();
        let first = peek_unit_delta(&value).unwrap();
        assert_eq!(first.x, Some(12.0));

        set_unit_number(&mut value, UNIT_FIELD_X, 24.0).unwrap();
        ack_unit_delta(&mut value, first.revision);
        let second = peek_unit_delta(&value).unwrap();
        assert_eq!(second.x, Some(24.0));
        assert!(second.revision > first.revision);

        ack_unit_delta(&mut value, second.revision);
        assert!(peek_unit_delta(&value).is_none());
    }

    #[test]
    fn numeric_dictionary_keeps_dirty_values_until_acknowledged() {
        let handle = STORE.with(|slot| {
            let mut store = slot.borrow_mut();
            *store = NativeEntityStore::default();
            store.create(NativeEntityData::Unit(unit(10))).unwrap()
        });
        native_numeric_attach(handle).unwrap();
        assert!(native_numeric_set(handle, 1, 100).unwrap());
        assert!(!native_numeric_set(handle, 1, 100).unwrap());
        assert!(native_numeric_set(handle, 2, 1000).unwrap());
        assert_eq!(native_numeric_get(handle, 1).unwrap(), 100);

        let first = native_map_peek_numeric_delta(1, 7, 10017).unwrap();
        assert_eq!(u32::from_le_bytes(first[0..4].try_into().unwrap()), 2);
        let revision = first[4..12].to_vec();
        let repeated = native_map_peek_numeric_delta(1, 8, 10017).unwrap();
        assert_eq!(u32::from_le_bytes(repeated[0..4].try_into().unwrap()), 2);

        native_map_ack_numeric_delta(1, &revision).unwrap();
        let empty = native_map_peek_numeric_delta(1, 9, 10017).unwrap();
        assert_eq!(u32::from_le_bytes(empty[0..4].try_into().unwrap()), 0);
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
        value.facing = 2;
        let record = encode_snapshot(&value, false);

        assert_eq!(
            encode_entity_move_frame(10_016, 18, &[record]),
            hex("272008121212080110051806200228063002380f40125002"),
        );
    }

    #[test]
    fn facing_uses_vertical_priority_and_keeps_cardinal_values() {
        assert_eq!(facing_from_input(0, -1), 0);
        assert_eq!(facing_from_input(-1, 0), 1);
        assert_eq!(facing_from_input(1, 0), 2);
        assert_eq!(facing_from_input(0, 1), 3);
        assert_eq!(facing_from_input(1, 1), 3);
    }

    fn unit(id: u32) -> UnitData {
        UnitData {
            __dirty_mask: 0,
            __revision: 0,
            __member_revisions: [0; 64],
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
            facing: 0,
            speed_cells_per_second: 10.0,
            alive: 1,
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
