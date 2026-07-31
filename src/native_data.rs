//! 管理带世代校验的 Entity 数据、脏版本和 Rust 侧 protobuf 投影。 / Owns generation-checked Entity data, dirty revisions, and Rust-side protobuf projection.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use deno_core::convert::Uint8Array;
use deno_core::op2;
use deno_error::JsErrorBox;

use crate::aoi::{AoiWorld, SyncTier, VisibilityChange};
#[cfg(test)]
use crate::generated::native_data::{EntityData, UnitData, UnitSplitData};
use crate::generated::native_data::{
    NativeEntityData, NativeEntityPools, NativePoolLocation, UnitColdData, UnitDelta, UnitHotData,
    ack_unit_split_delta, create_entity, peek_unit_split_delta,
};

const INDEX_BITS: u32 = 20;
const INDEX_MASK: u32 = (1 << INDEX_BITS) - 1;
const MAX_GENERATION: u32 = (1 << (32 - INDEX_BITS)) - 1;
const NATIVE_UNIT_RECORD_BYTES: usize = 46;
#[derive(Clone, Copy)]
struct Grid2DBounds {
    min_x: i32,
    max_x: i32,
    min_z: i32,
    max_z: i32,
    cell_size_meters: f32,
    origin_x_millimeters: i64,
    origin_z_millimeters: i64,
}

impl Grid2DBounds {
    fn new(
        width_cells: u32,
        depth_cells: u32,
        cell_size_millimeters: u32,
    ) -> Result<Self, JsErrorBox> {
        if !(3..=1_000_000).contains(&width_cells) || !(3..=1_000_000).contains(&depth_cells) {
            return Err(JsErrorBox::generic(
                "map dimensions must be between 3 and 1000000 cells",
            ));
        }
        if !(1..=1_000_000).contains(&cell_size_millimeters) {
            return Err(JsErrorBox::generic(
                "grid cell size must be between 1 and 1000000 millimeters",
            ));
        }
        let width = width_cells as i32;
        let depth = depth_cells as i32;
        let cell_size_millimeters = i64::from(cell_size_millimeters);
        Ok(Self {
            min_x: -(width / 2) + 1,
            max_x: (width - 1) / 2 - 1,
            min_z: -(depth / 2) + 1,
            max_z: (depth - 1) / 2 - 1,
            cell_size_meters: cell_size_millimeters as f32 / 1_000.0,
            // Cell 坐标以地图中心附近的 0 为基准；AOI Grid 必须从地图最小 Cell
            // 开始分组，否则奇数个 Grid 的地图会被世界零点额外切出一列。
            // Cell coordinates remain centered around zero, while AOI grids are anchored
            // at the map's minimum cell so odd-sized worlds retain their configured grid count.
            origin_x_millimeters: -i64::from(width / 2) * cell_size_millimeters,
            origin_z_millimeters: -i64::from(depth / 2) * cell_size_millimeters,
        })
    }

    fn contains(self, x: i32, z: i32) -> bool {
        (self.min_x..=self.max_x).contains(&x) && (self.min_z..=self.max_z).contains(&z)
    }
}

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
    scratch_growths: u64,
    aoi_relocations: u64,
    aoi_visibility_changes: u64,
    aoi_filter_overrides: u64,
}

struct EntitySlot {
    generation: u32,
    location: Option<NativePoolLocation>,
}

#[derive(Default)]
struct NumericData {
    values: HashMap<u32, i32>,
    dirty: HashMap<u32, u64>,
}

fn take_scratch<T>(slot: &mut Vec<T>) -> Vec<T> {
    let mut scratch = std::mem::take(slot);
    scratch.clear();
    scratch
}

#[derive(Default)]
struct NativeEntityStore {
    slots: Vec<EntitySlot>,
    free: Vec<usize>,
    pools: NativeEntityPools,
    units_by_map: HashMap<u32, Vec<u32>>,
    grid_2d_bounds: HashMap<u32, Grid2DBounds>,
    aoi_worlds: HashMap<u32, AoiWorld>,
    aoi_dirty_by_map: HashMap<u32, HashSet<u32>>,
    numerics_by_unit: HashMap<u32, NumericData>,
    scratch_handles: Vec<u32>,
    scratch_movement_records: Vec<[u8; NATIVE_UNIT_RECORD_BYTES]>,
    scratch_changed_positions: Vec<(u32, f32, f32)>,
    pending_movement_records: HashMap<u32, Vec<[u8; NATIVE_UNIT_RECORD_BYTES]>>,
    scratch_numeric_records: Vec<(u32, u32, i32)>,
    scratch_unit_delta_records: Vec<UnitDeltaRecord>,
    numeric_revision: u64,
    metrics: NativeDataMetrics,
}

impl NativeEntityStore {
    fn create(&mut self, value: NativeEntityData) -> Result<u32, JsErrorBox> {
        if self.free.is_empty() && self.slots.len() >= INDEX_MASK as usize {
            return Err(JsErrorBox::generic(
                "native Entity handle directory is full",
            ));
        }
        let unit_map_id = value.as_unit().map(|unit| unit.map_id);
        let location = self.pools.insert(value);
        let index = if let Some(index) = self.free.pop() {
            self.slots[index].location = Some(location);
            index
        } else {
            let index = self.slots.len();
            self.slots.push(EntitySlot {
                generation: 1,
                location: Some(location),
            });
            index
        };
        let handle = encode_handle(index, self.slots[index].generation);
        if let Some(map_id) = unit_map_id {
            self.units_by_map.entry(map_id).or_default().push(handle);
        }
        Ok(handle)
    }

    fn location(&self, handle: u32) -> Result<NativePoolLocation, JsErrorBox> {
        let (index, generation) = decode_handle(handle)?;
        let slot = self.slots.get(index).ok_or_else(|| stale_handle(handle))?;
        if slot.generation != generation {
            return Err(stale_handle(handle));
        }
        slot.location.ok_or_else(|| stale_handle(handle))
    }

    fn get_number(&self, handle: u32, field: u32) -> Result<f64, JsErrorBox> {
        self.pools
            .get_number(self.location(handle)?, field)
            .ok_or_else(|| JsErrorBox::generic(format!("unknown native Entity field: {field}")))
    }

    fn set_number(&mut self, handle: u32, field: u32, value: f64) -> Result<(), JsErrorBox> {
        let location = self.location(handle)?;
        let spatial_map = if matches!(
            field,
            crate::generated::native_data::UNIT_FIELD_X
                | crate::generated::native_data::UNIT_FIELD_Z
        ) {
            self.pools.get_unit_cold(location).map(|unit| unit.map_id)
        } else {
            None
        };
        self.pools
            .set_number(location, field, value)
            .map_err(JsErrorBox::generic)?;
        if let Some(map_id) = spatial_map
            && self.aoi_worlds.contains_key(&map_id)
        {
            self.aoi_dirty_by_map
                .entry(map_id)
                .or_default()
                .insert(handle);
        }
        Ok(())
    }

    fn destroy(&mut self, handle: u32) -> Result<(), JsErrorBox> {
        let (index, generation) = decode_handle(handle)?;
        let location = self.location(handle)?;
        let unit_identity = self
            .pools
            .get_unit_parts(location)
            .map(|(hot, cold)| (hot.id, cold.map_id));
        if let Some((unit_id, map_id)) = unit_identity
            && self
                .aoi_worlds
                .get(&map_id)
                .is_some_and(|world| world.is_attached(unit_id))
        {
            return Err(JsErrorBox::generic(format!(
                "native Unit {unit_id} must detach from AOI before destroy"
            )));
        }
        if !self.pools.remove(location) {
            return Err(stale_handle(handle));
        }
        if let Some((_, map_id)) = unit_identity {
            self.numerics_by_unit.remove(&handle);
            if let Some(dirty) = self.aoi_dirty_by_map.get_mut(&map_id) {
                dirty.remove(&handle);
                if dirty.is_empty() {
                    self.aoi_dirty_by_map.remove(&map_id);
                }
            }
            if let Some(handles) = self.units_by_map.get_mut(&map_id) {
                handles.retain(|candidate| *candidate != handle);
                if handles.is_empty() {
                    self.units_by_map.remove(&map_id);
                }
            }
        }
        let slot = self
            .slots
            .get_mut(index)
            .ok_or_else(|| stale_handle(handle))?;
        debug_assert_eq!(slot.generation, generation);
        slot.location = None;
        slot.generation = if slot.generation >= MAX_GENERATION {
            1
        } else {
            slot.generation + 1
        };
        self.free.push(index);
        Ok(())
    }

    fn live_units(&self) -> u32 {
        self.pools.live_unit() as u32
    }

    fn live_entities(&self) -> u32 {
        self.pools.live_entities() as u32
    }

    fn live_items(&self) -> u32 {
        self.pools.live_item() as u32
    }

    fn pool_capacity_bytes(&self) -> u64 {
        self.pools.estimated_capacity_bytes() as u64
    }

