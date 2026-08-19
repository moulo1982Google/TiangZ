//! 管理带世代校验的 Entity 数据、脏版本和 Rust 侧 protobuf 投影。 / Owns generation-checked Entity data, dirty revisions, and Rust-side protobuf projection.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use deno_core::convert::Uint8Array;
use deno_core::op2;
use deno_error::JsErrorBox;
use tiangz_transport::navigation::{NavigationAssetCache, NavigationBoxObstacle, NavigationWorld};

use crate::aoi::{AoiWorld, SyncTier, VisibilityChange};
// 生成的Native op绑定当前只导入一个稳定模块；这里仅做兼容转发，业务实现仍归属`src/game`。
// Generated Native op bindings currently import one stable module; this compatibility
// re-export keeps business implementations owned by `src/game`.
pub(crate) use crate::game::{
    op_native_numeric_attach, op_native_numeric_detach, op_native_numeric_get,
    op_native_numeric_set,
};
pub(crate) use crate::game::{
    op_native_unit_reset_movement, op_native_unit_set_movement_input,
    op_native_unit_set_navigation_input, op_native_unit_set_navigation_target,
};
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
const NAVIGATION_INPUT_LEASE_MS: f32 = 1_500.0;
const NAVIGATION_PATH_TURN_SPEED_RADIANS: f32 = std::f32::consts::TAU;

fn normalize_radians(value: f32) -> f32 {
    (value + std::f32::consts::PI).rem_euclid(std::f32::consts::TAU) - std::f32::consts::PI
}

#[derive(Clone)]
struct NavigationMovement {
    points: Vec<[f32; 3]>,
    next_point: usize,
    state_changed: bool,
    obstacle_revision: u64,
}

#[derive(Clone, Copy)]
struct NavigationDirectionalInput {
    forward: i8,
    strafe: i8,
    yaw: f32,
    polygon_ref: u64,
    lease_remaining_ms: f32,
    state_changed: bool,
}

#[derive(Clone, Copy)]
struct NavigationMovementRecord {
    unit_id: u32,
    sequence: u32,
    x: f32,
    y: f32,
    z: f32,
    yaw: f32,
    moving: bool,
    state_changed: bool,
}

#[derive(Clone, Copy)]
struct Grid2DBounds {
    width_cells: u32,
    depth_cells: u32,
    cell_size_millimeters: u32,
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
        let cell_size_millimeters_i64 = i64::from(cell_size_millimeters);
        Ok(Self {
            width_cells,
            depth_cells,
            cell_size_millimeters,
            min_x: -(width / 2) + 1,
            max_x: (width - 1) / 2 - 1,
            min_z: -(depth / 2) + 1,
            max_z: (depth - 1) / 2 - 1,
            cell_size_meters: cell_size_millimeters_i64 as f32 / 1_000.0,
            // Cell 坐标以地图中心附近的 0 为基准；AOI Grid 必须从地图最小 Cell
            // 开始分组，否则奇数个 Grid 的地图会被世界零点额外切出一列。
            // Cell coordinates remain centered around zero, while AOI grids are anchored
            // at the map's minimum cell so odd-sized worlds retain their configured grid count.
            origin_x_millimeters: -i64::from(width / 2) * cell_size_millimeters_i64,
            origin_z_millimeters: -i64::from(depth / 2) * cell_size_millimeters_i64,
        })
    }

    fn contains(self, x: i32, z: i32) -> bool {
        (self.min_x..=self.max_x).contains(&x) && (self.min_z..=self.max_z).contains(&z)
    }
}

thread_local! {
    static STORE: RefCell<NativeEntityStore> = RefCell::new(NativeEntityStore::default());
    static PROJECT_ROOT: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

/// 在V8业务线程启动时固定可信工程根目录；导航资源只能从该目录的navigation子树加载。 / Fixes the trusted project root on the V8 thread so navigation assets can only load from its navigation subtree.
pub(crate) fn configure_project_root(root: &Path) -> Result<(), JsErrorBox> {
    let root = root
        .canonicalize()
        .map_err(|error| JsErrorBox::generic(format!("failed to resolve project root: {error}")))?;
    PROJECT_ROOT.with(|slot| {
        let mut current = slot.borrow_mut();
        if current
            .as_ref()
            .is_some_and(|configured| configured != &root)
        {
            return Err(JsErrorBox::generic(
                "native project root cannot change inside one V8 thread",
            ));
        }
        *current = Some(root);
        Ok(())
    })
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
    numeric_replication: HashMap<u32, NumericTypeReplicationMetrics>,
}

#[derive(Clone, Default)]
struct NumericTypeReplicationMetrics {
    changes: u64,
    encoded_records: u64,
    recipient_deliveries: u64,
    logical_bytes: u64,
}

struct EntitySlot {
    generation: u32,
    location: Option<NativePoolLocation>,
}

#[derive(Default)]
struct NumericData {
    values: HashMap<u32, i64>,
    dirty: HashMap<u32, u64>,
    urgent: HashMap<u32, u64>,
}

const NUMERIC_CURRENT_HP: u32 = 1;

#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NumericReplicationSelection {
    ExcludeListedTypes = 0,
    IncludeListedTypes = 1,
}

impl TryFrom<u32> for NumericReplicationSelection {
    type Error = JsErrorBox;

    fn try_from(value: u32) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::ExcludeListedTypes),
            1 => Ok(Self::IncludeListedTypes),
            _ => Err(JsErrorBox::generic(format!(
                "invalid Numeric replication selection mode: {value}"
            ))),
        }
    }
}

impl NumericReplicationSelection {
    fn matches(self, numeric_type: u32, selected_types: &HashSet<u32>) -> bool {
        match self {
            Self::ExcludeListedTypes => !selected_types.contains(&numeric_type),
            Self::IncludeListedTypes => selected_types.contains(&numeric_type),
        }
    }
}

