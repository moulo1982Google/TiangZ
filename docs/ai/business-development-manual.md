# TiangZ AI 业务开发手册

本文面向承担TiangZ业务需求的AI和开发者。目标是用已有Scene、Session、Unit、Component、协议、状态复制和Client SDK完成业务，不把普通需求升级成框架或Rust Runtime改造。

维护契约：任何架构、目录边界、数据所有权、协议语义或业务开发流程的设计变更，都必须同时更新本文和[AI项目上下文](project-context.md)。设计改动未同步这两份文档，视为尚未完成。

## 默认立场

收到“新增技能、背包、公会、地图、怪物、任务”等业务需求时，默认修改范围是：

```text
app/model/demo/       新增或改变状态、字段、构造、继承和稳定类型时
app/hotfix/demo/      普通Handler与可热更领域行为
proto/
cocos_client2D/assets/scripts/Demo/
pixi_client/src/
configs/
tests或tools中的对应业务自测
```

默认不要修改：

```text
app/core/
src/
tools/codegen_*.mjs
app/generated/
src/generated/
客户端 Generated/
```

测试辅助代码同样不能放进`app/core`、`app/model`或`app/hotfix`。裸帧构造、压测Codec包装、Fake和Fixture应放到`tools/support`、`perf`或对应自测文件；普通业务不得依赖这些目录。客户端正式调用统一使用`client_sdk`生成的Client和Push Handler。

基准Scene放在`app/model/bench`，压测专用Handler放在`app/hotfix/bench`，并通过`npm run build:bench`显式装配。正常`npm run build`不得包含Bench Scene/Handler；Cocos/Pixi分发SDK也不得携带Bench协议。

Bench Hotfix可以通过`#tiangz/model`调用真实业务API，但Demo不得引用Bench。正式、压测等装配分别写在`app/model/main*.ts`与`app/hotfix/main*.ts`；不要为了消除依赖诊断把Bench实现搬回Demo。

只有现有公共能力无法表达需求时才进入Core。只有明确的数据所有权或性能证据支持时才进入Rust或`native_data`。开始修改前必须能用一句话说明业务边界和权威状态归属。

Model代码只从`app/core/public.ts`导入Core能力。Hotfix代码只能从`#tiangz/model`取得Model类型、协议和Stable Core API；禁止深层导入`app/model`或`app/core`。其他Core路径属于Internal，即使当前可以被TypeScript解析，也不能直接依赖。Stable API需要调整时，按[公共API与版本稳定性](../reference/api-stability.md)完成影响说明、迁移、显式API锁更新和验证。

## Model与Hotfix怎么选

- 新增字段、默认值、构造参数、继承关系、Scene/Entity/Component类型：写`app/model`，完整构建并重启Process。
- 新增或修改Handler、校验、流程编排和领域方法实现：写`app/hotfix`，可使用Hotfix-only构建。
- Hotfix通过`@systemFor(ModelType)`提供生命周期和领域方法；System没有字段、构造函数或静态成员，也不会被实例化。
- Model不手写“System未安装”的抛错空壳。codegen从System公开方法生成`app/generated/bootstrap/systems/*.d.ts`，调用方仍直接写`unit.Move()`或`component.UseItem()`。
- System公开方法必须显式写参数和返回类型。只改方法体可热更；修改公开签名会改变Model声明，必须完整构建并重启。
- `Awake/OnDestroy`可写在System中。Reload不重跑现有对象的`Awake`；新对象使用新版本Awake，现有对象后续方法和销毁使用当前generation。
- Model绝对不能在线热更，不设计字段migration。`npm run build:hotfix`拒绝时，说明这次改动已经越过行为边界，不能规避检查。
- `npm run build:hotfix`生成`dist/hotfix-candidates/<hash>`不可变候选，不覆盖当前Bundle。在Watcher终端输入`reload <候选目录>`才会触发每个Process独立校验和提交；禁止手工覆盖`dist/hotfix.js`。

