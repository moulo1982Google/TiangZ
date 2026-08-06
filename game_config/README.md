# 游戏配置源文件

这里存放策划直接维护的Luban Excel。`configs/`只负责机器、Process、Scene和端口部署，两者不得混用。

第一批配置：

- `ItemConfig.xlsx`：道具静态定义。
- `MapConfig.xlsx`：空间模式、米制地图尺寸、三维出生点、AOI引用、入图节流和导航资源身份。
- `PlayerConfig.xlsx`：玩家初始基础值，包括HP/MP；不描述升级后的等级成长。
- `MonsterConfig.xlsx`：怪物模板、最大生命值、基础攻击力、米/秒移动速度、独立普通攻击距离、攻击间隔毫秒、攻击模式和死亡复活秒数。
- `MonsterAreaConfig.xlsx`：固定刷怪槽、地图坐标和地图创建时是否生成；不保存尸体时间或复活时间。
- `BuffConfig.xlsx`：Buff模板、持续时间、Tick间隔，以及添加/Tick/移除时执行的Action。

修改Excel后运行：

```bash
npm run build:game-config:startup
npm run test:game-config
```

`build:game-config:startup`会重新生成并覆盖服务端重启使用的`dist/game-config`；服务器重启后才会读取新的配置。若要在线热更，改用`npm run build:game-config`，它只生成`dist/game-config-candidates/<指纹>`，再在Watcher中执行`reload-config <候选目录>`。`test:game-config`只验证生成结果，不会更新`dist/game-config`。

生成文件全部位于`app/generated/model/config`、`client_sdk/typescript/Generated/Config`和`game_config/generated`，禁止手工修改。字段分组使用Luban约定：`c`仅客户端、`s`仅服务端、`c,s`两端共享。

- 表、字段、类型、分组和引用关系属于Model，修改后必须执行完整`npm run build`并重启Process。
- 只改行数据或字段值时，在线热更使用`build:game-config`并在Watcher终端执行`reload-config <候选目录>`；准备重启服务器则使用`build:game-config:startup`更新`dist/game-config`。
- `npm run dev -- configs/local/cluster/StartMachine.json`会监听Excel并自动生成、校验和切换。
- Cocos/Pixi配置仍随Client SDK构建和发布，服务端切换不会修改已运行客户端中的数据。

`MapConfig.spatial_mode`当前支持`Grid2D`与`NavMesh3D`。Grid2D必须填写`width_cells/depth_cells/cell_size_meters`；NavMesh3D必须填写`navigation_asset/navigation_version/navigation_hash`，其中哈希为小写SHA-256。`entry_players_per_tick`限制单个MapInstance每逻辑Tick完成AOI Attach的人数，`entry_queue_capacity`限制仍在Loading中的等待人数；它们属于Cold地图容量配置。坐标采用米制X/Y/Z，X/Z为地面、Y为高度；完整契约见[地图空间与3D坐标契约](../docs/design/spatial-world.md)。

## Item、Action与Buff

`ItemConfig.use_effect`决定道具是否可用以及使用后执行哪种最小效果：

| `use_effect` | 含义 | `use_params`格式 |
|---:|---|---|
| `0` | 不可使用 | 空数组 |
| `1` | 给使用者添加Buff | 一个`BuffConfig.id` |
| `2` | 执行一个Action | `[ActionType参数...]`；当前`ChangeNumeric`为`[NumericType, delta]` |

当前演示道具：小型生命药水使用`ChangeNumeric(CurrentHp, 50)`，大型生命药水使用`AddBuff(2001)`。`ItemConfig.icon`是客户端字段，填写相对`assets/resources`的Cocos资源键，不含扩展名；Cocos3D快捷栏通过这个字段加载图标，资源缺失时回退到名称文字。道具Handler只消费道具并调用统一`ActionExecutor`，不能自行分支写HP、创建Timer或直接广播Buff。

Cocos3D演示玩家出生时预置`1001×50`和`1002×20`两个堆叠，快捷栏固定使用`1`切换平A、`2`使用1001、`3`使用1002。这个预置属于Demo的`ItemComponentSystem.Awake`，正式业务应由持久化数据恢复，不要把演示数量当成通用框架默认值。

