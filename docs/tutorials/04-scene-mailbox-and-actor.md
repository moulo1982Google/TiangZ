# Scene 通信、Mailbox、Actor 与 Component

## Scene 发现与调用

```ts
await this.scenes.callOne("Rank", RankProtocol.Query, request);

const gates = this.scenes.many("Gate");
const gate = gates[hash(account) % gates.length];
await this.scenes.call(gate, GateProtocol.Bind, request);

await this.scenes.send(
  this.scenes.byName(player.gateName),
  GateMessages.MapReady,
  message,
);
```

- `callOne` 用于全局唯一 SceneType。
- `many` 用于 Gate、Login、MapHost 等多实例类型。
- `byName` 用于玩家已经绑定到具体 Gate/MapHost 的情况。
- `knownScenes` 是路由目录，目标是否本地由框架判断。

## 本地与远程

同进程调用由 `ProcessRuntime` 直接进入目标 EntryScene mailbox，不经过 TCP。跨进程调用由 Rust 使用目标 Scene 的 IP/port，通过持久 Inner TCP 发送。两条路径使用同一 msgcode、protobuf、rpcId、错误码和 Handler。

业务层禁止手工根据 IP 判断部署位置。

## ordered 与 unordered

配置 Scene、动态 Scene、Session、Unit 都可以是 mailbox owner：

- `ordered`：当前 Handler 完成前不开始下一条消息，包括跨越 `await`。
- `unordered`：异步 Handler 可以重叠；同步 CPU 代码仍串行执行。

`LoginScene` 选择 unordered，避免一个连接的 IO 等待阻塞其他连接；每个 Session 默认 ordered，保证同一连接串行。若同一账号允许从多个连接同时登录，账号级互斥应由账号领域锁或 Location 处理，不能把账号永久包装成 `LoginActor`。

业务 Handler 按目标只有三种：

- Scene Handler：处理发给业务 Scene 的消息。
- Session Handler：处理客户端连接消息，直接取得该连接 Session。
- Unit Handler：处理发给玩家、怪物、NPC 的消息，直接取得目标 Unit。

Actor只是这三类 mailbox 目标的统称和底层路由术语，不是业务必须继承的第四种类型。

## 为什么 send 不等待 Handler

```text
Gate call MapHost.EnterMap
MapHost send Gate.MapReady
MapHost return EnterMap response
```

如果本地 `send` 等待 Gate Handler，而 Gate ordered mailbox 正在等待 MapHost RPC，就会形成调用环。框架的单向 `send` 只保证目标 mailbox 接受消息，不等待执行；异步错误由目标 Scene 记录。

## EntityRoot、Unit 与 Component

`ProcessHost.Root` 是进程级 Entity 索引，对应 ET 的 `Root.Instance`。每个动态 Scene/Actor 都有：

- `Id`：业务身份；Unit 的 Id 就是 UnitId。
- `InstanceId`：本次对象生命周期身份，由 ProcessHost 分配。
- `Parent`：Unit 的 Parent 是地图 `UnitComponent`。
- `DomainScene()`：直接返回 Unit 所属的 MapScene。

同一个 UnitId 被销毁后可以重新创建，但新旧 InstanceId 必须不同。Actor 消息使用 InstanceId 寻址，因此迟到消息不会命中新对象。

玩家、怪物和 NPC 都应继承 `Unit`。MapScene 挂载一个 `UnitComponent`，通过 `Create/Get/Remove/GetAll` 统一管理，不再为玩家、怪物各维护一套集合：

```ts
const units = map.AddComponent(UnitComponent);
const player = units.Create(unitId, PlayerUnit, awakeArgs);

units.Get<PlayerUnit>(unitId);
player.DomainScene<MapScene>();
units.Remove(unitId);
```

Unit 同时也是 Actor：Unit 决定身份、生命周期和 mailbox；Component 承载状态与领域能力；Handler 可以组合多个 Component。

Item、Buff、动态Quest等需要独立身份和生命周期、但不需要接收网络消息的对象继承`ChildEntity`。它们由Component创建和拥有：

```ts
const buffs = player.GetComponent(BuffComponent);
const buff = buffs.AddChild(Buff, buffInstanceId, awakeArgs);

buffs.GetChild(Buff, buffInstanceId);
buffs.TryGetChild(Buff, buffInstanceId);
buffs.GetChildren(Buff);
buffs.RemoveChild(Buff, buffInstanceId);
```

ChildEntity进入`EntityRoot`并具有真实`InstanceId`，Parent是所属Component，DomainScene是玩家所在地图；它没有mailbox，也不会进入Actor路由。Component移除或玩家销毁时，子Entity、其Component、Timer和Native handle按所有权链级联释放。业务不得直接`new Buff()`或调用内部销毁入口。

`Scene` 和 `Actor` 都继承 Core 的最小 `Entity`，组件由 Entity 按具体 class 作为 key 管理：

```ts
const position = player.AddComponent(PositionComponent, x, y);
const inventory = player.AddComponent(ItemComponent);
player.GetComponent(ItemComponent).Add(item);
player.RemoveComponent(ItemComponent);
```