## 第一步：给需求分类

| 需求 | 默认落点 |
|---|---|
| 玩家能力、背包、技能、任务 | PlayerUnit上的业务Component |
| 地图规则、玩家集合、怪物刷新 | MapScene上的Component |
| 登录、Gate、排行榜、社交 | EntryScene和其Component |
| 一个网络入口 | 独立Handler文件 |
| 新请求或通知 | proto源文件，再codegen |
| 客户端收到Push后的行为 | 客户端独立Handler和领域Context |
| 可覆盖属性同步 | Delta/latest，通常FrameFlush |
| 不可丢事实 | Event，立即可靠排队 |
| 进入或重连 | Snapshot |
| 高频跨帧权威数据 | 先测量，再考虑`.native` |
| 网络、mailbox、背压 | Core/Rust维护任务，不是普通业务任务 |

## 第二步：找到最接近的样例

- 玩家创建和组件装配：`app/model/demo/map/MapComponent.ts::CreatePlayer`。
- 玩家Unit：`app/model/demo/map/PlayerUnit.ts`。
- Unit RPC：`app/hotfix/demo/mapHost/handlers/C2M_UseItemHandler.ts`。
- Unit Message：`app/hotfix/demo/mapHost/handlers/C2M_MoveHandler.ts`。
- Session RPC：`app/hotfix/demo/gate/handlers/C2G_LoginGateHandler.ts`。
- EntryScene RPC：`app/hotfix/demo/mapHost/handlers/G2M_EnterMapHandler.ts`。
- Numeric字典Delta：`app/model/demo/numeric/NumericComponent.ts`。
- Item即时Event：`app/model/demo/item/ItemComponent.ts`、`app/hotfix/demo/item/ItemComponentSystem.ts`和`C2M_UseItemHandler.ts`。
- 帧尾同步：`app/model/demo/map/MapComponent.ts::FrameFlush`。
- 玩家下线保存：`app/model/demo/persistence/PlayerPersistenceComponent.ts`。
- Model/System领域方法范例：`app/model/demo/login/LoginComponent.ts`与`app/hotfix/demo/login/LoginComponentSystem.ts`。
- 客户端Push：`cocos_client2D/assets/scripts/Demo/Map/Handlers`。
- Scene发现和调用：`app/core/process/SceneMessageHelper.ts`及`docs/guides/business-cookbook.md`。

先复用这些形状，不重新发明Manager、ServiceLocator或事件总线。

## 新增玩家Component

普通业务状态先写TS Component：

```ts
import { Component } from "../../core/public";
import type { PlayerUnit } from "../map/PlayerUnit";

export class SkillComponent extends Component {
  private readonly skills = new Set<number>();

  /** 学习一个尚未拥有的技能，并返回是否发生变化。 / Learns a missing skill and returns whether state changed. */
  AddSkill(skillId: number): boolean {
    if (this.skills.has(skillId)) return false;
    this.skills.add(skillId);
    return true;
  }

  private player(): PlayerUnit {
    return this.GetParent<PlayerUnit>();
  }
}
```

在玩家Factory中装配，而不是在Handler中临时添加：

```ts
player.AddComponent(SkillComponent);
```

使用时：

```ts
unit.GetComponent(SkillComponent).AddSkill(skillId);
```

约束：

- `Awake`只做同步初始化。
- Component持有的定时器、订阅或句柄在`OnDestroy`释放。
- 纯数据组件不写空`OnDestroy`。
- 同类型组件只挂一个；可选依赖使用`TryGetComponent`。
- 不直接`new SkillComponent()`，必须走`AddComponent`，否则绕过生命周期和Update注册。

## Component下的多个业务对象

道具、任务和成就都遵循同一个所有权规则，但不强制使用相同的数据形状：

```text
PlayerUnit
├── ItemComponent          -> Map<ItemId, NativeItemRef>
├── QuestComponent         -> Map<QuestId, QuestState>
└── AchievementComponent   -> Map<AchievementId, AchievementState>
```

