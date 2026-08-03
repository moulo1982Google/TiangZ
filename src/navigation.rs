//! 封装离线 Recast 烘焙与只读 Detour 查询，避免业务层持有 C++ 指针。 / Wraps offline Recast baking and read-only Detour queries without exposing C++ pointers to business code.

use std::ffi::{c_char, c_float, c_int, c_uchar, c_void};
use std::fs;
use std::path::Path;
use std::ptr::NonNull;
use std::rc::{Rc, Weak};
use std::{collections::HashMap, fmt};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const ERROR_CAPACITY: usize = 512;

#[repr(C)]
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavBuildConfig {
    pub cell_size: f32,
    pub cell_height: f32,
    pub agent_height: f32,
    pub agent_radius: f32,
    pub agent_max_climb: f32,
    pub agent_max_slope: f32,
    pub region_min_size: f32,
    pub region_merge_size: f32,
    pub edge_max_len: f32,
    pub edge_max_error: f32,
    pub detail_sample_dist: f32,
    pub detail_sample_max_error: f32,
    pub verts_per_poly: i32,
    pub tile_size: i32,
}

impl Default for NavBuildConfig {
    fn default() -> Self {
        Self {
            cell_size: 0.3,
            cell_height: 0.2,
            agent_height: 1.8,
            agent_radius: 0.4,
            agent_max_climb: 0.5,
            agent_max_slope: 45.0,
            region_min_size: 8.0,
            region_merge_size: 20.0,
            edge_max_len: 12.0,
            edge_max_error: 1.3,
            detail_sample_dist: 6.0,
            detail_sample_max_error: 1.0,
            verts_per_poly: 6,
            tile_size: 32,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavBakeManifest {
    pub map: String,
    pub source: String,
    pub output: String,
    pub metadata: String,
    pub navigation_version: String,
    #[serde(default)]
    pub build: NavBuildConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavAssetMetadata {
    pub format: String,
    pub format_version: u32,
    pub recast_version: String,
    pub map: String,
    pub navigation_version: String,
    pub navigation_hash: String,
    pub source: String,
    pub vertex_count: usize,
    pub triangle_count: usize,
    pub bounds_min: [f32; 3],
    pub bounds_max: [f32; 3],
    pub build: NavBuildConfig,
}

#[repr(C)]
struct NavBytes {
    data: *mut c_uchar,
    len: usize,
}

#[derive(Debug)]
struct ObjMesh {
    vertices: Vec<f32>,
    indices: Vec<i32>,
    bounds_min: [f32; 3],
    bounds_max: [f32; 3],
}

unsafe extern "C" {
    fn tz_navmesh_build(
        vertices: *const c_float,
        vertex_count: c_int,
        indices: *const c_int,
        triangle_count: c_int,
        config: *const NavBuildConfig,
        output: *mut NavBytes,
        error: *mut c_char,
        error_capacity: usize,
    ) -> c_int;
    fn tz_navmesh_bytes_free(bytes: NavBytes);
    fn tz_navmesh_load(
        data: *const c_uchar,
        len: usize,
        error: *mut c_char,
        error_capacity: usize,
    ) -> *mut c_void;
    fn tz_navmesh_free(mesh: *mut c_void);
    fn tz_navmesh_query_create(
        mesh: *const c_void,
        error: *mut c_char,
        error_capacity: usize,
    ) -> *mut c_void;
    fn tz_navmesh_query_free(query: *mut c_void);
    fn tz_navmesh_project(
        query: *const c_void,
        point: *const c_float,
        half_extents: *const c_float,
        projected: *mut c_float,
    ) -> c_int;
    fn tz_navmesh_find_path(
        query: *const c_void,
        start: *const c_float,
        end: *const c_float,
        half_extents: *const c_float,
        points: *mut c_float,
        max_points: c_int,
        point_count: *mut c_int,
    ) -> c_int;
    fn tz_navmesh_move_along_surface(
        query: *const c_void,
        start: *const c_float,
        end: *const c_float,
        half_extents: *const c_float,
        start_ref: u64,
        result: *mut c_float,
        result_ref: *mut u64,
    ) -> c_int;
    fn tz_navmesh_raycast(
        query: *const c_void,
        start: *const c_float,
        end: *const c_float,
        half_extents: *const c_float,
        hit_t: *mut c_float,
        hit_position: *mut c_float,
        hit_normal: *mut c_float,
    ) -> c_int;
    fn tz_navmesh_sample_height(
        query: *const c_void,
        point: *const c_float,
        half_extents: *const c_float,
        height: *mut c_float,
    ) -> c_int;
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavigationSurfaceMove {
    pub position: [f32; 3],
    pub polygon_ref: u64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavigationRaycast {
    pub hit: bool,
    pub fraction: f32,
    pub position: [f32; 3],
    pub normal: [f32; 3],
}

/// 持有可跨MapInstance共享的不可变Detour网格，不包含查询临时状态。 / Owns an immutable Detour mesh shared across MapInstances without query scratch state.
pub struct NavigationAsset {
    handle: NonNull<c_void>,
    bytes: Vec<u8>,
    hash: String,
}

impl fmt::Debug for NavigationAsset {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NavigationAsset")
            .field("bytes", &self.bytes.len())
            .field("hash", &self.hash)
            .finish_non_exhaustive()
    }
}

impl NavigationAsset {
    /// 从已校验资源创建共享资产；Hash 不匹配时在进入 C++ 前失败。 / Creates a shared asset from verified bytes and rejects hash drift before entering C++.
    pub fn load(bytes: Vec<u8>, expected_hash: Option<&str>) -> Result<Self> {
        let hash = sha256_hex(&bytes);
        if let Some(expected) = expected_hash
            && !expected.eq_ignore_ascii_case(&hash)
        {
            bail!("导航资源 Hash 不匹配: expected={expected}, actual={hash}");
        }
        let mut error = [0i8; ERROR_CAPACITY];
        // SAFETY: The byte slice and error buffer stay alive for the call; the returned handle is owned below.
        let handle = unsafe {
            tz_navmesh_load(bytes.as_ptr(), bytes.len(), error.as_mut_ptr(), error.len())
        };
        let handle = NonNull::new(handle).ok_or_else(|| anyhow!(ffi_error(&error)))?;
        Ok(Self {
            handle,
            bytes,
            hash,
        })
    }

    /// 为一个MapInstance创建独立查询上下文；资产可共享，但查询临时状态绝不共享。 / Creates one query context per MapInstance; assets are shared while query scratch state is not.
    pub fn create_world(self: &Rc<Self>) -> Result<NavigationWorld> {
        let mut error = [0i8; ERROR_CAPACITY];
        // SAFETY: The asset handle remains alive through the Rc retained by NavigationWorld.
        let query = unsafe {
            tz_navmesh_query_create(self.handle.as_ptr(), error.as_mut_ptr(), error.len())
        };
        let query = NonNull::new(query).ok_or_else(|| anyhow!(ffi_error(&error)))?;
        Ok(NavigationWorld {
            asset: Rc::clone(self),
            query,
        })
    }

    pub fn hash(&self) -> &str {
        &self.hash
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

impl Drop for NavigationAsset {
    fn drop(&mut self) {
        // SAFETY: The handle was returned by tz_navmesh_load and is freed exactly once here.
        unsafe { tz_navmesh_free(self.handle.as_ptr()) };
    }
}

/// 保存一个MapInstance独占的Detour查询上下文，并强引用其共享只读资产。 / Owns a MapInstance-specific Detour query context and strongly retains its shared immutable asset.
pub struct NavigationWorld {
    asset: Rc<NavigationAsset>,
    query: NonNull<c_void>,
}

impl fmt::Debug for NavigationWorld {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NavigationWorld")
            .field("asset_hash", &self.asset.hash())
            .finish_non_exhaustive()
    }
}

impl NavigationWorld {
    /// 将任意世界坐标投影到最近可行走面；搜索盒过小会明确返回 None。 / Projects a world point onto the nearest walkable polygon and returns None when the search box misses.
    pub fn project(&self, point: [f32; 3], half_extents: [f32; 3]) -> Option<[f32; 3]> {
        let mut projected = [0.0; 3];
        // SAFETY: All pointers reference fixed-size arrays and the native handle remains valid for self's lifetime.
        let ok = unsafe {
            tz_navmesh_project(
                self.query.as_ptr(),
                point.as_ptr(),
                half_extents.as_ptr(),
                projected.as_mut_ptr(),
            )
        };
        (ok != 0).then_some(projected)
    }

    /// 返回拐点路径而非逐帧位置；调用方应限制 max_points，避免把寻路误用成高频 getter。 / Returns path corners rather than per-frame positions; callers should bound max_points.
    pub fn find_path(
        &self,
        start: [f32; 3],
        end: [f32; 3],
        half_extents: [f32; 3],
        max_points: usize,
    ) -> Result<Vec<[f32; 3]>> {
        if max_points == 0 || max_points > i32::MAX as usize {
            bail!(
                "max_points 必须位于 1..={} / max_points is out of range",
                i32::MAX
            );
        }
        let mut flat_points = vec![0.0f32; max_points * 3];
        let mut point_count = 0;
        // SAFETY: Output storage has max_points * 3 floats and all input arrays remain alive for the call.
        let ok = unsafe {
            tz_navmesh_find_path(
                self.query.as_ptr(),
                start.as_ptr(),
                end.as_ptr(),
                half_extents.as_ptr(),
                flat_points.as_mut_ptr(),
                max_points as i32,
                &mut point_count,
            )
        };
        if ok == 0 {
            bail!("导航路径查询失败 / NavMesh path query failed");
        }
        Ok(flat_points[..point_count as usize * 3]
            .chunks_exact(3)
            .map(|point| [point[0], point[1], point[2]])
            .collect())
    }

    /// 沿可行走面推进一个短步长并返回新的Polygon引用；调用方可缓存引用，避免每Tick重复定位。 / Moves one short step along the walkable surface and returns a cacheable polygon reference.
    pub fn move_along_surface(
        &self,
        start: [f32; 3],
        end: [f32; 3],
        half_extents: [f32; 3],
        polygon_ref: u64,
    ) -> Option<NavigationSurfaceMove> {
        let mut position = start;
        let mut result_ref = 0_u64;
        // SAFETY: All arrays remain alive for the call and the query belongs to this world.
        let ok = unsafe {
            tz_navmesh_move_along_surface(
                self.query.as_ptr(),
                start.as_ptr(),
                end.as_ptr(),
                half_extents.as_ptr(),
                polygon_ref,
                position.as_mut_ptr(),
                &mut result_ref,
            )
        };
        (ok != 0).then_some(NavigationSurfaceMove {
            position,
            polygon_ref: result_ref,
        })
    }

    /// 沿NavMesh表面检测直线阻挡；未命中时position等于终点且normal为零。 / Raycasts across the NavMesh surface; a miss returns the end position and a zero normal.
    pub fn raycast(
        &self,
        start: [f32; 3],
        end: [f32; 3],
        half_extents: [f32; 3],
    ) -> Option<NavigationRaycast> {
        let mut fraction = 0.0;
        let mut position = [0.0; 3];
        let mut normal = [0.0; 3];
        // SAFETY: All arrays remain alive for the call and output buffers have exactly three floats.
        let ok = unsafe {
            tz_navmesh_raycast(
                self.query.as_ptr(),
                start.as_ptr(),
                end.as_ptr(),
                half_extents.as_ptr(),
                &mut fraction,
                position.as_mut_ptr(),
                normal.as_mut_ptr(),
            )
        };
        (ok != 0).then_some(NavigationRaycast {
            hit: fraction < 1.0,
            fraction,
            position,
            normal,
        })
    }

    /// 按输入Y选择最近可行走层并返回其地面高度。 / Samples the nearest walkable layer selected by the input Y coordinate.
    pub fn sample_height(&self, point: [f32; 3], half_extents: [f32; 3]) -> Option<f32> {
        let mut height = 0.0;
        // SAFETY: Input arrays and scalar output remain valid for the native call.
        let ok = unsafe {
            tz_navmesh_sample_height(
                self.query.as_ptr(),
                point.as_ptr(),
                half_extents.as_ptr(),
                &mut height,
            )
        };
        (ok != 0).then_some(height)
    }

    pub fn asset_hash(&self) -> &str {
        self.asset.hash()
    }
}

impl Drop for NavigationWorld {
    fn drop(&mut self) {
        // SAFETY: The query was returned by tz_navmesh_query_create and is freed exactly once here.
        unsafe { tz_navmesh_query_free(self.query.as_ptr()) };
    }
}

/// 以内容Hash共享不可变导航资产；Weak条目保证最后一个MapInstance释放后资产可自然回收。 / Shares immutable assets by content hash while weak entries allow reclamation after the last MapInstance releases them.
#[derive(Debug, Default)]
pub struct NavigationAssetCache {
    assets: HashMap<String, Weak<NavigationAsset>>,
}

impl NavigationAssetCache {
    /// 校验后复用同Hash资产；不同版本可以并存，调用方无需在地图销毁时手工卸载全局资源。 / Reuses a verified hash while allowing versions to coexist without manual global unload on map disposal.
    pub fn load(&mut self, bytes: Vec<u8>, expected_hash: &str) -> Result<Rc<NavigationAsset>> {
        let actual_hash = sha256_hex(&bytes);
        if !expected_hash.eq_ignore_ascii_case(&actual_hash) {
            bail!("导航资源 Hash 不匹配: expected={expected_hash}, actual={actual_hash}");
        }
        if let Some(asset) = self.assets.get(&actual_hash).and_then(Weak::upgrade) {
            return Ok(asset);
        }
        let asset = Rc::new(NavigationAsset::load(bytes, Some(expected_hash))?);
        self.assets.insert(actual_hash, Rc::downgrade(&asset));
        Ok(asset)
    }

    /// 清除已无MapInstance引用的目录项；它只整理索引，不主动销毁仍在使用的资产。 / Removes expired directory entries without destroying assets still referenced by MapInstances.
    pub fn prune(&mut self) {
        self.assets.retain(|_, asset| asset.strong_count() > 0);
    }

    pub fn live_assets(&self) -> usize {
        self.assets
            .values()
            .filter(|asset| asset.strong_count() > 0)
            .count()
    }
}

/// 读取 OBJ 并离线烘焙；这里只接受三角面，避免工具静默改变美术输入。 / Reads and bakes an OBJ offline, accepting triangles only to avoid silently changing authored geometry.
pub fn bake_obj(source: &Path, config: NavBuildConfig) -> Result<(Vec<u8>, NavAssetMetadataSeed)> {
    let mesh = parse_obj(source)?;
    let vertex_count = mesh.vertices.len() / 3;
    let triangle_count = mesh.indices.len() / 3;
    let mut output = NavBytes {
        data: std::ptr::null_mut(),
        len: 0,
    };
    let mut error = [0i8; ERROR_CAPACITY];
    // SAFETY: Input buffers remain alive for the call and native output is copied before being released.
    let ok = unsafe {
        tz_navmesh_build(
            mesh.vertices.as_ptr(),
            vertex_count.try_into().context("OBJ 顶点数量超过 i32")?,
            mesh.indices.as_ptr(),
            triangle_count
                .try_into()
                .context("OBJ 三角形数量超过 i32")?,
            &config,
            &mut output,
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if ok == 0 {
        bail!("{}", ffi_error(&error));
    }
    if output.data.is_null() || output.len == 0 {
        bail!("Recast 没有生成任何可行走 Tile / Recast produced no walkable tiles");
    }
    // SAFETY: Native output owns output.len initialized bytes until tz_navmesh_bytes_free is called.
    let bytes = unsafe { std::slice::from_raw_parts(output.data, output.len).to_vec() };
    // SAFETY: This is the matching release function for tz_navmesh_build output.
    unsafe { tz_navmesh_bytes_free(output) };
    Ok((
        bytes,
        NavAssetMetadataSeed {
            vertex_count,
            triangle_count,
            bounds_min: mesh.bounds_min,
            bounds_max: mesh.bounds_max,
        },
    ))
}

#[derive(Debug)]
pub struct NavAssetMetadataSeed {
    pub vertex_count: usize,
    pub triangle_count: usize,
    pub bounds_min: [f32; 3],
    pub bounds_max: [f32; 3],
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn parse_obj(path: &Path) -> Result<ObjMesh> {
    let source = fs::read_to_string(path)
        .with_context(|| format!("读取导航源文件失败 / failed to read {}", path.display()))?;
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    let mut bounds_min = [f32::INFINITY; 3];
    let mut bounds_max = [f32::NEG_INFINITY; 3];
    for (line_index, raw_line) in source.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        match parts.next() {
            Some("v") => {
                let mut vertex = [0.0f32; 3];
                for axis in &mut vertex {
                    *axis = parts
                        .next()
                        .ok_or_else(|| anyhow!("OBJ 第 {} 行顶点字段不足", line_index + 1))?
                        .parse()
                        .with_context(|| format!("OBJ 第 {} 行顶点不是 f32", line_index + 1))?;
                }
                for axis in 0..3 {
                    bounds_min[axis] = bounds_min[axis].min(vertex[axis]);
                    bounds_max[axis] = bounds_max[axis].max(vertex[axis]);
                }
                vertices.extend(vertex);
            }
            Some("f") => {
                let face = parts.collect::<Vec<_>>();
                if face.len() != 3 {
                    bail!(
                        "OBJ 第 {} 行不是三角面；请在导出时完成三角化",
                        line_index + 1
                    );
                }
                for token in face {
                    let raw_index = token
                        .split('/')
                        .next()
                        .context("OBJ 面索引为空")?
                        .parse::<i32>()
                        .with_context(|| format!("OBJ 第 {} 行面索引无效", line_index + 1))?;
                    if raw_index <= 0 {
                        bail!(
                            "OBJ 第 {} 行使用了非正索引；导航输入必须使用稳定正索引",
                            line_index + 1
                        );
                    }
                    indices.push(raw_index - 1);
                }
            }
            _ => {}
        }
    }
    let vertex_count = vertices.len() / 3;
    if vertex_count < 3 || indices.is_empty() {
        bail!("OBJ 不包含可烘焙三角形 / OBJ has no bakeable triangles");
    }
    if indices.iter().any(|index| *index as usize >= vertex_count) {
        bail!("OBJ 面索引越界 / OBJ face index is out of bounds");
    }
    Ok(ObjMesh {
        vertices,
        indices,
        bounds_min,
        bounds_max,
    })
}

fn ffi_error(error: &[c_char]) -> String {
    let bytes = error
        .iter()
        .take_while(|value| **value != 0)
        .map(|value| *value as u8)
        .collect::<Vec<_>>();
    String::from_utf8_lossy(&bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn demo_source() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("navigation/maps/demo_3d/source/map_nav.obj")
    }

    #[test]
    fn graybox_bake_is_deterministic_and_queryable() {
        let (first, _) = bake_obj(&demo_source(), NavBuildConfig::default()).unwrap();
        let (second, _) = bake_obj(&demo_source(), NavBuildConfig::default()).unwrap();
        assert_eq!(first, second);

        let asset = Rc::new(NavigationAsset::load(first, None).unwrap());
        let world = asset.create_world().unwrap();
        let projected = world.project([0.0, 1.0, -10.0], [2.0, 4.0, 2.0]).unwrap();
        assert!(
            projected[1].abs() <= 0.25,
            "projection should stay within one cell-height of the floor: {projected:?}"
        );

        let path = world
            .find_path([-10.0, 0.0, 0.0], [10.0, 0.0, 0.0], [2.0, 4.0, 2.0], 32)
            .unwrap();
        assert!(
            path.len() >= 3,
            "path should route around the center obstacle: {path:?}"
        );
        assert!(
            path.iter().any(|point| point[2].abs() > 5.0),
            "path should leave the obstacle's Z range: {path:?}"
        );

        let moved = world
            .move_along_surface([-12.0, 0.0, -12.0], [-11.0, 0.0, -12.0], [2.0, 4.0, 2.0], 0)
            .unwrap();
        assert!(moved.position[0] > -12.0);
        assert_ne!(moved.polygon_ref, 0);
        let continued = world
            .move_along_surface(
                moved.position,
                [-10.0, 0.0, -12.0],
                [2.0, 4.0, 2.0],
                moved.polygon_ref,
            )
            .unwrap();
        assert!(continued.position[0] > moved.position[0]);

        let raycast = world
            .raycast([-10.0, 0.0, 0.0], [10.0, 0.0, 0.0], [2.0, 4.0, 2.0])
            .unwrap();
        assert!(raycast.hit);
        assert!(raycast.fraction < 1.0);
        let height = world
            .sample_height([-12.0, 1.0, -12.0], [2.0, 4.0, 2.0])
            .unwrap();
        assert!(height.abs() <= 0.25);

        let mut wall_position = [-10.0, 0.0, 0.0];
        let mut wall_ref = 0;
        for _ in 0..80 {
            let moved = world
                .move_along_surface(
                    wall_position,
                    [wall_position[0] + 0.2, wall_position[1], wall_position[2]],
                    [2.0, 4.0, 2.0],
                    wall_ref,
                )
                .unwrap();
            wall_position = moved.position;
            wall_ref = moved.polygon_ref;
        }
        assert!(
            wall_position[0] < -3.0,
            "movement crossed the obstacle: {wall_position:?}"
        );
        let slide = world
            .move_along_surface(
                wall_position,
                [wall_position[0], wall_position[1], wall_position[2] + 0.5],
                [2.0, 4.0, 2.0],
                wall_ref,
            )
            .unwrap();
        assert!(slide.position[2] > wall_position[2]);
    }

    #[test]
    fn hash_mismatch_is_rejected_before_native_load() {
        let (bytes, _) = bake_obj(&demo_source(), NavBuildConfig::default()).unwrap();
        let error = NavigationAsset::load(bytes, Some(&"0".repeat(64)))
            .expect_err("hash mismatch should fail");
        assert!(error.to_string().contains("Hash 不匹配"));
    }

    #[test]
    fn cache_shares_assets_and_releases_them_after_last_instance() {
        let (bytes, _) = bake_obj(&demo_source(), NavBuildConfig::default()).unwrap();
        let hash = sha256_hex(&bytes);
        let mut cache = NavigationAssetCache::default();
        let first = cache.load(bytes.clone(), &hash).unwrap();
        let second = cache.load(bytes, &hash).unwrap();
        assert!(Rc::ptr_eq(&first, &second));
        let first_world = first.create_world().unwrap();
        let second_world = second.create_world().unwrap();
        assert_ne!(first_world.query, second_world.query);
        assert_eq!(cache.live_assets(), 1);
        drop(first_world);
        drop(second_world);
        drop(first);
        drop(second);
        cache.prune();
        assert_eq!(cache.live_assets(), 0);
    }
}
