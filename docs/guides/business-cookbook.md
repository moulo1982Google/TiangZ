# 业务开发清单

## 新增入口 Scene

1. 在 `app/<game>/scenes/XxxScene.ts` 定义 `@entryScene()` class。
2. 业务状态放实例字段或 Actor/Component，不放模块级可变单例。
3. 运行 `npm run codegen`，确认生成入口导入。
4. 在配置 `scenes` 中增加本进程实例。
5. 在调用方 `knownScenes` 中增加可路由地址。

## 新增协议

1. 在 proto 中定义 Message 或 IRequest/IResponse。
2. RPC Request 注释声明 ResponseType 和 protocol。
3. 运行 `npm run codegen`。
4. 在 `app/<game>/<domain>/handlers` 中创建独立 Handler，根据目标使用 Scene、Session 或 Unit Handler 装饰器。
5. 普通错误使用业务错误码；框架错误码小于 10000。

小型 Scene 仍可使用方法级 `@rpc/@message`。当协议超过少量时应拆为独立 Handler，避免 Scene 同时承担路由、状态和业务实现。

- Scene 消息：`@rpcHandler(SceneType, rpc)` / `@messageHandler(SceneType, message)`。
- 客户端连接消息：`@sessionRpcHandler(SceneType, rpc)` / `@sessionMessageHandler(SceneType, message)`。
- 发给具体 Unit：`@unitRpcHandler(UnitType, rpc)` / `@unitMessageHandler(UnitType, message)`。

Unit Handler 参数直接是目标 Unit，不允许再从 MapHost 遍历地图定位。Session Handler 直接取得连接 Session，不要另建平行的 session Map 或 `LoginActor`。

## 选择调用目标

- 全局唯一：`this.scenes.callOne("Rank", ...)`。
- 多实例：`many("Gate")` 后做负载均衡，再 `call(target, ...)`。
- 已绑定实例：`byName(player.gateName)`。
- 通知：`send`，不要伪造无意义 RPC Response。

## 选择客户端广播语义

普通离散消息仍使用 RPC、Message 或单连接 Push。只有需要向一组在线玩家扇出的消息才声明广播语义：

- `event`：技能释放、掉落、进入、离开等事实。每一条都必须送达调度器，队列满会显式报错，不允许静默覆盖。
- `latest`：位置、朝向、血条等可覆盖状态。相同 `key` 在前一批仍在途时只保留最新值。

在客户端消息 Proto 上声明一次，descriptor 由 codegen 生成：

```proto
// @ets.msg protocol=Client method=EntityMove
// @ets.broadcast mode=latest item=CellMovementState items=movements key=unit_id tick=server_tick
message G2C_EntityMove // IMessage
{
  uint32 server_tick = 1;
  repeated CellMovementState movements = 2;
}

// @ets.msg protocol=Client method=SkillUsed
// @ets.broadcast mode=event
message G2C_SkillUsed // IMessage
{
  uint32 caster_id = 1;
  uint32 skill_id = 2;
}
```

业务代码只决定 Audience 和内容：

```ts
await this.broadcast.Publish(
  audience,
  ClientBroadcasts.SkillUsed,
  { casterId, skillId },
  serverTick,
);
```

`BroadcastAudience` 的 `key` 表示可复用的可见集合，`routes` 只包含 Gate 路由名和 UnitId。地图 AOI、公会在线成员等领域代码负责产生 Audience；Core 负责 protobuf 编码、latest 合并、event 排队、single-flight 和指标；通用 `S2G_ClientBroadcast` 负责按 Gate 批量下行。新增广播业务不再定义对应的 `M2G_Xxx` 和 Gate Handler。

Audience 与广播语义互相独立。同一个技能事件可以发给地图 AOI、队伍或公会；同一批收件人也可以同时接收 event 和 latest。不要把“谁能看到”写进 BroadcastHub。

## 新增客户端 Push Handler

1. 在 proto 定义服务端 Push，并运行 `npm run codegen` 生成 Message Descriptor。
2. 在客户端 `Demo/<domain>/Handlers/XxxHandler.ts` 创建独立 Handler。
3. 使用 `@clientMessageHandler(DomainMessageScope, ClientMessages.Xxx)` 声明作用域和消息。
4. Handler 调用领域 Context 的明确方法，不在 Handler 中创建 Cocos Node 或保存长生命周期状态。
5. 再次运行 `npm run codegen`，生成的 `Generated/Hotfix/handlers.ts` 会自动导入 Handler。
6. 领域进入时创建 `ClientMessageDispatcher`，退出时调用 `dispose()`。

`RpcSocket.on` 保留为 SDK 底层能力，不作为大型业务的默认组织方式。SDK Core、Generated 协议和 Demo Handler 分层不能互相倒置：Core 不得导入 Cocos 或 Demo，Generated 不写业务逻辑。

## 选择 mailbox