`XXXComponent`拥有集合并负责所有会改变业务结果的操作。业务代码不能访问它的可变`Map`，也不能从Handler直接修改Native Ref。Entity不等于Actor：Item即使是Entity，也没有mailbox，不能作为跨Process消息目标。

### 什么时候创建子Entity

满足以下任一条件时，优先使用有稳定实例ID的子Entity：

- 同一配置可能产生多个不同实例。
- 对象有强化、耐久、绑定、随机词条、锁定等独立状态。
- 对象有独立创建、销毁、持久化或计时生命周期。
- 其他领域需要稳定引用这个具体实例。

如果数据只由配置ID唯一确定，并且只有进度、状态或数量，优先使用普通State、Map、数组或Numeric。普通Quest和Achievement默认不创建Entity；可重复任务、动态任务实例或独立计时任务再升级。

### 查询对象，修改经过Component

读取一件道具时可以取得短期只读视图：

```ts
const items = unit.GetComponent(ItemComponent);
const item = items.GetItem(itemId);
if (item?.quality === 5) {
  // 只读取，不长期保存item。
}
```

业务修改必须经过拥有它的Component：

```ts
const changed = items.UseItem(itemId);
items.AddItem(itemId, 10);
items.RemoveItem(itemId, 2);
```

禁止：

```ts
// 错误：绕过数量校验、版本、持久化和客户端通知。
item.count -= 1;
```

道具自身的局部规则可以由Item方法实现，例如改变耐久或锁定状态；涉及集合所有权的新增、删除、拆分、合并、换格和转移始终由`ItemComponent`协调。跨Component业务由PlayerUnit领域方法或Handler协调，例如先让`ItemComponent`消费技能书，再调用`SkillComponent.AddSkill`，不要让SkillComponent直接删除背包数据。

`ItemView`只用于当前同步调用中的读取，不能跨`await`、Timer或玩家下线长期保存。协议和持久化边界分别复制为`ItemSnapshot`和`ItemRecord`；不要把运行时对象命名为`ItemDB`，也不要把可变Native句柄直接序列化。

## 编写Handler

Handler只负责协议适配、基础校验和调用领域能力。先按消息目标选择唯一对应的形状：

| 目标 | 装饰器 | Handler首个业务对象 |
|---|---|---|
| 配置Scene | `@rpcHandler/@messageHandler` | Scene |
| 客户端连接 | `@sessionRpcHandler/@sessionMessageHandler` | Scene、Session |
| 玩家/怪物/NPC | `@unitRpcHandler/@unitMessageHandler` | Unit |

不要新增泛化`XxxActor`来承接普通业务请求。连接状态放Session，地图实体状态放Unit，全局业务状态放Scene或其Component。Unit消息直接拿到目标Unit：

不要使用字符串`@handler`、`ProcessHost.call/send`或给Component动态注册网络入口；这些旧旁路已从Runtime移除。Scene间调用使用`SceneMessageHelper`，Session/Unit入口使用上表中的类型化Handler。

```ts
@unitRpcHandler(PlayerUnit, MapProtocol.UseItem)
export class C2M_UseItemHandler implements UnitRpcHandler<
  PlayerUnit,
  C2M_UseItem,
  M2C_UseItem
> {
  async handle(unit: PlayerUnit, request: C2M_UseItem): Promise<M2C_UseItem> {
    const item = unit.GetComponent(ItemComponent).UseItem(request.itemId);
    await unit.DomainScene().GetComponent(MapComponent).PublishItemChanged(unit, item);
    return { item };
  }
}
```

不要这样做：

```ts
// 错误：已经得到Unit，又遍历所有地图查找玩家。
const unit = mapHost.findPlayer(request.account);
```

如果操作天然属于PlayerUnit，可增加简短领域方法协调多个Component：

```ts
UseSkillBook(itemId: number): void {
  const skillId = this.GetComponent(ItemComponent).UseSkillBook(itemId);
  this.GetComponent(SkillComponent).AddSkill(skillId);
}
```

