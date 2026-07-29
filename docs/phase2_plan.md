# Phase 2 细化计划

> 术语说明：本文完成时业务类仍命名为 `*Service`。当前实现已迁移为 `LoginMgrScene/LoginScene/GateScene/MapHostScene`，业务行为和协议纵向切片保持不变。

Phase 2 的目标不是继续堆叠登录代码，而是完成第一条可游玩的多人地图纵向链路。最终应能够打开两个 Cocos 客户端，进入同一地图，看见彼此进入、移动和离开。

## 目录边界

所有新增代码必须遵守以下边界：

```text
Core       可复用框架代码，不允许依赖 Demo
Generated  只允许 codegen 写入，禁止手工修改
Demo       登录、地图、输入、界面等纯演示业务
```

Cocos 当前对应目录：

```text
assets/scripts/Core/
assets/scripts/Generated/
assets/scripts/Demo/
```

服务端继续使用相同约定：

```text
app/core/       框架
app/generated/  自动生成代码
app/demo/       演示业务
```

## Phase 2.0：登录进图纵向切片

状态：已完成。

- Cocos 通过 WebSocket 连接 LoginMgr、LoginService 和 GateService。
- Gate 登录后调用 MapService 进入地图。
- Cocos 能根据 `G2C_EnterMap` 渲染地图和本地玩家。
- `RpcSocket` 支持按 payload `rpcId` 关联并发 RPC。

## Phase 2.1：Cocos 分层与协议生成

状态：已完成。

- `codegen_proto.mjs` 把 client 目标协议生成到 `assets/scripts/Generated/Model`。
- Cocos 生成代码只依赖 `Core/Protocol`，不依赖 Demo。
- 删除手写 `DemoProtocol.ts`。
- `Core/Net/RpcSocket.call()` 直接接收生成的 `RpcDescriptor`，自动完成分配 `rpcId`、编码、响应消息号检查、解码和错误检查。
- `GameBootstrap`、`LoginFlow`、`MapView`、`LocalPlayerController` 和 `DemoUi` 已按职责拆分到 Demo。
- `GameBootstrap.ts.meta` 的 UUID 保持不变，现有场景引用不会因文件迁移失效。

验收命令：

```bash
npm run codegen
npm run typecheck:cocos-net
npm run check:cocos-demo
```

## Phase 2.2：单向 Message 与 S2C Push

状态：已完成。

- Core 已增加 `MessageDescriptor<T>`、`defineMessage()` 和 `@message(...)`。
- `codegen_proto.mjs` 自动生成 `messageDescriptors.ts`，业务代码不需要手工维护消息号、Codec 与 Handler 的绑定关系。
- 单向 Message 不生成 Response，也不携带无意义的系统错误响应。
- `ServiceContext.send()` 支持同进程和跨进程单向发送；发送成功表示消息已进入目标服务队列或内部连接写队列，不等待目标 Handler 执行。
- GateService 可通过 `sendClient(connectionId, descriptor, message)` 主动发送类型安全的 S2C Message。
- `MapService -> GateService -> Client` 的 `MapReady` 主动推送链路已经打通。
- Cocos `RpcSocket.on(descriptor, handler)` 和 `waitForMessage()` 会根据生成的描述符自动解码服务端通知。
- 单向内部 Message 不进入 `rpcId` pending 表，可与 RPC 共用同一条内部 TCP 连接。

验收结果：

- 单进程配置收到 `MapReady`：通过。
- 拆分进程配置收到 `MapReady`：通过。
- Message Handler 不产生 Response 的协议测试：通过。
- 单向 Message 后继续执行 RPC 的内部连接测试：通过。

## Phase 2.3：GateSession 与玩家路由

状态：已完成。

