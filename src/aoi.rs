//! 提供与导航实现无关的扁平 AOI Grid 和稠密关系位图。
//! Provides a navigation-agnostic flat AOI grid and dense relation bitsets.

use std::collections::BTreeMap;

use rustc_hash::FxHashMap;

const MAX_DENSE_ENTITIES: usize = 16_384;
const HOT_GRID_PROMOTE_MEMBERS: usize = 128;
const HOT_GRID_DEMOTE_MEMBERS: usize = 96;
const HOT_GRID_WORDS: usize = MAX_DENSE_ENTITIES.div_ceil(64);

/// 一条客户端可见关系的最终变化；Observer 可以看见或不再看见 Subject。
/// A final client-visible relation change between one observer and one subject.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct VisibilityChange {
    pub observer_id: u32,
    pub subject_id: u32,
    pub visible: bool,
}

/// 一档可覆盖状态的最大发送频率。半径使用 AOI Grid，间隔使用逻辑 Tick。
/// One replaceable-state sync tier, expressed as an AOI-grid radius and logical-tick interval.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct SyncTier {
    pub radius_grids: u32,
    pub interval_ticks: u32,
}

#[derive(Clone, Copy, Debug)]
struct PendingVisibilityChange {
    before: bool,
    after: bool,
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
struct GridCoord {
    x: i32,
    z: i32,
}

/// 对一个 Subject 的最终可见 Observer 集合做增量摘要。
///
/// 摘要只用于把“应当拥有相同受众”的 Subject 提前归组；最终接收者仍由
/// `delivery_audience`按真实AOI关系生成。三项独立信息共同参与分组，避免迟滞关系
/// 让每个Subject在每个Tick都重复扫描整个Detach范围。
///
/// Incremental summary of the final observer set for one subject. It is only a
/// grouping accelerator: `delivery_audience` still materializes the authoritative
/// recipients. Count plus two independent commutative accumulators make accidental
/// grouping collisions vanishingly unlikely without hashing the complete bit row.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
struct AudienceSignature {
    count: u32,
    xor: u64,
    sum: u64,
}

/// 以Scene内紧凑EntityIndex寻址的连续位图矩阵。增加实体时按512个槽位分段扩容；
/// 行列分别由调用方赋予Observer/Subject含义，避免每行一次独立堆分配。
/// A dense bit matrix addressed by compact scene-local entity indices.
#[derive(Default)]
struct DenseBitMatrix {
    words: Vec<u64>,
    row_capacity: usize,
    words_per_row: usize,
}

impl DenseBitMatrix {
    fn ensure_dimension(&mut self, dimension: usize) {
        if dimension <= self.row_capacity {
            return;
        }
        const ENTITY_BLOCK: usize = 512;
        let next_capacity = dimension.div_ceil(ENTITY_BLOCK) * ENTITY_BLOCK;
        let next_words_per_row = next_capacity.div_ceil(64);
        let mut next_words = vec![0; next_capacity * next_words_per_row];
        for row in 0..self.row_capacity {
            let source = row * self.words_per_row;
            let target = row * next_words_per_row;
            next_words[target..target + self.words_per_row]
                .copy_from_slice(&self.words[source..source + self.words_per_row]);
        }
        self.words = next_words;
        self.row_capacity = next_capacity;
        self.words_per_row = next_words_per_row;
    }

    fn contains(&self, row: usize, column: usize) -> bool {
        if row >= self.row_capacity || column >= self.row_capacity {
            return false;
        }
        let word = row * self.words_per_row + column / 64;
        self.words[word] & (1_u64 << (column % 64)) != 0
    }

    fn set(&mut self, row: usize, column: usize, value: bool) -> bool {
        let mask = 1_u64 << (column % 64);
        let word = &mut self.words[row * self.words_per_row + column / 64];
        let before = *word & mask != 0;
        if value {
            *word |= mask;
        } else {
            *word &= !mask;
        }
        before
    }

    /// 直接遍历一行中的置位索引，供热路径避免先构造临时集合。
    /// Visits set indices directly so hot paths do not materialize an intermediate collection.
    fn for_each_index(&self, row: usize, mut visit: impl FnMut(usize)) {
        if row >= self.row_capacity {
            return;
        }
        let start = row * self.words_per_row;
        let words = &self.words[start..start + self.words_per_row];
        for (word_index, &word) in words.iter().enumerate() {
            let mut remaining = word;
            while remaining != 0 {
                let bit = remaining.trailing_zeros() as usize;
                visit(word_index * 64 + bit);
                remaining &= remaining - 1;
            }
        }
    }

    fn clear_index(&mut self, index: usize) {
        if index >= self.row_capacity {
            return;
        }
        let row_start = index * self.words_per_row;
        self.words[row_start..row_start + self.words_per_row].fill(0);
        let mask = !(1_u64 << (index % 64));
        let word_index = index / 64;
        for row in 0..self.row_capacity {
            self.words[row * self.words_per_row + word_index] &= mask;
        }
    }
}

impl AudienceSignature {
    fn insert(&mut self, observer_id: u32) {
        let mixed = mix_observer_id(observer_id);
        self.count = self.count.saturating_add(1);
        self.xor ^= mixed;
        self.sum = self.sum.wrapping_add(mixed.rotate_left(29));
    }

