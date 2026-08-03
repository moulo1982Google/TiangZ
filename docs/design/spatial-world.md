# 地图空间与3D坐标契约

本文冻结TiangZ从`0.4.0`开始使用的地图空间语义。它约束Rust权威数据、协议、游戏配置和客户端适配；Rust AOI已完成Phase 4.1，NavMesh3D资产、权威移动、射线、高度查询和动态障碍已完成Phase 4.2.5。

## 世界坐标

服务端统一采用三维米制局部坐标：

```text
X/Z：地面平面
Y：高度
Yaw：绕Y轴旋转，单位为弧度，规范化到[-PI, PI)；Yaw=0朝+Z，前向量=(sin(Yaw), 0, cos(Yaw))
位置单位：米
```

坐标始终属于一个`MapInstanceId`。不同大陆、静态地图和动态副本不共享巨大的全局浮点坐标；跨地图传送同时改变`MapInstanceId`和地图局部坐标。Rust与protobuf使用`f32/float`保存`x/y/z/yaw`，不依赖Cocos、Unity或其他引擎类型。

当前Grid2D移动使用X/Z Cell。`cellX/cellZ`和`inputX/inputZ`是服务器地面轴；世界高度Y不参与二维Cell移动。现有Cocos 2D和Pixi把服务器X/Z映射为屏幕X/Y，服务器Y保持为零。客户端SDK只生成普通数值结构，Cocos在边界转换为`Vec3`，Unity在边界转换为`Vector3`或`float3`。Cocos 3D当前与TiangZ同为Y-Up和X/Z地面，Yaw数值可以直接转换成角度显示，但本地预测、相机与远端表现变量仍必须遵守TiangZ的零方向和前向量公式。UE使用Z-Up且原生Yaw=0朝+X，因此表现边界固定执行`UE(X,Y,Z)=TiangZ(X,Z,Y)×100`和`UEYawDegrees=90-RadiansToDegrees(TiangZYaw)`；UE输入状态仍必须保存并上报TiangZ Yaw，禁止把`FRotator::Yaw`直接写入协议。

## 地图空间模式

Luban `MapConfig`使用`SpatialMode`选择空间实现：

| 模式 | 当前状态 | 含义 |
| --- | --- | --- |
| `Grid2D` | 可运行 | X/Z规则网格，米制Cell，服务端Rust权威移动 |
| `NavMesh3D` | Map 100运行时已启用 | tiled NavMesh、投影、寻路、连续权威移动、射线、高度和动态障碍 |

`MapConfig`还包含出生点`spawnX/Y/Z/Yaw`、地图宽深Cell数`widthCells/depthCells`、米制`cellSizeMeters`、`aoiConfigId`以及`navigationAsset/version/hash`。`Cell`是可配置的最小空间单位：Grid2D按Cell离散移动，NavMesh3D允许在Cell内连续移动。`AoiConfig.gridSizeCells`声明一个AOI Grid包含多少个Cell；AOI Grid与NavMesh tile不是同一个概念。地图物理边界由地图制作与导航资源决定，配置记录其导出结果，不允许独立填写一份可能冲突的Grid数量。`NavMesh3D`配置缺少资源、版本或小写SHA-256时必须拒绝加载，路径越出`navigation/`目录或Hash不符也必须拒绝，不能退化为Grid2D。

空间配置使用以下唯一换算关系：

```text
地图宽度(米) = widthCells × cellSizeMeters
AOI Grid边长(米) = gridSizeCells × cellSizeMeters
Grid数量X/Z = widthCells/depthCells ÷ gridSizeCells
```

因此Cell边长、每Grid的Cell数都可以按地图类型配置，Grid数量由地图尺寸自然推导。Grid2D当前要求宽深Cell数能被`gridSizeCells`整除，不自动生成不完整的边缘Grid。Phase 4.2的NavMesh导出工具也必须输出地图局部边界并按同一规则对齐或显式补边，不能让运行时猜测美术场景尺寸。