不要增加只转发这一次调用的`UseItemSink`、`MapUnitEventSink`或Delegate。

## 新增协议

选择正确基类：

- 需要Response：`IRequest/IResponse`或`IActorLocationRequest/IActorLocationResponse`。
- 单向通知：`IMessage`、`IActorMessage`或`IActorLocationMessage`。
- 发给当前玩家Unit：优先ActorLocation类型。
- 服务端向客户端推送：`IMessage`，并声明`@ets.msg protocol=Client`。

示例：

```proto
//ResponseType M2C_UseSkill
// @ets.msg protocol=Map method=UseSkill
message C2M_UseSkill // IActorLocationRequest
{
  uint32 skill_id = 1;
}

message M2C_UseSkill // IActorLocationResponse
{
  uint32 skill_id = 1;
}
```

步骤：

1. 在正确proto源文件追加定义，不手工填写生成TS/Rust代码。
2. 评审消息类型、Response关联、字段编号和兼容性。
3. 新消息编号需要接受时，显式执行`npm run codegen:proto:update-lock`。
4. 执行`npm run codegen`。
5. 服务端只从`app/generated/model/server`导入；客户端、工具和压测客户端只从`client_sdk/typescript/Generated`导入。
6. 执行`npm run test:protocol`和相关业务测试。

不得手工修改`opcode.lock.json/schema.lock.json`来绕过生成器，也不得在业务代码中硬编码msgcode、rpcId或codec。

## EntryScene、动态Scene和Actor怎么选

使用EntryScene的情况：

- 需要配置启动和跨进程寻址。
- 是独立的顶层业务域，例如Rank、Social、Gate、MapHost。
- 需要部署多个实例并由Directory或业务负载均衡。

使用动态Scene的情况：

- 地图实例、副本实例等进程内业务容器。
- 大量低负载实例需要共享一个Process/V8。

使用Actor/Unit的情况：

- 消息需要以某个Entity为串行和生命周期边界。
- 玩家、怪物、NPC等具体地图实体。

使用Component的情况：

- 给Scene或Unit组合一项状态和领域能力。
- 它不需要成为独立部署和网络寻址边界。

不要为每张地图、每只怪物、每个组件创建EntryScene。

## Scene调用规则

```ts
// 全局恰好一个实例
await this.scenes.callOne("Rank", RankProtocol.Query, request);

// 多实例，业务选择具体目标
const gates = this.scenes.many("Gate");
const gate = chooseGate(gates, account);
await this.scenes.call(gate, GateProtocol.Bind, request);

// 已保存实例名
await this.scenes.send(
  this.scenes.byName(player.gateName),
  GateMessages.MapReady,
  message,
);
```

- 不在业务代码中判断目标是否同进程。
- `callOne`只用于配置上恰好一个实例的SceneType。
- 多实例必须先明确负载均衡、归属或Location结果。
- `send`成功只表示被本地mailbox接受或进入远程发送队列，不表示目标Handler执行完成。
- 框架自动分配并保留在途`rpcId`；业务不得写入、缓存或复用它。只有确实需要deadline时才传`{ timeoutMs }`，本地默认不为每次调用创建额外timer。
- Actor跨`await`后如果可能已下线或销毁，应检查`IsDisposed`或重新验证权威句柄；JavaScript Promise不能被框架强制终止。

## 选择Snapshot、Delta或Event

先问一句：如果同一个key连续变化两次，只收到最终值是否仍然正确？

- 正确：Delta/latest，例如位置、朝向、HP最终值、速度。
- 不正确：Event，例如使用两次道具、两次技能命中、获得两份奖励。
- 新观察者需要完整当前状态：Snapshot。

### Numeric动态字典

适合开发者维护稳定整数枚举的数值：

```ts
const numeric = unit.GetComponent(NumericComponent);
numeric[NumericType.CurrentHp] += 1;
```

