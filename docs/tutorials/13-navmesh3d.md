# NavMesh3D运行时与Cocos灰盒

Phase 4.2采用“制作期烘焙、运行期只读”的NavMesh流程。你现在不需要寻找正式3D地图，也不需要在Cocos中手工点击Bake；固定灰盒已经贯通离线资源、Map Runtime、Actor RPC和Cocos 3D预览。

## 一键烘焙

```powershell
cd E:\gitee\TiangZ
npm run navigation:bake
```

命令依次执行：

1. `tools/navigation/generate_graybox.mjs`确定性生成`source/map_nav.obj`。
2. Rust `navmesh_bake`读取`bake.json`，调用官方Recast生成TileCache所需的压缩高度层。
3. Detour立即回读结果并在原点附近执行一次投影，损坏资源不会落盘。
4. 输出`generated/navigation.bin`与`generated/navigation.meta.json`。

完整专项验证：

```powershell
npm run test:navigation
```

测试会检查重复烘焙字节一致、Hash错误被拒绝、坐标可投影、路径能绕过中央障碍、动态障碍增删与MapInstance隔离，以及相同Hash只创建一个共享模板。

## 目录职责

```text
navigation/maps/demo_3d/
  bake.json                    不可热更的烘焙参数与版本
  source/map_nav.obj           导航碰撞源，不是展示模型
  generated/navigation.bin     v2压缩高度层模板，不可热更
  generated/navigation.meta.json

third_party/recastnavigation/  固定的官方上游源码
src/native/navmesh_shim.*      TiangZ C ABI，不写业务规则
src/navigation.rs              Rust安全加载、实例TileCache、查询和障碍队列
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
cargo run --bin TiangZ -- configs/local/all-in-one.json
```

2. 使用Cocos Creator 3.8.8打开`cocos_client3D`，打开`assets/scene.scene`并运行浏览器预览。
3. Demo会自动登录并进入Map 100。看到绿色地面、中央障碍和蓝色玩家后，点击地面请求服务端路径；按`E`关闭红色动态门，再点击门后方可以观察绕行，再按`E`开门后恢复直线路径。

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

方向操作使用同一条权威链路。Cocos只保存WASD和右键状态：W/S映射前后，普通A/D修改`yaw`，按住右键时A/D映射横移，右键水平拖动修改朝向。状态变化立即发送`C2M_NavigateInput`，持续按住时每500ms续期；Rust不为方向输入重复寻路，而是在每个固定Tick用`moveAlongSurface`贴着NavMesh推进并缓存当前polygon引用。输入租约为1.5秒，客户端卡死或停止续期时Rust会自动广播停止；正常松键仍立即发送零输入。点击寻路在路径拐点先按固定角速度转身，再使用当前Tick的剩余时间前进，客户端预测使用同一规则；后退和横移则保留角色朝向。

尾随相机只读取客户端可视位置和朝向，不能写权威坐标、参与寻路或影响AOI。客户端分别保存权威`authoritativeYaw`、可视角色`playerYaw`和本地观察`cameraYaw`：权威Push始终更新`authoritativeYaw`，点击路径预测期间只允许预测推进`playerYaw`，预测结束后才平滑收敛权威朝向，避免路径拐点被稍旧Push反复拉回；键盘转身和右键拖动同步修改角色与相机朝向，点击路径转向时相机沿最短圆弧限速追随。摄像机位置必须每帧由`cameraYaw`和距离直接计算，不能在两侧目标位置之间做XYZ插值，否则可能穿过角色并翻到正面。客户端可调整相机距离、跟随速度和鼠标灵敏度；这些都是表现参数，不进入服务器冷配置。

`MapComponent.Raycast(start, end)`检测NavMesh边界阻挡，返回命中比例、位置和法线；它不检测角色、怪物或物理碰撞体。`MapComponent.SampleHeight(point)`按输入Y选择最近可行走层并返回高度，多层地图不能只传X/Z。两者都是同步粗粒度查询，不允许在TS逐polygon调用。

## 动态障碍

门、升降桥和临时路障使用地图内稳定`ObstacleId`，业务只描述最终盒体：

```ts
const map = unit.DomainScene().GetComponent(MapComponent);

map.UpsertNavigationBoxObstacle(doorId, {
  center: { x: -12, y: 1.5, z: 0 },
  halfExtents: { x: 4, y: 1.5, z: 1 },
  yawRadians: 0,
});

map.RemoveNavigationObstacle(doorId);
```

相同ID和几何重复提交返回`false`，不会重复排队。TS不能保存Detour障碍引用，也不能为了等待完成而在Handler循环调用Native；`MapComponent.Update`每Tick最多处理16条目标状态并重建4个Tile。完成后Rust递增障碍版本，正在执行的点击路径从权威位置到原终点自动重算。方向输入没有旧走廊，每Tick直接在最新表面推进。

`halfExtents`描述门或路障的真实物理半尺寸，不包含角色半径。Rust会读取该地图导航资源的`agentRadius`，在送入TileCache前自动扩大盒体的X/Z占用，Y高度保持原值。业务如果再次手工扩大，就会产生双重安全距离。当前一个MapInstance只使用一种烘焙Agent规格；未来若同时支持体型差异很大的角色，应建立独立导航规格，而不是临时改障碍尺寸。

障碍状态属于具体`MapInstanceId`。两个副本即使使用同一`navigationHash`，其中一个关门也不会影响另一个；地图销毁通过`SpatialRelease`同时释放TileCache和全部障碍。障碍几何、开关权限、`ObstacleId`分配和向客户端广播门表现都属于业务层，框架只提供空间能力。客户端进图时应从`MapSnapshotReady`获取当前门状态，之后消费地图广播的状态事件，不能只处理自己发起开关请求的响应。当前Cocos灰盒的`C2M_ToggleDemoDoor`只是演示协议，不应直接作为正式门系统。

Cocos 3D通过独立`ClientMessageDispatcher` Handler消费Push：本地玩家平滑吸收预测误差，明显偏离才直接校正；确认门已关闭后，本地方向预测也会按角色可视半宽约束在门外，减少服务端校正到达前的短暂穿模。这只是表现保护，Rust仍是唯一碰撞与位置权威。远端玩家和UE客户端不预测输入，只在权威位置之间插值，不需要再建立一套客户端权威碰撞。真实双客户端冒烟会比较双方收到的同一移动状态。

“关门时角色正站在门内”属于业务规则：可以拒绝关门、延迟关门或先把角色移动到安全点。TileCache只负责提交后的可行走面，不替业务决定该策略。

当前仍需完成正式展示地图与导航碰撞源的制作期一致性检查；角色碰撞、动态避让和Crowd不属于TileCache静态阻挡，后续单独设计。