/// AOI 路由帧编码的线程内暂存区；只服务当前 V8 业务线程，不跨调用共享。
/// Per-thread scratch for AOI route-frame encoding; it is owned by one V8 business thread and never shared across calls.
#[derive(Default)]
struct AoiRouteFrameScratch {
    subject_ids: Vec<u32>,
    force: Vec<bool>,
    payloads_by_route: Vec<Vec<u8>>,
    recipients_by_route: Vec<Vec<u32>>,
    touched_routes: Vec<usize>,
    client_frame: Vec<u8>,
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
    spatial_bounds: HashMap<u32, Grid2DBounds>,
    navigation_assets: NavigationAssetCache,
    navigation_worlds: HashMap<u32, NavigationWorld>,
    navigation_movements: HashMap<u32, NavigationMovement>,
    navigation_directional_inputs: HashMap<u32, NavigationDirectionalInput>,
    aoi_worlds: HashMap<u32, AoiWorld>,
    aoi_dirty_by_map: HashMap<u32, HashSet<u32>>,
    numerics_by_unit: HashMap<u32, NumericData>,
    scratch_handles: Vec<u32>,
    scratch_movement_records: Vec<[u8; NATIVE_UNIT_RECORD_BYTES]>,
    scratch_changed_positions: Vec<(u32, f32, f32)>,
    pending_movement_records: HashMap<u32, Vec<[u8; NATIVE_UNIT_RECORD_BYTES]>>,
    scratch_navigation_records: Vec<NavigationMovementRecord>,
    pending_navigation_records: HashMap<u32, Vec<NavigationMovementRecord>>,
    scratch_numeric_records: Vec<(u32, u32, i64)>,
    scratch_unit_delta_records: Vec<UnitDeltaRecord>,
    route_frame_scratch: AoiRouteFrameScratch,
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
            self.navigation_movements.remove(&handle);
            self.navigation_directional_inputs.remove(&handle);
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
            + self.scratch_navigation_records.capacity()
                * std::mem::size_of::<NavigationMovementRecord>()
            + self
                .pending_navigation_records
                .values()
                .map(Vec::capacity)
                .sum::<usize>()
                * std::mem::size_of::<NavigationMovementRecord>()
            + self.scratch_numeric_records.capacity() * std::mem::size_of::<(u32, u32, i64)>()
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

/// 更新Unit移动意图；仅供`src/game`中的业务op使用，不是生成ABI入口。 / Updates Unit movement intent for game-owned ops; this is not a generated ABI entrypoint.
pub(crate) fn set_unit_movement_input(
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

/// 清除Unit当前及排队移动；调用方必须已经处于正确的Actor/mailbox顺序中。 / Clears current and queued Unit movement; callers must already hold the correct Actor/mailbox ordering.
pub(crate) fn reset_unit_movement(handle: u32) -> Result<(), JsErrorBox> {
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        store.metrics.scalar_sets += 1;
        let location = store.location(handle)?;
        let map_id = store
            .pools
            .get_unit_cold(location)
            .ok_or_else(|| wrong_entity_type(handle, "Unit"))?
            .map_id;
        if store.navigation_worlds.contains_key(&map_id) {
            store.navigation_movements.remove(&handle);
            store.navigation_directional_inputs.remove(&handle);
            let unit = store.get_unit_hot_mut(handle)?;
            unit.input_x = 0;
            unit.input_z = 0;
            unit.input_changed = 0;
            unit.sequence = 0;
            unit.moving = 0;
            return Ok(());
        }
        let bounds = *store.spatial_bounds.get(&map_id).ok_or_else(|| {
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

/// 挂载Numeric存储；只向`src/game/numeric`提供生命周期原语。 / Attaches Numeric storage as a lifecycle primitive only for `src/game/numeric`.
pub(crate) fn attach_numeric(unit_handle: u32) -> Result<(), JsErrorBox> {
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

/// 移除Numeric存储；重复移除会明确报错。 / Removes Numeric storage and reports duplicate removal explicitly.
pub(crate) fn detach_numeric(unit_handle: u32) -> Result<(), JsErrorBox> {
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        if store.numerics_by_unit.remove(&unit_handle).is_none() {
            return Err(JsErrorBox::generic("native Numeric is not attached"));
        }
        Ok(())
    })
}

/// 读取一个Numeric值；未设置的key返回零。 / Reads one Numeric value and returns zero for an unset key.
pub(crate) fn numeric_value(unit_handle: u32, numeric_type: u32) -> Result<i64, JsErrorBox> {
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

/// 原子提交一组已完成派生计算的Numeric值，并逐字段维护脏版本。 / Atomically commits derived Numeric values and maintains per-field dirty revisions.
pub(crate) fn set_numeric_values(
    unit_handle: u32,
    values: &[(u32, i64)],
) -> Result<bool, JsErrorBox> {
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        store.get_unit_hot(unit_handle)?;
        let numeric = store
            .numerics_by_unit
            .get(&unit_handle)
            .ok_or_else(|| JsErrorBox::generic("native Numeric is not attached"))?;
        let changed: Vec<_> = values
            .iter()
            .copied()
            .filter_map(|(numeric_type, value)| {
                let previous = numeric.values.get(&numeric_type).copied().unwrap_or(0);
                (previous != value).then_some((numeric_type, value, previous))
            })
            .collect();
        if changed.is_empty() {
            return Ok(false);
        }
        for (numeric_type, value, previous) in changed {
            let revision = store.next_numeric_revision();
            let numeric = store.numerics_by_unit.get_mut(&unit_handle).unwrap();
            numeric.values.insert(numeric_type, value);
            numeric.dirty.insert(numeric_type, revision);
            if numeric_type == NUMERIC_CURRENT_HP
                && ((previous > 0 && value <= 0) || (previous <= 0 && value > 0))
            {
                numeric.urgent.insert(numeric_type, revision);
            }
            store
                .metrics
                .numeric_replication
                .entry(numeric_type)
                .or_default()
                .changes += 1;
        }
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

#[op2]
/// 将Numeric脏字典直接编码为每个Gate的最终批量帧，并在前缀中保留统一Ack版本。
/// Encodes Numeric dirty entries into final per-Gate batch frames while preserving one Ack revision prefix.
pub(crate) fn op_native_map_peek_numeric_aoi_route_frames(
    map_id: u32,
    server_tick: u32,
    client_message_code: u32,
    route_message_code: u32,
    #[buffer] aoi_visible_types: &[u8],
    #[buffer] selected_types: &[u8],
    selection_mode: u32,
    publish_due: bool,
) -> Result<Uint8Array, JsErrorBox> {
    native_map_peek_numeric_aoi_route_frames(
        map_id,
        server_tick,
        client_message_code,
        route_message_code,
        aoi_visible_types,
        selected_types,
        selection_mode,
        publish_due,
    )
    .map(Into::into)
}

#[allow(clippy::too_many_arguments)]
fn native_map_peek_numeric_aoi_route_frames(
    map_id: u32,
    server_tick: u32,
    client_message_code: u32,
    route_message_code: u32,
    aoi_visible_types: &[u8],
    selected_types: &[u8],
    selection_mode: u32,
    publish_due: bool,
) -> Result<Vec<u8>, JsErrorBox> {
    let client_message_code = u16::try_from(client_message_code)
        .map_err(|_| JsErrorBox::generic("numeric message code exceeds uint16"))?;
    let route_message_code = u16::try_from(route_message_code)
        .map_err(|_| JsErrorBox::generic("Gate route message code exceeds uint16"))?;
    let aoi_visible_types = decode_numeric_type_set(aoi_visible_types, "AOI-visible")?;
    let selected_types = decode_numeric_type_set(selected_types, "selected")?;
    let selection = NumericReplicationSelection::try_from(selection_mode)?;
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        let through_revision = store.numeric_revision;
        let handles = store.take_map_handles(map_id);
        let mut records = take_scratch(&mut store.scratch_numeric_records);
        let previous_capacity = records.capacity();
        let outcome = (|| {
            let has_urgent = !publish_due
                && handles.iter().any(|handle| {
                    store.numerics_by_unit.get(handle).is_some_and(|numeric| {
                        numeric.urgent.iter().any(|(&numeric_type, &revision)| {
                            revision <= through_revision
                                && selection.matches(numeric_type, &selected_types)
                                && numeric.dirty.contains_key(&numeric_type)
                        })
                    })
                });
            if !publish_due && !has_urgent {
                let token = encode_numeric_replication_revision(
                    through_revision,
                    selection,
                    &selected_types,
                );
                let mut result = Vec::with_capacity(4 + token.len() + 8);
                result.extend_from_slice(&(token.len() as u32).to_le_bytes());
                result.extend_from_slice(&token);
                result.extend_from_slice(&0_u32.to_le_bytes());
                result.extend_from_slice(&0_u32.to_le_bytes());
                return Ok(result);
            }
            for &handle in &handles {
                let unit_id = store.get_unit_hot(handle)?.id;
                if let Some(numeric) = store.numerics_by_unit.get(&handle) {
                    for (&numeric_type, &revision) in &numeric.dirty {
                        if revision <= through_revision
                            && selection.matches(numeric_type, &selected_types)
                        {
                            records.push((unit_id, numeric_type, numeric.values[&numeric_type]));
                        }
                    }
                }
            }
            records.sort_unstable_by_key(|record| (record.0, record.1));
            let subject_ids: Vec<_> = records.iter().map(|record| record.0).collect();
            let owner_only: Vec<_> = records
                .iter()
                .map(|record| !aoi_visible_types.contains(&record.1))
                .collect();
            let route_frames = {
                let NativeEntityStore {
                    aoi_worlds,
                    route_frame_scratch,
                    metrics,
                    ..
                } = &mut *store;
                let world = aoi_worlds.get(&map_id).ok_or_else(|| {
                    JsErrorBox::generic(format!("AOI world is not configured: {map_id}"))
                })?;
                let delivery_groups = world.visibility_delivery_groups(&subject_ids, &owner_only);
                record_numeric_replication_metrics(metrics, &records, &delivery_groups);
                encode_aoi_route_frames_from_groups(
                    world,
                    delivery_groups,
                    route_message_code,
                    route_frame_scratch,
                    |indices, frame| {
                        let subset: Vec<_> = indices.iter().map(|index| records[*index]).collect();
                        encode_entity_numeric_frame_into(
                            frame,
                            client_message_code,
                            server_tick,
                            &subset,
                        );
                    },
                )?
            };
            record_aoi_encoding_metrics(&mut store.metrics, &route_frames);
            let token =
                encode_numeric_replication_revision(through_revision, selection, &selected_types);
            let mut result = Vec::with_capacity(4 + token.len() + route_frames.len());
            result.extend_from_slice(&(token.len() as u32).to_le_bytes());
            result.extend_from_slice(&token);
            result.extend_from_slice(&route_frames);
            Ok(result)
        })();
        store.metrics.scratch_growths += u64::from(records.capacity() > previous_capacity);
        store.scratch_handles = handles;
        store.scratch_numeric_records = records;
        outcome
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
    let policy = decode_numeric_replication_revision(revision)?;
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        let handles = store.units_by_map.get(&map_id).cloned().unwrap_or_default();
        for handle in handles {
            if let Some(numeric) = store.numerics_by_unit.get_mut(&handle) {
                numeric.dirty.retain(|numeric_type, dirty_revision| {
                    *dirty_revision > policy.through_revision || !policy.matches(*numeric_type)
                });
                numeric.urgent.retain(|numeric_type, urgent_revision| {
                    *urgent_revision > policy.through_revision || !policy.matches(*numeric_type)
                });
            }
        }
        Ok(())
    })
}

struct NumericReplicationRevision {
    through_revision: u64,
    selection: Option<NumericReplicationSelection>,
    selected_types: HashSet<u32>,
}

impl NumericReplicationRevision {
    fn matches(&self, numeric_type: u32) -> bool {
        self.selection
            .is_none_or(|selection| selection.matches(numeric_type, &self.selected_types))
    }
}

fn decode_numeric_type_set(bytes: &[u8], label: &str) -> Result<HashSet<u32>, JsErrorBox> {
    if !bytes.len().is_multiple_of(4) {
        return Err(JsErrorBox::generic(format!(
            "{label} Numeric type payload must contain uint32 values"
        )));
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|bytes| u32::from_le_bytes(bytes.try_into().unwrap()))
        .collect())
}

fn encode_numeric_replication_revision(
    through_revision: u64,
    selection: NumericReplicationSelection,
    selected_types: &HashSet<u32>,
) -> Vec<u8> {
    let mut sorted_types: Vec<_> = selected_types.iter().copied().collect();
    sorted_types.sort_unstable();
    let mut bytes = Vec::with_capacity(16 + sorted_types.len() * 4);
    bytes.extend_from_slice(&through_revision.to_le_bytes());
    bytes.extend_from_slice(&(selection as u32).to_le_bytes());
    bytes.extend_from_slice(&(sorted_types.len() as u32).to_le_bytes());
    for numeric_type in sorted_types {
        bytes.extend_from_slice(&numeric_type.to_le_bytes());
    }
    bytes
}

fn decode_numeric_replication_revision(
    bytes: &[u8],
) -> Result<NumericReplicationRevision, JsErrorBox> {
    if bytes.len() == 8 {
        return Ok(NumericReplicationRevision {
            through_revision: u64::from_le_bytes(bytes.try_into().unwrap()),
            selection: None,
            selected_types: HashSet::new(),
        });
    }
    if bytes.len() < 16 {
        return Err(JsErrorBox::generic(
            "numeric replication revision is truncated",
        ));
    }
    let through_revision = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
    let selection = NumericReplicationSelection::try_from(u32::from_le_bytes(
        bytes[8..12].try_into().unwrap(),
    ))?;
    let type_count = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
    let expected_length = 16_usize
        .checked_add(type_count.saturating_mul(4))
        .ok_or_else(|| JsErrorBox::generic("numeric replication revision is too large"))?;
    if bytes.len() != expected_length {
        return Err(JsErrorBox::generic(
            "numeric replication revision has an invalid length",
        ));
    }
    Ok(NumericReplicationRevision {
        through_revision,
        selection: Some(selection),
        selected_types: decode_numeric_type_set(&bytes[16..], "selected")?,
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
/// 注册一张Grid2D地图的移动边界；同一MapInstance重复创建会被拒绝。 / Registers Grid2D movement bounds and rejects duplicate creation for one MapInstance.
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
        let mut store = slot.borrow_mut();
        if store.spatial_bounds.contains_key(&map_id) {
            return Err(JsErrorBox::generic(format!(
                "map spatial world is already configured: {map_id}"
            )));
        }
        store.spatial_bounds.insert(map_id, bounds);
        Ok(())
    })
}

#[op2(fast)]
/// 从冷配置加载共享NavMesh资产并创建实例独占查询上下文；路径不得越出navigation目录。 / Loads a shared cold NavMesh asset and creates an instance-owned query context within the navigation directory.
pub(crate) fn op_native_spatial_create_nav_mesh3_d(
    map_id: u32,
    width_cells: u32,
    depth_cells: u32,
    cell_size_millimeters: u32,
    #[buffer] asset_path: &[u8],
    #[buffer] expected_hash: &[u8],
) -> Result<(), JsErrorBox> {
    native_spatial_create_nav_mesh_3d(
        map_id,
        width_cells,
        depth_cells,
        cell_size_millimeters,
        asset_path,
        expected_hash,
    )
}

fn native_spatial_create_nav_mesh_3d(
    map_id: u32,
    width_cells: u32,
    depth_cells: u32,
    cell_size_millimeters: u32,
    asset_path: &[u8],
    expected_hash: &[u8],
) -> Result<(), JsErrorBox> {
    let bounds = Grid2DBounds::new(width_cells, depth_cells, cell_size_millimeters)?;
    let asset_path = decode_utf8(asset_path, "navigation asset path")?;
    let expected_hash = decode_utf8(expected_hash, "navigation asset hash")?;
    let bytes = read_navigation_asset(asset_path)?;
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        if store.spatial_bounds.contains_key(&map_id) {
            return Err(JsErrorBox::generic(format!(
                "map spatial world is already configured: {map_id}"
            )));
        }
        let asset = store
            .navigation_assets
            .load(bytes, expected_hash)
            .map_err(|error| JsErrorBox::generic(format!("{error:#}")))?;
        let world = asset
            .create_world()
            .map_err(|error| JsErrorBox::generic(format!("{error:#}")))?;
        store.spatial_bounds.insert(map_id, bounds);
        store.navigation_worlds.insert(map_id, world);
        Ok(())
    })
}

#[op2]
/// 把地图局部米制坐标投影到最近可行走面；未命中时返回空数组。 / Projects a map-local meter position onto the nearest walkable surface and returns empty bytes on a miss.
pub(crate) fn op_native_spatial_project_position(
    map_id: u32,
    x: f64,
    y: f64,
    z: f64,
    extent_x: f64,
    extent_y: f64,
    extent_z: f64,
) -> Result<Uint8Array, JsErrorBox> {
    native_spatial_project_position(map_id, x, y, z, extent_x, extent_y, extent_z).map(Into::into)
}

fn native_spatial_project_position(
    map_id: u32,
    x: f64,
    y: f64,
    z: f64,
    extent_x: f64,
    extent_y: f64,
    extent_z: f64,
) -> Result<Vec<u8>, JsErrorBox> {
    let point = [
        finite_f32(x, "x")?,
        finite_f32(y, "y")?,
        finite_f32(z, "z")?,
    ];
    let extents = [
        positive_f32(extent_x, "extentX")?,
        positive_f32(extent_y, "extentY")?,
        positive_f32(extent_z, "extentZ")?,
    ];
    STORE.with(|slot| {
        let store = slot.borrow();
        let world = store.navigation_worlds.get(&map_id).ok_or_else(|| {
            JsErrorBox::generic(format!("NavMesh world is not configured: {map_id}"))
        })?;
        Ok(world
            .project(point, extents)
            .map(|point| encode_nav_points([point]))
            .unwrap_or_default())
    })
}

#[op2]
/// 一次返回有界的路径拐点数组；禁止逐节点跨V8查询。 / Returns a bounded path-corner array in one call instead of crossing V8 once per node.
pub(crate) fn op_native_spatial_find_path(
    map_id: u32,
    start_x: f64,
    start_y: f64,
    start_z: f64,
    end_x: f64,
    end_y: f64,
    end_z: f64,
    extent_x: f64,
    extent_y: f64,
    extent_z: f64,
    max_points: u32,
) -> Result<Uint8Array, JsErrorBox> {
    native_spatial_find_path(
        map_id, start_x, start_y, start_z, end_x, end_y, end_z, extent_x, extent_y, extent_z,
        max_points,
    )
    .map(Into::into)
}

#[allow(clippy::too_many_arguments)]
fn native_spatial_find_path(
    map_id: u32,
    start_x: f64,
    start_y: f64,
    start_z: f64,
    end_x: f64,
    end_y: f64,
    end_z: f64,
    extent_x: f64,
    extent_y: f64,
    extent_z: f64,
    max_points: u32,
) -> Result<Vec<u8>, JsErrorBox> {
    if !(1..=256).contains(&max_points) {
        return Err(JsErrorBox::generic(
            "NavMesh maxPoints must be between 1 and 256",
        ));
    }
    let start = [
        finite_f32(start_x, "startX")?,
        finite_f32(start_y, "startY")?,
        finite_f32(start_z, "startZ")?,
    ];
    let end = [
        finite_f32(end_x, "endX")?,
        finite_f32(end_y, "endY")?,
        finite_f32(end_z, "endZ")?,
    ];
    let extents = [
        positive_f32(extent_x, "extentX")?,
        positive_f32(extent_y, "extentY")?,
        positive_f32(extent_z, "extentZ")?,
    ];
    STORE.with(|slot| {
        let store = slot.borrow();
        let world = store.navigation_worlds.get(&map_id).ok_or_else(|| {
            JsErrorBox::generic(format!("NavMesh world is not configured: {map_id}"))
        })?;
        let points = world
            .find_path(start, end, extents, max_points as usize)
            .map_err(|error| JsErrorBox::generic(format!("{error:#}")))?;
        Ok(encode_nav_points(&points))
    })
}

#[op2]
/// 检测NavMesh表面两点间的首个边界命中；返回固定长度结果，未命中也包含终点。 / Finds the first NavMesh boundary hit and returns a fixed-size result whose miss position is the end point.
pub(crate) fn op_native_spatial_raycast(
    map_id: u32,
    start_x: f64,
    start_y: f64,
    start_z: f64,
    end_x: f64,
    end_y: f64,
    end_z: f64,
    extent_x: f64,
    extent_y: f64,
    extent_z: f64,
) -> Result<Uint8Array, JsErrorBox> {
    native_spatial_raycast(
        map_id, start_x, start_y, start_z, end_x, end_y, end_z, extent_x, extent_y, extent_z,
    )
    .map(Into::into)
}

#[allow(clippy::too_many_arguments)]
fn native_spatial_raycast(
    map_id: u32,
    start_x: f64,
    start_y: f64,
    start_z: f64,
    end_x: f64,
    end_y: f64,
    end_z: f64,
    extent_x: f64,
    extent_y: f64,
    extent_z: f64,
) -> Result<Vec<u8>, JsErrorBox> {
    let start = [
        finite_f32(start_x, "startX")?,
        finite_f32(start_y, "startY")?,
        finite_f32(start_z, "startZ")?,
    ];
    let end = [
        finite_f32(end_x, "endX")?,
        finite_f32(end_y, "endY")?,
        finite_f32(end_z, "endZ")?,
    ];
    let extents = [
        positive_f32(extent_x, "extentX")?,
        positive_f32(extent_y, "extentY")?,
        positive_f32(extent_z, "extentZ")?,
    ];
    STORE.with(|slot| {
        let store = slot.borrow();
        let hit = store
            .navigation_worlds
            .get(&map_id)
            .ok_or_else(|| {
                JsErrorBox::generic(format!("NavMesh world is not configured: {map_id}"))
            })?
            .raycast(start, end, extents)
            .ok_or_else(|| {
                JsErrorBox::generic("NavMesh raycast start is outside the query extents")
            })?;
        let mut bytes = Vec::with_capacity(29);
        bytes.push(u8::from(hit.hit));
        bytes.extend_from_slice(&hit.fraction.to_le_bytes());
        for value in hit.position.into_iter().chain(hit.normal) {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        Ok(bytes)
    })
}

#[op2(fast)]
/// 按输入Y选择最近NavMesh层并返回地面高度；找不到可行走面时明确报错。 / Selects the nearest NavMesh layer by input Y and returns its floor height, failing when no surface is found.
pub(crate) fn op_native_spatial_sample_height(
    map_id: u32,
    x: f64,
    y: f64,
    z: f64,
    extent_x: f64,
    extent_y: f64,
    extent_z: f64,
) -> Result<f64, JsErrorBox> {
    let point = [
        finite_f32(x, "x")?,
        finite_f32(y, "y")?,
        finite_f32(z, "z")?,
    ];
    let extents = [
        positive_f32(extent_x, "extentX")?,
        positive_f32(extent_y, "extentY")?,
        positive_f32(extent_z, "extentZ")?,
    ];
    STORE.with(|slot| {
        slot.borrow()
            .navigation_worlds
            .get(&map_id)
            .ok_or_else(|| {
                JsErrorBox::generic(format!("NavMesh world is not configured: {map_id}"))
            })?
            .sample_height(point, extents)
            .map(f64::from)
            .ok_or_else(|| {
                JsErrorBox::generic("NavMesh height sample is outside the query extents")
            })
    })
}

#[op2(fast)]
/// 以稳定ObstacleId创建或修改MapInstance私有盒形障碍；只更新目标状态，不在Handler中重建Tile。 / Creates or updates an instance-local box obstacle without rebuilding tiles inside a Handler.
#[allow(clippy::too_many_arguments)]
pub(crate) fn op_native_spatial_upsert_box_obstacle(
    map_id: u32,
    obstacle_id: u32,
    center_x: f64,
    center_y: f64,
    center_z: f64,
    half_x: f64,
    half_y: f64,
    half_z: f64,
    yaw_radians: f64,
) -> Result<bool, JsErrorBox> {
    native_spatial_upsert_box_obstacle(
        map_id,
        obstacle_id,
        center_x,
        center_y,
        center_z,
        half_x,
        half_y,
        half_z,
        yaw_radians,
    )
}

#[allow(clippy::too_many_arguments)]
fn native_spatial_upsert_box_obstacle(
    map_id: u32,
    obstacle_id: u32,
    center_x: f64,
    center_y: f64,
    center_z: f64,
    half_x: f64,
    half_y: f64,
    half_z: f64,
    yaw_radians: f64,
) -> Result<bool, JsErrorBox> {
    let specification = NavigationBoxObstacle {
        center: [
            finite_f32(center_x, "centerX")?,
            finite_f32(center_y, "centerY")?,
            finite_f32(center_z, "centerZ")?,
        ],
        half_extents: [
            positive_f32(half_x, "halfX")?,
            positive_f32(half_y, "halfY")?,
            positive_f32(half_z, "halfZ")?,
        ],
        yaw_radians: finite_f32(yaw_radians, "yawRadians")?,
    };
    STORE.with(|slot| {
        slot.borrow_mut()
            .navigation_worlds
            .get_mut(&map_id)
            .ok_or_else(|| {
                JsErrorBox::generic(format!("NavMesh world is not configured: {map_id}"))
            })?
            .upsert_box_obstacle(obstacle_id, specification)
            .map_err(|error| JsErrorBox::generic(format!("{error:#}")))
    })
}

#[op2(fast)]
/// 幂等删除MapInstance内的动态障碍；不存在时返回false。 / Idempotently removes an instance-local obstacle and returns false when absent.
pub(crate) fn op_native_spatial_remove_obstacle(
    map_id: u32,
    obstacle_id: u32,
) -> Result<bool, JsErrorBox> {
    native_spatial_remove_obstacle(map_id, obstacle_id)
}

fn native_spatial_remove_obstacle(map_id: u32, obstacle_id: u32) -> Result<bool, JsErrorBox> {
    STORE.with(|slot| {
        Ok(slot
            .borrow_mut()
            .navigation_worlds
            .get_mut(&map_id)
            .ok_or_else(|| {
                JsErrorBox::generic(format!("NavMesh world is not configured: {map_id}"))
            })?
            .remove_obstacle(obstacle_id))
    })
}

#[op2]
/// 按帧预算提交障碍命令并重建Tile；返回命令数、Tile数、Rust等待数和完成标志。 / Applies obstacle commands and tile rebuilds within one frame budget.
pub(crate) fn op_native_spatial_update_obstacles(
    map_id: u32,
    max_commands: u32,
    max_tile_updates: u32,
) -> Result<Uint8Array, JsErrorBox> {
    native_spatial_update_obstacles(map_id, max_commands, max_tile_updates).map(Into::into)
}

fn native_spatial_update_obstacles(
    map_id: u32,
    max_commands: u32,
    max_tile_updates: u32,
) -> Result<Vec<u8>, JsErrorBox> {
    STORE.with(|slot| {
        let update = slot
            .borrow_mut()
            .navigation_worlds
            .get_mut(&map_id)
            .ok_or_else(|| {
                JsErrorBox::generic(format!("NavMesh world is not configured: {map_id}"))
            })?
            .update_obstacles(max_commands, max_tile_updates)
            .map_err(|error| JsErrorBox::generic(format!("{error:#}")))?;
        let mut bytes = Vec::with_capacity(17);
        bytes.extend_from_slice(&update.applied_commands.to_le_bytes());
        bytes.extend_from_slice(&update.rebuilt_tiles.to_le_bytes());
        bytes.extend_from_slice(&update.pending_commands.to_le_bytes());
        bytes.extend_from_slice(&update.obstacle_count.to_le_bytes());
        bytes.push(u8::from(update.up_to_date));
        Ok(bytes)
    })
}

/// 设置Unit的NavMesh移动目标；返回值前4字节是确认序号，后续是路径点数组。 / Sets a Unit NavMesh target; the first four bytes are the acknowledged sequence followed by path points.
#[allow(clippy::too_many_arguments)]
pub(crate) fn set_unit_navigation_target(
    map_id: u32,
    handle: u32,
    target_x: f64,
    target_y: f64,
    target_z: f64,
    sequence: u32,
) -> Result<Vec<u8>, JsErrorBox> {
    let target = [
        finite_f32(target_x, "targetX")?,
        finite_f32(target_y, "targetY")?,
        finite_f32(target_z, "targetZ")?,
    ];
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        let (current, current_sequence, unit_map_id) = {
            let (hot, cold) = store.get_unit_parts(handle)?;
            ([hot.x, hot.y, hot.z], hot.sequence, cold.map_id)
        };
        if unit_map_id != map_id {
            return Err(JsErrorBox::generic(format!(
                "native Unit belongs to map {unit_map_id}, not {map_id}"
            )));
        }
        if sequence <= current_sequence {
            let mut result = Vec::with_capacity(4);
            result.extend_from_slice(&current_sequence.to_le_bytes());
            return Ok(result);
        }
        let world = store.navigation_worlds.get(&map_id).ok_or_else(|| {
            JsErrorBox::generic(format!("NavMesh world is not configured: {map_id}"))
        })?;
        let points = world
            .find_path(current, target, [2.0, 4.0, 2.0], 64)
            .map_err(|error| JsErrorBox::generic(format!("{error:#}")))?;
        let obstacle_revision = world.obstacle_revision();
        {
            let unit = store.get_unit_hot_mut(handle)?;
            unit.sequence = sequence;
            unit.input_x = 0;
            unit.input_z = 0;
            unit.input_changed = 0;
            unit.moving = u32::from(points.len() > 1);
        }
        store.navigation_movements.insert(
            handle,
            NavigationMovement {
                next_point: usize::from(points.len() > 1),
                points: points.clone(),
                state_changed: true,
                obstacle_revision,
            },
        );
        store.navigation_directional_inputs.remove(&handle);
        let mut result = Vec::with_capacity(8 + points.len() * 12);
        result.extend_from_slice(&sequence.to_le_bytes());
        result.extend_from_slice(&encode_nav_points(&points));
        Ok(result)
    })
}