Rust自动维护`NumericType -> i32`值和dirty表，FrameFlush按`(unitId, numericType)`合并。新增NumericType通常不增加协议字段。

### 固定字段Dirty Mask

适合字段集合稳定且类型明确的状态，例如Unit速度、存活和显式传送坐标。在`.native`中使用`@replicated`和稳定`@memberId`，codegen生成setter置脏、强类型Delta和Peek/Ack。

普通业务不得仅为了少写TS就选择Native字段。只有权威状态确实需要Rust保存、批量计算或直接编码时才使用。

`.native`是生成器输入。普通业务Entity放在`native_data/<game>`；只有确实需要跨边界粗粒度批处理时，才在同目录新增`XxxOps.native`并实现对应Rust op。`native_data/core`属于框架ABI，业务不得修改。移动等确定性状态机的黄金数据放`tests/fixtures`，不能放进`native_data`伪装成模型定义。

### Item等即时Event

库存、技能命中和奖励是不可覆盖事实。修改权威状态后立即发布event；如果同一次操作还改变可覆盖属性，例如速度，则该属性继续走帧尾Delta。

`ItemComponent`持有`Map<ItemId, NativeItemRef>`，其中`NativeItemRef`已经是Item运行时实体句柄，不需要再增加职责重复的`ItemDB`。外部读取使用`GetItem`返回的`ItemView`，修改使用Component领域方法；只有所属`ItemComponentSystem`可以直接操作可变Native句柄。

## 广播给谁与如何广播

业务层产生`BroadcastAudience`：地图全体、AOI、队伍、公会在线成员等。Core的`BroadcastHub`处理编码、event队列、latest合并、single-flight和指标。

```ts
await this.broadcast.Publish(
  audience,
  ClientBroadcasts.SkillUsed,
  { casterId, skillId },
  serverTick,
);
```

规则：

- 不在BroadcastHub中写地图AOI或公会成员查询。
- 不为每种广播新增`M2G_Xxx`；统一通过`S2G_ClientBroadcast`下行。
- latest descriptor必须有稳定key。
- event队列满必须显式失败，不能静默丢弃。
- AOI尚未完成时可以使用当前Audience实现验证业务，但接口不能假定永久全地图可见。

## 定时器和Update

Component拥有的周期任务使用组件定时器：

```ts
this.NewRepeatedTimer(100, "RegenerateHp");

protected RegenerateHp(): void {
  this[NumericType.CurrentHp] += 1;
}
```

Component和Actor业务Timer必须传方法名，不能传匿名闭包。触发时框架从当前prototype解析方法，因此现有Timer会自然进入新Hotfix generation；Timer仍随owner销毁自动取消。

逐固定帧逻辑实现同步`Update()`，帧末复制实现`FrameFlush()`。不要在Update中创建未等待的异步任务：

```ts
// 错误：每帧都可能堆积一个尚未完成的RPC。
Update(): void {
  void this.scenes.callOne("Rank", descriptor, request);
}
```

需要异步串行时，用Actor定时器或给Actor发送消息，使工作进入其mailbox。

## 玩家下线和持久化

玩家保存应封装在玩家内部的生命周期能力中。断线、踢下线和Process停机共用同一个幂等Promise：

```ts
await player.Offline(reason);
```

业务Handler不要直接调用Repository，否则会绕过幂等保存和统一移除流程。旧Gate Session的断线消息必须校验`gateSessionId`，不能踢掉已重连玩家。

## 客户端业务

RPC使用生成Client：

```ts
const gate = new GateClient(socket);
const response = await gate.enterMap({ mapId: 1 });
```

服务端Push使用独立Handler：

```ts
@clientMessageHandler(MapMessageScope, ClientMessages.ItemChanged)
export class G2C_ItemChangedHandler implements ClientMessageHandler<
  MapEntityManager,
  G2C_ItemChanged
> {
  handle(entities: MapEntityManager, message: G2C_ItemChanged): void {
    entities.applyItem(message.item);
  }
}
```