表结构属于不可热更Model。`MapConfig`、`AoiConfig`和`AoiSyncTierConfig`整表属于Cold配置：空间模式、Cell尺寸、AOI Grid尺寸、可见范围、同步频率或导航资源发生任何数据变化，都必须完整构建并重启Process，运行中的MapInstance绝不接受这些候选。

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

多个静态实例或动态副本共享同一份只读压缩高度层模板，但每个MapInstance独立构建`dtNavMesh + dtTileCache + Query`，并拥有独立AOI、动态障碍和Unit状态。MapScene创建时建立实例私有空间状态，销毁时通过`SpatialRelease`幂等释放；该释放不得卸载仍被其他实例引用的共享导航模板。

`Grid2D`由`SpatialCreateGrid2D`创建Rust边界和米制Cell信息；`NavMesh3D`由`SpatialCreateNavMesh3D`创建实例TileCache和查询上下文。`NavigationAssetCache`按内容Hash共享只读高度层模板并使用Weak目录回收；`SpatialRelease`释放实例NavMesh、TileCache、障碍、查询对象，并清理无持有者的弱缓存。

导航网格只能离线烘焙。`navigation/maps/<map>/bake.json`是不可热更的制作输入，`npm run navigation:bake`生成`navigation.bin`和带版本、Hash、边界、Agent参数的元数据。服务端启动时只加载和校验结果，绝不在运行期扫描美术场景或调用Recast烘焙。官方Recast/Detour固定为`v1.6.0`，C++源码保持上游原样，TiangZ适配只放在`src/native/navmesh_shim.*`与Rust安全封装中。

## TS与Rust边界

TS负责地图规则、AI意图、技能、任务、传送和副本流程。Rust负责高频且权威的空间工作：坐标、移动推进、NavMesh查询、AOI索引和批量快照。`FindPath`是无副作用路径查询；`NavigateTo`提交世界目标并持有路径走廊；`NavigateInput`提交相对`yaw`的前后/横移状态，Rust每Tick通过`moveAlongSurface`推进并缓存polygon引用，零输入明确停止。`Raycast`只查询NavMesh边界，`SampleHeight`按Y选择可行走层。`G2C_EntityNavigate`是可覆盖权威状态。禁止在每个Tick逐顶点或逐路径节点跨越V8边界。

动态障碍使用地图内稳定`ObstacleId: u32`。TS调用`MapComponent.UpsertNavigationBoxObstacle(id, box)`或`RemoveNavigationObstacle(id)`描述最终状态；相同ID和几何保持幂等，业务不能持有`dtObstacleRef`。业务提交的是障碍真实物理盒体，Rust TileCache会按该导航资源烘焙时的`agentRadius`自动扩大X/Z占用范围，保证角色中心可行走时其体积也不会穿入障碍；业务不得手工重复增加半径。Rust每Tick最多提交16条障碍命令并重建4个受影响Tile，完成后递增障碍版本，所有尚未完成的点击路径从权威当前位置到原目标自动重算。方向输入每Tick直接使用最新NavMesh表面。障碍属于MapInstance，模板相同的两个副本互不影响，地图销毁后全部释放。

Rust不得回调TS读取权威空间数据。地图业务仍使用`MapScene + Component`，Rust空间层是Scene之下的原生能力，不取代Scene或把全部地图业务下沉。

## Rust AOI

AOI的完整分层、数据结构、生命周期和函数调用图见[AOI完整设计与函数调用关系](aoi-architecture.md)。本节只保留空间契约层面的约束。

每个`MapInstanceId`拥有独立的Rust `AoiWorld`。有限地图按配置边界预建扁平连续AOI Grid，X/Z坐标直接计算数组下标，不经过坐标Hash；玩家同时是Observer和Subject，后续怪物/NPC可只作为Subject。自身权威状态始终发送给自己的客户端，但自身不产生Enter/Leave关系。超过四百万个AOI Grid的地图会被拒绝；极大或无边界世界以后应使用分块稀疏Grid，不能让普通地图路径承担两套索引。

可见性与同步频率是两套独立配置：

