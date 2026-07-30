# 地图空间与3D坐标契约

本文冻结TiangZ从`0.4.0`开始使用的地图空间语义。它约束Rust权威数据、协议、游戏配置和客户端适配；NavMesh与Rust AOI尚未在本版本实现，但后续实现不得改变本契约。

## 世界坐标

服务端统一采用三维米制局部坐标：

```text
X/Z：地面平面
Y：高度
Yaw：绕Y轴旋转，单位为弧度，规范化到[-PI, PI)
位置单位：米
```

坐标始终属于一个`MapInstanceId`。不同大陆、静态地图和动态副本不共享巨大的全局浮点坐标；跨地图传送同时改变`MapInstanceId`和地图局部坐标。Rust与protobuf使用`f32/float`保存`x/y/z/yaw`，不依赖Cocos、Unity或其他引擎类型。

当前Grid2D移动使用X/Z Cell。`cellX/cellZ`和`inputX/inputZ`是服务器地面轴；世界高度Y不参与二维Cell移动。现有Cocos 2D和Pixi把服务器X/Z映射为屏幕X/Y，服务器Y保持为零。客户端SDK只生成普通数值结构，Cocos在边界转换为`Vec3`，Unity在边界转换为`Vector3`或`float3`。

## 地图空间模式

Luban `MapConfig`使用`SpatialMode`选择空间实现：

| 模式 | 当前状态 | 含义 |
| --- | --- | --- |
| `Grid2D` | 可运行 | X/Z规则网格，米制Cell，服务端Rust权威移动 |
| `NavMesh3D` | 契约已冻结、运行时待Phase 4.3实现 | tiled NavMesh、位置投影、寻路、射线和高度查询 |

`MapConfig`还包含出生点`spawnX/Y/Z/Yaw`、`aoiCellSizeMeters`以及`navigationAsset/version/hash`。`NavMesh3D`配置缺少资源、版本或小写SHA-256时必须拒绝加载；当前Runtime遇到合法NavMesh3D配置也会明确报出导航运行时尚未安装，不能退化为Grid2D。

表结构与空间模式属于不可热更Model；只修改现有字段值仍遵循游戏配置候选的原子切换规则。正在运行的地图不会因配置热更重建空间实现，改变空间模式、Cell尺寸或导航资源应重启对应Process并重新创建MapInstance。

## Rust所有权与生命周期

不可变导航资产按`MapConfigId + navigationVersion/hash`加载并共享：

```text
MapConfigId
  -> Shared NavigationAsset

MapInstanceId
  -> NavigationWorld查询上下文
  -> AoiWorld
  -> DynamicObstacles
  -> Unit空间状态
```

多个静态实例或动态副本可以共享同一份只读NavMesh，但每个MapInstance拥有独立AOI、动态障碍和Unit状态。MapScene创建时建立实例私有空间状态，销毁时通过`SpatialRelease`幂等释放；该释放不得卸载仍被其他实例引用的共享导航资产。

当前`Grid2D`由`SpatialCreateGrid2D`创建Rust边界和米制Cell信息。Phase 4.3将增加NavMesh3D创建入口，不复用或伪装Grid2D数据。

## TS与Rust边界

TS负责地图规则、AI意图、技能、任务、传送和副本流程。Rust负责高频且权威的空间工作：坐标、移动推进、NavMesh查询、AOI索引和批量快照。推荐使用`ProjectPosition`、`FindPath`、`SetMoveIntent`、`StopMovement`和`Raycast`等粗粒度调用；禁止在每个Tick逐顶点或逐路径节点跨越V8边界。

Rust不得回调TS读取权威空间数据。地图业务仍使用`MapScene + Component`，Rust空间层是Scene之下的原生能力，不取代Scene或把全部地图业务下沉。

## 客户端进入契约

`G2C_EnterMap`携带：

- `mapId`和`mapInstanceId`；
- `x/y/z`权威出生位置；
- `spatialMode`；
- `navigationVersion/navigationHash`；
- `fixedUpdateMs`。

客户端必须先比较本地`MapConfig`与响应中的空间模式和导航版本，再允许玩家移动。Cocos 2D和Pixi只接受`Grid2D`；未来Cocos 3D负责加载匹配的导航资源并把普通SDK坐标转换为引擎`Vec3`。

## 协议兼容性

本契约是`0.4.0`的显式破坏性升级：旧二维协议字段`y/cellY/inputY`迁移为地面轴`z/cellZ/inputZ`，并新增高度`y`与`yaw`。旧`0.3.10`客户端不得连接`0.4.x`服务端。普通协议演进仍只能增量更新schema lock；只有明确的破坏性版本发布才允许使用`npm run codegen:proto:replace-schema-lock`，并必须同步版本、迁移说明和全部客户端SDK。

## 验收

Phase 4.0要求：

1. Native Unit和protobuf都使用`x/y/z/yaw`。
2. Grid2D只使用X/Z Cell，Rust使用米制位置。
3. MapConfig能表达Grid2D/NavMesh3D并校验导航资源身份。
4. MapScene销毁释放实例空间状态。
5. Cocos 2D、Pixi、协议、Native移动、地图传送与Runtime smoke全部回归通过。
