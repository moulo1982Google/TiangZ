# 登录、Gate、地图与 Cocos 链路

## Demo Scene 职责

```text
Client
  -> LoginMgrScene：选择 LoginScene 地址
  -> LoginScene：创建/路由 LoginActor，签发 Demo Token，选择 GateScene
  -> GateScene：维护连接和 GateSession，转发客户端消息
  -> MapHostScene：创建多个 MapScene，管理 PlayerUnit Directory
       -> MapScene.UnitComponent：统一管理玩家、怪物和 NPC Unit
  <- GateScene：把 Map Push 发送给对应客户端
```

协议中的 `GetLoginServiceAddr` 和 `mapService` 是已有 Demo 线协议名称，表达“登录服务器/地图服务器地址”，不代表框架仍有 Service 运行层。

## 路由数据保存

玩家登录 Gate 后，GateSession 保存 account、token、unitId、actorInstanceId、MapHost Scene 名和 GateSessionId。UnitId 用于业务和客户端显示，actorInstanceId 只用于服务端 Actor 寻址。玩家进入地图时把当前 Gate Scene 名传给 PlayerUnit；玩家不换 Gate 时，该绑定可以随玩家状态保存。

```text
MapHostScene send GateScene
GateScene 根据 UnitId/Account 找 connectionId
GateScene sendClient
Client SDK 按 msgcode 分发 Push
```

未来 `SendMessageToClient(unitId, message)` 可以在 Location/Online 目录上封装这条链路，但底层仍是 Scene 路由。

## 多地图

`MapHostComponent` 管理多个 `MapRuntime`。每个 MapRuntime 对应一个动态 `MapScene + UnitComponent`。低负载时多个地图共享一个 Process/V8；高负载时增加 MapHost 实例并由 Directory/Location 选择具体 Scene。MapHost 的 PlayerDirectory 只负责账号重连辅助索引，普通 Unit 消息全部通过 InstanceId 直达。

## Cocos 验证

1. 运行 `npm run build`。
2. 运行 `cargo run --bin ets_runtime -- configs/local/all.json`。
3. 用 Cocos Creator 打开 `cocos_client2D`。
4. Preview 后进入游戏，多开页面可观察玩家互见和移动。

`npm run test:runtime` 会在无 Cocos 环境下验证同一条协议和地图生命周期。