    fn remove(&mut self, observer_id: u32) {
        let mixed = mix_observer_id(observer_id);
        self.count = self.count.saturating_sub(1);
        self.xor ^= mixed;
        self.sum = self.sum.wrapping_sub(mixed.rotate_left(29));
    }
}

#[derive(Clone, Copy, Debug)]
struct AoiEntry {
    unit_id: u32,
    grid: GridCoord,
    grid_index: usize,
    slot_in_grid: usize,
    observer: bool,
    subject: bool,
    delivery_route_id: u32,
}

/// 一张地图实例独占的 AOI 世界。
///
/// 有限地图使用扁平Grid和连续成员数组；空间候选与业务过滤后的最终可见关系分别
/// 保存为双向稠密位图。只有跨Grid移动、Attach/Detach或业务显式失效才更新关系。
///
/// Finite maps use flat grids with contiguous members. Bidirectional dense bitsets retain spatial
/// and final visibility relations, which change only on grid crossings, lifecycle events, or
/// explicit business invalidation.
pub(crate) struct AoiWorld {
    grid_size_meters: f32,
    origin_x_meters: f32,
    origin_z_meters: f32,
    enter_radius_grids: i32,
    detach_radius_grids: i32,
    grid_width: u32,
    grid_depth: u32,
    sync_tiers: Vec<SyncTier>,
    unit_indices: FxHashMap<u32, usize>,
    entries: Vec<Option<AoiEntry>>,
    entry_count: usize,
    free_entity_indices: Vec<usize>,
    grids: Vec<Vec<usize>>,
    hot_grid_bits: Vec<Option<Box<[u64; HOT_GRID_WORDS]>>>,
    occupied_grid_count: usize,
    spatial_subjects: DenseBitMatrix,
    spatial_observers: DenseBitMatrix,
    visible_subjects: DenseBitMatrix,
    visible_observers: DenseBitMatrix,
    lingering_subjects: DenseBitMatrix,
    spatial_relation_count: usize,
    visible_relation_count: usize,
    lingering_relation_count: usize,
    audience_signatures: Vec<AudienceSignature>,
    scratch_candidates: Vec<usize>,
    scratch_candidate_seen: Vec<bool>,
    scratch_hot_candidates: Box<[u64; HOT_GRID_WORDS]>,
    pending_changes: FxHashMap<(u32, u32), PendingVisibilityChange>,
}

impl AoiWorld {
    /// 创建米制 AOI Grid。Enter、Detach 与同步档位彼此独立，但同步只作用于已可见关系。
    /// Creates meter-based AOI grids. Visibility and sync tiers are independent, while sync always
    /// remains constrained to already-visible relations.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        grid_size_millimeters: u32,
        origin_x_millimeters: i64,
        origin_z_millimeters: i64,
        grid_width: u32,
        grid_depth: u32,
        enter_radius_grids: u32,
        detach_radius_grids: u32,
        sync_tiers: Vec<SyncTier>,
    ) -> Result<Self, &'static str> {
        if grid_size_millimeters == 0 {
            return Err("AOI grid size must be greater than zero");
        }
        if grid_width == 0 || grid_depth == 0 {
            return Err("AOI grid dimensions must be greater than zero");
        }
        let grid_count = usize::try_from(u64::from(grid_width) * u64::from(grid_depth))
            .map_err(|_| "AOI grid dimensions exceed platform capacity")?;
        if grid_count > 4_000_000 {
            return Err("AOI flat grid exceeds 4000000 cells");
        }
        if enter_radius_grids > detach_radius_grids {
            return Err("AOI enter radius must not exceed detach radius");
        }
        if detach_radius_grids > i32::MAX as u32 {
            return Err("AOI detach radius exceeds i32");
        }
        if sync_tiers.is_empty() {
            return Err("AOI needs at least one sync tier");
        }
        let mut previous_radius = None;
        let mut previous_interval = None;
        for tier in &sync_tiers {
            if tier.interval_ticks == 0 {
                return Err("AOI sync interval must be greater than zero");
            }
            if tier.radius_grids > detach_radius_grids {
                return Err("AOI sync tier exceeds the detach radius");
            }
            if previous_radius.is_some_and(|radius| tier.radius_grids <= radius) {
                return Err("AOI sync tier radii must be strictly increasing");
            }
            if previous_interval.is_some_and(|interval| tier.interval_ticks < interval) {
                return Err("AOI outer sync tiers must not run faster than inner tiers");
            }
            previous_radius = Some(tier.radius_grids);
            previous_interval = Some(tier.interval_ticks);
        }
        if previous_radius != Some(detach_radius_grids) {
            return Err("AOI outermost sync tier must cover the detach radius");
        }
        Ok(Self {
            grid_size_meters: grid_size_millimeters as f32 / 1_000.0,
            origin_x_meters: origin_x_millimeters as f32 / 1_000.0,
            origin_z_meters: origin_z_millimeters as f32 / 1_000.0,
            enter_radius_grids: enter_radius_grids as i32,
            detach_radius_grids: detach_radius_grids as i32,
            grid_width,
            grid_depth,
            sync_tiers,
            unit_indices: FxHashMap::default(),
            entries: Vec::new(),
            entry_count: 0,
            free_entity_indices: Vec::new(),
            grids: (0..grid_count).map(|_| Vec::new()).collect(),
            hot_grid_bits: (0..grid_count).map(|_| None).collect(),
            occupied_grid_count: 0,
            spatial_subjects: DenseBitMatrix::default(),
            spatial_observers: DenseBitMatrix::default(),
            visible_subjects: DenseBitMatrix::default(),
            visible_observers: DenseBitMatrix::default(),
            lingering_subjects: DenseBitMatrix::default(),
            spatial_relation_count: 0,
            visible_relation_count: 0,
            lingering_relation_count: 0,
            audience_signatures: Vec::new(),
            scratch_candidates: Vec::new(),
            scratch_candidate_seen: Vec::new(),
            scratch_hot_candidates: Box::new([0; HOT_GRID_WORDS]),
            pending_changes: FxHashMap::default(),
        })
    }

    /// 将实体加入空间索引。新关系只由 Enter 范围建立，Detach 范围不会提前暴露实体。
    /// Attaches an entity; new relations originate only inside Enter, never inside Detach alone.
    #[cfg(test)]
    pub(crate) fn attach(
        &mut self,
        unit_id: u32,
        x: f32,
        z: f32,
        observer: bool,
        subject: bool,
    ) -> Result<(), &'static str> {
        self.attach_routed(unit_id, x, z, observer, subject, 0)
    }

    /// 将实体连同宿主分配的稳定投递路由加入空间索引。
    /// Attaches an entity with the stable host-assigned delivery route used by native fan-out.
    pub(crate) fn attach_routed(
        &mut self,
        unit_id: u32,
        x: f32,
        z: f32,
        observer: bool,
        subject: bool,
        delivery_route_id: u32,
    ) -> Result<(), &'static str> {
        if unit_id == 0 {
            return Err("AOI unit id must be greater than zero");
        }
        if !x.is_finite() || !z.is_finite() {
            return Err("AOI position must be finite");
        }
        if self.unit_indices.contains_key(&unit_id) {
            return Err("AOI unit is already attached");
        }
        if self.entry_count >= MAX_DENSE_ENTITIES {
            return Err("AOI dense entity capacity exceeds 16384");
        }
        let grid = self.grid_of(x, z);
        let Some(grid_index) = self.grid_index(grid) else {
            return Err("AOI position is outside the configured map grid");
        };
        let entity_index = self.allocate_entity_index();
        let slot_in_grid = self.push_to_grid(grid_index, entity_index);
        self.entries[entity_index] = Some(AoiEntry {
            unit_id,
            grid,
            grid_index,
            slot_in_grid,
            observer,
            subject,
            delivery_route_id,
        });
        self.unit_indices.insert(unit_id, entity_index);
        self.entry_count += 1;
        if subject {
            let mut signature = AudienceSignature::default();
            if observer {
                signature.insert(unit_id);
            }
            self.audience_signatures[entity_index] = signature;
        }

        // Observer+Subject实体只扫描一次Enter邻域，并直接以EntityIndex建立双向关系。
        // Observer+subject entities scan the Enter neighborhood once and update by EntityIndex.
        let mut candidates = std::mem::take(&mut self.scratch_candidates);
        candidates.clear();
        self.collect_candidates(&mut candidates, &[(grid, self.enter_radius_grids)]);
        for other_index in candidates.iter().copied() {
            if other_index == entity_index {
                continue;
            }
            let Some(other) = self.entries[other_index] else {
                continue;
            };
            if observer && other.subject {
                self.set_spatial_relation_indices(entity_index, other_index, true);
            }
            if subject && other.observer {
                self.set_spatial_relation_indices(other_index, entity_index, true);
            }
        }
        for &index in &candidates {
            self.scratch_candidate_seen[index] = false;
        }
        self.scratch_candidates = candidates;
        Ok(())
    }

    /// 返回 Observer 的进程内投递路由；0 表示该 Observer 未配置原生快照路由。
    /// Returns an observer's process-local delivery route; zero means native fan-out is disabled.
    pub(crate) fn delivery_route_id(&self, observer_id: u32) -> Option<u32> {
        self.entry(observer_id)
            .filter(|entry| entry.observer && entry.delivery_route_id != 0)
            .map(|entry| entry.delivery_route_id)
    }

    /// 更新已挂载Observer的投递路由，不改变任何可见关系。 / Updates an attached observer's delivery route without changing visibility relations.
    pub(crate) fn set_delivery_route_id(
        &mut self,
        observer_id: u32,
        delivery_route_id: u32,
    ) -> Result<(), &'static str> {
        if delivery_route_id == 0 {
            return Err("AOI observer delivery route must be greater than zero");
        }
        let Some(entity_index) = self.entity_index(observer_id) else {
            return Err("AOI observer is not attached");
        };
        let Some(entry) = self.entries[entity_index].as_mut() else {
            return Err("AOI observer entry is missing");
        };
        if !entry.observer {
            return Err("AOI entity is not an observer");
        }
        entry.delivery_route_id = delivery_route_id;
        Ok(())
    }

    /// 返回当前地图使用的最大投递路由编号，供帧尾复用连续分桶。
    /// Returns the largest active route id so frame-end fan-out can reuse dense buckets.
    pub(crate) fn max_delivery_route_id(&self) -> u32 {
        self.entries
            .iter()
            .flatten()
            .map(|entry| entry.delivery_route_id)
            .max()
            .unwrap_or(0)
    }

    /// 从 AOI 移除实体并先生成所有最终 Leave。调用方随后才能销毁 Native Entity。
    /// Detaches an entity after producing final Leave changes, before Native Entity destruction.
    pub(crate) fn detach(&mut self, unit_id: u32) -> bool {
        let Some(entity_index) = self.entity_index(unit_id) else {
            return false;
        };
        let Some(entry) = self.entries[entity_index] else {
            return false;
        };
        let mut relations = std::mem::take(&mut self.scratch_candidates);
        relations.clear();
        if entry.observer {
            self.spatial_subjects
                .for_each_index(entity_index, |index| relations.push(index));
            while let Some(subject_index) = relations.pop() {
                self.set_spatial_relation_indices(entity_index, subject_index, false);
            }
        }
        if entry.subject {
            self.spatial_observers
                .for_each_index(entity_index, |index| relations.push(index));
            while let Some(observer_index) = relations.pop() {
                self.set_spatial_relation_indices(observer_index, entity_index, false);
            }
        }
        self.scratch_candidates = relations;
        self.audience_signatures[entity_index] = AudienceSignature::default();
        self.remove_from_grid(entity_index, entry.grid_index, entry.slot_in_grid);
        self.unit_indices.remove(&unit_id);
        self.entries[entity_index] = None;
        self.entry_count -= 1;
        self.release_entity_index(entity_index);
        true
    }

    /// 仅跨 AOI Grid 时重算关系；Enter 建立关系，Detach 删除已有关系，中间区域保持原状态。
    /// Reconciles only after crossing an AOI grid: Enter creates, Detach removes, and the band keeps
    /// the previous state.
    pub(crate) fn relocate(&mut self, unit_id: u32, x: f32, z: f32) -> Result<bool, &'static str> {
        if !x.is_finite() || !z.is_finite() {
            return Err("AOI position must be finite");
        }
        let next = self.grid_of(x, z);
        let next_grid_index = self
            .grid_index(next)
            .ok_or("AOI position is outside the configured map grid")?;
        let Some(entity_index) = self.entity_index(unit_id) else {
            return Err("AOI unit is not attached");
        };
        let Some(entry) = self.entries[entity_index] else {
            return Err("AOI unit is not attached");
        };
        if entry.grid == next {
            return Ok(false);
        }

        // 一次收集旧Detach范围与新Enter范围的并集，同时处理两个可见方向。
        // A moving observer+subject used to scan and materialize the same dense neighborhood four
        // times. One candidate pass preserves directional filters while avoiding duplicate work.
        let mut candidates = std::mem::take(&mut self.scratch_candidates);
        candidates.clear();
        self.collect_candidates(
            &mut candidates,
            &[
                (entry.grid, self.detach_radius_grids),
                (next, self.enter_radius_grids),
            ],
        );
        self.remove_from_grid(entity_index, entry.grid_index, entry.slot_in_grid);
        let slot_in_grid = self.push_to_grid(next_grid_index, entity_index);
        let moved = self.entries[entity_index].as_mut().unwrap();
        moved.grid = next;
        moved.grid_index = next_grid_index;
        moved.slot_in_grid = slot_in_grid;

        for other_index in candidates.iter().copied() {
            if other_index == entity_index {
                continue;
            }
            let Some(other) = self.entries[other_index] else {
                continue;
            };
            let after_distance = chebyshev(next, other.grid);
            if entry.observer && other.subject {
                let before_spatial = self.spatial_subjects.contains(entity_index, other_index);
                self.reconcile_pair_indices(
                    entity_index,
                    other_index,
                    before_spatial,
                    after_distance,
                );
            }
            if entry.subject && other.observer {
                let before_spatial = self.spatial_subjects.contains(other_index, entity_index);
                self.reconcile_pair_indices(
                    other_index,
                    entity_index,
                    before_spatial,
                    after_distance,
                );
            }
        }
        for &index in &candidates {
            self.scratch_candidate_seen[index] = false;
        }
        self.scratch_candidates = candidates;
        Ok(true)
    }

    /// 覆盖一条当前空间关系的业务可见结果；不能把尚未 Enter 的实体强制设为可见。
    /// Overrides business visibility for a current spatial relation without creating visibility.
    pub(crate) fn set_visible(&mut self, observer_id: u32, subject_id: u32, visible: bool) -> bool {
        let Some(observer_index) = self.entity_index(observer_id) else {
            return false;
        };
        let Some(subject_index) = self.entity_index(subject_id) else {
            return false;
        };
        let spatial = self
            .spatial_subjects
            .contains(observer_index, subject_index);
        let desired = visible && spatial;
        self.set_visible_relation_indices(observer_index, subject_index, desired)
    }

    /// 返回实体涉及的当前空间关系，供阵营、隐身、位面等业务状态失效后重新过滤。
    /// Returns current spatial relations for business-filter invalidation.
    pub(crate) fn candidate_pairs(
        &self,
        unit_id: u32,
        include_observer: bool,
        include_subject: bool,
    ) -> Vec<(u32, u32)> {
        let Some(entity_index) = self.entity_index(unit_id) else {
            return Vec::new();
        };
        let Some(entry) = self.entries[entity_index] else {
            return Vec::new();
        };
        let mut pairs = Vec::new();
        if include_observer && entry.observer {
            self.spatial_subjects
                .for_each_index(entity_index, |subject_index| {
                    if let Some(subject) = self.entries[subject_index].as_ref() {
                        pairs.push((unit_id, subject.unit_id));
                    }
                });
        }
        if include_subject && entry.subject {
            self.spatial_observers
                .for_each_index(entity_index, |observer_index| {
                    if let Some(observer) = self.entries[observer_index].as_ref() {
                        pairs.push((observer.unit_id, unit_id));
                    }
                });
        }
        pairs.sort_unstable();
        pairs.dedup();
        pairs
    }

    pub(crate) fn visible_subjects(&self, observer_id: u32) -> Vec<u32> {
        let Some(entity_index) = self.entity_index(observer_id) else {
            return Vec::new();
        };
        let entry = self.entries[entity_index].as_ref().unwrap();
        if !entry.observer {
            return Vec::new();
        }
        let mut ids = self.visible_subject_ids(entity_index);
        ids.sort_unstable();
        ids
    }

    pub(crate) fn observers_of(&self, subject_id: u32) -> Vec<u32> {
        let Some(entity_index) = self.entity_index(subject_id) else {
            return Vec::new();
        };
        let entry = self.entries[entity_index].as_ref().unwrap();
        if !entry.subject {
            return Vec::new();
        }
        let mut ids = self.visible_observer_ids(entity_index);
        ids.sort_unstable();
        ids
    }

    pub(crate) fn is_attached(&self, unit_id: u32) -> bool {
        self.unit_indices.contains_key(&unit_id)
    }
    pub(crate) fn entry_count(&self) -> usize {
        self.entry_count
    }
    pub(crate) fn grid_count(&self) -> usize {
        self.occupied_grid_count
    }

    pub(crate) fn lingering_relation_count(&self) -> usize {
        self.lingering_relation_count
    }

    pub(crate) fn rejected_relation_count(&self) -> usize {
        self.spatial_relation_count
            .saturating_sub(self.visible_relation_count)
    }

    /// 返回当前空间候选边数量；该计数随双向空间位图增量维护，不扫描Grid。
    /// Returns the incrementally maintained spatial relation count without scanning grids.
    pub(crate) fn candidate_relation_count(&self) -> usize {
        self.spatial_relation_count
    }

    pub(crate) fn visible_relation_count(&self) -> usize {
        self.visible_relation_count
    }

    /// 按最终可见受众聚合普通脏状态。该入口不节流，适合 Numeric 等由上层决定频率的数据源。
    /// Groups ordinary dirty state by final visible audiences without applying sync-tier throttling.
    pub(crate) fn delivery_groups(&self, subject_ids: &[u32]) -> Vec<(Vec<u32>, Vec<usize>)> {
        self.delivery_groups_impl(subject_ids, None, None, 0)
    }

    /// 按条目选择仅Owner或最终AOI受众；用于Numeric等同时包含公开与私有字段的状态源。
    /// Selects owner-only or final AOI delivery per item for state sources that mix public and
    /// private fields, such as Numeric replication.
    pub(crate) fn visibility_delivery_groups(
        &self,
        subject_ids: &[u32],
        owner_only: &[bool],
    ) -> Vec<(Vec<u32>, Vec<usize>)> {
        debug_assert_eq!(subject_ids.len(), owner_only.len());
        self.delivery_groups_impl(subject_ids, Some(owner_only), None, 0)
    }

    /// 对可覆盖移动状态应用独立同步档位；`force` 用于开始、停止、转向等不可延后的状态切换。
    /// Applies independent sync tiers to replaceable movement; force bypasses throttling for state changes.
    pub(crate) fn tiered_delivery_groups(
        &self,
        subject_ids: &[u32],
        force: &[bool],
        server_tick: u32,
    ) -> Vec<(Vec<u32>, Vec<usize>)> {
        debug_assert_eq!(subject_ids.len(), force.len());
        self.delivery_groups_impl(subject_ids, None, Some(force), server_tick)
    }

    pub(crate) fn peek_changes(&self) -> Vec<VisibilityChange> {
        self.sorted_changes()
    }

    pub(crate) fn take_changes(&mut self) -> Vec<VisibilityChange> {
        let changes = self.sorted_changes();
        self.pending_changes.clear();
        changes
    }

    fn delivery_groups_impl(
        &self,
        subject_ids: &[u32],
        owner_only: Option<&[bool]>,
        force: Option<&[bool]>,
        server_tick: u32,
    ) -> Vec<(Vec<u32>, Vec<usize>)> {
        let mut signature_groups: BTreeMap<(GridCoord, AudienceSignature, bool), Vec<usize>> =
            BTreeMap::new();
        // Audience通常是上百个UnitId。把整段Vec作为BTree键会在每次插入时反复比较
        // 共同前缀；HashMap只线性扫描键一次，最后再排序一次保持测试和网络输出稳定。
        // An audience often contains hundreds of UnitIds. Using the whole Vec as a BTree key
        // repeatedly compares common prefixes; hash once and sort once for deterministic output.
        let mut by_audience: FxHashMap<Vec<u32>, Vec<usize>> = FxHashMap::default();
        for (index, subject_id) in subject_ids.iter().copied().enumerate() {
            let Some(entity_index) = self.entity_index(subject_id) else {
                continue;
            };
            let entry = self.entries[entity_index].as_ref().unwrap();
            if !entry.subject {
                continue;
            }
            if owner_only.is_some_and(|values| values[index]) {
                if !entry.observer {
                    continue;
                }
                by_audience.entry(vec![subject_id]).or_default().push(index);
                continue;
            }
            let forced = force.is_none_or(|values| values[index]);
            let signature = self.audience_signatures[entity_index];
            signature_groups
                .entry((entry.grid, signature, forced))
                .or_default()
                .push(index);
        }
        for ((_grid, _signature, forced), indices) in signature_groups {
            let subject_id = subject_ids[indices[0]];
            let audience = self.delivery_audience(subject_id, server_tick, forced);
            if !audience.is_empty() {
                by_audience.entry(audience).or_default().extend(indices);
            }
        }
        let mut groups: Vec<_> = by_audience.into_iter().collect();
        groups.sort_unstable_by(|left, right| left.0.cmp(&right.0));
        groups
    }

    fn delivery_audience(&self, subject_id: u32, server_tick: u32, forced: bool) -> Vec<u32> {
        let Some(subject_index) = self.entity_index(subject_id) else {
            return Vec::new();
        };
        let subject = self.entries[subject_index].as_ref().unwrap();
        let mut ids = Vec::new();
        self.visible_observers
            .for_each_index(subject_index, |observer_index| {
                let Some(observer) = self.entries[observer_index].as_ref() else {
                    return;
                };
                if forced || self.sync_due(observer.grid, subject.grid, server_tick) {
                    ids.push(observer.unit_id);
                }
            });
        // 自身权威回包沿用旧语义，不属于 observer-subject 可见边。
        if subject.observer && (forced || self.sync_due(subject.grid, subject.grid, server_tick)) {
            ids.push(subject_id);
        }
        ids.sort_unstable();
        ids.dedup();
        ids
    }

    fn sync_due(&self, observer: GridCoord, subject: GridCoord, server_tick: u32) -> bool {
        let distance = chebyshev(observer, subject) as u32;
        self.sync_tiers
            .iter()
            .find(|tier| distance <= tier.radius_grids)
            .is_some_and(|tier| {
                server_tick % tier.interval_ticks == grid_phase(subject, tier.interval_ticks)
            })
    }

    fn reconcile_pair_indices(
        &mut self,
        observer_index: usize,
        subject_index: usize,
        before_spatial: bool,
        distance: i32,
    ) {
        let after_spatial = distance <= self.enter_radius_grids
            || (before_spatial && distance <= self.detach_radius_grids);
        self.set_spatial_relation_indices(observer_index, subject_index, after_spatial);
        self.set_lingering_relation_indices(
            observer_index,
            subject_index,
            after_spatial && distance > self.enter_radius_grids,
        );
    }

    fn visible_subject_ids(&self, observer_index: usize) -> Vec<u32> {
        self.relation_ids(&self.visible_subjects, observer_index)
    }

    fn visible_observer_ids(&self, subject_index: usize) -> Vec<u32> {
        self.relation_ids(&self.visible_observers, subject_index)
    }

    fn relation_ids(&self, matrix: &DenseBitMatrix, row: usize) -> Vec<u32> {
        let mut ids = Vec::new();
        matrix.for_each_index(row, |index| {
            if let Some(entry) = self.entries[index].as_ref() {
                ids.push(entry.unit_id);
            }
        });
        ids
    }

    fn grid_of(&self, x: f32, z: f32) -> GridCoord {
        GridCoord {
            x: ((x - self.origin_x_meters) / self.grid_size_meters).floor() as i32,
            z: ((z - self.origin_z_meters) / self.grid_size_meters).floor() as i32,
        }
    }

    fn grid_index(&self, grid: GridCoord) -> Option<usize> {
        if grid.x < 0
            || grid.z < 0
            || grid.x >= self.grid_width as i32
            || grid.z >= self.grid_depth as i32
        {
            return None;
        }
        Some(grid.z as usize * self.grid_width as usize + grid.x as usize)
    }

    fn push_to_grid(&mut self, grid_index: usize, entity_index: usize) -> usize {
        let members = &mut self.grids[grid_index];
        if members.is_empty() {
            self.occupied_grid_count += 1;
        }
        let slot = members.len();
        members.push(entity_index);
        if let Some(bits) = self.hot_grid_bits[grid_index].as_mut() {
            bits[entity_index / 64] |= 1_u64 << (entity_index % 64);
        } else if members.len() >= HOT_GRID_PROMOTE_MEMBERS {
            let mut bits = Box::new([0_u64; HOT_GRID_WORDS]);
            for &member_index in members.iter() {
                bits[member_index / 64] |= 1_u64 << (member_index % 64);
            }
            self.hot_grid_bits[grid_index] = Some(bits);
        }
        slot
    }

    fn remove_from_grid(&mut self, entity_index: usize, grid_index: usize, slot_in_grid: usize) {
        let (swapped_index, became_empty) = {
            let members = &mut self.grids[grid_index];
            debug_assert_eq!(members.get(slot_in_grid), Some(&entity_index));
            members.swap_remove(slot_in_grid);
            (members.get(slot_in_grid).copied(), members.is_empty())
        };
        if let Some(swapped_index) = swapped_index {
            self.entries[swapped_index].as_mut().unwrap().slot_in_grid = slot_in_grid;
        }
        if let Some(bits) = self.hot_grid_bits[grid_index].as_mut() {
            bits[entity_index / 64] &= !(1_u64 << (entity_index % 64));
            if self.grids[grid_index].len() < HOT_GRID_DEMOTE_MEMBERS {
                self.hot_grid_bits[grid_index] = None;
            }
        }
        if became_empty {
            self.occupied_grid_count -= 1;
        }
    }

    fn allocate_entity_index(&mut self) -> usize {
        self.free_entity_indices.pop().unwrap_or_else(|| {
            let index = self.entries.len();
            self.entries.push(None);
            self.audience_signatures.push(AudienceSignature::default());
            self.spatial_subjects.ensure_dimension(index + 1);
            self.spatial_observers.ensure_dimension(index + 1);
            self.visible_subjects.ensure_dimension(index + 1);
            self.visible_observers.ensure_dimension(index + 1);
            self.lingering_subjects.ensure_dimension(index + 1);
            self.scratch_candidate_seen.push(false);
            index
        })
    }

    fn release_entity_index(&mut self, index: usize) {
        self.spatial_subjects.clear_index(index);
        self.spatial_observers.clear_index(index);
        self.visible_subjects.clear_index(index);
        self.visible_observers.clear_index(index);
        self.lingering_subjects.clear_index(index);
        self.free_entity_indices.push(index);
    }

    fn entity_index(&self, unit_id: u32) -> Option<usize> {
        self.unit_indices.get(&unit_id).copied()
    }

    fn entry(&self, unit_id: u32) -> Option<&AoiEntry> {
        self.entity_index(unit_id)
            .and_then(|index| self.entries[index].as_ref())
    }

    fn collect_candidates(&mut self, output: &mut Vec<usize>, regions: &[(GridCoord, i32)]) {
        self.scratch_hot_candidates.fill(0);
        for &(center, radius) in regions {
            let min_x = (center.x - radius).max(0);
            let max_x = (center.x + radius).min(self.grid_width as i32 - 1);
            let min_z = (center.z - radius).max(0);
            let max_z = (center.z + radius).min(self.grid_depth as i32 - 1);
            for z in min_z..=max_z {
                for x in min_x..=max_x {
                    let grid_index = z as usize * self.grid_width as usize + x as usize;
                    if let Some(bits) = self.hot_grid_bits[grid_index].as_ref() {
                        for (target, source) in
                            self.scratch_hot_candidates.iter_mut().zip(bits.iter())
                        {
                            *target |= *source;
                        }
                        continue;
                    }
                    for &entity_index in &self.grids[grid_index] {
                        if !self.scratch_candidate_seen[entity_index] {
                            self.scratch_candidate_seen[entity_index] = true;
                            output.push(entity_index);
                        }
                    }
                }
            }
        }
        for (word_index, &word) in self.scratch_hot_candidates.iter().enumerate() {
            let mut remaining = word;
            while remaining != 0 {
                let bit = remaining.trailing_zeros() as usize;
                let entity_index = word_index * 64 + bit;
                if !self.scratch_candidate_seen[entity_index] {
                    self.scratch_candidate_seen[entity_index] = true;
                    output.push(entity_index);
                }
                remaining &= remaining - 1;
            }
        }
    }

    fn set_spatial_relation_indices(
        &mut self,
        observer_index: usize,
        subject_index: usize,
        spatial: bool,
    ) -> bool {
        let observer = self.entries[observer_index].unwrap();
        let subject = self.entries[subject_index].unwrap();
        if observer_index == subject_index || !observer.observer || !subject.subject {
            return false;
        }
        let before = self
            .spatial_subjects
            .set(observer_index, subject_index, spatial);
        if before == spatial {
            return false;
        }
        self.spatial_observers
            .set(subject_index, observer_index, spatial);
        if spatial {
            self.spatial_relation_count += 1;
            self.set_visible_relation_indices(observer_index, subject_index, true);
        } else {
            self.set_lingering_relation_indices(observer_index, subject_index, false);
            self.set_visible_relation_indices(observer_index, subject_index, false);
            self.spatial_relation_count -= 1;
        }
        true
    }

    fn set_lingering_relation_indices(
        &mut self,
        observer_index: usize,
        subject_index: usize,
        lingering: bool,
    ) {
        let before = self
            .lingering_subjects
            .set(observer_index, subject_index, lingering);
        if before == lingering {
            return;
        }
        if lingering {
            self.lingering_relation_count += 1;
        } else {
            self.lingering_relation_count -= 1;
        }
    }

    fn set_visible_relation_indices(
        &mut self,
        observer_index: usize,
        subject_index: usize,
        visible: bool,
    ) -> bool {
        let observer_id = self.entries[observer_index].unwrap().unit_id;
        let subject_id = self.entries[subject_index].unwrap().unit_id;
        let before = self
            .visible_subjects
            .set(observer_index, subject_index, visible);
        if before == visible {
            return false;
        }
        self.visible_observers
            .set(subject_index, observer_index, visible);
        if visible {
            self.visible_relation_count += 1;
        } else {
            self.visible_relation_count -= 1;
        }
        self.record_change(observer_id, subject_index, subject_id, before, visible);
        true
    }

    fn sorted_changes(&self) -> Vec<VisibilityChange> {
        let mut changes: Vec<_> = self
            .pending_changes
            .iter()
            .map(|(&(observer_id, subject_id), change)| VisibilityChange {
                observer_id,
                subject_id,
                visible: change.after,
            })
            .collect();
        changes.sort_unstable_by_key(|change| (change.observer_id, change.subject_id));
        changes
    }

    fn record_change(
        &mut self,
        observer_id: u32,
        subject_index: usize,
        subject_id: u32,
        before: bool,
        after: bool,
    ) {
        if before == after {
            return;
        }
        let signature = &mut self.audience_signatures[subject_index];
        if after {
            signature.insert(observer_id);
        } else {
            signature.remove(observer_id);
        }
        let pair = (observer_id, subject_id);
        if let Some(change) = self.pending_changes.get_mut(&pair) {
            change.after = after;
            if change.before == change.after {
                self.pending_changes.remove(&pair);
            }
        } else {
            self.pending_changes
                .insert(pair, PendingVisibilityChange { before, after });
        }
    }
}