    fn scratch_capacity_bytes(&self) -> u64 {
        let pending_movement_capacity: usize = self
            .pending_movement_records
            .values()
            .map(Vec::capacity)
            .sum();
        (self.scratch_handles.capacity() * std::mem::size_of::<u32>()
            + self.scratch_movement_records.capacity()
                * std::mem::size_of::<[u8; NATIVE_UNIT_RECORD_BYTES]>()
            + pending_movement_capacity * std::mem::size_of::<[u8; NATIVE_UNIT_RECORD_BYTES]>()
            + self.scratch_numeric_records.capacity() * std::mem::size_of::<(u32, u32, i32)>()
            + self.scratch_unit_delta_records.capacity() * std::mem::size_of::<UnitDeltaRecord>())
            as u64
    }

    fn take_map_handles(&mut self, map_id: u32) -> Vec<u32> {
        let mut handles = take_scratch(&mut self.scratch_handles);
        let previous_capacity = handles.capacity();
        if let Some(source) = self.units_by_map.get(&map_id) {
            handles.extend_from_slice(source);
        }
        self.metrics.scratch_growths += u64::from(handles.capacity() > previous_capacity);
        handles
    }

    fn get_unit_hot(&self, handle: u32) -> Result<&UnitHotData, JsErrorBox> {
        self.pools
            .get_unit_hot(self.location(handle)?)
            .ok_or_else(|| wrong_entity_type(handle, "Unit"))
    }

    fn get_unit_hot_mut(&mut self, handle: u32) -> Result<&mut UnitHotData, JsErrorBox> {
        let location = self.location(handle)?;
        self.pools
            .get_unit_hot_mut(location)
            .ok_or_else(|| wrong_entity_type(handle, "Unit"))
    }

    fn get_unit_parts(&self, handle: u32) -> Result<(&UnitHotData, &UnitColdData), JsErrorBox> {
        self.pools
            .get_unit_parts(self.location(handle)?)
            .ok_or_else(|| wrong_entity_type(handle, "Unit"))
    }

    fn get_unit_cold_mut(&mut self, handle: u32) -> Result<&mut UnitColdData, JsErrorBox> {
        let location = self.location(handle)?;
        self.pools
            .get_unit_cold_mut(location)
            .ok_or_else(|| wrong_entity_type(handle, "Unit"))
    }

    fn unit_spatial(&self, handle: u32) -> Result<(u32, u32, f32, f32), JsErrorBox> {
        let (hot, cold) = self.get_unit_parts(handle)?;
        Ok((hot.id, cold.map_id, hot.x, hot.z))
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
/// 在生成的类型池中分配Entity，并返回带世代校验的稳定句柄。 / Allocates an Entity in generated typed pools and returns a generation-checked stable handle.
pub(crate) fn op_native_entity_create(
    entity_type: u32,
    #[buffer] values: &[f64],
) -> Result<u32, JsErrorBox> {
    let value = create_entity(entity_type, values).map_err(JsErrorBox::generic)?;
    STORE.with(|slot| slot.borrow_mut().create(value))
}

#[op2(fast)]
/// 销毁一个池化Entity；此后通过旧句柄执行的操作会被拒绝。 / Destroys one pooled Entity; later operations through the stale handle are rejected.
pub(crate) fn op_native_entity_destroy(handle: u32) -> Result<(), JsErrorBox> {
    STORE.with(|slot| slot.borrow_mut().destroy(handle))
}

#[op2(fast)]
/// 更新 Unit 移动意图，但不推进模拟，也不回调 TS。 / Updates Unit movement intent without advancing simulation or calling back into TS.
pub(crate) fn op_native_unit_set_movement_input(
    handle: u32,
    input_x: i8,
    input_z: i8,
    sequence: u32,
) -> Result<bool, JsErrorBox> {
    native_unit_set_movement_input_impl(handle, input_x, input_z, sequence)
}

fn native_unit_set_movement_input_impl(
    handle: u32,
    input_x: i8,
    input_z: i8,
    sequence: u32,
) -> Result<bool, JsErrorBox> {
    if !(-1..=1).contains(&input_x) || !(-1..=1).contains(&input_z) {
        return Err(JsErrorBox::generic(
            "native movement input must be between -1 and 1",
        ));
    }
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        store.metrics.scalar_sets += 1;
        let unit = store.get_unit_hot_mut(handle)?;
        if sequence <= unit.sequence {
            return Ok(false);
        }
        unit.input_changed |= u32::from(unit.input_x != input_x || unit.input_z != input_z);
        unit.input_x = input_x;
        unit.input_z = input_z;
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
        let location = store.location(handle)?;
        let map_id = store
            .pools
            .get_unit_cold(location)
            .ok_or_else(|| wrong_entity_type(handle, "Unit"))?
            .map_id;
        let bounds = *store.grid_2d_bounds.get(&map_id).ok_or_else(|| {
            JsErrorBox::generic(format!("map {map_id} has no Grid2D spatial state"))
        })?;
        let (x, z) = {
            let unit = store.get_unit_hot_mut(handle)?;
            unit.input_x = 0;
            unit.input_z = 0;
            unit.input_changed = 0;
            unit.sequence = 0;
            unit.target_cell_x = unit.cell_x;
            unit.target_cell_z = unit.cell_z;
            unit.move_start_tick = 0;
            unit.move_end_tick = 0;
            unit.moving = 0;
            (
                cell_to_world(unit.cell_x, bounds.cell_size_meters),
                cell_to_world(unit.cell_z, bounds.cell_size_meters),
            )
        };
        store.set_number(
            handle,
            crate::generated::native_data::UNIT_FIELD_X,
            x as f64,
        )?;
        store.set_number(
            handle,
            crate::generated::native_data::UNIT_FIELD_Z,
            z as f64,
        )?;
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
        store.get_number(handle, field)
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
        store.set_number(handle, field, value)
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
        store.get_unit_hot(unit_handle)?;
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
        store.get_unit_hot(unit_handle)?;
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
        store.get_unit_hot(unit_handle)?;
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
        let handles = store.take_map_handles(map_id);
        let mut records = take_scratch(&mut store.scratch_numeric_records);
        let previous_capacity = records.capacity();
        let outcome = (|| {
            for &handle in &handles {
                let unit_id = store.get_unit_hot(handle)?.id;
                if let Some(numeric) = store.numerics_by_unit.get(&handle) {
                    for (&numeric_type, &revision) in &numeric.dirty {
                        if revision <= through_revision {
                            records.push((unit_id, numeric_type, numeric.values[&numeric_type]));
                        }
                    }
                }
            }
            records.sort_unstable_by_key(|record| (record.0, record.1));
            let mut result = Vec::with_capacity(14 + records.len() * 14);
            result.extend_from_slice(&(records.len() as u32).to_le_bytes());
            result.extend_from_slice(&through_revision.to_le_bytes());
            let frame_start = result.len();
            encode_entity_numeric_frame_into(&mut result, message_code, server_tick, &records);
            store.metrics.batch_calls += 1;
            store.metrics.encoded_frames += 1;
            store.metrics.encoded_items += records.len() as u64;
            store.metrics.encoded_bytes += (result.len() - frame_start) as u64;
            Ok(result)
        })();
        store.metrics.scratch_growths += u64::from(records.capacity() > previous_capacity);
        store.scratch_handles = handles;
        store.scratch_numeric_records = records;
        outcome
    })
}

