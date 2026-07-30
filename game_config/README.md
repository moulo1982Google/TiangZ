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
- `npm run dev -- configs/local/StartMachine.json`会监听Excel并自动生成、校验和切换。
- Cocos/Pixi配置仍随Client SDK构建和发布，服务端切换不会修改已运行客户端中的数据。

`MapConfig.spatial_mode`当前支持`Grid2D`与`NavMesh3D`。Grid2D必须填写`width_cells/depth_cells/cell_size_meters`；NavMesh3D必须填写`navigation_asset/navigation_version/navigation_hash`，其中哈希为小写SHA-256。`entry_players_per_tick`限制单个MapInstance每逻辑Tick完成AOI Attach的人数，`entry_queue_capacity`限制仍在Loading中的等待人数；它们属于Cold地图容量配置。坐标采用米制X/Y/Z，X/Z为地面、Y为高度；完整契约见[地图空间与3D坐标契约](../docs/design/spatial-world.md)。
