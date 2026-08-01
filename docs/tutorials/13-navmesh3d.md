# NavMesh3D运行时与Cocos灰盒

Phase 4.2采用“制作期烘焙、运行期只读”的NavMesh流程。你现在不需要寻找正式3D地图，也不需要在Cocos中手工点击Bake；固定灰盒已经贯通离线资源、Map Runtime、Actor RPC和Cocos 3D预览。

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

## 打开3D Demo

1. 启动服务端：

```powershell
cargo run --bin TiangZ -- configs/local/all.json
```

2. 使用Cocos Creator 3.8.8打开`cocos_client3D`，打开`assets/scene.scene`并运行浏览器预览。
3. Demo会自动登录并进入Map 100。看到绿色地面、中央障碍和蓝色玩家后，点击地面即可请求服务端Rust NavMesh路径。

浏览器预览使用WebSocket；Native构建使用KCP。状态栏会显示Map和导航版本，资源Hash不一致时拒绝进入。灰盒几何由客户端代码绘制，只负责展示；服务端仍以`navigation.bin`为权威导航资源。

服务端业务查询保持简单：

```ts
const path = unit.DomainScene()
  .GetComponent(MapComponent)
  .FindPath(start, target);
```

外部客户端通过生成的`MapClient.findPath()`调用`C2M_FindPath`。该RPC只返回普通`{x,y,z}`拐点，不修改权威位置，也不允许把Detour多边形或句柄传给TS。

## 当前边界

4.2.2已经完成启动装载、实例查询上下文、出生点投影、`ProjectPosition/FindPath`和真实传送冒烟。相同Hash的Map实例共享不可变资产，但查询对象按MapInstance隔离；路径、输入和结果均有长度与有限数校验，资产路径只能位于项目`navigation/`目录。

当前Cocos角色沿返回路径移动只是可视预览，服务端不会因此持续推进权威坐标，其他客户端也不会收到这次预览。下一步仍需完成：

- 3D权威移动意图、Rust逐Tick推进和多人位置同步。
- `Raycast`、独立高度查询和动态障碍。
- 客户端预测、插值和服务端校正。
- 正式展示地图与导航碰撞源的制作期一致性检查。