/// 提交相对朝向的NavMesh方向状态；Rust在每个固定Tick贴着可行走面推进，零输入明确停止。 / Submits facing-relative NavMesh input that Rust advances along the surface every fixed tick; zero input explicitly stops.
pub(crate) fn set_unit_navigation_input(
    map_id: u32,
    handle: u32,
    forward: i8,
    strafe: i8,
    yaw: f64,
    sequence: u32,
) -> Result<Vec<u8>, JsErrorBox> {
    if !(-1..=1).contains(&forward) || !(-1..=1).contains(&strafe) {
        return Err(JsErrorBox::generic(
            "navigation input must use discrete values from -1 to 1",
        ));
    }
    let yaw = finite_f32(yaw, "yaw")?;
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        let (current_sequence, unit_map_id) = {
            let (hot, cold) = store.get_unit_parts(handle)?;
            (hot.sequence, cold.map_id)
        };
        if unit_map_id != map_id {
            return Err(JsErrorBox::generic(format!(
                "Unit map mismatch: expected {map_id}, actual {unit_map_id}"
            )));
        }
        if sequence <= current_sequence {
            return Ok(current_sequence.to_le_bytes().to_vec());
        }
        {
            let unit = store.get_unit_hot_mut(handle)?;
            unit.sequence = sequence;
            unit.yaw = yaw;
            unit.input_x = 0;
            unit.input_z = 0;
            unit.input_changed = 0;
            unit.moving = u32::from(forward != 0 || strafe != 0);
        }
        store.navigation_movements.remove(&handle);
        let polygon_ref = store
            .navigation_directional_inputs
            .get(&handle)
            .map_or(0, |input| input.polygon_ref);
        store.navigation_directional_inputs.insert(
            handle,
            NavigationDirectionalInput {
                forward,
                strafe,
                yaw,
                polygon_ref,
                lease_remaining_ms: NAVIGATION_INPUT_LEASE_MS,
                state_changed: true,
            },
        );
        Ok(sequence.to_le_bytes().to_vec())
    })
}

