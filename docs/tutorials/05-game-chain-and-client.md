# 登录、Gate、地图与 Cocos 链路

## Demo Scene 职责

```text
Client
  -> LoginMgrScene：选择 LoginScene 地址
  -> LoginScene：由连接 Session Handler 签发 Demo Token，选择 GateScene
  -> GateScene：GateSession 表示连接实体，保存认证和玩家路由状态
  -> MapHostScene：创建多个 MapScene，管理 PlayerUnit Directory
       -> MapScene.UnitComponent：统一管理玩家、怪物和 NPC Unit
  <- GateScene：把 Map Push 发送给对应客户端
```

协议中的 `GetLoginServiceAddr` 和 `mapService` 是已有 Demo 线协议名称，表达“登录服务器/地图服务器地址”，不代表框架仍有 Service 运行层。

## 路由数据保存

玩家登录 Gate 后，GateSession 保存 account、token、unitId、actorInstanceId、MapHost Scene 名和 GateSessionId。GateSession 本身就是带 mailbox 的连接 Entity，不再同时维护一个普通对象会话和一个额外 Actor。UnitId 用于业务和客户端显示，actorInstanceId 只用于服务端 Unit 寻址。玩家进入地图时把当前 Gate Scene 名传给 PlayerUnit；玩家不换 Gate 时，该绑定可以随玩家状态保存。

```text
MapHostScene send GateScene
GateScene 根据 UnitId/Account 找 connectionId
GateScene sendClient
Client SDK 按 msgcode 分发 Push
```

未来 `SendMessageToClient(unitId, message)` 可以在 Location/Online 目录上封装这条链路，但底层仍是 Scene 路由。

## 多地图

`MapHostComponent` 管理多个动态 `MapScene + UnitComponent`。低负载时Map1和Map2共享一个Process/V8；高负载时增加MapHost实例并由Directory/Location选择具体Scene。MapHost的PlayerDirectory只负责本宿主账号重连和迁移辅助索引，普通Unit消息全部通过InstanceId直达。

当前Demo按`T`键可在Map1和Map2之间传送。客户端沿用当前Gate连接再次调用`EnterMap`，服务端保留UnitId，旧地图广播`EntityLeave`，目标地图使用`MapConfig`出生点创建新的Actor实例并广播`EntityEnter`。Numeric、Item等需要保留的Component显式使用`@transferable()`和`ITransfer`导出/恢复自身值快照；未标记的临时组件不会传送。客户端同时等待RPC响应和`MapReady`，随后释放旧地图消息作用域并从全量快照重建地图。跨MapHost传送尚未实现，后续由动态副本Directory增加可编码DTO、跨进程接管和回滚。

如果组件恢复数据后还要重建运行时行为，在Hotfix System实现`IDeserialize`。例如Buff的`RestoreTransfer`只恢复Buff ID、层数和结束时间，`Deserialize`再计算剩余时间并创建Timer。Entity保证所有传送数据先恢复完，再调用`Deserialize`，因此不要在每个字段setter中启动Timer，也不要把Timer句柄写入迁移快照。

## Cocos 验证

1. 运行 `npm run build`。
2. 运行 `cargo run --bin TiangZ -- configs/local/all.json`。
3. 用 Cocos Creator 打开 `cocos_client2D`。
4. Preview 后进入游戏，多开页面可观察玩家互见和移动；按`T`在Map1/Map2间传送。

`npm run test:runtime` 会在无 Cocos 环境下验证同一条协议和地图生命周期。