- 不把所有`socket.on(...)`堆到Manager构造函数。
- Handler只调用领域Context，不持有Cocos Node等长生命周期对象。
- SDK Core不得导入`cc`、Pixi或Demo。
- 修改公共SDK后必须验证Cocos和Pixi分发副本一致。

## 什么时候允许改Core或Rust

满足以下条件之一，才考虑Core：

- 多个互不相关业务域都缺少同一种通用语义。
- 现有API无法保证mailbox、生命周期、背压或错误契约。
- 需求本身就是框架能力，而不是某个游戏功能。

满足以下条件并取得用户确认，才考虑Rust/NativeData：

- 已有基准显示TS或V8边界是主要瓶颈。
- 数据需要跨热更长期存在，并明确由Rust作为唯一权威源。
- 可以设计粗粒度批量op，避免Rust处理后又回调TS取数据。
- 已定义生命周期、generation handle、错误和观测指标。
- 有TS方案或旧方案可进行同口径A/B验证。

不允许以“以后可能更快”为唯一理由修改Rust。

## 日志、错误与注释

- 使用`scene.logger`或领域Logger，附带`process/scene/mapId/unitId`等结构化字段。
- 系统错误码小于10000，业务错误码从10000开始。
- RPC框架错误需要日志和Response；单向Message没有Response，不额外推送无人订阅的通用ErrorResponse。
- 公共与生命周期函数写中英文对照注释，说明副作用、所有权、顺序和不应采用的调用方式。
- 不给简单getter和显然赋值写重复注释。

## 验证矩阵

当前仍处于`0.3.10`框架稳定化阶段。Model/Hotfix双Bundle、`@systemFor`、兼容指纹、Watcher Reload、Rust有界投递屏障、超时拒绝、事务回滚、Prometheus指标、3000玩家1Hz Reload A/B、8秒慢RPC屏障、Timer跨generation和100代资源长稳均已完成。热更按整个Process原子提交Hotfix behavior，现有Entity/Component和Rust handle不重建。Model绝对不能热更；字段、构造、继承、公开System签名、协议或Native schema变化必须完整部署并重启Process，不存在字段migration旁路。完整约束见[热更设计](../design/typescript-hot-reload.md)。

本地只修改Hotfix行为时，可运行`npm run dev -- configs/local/StartMachine.json`后直接保存TS文件；开发宿主会自动生成注册入口、类型检查、构建不可变候选并Reload。构建失败时旧generation继续运行。这个便利入口不适用于Model字段、Core、Proto或`.native`变化，也不用于正式部署。Developer Tools把Model长期状态中的显式`any`、可选字段、基本类型与`undefined`联合、跨基本类型联合、`delete`字段和`as any`写属性视为错误；请使用稳定默认值或明确的数据结构。对象`T | null`、判别联合、显式Map/Record和普通DTO仍可正常使用。

| 修改类型 | 最少验证 |
|---|---|
| 纯TS业务Component/Handler | `npm run typecheck`和对应自测 |
| 只修改Hotfix行为 | `npm run build:hotfix`、`npm run test:hotfix` |
| Model字段、类型、构造或继承 | `npm run build`、相关测试并重启Process；不得使用Hotfix-only |
| proto或客户端Push | `npm run codegen`、`npm run test:protocol`、对应Client测试 |
| Native Entity/字段 | `npm run test:native-data`、`cargo test --all-targets` |
| 状态复制/广播 | `npm run test:map-broadcast`、相关性能基准 |
| 客户端SDK | `npm run test:client-sdk`、`npm run test:client-sdk-distribution`、Cocos/Pixi typecheck |
| Scene部署或跨进程调用 | `npm run test:runtime` |
| mailbox、背压、生命周期 | 完整`npm run verify` |
| RPC、Actor路由或生命周期 | `npm run test:rpc-actor-correctness`和完整`npm run verify` |
| 异常恢复、连接清理或持久化失败 | `npm run test:fault-injection` |
| 一般合并前质量门 | `npm run verify:quick` |
| 框架热路径或Runtime优化 | `npm run verify:perf`，背压和长稳按改动风险另跑 |
| Release候选 | `npm run audit:dependencies`、`npm run verify`、`npm run release:package` |