fn decode_utf8<'a>(bytes: &'a [u8], name: &str) -> Result<&'a str, JsErrorBox> {
    let value = std::str::from_utf8(bytes)
        .map_err(|_| JsErrorBox::generic(format!("{name} must be UTF-8")))?;
    if value.is_empty() {
        return Err(JsErrorBox::generic(format!("{name} must not be empty")));
    }
    Ok(value)
}

fn read_navigation_asset(relative: &str) -> Result<Vec<u8>, JsErrorBox> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || relative.components().next() != Some(Component::Normal("navigation".as_ref()))
    {
        return Err(JsErrorBox::generic(
            "navigation asset must be a normalized relative path below navigation/",
        ));
    }
    PROJECT_ROOT.with(|slot| {
        let root = slot
            .borrow()
            .clone()
            .ok_or_else(|| JsErrorBox::generic("native project root is not configured"))?;
        let navigation_root = root.join("navigation").canonicalize().map_err(|error| {
            JsErrorBox::generic(format!("failed to resolve navigation directory: {error}"))
        })?;
        let path = root.join(relative).canonicalize().map_err(|error| {
            JsErrorBox::generic(format!("failed to resolve navigation asset: {error}"))
        })?;
        if !path.starts_with(&navigation_root) {
            return Err(JsErrorBox::generic(
                "navigation asset resolves outside the navigation directory",
            ));
        }
        fs::read(&path).map_err(|error| {
            JsErrorBox::generic(format!(
                "failed to read navigation asset {}: {error}",
                path.display()
            ))
        })
    })
}

fn finite_f32(value: f64, name: &str) -> Result<f32, JsErrorBox> {
    if !value.is_finite() || value < f32::MIN as f64 || value > f32::MAX as f64 {
        return Err(JsErrorBox::generic(format!("{name} must fit a finite f32")));
    }
    Ok(value as f32)
}

fn positive_f32(value: f64, name: &str) -> Result<f32, JsErrorBox> {
    let value = finite_f32(value, name)?;
    if value <= 0.0 {
        return Err(JsErrorBox::generic(format!("{name} must be positive")));
    }
    Ok(value)
}