fn mix_observer_id(observer_id: u32) -> u64 {
    let mut value = u64::from(observer_id).wrapping_add(0x9e37_79b9_7f4a_7c15);
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

fn chebyshev(left: GridCoord, right: GridCoord) -> i32 {
    (left.x - right.x).abs().max((left.z - right.z).abs())
}

/// 让不同Subject Grid的低频同步稳定错峰，同一Grid仍可共享一份编码帧。
/// Staggers low-frequency sync by subject grid while preserving one shared frame per grid.
fn grid_phase(grid: GridCoord, interval_ticks: u32) -> u32 {
    let mixed = (grid.x as u32).wrapping_mul(0x9e37_79b9).rotate_left(13)
        ^ (grid.z as u32).wrapping_mul(0x85eb_ca6b);
    mixed % interval_ticks
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::hint::black_box;
    use std::time::{Duration, Instant};

    fn world() -> AoiWorld {
        AoiWorld::new(
            10_000,
            0,
            0,
            100,
            100,
            1,
            3,
            vec![
                SyncTier {
                    radius_grids: 1,
                    interval_ticks: 1,
                },
                SyncTier {
                    radius_grids: 2,
                    interval_ticks: 4,
                },
                SyncTier {
                    radius_grids: 3,
                    interval_ticks: 20,
                },
            ],
        )
        .unwrap()
    }

    #[test]
    fn map_relative_origin_preserves_odd_world_grid_count() {
        let world = AoiWorld::new(
            15_000,
            -112_000,
            -112_000,
            15,
            15,
            1,
            3,
            vec![SyncTier {
                radius_grids: 3,
                interval_ticks: 1,
            }],
        )
        .unwrap();

        assert_eq!(world.grid_of(-105.0, -105.0), GridCoord { x: 0, z: 0 });
        assert_eq!(world.grid_of(105.0, 105.0), GridCoord { x: 14, z: 14 });
    }

    #[test]
    fn outermost_sync_tier_must_cover_detach_radius() {
        let result = AoiWorld::new(
            10_000,
            0,
            0,
            100,
            100,
            1,
            3,
            vec![
                SyncTier {
                    radius_grids: 1,
                    interval_ticks: 1,
                },
                SyncTier {
                    radius_grids: 2,
                    interval_ticks: 4,
                },
            ],
        );
        assert!(matches!(
            result,
            Err("AOI outermost sync tier must cover the detach radius")
        ));
    }

    #[test]
    fn enter_and_detach_are_independent_with_hysteresis() {
        let mut world = world();
        world.attach(1, 0.0, 0.0, true, true).unwrap();
        world.attach(2, 10.0, 0.0, true, true).unwrap();
        world.take_changes();
        world.relocate(2, 30.0, 0.0).unwrap();
        assert_eq!(world.visible_subjects(1), vec![2]);
        assert!(world.take_changes().is_empty());
        world.relocate(2, 40.0, 0.0).unwrap();
        assert!(world.visible_subjects(1).is_empty());
        assert_eq!(world.take_changes().len(), 2);
    }

    #[test]
    fn detach_band_does_not_create_visibility_before_enter() {
        let mut world = world();
        world.attach(1, 0.0, 0.0, true, true).unwrap();
        world.attach(2, 20.0, 0.0, true, true).unwrap();
        assert!(world.visible_subjects(1).is_empty());
        world.relocate(2, 10.0, 0.0).unwrap();
        assert_eq!(world.visible_subjects(1), vec![2]);
    }

    #[test]
    fn business_filter_can_reject_and_restore_one_direction() {
        let mut world = world();
        world.attach(1, 0.0, 0.0, true, true).unwrap();
        world.attach(2, 0.0, 0.0, true, true).unwrap();
        assert!(world.set_visible(1, 2, false));
        assert!(world.visible_subjects(1).is_empty());
        assert!(world.observers_of(2).is_empty());
        assert_eq!(world.visible_subjects(2), vec![1]);
        assert_eq!(world.observers_of(1), vec![2]);
        assert!(world.set_visible(1, 2, true));
        assert_eq!(world.observers_of(2), vec![1]);
    }

    #[test]
    fn dense_enter_visibility_tracks_every_directed_relation() {
        let mut world = world();
        for unit_id in 1..=100 {
            world.attach(unit_id, 0.0, 0.0, true, true).unwrap();
            world.take_changes();
        }
        assert_eq!(world.candidate_relation_count(), 9_900);
        assert_eq!(world.visible_relation_count(), 9_900);
        assert_eq!(world.lingering_relation_count(), 0);
    }

    #[test]
    fn hot_grid_bitmap_promotes_and_demotes_without_changing_relations() {
        let mut world = world();
        for unit_id in 1..=128 {
            world.attach(unit_id, 1.0, 1.0, true, true).unwrap();
        }
        let first_grid = world.grid_index(GridCoord { x: 0, z: 0 }).unwrap();
        assert!(world.hot_grid_bits[first_grid].is_some());
        assert_eq!(world.visible_relation_count(), 128 * 127);

        world.relocate(128, 11.0, 1.0).unwrap();
        assert_eq!(world.visible_subjects(128).len(), 127);
        for unit_id in 1..=32 {
            assert!(world.detach(unit_id));
        }

        assert_eq!(world.grids[first_grid].len(), 95);
        assert!(world.hot_grid_bits[first_grid].is_none());
        assert_eq!(world.visible_subjects(128).len(), 95);
    }

    #[test]
    fn sync_tiers_only_throttle_replaceable_records() {
        let mut world = world();
        world.attach(1, 0.0, 0.0, true, true).unwrap();
        world.attach(2, 10.0, 0.0, true, true).unwrap();
        world.relocate(2, 30.0, 0.0).unwrap();
        let subjects = [2];
        let due_tick = (1..=20)
            .find(|tick| grid_phase(GridCoord { x: 3, z: 0 }, 20) == tick % 20)
            .unwrap();
        let early = world.tiered_delivery_groups(&subjects, &[false], due_tick + 1);
        assert!(early.iter().all(|(audience, _)| !audience.contains(&1)));
        let due = world.tiered_delivery_groups(&subjects, &[false], due_tick);
        assert!(due.iter().any(|(audience, _)| audience.contains(&1)));
        let forced = world.tiered_delivery_groups(&subjects, &[true], 1);
        assert!(forced.iter().any(|(audience, _)| audience.contains(&1)));
    }

    #[test]
    fn medium_ring_uses_five_hertz_without_creating_new_visibility() {
        let mut world = world();
        world.attach(1, 0.0, 0.0, true, true).unwrap();
        world.attach(2, 10.0, 0.0, true, true).unwrap();
        world.relocate(2, 20.0, 0.0).unwrap();
        let subjects = [2];
        let due_tick = (1..=4)
            .find(|tick| grid_phase(GridCoord { x: 2, z: 0 }, 4) == tick % 4)
            .unwrap();
        assert!(
            world
                .tiered_delivery_groups(&subjects, &[false], due_tick)
                .iter()
                .any(|(audience, _)| audience.contains(&1))
        );
        assert!(
            world
                .tiered_delivery_groups(&subjects, &[false], due_tick + 1)
                .iter()
                .all(|(audience, _)| !audience.contains(&1))
        );
    }

    #[test]
    fn dense_delivery_shares_one_encoded_frame() {
        let mut world = world();
        for unit_id in 1..=100 {
            world.attach(unit_id, 0.0, 0.0, true, true).unwrap();
            world.take_changes();
        }
        let subjects: Vec<_> = (1..=100).collect();
        assert_eq!(
            world.delivery_groups(&subjects),
            vec![((1..=100).collect(), (0..100).collect())]
        );
    }

    #[test]
    fn private_delivery_reaches_only_each_subject_owner() {
        let mut world = world();
        for unit_id in 1..=3 {
            world
                .attach_routed(unit_id, 0.0, 0.0, true, true, unit_id)
                .unwrap();
        }
        world.attach_routed(4, 0.0, 0.0, false, true, 0).unwrap();
        world.take_changes();

        assert_eq!(
            world.visibility_delivery_groups(&[1, 2, 3, 4], &[false, true, true, true]),
            vec![
                (vec![1, 2, 3], vec![0]),
                (vec![2], vec![1]),
                (vec![3], vec![2]),
            ]
        );
    }

    #[test]
    fn delivery_route_rebind_preserves_visibility() {
        let mut world = world();
        world.attach_routed(1, 0.0, 0.0, true, true, 1).unwrap();
        world.attach_routed(2, 0.0, 0.0, true, true, 2).unwrap();
        world.take_changes();
        let visible_before = world.visible_subjects(1);

        world.set_delivery_route_id(1, 9).unwrap();

        assert_eq!(world.delivery_route_id(1), Some(9));
        assert_eq!(world.visible_subjects(1), visible_before);
        assert!(world.take_changes().is_empty());
    }

    #[test]
    fn dense_hysteresis_delivery_still_shares_one_encoded_frame() {
        let mut world = world();
        for unit_id in 1..=90 {
            world.attach(unit_id, 1.0, 1.0, true, true).unwrap();
        }
        world.take_changes();

        let grid_offsets = [0.0_f32, 1.0, 2.0];
        for unit_id in 1..=90 {
            let slot = (unit_id - 1) as usize % 9;
            let x = grid_offsets[slot % 3] * 10.0 + 1.0;
            let z = grid_offsets[slot / 3] * 10.0 + 1.0;
            world.relocate(unit_id, x, z).unwrap();
        }

        assert!(world.lingering_relation_count() > 0);
        assert_eq!(world.visible_relation_count(), 90 * 89);
        let subjects: Vec<_> = (1..=90).collect();
        let groups = world.tiered_delivery_groups(&subjects, &[true; 90], 1);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].0, (1..=90).collect::<Vec<_>>());
        let mut indices = groups[0].1.clone();
        indices.sort_unstable();
        assert_eq!(indices, (0..90).collect::<Vec<_>>());
    }

    #[test]
    fn business_filter_splits_only_the_affected_audience() {
        let mut world = world();
        for unit_id in 1..=3 {
            world.attach(unit_id, 0.0, 0.0, true, true).unwrap();
        }
        world.take_changes();
        assert!(world.set_visible(1, 2, false));
        assert_eq!(world.rejected_relation_count(), 1);

        assert_eq!(
            world.delivery_groups(&[1, 2, 3]),
            vec![(vec![1, 2, 3], vec![0, 2]), (vec![2, 3], vec![1])]
        );
    }

    #[test]
    fn moving_one_member_repairs_the_swapped_grid_slot() {
        let mut world = world();
        world.attach(1, 1.0, 1.0, true, true).unwrap();
        world.attach(2, 2.0, 2.0, true, true).unwrap();

        world.relocate(1, 11.0, 1.0).unwrap();
        world.relocate(2, 21.0, 1.0).unwrap();

        let first_index = world.entity_index(1).unwrap();
        let second_index = world.entity_index(2).unwrap();
        let first = world.entries[first_index].as_ref().unwrap();
        let second = world.entries[second_index].as_ref().unwrap();
        assert_eq!(
            world.grids[first.grid_index][first.slot_in_grid],
            first_index
        );
        assert_eq!(
            world.grids[second.grid_index][second.slot_in_grid],
            second_index
        );
        assert_eq!(world.occupied_grid_count, 2);
    }

    #[test]
    fn reused_entity_index_does_not_inherit_visibility_bits() {
        let mut world = world();
        world.attach(1, 1.0, 1.0, true, true).unwrap();
        world.attach(2, 1.0, 1.0, true, true).unwrap();
        world.take_changes();
        let released_index = world.entity_index(2).unwrap();

        assert!(world.set_visible(1, 2, false));
        assert!(world.detach(2));
        world.take_changes();
        world.attach(3, 31.0, 1.0, true, true).unwrap();

        assert_eq!(world.entity_index(3), Some(released_index));
        assert!(world.visible_subjects(1).is_empty());
        assert!(world.observers_of(3).is_empty());
        assert_eq!(world.rejected_relation_count(), 0);
    }

    #[test]
    fn attach_and_relocate_reject_positions_outside_flat_grid() {
        let mut world = world();
        assert_eq!(
            world.attach(1, -1.0, 0.0, true, true),
            Err("AOI position is outside the configured map grid")
        );
        assert_eq!(world.entry_count(), 0);
        assert!(world.free_entity_indices.is_empty());

        world.attach(2, 1.0, 1.0, true, true).unwrap();
        let before = *world.entry(2).unwrap();
        assert_eq!(
            world.relocate(2, 1_000.0, 1.0),
            Err("AOI position is outside the configured map grid")
        );
        let after = world.entry(2).unwrap();
        assert_eq!(after.grid, before.grid);
        assert_eq!(after.grid_index, before.grid_index);
        assert_eq!(after.slot_in_grid, before.slot_in_grid);
    }

    /// 手工运行的热点Grid候选集合微基准，不进入普通测试与CI。
    /// Manual hotspot-grid candidate benchmark excluded from regular tests and CI.
    #[test]
    #[ignore = "run manually when evaluating hotspot cell storage"]
    fn benchmark_hot_grid_candidate_storage() {
        fn vec_collect(
            cells: &[Vec<usize>],
            cell_indices: &[usize],
            seen: &mut [bool],
            output: &mut Vec<usize>,
        ) {
            output.clear();
            for &cell_index in cell_indices {
                for &entity_index in &cells[cell_index] {
                    if !seen[entity_index] {
                        seen[entity_index] = true;
                        output.push(entity_index);
                    }
                }
            }
            for &entity_index in output.iter() {
                seen[entity_index] = false;
            }
        }

        fn bitmap_collect(
            cells: &[Vec<u64>],
            cell_indices: &[usize],
            union: &mut [u64],
            output: &mut Vec<usize>,
        ) {
            output.clear();
            union.fill(0);
            for &cell_index in cell_indices {
                for (target, source) in union.iter_mut().zip(&cells[cell_index]) {
                    *target |= *source;
                }
            }
            for (word_index, &word) in union.iter().enumerate() {
                let mut remaining = word;
                while remaining != 0 {
                    let bit = remaining.trailing_zeros() as usize;
                    output.push(word_index * 64 + bit);
                    remaining &= remaining - 1;
                }
            }
        }

        fn measure(mut operation: impl FnMut()) -> Duration {
            let started = Instant::now();
            for _ in 0..10_000 {
                operation();
            }
            started.elapsed()
        }

        let capacity: usize = 16_384;
        let words = capacity.div_ceil(64);
        for density in [8_usize, 16, 32, 64, 128, 256, 512, 1_024, 3_000] {
            let cell_count = (capacity / density).clamp(1, 28);
            let mut vec_cells = vec![Vec::new(); cell_count];
            let mut bitmap_cells = vec![vec![0_u64; words]; cell_count];
            let mut next_entity = 0;
            for cell_index in 0..cell_count {
                for _ in 0..density {
                    if next_entity == capacity {
                        break;
                    }
                    vec_cells[cell_index].push(next_entity);
                    bitmap_cells[cell_index][next_entity / 64] |= 1_u64 << (next_entity % 64);
                    next_entity += 1;
                }
            }
            // 模拟旧Detach与新Enter邻域重叠：热点Grid会被访问两次。
            // Models overlap between old Detach and new Enter neighborhoods.
            let mut cell_indices: Vec<_> = (0..cell_count).collect();
            cell_indices.extend(0..cell_count.min(6));
            let mut seen = vec![false; capacity];
            let mut union = vec![0_u64; words];
            let mut output = Vec::with_capacity(next_entity);
            let vec_elapsed = measure(|| {
                vec_collect(&vec_cells, &cell_indices, &mut seen, &mut output);
                black_box(output.len());
            });
            let bitmap_elapsed = measure(|| {
                bitmap_collect(&bitmap_cells, &cell_indices, &mut union, &mut output);
                black_box(output.len());
            });
            println!(
                "density={density:4} cells={cell_count:2} entities={next_entity:5} vec_ms={:8.2} bitmap_ms={:8.2} ratio={:.3}",
                vec_elapsed.as_secs_f64() * 1_000.0,
                bitmap_elapsed.as_secs_f64() * 1_000.0,
                bitmap_elapsed.as_secs_f64() / vec_elapsed.as_secs_f64()
            );
        }
    }
}