- GateSession只保存一次物理连接的认证状态与Route引用；`GatePlayerRoute`保存跨重连的Map/Unit/Actor路由。
- Gate维护`account -> Route`、`connectionId -> Route`和`unitId -> Route`索引。
- Disconnect 事件进入 Service mailbox 串行处理，不再在 Rust 推送事件的同步阶段直接执行异步清理。
- 普通Disconnect只销毁GateSession并进入30秒重连宽限，不通知Map删除玩家。
- Map中的`UnitGateComponent`只记录长期Gate实例，不保存GateSessionId。
- 重连通过`SecondEnterMap`恢复原Unit；最终超时由Gate调用`PlayerOffline`，Map完成保存、删除和AOI离开后Gate清理Route。
- 完整 Token 签发、角色认证、顶号和重连策略仍留在 Phase 3。

验收结果：

- 同账号新连接进入后，旧连接断开不会删除当前地图玩家：通过。
- 当前有效连接断开后，宽限期内重连继续使用原UnitId：通过。
- 单进程配置：通过。
- 拆分进程配置：通过。

## Phase 2.4：地图 Actor 与 Component

状态：已完成。

目标结构：

```text
MapHostScene
  -> MapScene
       -> UnitComponent
            -> PlayerUnit
            -> NativeUnitRef
            -> PositionComponent
            -> UnitGateComponent
```

- 地图实体已经迁移为 Unit/Component；玩家是 PlayerUnit，怪物和 NPC 后续使用同一 Unit 基类。
- MapHostScene 只负责协议入口、MapScene 创建和账号重连辅助目录。
- 每个地图实例对应一个 MapScene，UnitComponent 按 UnitId 统一维护全部 Unit。
- PlayerUnit 使用 ordered MailBoxComponent，异步 Handler `await` 时同一玩家不会重入。
- NativeUnitRef 指向 Rust Arena 中的权威坐标与移动状态，PositionComponent 提供业务视图。
- UnitGateComponent只保存Gate实例。
- 玩家重连通过PlayerUnit Handler返回权威快照但不更新Gate绑定；宽限期结束后的最终下线才由UnitComponent移除并销毁PlayerUnit。
- Core 的 ProcessHost 已增加 `despawnActor()` 生命周期接口。

验收结果：

- Actor Component 初始化、查询、重绑定与销毁自测：通过。
- 两个并发提交的异步 Actor Handler 最大同时执行数为 1，完成顺序保持为 `[1, 2]`：通过。
- 单进程登录、重连和断线生命周期：通过。
- 拆分进程登录、重连和断线生命周期：通过。

## Phase 2.5：服务端权威移动

状态：已完成。

消息链路：

```text
Cocos 输入
-> C2M_Move（IActorLocationMessage，由 Gate 框架自动转发）
-> Core 根据 Gate 连接保存的 MapHost/InstanceId，用内部 ActorLocationEnvelope 转发原始帧
-> 目标 ProcessHost.Root 按 InstanceId 定位 PlayerUnit
-> ActorMessageDispatcher 进入 PlayerUnit 的 MailBoxComponent
-> C2M_MoveHandler 直接调用 PlayerUnit.Move() 更新方向状态
-> Map 固定帧推进 Cell 移动，并向 BroadcastHub 发布 latest 状态
-> 通用S2G_ClientBroadcast按Gate实例与UnitId聚合，并由GatePlayerRoute解析当前connectionId后下发G2C_EntityMove
-> Cocos 按服务端 fixedUpdateMs 和 Cell 路径逐帧推演
```

实现内容：

- 客户端只发送方向输入和递增序号，不发送坐标、速度或客户端时间。
- Gate 在 EnterMap 成功后把连接绑定到 UnitId、Actor InstanceId 与 MapHost；业务 Move 不携带账号、UnitId、Gate 或 MapService。
- codegen 根据 `IActorLocationMessage/Request` 自动生成 `routing: "actor-location"`，Gate 不需要 Move Handler。
- MapHost EntryScene 使用 unordered mailbox 接入不同玩家；PlayerUnit 使用 ordered MailBoxComponent 串行处理同一玩家移动。
- Cocos 在方向变化时立即发送状态，持续移动时以 5Hz 保活；服务端 Game.Update 以 20Hz 推进 Rust Unit 状态并输出活动实体快照。
- Rust 移动批处理每个逻辑帧只应用最新方向状态，并丢弃重复或过期序号，避免输入队列堆积。
- PositionComponent 通过 NativeUnitRef 访问 Cell 坐标并处理地图边界。
- Map 仍向同地图所有在线玩家广播权威坐标；Audience 由地图决定，按 Gate 分组、single-flight 和同 Unit 状态覆盖由 Core BroadcastHub 完成。
- 本地 Unit 使用输入预测和服务端确认序号；远端 Unit 使用 50ms 状态缓冲、速度推演和禁止反向的误差校正。