#[op2]
/// 将 Numeric 脏字典按最终 AOI 受众分组编码，并保留统一 Ack 版本。 / Encodes Numeric dirty entries by final AOI audiences while preserving one Ack revision.
pub(crate) fn op_native_map_peek_numeric_aoi_delta(
    map_id: u32,
    server_tick: u32,
    message_code: u32,
) -> Result<Uint8Array, JsErrorBox> {
    let message_code = u16::try_from(message_code)
        .map_err(|_| JsErrorBox::generic("numeric message code exceeds uint16"))?;
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        let through_revision = store.numeric_revision;
        let handles = store.take_map_handles(map_id);
        let mut records = take_scratch(&mut store.scratch_numeric_records);
        let previous_capacity = records.capacity();
        let outcome = (|| {
            for &handle in &handles {
                let unit_id = store.get_unit_hot(handle)?.id;
                if let Some(numeric) = store.numerics_by_unit.get(&handle) {
                    for (&numeric_type, &revision) in &numeric.dirty {
                        if revision <= through_revision {
                            records.push((unit_id, numeric_type, numeric.values[&numeric_type]));
                        }
                    }
                }
            }
            records.sort_unstable_by_key(|record| (record.0, record.1));
            let mut result = Vec::new();
            result.extend_from_slice(&through_revision.to_le_bytes());
            let batches = {
                let world = store.aoi_worlds.get(&map_id).ok_or_else(|| {
                    JsErrorBox::generic(format!("AOI world is not configured: {map_id}"))
                })?;
                encode_aoi_batches(
                    world,
                    records.iter().map(|record| record.0),
                    |indices, frame| {
                        let subset: Vec<_> = indices.iter().map(|index| records[*index]).collect();
                        encode_entity_numeric_frame_into(frame, message_code, server_tick, &subset);
                    },
                )
            };
            record_aoi_encoding_metrics(&mut store.metrics, &batches);
            result.extend_from_slice(&batches);
            Ok(result)
        })();
        store.metrics.scratch_growths += u64::from(records.capacity() > previous_capacity);
        store.scratch_handles = handles;
        store.scratch_numeric_records = records;
        outcome.map(Into::into)
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
        let handles = store.take_map_handles(map_id);
        let mut records = take_scratch(&mut store.scratch_unit_delta_records);
        let previous_capacity = records.capacity();
        let outcome = (|| {
            for &handle in &handles {
                let (hot, cold) = store.get_unit_parts(handle)?;
                if let Some(delta) = peek_unit_split_delta(hot, cold) {
                    records.push(UnitDeltaRecord {
                        handle,
                        unit_id: hot.id,
                        delta,
                    });
                }
            }
            records.sort_unstable_by_key(|record| record.unit_id);
            let revision_len = 4 + records.len() * 12;
            let mut result = Vec::with_capacity(8 + revision_len + 2 + records.len() * 36);
            result.extend_from_slice(&(records.len() as u32).to_le_bytes());
            result.extend_from_slice(&(revision_len as u32).to_le_bytes());
            result.extend_from_slice(&(records.len() as u32).to_le_bytes());
            for record in &records {
                result.extend_from_slice(&record.handle.to_le_bytes());
                result.extend_from_slice(&record.delta.revision.to_le_bytes());
            }
            let frame_start = result.len();
            encode_entity_state_frame_into(&mut result, message_code, server_tick, &records);
            store.metrics.batch_calls += 1;
            store.metrics.encoded_frames += 1;
            store.metrics.encoded_items += records.len() as u64;
            store.metrics.encoded_bytes += (result.len() - frame_start) as u64;
            Ok(result)
        })();
        store.metrics.scratch_growths += u64::from(records.capacity() > previous_capacity);
        store.scratch_handles = handles;
        store.scratch_unit_delta_records = records;
        outcome
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
            if let Ok(unit) = store.get_unit_cold_mut(handle)
                && unit.map_id == map_id
            {
                ack_unit_split_delta(unit, through_revision);
            }
        }
        Ok(())
    })
}

#[derive(Clone)]
struct UnitDeltaRecord {
    handle: u32,
    unit_id: u32,
    delta: UnitDelta,
}

#[op2]
/// 将固定字段脏 mask 按最终 AOI 受众分组编码；revision 仍按实体独立确认。 / Encodes fixed-field dirty masks by final AOI audiences while preserving per-entity revisions.
pub(crate) fn op_native_map_peek_unit_aoi_delta(
    map_id: u32,
    server_tick: u32,
    message_code: u32,
) -> Result<Uint8Array, JsErrorBox> {
    let message_code = u16::try_from(message_code)
        .map_err(|_| JsErrorBox::generic("unit state message code exceeds uint16"))?;
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        let handles = store.take_map_handles(map_id);
        let mut records = take_scratch(&mut store.scratch_unit_delta_records);
        let previous_capacity = records.capacity();
        let outcome = (|| {
            for &handle in &handles {
                let (hot, cold) = store.get_unit_parts(handle)?;
                if let Some(delta) = peek_unit_split_delta(hot, cold) {
                    records.push(UnitDeltaRecord {
                        handle,
                        unit_id: hot.id,
                        delta,
                    });
                }
            }
            records.sort_unstable_by_key(|record| record.unit_id);
            let revision_len = 4 + records.len() * 12;
            let mut result = Vec::new();
            result.extend_from_slice(&(revision_len as u32).to_le_bytes());
            result.extend_from_slice(&(records.len() as u32).to_le_bytes());
            for record in &records {
                result.extend_from_slice(&record.handle.to_le_bytes());
                result.extend_from_slice(&record.delta.revision.to_le_bytes());
            }
            let batches = {
                let world = store.aoi_worlds.get(&map_id).ok_or_else(|| {
                    JsErrorBox::generic(format!("AOI world is not configured: {map_id}"))
                })?;
                encode_aoi_batches(
                    world,
                    records.iter().map(|record| record.unit_id),
                    |indices, frame| {
                        let subset: Vec<_> = indices
                            .iter()
                            .map(|index| records[*index].clone())
                            .collect();
                        encode_entity_state_frame_into(frame, message_code, server_tick, &subset);
                    },
                )
            };
            record_aoi_encoding_metrics(&mut store.metrics, &batches);
            result.extend_from_slice(&batches);
            Ok(result)
        })();
        store.metrics.scratch_growths += u64::from(records.capacity() > previous_capacity);
        store.scratch_handles = handles;
        store.scratch_unit_delta_records = records;
        outcome.map(Into::into)
    })
}

#[op2(fast)]
/// 注册一张地图的移动边界；重复注册会原子替换旧值。 / Registers movement bounds for a map, atomically replacing an older value.
pub(crate) fn op_native_spatial_create_grid2_d(
    map_id: u32,
    width_cells: u32,
    depth_cells: u32,
    cell_size_millimeters: u32,
) -> Result<(), JsErrorBox> {
    native_spatial_create_grid_2d(map_id, width_cells, depth_cells, cell_size_millimeters)
}

fn native_spatial_create_grid_2d(
    map_id: u32,
    width_cells: u32,
    depth_cells: u32,
    cell_size_millimeters: u32,
) -> Result<(), JsErrorBox> {
    let bounds = Grid2DBounds::new(width_cells, depth_cells, cell_size_millimeters)?;
    STORE.with(|slot| {
        slot.borrow_mut().grid_2d_bounds.insert(map_id, bounds);
    });
    Ok(())
}

#[op2(fast)]
/// 创建地图实例独占的 AOI Grid，并冻结可见迟滞与同步档位。 / Creates one map-instance AOI grid and freezes visibility hysteresis and sync tiers.
pub(crate) fn op_native_aoi_create(
    map_id: u32,
    grid_size_millimeters: u32,
    enter_radius_grids: u32,
    detach_radius_grids: u32,
    #[buffer] sync_tiers: &[u8],
) -> Result<(), JsErrorBox> {
    if !sync_tiers.len().is_multiple_of(8) {
        return Err(JsErrorBox::generic(
            "AOI sync tiers must contain radius/interval uint32 pairs",
        ));
    }
    let tiers = sync_tiers
        .chunks_exact(8)
        .map(|bytes| SyncTier {
            radius_grids: u32::from_le_bytes(bytes[0..4].try_into().unwrap()),
            interval_ticks: u32::from_le_bytes(bytes[4..8].try_into().unwrap()),
        })
        .collect();
    let bounds = STORE
        .with(|slot| slot.borrow().grid_2d_bounds.get(&map_id).copied())
        .ok_or_else(|| {
            JsErrorBox::generic(format!("map spatial world is not configured: {map_id}"))
        })?;
    let world = AoiWorld::new(
        grid_size_millimeters,
        bounds.origin_x_millimeters,
        bounds.origin_z_millimeters,
        enter_radius_grids,
        detach_radius_grids,
        tiers,
    )
    .map_err(JsErrorBox::generic)?;
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        if store.aoi_worlds.insert(map_id, world).is_some() {
            return Err(JsErrorBox::generic(format!(
                "AOI world is already configured: {map_id}"
            )));
        }
        Ok(())
    })
}

#[op2(fast)]
/// 释放地图 AOI；调用前必须先移除全部实体。 / Releases a map AOI world after every entity has detached.
pub(crate) fn op_native_aoi_release(map_id: u32) -> Result<(), JsErrorBox> {
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        let Some(world) = store.aoi_worlds.remove(&map_id) else {
            return Ok(());
        };
        if store
            .units_by_map
            .get(&map_id)
            .into_iter()
            .flatten()
            .filter_map(|handle| store.unit_spatial(*handle).ok())
            .any(|(unit_id, _, _, _)| world.is_attached(unit_id))
        {
            store.aoi_worlds.insert(map_id, world);
            return Err(JsErrorBox::generic(format!(
                "AOI world {map_id} still contains attached entities"
            )));
        }
        store.aoi_dirty_by_map.remove(&map_id);
        Ok(())
    })
}

#[op2]
/// 在完整 Entity 图提交后加入 AOI；返回待业务过滤的候选变化但不清空。 / Attaches a committed Entity and returns candidate changes without clearing them before business filtering.
pub(crate) fn op_native_aoi_attach(
    map_id: u32,
    handle: u32,
    observer: bool,
    subject: bool,
    delivery_route_id: u32,
) -> Result<Uint8Array, JsErrorBox> {
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        let (unit_id, unit_map_id, x, z) = store.unit_spatial(handle)?;
        if unit_map_id != map_id {
            return Err(JsErrorBox::generic(format!(
                "native Unit {unit_id} belongs to map {unit_map_id}, not {map_id}"
            )));
        }
        store
            .aoi_worlds
            .get_mut(&map_id)
            .ok_or_else(|| JsErrorBox::generic(format!("AOI world is not configured: {map_id}")))?
            .attach_routed(unit_id, x, z, observer, subject, delivery_route_id)
            .map_err(JsErrorBox::generic)?;
        if let Some(dirty) = store.aoi_dirty_by_map.get_mut(&map_id) {
            dirty.remove(&handle);
        }
        Ok(encode_visibility_changes(&store.aoi_worlds[&map_id].peek_changes()).into())
    })
}

