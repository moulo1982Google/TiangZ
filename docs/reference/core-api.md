# Core API 参考

业务代码统一从`app/core/public.ts`导入本页API，不得依赖Core实现文件的深层路径。Stable、Experimental、Internal和Generated分级及变更流程见[公共API与版本稳定性](api-stability.md)。

## ProcessRuntime

- 一个 OS Process 创建一个实例。
- 按配置创建多个 EntryScene。
- 根据 Rust 事件元数据中的 `sceneIndex` 分发连接帧。
- 本地 Scene call/send 直接路由；远程调用交给 Host Op。
- 汇总全部 Scene outbound 和 metrics。
- 每次 Runtime Pump 依次推进 Time/Timer、Scene mailbox、固定 Game.Update，最后汇总同一 Pump 产生的 outbound。

## Singleton 与时间系统

- `SingletonRegistry.Add/Get/TryGet/Remove/DestroyAll`：进程级单例容器；同一类型只允许一个实例。
- Core 单例通过强类型静态属性访问，例如 `TimeSystem.Instance`、`TimerSystem.Instance`、`Game.Instance`。
- `TimeSystem.FrameTime/DeltaTime`：V8 单调时钟及本次 Runtime Pump 间隔，适合耗时和游戏定时。
- `TimeSystem.ServerNow`：Unix 毫秒墙上时间，适合日期、活动开放时间和日志。
- `TimeSystem.FixedTime/FixedDeltaTime/FrameCount`：当前固定游戏帧时间、固定步长和累计帧数。

业务单例可以继承 `Singleton`，在 Process 启动阶段注册。不要在模块加载阶段偷偷创建单例，也不要用单例替代应归属 Scene、Actor 或 Component 的业务状态。

## TimerSystem 与 IUpdate

- `TimerSystem.NewOnceTimer(delayMs, callback)`：创建一次性游戏定时器。
- `TimerSystem.NewRepeatedTimer(intervalMs, callback)`：创建重复游戏定时器；Process 卡顿时只触发一次并跳过过期周期，不突发补齐。
- `TimerSystem.Remove(timerId)`：取消定时器。
- `TimerSystem.WaitAsync(delayMs)`：等待游戏时钟推进；它不是 Rust/Tokio IO 超时。
- Component 实现同步 `Update(): void`、`LateUpdate(): void` 或 `FrameFlush(): void` 后，会在 `AddComponent` 成功时自动注册，在 `RemoveComponent`/销毁时自动注销。每个固定逻辑帧严格按 `Update -> LateUpdate -> FrameFlush` 执行，三个阶段都禁止返回 Promise。
- `Component.NewOnceTimer/NewRepeatedTimer/RemoveTimer`：定时器随组件销毁自动清理。
- `Actor.NewOnceTimer/NewRepeatedTimer/RemoveTimer`：回调先进入 Actor 自己的 mailbox；ordered Actor 忙碌时排队，Actor 销毁时自动取消。

`IUpdate.Update()` 不允许返回 Promise。需要异步串行语义时使用消息或 Actor 定时器，让它进入 mailbox；不要在每帧 Update 内堆积未完成的异步任务。

## StateReplicationSystem

- `Add(source)`：注册一个具名的编码状态来源；同名来源会被拒绝。
- `source.Peek()`：返回 `itemCount/frame/Ack`，Peek 不允许提前清除 Dirty。
- `FrameFlush()`：取得当前 Audience，把所有非空 Delta 交给 `BroadcastHub` 的 latest single-flight 通道。
- 只有发送成功才调用 `Ack()`；发送失败保留 Dirty，下一帧重新 Peek。
- Snapshot 和 Event 不注册为状态来源：Snapshot 直接定向发送完整值，Event 使用 `BroadcastHub` 的 event 描述符可靠排队。

## EntryScene

- `self: SceneConfig`：当前入口 Scene 地址。
- `scenes: SceneMessageHelper`：Scene 发现与 call/send。
- `processHost: ProcessHost`：创建动态 Scene、Actor、Component。
- `mailbox`：`ordered` 或 `unordered`，默认 ordered。
- `sendClient(connectionId, descriptor, message)`：向客户端连接推送消息。
- `childSceneId(localId)`：生成入口 Scene 范围内唯一的子 Scene ID。
- EntryScene 也继承 `Entity`，可使用 `AddComponent/GetComponent/RemoveComponent` 组织业务能力。

## 装饰器

