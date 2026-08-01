# Recast Navigation

TiangZ 固定使用官方 Recast Navigation `v1.6.0`：

- 上游仓库：<https://github.com/recastnavigation/recastnavigation>
- 固定提交：`6dc1667f580357e8a2154c28b7867bea7e8ad3a7`
- 许可证：zlib，见同目录 `License.txt`
- 引入目录：`Recast`、`Detour`、`DetourTileCache`，以及Demo中独立的`ChunkyTriMesh`空间索引

当前构建编译 `Recast`、`Detour`与`ChunkyTriMesh`。后者让离线烘焙按Tile查询附近三角形，避免每个Tile重扫全图；`DetourTileCache`保留给后续动态障碍物阶段，不参与首版静态导航网格运行时。

上游源码保持原样。TiangZ 的 C ABI 适配位于 `src/native/navmesh_shim.*`，不要直接修改第三方目录来承载项目逻辑。