fn encode_nav_points(points: impl AsRef<[[f32; 3]]>) -> Vec<u8> {
    let points = points.as_ref();
    let mut bytes = Vec::with_capacity(4 + points.len() * 12);
    bytes.extend_from_slice(&(points.len() as u32).to_le_bytes());
    for point in points {
        for coordinate in point {
            bytes.extend_from_slice(&coordinate.to_le_bytes());
        }
    }
    bytes
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
        .with(|slot| slot.borrow().spatial_bounds.get(&map_id).copied())
        .ok_or_else(|| {
            JsErrorBox::generic(format!("map spatial world is not configured: {map_id}"))
        })?;
    let width_millimeters = u64::from(bounds.width_cells) * u64::from(bounds.cell_size_millimeters);
    let depth_millimeters = u64::from(bounds.depth_cells) * u64::from(bounds.cell_size_millimeters);
    if width_millimeters % u64::from(grid_size_millimeters) != 0
        || depth_millimeters % u64::from(grid_size_millimeters) != 0
    {
        return Err(JsErrorBox::generic(
            "map dimensions must be divisible by the AOI grid size",
        ));
    }
    let world = AoiWorld::new(
        grid_size_millimeters,
        bounds.origin_x_millimeters,
        bounds.origin_z_millimeters,
        u32::try_from(width_millimeters / u64::from(grid_size_millimeters))
            .map_err(|_| JsErrorBox::generic("AOI grid width exceeds uint32"))?,
        u32::try_from(depth_millimeters / u64::from(grid_size_millimeters))
            .map_err(|_| JsErrorBox::generic("AOI grid depth exceeds uint32"))?,
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
    native_spatial_release(map_id);
}

fn native_spatial_release(map_id: u32) {
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        if let Some(handles) = store.units_by_map.get(&map_id).cloned() {
            for handle in handles {
                store.navigation_movements.remove(&handle);
                store.navigation_directional_inputs.remove(&handle);
            }
        }
        store.pending_navigation_records.remove(&map_id);
        store.pending_movement_records.remove(&map_id);
        store.spatial_bounds.remove(&map_id);
        store.navigation_worlds.remove(&map_id);
        store.navigation_assets.prune();
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
            .spatial_bounds
            .get(&map_id)
            .ok_or_else(|| JsErrorBox::generic(format!("map {map_id} is not configured")))?;
        let navigation = store.navigation_worlds.contains_key(&map_id);
        let handles = store.take_map_handles(map_id);
        let mut records = store
            .pending_movement_records
            .remove(&map_id)
            .unwrap_or_else(|| take_scratch(&mut store.scratch_movement_records));
        records.clear();
        let previous_capacity = records.capacity();
        let mut changed_positions = take_scratch(&mut store.scratch_changed_positions);
        let previous_positions_capacity = changed_positions.capacity();
        let mut navigation_records = store
            .pending_navigation_records
            .remove(&map_id)
            .unwrap_or_else(|| take_scratch(&mut store.scratch_navigation_records));
        navigation_records.clear();
        let previous_navigation_capacity = navigation_records.capacity();
        let outcome = (|| {
            if navigation {
                update_navigation_map(
                    &mut store,
                    &handles,
                    fixed_update_ms as f32,
                    &mut navigation_records,
                    &mut changed_positions,
                )?;
            } else {
                update_map(
                    &mut store,
                    &handles,
                    server_tick,
                    fixed_update_ms as f32,
                    bounds,
                    &mut records,
                    &mut changed_positions,
                )?;
            }
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
            Ok(if navigation {
                navigation_records.len() as u32
            } else {
                records.len() as u32
            })
        })();
        store.metrics.scratch_growths += u64::from(records.capacity() > previous_capacity);
        store.metrics.scratch_growths +=
            u64::from(changed_positions.capacity() > previous_positions_capacity);
        store.metrics.scratch_growths +=
            u64::from(navigation_records.capacity() > previous_navigation_capacity);
        store.scratch_handles = handles;
        store.scratch_changed_positions = changed_positions;
        store.pending_movement_records.insert(map_id, records);
        store
            .pending_navigation_records
            .insert(map_id, navigation_records);
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
            let NativeEntityStore {
                aoi_worlds,
                route_frame_scratch,
                ..
            } = &mut *store;
            let world = aoi_worlds.get(&map_id).ok_or_else(|| {
                JsErrorBox::generic(format!("AOI world is not configured: {map_id}"))
            })?;
            encode_tiered_aoi_route_frames(
                world,
                &records,
                server_tick,
                client_message_code,
                route_message_code,
                route_frame_scratch,
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

#[op2]
/// 按AOI分档编码NavMesh3D权威位置，并在Rust内完成Observer到Gate的路由聚合。 / Encodes authoritative NavMesh positions with AOI tiers and groups observers by Gate in Rust.
pub(crate) fn op_native_map_take_navigation_aoi_route_frames(
    map_id: u32,
    server_tick: u32,
    client_message_code: u32,
    route_message_code: u32,
) -> Result<Uint8Array, JsErrorBox> {
    let client_message_code = u16::try_from(client_message_code)
        .map_err(|_| JsErrorBox::generic("client navigation message code exceeds uint16"))?;
    let route_message_code = u16::try_from(route_message_code)
        .map_err(|_| JsErrorBox::generic("Gate route message code exceeds uint16"))?;
    STORE.with(|slot| {
        let mut store = slot.borrow_mut();
        let records = store
            .pending_navigation_records
            .remove(&map_id)
            .unwrap_or_default();
        let result = {
            let NativeEntityStore {
                aoi_worlds,
                route_frame_scratch,
                ..
            } = &mut *store;
            let world = aoi_worlds.get(&map_id).ok_or_else(|| {
                JsErrorBox::generic(format!("AOI world is not configured: {map_id}"))
            })?;
            encode_tiered_navigation_aoi_route_frames(
                world,
                &records,
                server_tick,
                client_message_code,
                route_message_code,
                route_frame_scratch,
            )?
        };
        record_aoi_encoding_metrics(&mut store.metrics, &result);
        let mut scratch = records;
        scratch.clear();
        if scratch.capacity() > store.scratch_navigation_records.capacity() {
            store.scratch_navigation_records = scratch;
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

fn update_navigation_map(
    store: &mut NativeEntityStore,
    handles: &[u32],
    fixed_update_ms: f32,
    records: &mut Vec<NavigationMovementRecord>,
    changed_positions: &mut Vec<(u32, f32, f32)>,
) -> Result<(), JsErrorBox> {
    for &handle in handles {
        if let Some(mut input) = store.navigation_directional_inputs.remove(&handle) {
            update_navigation_directional_input(
                store,
                handle,
                fixed_update_ms,
                &mut input,
                records,
                changed_positions,
            )?;
            if input.forward != 0 || input.strafe != 0 {
                input.state_changed = false;
                store.navigation_directional_inputs.insert(handle, input);
            }
            continue;
        }
        let Some(mut movement) = store.navigation_movements.remove(&handle) else {
            continue;
        };
        let (map_id, current) = {
            let (unit, cold) = store.get_unit_parts(handle)?;
            (cold.map_id, [unit.x, unit.y, unit.z])
        };
        let world = store.navigation_worlds.get(&map_id).ok_or_else(|| {
            JsErrorBox::generic(format!("NavMesh world is not configured: {map_id}"))
        })?;
        if movement.obstacle_revision != world.obstacle_revision() {
            let target = movement.points.last().copied().unwrap_or(current);
            movement.points = world
                .find_path(current, target, [2.0, 4.0, 2.0], 64)
                .unwrap_or_default();
            movement.next_point = usize::from(movement.points.len() > 1);
            movement.obstacle_revision = world.obstacle_revision();
            movement.state_changed = true;
        }
        let mut keep_movement = false;
        {
            let unit = store.get_unit_hot_mut(handle)?;
            let previous = [unit.x, unit.y, unit.z];
            let speed = unit.speed_cells_per_second.max(0.0);
            let mut remaining_seconds = fixed_update_ms / 1_000.0;
            while speed > 0.0
                && remaining_seconds > 0.0
                && movement.next_point < movement.points.len()
            {
                let target = movement.points[movement.next_point];
                let delta = [target[0] - unit.x, target[1] - unit.y, target[2] - unit.z];
                let distance =
                    (delta[0] * delta[0] + delta[1] * delta[1] + delta[2] * delta[2]).sqrt();
                if distance <= 0.0001 {
                    unit.x = target[0];
                    unit.y = target[1];
                    unit.z = target[2];
                    movement.next_point += 1;
                    continue;
                }
                let target_yaw = delta[0].atan2(delta[2]);
                let yaw_delta = normalize_radians(target_yaw - unit.yaw);
                let turn_seconds = yaw_delta.abs() / NAVIGATION_PATH_TURN_SPEED_RADIANS;
                if turn_seconds >= remaining_seconds {
                    unit.yaw = normalize_radians(
                        unit.yaw
                            + yaw_delta.signum()
                                * NAVIGATION_PATH_TURN_SPEED_RADIANS
                                * remaining_seconds,
                    );
                    break;
                }
                unit.yaw = target_yaw;
                remaining_seconds -= turn_seconds;
                let step = (speed * remaining_seconds).min(distance);
                let scale = step / distance;
                unit.x += delta[0] * scale;
                unit.y += delta[1] * scale;
                unit.z += delta[2] * scale;
                remaining_seconds -= step / speed;
                if step >= distance - 0.0001 {
                    movement.next_point += 1;
                }
            }
            if movement.next_point >= movement.points.len() {
                unit.moving = 0;
                movement.state_changed = true;
            } else {
                unit.moving = 1;
                keep_movement = true;
            }
            if unit.x != previous[0] || unit.y != previous[1] || unit.z != previous[2] {
                changed_positions.push((unit.id, unit.x, unit.z));
            }
            if unit.moving != 0 || movement.state_changed {
                records.push(NavigationMovementRecord {
                    unit_id: unit.id,
                    sequence: unit.sequence,
                    x: unit.x,
                    y: unit.y,
                    z: unit.z,
                    yaw: unit.yaw,
                    moving: unit.moving != 0,
                    state_changed: movement.state_changed,
                });
            }
        }
        movement.state_changed = false;
        if keep_movement {
            store.navigation_movements.insert(handle, movement);
        }
    }
    Ok(())
}

fn update_navigation_directional_input(
    store: &mut NativeEntityStore,
    handle: u32,
    fixed_update_ms: f32,
    input: &mut NavigationDirectionalInput,
    records: &mut Vec<NavigationMovementRecord>,
    changed_positions: &mut Vec<(u32, f32, f32)>,
) -> Result<(), JsErrorBox> {
    let (unit_id, sequence, map_id, current, speed) = {
        let (unit, cold) = store.get_unit_parts(handle)?;
        (
            unit.id,
            unit.sequence,
            cold.map_id,
            [unit.x, unit.y, unit.z],
            unit.speed_cells_per_second.max(0.0),
        )
    };
    let mut active = input.forward != 0 || input.strafe != 0;
    if active {
        input.lease_remaining_ms -= fixed_update_ms;
        if input.lease_remaining_ms <= 0.0 {
            input.forward = 0;
            input.strafe = 0;
            input.state_changed = true;
            active = false;
        }
    }
    let mut position = current;
    if active {
        let forward_x = input.yaw.sin();
        let forward_z = input.yaw.cos();
        // Yaw 0 faces +Z; positive strafe is the Unity/world-space right (+X).
        // Yaw 为 0 时朝向 +Z；正 strafe 必须是世界右侧（+X）。
        let right_x = input.yaw.cos();
        let right_z = -input.yaw.sin();
        let mut direction_x =
            forward_x * f32::from(input.forward) + right_x * f32::from(input.strafe);
        let mut direction_z =
            forward_z * f32::from(input.forward) + right_z * f32::from(input.strafe);
        let length = (direction_x * direction_x + direction_z * direction_z).sqrt();
        direction_x /= length;
        direction_z /= length;
        let step = speed * fixed_update_ms / 1_000.0;
        let desired = [
            current[0] + direction_x * step,
            current[1],
            current[2] + direction_z * step,
        ];
        if let Some(moved) = store.navigation_worlds.get(&map_id).and_then(|world| {
            world.move_along_surface(current, desired, [2.0, 4.0, 2.0], input.polygon_ref)
        }) {
            position = moved.position;
            input.polygon_ref = moved.polygon_ref;
        } else {
            input.polygon_ref = 0;
        }
    }
    {
        let unit = store.get_unit_hot_mut(handle)?;
        unit.x = position[0];
        unit.y = position[1];
        unit.z = position[2];
        unit.yaw = input.yaw;
        unit.moving = u32::from(active);
    }
    if position != current {
        changed_positions.push((unit_id, position[0], position[2]));
    }
    if active || input.state_changed {
        records.push(NavigationMovementRecord {
            unit_id,
            sequence,
            x: position[0],
            y: position[1],
            z: position[2],
            yaw: input.yaw,
            moving: active,
            state_changed: input.state_changed,
        });
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
    scratch: &mut AoiRouteFrameScratch,
) -> Result<Vec<u8>, JsErrorBox> {
    scratch.subject_ids.clear();
    scratch
        .subject_ids
        .extend(records.iter().map(|record| read_record_u32(record, 0)));
    scratch.force.clear();
    scratch
        .force
        .extend(records.iter().map(|record| record[16] != 0));
    let delivery_groups =
        world.tiered_delivery_groups(&scratch.subject_ids, &scratch.force, server_tick);
    encode_aoi_route_frames_from_groups(
        world,
        delivery_groups,
        route_message_code,
        scratch,
        |indices, frame| {
            encode_entity_move_frame_indices_into(
                frame,
                client_message_code,
                server_tick,
                records,
                indices,
            );
        },
    )
}

fn encode_tiered_navigation_aoi_route_frames(
    world: &AoiWorld,
    records: &[NavigationMovementRecord],
    server_tick: u32,
    client_message_code: u16,
    route_message_code: u16,
    scratch: &mut AoiRouteFrameScratch,
) -> Result<Vec<u8>, JsErrorBox> {
    scratch.subject_ids.clear();
    scratch
        .subject_ids
        .extend(records.iter().map(|record| record.unit_id));
    scratch.force.clear();
    scratch
        .force
        .extend(records.iter().map(|record| record.state_changed));
    let delivery_groups =
        world.tiered_delivery_groups(&scratch.subject_ids, &scratch.force, server_tick);
    encode_aoi_route_frames_from_groups(
        world,
        delivery_groups,
        route_message_code,
        scratch,
        |indices, frame| {
            encode_entity_navigate_frame_indices_into(
                frame,
                client_message_code,
                server_tick,
                records,
                indices,
            );
        },
    )
}

/// 把按最终受众聚合的客户端帧进一步按Gate路由编码；调用方只提供客户端payload编码器。
/// Encodes final-audience client frames into per-Gate route frames; callers only provide client payload encoding.
fn encode_aoi_route_frames_from_groups<F>(
    world: &AoiWorld,
    delivery_groups: Vec<(Vec<u32>, Vec<usize>)>,
    route_message_code: u16,
    scratch: &mut AoiRouteFrameScratch,
    mut encode_frame: F,
) -> Result<Vec<u8>, JsErrorBox>
where
    F: FnMut(&[usize], &mut Vec<u8>),
{
    let total_items = delivery_groups
        .iter()
        .map(|(_, indices)| indices.len() as u32)
        .sum::<u32>();
    let route_capacity = usize::try_from(world.max_delivery_route_id())
        .map_err(|_| JsErrorBox::generic("AOI delivery route id exceeds usize"))?
        .checked_add(1)
        .ok_or_else(|| JsErrorBox::generic("AOI delivery route capacity overflow"))?;
    prepare_route_frame_scratch(scratch, route_capacity);

    for (recipients, indices) in delivery_groups {
        scratch.client_frame.clear();
        encode_frame(&indices, &mut scratch.client_frame);
        for route_id in scratch.touched_routes.iter().copied() {
            scratch.recipients_by_route[route_id].clear();
        }
        scratch.touched_routes.clear();
        for recipient_id in recipients {
            let route_id = world.delivery_route_id(recipient_id).ok_or_else(|| {
                JsErrorBox::generic(format!(
                    "AOI observer {recipient_id} has no native delivery route"
                ))
            })?;
            let route_index = route_id as usize;
            if scratch.recipients_by_route[route_index].is_empty() {
                scratch.touched_routes.push(route_index);
            }
            scratch.recipients_by_route[route_index].push(recipient_id);
        }
        for route_id in scratch.touched_routes.iter().copied() {
            let route_recipients = &scratch.recipients_by_route[route_id];
            encode_client_broadcast_batch_item(
                &mut scratch.payloads_by_route[route_id],
                route_recipients,
                &scratch.client_frame,
            );
        }
    }

    for route_id in scratch.touched_routes.iter().copied() {
        scratch.recipients_by_route[route_id].clear();
    }
    scratch.touched_routes.clear();

    let route_count = scratch
        .payloads_by_route
        .iter()
        .skip(1)
        .filter(|payload| !payload.is_empty())
        .count();
    let mut bytes = Vec::with_capacity(
        8 + scratch
            .payloads_by_route
            .iter()
            .map(|payload| 10 + payload.len())
            .sum::<usize>(),
    );
    bytes.extend_from_slice(&total_items.to_le_bytes());
    bytes.extend_from_slice(&(route_count as u32).to_le_bytes());
    for (route_id, payload) in scratch.payloads_by_route.iter().enumerate().skip(1) {
        if payload.is_empty() {
            continue;
        }
        bytes.extend_from_slice(&(route_id as u32).to_le_bytes());
        bytes.extend_from_slice(&((payload.len() + 2) as u32).to_le_bytes());
        bytes.extend_from_slice(&route_message_code.to_be_bytes());
        bytes.extend_from_slice(payload);
    }
    Ok(bytes)
}

/// 准备并复用路由编码容器；只有路由数量增长时才扩容，调用间保留容量。
/// Prepares reusable route containers; capacity grows only when route count increases and is retained between calls.
fn prepare_route_frame_scratch(scratch: &mut AoiRouteFrameScratch, route_capacity: usize) {
    if scratch.payloads_by_route.len() < route_capacity {
        scratch
            .payloads_by_route
            .resize_with(route_capacity, Vec::new);
    }
    if scratch.recipients_by_route.len() < route_capacity {
        scratch
            .recipients_by_route
            .resize_with(route_capacity, Vec::new);
    }
    for payload in &mut scratch.payloads_by_route {
        payload.clear();
    }
    for recipients in &mut scratch.recipients_by_route {
        recipients.clear();
    }
    scratch.touched_routes.clear();
    scratch.client_frame.clear();
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

/// Numeric按类型统计逻辑投递量；只累计真正进入某个最终受众组的记录。
/// Tracks logical Numeric delivery per type and counts only records that entered a final audience group.
fn record_numeric_replication_metrics(
    metrics: &mut NativeDataMetrics,
    records: &[(u32, u32, i64)],
    delivery_groups: &[(Vec<u32>, Vec<usize>)],
) {
    for (recipients, indices) in delivery_groups {
        let recipient_count = recipients.len() as u64;
        for &index in indices {
            let (unit_id, numeric_type, value) = records[index];
            let item_payload_bytes = uint32_field_len(1, unit_id)
                + uint32_field_len(2, numeric_type)
                + int64_field_len(3, value);
            let item_wire_bytes = varint_len((2 << 3) | 2)
                + varint_len(item_payload_bytes as u32)
                + item_payload_bytes;
            let type_metrics = metrics.numeric_replication.entry(numeric_type).or_default();
            type_metrics.encoded_records += 1;
            type_metrics.recipient_deliveries += recipient_count;
            type_metrics.logical_bytes += (item_wire_bytes as u64).saturating_mul(recipient_count);
        }
    }
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
        let navigation_assets = store.navigation_assets.live_assets() as u32;
        let navigation_worlds = store.navigation_worlds.len() as u32;
        let metrics = store.metrics.clone();
        let mut numeric_replication: Vec<_> = metrics.numeric_replication.iter().collect();
        numeric_replication.sort_unstable_by_key(|(numeric_type, _)| **numeric_type);
        let mut bytes = Vec::with_capacity(164 + numeric_replication.len() * 36);
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
        bytes.extend_from_slice(&navigation_assets.to_le_bytes());
        bytes.extend_from_slice(&navigation_worlds.to_le_bytes());
        bytes.extend_from_slice(&(numeric_replication.len() as u32).to_le_bytes());
        for (&numeric_type, type_metrics) in numeric_replication {
            bytes.extend_from_slice(&numeric_type.to_le_bytes());
            bytes.extend_from_slice(&type_metrics.changes.to_le_bytes());
            bytes.extend_from_slice(&type_metrics.encoded_records.to_le_bytes());
            bytes.extend_from_slice(&type_metrics.recipient_deliveries.to_le_bytes());
            bytes.extend_from_slice(&type_metrics.logical_bytes.to_le_bytes());
        }
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

fn encode_entity_navigate_frame_indices_into(
    frame: &mut Vec<u8>,
    message_code: u16,
    server_tick: u32,
    records: &[NavigationMovementRecord],
    indices: &[usize],
) {
    frame.extend_from_slice(&message_code.to_be_bytes());
    write_uint32_field(frame, 1, server_tick);
    let mut item = Vec::with_capacity(40);
    for &index in indices {
        let record = records[index];
        item.clear();
        write_uint32_field(&mut item, 1, record.unit_id);
        write_uint32_field(&mut item, 2, record.sequence);
        write_float_field(&mut item, 3, record.x);
        write_float_field(&mut item, 4, record.y);
        write_float_field(&mut item, 5, record.z);
        write_float_field(&mut item, 6, record.yaw);
        write_bool_field(&mut item, 7, record.moving);
        write_tag(frame, 2, 2);
        write_varint(frame, item.len() as u32);
        frame.extend_from_slice(&item);
    }
}

fn encode_entity_numeric_frame_into(
    frame: &mut Vec<u8>,
    message_code: u16,
    server_tick: u32,
    records: &[(u32, u32, i64)],
) {
    frame.extend_from_slice(&message_code.to_be_bytes());
    write_uint32_field(frame, 1, server_tick);
    for &(unit_id, numeric_type, value) in records {
        let item_len = uint32_field_len(1, unit_id)
            + uint32_field_len(2, numeric_type)
            + int64_field_len(3, value);
        write_tag(frame, 2, 2);
        write_varint(frame, item_len as u32);
        write_uint32_field(frame, 1, unit_id);
        write_uint32_field(frame, 2, numeric_type);
        write_int64_field(frame, 3, value);
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

fn int64_field_len(field_number: u32, value: i64) -> usize {
    if value == 0 {
        return 0;
    }
    varint_len(field_number << 3) + varint64_len(value as u64)
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

fn varint64_len(mut value: u64) -> usize {
    let mut len = 1;
    while value >= 0x80 {
        value >>= 7;
        len += 1;
    }
    len
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

fn write_int64_field(bytes: &mut Vec<u8>, field_number: u32, value: i64) {
    if value == 0 {
        return;
    }
    write_tag(bytes, field_number, 0);
    write_varint64(bytes, value as u64);
}

fn write_varint64(bytes: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        bytes.push((value as u8) | 0x80);
        value >>= 7;
    }
    bytes.push(value as u8);
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
                    bounds.cell_size_meters,
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

/// 按世界米制速度计算Grid2D跨一个Cell的Tick数；Cell边长变化不会改变角色的米/秒速度。
/// Calculates Grid2D ticks from world-meter speed so changing Cell size does not change meters per second.
fn step_duration_ticks(
    input_x: i8,
    input_z: i8,
    speed_meters_per_second: f32,
    cell_size_meters: f32,
    fixed_update_ms: f32,
) -> u32 {
    let distance_cells = if input_x != 0 && input_z != 0 {
        std::f32::consts::SQRT_2
    } else {
        1.0
    };
    let distance_meters = distance_cells * cell_size_meters;
    (1_000.0 * distance_meters / speed_meters_per_second / fixed_update_ms)
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
        assert_eq!(first.len(), 164);
        assert_eq!(second.len(), 164);

        STORE.with(|slot| {
            let store = slot.borrow();
            assert_eq!(store.metrics.scalar_gets, 7);
            assert_eq!(store.metrics.encoded_bytes, 128);
        });
    }

    #[test]
    fn nav_mesh_world_loads_from_trusted_root_and_queries_in_one_call() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        configure_project_root(root).unwrap();
        STORE.with(|slot| *slot.borrow_mut() = NativeEntityStore::default());
        let asset = b"navigation/maps/demo_3d/generated/navigation.bin";
        let hash = b"1844ce35706c008f494bc74b6a6c55105e5da3d3fc104634e9c8726daab67421";
        native_spatial_create_nav_mesh_3d(90_001, 48, 48, 1_000, asset, hash).unwrap();
        native_spatial_create_nav_mesh_3d(90_002, 48, 48, 1_000, asset, hash).unwrap();

        let projected =
            native_spatial_project_position(90_001, 0.0, 1.0, -10.0, 2.0, 4.0, 2.0).unwrap();
        assert_eq!(u32::from_le_bytes(projected[0..4].try_into().unwrap()), 1);
        let path =
            native_spatial_find_path(90_001, -10.0, 0.0, 0.0, 10.0, 0.0, 0.0, 2.0, 4.0, 2.0, 32)
                .unwrap();
        assert!(u32::from_le_bytes(path[0..4].try_into().unwrap()) >= 3);
        STORE.with(|slot| {
            let store = slot.borrow();
            assert_eq!(store.navigation_assets.live_assets(), 1);
            assert_eq!(store.navigation_worlds.len(), 2);
        });

        native_spatial_release(90_001);
        native_spatial_release(90_002);
        STORE.with(|slot| {
            let store = slot.borrow();
            assert_eq!(store.navigation_assets.live_assets(), 0);
            assert!(store.navigation_worlds.is_empty());
        });
    }

    #[test]
    fn nav_mesh_obstacle_ops_are_bounded_and_released_with_the_map() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        configure_project_root(root).unwrap();
        STORE.with(|slot| *slot.borrow_mut() = NativeEntityStore::default());
        native_spatial_create_nav_mesh_3d(
            90_004,
            60,
            60,
            1_000,
            b"navigation/maps/demo_3d/generated/navigation.bin",
            b"1844ce35706c008f494bc74b6a6c55105e5da3d3fc104634e9c8726daab67421",
        )
        .unwrap();
        let mut value = unit(88);
        value.map_id = 90_004;
        value.x = -12.0;
        value.y = 0.2;
        value.z = -12.0;
        value.speed_cells_per_second = 4.0;
        let handle = STORE.with(|slot| {
            slot.borrow_mut()
                .create(NativeEntityData::Unit(value))
                .unwrap()
        });
        set_unit_navigation_target(90_004, handle, -12.0, 0.0, 12.0, 1).unwrap();
        assert!(
            native_spatial_upsert_box_obstacle(90_004, 7, -12.0, 1.5, 0.0, 4.0, 1.5, 1.0, 0.0,)
                .unwrap()
        );
        assert!(
            !native_spatial_upsert_box_obstacle(90_004, 7, -12.0, 1.5, 0.0, 4.0, 1.5, 1.0, 0.0,)
                .unwrap()
        );
        for _ in 0..64 {
            let bytes = native_spatial_update_obstacles(90_004, 8, 4).unwrap();
            if bytes[16] != 0 {
                break;
            }
        }
        STORE.with(|slot| {
            assert_eq!(slot.borrow().navigation_worlds[&90_004].obstacle_count(), 1);
        });
        native_map_advance_movement(90_004, 1, 50).unwrap();
        STORE.with(|slot| {
            let store = slot.borrow();
            let movement = &store.navigation_movements[&handle];
            assert!(
                movement
                    .points
                    .iter()
                    .any(|point| (point[0] + 12.0).abs() > 4.0),
                "an active route must replan after the obstacle revision"
            );
        });
        native_spatial_release(90_004);
        STORE.with(|slot| assert!(!slot.borrow().navigation_worlds.contains_key(&90_004)));
    }

    #[test]
    fn nav_mesh_target_stays_in_rust_and_advances_authoritative_position() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        configure_project_root(root).unwrap();
        STORE.with(|slot| *slot.borrow_mut() = NativeEntityStore::default());
        native_spatial_create_nav_mesh_3d(
            1,
            48,
            48,
            1_000,
            b"navigation/maps/demo_3d/generated/navigation.bin",
            b"1844ce35706c008f494bc74b6a6c55105e5da3d3fc104634e9c8726daab67421",
        )
        .unwrap();
        let mut value = unit(77);
        value.x = -12.0;
        value.y = 0.2;
        value.z = -12.0;
        value.speed_cells_per_second = 4.0;
        let handle = STORE.with(|slot| {
            slot.borrow_mut()
                .create(NativeEntityData::Unit(value))
                .unwrap()
        });

        let accepted = set_unit_navigation_target(1, handle, 12.0, 0.0, 12.0, 1).unwrap();
        assert_eq!(u32::from_le_bytes(accepted[0..4].try_into().unwrap()), 1);
        assert!(u32::from_le_bytes(accepted[4..8].try_into().unwrap()) >= 3);
        assert_eq!(native_map_advance_movement(1, 1, 50).unwrap(), 1);
        STORE.with(|slot| {
            let store = slot.borrow();
            let unit = store.get_unit_hot(handle).unwrap();
            assert_eq!(unit.x, -12.0);
            assert_eq!(unit.z, -12.0);
            assert_ne!(unit.yaw, 0.0);
            assert_eq!(unit.moving, 1);
            assert!(store.navigation_movements.contains_key(&handle));
            assert_eq!(store.pending_navigation_records[&1].len(), 1);
        });
        assert_eq!(native_map_advance_movement(1, 2, 200).unwrap(), 1);
        STORE.with(|slot| {
            let store = slot.borrow();
            let unit = store.get_unit_hot(handle).unwrap();
            assert!(unit.x > -12.0 || unit.z > -12.0);
            assert_eq!(unit.moving, 1);
        });

        let stale = set_unit_navigation_target(1, handle, -10.0, 0.0, -10.0, 1).unwrap();
        assert_eq!(u32::from_le_bytes(stale[0..4].try_into().unwrap()), 1);
        assert_eq!(stale.len(), 4);

        let yaw = std::f64::consts::FRAC_PI_2;
        let before_direction = STORE.with(|slot| slot.borrow().get_unit_hot(handle).unwrap().x);
        let directional = set_unit_navigation_input(1, handle, 1, 0, yaw, 2).unwrap();
        assert_eq!(u32::from_le_bytes(directional[0..4].try_into().unwrap()), 2);
        assert_eq!(directional.len(), 4);
        assert_eq!(native_map_advance_movement(1, 3, 50).unwrap(), 1);
        STORE.with(|slot| {
            let store = slot.borrow();
            let unit = store.get_unit_hot(handle).unwrap();
            assert!((unit.yaw - std::f32::consts::FRAC_PI_2).abs() < 0.0001);
            assert_eq!(unit.moving, 1);
            assert!(unit.x > before_direction);
            assert!(store.navigation_directional_inputs.contains_key(&handle));
        });

        let stopped = set_unit_navigation_input(1, handle, 0, 0, yaw, 3).unwrap();
        assert_eq!(u32::from_le_bytes(stopped[0..4].try_into().unwrap()), 3);
        assert_eq!(native_map_advance_movement(1, 4, 50).unwrap(), 1);
        STORE.with(|slot| {
            let store = slot.borrow();
            let unit = store.get_unit_hot(handle).unwrap();
            assert_eq!(unit.moving, 0);
            assert!(!store.navigation_movements.contains_key(&handle));
            assert!(!store.navigation_directional_inputs.contains_key(&handle));
            let record = store.pending_navigation_records[&1].last().unwrap();
            assert_eq!(record.sequence, 3);
            assert!(!record.moving);
            assert!(record.state_changed);
        });

        set_unit_navigation_input(1, handle, 1, 0, yaw, 4).unwrap();
        for tick in 5..35 {
            native_map_advance_movement(1, tick, 50).unwrap();
        }
        STORE.with(|slot| {
            let store = slot.borrow();
            assert_eq!(store.get_unit_hot(handle).unwrap().moving, 0);
            assert!(!store.navigation_directional_inputs.contains_key(&handle));
            let record = store.pending_navigation_records[&1].last().unwrap();
            assert_eq!(record.sequence, 4);
            assert!(!record.moving);
            assert!(record.state_changed);
        });
    }

    #[test]
    fn nav_mesh_asset_cannot_escape_navigation_directory() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        configure_project_root(root).unwrap();
        let error = native_spatial_create_nav_mesh_3d(
            90_003,
            48,
            48,
            1_000,
            b"navigation/../Cargo.toml",
            b"0000000000000000000000000000000000000000000000000000000000000000",
        )
        .unwrap_err();
        assert!(error.to_string().contains("normalized relative path"));
    }

    #[test]
    fn movement_scratch_grows_once_then_reuses_capacity() {
        let handle = STORE.with(|slot| {
            let mut store = slot.borrow_mut();
            *store = NativeEntityStore::default();
            store.create(NativeEntityData::Unit(unit(10))).unwrap()
        });
        set_unit_movement_input(handle, 1, 0, 1).unwrap();
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
            100,
            100,
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
            100,
            100,
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
        let mut scratch = AoiRouteFrameScratch::default();
        let bytes =
            encode_tiered_aoi_route_frames(&world, &records, 1, 10_016, 20_010, &mut scratch)
                .unwrap();
        let repeated_bytes =
            encode_tiered_aoi_route_frames(&world, &records, 1, 10_016, 20_010, &mut scratch)
                .unwrap();
        assert_eq!(bytes, repeated_bytes);

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
                100,
                100,
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
        attach_numeric(handle).unwrap();
        assert!(set_numeric_values(handle, &[(1, 100)]).unwrap());
        assert!(!set_numeric_values(handle, &[(1, 100)]).unwrap());
        assert!(set_numeric_values(handle, &[(2, 1000)]).unwrap());
        assert_eq!(numeric_value(handle, 1).unwrap(), 100);

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
    fn numeric_replication_policy_isolated_ack_throttle_and_urgent_hp() {
        let handle = STORE.with(|slot| {
            let mut store = slot.borrow_mut();
            *store = NativeEntityStore::default();
            let handle = store.create(NativeEntityData::Unit(unit(10))).unwrap();
            let mut world = AoiWorld::new(
                10_000,
                0,
                0,
                100,
                100,
                1,
                1,
                vec![SyncTier {
                    radius_grids: 1,
                    interval_ticks: 1,
                }],
            )
            .unwrap();
            world.attach_routed(10, 0.0, 0.0, true, true, 7).unwrap();
            world.take_changes();
            store.aoi_worlds.insert(1, world);
            handle
        });
        attach_numeric(handle).unwrap();
        assert!(set_numeric_values(handle, &[(NUMERIC_CURRENT_HP, 100), (2, 200)]).unwrap());

        let aoi_types = NUMERIC_CURRENT_HP.to_le_bytes();
        let owner = native_map_peek_numeric_aoi_route_frames(
            1,
            1,
            10_017,
            20_010,
            &aoi_types,
            &aoi_types,
            NumericReplicationSelection::ExcludeListedTypes as u32,
            true,
        )
        .unwrap();
        let owner_revision_len = u32::from_le_bytes(owner[0..4].try_into().unwrap()) as usize;
        let owner_route_offset = 4 + owner_revision_len;
        assert_eq!(
            u32::from_le_bytes(
                owner[owner_route_offset..owner_route_offset + 4]
                    .try_into()
                    .unwrap()
            ),
            1
        );
        native_map_ack_numeric_delta(1, &owner[4..owner_route_offset]).unwrap();
        STORE.with(|slot| {
            let store = slot.borrow();
            let numeric = &store.numerics_by_unit[&handle];
            assert!(numeric.dirty.contains_key(&NUMERIC_CURRENT_HP));
            assert!(!numeric.dirty.contains_key(&2));
        });

        let initial_hp = native_map_peek_numeric_aoi_route_frames(
            1,
            2,
            10_017,
            20_010,
            &aoi_types,
            &aoi_types,
            NumericReplicationSelection::IncludeListedTypes as u32,
            false,
        )
        .unwrap();
        let initial_revision_len =
            u32::from_le_bytes(initial_hp[0..4].try_into().unwrap()) as usize;
        let initial_route_offset = 4 + initial_revision_len;
        assert_eq!(
            u32::from_le_bytes(
                initial_hp[initial_route_offset..initial_route_offset + 4]
                    .try_into()
                    .unwrap()
            ),
            1,
            "initial alive transition must publish immediately"
        );
        native_map_ack_numeric_delta(1, &initial_hp[4..initial_route_offset]).unwrap();

        assert!(set_numeric_values(handle, &[(NUMERIC_CURRENT_HP, 90)]).unwrap());
        let throttled = native_map_peek_numeric_aoi_route_frames(
            1,
            3,
            10_017,
            20_010,
            &aoi_types,
            &aoi_types,
            NumericReplicationSelection::IncludeListedTypes as u32,
            false,
        )
        .unwrap();
        let throttled_revision_len =
            u32::from_le_bytes(throttled[0..4].try_into().unwrap()) as usize;
        let throttled_route_offset = 4 + throttled_revision_len;
        assert_eq!(
            u32::from_le_bytes(
                throttled[throttled_route_offset..throttled_route_offset + 4]
                    .try_into()
                    .unwrap()
            ),
            0
        );
        STORE.with(|slot| {
            assert!(
                slot.borrow().numerics_by_unit[&handle]
                    .dirty
                    .contains_key(&NUMERIC_CURRENT_HP)
            );
        });

        let due = native_map_peek_numeric_aoi_route_frames(
            1,
            4,
            10_017,
            20_010,
            &aoi_types,
            &aoi_types,
            NumericReplicationSelection::IncludeListedTypes as u32,
            true,
        )
        .unwrap();
        let due_revision_len = u32::from_le_bytes(due[0..4].try_into().unwrap()) as usize;
        let due_route_offset = 4 + due_revision_len;
        assert_eq!(
            u32::from_le_bytes(
                due[due_route_offset..due_route_offset + 4]
                    .try_into()
                    .unwrap()
            ),
            1
        );
        native_map_ack_numeric_delta(1, &due[4..due_route_offset]).unwrap();

        assert!(set_numeric_values(handle, &[(NUMERIC_CURRENT_HP, 0)]).unwrap());
        let death = native_map_peek_numeric_aoi_route_frames(
            1,
            5,
            10_017,
            20_010,
            &aoi_types,
            &aoi_types,
            NumericReplicationSelection::IncludeListedTypes as u32,
            false,
        )
        .unwrap();
        let death_revision_len = u32::from_le_bytes(death[0..4].try_into().unwrap()) as usize;
        let death_route_offset = 4 + death_revision_len;
        assert_eq!(
            u32::from_le_bytes(
                death[death_route_offset..death_route_offset + 4]
                    .try_into()
                    .unwrap()
            ),
            1,
            "death must bypass the publish interval"
        );
    }

    #[test]
    fn numeric_dependencies_recompute_max_hp_in_rust() {
        let handle = STORE.with(|slot| {
            let mut store = slot.borrow_mut();
            *store = NativeEntityStore::default();
            store.create(NativeEntityData::Unit(unit(10))).unwrap()
        });
        attach_numeric(handle).unwrap();

        assert!(crate::game::set_numeric(handle, 10_001, 1_000).unwrap());
        assert_eq!(numeric_value(handle, 1_000).unwrap(), 1_000);
        assert!(crate::game::set_numeric(handle, 10_002, 100).unwrap());
        assert_eq!(numeric_value(handle, 1_000).unwrap(), 1_100);
        assert!(crate::game::set_numeric(handle, 10_003, 20).unwrap());
        assert_eq!(numeric_value(handle, 1_000).unwrap(), 1_320);

        let direct = crate::game::set_numeric(handle, 1_000, 9_999).unwrap_err();
        assert!(direct.to_string().contains("derived"));
        assert_eq!(numeric_value(handle, 1_000).unwrap(), 1_320);

        let encoded = native_map_peek_numeric_delta(1, 7, 10_017).unwrap();
        assert_eq!(u32::from_le_bytes(encoded[0..4].try_into().unwrap()), 4);

        assert!(crate::game::set_numeric(handle, 20_001, 5).unwrap());
        assert_eq!(numeric_value(handle, 2_000).unwrap(), 5);
        assert!(crate::game::set_numeric(handle, 20_002, 3).unwrap());
        assert_eq!(numeric_value(handle, 2_000).unwrap(), 8);
        assert!(crate::game::set_numeric(handle, 20_003, 20).unwrap());
        assert_eq!(numeric_value(handle, 2_000).unwrap(), 9);
        let direct_attack = crate::game::set_numeric(handle, 2_000, 99).unwrap_err();
        assert!(direct_attack.to_string().contains("derived"));
        assert_eq!(numeric_value(handle, 2_000).unwrap(), 9);
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
    fn grid_movement_uses_cell_size_with_meter_speed() {
        let bounds = Grid2DBounds::new(128, 128, 2_000).unwrap();
        let mut value = unit_hot(1);
        value.speed_cells_per_second = 2.0;
        value.input_x = 1;
        value.input_changed = 1;

        assert!(update_movement(&mut value, 10, 50.0, bounds));
        assert_eq!(value.move_end_tick, 30);
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
