# 游戏配置源文件

这里存放策划直接维护的Luban Excel。`configs/`只负责机器、Process、Scene和端口部署，两者不得混用。

第一批配置：

- `ItemConfig.xlsx`：道具静态定义。
- `MapConfig.xlsx`：空间模式、米制地图尺寸、三维出生点、AOI引用、入图节流和导航资源身份。
- `PlayerConfig.xlsx`：玩家初始基础值；不描述升级后的等级成长。

修改Excel后运行：

```bash
npm run build:game-config
npm run test:game-config
```

生成文件全部位于`app/generated/model/config`、`client_sdk/typescript/Generated/Config`和`game_config/generated`，禁止手工修改。字段分组使用Luban约定：`c`仅客户端、`s`仅服务端、`c,s`两端共享。

- 表、字段、类型、分组和引用关系属于Model，修改后必须执行完整`npm run build`并重启Process。
- 只改行数据或字段值时，`build:game-config`会输出`dist/game-config-candidates/<指纹>`；在Watcher终端执行`reload-config <候选目录>`即可在线切换服务端数据。
- `npm run dev -- configs/local/cluster/StartMachine.json`会监听Excel并自动生成、校验和切换。
- Cocos/Pixi配置仍随Client SDK构建和发布，服务端切换不会修改已运行客户端中的数据。

`MapConfig.spatial_mode`当前支持`Grid2D`与`NavMesh3D`。Grid2D必须填写`width_cells/depth_cells/cell_size_meters`；NavMesh3D必须填写`navigation_asset/navigation_version/navigation_hash`，其中哈希为小写SHA-256。`entry_players_per_tick`限制单个MapInstance每逻辑Tick完成AOI Attach的人数，`entry_queue_capacity`限制仍在Loading中的等待人数；它们属于Cold地图容量配置。坐标采用米制X/Y/Z，X/Z为地面、Y为高度；完整契约见[地图空间与3D坐标契约](../docs/design/spatial-world.md)。

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