#[op2]
/// 在销毁 Native Entity 前移出 AOI，并返回最终离开关系。 / Detaches before Native Entity destruction and returns final leave relations.
pub(crate) fn op_native_aoi_detach(map_id: u32, handle: u32) -> Result<Uint8Array, JsErrorBox> {
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        let (unit_id, unit_map_id, _, _) = store.unit_spatial(handle)?;
        if unit_map_id != map_id {
            return Err(JsErrorBox::generic(format!(
                "native Unit {unit_id} belongs to map {unit_map_id}, not {map_id}"
            )));
        }
        let changes = {
            let world = store.aoi_worlds.get_mut(&map_id).ok_or_else(|| {
                JsErrorBox::generic(format!("AOI world is not configured: {map_id}"))
            })?;
            world.detach(unit_id);
            world.take_changes()
        };
        store.metrics.aoi_visibility_changes += changes.len() as u64;
        if let Some(dirty) = store.aoi_dirty_by_map.get_mut(&map_id) {
            dirty.remove(&handle);
        }
        Ok(encode_visibility_changes(&changes).into())
    })
}

#[op2]
/// 刷新 FastOP 写入产生的空间脏实体；同 Cell 写入不会重建邻居关系。 / Refreshes spatially dirty FastOP writes without rebuilding neighbors for same-cell movement.
pub(crate) fn op_native_aoi_refresh(map_id: u32) -> Result<Uint8Array, JsErrorBox> {
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        let handles = store.aoi_dirty_by_map.remove(&map_id).unwrap_or_default();
        let mut positions = Vec::with_capacity(handles.len());
        for handle in handles {
            if let Ok((unit_id, unit_map_id, x, z)) = store.unit_spatial(handle)
                && unit_map_id == map_id
            {
                positions.push((unit_id, x, z));
            }
        }
        let (relocations, changes) = {
            let world = store.aoi_worlds.get_mut(&map_id).ok_or_else(|| {
                JsErrorBox::generic(format!("AOI world is not configured: {map_id}"))
            })?;
            let mut relocations = 0_u64;
            for (unit_id, x, z) in positions {
                if world.is_attached(unit_id) {
                    relocations +=
                        u64::from(world.relocate(unit_id, x, z).map_err(JsErrorBox::generic)?);
                }
            }
            (relocations, world.peek_changes())
        };
        store.metrics.aoi_relocations += relocations;
        Ok(encode_visibility_changes(&changes).into())
    })
}

#[op2(fast)]
/// 应用同步业务过滤器的最终判定；只能收窄当前空间候选关系。 / Applies a synchronous business-filter decision and can only narrow a current spatial candidate.
pub(crate) fn op_native_aoi_set_visible(
    map_id: u32,
    observer_id: u32,
    subject_id: u32,
    visible: bool,
) -> Result<bool, JsErrorBox> {
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        let changed = store
            .aoi_worlds
            .get_mut(&map_id)
            .ok_or_else(|| JsErrorBox::generic(format!("AOI world is not configured: {map_id}")))?
            .set_visible(observer_id, subject_id, visible);
        store.metrics.aoi_filter_overrides += u64::from(changed);
        Ok(changed)
    })
}

#[op2]
/// 取走过滤完成后的规范化可见变化。 / Takes normalized visibility changes after filtering completes.
pub(crate) fn op_native_aoi_take_changes(map_id: u32) -> Result<Uint8Array, JsErrorBox> {
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        let changes = store
            .aoi_worlds
            .get_mut(&map_id)
            .ok_or_else(|| JsErrorBox::generic(format!("AOI world is not configured: {map_id}")))?
            .take_changes();
        store.metrics.aoi_visibility_changes += changes.len() as u64;
        Ok(encode_visibility_changes(&changes).into())
    })
}

#[op2]
/// 查询业务状态失效后必须重算的候选关系；mode 1=Observer、2=Subject、3=两者。 / Queries candidate relations for invalidation; mode 1=observer, 2=subject, 3=both.
pub(crate) fn op_native_aoi_query_relations(
    map_id: u32,
    unit_id: u32,
    mode: u32,
) -> Result<Uint8Array, JsErrorBox> {
    if !(1..=3).contains(&mode) {
        return Err(JsErrorBox::generic(
            "AOI invalidation mode must be 1, 2, or 3",
        ));
    }
    STORE.with(|slot| {
        let store = slot.borrow();
        let pairs = store
            .aoi_worlds
            .get(&map_id)
            .ok_or_else(|| JsErrorBox::generic(format!("AOI world is not configured: {map_id}")))?
            .candidate_pairs(unit_id, mode & 1 != 0, mode & 2 != 0);
        let mut bytes = Vec::with_capacity(4 + pairs.len() * 8);
        bytes.extend_from_slice(&(pairs.len() as u32).to_le_bytes());
        for (observer_id, subject_id) in pairs {
            bytes.extend_from_slice(&observer_id.to_le_bytes());
            bytes.extend_from_slice(&subject_id.to_le_bytes());
        }
        Ok(bytes.into())
    })
}

#[op2]
/// 返回某 Observer 的最终可见 Subject 列表；自身快照由调用方显式补入。 / Returns final visible subjects for one observer; callers add the self snapshot explicitly.
pub(crate) fn op_native_aoi_visible_subjects(
    map_id: u32,
    observer_id: u32,
) -> Result<Uint8Array, JsErrorBox> {
    STORE.with(|slot| {
        let store = slot.borrow();
        let subjects = store
            .aoi_worlds
            .get(&map_id)
            .ok_or_else(|| JsErrorBox::generic(format!("AOI world is not configured: {map_id}")))?
            .visible_subjects(observer_id);
        let mut bytes = Vec::with_capacity(4 + subjects.len() * 4);
        bytes.extend_from_slice(&(subjects.len() as u32).to_le_bytes());
        for subject_id in subjects {
            bytes.extend_from_slice(&subject_id.to_le_bytes());
        }
        Ok(bytes.into())
    })
}

#[op2]
/// 返回当前能看见某 Subject 的最终 Observer；用于业务公开状态广播，不包含 Subject 自身。
/// Returns final observers that can see one subject for public state broadcasts, excluding self.
pub(crate) fn op_native_aoi_visible_observers(
    map_id: u32,
    subject_id: u32,
) -> Result<Uint8Array, JsErrorBox> {
    STORE.with(|slot| {
        let store = slot.borrow();
        let observers = store
            .aoi_worlds
            .get(&map_id)
            .ok_or_else(|| JsErrorBox::generic(format!("AOI world is not configured: {map_id}")))?
            .observers_of(subject_id);
        let mut bytes = Vec::with_capacity(4 + observers.len() * 4);
        bytes.extend_from_slice(&(observers.len() as u32).to_le_bytes());
        for observer_id in observers {
            bytes.extend_from_slice(&observer_id.to_le_bytes());
        }
        Ok(bytes.into())
    })
}

fn encode_visibility_changes(changes: &[VisibilityChange]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(4 + changes.len() * 9);
    bytes.extend_from_slice(&(changes.len() as u32).to_le_bytes());
    for change in changes {
        bytes.extend_from_slice(&change.observer_id.to_le_bytes());
        bytes.extend_from_slice(&change.subject_id.to_le_bytes());
        bytes.push(u8::from(change.visible));
    }
    bytes
}

#[op2(fast)]
/// 释放地图实例私有空间状态；不存在时保持幂等，共享导航资产不在这里卸载。 / Releases per-instance spatial state idempotently without unloading shared navigation assets.
pub(crate) fn op_native_spatial_release(map_id: u32) {
    STORE.with(|slot| {
        slot.borrow_mut().grid_2d_bounds.remove(&map_id);
    });
}

#[op2]
/// 推进一张地图中的全部 Unit，并返回 Rust 编码的可覆盖移动快照。 / Advances all Units in one map and returns a Rust-encoded replaceable movement snapshot.
pub(crate) fn op_native_map_update_movement(
    map_id: u32,
    server_tick: u32,
    fixed_update_ms: u32,
    message_code: u32,
) -> Result<Uint8Array, JsErrorBox> {
    native_map_update_movement(map_id, server_tick, fixed_update_ms, message_code).map(Into::into)
}

