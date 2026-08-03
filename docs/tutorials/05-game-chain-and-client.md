# 登录、Gate、地图与 Cocos 链路

## Demo Scene 职责

```text
Client
  -> LoginMgrScene：选择 LoginScene 地址
  -> LoginScene：由连接 Session Handler 签发 Demo Token，选择 GateScene
  -> GateScene：GateSession表示一次连接，GatePlayerRoute保存跨重连玩家路由
  -> MapHostScene：创建多个 MapScene，管理 PlayerUnit Directory
       -> MapScene.UnitComponent：统一管理玩家、怪物和 NPC Unit
  <- GateScene：把 Map Push 发送给对应客户端
```

协议中的 `GetLoginServiceAddr` 和 `mapService` 是已有 Demo 线协议名称，表达“登录服务器/地图服务器地址”，不代表框架仍有 Service 运行层。

## 路由数据保存

玩家登录Gate后，`GateSession`只保存本连接的account、token和Route引用；连接断开后Session立即销毁。`GatePlayerRoute`按账号保存当前connectionId以及MapHost Scene、MapId、UnitId和ActorInstanceId，并在重连宽限期内继续存在。UnitId用于业务和客户端显示，actorInstanceId只用于服务端Unit寻址。PlayerUnit只保存长期Gate Scene名，不知道connectionId或GateSessionId。

```text
MapHostScene send GateScene
GateScene 根据 UnitId/Account 找 connectionId
GateScene sendClient
Client SDK 按 msgcode 分发 Push
```

未来 `SendMessageToClient(unitId, message)` 可以在 Location/Online 目录上封装这条链路，但底层仍是 Scene 路由。

## 断线重连

客户端SDK每5秒调用一次`C2G_Ping -> G2C_Ping`，回包的`serverTime`是Gate生成响应时的Unix毫秒。Gate收到任意客户端消息都会刷新`lastReceiveTime`，出站消息只记录`lastSendTime`用于观测。物理连接关闭后玩家Unit仍留在Map中，Gate保留Route等待30秒：

```text
新连接 -> LoginGate附着旧Route -> SecondEnterMap
Map -> 清除旧移动意图 -> 返回全量权威快照
```

该过程不创建Unit、不广播`EntityEnter`、不修改Unit的Gate绑定。宽限期结束仍未重连时，Gate调用`PlayerOffline`；Map保存玩家、移除Unit并广播`EntityLeave`后，Gate才清理Route。Map不运行玩家断线Timer。

## 多地图

`MapHostComponent` 管理多个动态 `MapScene + UnitComponent`。低负载时Map1和Map2共享一个Process/V8；高负载时增加MapHost实例并由Directory/Location选择具体Scene。MapHost的PlayerDirectory只负责本宿主账号重连和迁移辅助索引，普通Unit消息全部通过InstanceId直达。

当前Demo按`T`键可在Map1和Map2之间传送。客户端沿用当前Gate连接再次调用`EnterMap`，业务代码不区分两个地图是否位于同一MapHost。Gate在任何异步调用前打开迁移屏障，Location锁住旧Actor位置，目标地图创建新Actor并恢复数据，Location提交后才清理旧Actor。Numeric、Item等需要保留的Component显式使用`@transferable()`和`ITransfer`；未标记的临时组件不会传送。客户端同时等待RPC响应和`MapReady`，随后释放旧地图消息作用域并从全量快照重建地图。拆分配置中的Map1与Map2位于不同Process，`npm run test:runtime`会验证跨进程链路和传送期间消息排队。

如果组件恢复数据后还要重建运行时行为，在Hotfix System实现`IDeserialize`。例如Buff的`RestoreTransfer`只恢复Buff ID、层数和结束时间，`Deserialize`再计算剩余时间并创建Timer。Entity保证所有传送数据先恢复完，再调用`Deserialize`，因此不要在每个字段setter中启动Timer，也不要把Timer句柄写入迁移快照。

## Cocos 验证

1. 运行 `npm run build`。
2. 运行 `cargo run --bin TiangZ -- configs/local/all-in-one.json`。
3. 用 Cocos Creator 打开 `cocos_client2D`。
4. Preview 后进入游戏，多开页面可观察玩家互见和移动；按`T`在Map1/Map2间传送。

`npm run test:runtime` 会在无 Cocos 环境下验证同一条协议和地图生命周期。