验收结果：

- Actor 自测覆盖首次移动、重复序号丢弃和非法方向输入拒绝：通过。
- 单进程与拆分进程均完成完整移动链路：通过。
- 重复序号不会产生客户端广播：通过。
- 两个账号进入同一地图，观察者收到与移动者一致的权威坐标：通过。
- Cocos 网络层类型检查与 Demo 独立打包：通过。

## Phase 2.6：最小多人可见

状态：已完成。

Phase 2 暂不实现正式网格 AOI，而是在同一张小地图内全量广播：

- 玩家进入时向其他玩家推送 EntityEnter。
- 新玩家收到当前地图实体快照。
- 为远端玩家创建节点，并消费 Phase 2.5 已完成的 EntityMove 广播。
- 玩家断线或离开时推送 EntityLeave。

这一步用于验证 Message、Actor、Gate 路由、S2C Push 和客户端实体管理的完整链路。Phase 5 再把全量广播替换为网格 AOI。

实现内容：

- codegen 支持 `repeated` 消息结构体字段，`EnterMap` Response 可以携带 `MapEntitySnapshot[]`。
- 新玩家进入时，在同一个 RPC Response 中收到包含自己在内的地图实体快照，避免 Gate 尚未建立 UnitId 索引时丢失快照 Push。
- 新 Unit 创建后，Map 向同地图旧玩家广播 `EntityEnter`；同账号重连复用 Unit 时不会重复广播。
- 有效 GateSession 断开并移除 PlayerUnit 后，Map 向剩余玩家广播 `EntityLeave`。
- Cocos 的 `MapEntityManager` 统一管理本地和远端 Unit，处理快照、Enter、Move、Leave 和位置插值。
- 本地 Unit 使用黄色，远端 Unit 使用蓝色，并显示账号和 UnitId。
- `LocalPlayerController` 只负责输入上报，`MapController` 组合输入与实体显示生命周期。

验收结果：

- 嵌套消息及 `repeated MapEntitySnapshot` 编解码往返：通过。
- 第二个玩家进入后，旧玩家收到 Enter，新玩家快照同时包含两个 Unit：通过。
- 任一玩家移动时两个连接收到一致权威坐标：通过。
- 第二个玩家断线后，第一个玩家收到对应 Leave：通过。
- 单进程和拆分进程部署均通过上述生命周期：通过。

## Phase 2.7：综合验收

状态：自动验收已完成，浏览器视觉复核待人工打开构建页。

验收条件：

1. 单进程和分进程部署都能完成登录进图。
2. 两个 Cocos 页面能进入同一地图并看见彼此。
3. 任意玩家移动时，另一端能平滑更新位置。
4. 玩家断线后，地图和其他客户端都能清理对应实体。
5. Cocos 不再维护任何手写协议副本。
6. Runtime 冒烟、协议类型检查和背压测试保持通过。

验收结果：

- `npm run test:runtime`：单进程和拆分进程的登录、进图、快照、Enter、Move、Leave 全部通过。
- `npm run check`：服务端类型检查、协议测试、Actor 测试、Cocos 网络层和完整 Demo 类型检查、Cocos Demo 打包全部通过。
- Cocos Creator 3.8.6 Web Desktop 正式构建成功，产物位于 `cocos_client2D/build/web-desktop/`。
- 背压用例改用 unordered BenchService 和 16384 并发；最终回归峰值队列为 4096、背压等待 379 次、请求错误 0、健康连接误断开 0。
- Rust 默认 allocator 与 `--no-default-features` 两套全目标测试均通过。
- 当前会话没有可连接的内置浏览器实例，因此未自动截图；本地构建页可用于双窗口人工视觉复核。