fn native_map_update_movement(
    map_id: u32,
    server_tick: u32,
    fixed_update_ms: u32,
    message_code: u32,
) -> Result<Vec<u8>, JsErrorBox> {
    if fixed_update_ms == 0 {
        return Err(JsErrorBox::generic(
            "fixed update milliseconds must be greater than zero",
        ));
    }
    let message_code = u16::try_from(message_code)
        .map_err(|_| JsErrorBox::generic("movement message code exceeds uint16"))?;
    native_map_advance_movement(map_id, server_tick, fixed_update_ms)?;
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        let records = store
            .pending_movement_records
            .get(&map_id)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let mut result = Vec::with_capacity(6 + records.len() * 24);
        result.extend_from_slice(&(records.len() as u32).to_le_bytes());
        let frame_start = result.len();
        encode_entity_move_frame_into(&mut result, message_code, server_tick, records);
        let record_count = records.len() as u64;
        let encoded_bytes = (result.len() - frame_start) as u64;
        store.metrics.encoded_frames += 1;
        store.metrics.encoded_items += record_count;
        store.metrics.encoded_bytes += encoded_bytes;
        Ok(result)
    })
}

#[op2(fast)]
/// 只推进 Rust 权威移动并刷新 AOI，不编码客户端协议。 / Advances Rust-authoritative movement and AOI without encoding a client protocol frame.
pub(crate) fn op_native_map_advance_movement(
    map_id: u32,
    server_tick: u32,
    fixed_update_ms: u32,
) -> Result<u32, JsErrorBox> {
    native_map_advance_movement(map_id, server_tick, fixed_update_ms)
}

fn native_map_advance_movement(
    map_id: u32,
    server_tick: u32,
    fixed_update_ms: u32,
) -> Result<u32, JsErrorBox> {
    if fixed_update_ms == 0 {
        return Err(JsErrorBox::generic(
            "fixed update milliseconds must be greater than zero",
        ));
    }
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        store.metrics.batch_calls += 1;
        let bounds = *store
            .grid_2d_bounds
            .get(&map_id)
            .ok_or_else(|| JsErrorBox::generic(format!("map {map_id} is not configured")))?;
        let handles = store.take_map_handles(map_id);
        let mut records = store
            .pending_movement_records
            .remove(&map_id)
            .unwrap_or_else(|| take_scratch(&mut store.scratch_movement_records));
        records.clear();
        let previous_capacity = records.capacity();
        let mut changed_positions = take_scratch(&mut store.scratch_changed_positions);
        let previous_positions_capacity = changed_positions.capacity();
        let outcome = (|| {
            update_map(
                &mut store,
                &handles,
                server_tick,
                fixed_update_ms as f32,
                bounds,
                &mut records,
                &mut changed_positions,
            )?;
            let mut relocations = 0_u64;
            if let Some(world) = store.aoi_worlds.get_mut(&map_id) {
                for &(unit_id, x, z) in &changed_positions {
                    if world.is_attached(unit_id) {
                        relocations +=
                            u64::from(world.relocate(unit_id, x, z).map_err(JsErrorBox::generic)?);
                    }
                }
            }
            store.metrics.aoi_relocations += relocations;
            Ok(records.len() as u32)
        })();
        store.metrics.scratch_growths += u64::from(records.capacity() > previous_capacity);
        store.metrics.scratch_growths +=
            u64::from(changed_positions.capacity() > previous_positions_capacity);
        store.scratch_handles = handles;
        store.scratch_changed_positions = changed_positions;
        store.pending_movement_records.insert(map_id, records);
        outcome
    })
}

#[op2]
/// 按最终 AOI 关系分组编码本帧移动；TS 只读取外层接收者，不解码 protobuf。 / Encodes this tick's movement by final AOI audiences; TS reads only recipient envelopes.
pub(crate) fn op_native_map_take_movement_aoi_delta(
    map_id: u32,
    server_tick: u32,
    message_code: u32,
) -> Result<Uint8Array, JsErrorBox> {
    let message_code = u16::try_from(message_code)
        .map_err(|_| JsErrorBox::generic("movement message code exceeds uint16"))?;
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        let records = store
            .pending_movement_records
            .remove(&map_id)
            .unwrap_or_default();
        let result = {
            let world = store.aoi_worlds.get(&map_id).ok_or_else(|| {
                JsErrorBox::generic(format!("AOI world is not configured: {map_id}"))
            })?;
            encode_tiered_aoi_batches(
                world,
                records.iter().map(|record| read_record_u32(record, 0)),
                records.iter().map(|record| record[16] != 0),
                server_tick,
                |indices, frame| {
                    encode_entity_move_frame_indices_into(
                        frame,
                        message_code,
                        server_tick,
                        &records,
                        indices,
                    );
                },
            )
        };
        record_aoi_encoding_metrics(&mut store.metrics, &result);
        let mut scratch = records;
        scratch.clear();
        if scratch.capacity() > store.scratch_movement_records.capacity() {
            store.scratch_movement_records = scratch;
        }
        Ok(result.into())
    })
}

#[op2]
/// 在 Rust 内完成 AOI 接收者到 Gate 路由的分组，并直接生成每个 Gate 的批量内网帧。
/// Groups AOI recipients by Gate route and emits complete per-Gate inner frames without returning recipient lists to TS.
pub(crate) fn op_native_map_take_movement_aoi_route_frames(
    map_id: u32,
    server_tick: u32,
    client_message_code: u32,
    route_message_code: u32,
) -> Result<Uint8Array, JsErrorBox> {
    let client_message_code = u16::try_from(client_message_code)
        .map_err(|_| JsErrorBox::generic("client movement message code exceeds uint16"))?;
    let route_message_code = u16::try_from(route_message_code)
        .map_err(|_| JsErrorBox::generic("Gate route message code exceeds uint16"))?;
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        let records = store
            .pending_movement_records
            .remove(&map_id)
            .unwrap_or_default();
        let result = {
            let world = store.aoi_worlds.get(&map_id).ok_or_else(|| {
                JsErrorBox::generic(format!("AOI world is not configured: {map_id}"))
            })?;
            encode_tiered_aoi_route_frames(
                world,
                &records,
                server_tick,
                client_message_code,
                route_message_code,
            )?
        };
        record_aoi_encoding_metrics(&mut store.metrics, &result);
        let mut scratch = records;
        scratch.clear();
        if scratch.capacity() > store.scratch_movement_records.capacity() {
            store.scratch_movement_records = scratch;
        }
        Ok(result.into())
    })
}

fn update_map(
    store: &mut NativeEntityStore,
    handles: &[u32],
    server_tick: u32,
    fixed_update_ms: f32,
    bounds: Grid2DBounds,
    records: &mut Vec<[u8; NATIVE_UNIT_RECORD_BYTES]>,
    changed_positions: &mut Vec<(u32, f32, f32)>,
) -> Result<(), JsErrorBox> {
    for &handle in handles {
        let unit = store.get_unit_hot_mut(handle)?;
        let previous_x = unit.x;
        let previous_z = unit.z;
        let state_changed = update_movement(unit, server_tick, fixed_update_ms, bounds);
        if unit.x != previous_x || unit.z != previous_z {
            changed_positions.push((unit.id, unit.x, unit.z));
        }
        if unit.moving != 0 || state_changed {
            records.push(encode_snapshot(unit, state_changed));
        }
    }
    Ok(())
}

fn encode_aoi_batches<I, F>(world: &AoiWorld, subject_ids: I, mut encode_frame: F) -> Vec<u8>
where
    I: IntoIterator<Item = u32>,
    F: FnMut(&[usize], &mut Vec<u8>),
{
    let subjects: Vec<_> = subject_ids.into_iter().collect();
    encode_aoi_delivery_groups(world.delivery_groups(&subjects), &mut encode_frame)
}

fn encode_tiered_aoi_batches<I, B, F>(
    world: &AoiWorld,
    subject_ids: I,
    force: B,
    server_tick: u32,
    mut encode_frame: F,
) -> Vec<u8>
where
    I: IntoIterator<Item = u32>,
    B: IntoIterator<Item = bool>,
    F: FnMut(&[usize], &mut Vec<u8>),
{
    let subjects: Vec<_> = subject_ids.into_iter().collect();
    let force: Vec<_> = force.into_iter().collect();
    encode_aoi_delivery_groups(
        world.tiered_delivery_groups(&subjects, &force, server_tick),
        &mut encode_frame,
    )
}