- `AddComponent(Type, ...args)`：创建并返回组件，由框架同步调用组件的 `Awake(...args)`；参数由组件类型检查，同类型重复添加会抛错。
- `GetComponent(Type)`：返回必需组件；不存在时抛错，避免业务代码到处写非空断言。
- `TryGetComponent(Type)`：查询可选组件，不存在时返回 `undefined`。
- `HasComponent(Type)`：只判断是否存在。
- `RemoveComponent(Type)`：删除组件并返回是否真的删除。

组件不按宿主类型区分基类，也不在构造函数里接收 Scene/Actor 专用 Context。业务初始化参数交给 `Awake`：

```ts
export class PositionComponent extends Component<[
  x: number,
  y: number,
]> {
  protected override Awake(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }
}
```

`Awake` 必须同步完成且只执行一次。数据库读取、远程 RPC 等异步初始化由 Factory 显式 `await`，完成后再把 Entity 发布到地图或 Location；框架会拒绝 `async Awake`，避免其他消息观察到半初始化对象。业务 `Awake` 写在Hotfix的`@systemFor`类中，Core仍只保留一套泛型生命周期骨架，不复制ET按参数数量拆分的多套接口。

Actor 自身也使用相同模式，创建参数直接传给 `spawnActor`，不需要伪造一条只执行一次的 Initialize 消息：

```ts
export class PlayerUnit extends Unit<[request: AwakePlayerUnit]> {
  protected override Awake(request: AwakePlayerUnit): void {
    this.account = request.account;
  }
}

const player = map.GetComponent(UnitComponent).Create(
  unitId,
  PlayerUnit,
  actorArgs,
);
const native = player.AddComponent(NativeUnitRef, {
  id: unitId,
  instanceId: player.InstanceId,
  mapId,
  x,
  y,
});
player.AddComponent(PositionComponent, native);
player.AddComponent(UnitGateComponent, gateName, gateSessionId);
```

Unit/Component 的 `Awake` 中只设置同步状态和组装组件，不发送消息、不发布 Location。若创建流程还要读取数据库，Factory 应在完成所有 `await` 后再发布到 Location；创建失败时由 UnitComponent 删除 Unit，其组件会被级联清理。

JavaScript 的 GC 会回收普通对象内存，因此纯状态组件不需要销毁代码。组件持有定时器、事件订阅或宿主资源时，可以覆写受保护的 `OnDestroy()`；`RemoveComponent` 和 `UnitComponent.Remove` 会自动调用它。业务代码不直接 Dispose Unit，否则会让 Root、UnitComponent 与 mailbox 路由脱节。

## 固定 Update 与游戏定时器

需要每个固定游戏帧执行的组件直接实现 `Update()`。框架会在组件 Add/Awake 成功后自动注册，移除组件时自动注销：

```ts
export class MonsterPatrolComponent extends Component implements IUpdate {
  protected override Awake(): void {
    this.NewRepeatedTimer(1000, "ChooseNextTarget");
  }

  Update(): void {
    const dt = TimeSystem.Instance.FixedDeltaTime / 1000;
    this.MoveTowardTarget(dt);
  }

  protected ChooseNextTarget(): void {
    // 选择新的巡逻点
  }

  private MoveTowardTarget(_dt: number): void {}
}
```

`Update()` 必须同步，不要标记为 `async`。定时器可由Component或ChildEntity持有，所有者销毁后自动取消。它们挂在Unit或Session之下时，回调会进入所属Entity的mailbox：ordered mailbox正在等待异步Handler时，定时器回调会排队，不会重入状态。高数量Buff不要各自创建常驻重复Timer，应由BuffComponent合并调度最近到期项。

`TimerSystem.WaitAsync` 使用游戏 Pump 推进，适合业务时间；网络超时、文件 IO 等基础设施等待仍使用 Rust/Tokio 提供的 `ctx.sleep` 或对应 Host API。

## ActorLocation 直达 Unit

ActorLocation 保存的是 `MapHost EntryScene + Unit InstanceId`，不是只保存 UnitId。目标进程收到 Envelope 后执行：

```text
ActorLocationEnvelope(instanceId)
-> ProcessHost.Root.Get(instanceId)
-> UnitMessageDispatcher
-> Unit.MailBoxComponent
-> @unitMessageHandler / @unitRpcHandler
```

Unit Handler 直接取得 Unit：

```ts
@unitMessageHandler(PlayerUnit, MapMessages.Move)
export class C2M_MoveHandler {
  async handle(unit: PlayerUnit, message: C2M_Move): Promise<void> {
    const result = unit.Move(message);
    if (!result.accepted) return;
    await unit.DomainScene<MapScene>()
      .GetComponent(MapComponent)
      .PlayerMoved(unit, result.snapshot);
  }
}
```

它不先进入 MapHost Handler，也不按账号或 UnitId 扫描地图。

这里的 `MapComponent` 直接实现单张地图的 Unit 管理、AOI 与广播，不再回调 `MapUnitEventSink`。`MapHostComponent` 只负责创建多张地图和协调玩家跨图，不承载单张地图内部行为。

多个同类型 EntryScene 共享一个 ProcessHost。使用 `this.childSceneId("map:1")` 为子 Scene 加上入口 Scene 命名空间，避免不同 MapHost 创建同名子 Scene。