- 共享强一致状态：ordered Scene。
- 连接消息默认并发：入口Scene与Session均为unordered；共享状态事务按账号、队伍等稳定Key显式加协程锁。
- 不同玩家独立：入口Scene unordered，玩家继承ActorUnit并显式ordered。
- 地图批量实体：怪物、NPC等直接继承Unit，不声明`@actor`，由所属Component的固定更新桶驱动。
- CPU 密集任务：拆分 Process 或下沉专用 worker，unordered 不会产生多线程 CPU 并行。

## 管理 Component

- 在 Scene、Session 或 Unit Factory 中显式调用 `AddComponent(Type, ...awakeArgs)`，由创建位置决定实体具备哪些能力。
- 普通Unit和ActorUnit都由`UnitComponent.Create(unitId, UnitType, ...awakeArgs)`创建；框架根据`ActorUnit + @actor`决定是否建立Mailbox，业务不得分叉创建流程。Session由网络连接和Session Handler按需创建。
- `Awake` 只初始化同步状态；需要数据库或 RPC 时，由 Factory 在发布 Entity 前显式等待。
- 运行期能力同样使用 `AddComponent` 与 `RemoveComponent` 动态开关。
- 必需依赖使用 `GetComponent(Type)`，可选依赖使用 `TryGetComponent(Type)`。
- Component 负责聚合状态和领域能力；一个 Handler 可以协调多个 Component，不要求 Handler 挂在某个 Component 上。
- 只有持有定时器、订阅或宿主句柄的 Component 才覆写 `OnDestroy()`，纯数据组件不写空生命周期方法。

## 编写业务调用链

推荐结构是“Handler 薄适配，Entity 做功能胶水，Component 实现领域能力”：

```ts
@unitRpcHandler(PlayerUnit, MapProtocol.UseItem)
export class C2M_UseItemHandler {
  handle(unit: PlayerUnit, message: C2M_UseItem): Promise<M2C_UseItem> {
    return unit.GetComponent(ItemComponent).UseItemTransactional(
      message.itemId,
      message.operationId,
    );
  }
}

export class PlayerUnit extends Unit {
  UseItem(itemId: number): void {
    this.GetComponent(BagComponent).UseItem(itemId);
    this.GetComponent(SkillComponent).AddSkillByItem(itemId);
  }
}
```

如果 `BagComponent.UseItem()` 已经能够确定新增技能，也可以由它直接取得同一 Unit 上的 `SkillComponent`：

```ts
UseItem(itemId: number): void {
  const unit = this.GetParent<PlayerUnit>();
  const skillId = this.consumeSkillBook(itemId);
  unit.GetComponent(SkillComponent).AddSkill(skillId);
}
```

不要为这条调用链增加 `UseItemSink`、`SkillEventDelegate` 或只转发一次调用的 Component。只有跨 mailbox、跨进程、协议编解码、Location 路由等真实边界才需要框架适配层。

当“是否允许使用”会被死亡、控制、道具CD、公共CD等多个独立模块扩展时，领域Component使用同步Veto Event，而不是让Handler依赖所有模块：

```ts
const reason = unit.DomainScene().Events.Check(ItemEvents.BeforeUse, {
  unit,
  item,
  config,
});
if (reason !== SystemErrCode.Success) throw new RpcError(reason, "item use vetoed");
```

每个规则在Hotfix中实现独立`@vetoEventHandler`，只读状态并返回错误码；全部放行后才执行扣除和Action。不要为每个玩家动态注册闭包，也不要在Veto Handler中修改状态。完整设计见[Veto Event与后台任务设计](../design/veto-events-and-spawn.md)。

推荐的 EntryScene 业务结构：

```text
scenes/MapHostScene.ts                 # 边界、mailbox、组件装配
mapHost/MapHostComponent.ts            # 地图宿主状态与领域方法
mapHost/handlers/G2M_EnterMapHandler.ts # 一个协议入口一个文件
```

新增平级游戏目录（例如 `app/mymmorpg`）时，只要位于 codegen 的 `sceneSearchRoots/handlerSearchRoots` 下，就会自动进入生成导入表。

## 多地图与副本

MapHost EntryScene 创建多个动态 MapScene，每个 MapScene 挂载 `UnitComponent` 和拥有单图行为的 `MapComponent`。玩家、怪物、NPC 都创建为 Unit；低负载地图共享一个 Process，需要扩容时增加 MapHost 实例，并由 Directory/Location 决定具体 Scene。不要为每只怪物创建顶层 EntryScene。

查询规则：

- Actor 消息：InstanceId -> ProcessHost.Root，O(1)。
- 地图业务：UnitId -> 当前 MapScene.UnitComponent，O(1)。
- 登录重连：account -> PlayerDirectory 辅助索引，O(1)。
- 不允许遍历 MapHost 的全部地图查找 Unit。

## 部署拆分

只调整 `scenes` 归属和 `knownScenes` 地址，不修改 Handler 调用。提交前运行 `npm run test:runtime`，同时验证 all-in-one 与 split。