- `enterRangeGrids`：从不可见变为可见的范围，进入时发送全量Snapshot。
- `detachRangeGrids`：已经可见后允许保持关系的迟滞范围；越界才发送Leave，避免边界抖动。
- `AoiSyncTierConfig.rangeGrids/syncHz`：已可见关系中，可覆盖状态的最大发送频率。同步范围不能超过Detach，且最外层必须恰好覆盖Detach范围。

范围字段填写奇数边长，例如Enter `3`代表3×3 AOI Grid，Detach `5`代表5×5。当前Demo每个Cell为1米、一个AOI Grid为15×15 Cell、默认地图为150×150 Cell即10×10 AOI Grid；3×3内Movement最高20Hz，已可见关系移入5×5外圈后降为5Hz，越过5×5立即Leave。5×5不会让一个从未Enter的单位提前创建视野。低频档按Subject所在Grid稳定错峰，避免所有远距单位在同一个Tick形成周期尖峰；同一Grid仍共享编码帧。当前不再配置7×7可见范围和1Hz档位。

AOI Grid从每张地图的最小Cell开始编号，不从世界坐标0开始切分。地图宽高必须是`gridSizeCells`的整数倍；因此150、225、300 Cell会严格形成10×10、15×15、20×20 Grid，奇数个Grid的地图不会在零点两侧多切出一列。AOI关系只在实体跨越Grid边界时重算；Grid2D每步移动一个Cell，NavMesh3D可以在同一Cell内连续移动。

`NativeUnitRef.x/z`通过FastOP修改时只标记空间脏；帧内可多次写入，帧末只在跨AOI Grid时重算邻域。每个Grid使用连续`EntityIndex`数组，实体保存`slotInGrid`，跨Grid通过`swap-remove + push`完成O(1)成员迁移并修复被交换实体的槽位。`UnitId -> EntityIndex`哈希只用于API入口定位；实体元数据和Audience签名按可复用`EntityIndex`连续存放，候选遍历、关系差分和受众生成不得逐候选回查UnitId哈希。空间候选关系和业务过滤后的最终可见关系各保存一组Observer→Subject、Subject→Observer双向稠密位图，另用一张单向位图记录迟滞关系，因此关系差分、正反向受众查询和指标计数不再扫描Hash集合或全量关系。EntityIndex释放时必须同时清除全部位图的行列，防止新实体继承旧关系。

这是一项有意的“内存换吞吐”设计：位图使用单块连续`u64`矩阵并按512个实体分段扩容，避免每个Observer一块小Vec。3000个实体会预留到3072，五张矩阵约5.6 MiB；它适合单Scene数千活跃实体。Grid成员默认仍是稀疏连续数组；单Grid达到128个实体时额外建立固定容量成员位图，用位或合并重叠的Detach/Enter候选，降到96以下释放，避免阈值抖动。Release微基准显示64人/Grid时位图仍慢约20%，128人起反超，256/512人时耗时约为数组方案的65%/53%，因此阈值不是业务配置。受16384实体上限约束，热点位图同时存在的数量自然有界。当前稠密实现硬限制每MapInstance 16384个AOI实体，此时五张关系矩阵约160 MiB，超过限制会明确拒绝Attach。十万级Scene不能照搬完整位图，应改用分块稀疏位图或空间分片。当前不按Tick重建CSR Grid，因为AOI只在跨Grid时变更，80%的Grid内移动无需更新成员表。TS不保存镜像关系表。高频Movement仍在Rust编码protobuf并按同步档位节流；开始、停止和转向等`stateChanged`记录强制立即发送。Numeric和UnitState仍由各自脏数据策略决定发送时机，AOI只负责最终受众。默认关系按Subject所在Grid聚合相同受众，迟滞或业务过滤例外才计算精确受众。