/// 返回 `[itemCount, routeCount, routeId, frameLength, frame...]`；frame 已经是完整 Gate 消息。
/// Returns a compact route envelope whose frames are complete Gate protocol messages.
fn encode_tiered_aoi_route_frames(
    world: &AoiWorld,
    records: &[[u8; NATIVE_UNIT_RECORD_BYTES]],
    server_tick: u32,
    client_message_code: u16,
    route_message_code: u16,
) -> Result<Vec<u8>, JsErrorBox> {
    let subject_ids: Vec<_> = records
        .iter()
        .map(|record| read_record_u32(record, 0))
        .collect();
    let force: Vec<_> = records.iter().map(|record| record[16] != 0).collect();
    let delivery_groups = world.tiered_delivery_groups(&subject_ids, &force, server_tick);
    let total_items = delivery_groups
        .iter()
        .map(|(_, indices)| indices.len() as u32)
        .sum::<u32>();
    let route_capacity = usize::try_from(world.max_delivery_route_id())
        .map_err(|_| JsErrorBox::generic("AOI delivery route id exceeds usize"))?
        .checked_add(1)
        .ok_or_else(|| JsErrorBox::generic("AOI delivery route capacity overflow"))?;
    let mut payloads_by_route: Vec<Vec<u8>> = (0..route_capacity).map(|_| Vec::new()).collect();
    let mut recipients_by_route: Vec<Vec<u32>> = (0..route_capacity).map(|_| Vec::new()).collect();
    let mut client_frame = Vec::with_capacity(256);

    for (recipients, indices) in delivery_groups {
        client_frame.clear();
        encode_entity_move_frame_indices_into(
            &mut client_frame,
            client_message_code,
            server_tick,
            records,
            &indices,
        );
        for recipients in &mut recipients_by_route {
            recipients.clear();
        }
        for recipient_id in recipients {
            let route_id = world.delivery_route_id(recipient_id).ok_or_else(|| {
                JsErrorBox::generic(format!(
                    "AOI observer {recipient_id} has no native delivery route"
                ))
            })?;
            recipients_by_route[route_id as usize].push(recipient_id);
        }
        for (route_id, route_recipients) in recipients_by_route.iter().enumerate().skip(1) {
            if route_recipients.is_empty() {
                continue;
            }
            encode_client_broadcast_batch_item(
                &mut payloads_by_route[route_id],
                route_recipients,
                &client_frame,
            );
        }
    }

    let route_count = payloads_by_route
        .iter()
        .skip(1)
        .filter(|payload| !payload.is_empty())
        .count();
    let mut bytes = Vec::with_capacity(
        8 + payloads_by_route
            .iter()
            .map(|payload| 10 + payload.len())
            .sum::<usize>(),
    );
    bytes.extend_from_slice(&total_items.to_le_bytes());
    bytes.extend_from_slice(&(route_count as u32).to_le_bytes());
    for (route_id, payload) in payloads_by_route.into_iter().enumerate().skip(1) {
        if payload.is_empty() {
            continue;
        }
        bytes.extend_from_slice(&(route_id as u32).to_le_bytes());
        bytes.extend_from_slice(&((payload.len() + 2) as u32).to_le_bytes());
        bytes.extend_from_slice(&route_message_code.to_be_bytes());
        bytes.extend_from_slice(&payload);
    }
    Ok(bytes)
}

/// 编码 S2G_ClientBroadcastBatch.batches 中的一个元素，保持与 TS 生成 Codec 相同的非 packed uint32 表示。
/// Encodes one S2G_ClientBroadcastBatch item using the same unpacked uint32 representation as the generated TS codec.
fn encode_client_broadcast_batch_item(
    route_payload: &mut Vec<u8>,
    recipient_ids: &[u32],
    client_frame: &[u8],
) {
    let item_len = recipient_ids
        .iter()
        .map(|id| varint_len(1 << 3) + varint_len(*id))
        .sum::<usize>()
        + varint_len((2 << 3) | 2)
        + varint_len(client_frame.len() as u32)
        + client_frame.len();
    write_tag(route_payload, 1, 2);
    write_varint(route_payload, item_len as u32);
    for &recipient_id in recipient_ids {
        write_tag(route_payload, 1, 0);
        write_varint(route_payload, recipient_id);
    }
    write_tag(route_payload, 2, 2);
    write_varint(route_payload, client_frame.len() as u32);
    route_payload.extend_from_slice(client_frame);
}

fn encode_aoi_delivery_groups<F>(
    delivery_groups: Vec<(Vec<u32>, Vec<usize>)>,
    encode_frame: &mut F,
) -> Vec<u8>
where
    F: FnMut(&[usize], &mut Vec<u8>),
{
    // 默认关系按 Subject Grid 聚合；只有迟滞或业务过滤例外需要逐 Subject 求精确受众。
    // Default relations aggregate by subject grid; only hysteresis and filter exceptions need exact audiences.
    // 直接写最终外层帧，避免为每个分组创建临时frame后再复制到第二个Vec。
    // Writes the final envelope directly, avoiding one temporary frame and one second copy per group.
    let mut bytes = Vec::with_capacity(8 + delivery_groups.len() * 32);
    bytes.extend_from_slice(&0_u32.to_le_bytes());
    bytes.extend_from_slice(&0_u32.to_le_bytes());
    let mut total_items = 0_u32;
    let mut batch_count = 0_u32;
    for (recipients, indices) in delivery_groups {
        total_items = total_items.saturating_add(indices.len() as u32);
        batch_count = batch_count.saturating_add(1);
        bytes.extend_from_slice(&(recipients.len() as u32).to_le_bytes());
        for recipient_id in recipients {
            bytes.extend_from_slice(&recipient_id.to_le_bytes());
        }
        bytes.extend_from_slice(&(indices.len() as u32).to_le_bytes());
        let frame_len_offset = bytes.len();
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        let frame_start = bytes.len();
        encode_frame(&indices, &mut bytes);
        let frame_len = (bytes.len() - frame_start) as u32;
        bytes[frame_len_offset..frame_len_offset + 4].copy_from_slice(&frame_len.to_le_bytes());
    }
    bytes[0..4].copy_from_slice(&total_items.to_le_bytes());
    bytes[4..8].copy_from_slice(&batch_count.to_le_bytes());
    bytes
}

fn record_aoi_encoding_metrics(metrics: &mut NativeDataMetrics, bytes: &[u8]) {
    if bytes.len() < 8 {
        return;
    }
    let item_count = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as u64;
    let batch_count = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as u64;
    metrics.batch_calls += 1;
    metrics.encoded_frames += batch_count;
    metrics.encoded_items += item_count;
    metrics.encoded_bytes += bytes.len() as u64;
}

#[op2]
/// 序列化 NativeData 生命周期累计计数器，供 TS 与 Prometheus 读取。
///
/// 这些值遵循 Prometheus Counter 的单调递增语义；调用方不得把读取动作当作清零边界。
/// Serializes lifetime NativeData counters for TS and Prometheus. Values are monotonic and a
/// read must never be treated as a reset boundary.
pub(crate) fn op_native_data_take_metrics() -> Uint8Array {
    native_data_metrics_bytes().into()
}

fn native_data_metrics_bytes() -> Vec<u8> {
    STORE.with(|slot| {
        let store = slot.borrow();
        let live_entities = store.live_entities();
        let live_units = store.live_units();
        let live_items = store.live_items();
        let pool_capacity_bytes = store.pool_capacity_bytes();
        let scratch_capacity_bytes = store.scratch_capacity_bytes();
        let aoi_worlds = store.aoi_worlds.len() as u32;
        let aoi_entries = store
            .aoi_worlds
            .values()
            .map(AoiWorld::entry_count)
            .sum::<usize>() as u32;
        let aoi_grids = store
            .aoi_worlds
            .values()
            .map(AoiWorld::grid_count)
            .sum::<usize>() as u32;
        let aoi_candidate_relations = store
            .aoi_worlds
            .values()
            .map(AoiWorld::candidate_relation_count)
            .sum::<usize>() as u64;
        let aoi_visible_relations = store
            .aoi_worlds
            .values()
            .map(AoiWorld::visible_relation_count)
            .sum::<usize>() as u64;
        let aoi_lingering_relations = store
            .aoi_worlds
            .values()
            .map(AoiWorld::lingering_relation_count)
            .sum::<usize>() as u64;
        let aoi_rejected_relations = store
            .aoi_worlds
            .values()
            .map(AoiWorld::rejected_relation_count)
            .sum::<usize>() as u64;
        let metrics = store.metrics.clone();
        let mut bytes = Vec::with_capacity(152);
        bytes.extend_from_slice(&metrics.scalar_gets.to_le_bytes());
        bytes.extend_from_slice(&metrics.scalar_sets.to_le_bytes());
        bytes.extend_from_slice(&metrics.batch_calls.to_le_bytes());
        bytes.extend_from_slice(&live_entities.to_le_bytes());
        bytes.extend_from_slice(&live_units.to_le_bytes());
        bytes.extend_from_slice(&metrics.encoded_frames.to_le_bytes());
        bytes.extend_from_slice(&metrics.encoded_items.to_le_bytes());
        bytes.extend_from_slice(&metrics.encoded_bytes.to_le_bytes());
        bytes.extend_from_slice(&pool_capacity_bytes.to_le_bytes());
        bytes.extend_from_slice(&live_items.to_le_bytes());
        bytes.extend_from_slice(&scratch_capacity_bytes.to_le_bytes());
        bytes.extend_from_slice(&metrics.scratch_growths.to_le_bytes());
        bytes.extend_from_slice(&aoi_worlds.to_le_bytes());
        bytes.extend_from_slice(&aoi_entries.to_le_bytes());
        bytes.extend_from_slice(&aoi_grids.to_le_bytes());
        bytes.extend_from_slice(&aoi_candidate_relations.to_le_bytes());
        bytes.extend_from_slice(&aoi_visible_relations.to_le_bytes());
        bytes.extend_from_slice(&metrics.aoi_relocations.to_le_bytes());
        bytes.extend_from_slice(&metrics.aoi_visibility_changes.to_le_bytes());
        bytes.extend_from_slice(&metrics.aoi_filter_overrides.to_le_bytes());
        bytes.extend_from_slice(&aoi_lingering_relations.to_le_bytes());
        bytes.extend_from_slice(&aoi_rejected_relations.to_le_bytes());
        bytes
    })
}

