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

动态副本属于游戏业务，不属于Core。业务在创建时选择承载它的MapHost：

```ts
const dynamicMaps = new DynamicMapProxy(this.scenes);
const created = await dynamicMaps.CreateOn("map_1", 1001);
const dungeonInstanceId = created.instance.mapInstanceId;
```

`CreateOn`中的MapHost选择以后可以由负载、玩法分区或容量策略决定。创建成功后，副本业务只保存`dungeonInstanceId`，不继续保存网络地址。

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

销毁非空地图会失败。框架不会暗中踢人、保存玩家或选择入口地图。Demo的`DynamicMapManagerComponent`会在地图连续无人五分钟后兜底销毁，但业务不能依赖该延时完成正常副本流程。

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
- `npm run test:runtime`：单进程和拆分进程的静态地图传送，以及通过正式Inner握手创建、销毁动态副本。
- 修改Proto后追加`npm run test:protocol-locks`。
