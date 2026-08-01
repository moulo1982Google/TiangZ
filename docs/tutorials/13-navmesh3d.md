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

## 权威移动

4.2.3在查询链上增加了权威移动。客户端只提交目标与递增序号：

```ts
const result = await mapClient.navigateTo({
  targetX: 10,
  targetY: 0,
  targetZ: 10,
  sequence: ++sequence,
});
```

服务端Handler只调用`PlayerUnit.NavigateTo()`。Rust从Unit权威坐标寻路并持有路径与当前拐点，20Hz推进`x/y/z/yaw`，再通过`G2C_EntityNavigate`按AOI同步档位和Gate路由批量发送。返回路径用于发起客户端预测，不代表客户端拥有权威位置。

方向操作使用同一条权威链路。Cocos只保存WASD和右键状态：W/S映射前后，普通A/D修改`yaw`，按住右键时A/D映射横移，右键水平拖动修改朝向。状态变化立即发送`C2M_NavigateInput`，持续按住时每500ms续期；Rust把局部方向换算为短NavMesh路径，松键的零输入会清理旧路径并广播停止。点击寻路会沿路径转身，后退和横移则保留角色朝向。

尾随相机只读取客户端可视位置和朝向，不能写权威坐标、参与寻路或影响AOI。客户端可调整相机距离、平滑速度和鼠标灵敏度；这些都是表现参数，不进入服务器冷配置。

Cocos 3D通过独立`ClientMessageDispatcher` Handler消费Push：本地玩家平滑吸收预测误差，明显偏离才直接校正；远端玩家不预测输入，只在权威位置之间插值。真实双客户端冒烟会比较双方收到的同一移动状态。

当前仍需完成：

- `Raycast`、独立高度查询和动态障碍。
- 正式展示地图与导航碰撞源的制作期一致性检查。
