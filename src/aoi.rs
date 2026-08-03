//! 提供与导航实现无关的扁平 AOI Grid 和稠密关系位图。
//! Provides a navigation-agnostic flat AOI grid and dense relation bitsets.

use std::collections::BTreeMap;

use rustc_hash::FxHashMap;

const MAX_DENSE_ENTITIES: usize = 16_384;

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

    fn indices(&self, row: usize) -> Vec<usize> {
        if row >= self.row_capacity {
            return Vec::new();
        }
        let start = row * self.words_per_row;
        let words = &self.words[start..start + self.words_per_row];
        let mut indices = Vec::new();
        for (word_index, &word) in words.iter().enumerate() {
            let mut remaining = word;
            while remaining != 0 {
                let bit = remaining.trailing_zeros() as usize;
                indices.push(word_index * 64 + bit);
                remaining &= remaining - 1;
            }
        }
        indices
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
    entity_index: usize,
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
    entries: FxHashMap<u32, AoiEntry>,
    entity_ids: Vec<Option<u32>>,
    free_entity_indices: Vec<usize>,
    grids: Vec<Vec<usize>>,
    occupied_grid_count: usize,
    spatial_subjects: DenseBitMatrix,
    spatial_observers: DenseBitMatrix,
    visible_subjects: DenseBitMatrix,
    visible_observers: DenseBitMatrix,
    lingering_subjects: DenseBitMatrix,
    spatial_relation_count: usize,
    visible_relation_count: usize,
    lingering_relation_count: usize,
    audience_signatures: FxHashMap<u32, AudienceSignature>,
    scratch_candidates: Vec<usize>,
    scratch_candidate_seen: Vec<bool>,
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
            entries: FxHashMap::default(),
            entity_ids: Vec::new(),
            free_entity_indices: Vec::new(),
            grids: (0..grid_count).map(|_| Vec::new()).collect(),
            occupied_grid_count: 0,
            spatial_subjects: DenseBitMatrix::default(),
            spatial_observers: DenseBitMatrix::default(),
            visible_subjects: DenseBitMatrix::default(),
            visible_observers: DenseBitMatrix::default(),
            lingering_subjects: DenseBitMatrix::default(),
            spatial_relation_count: 0,
            visible_relation_count: 0,
            lingering_relation_count: 0,
            audience_signatures: FxHashMap::default(),
            scratch_candidates: Vec::new(),
            scratch_candidate_seen: Vec::new(),
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
        if self.entries.contains_key(&unit_id) {
            return Err("AOI unit is already attached");
        }
        if self.entries.len() >= MAX_DENSE_ENTITIES {
            return Err("AOI dense entity capacity exceeds 16384");
        }
        let entity_index = self.allocate_entity_index(unit_id);
        let grid = self.grid_of(x, z);
        let Some(grid_index) = self.grid_index(grid) else {
            self.release_entity_index(entity_index);
            return Err("AOI position is outside the configured map grid");
        };
        let slot_in_grid = self.push_to_grid(grid_index, entity_index);
        self.entries.insert(
            unit_id,
            AoiEntry {
                entity_index,
                grid,
                grid_index,
                slot_in_grid,
                observer,
                subject,
                delivery_route_id,
            },
        );
        if subject {
            let mut signature = AudienceSignature::default();
            if observer {
                signature.insert(unit_id);
            }
            self.audience_signatures.insert(unit_id, signature);
        }

        if observer {
            for subject_id in self.subjects_within(unit_id, grid, self.enter_radius_grids) {
                self.set_spatial_relation(unit_id, subject_id, true);
            }
        }
        if subject {
            for observer_id in self.observers_within(unit_id, grid, self.enter_radius_grids) {
                self.set_spatial_relation(observer_id, unit_id, true);
            }
        }
        Ok(())
    }

    /// 返回 Observer 的进程内投递路由；0 表示该 Observer 未配置原生快照路由。
    /// Returns an observer's process-local delivery route; zero means native fan-out is disabled.
    pub(crate) fn delivery_route_id(&self, observer_id: u32) -> Option<u32> {
        self.entries
            .get(&observer_id)
            .filter(|entry| entry.observer && entry.delivery_route_id != 0)
            .map(|entry| entry.delivery_route_id)
    }

    /// 返回当前地图使用的最大投递路由编号，供帧尾复用连续分桶。
    /// Returns the largest active route id so frame-end fan-out can reuse dense buckets.
    pub(crate) fn max_delivery_route_id(&self) -> u32 {
        self.entries
            .values()
            .map(|entry| entry.delivery_route_id)
            .max()
            .unwrap_or(0)
    }

    /// 从 AOI 移除实体并先生成所有最终 Leave。调用方随后才能销毁 Native Entity。
    /// Detaches an entity after producing final Leave changes, before Native Entity destruction.
    pub(crate) fn detach(&mut self, unit_id: u32) -> bool {
        let Some(entry) = self.entries.get(&unit_id).copied() else {
            return false;
        };
        if entry.observer {
            for subject_id in self.spatial_subject_ids(entry.entity_index) {
                self.set_spatial_relation(unit_id, subject_id, false);
            }
        }
        if entry.subject {
            for observer_id in self.spatial_observer_ids(entry.entity_index) {
                self.set_spatial_relation(observer_id, unit_id, false);
            }
        }
        self.audience_signatures.remove(&unit_id);
        self.remove_from_grid(entry.entity_index, entry.grid_index, entry.slot_in_grid);
        self.entries.remove(&unit_id);
        self.release_entity_index(entry.entity_index);
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
        let Some(entry) = self.entries.get(&unit_id).copied() else {
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
        self.extend_candidates(&mut candidates, entry.grid, self.detach_radius_grids);
        self.extend_candidates(&mut candidates, next, self.enter_radius_grids);
        self.remove_from_grid(entry.entity_index, entry.grid_index, entry.slot_in_grid);
        let slot_in_grid = self.push_to_grid(next_grid_index, entry.entity_index);
        let moved = self.entries.get_mut(&unit_id).unwrap();
        moved.grid = next;
        moved.grid_index = next_grid_index;
        moved.slot_in_grid = slot_in_grid;

        for other_index in candidates.iter().copied() {
            if other_index == entry.entity_index {
                continue;
            }
            let Some(other_id) = self.entity_id(other_index) else {
                continue;
            };
            let Some(other) = self.entries.get(&other_id).copied() else {
                continue;
            };
            let after_distance = chebyshev(next, other.grid);
            if entry.observer && other.subject {
                let pair = (unit_id, other_id);
                let before_spatial = self.is_spatially_visible(pair);
                self.reconcile_pair(pair, before_spatial, after_distance);
            }
            if entry.subject && other.observer {
                let pair = (other_id, unit_id);
                let before_spatial = self.is_spatially_visible(pair);
                self.reconcile_pair(pair, before_spatial, after_distance);
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
        let pair = (observer_id, subject_id);
        let spatial = self.is_spatially_visible(pair);
        let desired = visible && spatial;
        self.set_visible_relation(observer_id, subject_id, desired)
    }

    /// 返回实体涉及的当前空间关系，供阵营、隐身、位面等业务状态失效后重新过滤。
    /// Returns current spatial relations for business-filter invalidation.
    pub(crate) fn candidate_pairs(
        &self,
        unit_id: u32,
        include_observer: bool,
        include_subject: bool,
    ) -> Vec<(u32, u32)> {
        let Some(entry) = self.entries.get(&unit_id).copied() else {
            return Vec::new();
        };
        let mut pairs = Vec::new();
        if include_observer && entry.observer {
            pairs.extend(
                self.spatial_subject_ids(entry.entity_index)
                    .into_iter()
                    .map(|id| (unit_id, id)),
            );
        }
        if include_subject && entry.subject {
            pairs.extend(
                self.spatial_observer_ids(entry.entity_index)
                    .into_iter()
                    .map(|id| (id, unit_id)),
            );
        }
        pairs.sort_unstable();
        pairs.dedup();
        pairs
    }

    pub(crate) fn visible_subjects(&self, observer_id: u32) -> Vec<u32> {
        let Some(entry) = self.entries.get(&observer_id) else {
            return Vec::new();
        };
        if !entry.observer {
            return Vec::new();
        }
        let mut ids = self.visible_subject_ids(entry.entity_index);
        ids.sort_unstable();
        ids
    }

    pub(crate) fn observers_of(&self, subject_id: u32) -> Vec<u32> {
        let Some(entry) = self.entries.get(&subject_id) else {
            return Vec::new();
        };
        if !entry.subject {
            return Vec::new();
        }
        let mut ids = self.visible_observer_ids(entry.entity_index);
        ids.sort_unstable();
        ids
    }

    pub(crate) fn is_attached(&self, unit_id: u32) -> bool {
        self.entries.contains_key(&unit_id)
    }
    pub(crate) fn entry_count(&self) -> usize {
        self.entries.len()
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
        self.delivery_groups_impl(subject_ids, None, 0)
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
        self.delivery_groups_impl(subject_ids, Some(force), server_tick)
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
            let Some(entry) = self.entries.get(&subject_id) else {
                continue;
            };
            if !entry.subject {
                continue;
            }
            let forced = force.is_none_or(|values| values[index]);
            let signature = self
                .audience_signatures
                .get(&subject_id)
                .copied()
                .unwrap_or_default();
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
        let Some(subject) = self.entries.get(&subject_id) else {
            return Vec::new();
        };
        let mut ids: Vec<_> = self
            .observers_of(subject_id)
            .into_iter()
            .filter(|observer_id| {
                forced || self.sync_due(self.entries[observer_id].grid, subject.grid, server_tick)
            })
            .collect();
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

    fn reconcile_pair(&mut self, pair: (u32, u32), before_spatial: bool, distance: i32) {
        let after_spatial = distance <= self.enter_radius_grids
            || (before_spatial && distance <= self.detach_radius_grids);
        self.set_spatial_relation(pair.0, pair.1, after_spatial);
        self.set_lingering_relation(
            pair.0,
            pair.1,
            after_spatial && distance > self.enter_radius_grids,
        );
    }

    fn spatial_subject_ids(&self, observer_index: usize) -> Vec<u32> {
        self.relation_ids(&self.spatial_subjects, observer_index)
    }

    fn spatial_observer_ids(&self, subject_index: usize) -> Vec<u32> {
        self.relation_ids(&self.spatial_observers, subject_index)
    }

    fn visible_subject_ids(&self, observer_index: usize) -> Vec<u32> {
        self.relation_ids(&self.visible_subjects, observer_index)
    }

    fn visible_observer_ids(&self, subject_index: usize) -> Vec<u32> {
        self.relation_ids(&self.visible_observers, subject_index)
    }

    fn relation_ids(&self, matrix: &DenseBitMatrix, row: usize) -> Vec<u32> {
        matrix
            .indices(row)
            .into_iter()
            .filter_map(|index| self.entity_id(index))
            .collect()
    }

    fn subjects_within(&self, observer_id: u32, center: GridCoord, radius: i32) -> Vec<u32> {
        self.nearby_ids(center, radius)
            .filter(|id| {
                *id != observer_id && self.entries.get(id).is_some_and(|entry| entry.subject)
            })
            .collect()
    }

    fn observers_within(&self, subject_id: u32, center: GridCoord, radius: i32) -> Vec<u32> {
        self.nearby_ids(center, radius)
            .filter(|id| {
                *id != subject_id && self.entries.get(id).is_some_and(|entry| entry.observer)
            })
            .collect()
    }

    fn nearby_ids(&self, center: GridCoord, radius: i32) -> impl Iterator<Item = u32> + '_ {
        self.nearby_indices(center, radius)
            .filter_map(|entity_index| self.entity_id(entity_index))
    }

    fn nearby_indices(&self, center: GridCoord, radius: i32) -> impl Iterator<Item = usize> + '_ {
        self.coords_within(center, radius)
            .filter_map(|coord| self.grid_index(coord))
            .flat_map(|index| self.grids[index].iter().copied())
    }

    fn coords_within(&self, center: GridCoord, radius: i32) -> impl Iterator<Item = GridCoord> {
        (center.z - radius..=center.z + radius).flat_map(move |z| {
            (center.x - radius..=center.x + radius).map(move |x| GridCoord { x, z })
        })
    }

    fn is_spatially_visible(&self, pair: (u32, u32)) -> bool {
        let Some(observer) = self.entries.get(&pair.0) else {
            return false;
        };
        let Some(subject) = self.entries.get(&pair.1) else {
            return false;
        };
        self.spatial_subjects
            .contains(observer.entity_index, subject.entity_index)
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
            let swapped_id = self.entity_id(swapped_index).unwrap();
            self.entries.get_mut(&swapped_id).unwrap().slot_in_grid = slot_in_grid;
        }
        if became_empty {
            self.occupied_grid_count -= 1;
        }
    }

    fn allocate_entity_index(&mut self, unit_id: u32) -> usize {
        let index = self.free_entity_indices.pop().unwrap_or_else(|| {
            let index = self.entity_ids.len();
            self.entity_ids.push(None);
            self.spatial_subjects.ensure_dimension(index + 1);
            self.spatial_observers.ensure_dimension(index + 1);
            self.visible_subjects.ensure_dimension(index + 1);
            self.visible_observers.ensure_dimension(index + 1);
            self.lingering_subjects.ensure_dimension(index + 1);
            self.scratch_candidate_seen.push(false);
            index
        });
        self.entity_ids[index] = Some(unit_id);
        index
    }

    fn release_entity_index(&mut self, index: usize) {
        self.spatial_subjects.clear_index(index);
        self.spatial_observers.clear_index(index);
        self.visible_subjects.clear_index(index);
        self.visible_observers.clear_index(index);
        self.lingering_subjects.clear_index(index);
        self.entity_ids[index] = None;
        self.free_entity_indices.push(index);
    }

    fn entity_id(&self, index: usize) -> Option<u32> {
        self.entity_ids.get(index).copied().flatten()
    }

    fn extend_candidates(&mut self, output: &mut Vec<usize>, center: GridCoord, radius: i32) {
        let min_x = (center.x - radius).max(0);
        let max_x = (center.x + radius).min(self.grid_width as i32 - 1);
        let min_z = (center.z - radius).max(0);
        let max_z = (center.z + radius).min(self.grid_depth as i32 - 1);
        for z in min_z..=max_z {
            for x in min_x..=max_x {
                let grid_index = z as usize * self.grid_width as usize + x as usize;
                for member_slot in 0..self.grids[grid_index].len() {
                    let entity_index = self.grids[grid_index][member_slot];
                    if !self.scratch_candidate_seen[entity_index] {
                        self.scratch_candidate_seen[entity_index] = true;
                        output.push(entity_index);
                    }
                }
            }
        }
    }

    fn set_spatial_relation(&mut self, observer_id: u32, subject_id: u32, spatial: bool) -> bool {
        let Some(observer) = self.entries.get(&observer_id).copied() else {
            return false;
        };
        let Some(subject) = self.entries.get(&subject_id).copied() else {
            return false;
        };
        if observer_id == subject_id || !observer.observer || !subject.subject {
            return false;
        }
        let before =
            self.spatial_subjects
                .set(observer.entity_index, subject.entity_index, spatial);
        if before == spatial {
            return false;
        }
        self.spatial_observers
            .set(subject.entity_index, observer.entity_index, spatial);
        if spatial {
            self.spatial_relation_count += 1;
            self.set_visible_relation(observer_id, subject_id, true);
        } else {
            self.set_lingering_relation(observer_id, subject_id, false);
            self.set_visible_relation(observer_id, subject_id, false);
            self.spatial_relation_count -= 1;
        }
        true
    }

    fn set_lingering_relation(&mut self, observer_id: u32, subject_id: u32, lingering: bool) {
        let Some(observer) = self.entries.get(&observer_id).copied() else {
            return;
        };
        let Some(subject) = self.entries.get(&subject_id).copied() else {
            return;
        };
        let before =
            self.lingering_subjects
                .set(observer.entity_index, subject.entity_index, lingering);
        if before == lingering {
            return;
        }
        if lingering {
            self.lingering_relation_count += 1;
        } else {
            self.lingering_relation_count -= 1;
        }
    }

    fn set_visible_relation(&mut self, observer_id: u32, subject_id: u32, visible: bool) -> bool {
        let Some(observer) = self.entries.get(&observer_id).copied() else {
            return false;
        };
        let Some(subject) = self.entries.get(&subject_id).copied() else {
            return false;
        };
        let before =
            self.visible_subjects
                .set(observer.entity_index, subject.entity_index, visible);
        if before == visible {
            return false;
        }
        self.visible_observers
            .set(subject.entity_index, observer.entity_index, visible);
        if visible {
            self.visible_relation_count += 1;
        } else {
            self.visible_relation_count -= 1;
        }
        self.record_change(observer_id, subject_id, before, visible);
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

    fn record_change(&mut self, observer_id: u32, subject_id: u32, before: bool, after: bool) {
        if before == after {
            return;
        }
        if let Some(signature) = self.audience_signatures.get_mut(&subject_id) {
            if after {
                signature.insert(observer_id);
            } else {
                signature.remove(observer_id);
            }
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

        let first = world.entries.get(&1).unwrap();
        let second = world.entries.get(&2).unwrap();
        assert_eq!(
            world.grids[first.grid_index][first.slot_in_grid],
            first.entity_index
        );
        assert_eq!(
            world.grids[second.grid_index][second.slot_in_grid],
            second.entity_index
        );
        assert_eq!(world.occupied_grid_count, 2);
    }

    #[test]
    fn reused_entity_index_does_not_inherit_visibility_bits() {
        let mut world = world();
        world.attach(1, 1.0, 1.0, true, true).unwrap();
        world.attach(2, 1.0, 1.0, true, true).unwrap();
        world.take_changes();
        let released_index = world.entries.get(&2).unwrap().entity_index;

        assert!(world.set_visible(1, 2, false));
        assert!(world.detach(2));
        world.take_changes();
        world.attach(3, 31.0, 1.0, true, true).unwrap();

        assert_eq!(world.entries.get(&3).unwrap().entity_index, released_index);
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
        assert!(world.entries.is_empty());
        assert!(world.free_entity_indices.len() == 1);

        world.attach(2, 1.0, 1.0, true, true).unwrap();
        let before = *world.entries.get(&2).unwrap();
        assert_eq!(
            world.relocate(2, 1_000.0, 1.0),
            Err("AOI position is outside the configured map grid")
        );
        let after = world.entries.get(&2).unwrap();
        assert_eq!(after.grid, before.grid);
        assert_eq!(after.grid_index, before.grid_index);
        assert_eq!(after.slot_in_grid, before.slot_in_grid);
    }
}