`BuffConfig`的三个Action阶段分别是：

- `add_action_*`：Buff创建时执行一次。
- `tick_action_*`：每个`tick_interval_ms`执行一次；间隔为`0`表示没有Tick。
- `remove_action_*`：Buff主动移除、自然到期或Unit销毁时执行一次。

Action当前支持`None`、`ChangeNumeric`、`AddBuff`和`RemoveBuff`。表结构和Action参数属于Model，改列或类型必须重启；只改数值行时按Hot配置流程生成候选并Reload。更完整的调用边界见[Action与Buff最小闭环](../docs/design/action-buff.md)。

怪物死亡会删除当前MonsterUnit。`MonsterComponent`把`MonsterConfig.max_hp`写入Numeric的`MaxHpBase`，由Rust推导出只读`MaxHp`，把攻击力写入`AttackBase`并由Rust推导只读`Attack`，把`attack_interval_ms`写入`AttackSpeedAdd`并读取只读`AttackSpeed`；`move_speed`按米/秒转换为Numeric的毫米/秒`MoveSpeedBase`。`respawn_seconds`到期后复用同一个`AreaId`刷怪槽，但会创建新的MonsterUnit并分配新的UnitId。不要在Area表新增`corpse_lifetime_seconds`或重复配置`respawn_seconds`。

`PlayerConfig.initial_hp/max_hp`和`initial_mp/max_mp`分别初始化玩家的当前/最大HP与MP；`attack_range`是独立的普通攻击距离，不属于Numeric链式属性。它们会在创建Unit时写入Numeric，客户端HUD只显示服务端快照和增量。`PlayerConfig.move_speed`同样填写米/秒。Grid2D的移动实现会把一个Cell的米制边长纳入单步耗时，因此不能再把它理解成“每秒几个Cell”；底层协议里的历史字段名`speedCellsPerSecond`暂时保留兼容，但它承载的是米/秒值。

## AOI冷配置

`AoiConfig.xlsx`和`AoiSyncTierConfig.xlsx`都是Cold配置，只能停服修改、重新生成并重启Process，禁止通过`reload-config`热更。`MapConfig.aoi_config_id`决定地图使用哪套AOI配置。

- `AoiConfig.enter_range_grids`：建立新可见关系的范围，必须是正奇数。
- `AoiConfig.detach_range_grids`：已可见关系的迟滞边界，必须是正奇数且不小于Enter。
- `MapConfig.cell_size_meters`：一个Cell的米制边长。
- `AoiConfig.grid_size_cells`：一个AOI Grid每条边包含的Cell数量。
- `AoiSyncTierConfig.range_grids`：本档同步范围，必须是正奇数、唯一并逐档扩大。
- `AoiSyncTierConfig.sync_hz`：本档可覆盖状态的最高同步频率，外层不得高于内层，并且必须整除服务端20Hz逻辑Tick。

Grid数量不单独配置，而是由`MapConfig.width_cells/depth_cells ÷ AoiConfig.grid_size_cells`推导；地图米制尺寸等于`width_cells/depth_cells × cell_size_meters`。地图制作流程决定物理边界并把结果写入MapConfig，运行时只接受能完整切成AOI Grid的尺寸，避免边缘出现半个Grid或多份尺寸配置互相冲突。

同步档位数量不写死。默认配置是`3×3 → 20Hz`、`5×5 → 5Hz`；如果业务需要恢复远距离低频观察，可以只修改Excel：

1. 将`detach_range_grids`改为`7`，Enter仍保持`3`。
2. 保留`3×3 → 20Hz`和`5×5 → 5Hz`两行。
3. 新增同一`aoi_config_id`的`7×7 → 1Hz`行。
4. 运行`npm run build`和`npm run test:game-config`，然后重启相关Process。

最外层同步范围必须等于Detach范围。这样所有已可见关系都有同步档位；例如配置了`Detach=7`却只填写到`5×5`会在生成期直接报错。处于5×5或7×7迟滞圈的单位不会凭空Enter，只有已经在Enter圈建立过的关系才会继续以外层频率同步。
