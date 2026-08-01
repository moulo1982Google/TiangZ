# NavMesh3D离线资源与Rust查询

Phase 4.2采用“制作期烘焙、运行期只读”的NavMesh流程。你现在不需要寻找正式3D地图，也不需要在Cocos中手工点击Bake；4.2.1先用固定灰盒把资源格式、跨平台构建、Hash和Rust查询链路钉死。

## 一键烘焙

```powershell
cd E:\gitee\TiangZ
npm run navigation:bake
```

命令依次执行：

1. `tools/navigation/generate_graybox.mjs`确定性生成`source/map_nav.obj`。
2. Rust `navmesh_bake`读取`bake.json`，调用官方Recast生成tiled NavMesh。
3. Detour立即回读结果并在原点附近执行一次投影，损坏资源不会落盘。
4. 输出`generated/navigation.bin`与`generated/navigation.meta.json`。

完整专项验证：

```powershell
npm run test:navigation
```

测试会检查重复烘焙字节一致、Hash错误被拒绝、坐标可投影、路径能绕过中央障碍，以及相同Hash只创建一个共享资产。

## 目录职责

```text
navigation/maps/demo_3d/
  bake.json                    不可热更的烘焙参数与版本
  source/map_nav.obj           导航碰撞源，不是展示模型
  generated/navigation.bin     服务端与未来客户端使用的只读资源
  generated/navigation.meta.json

third_party/recastnavigation/  固定的官方上游源码
src/native/navmesh_shim.*      TiangZ C ABI，不写业务规则
src/navigation.rs              Rust安全加载、Hash、投影、寻路和共享缓存
```

不要修改`third_party/recastnavigation`实现业务；升级上游必须作为单独变更，重新烘焙全部资源并跑Windows/Linux兼容矩阵。

## 真实地图以后怎样接入

Phase 4.3接入真实Cocos 3D地图时，制作流程应从同一场景导出两份用途不同的资产：

- 展示模型：材质、贴图、动画和视觉细节，由Cocos加载。
- 导航碰撞源：只保留地面、坡道、楼梯和阻挡体，三角化后交给离线烘焙工具。

两者共享地图局部米制X/Y/Z坐标，但服务端不读取展示模型。地图边界、Cell/AOI Grid划分与导航元数据必须一致，工具会逐步增加自动校验，而不是让运行时猜测。

## 当前边界

4.2.1只完成离线资源与Rust查询内核。当前`MapComponent`仍会拒绝`SpatialMode.NavMesh3D`，这是刻意的阶段边界，不允许偷偷回退到Grid2D。下一步将完成：

- 按`MapConfig.navigationAsset/version/hash`启动时加载并共享资源。
- 每个MapInstance创建独立查询上下文、AOI和动态障碍状态。
- 向TS暴露粗粒度`ProjectPosition`、`FindPath`、`Raycast`和高度查询。
- 增加动态障碍，再接Cocos 3D点击寻路与服务端校正。
