//! 提供与导航实现无关的稀疏 AOI Grid。 / Provides a navigation-agnostic sparse AOI grid.

use std::collections::BTreeMap;

use rustc_hash::{FxHashMap, FxHashSet};

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

#[derive(Clone, Copy, Debug)]
struct AoiEntry {
    grid: GridCoord,
    observer: bool,
    subject: bool,
    delivery_route_id: u32,
}

/// 一张地图实例独占的 AOI 世界。
///
/// Enter 范围内的关系由 Grid 实时推导；只有已经 Enter、随后移动到 Enter 外但尚未越过
/// Detach 的迟滞关系，才进入 `lingering_relations`。因此密集同屏不会永久保存 N*N 关系。
/// 业务过滤器拒绝的关系同样只作为稀疏覆盖保存。
///
/// Relations inside Enter are derived from grids. Only relations that already entered and then
/// moved into the hysteresis band are materialized, so dense crowds do not retain an N-by-N graph.
pub(crate) struct AoiWorld {
    grid_size_meters: f32,
    origin_x_meters: f32,
    origin_z_meters: f32,
    enter_radius_grids: i32,
    detach_radius_grids: i32,
    sync_tiers: Vec<SyncTier>,
    entries: FxHashMap<u32, AoiEntry>,
    grids: FxHashMap<GridCoord, FxHashSet<u32>>,
    lingering_relations: FxHashSet<(u32, u32)>,
    rejected_relations: FxHashSet<(u32, u32)>,
    pending_changes: FxHashMap<(u32, u32), PendingVisibilityChange>,
}