- `@entryScene(name?)`：注册 EntryScene；省略时去掉类名末尾 `Scene`。
- `@rpc(descriptor)`：绑定 RPC Handler。
- `@message(descriptor)`：绑定单向 Message Handler。
- `@rpcHandler(SceneType, descriptor)`：把独立 Handler class 绑定到指定 EntryScene 的 RPC。
- `@messageHandler(SceneType, descriptor)`：把独立 Handler class 绑定到指定 EntryScene 的单向消息。
- `@sessionRpcHandler(SceneType, descriptor)` / `@sessionMessageHandler(...)`：绑定客户端连接消息，Handler 直接取得 Session。
- `@unitRpcHandler(UnitType, descriptor)` / `@unitMessageHandler(...)`：绑定 Unit 消息，Handler 直接取得 Unit。
- `@scene/@component`：注册 Scene 与 Component 元数据。Session 和 Unit 默认使用 ordered mailbox，业务不需要 `@actor`。

`@rpc/@message` 方法装饰器继续兼容小型 Scene。业务增长后优先使用独立 Handler class；Scene、Session、Unit 三类 Handler 分别表达目标身份，不要求开发者理解内部 Actor 基类。相同目标类型、相同 msgcode 重复绑定会在启动前抛错。

## SceneMessageHelper

- `one(type)`：返回唯一实例，否则抛 `SceneNotFound/AmbiguousScene`。
- `optionalOne(type)`：允许不存在，但不允许多个。
- `many(type)`：返回全部实例。
- `byName(name)`：按实例名查找。
- `call/callOne/callOptionalOne`：RPC。
- `send/sendOne`：单向消息。
- `callActor/sendActor`：已知目标 EntryScene 与 InstanceId 时直接发送 Actor 消息。

## ProcessHost

- `spawnScene/despawnScene`。
- `spawnActor(sceneId, actorId, Type, ...awakeArgs)/despawnActor`；Actor 参数由其 `Actor<[...args]>` 类型约束，并由框架同步调用一次 `Awake`。
- `Root.Get(instanceId)`：O(1) 获取当前生命周期 Entity。
- `runActorMailbox(instanceId, callback)`：Session/Unit Handler 与 Actor 定时器共用的类型化 mailbox 底层入口。

普通业务不直接调用 `ProcessHost`。内部 Scene 通讯使用 `SceneMessageHelper` 和生成 descriptor；Session/Unit 消息由类型化 Handler 自动进入目标 mailbox。Runtime 不再提供 `@handler("字符串")`、`ProcessHost.call/send` 这条旁路。

## Unit 与 UnitComponent

- `Unit` 继承 Actor，玩家、怪物和 NPC 使用同一实体基类。
- `Unit.Id/UnitId` 是业务 ID；`Unit.InstanceId` 是本次生命周期 Actor 地址。
- `Unit.Parent` 指向所在地图的 `UnitComponent`。
- `Unit.DomainScene()` 直接取得所在动态 MapScene。
- `UnitComponent.Create/Get/Remove/GetAll` 按 UnitId 管理地图全部 Unit。
- Unit 销毁必须经过 UnitComponent/ProcessHost，保证 Unit 集合、Root 和 mailbox 同步移除。
- `MailBoxComponent` 挂在每个 Actor 上，当前支持 ordered/unordered。

## Entity 与 Component

- `EntryScene`、动态 `Scene` 和 `Actor` 都继承 `Entity`，可以持有多个不同类型的 Component。
- `AddComponent(Type, ...awakeArgs)`：创建组件并同步调用 `Awake`；参数由 Component 的元组泛型约束，同类型只允许一个实例。
- `GetComponent(Type)`：获取必需组件，不存在时抛错。
- `TryGetComponent(Type)/HasComponent(Type)`：查询可选组件。
- `RemoveComponent(Type)`：移除组件并执行其 `OnDestroy()`。
- `despawnActor` 会销毁 Actor 的全部组件；业务层不直接调用内部 `__dispose()`。
- 所有业务组件统一继承 `Component`。挂载目标由 `entryScene.AddComponent(...)`、`mapScene.AddComponent(...)` 或 `unit.AddComponent(...)` 决定。
- Component 通过 `GetParent<T>()` 取得直接宿主，通过 `DomainScene<T>()` 取得所属动态 Scene；不提供按宿主拆分的 Component Context。
- EntryScene 的协议 Handler 绑定在 Scene 类型上，再通过 `scene.GetComponent(...)` 协调一个或多个组件；组件本身不承担网络路由注册。
- Component `Awake` 只做同步初始化；异步加载由业务 Factory 编排。
- Component 实现 `Update(): void` 即自动参加固定游戏帧，不需要手工维护 Update 列表。
- Component 自有定时器在组件销毁时自动取消；挂在 Actor 上的组件定时器还会遵循 Actor mailbox。

精确泛型签名以`app/core/public.ts`及其引用的类型定义为准。新增公共API时显式更新API锁，并同步更新本文档、教程和两份AI交接文档。