fn encode_entity_move_frame_into(
    frame: &mut Vec<u8>,
    message_code: u16,
    server_tick: u32,
    records: &[[u8; NATIVE_UNIT_RECORD_BYTES]],
) {
    frame.extend_from_slice(&message_code.to_be_bytes());
    write_uint32_field(frame, 1, server_tick);
    for record in records {
        write_tag(frame, 2, 2);
        write_varint(frame, cell_movement_encoded_len(record) as u32);
        encode_cell_movement(frame, record);
    }
}

fn encode_entity_move_frame_indices_into(
    frame: &mut Vec<u8>,
    message_code: u16,
    server_tick: u32,
    records: &[[u8; NATIVE_UNIT_RECORD_BYTES]],
    indices: &[usize],
) {
    frame.extend_from_slice(&message_code.to_be_bytes());
    write_uint32_field(frame, 1, server_tick);
    for &index in indices {
        let record = &records[index];
        write_tag(frame, 2, 2);
        write_varint(frame, cell_movement_encoded_len(record) as u32);
        encode_cell_movement(frame, record);
    }
}

fn encode_entity_numeric_frame_into(
    frame: &mut Vec<u8>,
    message_code: u16,
    server_tick: u32,
    records: &[(u32, u32, i32)],
) {
    frame.extend_from_slice(&message_code.to_be_bytes());
    write_uint32_field(frame, 1, server_tick);
    for &(unit_id, numeric_type, value) in records {
        let item_len = uint32_field_len(1, unit_id)
            + uint32_field_len(2, numeric_type)
            + sint32_field_len(3, value);
        write_tag(frame, 2, 2);
        write_varint(frame, item_len as u32);
        write_uint32_field(frame, 1, unit_id);
        write_uint32_field(frame, 2, numeric_type);
        write_sint32_field(frame, 3, value);
    }
}

fn encode_entity_state_frame_into(
    frame: &mut Vec<u8>,
    message_code: u16,
    server_tick: u32,
    records: &[UnitDeltaRecord],
) {
    frame.extend_from_slice(&message_code.to_be_bytes());
    write_uint32_field(frame, 1, server_tick);
    let mut item = Vec::with_capacity(32);
    for record in records {
        item.clear();
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
        if let Some(value) = record.delta.z {
            write_float_field(&mut item, 8, value);
        }
        if let Some(value) = record.delta.yaw {
            write_float_field(&mut item, 9, value);
        }
        write_tag(frame, 2, 2);
        write_varint(frame, item.len() as u32);
        frame.extend_from_slice(&item);
    }
}