impl AoiWorld {
    /// 创建米制 AOI Grid。Enter、Detach 与同步档位彼此独立，但同步只作用于已可见关系。
    /// Creates meter-based AOI grids. Visibility and sync tiers are independent, while sync always
    /// remains constrained to already-visible relations.
    pub(crate) fn new(
        grid_size_millimeters: u32,
        origin_x_millimeters: i64,
        origin_z_millimeters: i64,
        enter_radius_grids: u32,
        detach_radius_grids: u32,
        sync_tiers: Vec<SyncTier>,
    ) -> Result<Self, &'static str> {
        if grid_size_millimeters == 0 {
            return Err("AOI grid size must be greater than zero");
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
        Ok(Self {
            grid_size_meters: grid_size_millimeters as f32 / 1_000.0,
            origin_x_meters: origin_x_millimeters as f32 / 1_000.0,
            origin_z_meters: origin_z_millimeters as f32 / 1_000.0,
            enter_radius_grids: enter_radius_grids as i32,
            detach_radius_grids: detach_radius_grids as i32,
            sync_tiers,
            entries: FxHashMap::default(),
            grids: FxHashMap::default(),
            lingering_relations: FxHashSet::default(),
            rejected_relations: FxHashSet::default(),
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
        self.clear_unit_relations(unit_id);
        let grid = self.grid_of(x, z);
        self.entries.insert(
            unit_id,
            AoiEntry {
                grid,
                observer,
                subject,
                delivery_route_id,
            },
        );
        self.grids.entry(grid).or_default().insert(unit_id);

        if observer {
            for subject_id in self.subjects_within(unit_id, grid, self.enter_radius_grids) {
                self.record_change(unit_id, subject_id, false, true);
            }
        }
        if subject {
            for observer_id in self.observers_within(unit_id, grid, self.enter_radius_grids) {
                self.record_change(observer_id, unit_id, false, true);
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
            for subject_id in self.visible_subjects(unit_id) {
                self.record_change(unit_id, subject_id, true, false);
            }
        }
        if entry.subject {
            for observer_id in self.observers_of(unit_id) {
                self.record_change(observer_id, unit_id, true, false);
            }
        }
        self.entries.remove(&unit_id);
        if let Some(grid) = self.grids.get_mut(&entry.grid) {
            grid.remove(&unit_id);
            if grid.is_empty() {
                self.grids.remove(&entry.grid);
            }
        }
        self.clear_unit_relations(unit_id);
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
        let Some(entry) = self.entries.get(&unit_id).copied() else {
            return Err("AOI unit is not attached");
        };
        if entry.grid == next {
            return Ok(false);
        }

        let old_subjects = if entry.observer {
            self.spatial_subjects(unit_id)
        } else {
            FxHashSet::default()
        };
        let old_observers = if entry.subject {
            self.spatial_observers(unit_id)
        } else {
            FxHashSet::default()
        };
        if let Some(grid) = self.grids.get_mut(&entry.grid) {
            grid.remove(&unit_id);
            if grid.is_empty() {
                self.grids.remove(&entry.grid);
            }
        }
        self.grids.entry(next).or_default().insert(unit_id);
        self.entries.get_mut(&unit_id).unwrap().grid = next;

        if entry.observer {
            let mut candidates = old_subjects.clone();
            candidates.extend(self.subjects_within(unit_id, next, self.enter_radius_grids));
            for subject_id in candidates {
                self.reconcile_pair((unit_id, subject_id), old_subjects.contains(&subject_id));
            }
        }
        if entry.subject {
            let mut candidates = old_observers.clone();
            candidates.extend(self.observers_within(unit_id, next, self.enter_radius_grids));
            for observer_id in candidates {
                self.reconcile_pair((observer_id, unit_id), old_observers.contains(&observer_id));
            }
        }
        Ok(true)
    }

    /// 覆盖一条当前空间关系的业务可见结果；不能把尚未 Enter 的实体强制设为可见。
    /// Overrides business visibility for a current spatial relation without creating visibility.
    pub(crate) fn set_visible(&mut self, observer_id: u32, subject_id: u32, visible: bool) -> bool {
        let pair = (observer_id, subject_id);
        let spatial = self.is_spatially_visible(pair);
        let desired = visible && spatial;
        let current = spatial && !self.rejected_relations.contains(&pair);
        if current == desired {
            return false;
        }
        if desired {
            self.rejected_relations.remove(&pair);
        } else if spatial {
            self.rejected_relations.insert(pair);
        }
        self.record_change(observer_id, subject_id, current, desired);
        true
    }

    /// 返回实体涉及的当前空间关系，供阵营、隐身、位面等业务状态失效后重新过滤。
    /// Returns current spatial relations for business-filter invalidation.
    pub(crate) fn candidate_pairs(
        &self,
        unit_id: u32,
        include_observer: bool,
        include_subject: bool,
    ) -> Vec<(u32, u32)> {
        let Some(entry) = self.entries.get(&unit_id) else {
            return Vec::new();
        };
        let mut pairs = Vec::new();
        if include_observer && entry.observer {
            pairs.extend(
                self.spatial_subjects(unit_id)
                    .into_iter()
                    .map(|id| (unit_id, id)),
            );
        }
        if include_subject && entry.subject {
            pairs.extend(
                self.spatial_observers(unit_id)
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
        let mut ids: Vec<_> = self
            .spatial_subjects(observer_id)
            .into_iter()
            .filter(|id| !self.rejected_relations.contains(&(observer_id, *id)))
            .collect();
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
        let mut ids: Vec<_> = self
            .spatial_observers(subject_id)
            .into_iter()
            .filter(|id| !self.rejected_relations.contains(&(*id, subject_id)))
            .collect();
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
        self.grids.len()
    }

    /// 统计空间候选边；Enter 内按 Grid 聚合，迟滞带只加实际保留的稀疏关系。
    /// Counts spatial edges from aggregated Enter grids plus sparse hysteresis relations.
    pub(crate) fn candidate_relation_count(&self) -> usize {
        let mut roles: FxHashMap<GridCoord, (usize, usize, usize)> = FxHashMap::default();
        for entry in self.entries.values() {
            let value = roles.entry(entry.grid).or_default();
            value.0 += usize::from(entry.observer);
            value.1 += usize::from(entry.subject);
            value.2 += usize::from(entry.observer && entry.subject);
        }
        let enter = roles
            .iter()
            .map(|(grid, &(observers, _, both))| {
                let subjects = self
                    .coords_within(*grid, self.enter_radius_grids)
                    .filter_map(|neighbor| roles.get(&neighbor))
                    .map(|value| value.1)
                    .sum::<usize>();
                observers * subjects - both
            })
            .sum::<usize>();
        enter + self.lingering_relations.len()
    }

    pub(crate) fn visible_relation_count(&self) -> usize {
        self.candidate_relation_count()
            .saturating_sub(self.rejected_relations.len())
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
        let special_subjects: FxHashSet<_> = self
            .rejected_relations
            .iter()
            .chain(self.lingering_relations.iter())
            .map(|pair| pair.1)
            .collect();
        let mut default_groups: BTreeMap<(GridCoord, bool), Vec<usize>> = BTreeMap::new();
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
            if special_subjects.contains(&subject_id) {
                let audience = self.delivery_audience(subject_id, server_tick, forced);
                if !audience.is_empty() {
                    by_audience.entry(audience).or_default().push(index);
                }
            } else {
                default_groups
                    .entry((entry.grid, forced))
                    .or_default()
                    .push(index);
            }
        }
        for ((grid, forced), indices) in default_groups {
            let audience = self.default_audience(grid, server_tick, forced);
            if !audience.is_empty() {
                by_audience.entry(audience).or_default().extend(indices);
            }
        }
        let mut groups: Vec<_> = by_audience.into_iter().collect();
        groups.sort_unstable_by(|left, right| left.0.cmp(&right.0));
        groups
    }

    fn default_audience(
        &self,
        subject_grid: GridCoord,
        server_tick: u32,
        forced: bool,
    ) -> Vec<u32> {
        let mut ids: Vec<_> = self
            .nearby_ids(subject_grid, self.enter_radius_grids)
            .filter(|id| self.entries.get(id).is_some_and(|entry| entry.observer))
            .filter(|id| forced || self.sync_due(self.entries[id].grid, subject_grid, server_tick))
            .collect();
        ids.sort_unstable();
        ids
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

    fn reconcile_pair(&mut self, pair: (u32, u32), before_spatial: bool) {
        let distance = self.pair_distance(pair);
        let after_spatial = distance.is_some_and(|value| {
            value <= self.enter_radius_grids
                || (before_spatial && value <= self.detach_radius_grids)
        });
        let before_visible = before_spatial && !self.rejected_relations.contains(&pair);
        if after_spatial && distance.unwrap() > self.enter_radius_grids {
            self.lingering_relations.insert(pair);
        } else {
            self.lingering_relations.remove(&pair);
        }
        if !after_spatial || !before_spatial {
            self.rejected_relations.remove(&pair);
        }
        let after_visible = after_spatial && !self.rejected_relations.contains(&pair);
        self.record_change(pair.0, pair.1, before_visible, after_visible);
    }

    fn spatial_subjects(&self, observer_id: u32) -> FxHashSet<u32> {
        let Some(entry) = self.entries.get(&observer_id) else {
            return FxHashSet::default();
        };
        self.nearby_ids(entry.grid, self.detach_radius_grids)
            .filter(|subject_id| {
                *subject_id != observer_id
                    && self
                        .entries
                        .get(subject_id)
                        .is_some_and(|entry| entry.subject)
                    && self.is_spatially_visible((observer_id, *subject_id))
            })
            .collect()
    }

    fn spatial_observers(&self, subject_id: u32) -> FxHashSet<u32> {
        let Some(entry) = self.entries.get(&subject_id) else {
            return FxHashSet::default();
        };
        self.nearby_ids(entry.grid, self.detach_radius_grids)
            .filter(|observer_id| {
                *observer_id != subject_id
                    && self
                        .entries
                        .get(observer_id)
                        .is_some_and(|entry| entry.observer)
                    && self.is_spatially_visible((*observer_id, subject_id))
            })
            .collect()
    }

    fn subjects_within(&self, observer_id: u32, center: GridCoord, radius: i32) -> FxHashSet<u32> {
        self.nearby_ids(center, radius)
            .filter(|id| {
                *id != observer_id && self.entries.get(id).is_some_and(|entry| entry.subject)
            })
            .collect()
    }

    fn observers_within(&self, subject_id: u32, center: GridCoord, radius: i32) -> FxHashSet<u32> {
        self.nearby_ids(center, radius)
            .filter(|id| {
                *id != subject_id && self.entries.get(id).is_some_and(|entry| entry.observer)
            })
            .collect()
    }

    fn nearby_ids(&self, center: GridCoord, radius: i32) -> impl Iterator<Item = u32> + '_ {
        self.coords_within(center, radius)
            .flat_map(|coord| self.grids.get(&coord).into_iter().flatten().copied())
    }

    fn coords_within(&self, center: GridCoord, radius: i32) -> impl Iterator<Item = GridCoord> {
        (center.z - radius..=center.z + radius).flat_map(move |z| {
            (center.x - radius..=center.x + radius).map(move |x| GridCoord { x, z })
        })
    }

    fn is_spatially_visible(&self, pair: (u32, u32)) -> bool {
        self.pair_distance(pair)
            .is_some_and(|distance| distance <= self.enter_radius_grids)
            || self.lingering_relations.contains(&pair)
    }

    fn pair_distance(&self, pair: (u32, u32)) -> Option<i32> {
        let observer = self.entries.get(&pair.0)?;
        let subject = self.entries.get(&pair.1)?;
        if pair.0 == pair.1 || !observer.observer || !subject.subject {
            return None;
        }
        Some(chebyshev(observer.grid, subject.grid))
    }

    fn grid_of(&self, x: f32, z: f32) -> GridCoord {
        GridCoord {
            x: ((x - self.origin_x_meters) / self.grid_size_meters).floor() as i32,
            z: ((z - self.origin_z_meters) / self.grid_size_meters).floor() as i32,
        }
    }

    fn clear_unit_relations(&mut self, unit_id: u32) {
        self.lingering_relations
            .retain(|pair| pair.0 != unit_id && pair.1 != unit_id);
        self.rejected_relations
            .retain(|pair| pair.0 != unit_id && pair.1 != unit_id);
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
        assert_eq!(world.visible_subjects(2), vec![1]);
        assert!(world.set_visible(1, 2, true));
    }

    #[test]
    fn dense_enter_visibility_does_not_materialize_pair_relations() {
        let mut world = world();
        for unit_id in 1..=100 {
            world.attach(unit_id, 0.0, 0.0, true, true).unwrap();
            world.take_changes();
        }
        assert_eq!(world.candidate_relation_count(), 9_900);
        assert_eq!(world.visible_relation_count(), 9_900);
        assert!(world.lingering_relations.is_empty());
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
}
