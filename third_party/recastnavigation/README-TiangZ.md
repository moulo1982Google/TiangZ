# Recast Navigation

TiangZ 固定使用官方 Recast Navigation `v1.6.0`：

- 上游仓库：<https://github.com/recastnavigation/recastnavigation>
- 固定提交：`6dc1667f580357e8a2154c28b7867bea7e8ad3a7`
- 许可证：zlib，见同目录 `License.txt`
- 引入目录：`Recast`、`Detour`、`DetourTileCache`，以及Demo中独立的`ChunkyTriMesh`空间索引

当前构建编译 `Recast`、`Detour`、`DetourTileCache` 与 `ChunkyTriMesh`。`ChunkyTriMesh` 让离线烘焙按 Tile 查询附近三角形，避免每个 Tile 重扫全图；`DetourTileCache` 使用烘焙资源中的压缩高度层，在每个 MapInstance 内独立增删动态障碍并按预算重建受影响 Tile。

上游源码保持原样。TiangZ 的 C ABI 适配位于 `src/native/navmesh_shim.*`，不要直接修改第三方目录来承载项目逻辑。