#[cfg(test)]
fn encode_entity_move_frame(
    message_code: u16,
    server_tick: u32,
    records: &[[u8; NATIVE_UNIT_RECORD_BYTES]],
) -> Vec<u8> {
    let mut frame = Vec::with_capacity(2 + 8 + records.len() * 24);
    encode_entity_move_frame_into(&mut frame, message_code, server_tick, records);
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

fn update_movement(
    unit: &mut UnitHotData,
    server_tick: u32,
    fixed_update_ms: f32,
    bounds: Grid2DBounds,
) -> bool {
    let mut state_changed = unit.input_changed != 0;
    unit.input_changed = 0;
    if unit.moving != 0 && server_tick >= unit.move_end_tick {
        unit.cell_x = unit.target_cell_x;
        unit.cell_z = unit.target_cell_z;
        unit.x = cell_to_world(unit.cell_x, bounds.cell_size_meters);
        unit.z = cell_to_world(unit.cell_z, bounds.cell_size_meters);
        unit.moving = 0;
        state_changed = true;
    }

    if unit.moving == 0 && (unit.input_x != 0 || unit.input_z != 0) {
        unit.facing = facing_from_input(unit.input_x, unit.input_z);
        unit.yaw = yaw_from_input(unit.input_x, unit.input_z);
        let target_x = unit.cell_x + unit.input_x as i32;
        let target_z = unit.cell_z + unit.input_z as i32;
        if bounds.contains(target_x, target_z) {
            unit.target_cell_x = target_x;
            unit.target_cell_z = target_z;
            unit.move_start_tick = server_tick;
            unit.move_end_tick = server_tick
                + step_duration_ticks(
                    unit.input_x,
                    unit.input_z,
                    unit.speed_cells_per_second,
                    fixed_update_ms,
                );
            unit.moving = 1;
        } else {
            unit.input_x = 0;
            unit.input_z = 0;
        }
        state_changed = true;
    }

    state_changed
}

fn encode_snapshot(unit: &UnitHotData, state_changed: bool) -> [u8; NATIVE_UNIT_RECORD_BYTES] {
    let mut bytes = [0_u8; NATIVE_UNIT_RECORD_BYTES];
    bytes[0..4].copy_from_slice(&unit.id.to_le_bytes());
    bytes[4..8].copy_from_slice(&unit.x.round().to_le_bytes());
    bytes[8..12].copy_from_slice(&unit.z.round().to_le_bytes());
    bytes[12..16].copy_from_slice(&unit.sequence.to_le_bytes());
    bytes[16] = u8::from(state_changed);
    bytes[17] = u8::from(unit.moving != 0);
    bytes[18..22].copy_from_slice(&unit.cell_x.to_le_bytes());
    bytes[22..26].copy_from_slice(&unit.cell_z.to_le_bytes());
    bytes[26..30].copy_from_slice(&unit.target_cell_x.to_le_bytes());
    bytes[30..34].copy_from_slice(&unit.target_cell_z.to_le_bytes());
    bytes[34..38].copy_from_slice(&unit.move_start_tick.to_le_bytes());
    bytes[38..42].copy_from_slice(&unit.move_end_tick.to_le_bytes());
    bytes[42..46].copy_from_slice(&unit.facing.to_le_bytes());
    bytes
}

fn facing_from_input(input_x: i8, input_z: i8) -> u32 {
    if input_z > 0 {
        3
    } else if input_z < 0 {
        0
    } else if input_x < 0 {
        1
    } else if input_x > 0 {
        2
    } else {
        0
    }
}

fn yaw_from_input(input_x: i8, input_z: i8) -> f32 {
    (input_x as f32).atan2(input_z as f32)
}

fn cell_to_world(cell: i32, cell_size_meters: f32) -> f32 {
    cell as f32 * cell_size_meters
}

fn step_duration_ticks(
    input_x: i8,
    input_z: i8,
    speed_cells_per_second: f32,
    fixed_update_ms: f32,
) -> u32 {
    let distance = if input_x != 0 && input_z != 0 {
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

    #[test]
    fn map_bounds_reserve_the_outer_cell_for_a_three_by_three_unit() {
        let bounds = Grid2DBounds::new(128, 64, 1_000).unwrap();
        assert!(bounds.contains(-63, -31));
        assert!(bounds.contains(62, 30));
        assert!(!bounds.contains(-64, 0));
        assert!(!bounds.contains(0, 31));
        assert!(Grid2DBounds::new(2, 128, 1_000).is_err());
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MovementFixture {
        fixed_update_ms: u32,
        initial_cell_x: i32,
        initial_cell_z: i32,
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
        z: i8,
        sequence: u32,
    }

    #[derive(Debug, Deserialize, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct ExpectedMovement {
        acknowledged_sequence: u32,
        from_cell_x: i32,
        from_cell_z: i32,
        to_cell_x: i32,
        to_cell_z: i32,
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
        assert!(store.location(first).is_err());
        assert_eq!(store.get_unit_hot(second).unwrap().id, 2);
    }

    #[test]
    fn generated_scalar_accessors_keep_values_in_rust_store() {
        let mut store = NativeEntityStore::default();
        let handle = store.create(NativeEntityData::Unit(unit(1))).unwrap();
        store
            .set_number(handle, crate::generated::native_data::UNIT_FIELD_X, 12.5)
            .unwrap();
        assert_eq!(
            store
                .get_number(handle, crate::generated::native_data::UNIT_FIELD_X)
                .unwrap(),
            12.5,
        );
        assert!(
            store
                .set_number(handle, crate::generated::native_data::UNIT_FIELD_ID, 2.0)
                .is_err()
        );
        assert!(
            store
                .set_number(
                    handle,
                    crate::generated::native_data::UNIT_FIELD_CELL_X,
                    1.5
                )
                .is_err()
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
            assert_eq!(store.get_unit_hot(handle).unwrap().x, 1.0);
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

        let first = native_data_metrics_bytes();
        let second = native_data_metrics_bytes();
        assert_eq!(first.len(), 152);
        assert_eq!(second.len(), 152);

        STORE.with(|slot| {
            let store = slot.borrow();
            assert_eq!(store.metrics.scalar_gets, 7);
            assert_eq!(store.metrics.encoded_bytes, 128);
        });
    }

    #[test]
    fn movement_scratch_grows_once_then_reuses_capacity() {
        let handle = STORE.with(|slot| {
            let mut store = slot.borrow_mut();
            *store = NativeEntityStore::default();
            store.create(NativeEntityData::Unit(unit(10))).unwrap()
        });
        native_unit_set_movement_input_impl(handle, 1, 0, 1).unwrap();
        native_spatial_create_grid_2d(1, 128, 128, 1_000).unwrap();

        native_map_update_movement(1, 1, 50, 10_016).unwrap();
        let first_growths = STORE.with(|slot| slot.borrow().metrics.scratch_growths);
        native_map_update_movement(1, 2, 50, 10_016).unwrap();
        let second_growths = STORE.with(|slot| slot.borrow().metrics.scratch_growths);

        assert!(first_growths >= 2);
        assert_eq!(second_growths, first_growths);
    }

    #[test]
    fn aoi_batches_share_one_frame_for_identical_audiences() {
        let mut world = AoiWorld::new(
            10_000,
            0,
            0,
            1,
            1,
            vec![SyncTier {
                radius_grids: 1,
                interval_ticks: 1,
            }],
        )
        .unwrap();
        world.attach(1, 0.0, 0.0, true, true).unwrap();
        world.attach(2, 0.0, 0.0, true, true).unwrap();
        world.attach(3, 0.0, 0.0, true, true).unwrap();
        world.take_changes();

        let bytes = encode_aoi_batches(&world, [1, 2, 3], |indices, frame| {
            frame.extend(indices.iter().map(|index| *index as u8));
        });
        assert_eq!(u32::from_le_bytes(bytes[0..4].try_into().unwrap()), 3);
        assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(bytes[8..12].try_into().unwrap()), 3);
    }

    #[test]
    fn aoi_route_frames_match_gate_batch_protobuf() {
        let mut world = AoiWorld::new(
            10_000,
            0,
            0,
            1,
            1,
            vec![SyncTier {
                radius_grids: 1,
                interval_ticks: 1,
            }],
        )
        .unwrap();
        world.attach_routed(1, 0.0, 0.0, true, true, 7).unwrap();
        world.attach_routed(2, 0.0, 0.0, true, true, 8).unwrap();
        world.take_changes();
        let records = [
            encode_snapshot(&unit_hot(1), true),
            encode_snapshot(&unit_hot(2), true),
        ];
        let expected_client_frame = encode_entity_move_frame(10_016, 1, &records);
        let bytes = encode_tiered_aoi_route_frames(&world, &records, 1, 10_016, 20_010).unwrap();

        assert_eq!(u32::from_le_bytes(bytes[0..4].try_into().unwrap()), 2);
        assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 2);
        let mut offset = 8;
        for (expected_route, expected_recipient) in [(7, 1), (8, 2)] {
            assert_eq!(
                u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()),
                expected_route
            );
            let frame_len =
                u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
            offset += 8;
            let frame = &bytes[offset..offset + frame_len];
            offset += frame_len;
            assert_eq!(&frame[..2], &20_010_u16.to_be_bytes());

            let mut payload_offset = 2;
            assert_eq!(take_test_varint(frame, &mut payload_offset), 10);
            let item_len = take_test_varint(frame, &mut payload_offset) as usize;
            let item_end = payload_offset + item_len;
            assert_eq!(take_test_varint(frame, &mut payload_offset), 8);
            assert_eq!(
                take_test_varint(frame, &mut payload_offset),
                expected_recipient
            );
            assert_eq!(take_test_varint(frame, &mut payload_offset), 18);
            let client_len = take_test_varint(frame, &mut payload_offset) as usize;
            assert_eq!(
                &frame[payload_offset..payload_offset + client_len],
                expected_client_frame
            );
            payload_offset += client_len;
            assert_eq!(payload_offset, item_end);
            assert_eq!(item_end, frame.len());
        }
        assert_eq!(offset, bytes.len());
    }

    #[test]
    fn attached_native_unit_must_leave_aoi_before_destroy() {
        let mut store = NativeEntityStore::default();
        store.aoi_worlds.insert(
            1,
            AoiWorld::new(
                10_000,
                0,
                0,
                1,
                1,
                vec![SyncTier {
                    radius_grids: 1,
                    interval_ticks: 1,
                }],
            )
            .unwrap(),
        );
        let handle = store.create(NativeEntityData::Unit(unit(1))).unwrap();
        let (unit_id, _, x, z) = store.unit_spatial(handle).unwrap();
        store
            .aoi_worlds
            .get_mut(&1)
            .unwrap()
            .attach(unit_id, x, z, true, true)
            .unwrap();

        assert!(store.destroy(handle).is_err());
        store.aoi_worlds.get_mut(&1).unwrap().detach(unit_id);
        store.destroy(handle).unwrap();
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
            store.get_number(handle, ITEM_FIELD_CONFIG_ID).unwrap(),
            3001.0
        );
        store.set_number(handle, ITEM_FIELD_COUNT, 3.0).unwrap();
        assert_eq!(store.get_number(handle, ITEM_FIELD_COUNT).unwrap(), 3.0);
        assert!(store.get_unit_hot(handle).is_err());
        store.destroy(handle).unwrap();
        assert!(store.location(handle).is_err());
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
        let bounds = Grid2DBounds::new(128, 128, 1_000).unwrap();
        let mut value = unit_hot(1);
        value.input_x = 1;
        value.sequence = 7;
        value.input_changed = 1;
        assert!(update_movement(&mut value, 10, 50.0, bounds));
        assert_eq!(value.target_cell_x, 1);
        assert_eq!(value.move_end_tick, 12);
        assert_eq!(value.sequence, 7);

        value.input_x = 0;
        value.input_z = 1;
        value.sequence = 8;
        value.input_changed = 1;
        assert!(update_movement(&mut value, 11, 50.0, bounds));
        assert_eq!(value.target_cell_x, 1);
        assert_eq!(value.target_cell_z, 0);

        assert!(update_movement(&mut value, 12, 50.0, bounds));
        assert_eq!(value.cell_x, 1);
        assert_eq!(value.cell_z, 0);
        assert_eq!(value.target_cell_x, 1);
        assert_eq!(value.target_cell_z, 1);
    }

    #[test]
    fn movement_matches_regression_fixture() {
        let bounds = Grid2DBounds::new(128, 128, 1_000).unwrap();
        let fixture: MovementFixture = serde_json::from_str(include_str!(
            "../tests/fixtures/native_data/movement_regression.json"
        ))
        .unwrap();
        let mut value = unit_hot(1);
        value.cell_x = fixture.initial_cell_x;
        value.cell_z = fixture.initial_cell_z;
        value.target_cell_x = fixture.initial_cell_x;
        value.target_cell_z = fixture.initial_cell_z;
        value.x = cell_to_world(fixture.initial_cell_x, bounds.cell_size_meters);
        value.z = cell_to_world(fixture.initial_cell_z, bounds.cell_size_meters);

        for step in fixture.steps {
            if let Some(input) = step.input {
                value.input_changed |=
                    u32::from(value.input_x != input.x || value.input_z != input.z);
                value.input_x = input.x;
                value.input_z = input.z;
                value.sequence = input.sequence;
            }
            let state_changed = update_movement(
                &mut value,
                step.tick,
                fixture.fixed_update_ms as f32,
                bounds,
            );
            let actual = ExpectedMovement {
                acknowledged_sequence: value.sequence,
                from_cell_x: value.cell_x,
                from_cell_z: value.cell_z,
                to_cell_x: value.target_cell_x,
                to_cell_z: value.target_cell_z,
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
        let mut value = unit_hot(1);
        value.sequence = 5;
        value.cell_x = 3;
        value.cell_z = 1;
        value.target_cell_x = 3;
        value.target_cell_z = 1;
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
            z: 0.0,
            yaw: 0.0,
            cell_x: 0,
            cell_z: 0,
            target_cell_x: 0,
            target_cell_z: 0,
            move_start_tick: 0,
            move_end_tick: 0,
            moving: 0,
            facing: 0,
            speed_cells_per_second: 10.0,
            alive: 1,
            input_x: 0,
            input_z: 0,
            input_changed: 0,
            sequence: 0,
        }
    }

    fn unit_hot(id: u32) -> UnitHotData {
        UnitSplitData::from(unit(id)).hot
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

    fn take_test_varint(bytes: &[u8], offset: &mut usize) -> u32 {
        let mut value = 0_u32;
        let mut shift = 0;
        loop {
            let byte = bytes[*offset];
            *offset += 1;
            value |= u32::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return value;
            }
            shift += 7;
        }
    }
}
