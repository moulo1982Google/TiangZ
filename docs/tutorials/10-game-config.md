# Luban游戏配置

> 当前在线配置更新已与完整 Hotfix 合并为一个帧间事务：`build:game-config` 等价于 `build:hotfix`，使用输出的 `hotfix-candidates/<releaseId>` 调用 `reload`。`reload-config` 只接受同样的联合候选；下文历史纯配置候选在线操作已被取代。结构/冷配置变化仍重启，`build:game-config:startup` 现在执行完整构建。详见 [联合热更](../design/typescript-hot-reload.md#hotfix-与配置的联合发布2026-09-17)。

TiangZ把配置分成两类：

- `configs/<environment>/`描述机器、Process、Scene、端口和Runtime参数，面向部署。
- `game_config/`描述道具、地图和玩家模板等策划数值，面向游戏内容。

不要把游戏数值塞进启动JSON，也不要让业务代码直接读取Excel或零散JSON。

## 第一批配置

| 表 | 用途 | 当前关键字段 |
| --- | --- | --- |
| `ItemConfig.xlsx` | 道具静态定义 | 名称、客户端描述、最大堆叠、使用效果与Action参数 |
| `MapConfig.xlsx` | 地图静态定义 | 空间模式、米制尺寸、三维出生点、AOI引用、入图节流、导航资源身份 |
| `PlayerConfig.xlsx` | 玩家初始模板 | 初始地图、初始/最大HP、移动速度、初始道具 |
| `MonsterConfig/MonsterAreaConfig.xlsx` | 怪物模板与固定刷怪槽 | 数值、行为、重生时间、地图位置 |
| `BuffConfig.xlsx` | Buff生命周期 | 冲突/刷新、持续时间与Add/Tick/Remove Action |
| `SkillConfig.xlsx` | 前后端技能基础规则 | 目标关系、读条、CD/GCD、距离、弹道和策略 |
| `SkillEffectConfig.xlsx` | 服务端技能效果 | 按顺序执行的目标、Action和参数 |
| `AoiConfig.xlsx` | AOI冷配置 | AOI Grid包含的Cell数、Enter与Detach范围 |
| `AoiSyncTierConfig.xlsx` | AOI同步冷配置 | 独立同步范围与最高同步Hz |
| `ConfigTablePolicy.xlsx` | 表级重载策略 | 每张配置表是Hot还是Cold |

`PlayerConfig`只描述“创建玩家时从哪里开始”，不保存玩家升级后的等级、经验、装备结果或当前血量。那些是玩家运行时和持久化数据。

地图坐标统一为米制X/Y/Z：X/Z是地面平面，Y是高度，Yaw为绕Y轴弧度。Grid2D使用`widthCells/depthCells/cellSizeMeters`；AOI通过`aoiConfigId`引用独立的Grid、Enter、Detach和同步档位；`entryPlayersPerTick/entryQueueCapacity`控制每个MapInstance的隐藏式Loading入图队列；NavMesh3D使用`navigationAsset/navigationVersion/navigationHash`。客户端只在引擎边界转换为Cocos `Vec3`、Unity向量或二维屏幕坐标，详细规则见[地图空间与3D坐标契约](../design/spatial-world.md)。

## Excel约定

每张数据表前四行由Luban解释：

```text
##var    字段名
##type   字段类型
##group  输出目标
##       中文说明
```

数据从第五行开始。字段名在Excel中使用`snake_case`，Luban生成的TypeScript属性使用`camelCase`。例如`initial_map_id`生成`initialMapId`。

`##group`控制字段去哪一端：

- `c,s`：客户端和服务端都需要。
- `c`：只进入客户端，例如道具展示描述。
- `s`：只进入服务端，例如玩家初始赠送道具。

引用使用Luban的`#ref`约束：

```text
int#ref=game.TbMapConfig
int#ref=game.TbItemConfig
```

如果`PlayerConfig.initial_map_id`引用不存在的地图，生成会直接失败，不把错误留到服务器运行期。

新增整张表时，还要在`game_config/Datas/__tables__.xlsx`登记表名、记录类型、输入文件和`id`索引。普通新增行或修改字段值不需要改`__tables__.xlsx`。

## 生成和验证

仓库在`tools/third_party/luban/4.10.2/`固定收录官方CLI，首次拉取不需要另装Luban，但机器需要.NET 8或更高版本。

```powershell
npm run build:game-config:startup
npm run test:game-config
```

这里有两个不同的打包入口：

- `npm run build:game-config:startup`执行完整构建，生成相互匹配的 Model、Hotfix 和 `dist/game-config`，部署后重启。
- `npm run build:game-config`等价于 `build:hotfix`，生成携带完整配置的 `dist/hotfix-candidates/<releaseId前16位>`，不会覆盖启动包。把输出的联合候选目录交给 Watcher 的 `reload`。
- `npm run test:game-config`只验证生成物和分区指纹，不会把`game_config/generated`复制到服务器启动目录。

完整`npm run codegen`也会执行游戏配置生成，并把客户端配置随公共SDK分发到Cocos和Pixi。生成目录如下：

```text
app/generated/model/config/                    服务端
client_sdk/typescript/Generated/Config/        客户端SDK唯一源码
game_config/generated/                         完整JSON数据包与schema/data指纹
../TiangZ-Examples/clients/cocos_client2D_3.8.6/.../Generated/SDK/Generated/Config/  自动分发副本
../TiangZ-Examples/clients/cocos_client3D_3.8.8/.../Generated/SDK/Generated/Config/  自动分发副本
../TiangZ-Examples/clients/pixi_client_8.19.0/.../Generated/SDK/Generated/Config/     自动分发副本
```

所有Generated文件都禁止手改。服务端Model记录结构指纹，独立数据包记录数据指纹；客户端生成物记录它所携带的数据指纹，用于版本诊断。

## 服务端使用

Model可以从生成目录导入；Hotfix通过`#tiangz/model`取得公开的`GameConfigs`：

```ts
import { GameConfigs } from "#tiangz/model";

const item = GameConfigs.ItemConfig.Get(itemConfigId);
const map = GameConfigs.MapConfig.TryGet(mapId);
const players = GameConfigs.PlayerConfig.GetAll();
```

- `Get(id)`要求配置存在，不存在时抛错，适合已经过协议或领域校验的ID。
- `TryGet(id)`返回配置或`undefined`，适合把外部输入转换成业务错误。
- `GetAll()`返回只读数组，用于低频初始化和管理逻辑，不要在每帧热路径反复全表扫描。

## 客户端使用

Cocos和Pixi都从各自的自动分发SDK导入同一套API：

```ts
import { GameConfigs } from "../../Generated/SDK/Generated/Config";

const map = GameConfigs.MapConfig.Get(enterMap.mapId);
const player = GameConfigs.PlayerConfig.Get(1);
```

客户端看不到标记为`s`的字段。不要为了方便把服务端奖励、掉落权重或校验数据改成`c,s`；公开给客户端的数据都应按可被读取和篡改的公开信息处理。

## Model、Hot数据与Cold数据

Luban输入被拆成两部分：

- **结构属于Model**：表名、字段名、字段类型、`c/s`分组、索引和`#ref`关系会生成TypeScript类型与解码代码。修改这些内容必须运行完整`npm run build`、重启Process，并发布匹配的客户端SDK。
- **Hot数据**：`ConfigTablePolicy.xlsx`标为`Hot`的整张表可以在线原子替换。当前`ItemConfig`和`PlayerConfig`为Hot。
- **Cold数据**：标为`Cold`的整张表即使只改一个值也必须完整构建并重启Process。当前`MapConfig`、`AoiConfig`、`AoiSyncTierConfig`和策略表本身为Cold。

策略按整张表声明，不做字段级Hot/Cold混用。新增配置表必须同时在`ConfigTablePolicy.xlsx`登记，否则codegen直接失败。生成包同时包含完整、Hot、Cold三份JSON与各自指纹；Rust先验证分区确实能无重叠地还原完整数据，TS再验证Cold指纹没有变化，不能只伪造manifest绕过边界。

本地使用`npm run dev -- configs/local/cluster/StartMachine.json`时，保存Hot表后开发宿主会自动生成、校验并让Watcher广播候选。Cold表变化会明确提示需要完整构建和重启。手工部署Hot候选时：

```text
npm run build:game-config
# 读取输出中的 candidate=dist/hotfix-candidates/...
reload dist/hotfix-candidates/...
```

每个 Process 校验联合发布身份、文件哈希、Hot/Cold 分区、Model 结构指纹与模块配置校验器，并暂存 Hotfix 行为。Cold 指纹不一致会以“必须重启”拒绝；所有准备完成后，在现有帧间安全点同时提交行为与配置。失败保留旧的整套版本。可以从 `tiangz_game_config_info`、`tiangz_game_config_reload_successes_total` 和 `tiangz_game_config_reload_failures_total` 确认结果；其中配置身份是包含模块配置的完整配置 manifest 哈希。

切换不会重跑Scene、Entity或Component的`Awake`，也不会修改已经由配置创建出的运行时状态。旧代码若保存过某行配置对象，该引用仍保持旧值；后续通过`GameConfigs.Xxx.Get`取得的是新快照。因此默认在真正使用数值时查询，不要把整行配置长期缓存到Entity字段。地图创建参数和玩家初始模板只自然影响新地图、新玩家；道具使用这类即时查询会立即读取新值。

当前在线 Reload 联合替换服务端 Hotfix 与配置。Cocos/Pixi 中的配置仍编入 Client SDK，必须单独构建和发布。原子提交由每个 Process 的 Runtime 执行，不是 Watcher 的全局事务；不同进程可以暂时运行不同的完整版本，不能据此假定全服或客户端已同步切换。

## 新增配置的检查清单

1. 判断它是静态策划配置，还是玩家运行时/数据库数据。
2. 设计稳定`id`，明确每个字段属于`c`、`s`还是`c,s`。
3. 能引用其他表时使用`#ref`，不依赖业务代码事后检查。
4. 重启部署执行完整 `npm run build`；在线更新执行 `npm run build:game-config`，再用 Watcher 的 `reload` 提交联合候选。旧拼写 `reload-config` 也只接受联合候选，纯配置目录不能在线提交。模块校验与业务用例通过后再发布。
5. 业务只调用`GameConfigs`，不缓存可变副本，不扫描Generated JSON。
6. 配置改变了架构或业务流程时，同步更新两份AI文档。
