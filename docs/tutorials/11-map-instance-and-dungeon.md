# 地图实例与动态副本

本文说明业务开发者如何配置静态地图、创建动态副本、传送玩家和销毁副本。底层事务与失败恢复见[Entity地图迁移](../design/entity-transfer.md)。

## 两个编号

- `MapConfigId`：Luban `MapConfig`中的地图模板编号，例如地图1和地图2。
- `MapInstanceId`：当前运行中的地图实例编号，用于传送和路由。

静态地图的`MapInstanceId`等于`MapConfigId`。动态副本即使来自同一个`MapConfig`，每次创建也会得到不同的全局实例号。业务不得把MapHost名字、IP或端口当作地图身份。

## 配置静态地图

只在实际启动MapHost的`scenes`条目填写`staticMapIds`：

```json
{
  "name": "map_1",
  "sceneType": "MapHost",
  "staticMapIds": [1, 3],
  "ip": "127.0.0.1",
  "port": 7301
}
```

MapHost启动时会为配置1和3创建MapScene，并向Location注册实例1和3。其他Process的`knownScenes`只保留MapHost的name/type/ip/port，不重复填写`staticMapIds`。

## 创建动态副本

动态副本属于游戏业务，不属于Core。只有`acceptDynamicMaps=true`的MapHost会向单例`MapManager`注册内网地址，并每5秒上报动态实例数和玩家数。业务创建时不选择MapHost，只提供一次副本尝试的稳定`requestId`：

```ts
const dynamicMaps = new DynamicMapProxy(this.scenes);
const requestId = `team-dungeon:${teamId}:${attemptId}`;
const created = await dynamicMaps.Create(requestId, 1001);
const dungeonInstanceId = created.instance.mapInstanceId;
```

同一`requestId + mapConfigId`的并发调用和超时重试始终返回同一个`MapInstanceId`；同一`requestId`改用其他模板会明确报冲突。新一轮副本必须生成新的业务`requestId`，已经销毁的尝试也不能复用旧ID。

`MapManager`按“动态实例数最少、玩家数最少、MapHost名称稳定排序”选择仍在15秒租约内的宿主，先生成全局`MapInstanceId`，再命令目标MapHost按指定ID创建并注册Location。MapHost不会自行改号。创建成功后，业务只保存实例号，不保存宿主或网络地址。

当前MapHost注册会重报仍托管的`requestId -> MapInstanceId`，因此单独重启MapManager可以恢复运行期幂等关系。MapManager和对应MapHost同时丢失后的跨重启幂等需要未来的Redis持久化，本阶段不伪装成已经具备该保证。

## 部署副本Host

静态地图和动态副本使用同一个`MapHostScene`实现，只通过部署配置区分角色：

| 角色 | `staticMapIds` | `acceptDynamicMaps` |
|---|---|---|
| 静态地图专用 | `[1, 2]` | `false`或省略 |
| 动态副本专用 | `[]`或省略 | `true` |
| 混合承载 | `[1, 2]` | `true` |

空载副本进程参考[`configs/local/dungeon1.json`](../../configs/local/dungeon1.json)：

```json
{
  "scenes": [{
    "name": "dungeon_1",
    "sceneType": "MapHost",
    "acceptDynamicMaps": true,
    "staticMapIds": [],
    "ip": "127.0.0.1",
    "port": 7310,
    "protocol": "tcp",
    "audience": "inner"
  }],
  "knownSceneFiles": ["cluster.known-scenes.json"]
}
```

稳定基础Scene集中写在[`cluster.known-scenes.json`](../../configs/local/cluster.known-scenes.json)。新增`dungeon_2`只需要新的进程身份、Scene名称和端口，不需要把它反向添加到Gate、Location或其他MapHost配置。MapInstance与玩家Location会携带经过校验的MapHost Endpoint；首次进图、断线重连、Actor消息、跨图传送和销毁都直接使用该动态路由。

## 统一传送

静态地图和动态副本使用完全相同的API：

```ts
await player.TransferToMap(targetMapInstanceId);
```

例如回到静态地图1：

```ts
await player.TransferToMap(1n);
```

框架会通过MapInstance目录找到MapHost，并自动选择同MapHost或跨MapHost事务。业务Handler不要调用`MapHostComponent.TransferPlayer`，不要查询目标IP，也不要分别实现`TransferLocal`和`TransferRemote`。

## 销毁动态副本

正常结束副本时，业务先决定所有玩家的去向并逐个传送：

```ts
for (const player of dungeonPlayers) {
  await player.TransferToMap(entranceMapInstanceId);
}
await dynamicMaps.Dispose(dungeonInstanceId);
```

销毁非空地图会失败。框架不会暗中踢人、保存玩家或选择入口地图。MapHost本地`DynamicMapLifecycleComponent`会在地图连续无人五分钟后兜底销毁，但业务不能依赖该延时完成正常副本流程。

## 玩家重新上线

如果持久化数据记录了动态副本实例，登录业务先判断实例是否仍存在：

```ts
const target = await dynamicMaps.Exists(savedMapInstanceId)
  ? savedMapInstanceId
  : entranceMapInstanceId;
await player.TransferToMap(target);
```

“副本不存在后回到哪里”是玩法规则，应由业务提供，Location和MapHost不会替游戏决定。

## 验证

- `npm run test:location`：MapInstance目录的幂等注册、冲突与删除规则。
- `npm run test:runtime`：单进程和拆分进程的静态地图传送，以及通过正式Inner握手验证MapHost注册、重复创建幂等和动态副本销毁。
- 修改Proto后追加`npm run test:protocol-locks`。