Rust输出的多个Audience batch不会逐条穿过Map到Gate的内部Transport。`BroadcastHub.SendMany`把同一逻辑作业整体提交，`SceneBroadcastTransport`再以当前同步Game Tick为聚合边界，将同Tick产生的Movement、Numeric和UnitState批次按Gate重组为一条`S2G_ClientBroadcastBatch`。批量项保持各自接收者列表和最终客户端frame，Gate不解码或重新编码业务payload。该优化只减少内部消息和Promise调度，不改变AOI可见关系、状态节流、dirty Ack或客户端消息边界。

跨AOI Grid产生的进入/离开是不可覆盖生命周期事件，不能使用latest丢弃中间结果。Rust先把同帧关系抖动折叠为最终变化；TS按Subject收集变化并取得进入Snapshot，再把受众完全相同的多个Subject合并为一个`G2C_AoiDelta`。客户端按消息中的`enters`创建或刷新实体，再按`leaves`移除实体。旧单实体`G2C_EntityEnter/Leave`暂时保留协议兼容，但Runtime不再逐关系发送。

批量登录、切线回城或副本结束可能在极短时间内向同一MapInstance制造大量Attach。每个MapInstance因此拥有独立的入图等待队列，`MapConfig.entryPlayersPerTick`限制每个逻辑Tick真正完成AOI Attach的人数，`entryQueueCapacity`限制等待上限。玩家连接和登录已经完成，只在Loading中等待进入响应；这不是区服满载时的全局登录排队，也不负责决定地图人数上限。首次进入和地图传送都受该队列控制，原Unit仍存在的断线重连不重复Attach，直接恢复全量快照。两个参数属于Cold配置，修改后必须重启Map Process。Admission相关的首次进图、源Unit传送和跨MapHost目标提交使用独立10分钟RPC故障上限，以覆盖默认队列的最坏排空预算；普通Scene RPC仍保持短超时，运维容量判断仍应以队列深度和Loading时延为准。

阵营、隐身和位面属于业务规则，由同步`IAoiVisibilityFilter.CanObserve(observer, subject)`实现。过滤器只在候选关系变化或显式失效时执行，不逐帧执行；禁止Promise、RPC、数据库、发消息和修改Entity，异常按不可见处理并记录日志。业务字段改变后必须调用`InvalidateObserver`、`InvalidateSubject`或`Invalidate`，框架不会猜测任意业务字段的含义。

生命周期顺序固定为：完整Unit组件图和Location提交完成后Attach；进入响应返回自身加最终可见Subject；退出或传送时先Detach并生成Leave，再销毁Native Unit。Rust会拒绝销毁仍挂在AOI中的Unit。

## 客户端进入契约

`G2C_EnterMap`携带：

- `mapId`和`mapInstanceId`；
- `x/y/z`权威出生位置；
- `spatialMode`；
- `navigationVersion/navigationHash`；
- `fixedUpdateMs`。

客户端必须先比较本地`MapConfig`与响应中的空间模式和导航版本，再允许玩家移动。Cocos 2D和Pixi只接受`Grid2D`；Cocos 3D把普通SDK坐标转换为`Vec3`，通过`MapClient.navigateTo()`提交目标并使用返回路径预测，通过`G2C_EntityNavigate`纠偏和插值远端玩家。客户端不得把预测位置写成第二份服务端权威数据。

## 协议兼容性

本契约是`0.4.0`的显式破坏性升级：旧二维协议字段`y/cellY/inputY`迁移为地面轴`z/cellZ/inputZ`，并新增高度`y`与`yaw`。旧`0.3.10`客户端不得连接`0.4.x`服务端。普通协议演进仍只能增量更新schema lock；只有明确的破坏性版本发布才允许使用`npm run codegen:proto:replace-schema-lock`，并必须同步版本、迁移说明和全部客户端SDK。

## 验收

Phase 4.0要求：

1. Native Unit和protobuf都使用`x/y/z/yaw`。
2. Grid2D只使用X/Z Cell，Rust使用米制位置。
3. MapConfig能表达Grid2D/NavMesh3D并校验导航资源身份。
4. MapScene销毁释放实例空间状态。
5. Cocos 2D、Pixi、协议、Native移动、地图传送与Runtime smoke全部回归通过。