性能结果必须注明机器、配置、玩家数、Gate数、频率、持续时间、是否AOI以及指标口径。不要把Probe基线或全地图可见Demo结果描述为正式业务容量。

Native字段可用`@hot`和`@cold`表达Rust存储温度，但这属于Model/schema设计，不是业务Hotfix。`@hot`只用于每Tick确实会连续扫描的最小字段集；低频字段和未标记字段不应为了猜测性能全部标热。codegen负责生成类型池和冷热访问器；业务仍只通过`NativeXxxRef`与粗粒度op访问数据，不直接引用`XxxHotData`、`XxxColdData`、保存Rust池索引或管理Pool。修改冷热归属后运行`npm run perf:native-storage`与`npm run test:native-data`，并完整重启Process。

Cocos业务脚本提交前应在打开过工程的Cocos环境运行`typecheck:cocos-demo:engine`；CI中的`typecheck:cocos-demo`只保证入口及依赖可bundle，不伪造引擎类型。客户端SDK本身仍必须通过与引擎无关的`typecheck:cocos-net`。

## 后续Map同步策略

同步方式属于Map的玩法策略，不属于整个Process或Runtime。Phase 4后续允许普通大世界使用状态同步、竞技场等独立Map使用帧同步，以及少数高精度场景使用高频状态同步。同一个部署中可以同时存在这些Map，但玩家切换同步方式应通过退出旧Map、进入新Map完成。

当前业务继续使用已有状态同步链路，不要提前在Handler中散落同步模式判断，也不要自行建立另一套帧号、输入队列或广播接口。后续实现应由Map创建配置选择策略，并由对应Component承接输入、模拟和广播；Handler仍只表达移动、施法等领域意图。逻辑Tick、网络同步频率与客户端渲染频率必须分别配置，提升其中一项不能隐式提高其他两项。

## AI提交前自检

1. 是否只修改了需求真正涉及的目录？
2. 是否复用了现有Scene、Actor、Component和广播机制？
3. Handler是否保持薄，领域状态是否有明确所有者？
4. 是否错误遍历地图定位已知Actor？
5. Snapshot、Delta、Event是否选对？
6. 是否手工修改了Generated、msgcode、rpcId或codec？
7. 是否无依据进入Core或Rust？
8. 是否保留了用户原有脏文件？
9. 是否执行了与改动匹配的codegen和测试？
10. 是否在最终说明中列出验证过和未验证的部分？
11. 如果存在设计变更，是否同步更新了AI项目上下文和AI业务开发手册？
12. Model是否只从`app/core/public.ts`导入Core，Hotfix是否只从`#tiangz/model`导入稳定依赖？
13. System是否误加了字段、构造、静态成员或新的状态形状？公开方法是否显式标注参数和返回类型？
14. 故障测试是否使用确定性Fake或真实边界，而没有向生产配置加入随机故障开关？
## 可观测性边界

业务代码使用 Scene/Actor 上下文 Logger 和框架已有自定义指标入口，不得创建 Observer Scene、定时 RPC 或业务内广播来汇总 Process 指标。每个 Process 的 `/metrics` 由 Rust Host 暴露，Prometheus 按 `StartMachine.json` 直接抓取。业务新增指标必须使用有限枚举标签，不能把玩家 ID、道具 ID、RPC ID 等无界值放入 Prometheus label。`CustomMetricSnapshot.values` 默认按 Gauge 导出；只增不减、进程生命周期累计的字段必须在 `kinds` 中显式声明为 `counter`，不得仅靠 `_total` 命名猜测语义。修改观测契约后必须执行 `npm run verify:observability`。
