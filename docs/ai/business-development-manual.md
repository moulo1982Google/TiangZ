# TiangZ AI 业务开发手册

本文面向承担TiangZ业务需求的AI和开发者。目标是用已有Scene、Session、Unit、Component、协议、状态复制和Client SDK完成业务，不把普通需求升级成框架或Rust Runtime改造。

维护契约：任何架构、目录边界、数据所有权、协议语义或业务开发流程的设计变更，都必须同时更新本文和[AI项目上下文](project-context.md)。设计改动未同步这两份文档，视为尚未完成。

## 默认立场

收到“新增技能、背包、公会、地图、怪物、任务”等业务需求时，默认修改范围是：

```text
app/model/demo/       新增或改变状态、字段、构造、继承和稳定类型时
app/hotfix/demo/      普通Handler与可热更领域行为
proto/
game_config/                 策划静态配置Excel；结构完整部署，纯数据可生成候选热更
cocos_client2D/assets/scripts/Demo/
cocos_client3D/assets/       仅在Phase 4.3或明确的3D客户端需求中修改；Generated/SDK禁止手改
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

## 开始设计前

新增Item、Buff、Quest、Achievement、Numeric或其他业务系统前，先阅读[领域设计模式](../patterns/README.md)，按下面七个问题写清楚设计：

1. 谁拥有状态：PlayerUnit、MapScene、EntryScene还是Session。
2. 数据是普通值、Component、本地ChildEntity，还是需要跨Process寻址的Actor。
3. 谁创建、删除、保存，并负责清理Timer和外部句柄。
4. 谁能看到：自己、队伍、AOI还是全局。
5. 变化是Snapshot、可覆盖Latest、不可丢Event，还是无需网络同步。
6. 变化频率和持久化频率分别是多少。
7. TypeScript是否已经足够；只有明确性能或权威所有权收益时才进入Native。

安装TiangZ Developer Tools `v0.15.0`后，可执行“TiangZ：设计业务系统”、输入`@tiangz /design quest`，运行`tiangz-design`，或执行“TiangZ：运行 Runtime Foundation 自测”。CLI和向导使用确定性规则；聊天模型只负责解释。输出是设计起点，不会自动创建代码，也不能绕过目录依赖、Generated锁和验证命令。修改`docs/patterns`稳定规则时必须同步修改design-core并升级固定Tag；`npm run verify:design-rules`会拒绝缺失、重复、归属错误或只改一侧的规则。

## Model与Hotfix怎么选

- 新增字段、默认值、构造参数、继承关系、Scene/Entity/Component类型：写`app/model`，完整构建并重启Process。
- 新增或修改Handler、校验、流程编排和领域方法实现：写`app/hotfix`，可使用Hotfix-only构建。
- Hotfix通过`@systemFor(ModelType)`提供生命周期和领域方法；System没有字段、构造函数或静态成员，也不会被实例化。
- Model不手写“System未安装”的抛错空壳。codegen从System公开方法生成`app/generated/bootstrap/systems/*.d.ts`，调用方仍直接写`unit.Move()`或`component.UseItem()`。
- System公开方法必须显式写参数和返回类型。只改方法体可热更；修改公开签名会改变Model声明，必须完整构建并重启。
- `Awake/OnDestroy/Deserialize`都是可选能力。需要Hotfix承担某个生命周期时，Model使用`@lifecycle({ awake: true, destroy: true, deserialize: true })`只声明实际需要的项，System提供实现；未声明的钩子不要求空实现。Reload不重跑现有对象的`Awake`；新对象使用新版本Awake，现有对象后续方法和销毁使用当前generation。
- `@transferable()`是迁移能力的唯一声明，同时要求Model自身或对应System提供同步`CaptureTransfer/RestoreTransfer`，不再重复写`transfer: true`。codegen缺方法会直接失败，Hotfix候选缺少Model已声明的方法会整包拒绝并保留旧generation。
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
| 道具、地图、玩家模板等静态数值 | `game_config/Datas/*.xlsx`，再执行Luban codegen |
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

## 游戏配置开发规则

静态策划配置统一维护在`game_config/Datas`，启动部署配置继续维护在`configs/<environment>`，两者不能混用。新增或修改配置时：

1. 在Excel中维护字段和值；新增整张表时同步登记`__tables__.xlsx`。
2. 用`##group`明确字段属于客户端`c`、服务端`s`或两端`c,s`；服务端秘密和校验数据不得为了省事发给客户端。
3. 跨表ID使用Luban `#ref`，让生成阶段拒绝悬空引用。
4. 纯数据变化执行`npm run build:game-config`和`npm run test:game-config`；结构变化执行完整`npm run build`。
5. 服务端通过`GameConfigs`读取，客户端通过分发SDK中的同名入口读取；禁止直接读Excel/JSON、手改Generated或自行维护第二份配置缓存。

`PlayerConfig`表示创建玩家时的基础模板，不表示某个玩家升级后的等级、经验、当前生命或背包结果。运行时状态属于Entity/Component和持久化记录。配置对象与数组只读；`GetAll()`只用于低频初始化和管理流程，帧内热路径应按ID查询或预先建立明确索引。

游戏配置的表名、字段、类型、分组、索引和引用关系属于Model，不能热更；变化后必须完整构建、重启相关Process并同步客户端SDK。只修改数据行或字段值时，`build:game-config`会生成独立候选，可通过Watcher的`reload-config`原子切换服务端快照。Reload不重跑Awake、不修改既有Entity状态；业务不要长期缓存配置行，应在真正使用数值时通过`GameConfigs`查询。客户端数据仍随SDK发布，不能把服务端Reload当作客户端配置下发。详细格式和示例见[游戏配置教程](../tutorials/10-game-config.md)。

## 新增玩家Component

普通业务状态先写TS Component。生命周期声明属于不可热更Model，方法实现属于Hotfix System：

```ts
import { Component, component, lifecycle } from "../../core/public";

@component()
@lifecycle({ awake: true, destroy: true })
export class SkillComponent extends Component {
  protected readonly skills = new Set<number>();
}
```

对应`SkillComponentSystem`使用`@systemFor(SkillComponent)`实现`Awake/OnDestroy`和`AddSkill`等领域方法；Model只保留字段、继承与稳定声明。`@lifecycle`只写System必须实现的钩子，不要为了整齐把所有选项都设为`true`。

在玩家Factory中装配，而不是在Handler中临时添加：

```ts
player.AddComponent(SkillComponent);
```

使用时：

```ts
unit.GetComponent(SkillComponent).AddSkill(skillId);
```

约束：

- `Awake`只做同步初始化；声明了`awake`却缺少System实现时，生成失败。
- Component持有的定时器、订阅或句柄在`OnDestroy`释放。
- 纯数据组件不写空`OnDestroy`。
- `Deserialize`只在完整数据图恢复后重建Timer、索引和非序列化缓存；不读数据库，也不能返回Promise。
- `@transferable()`要求同步实现`ITransfer`；没有迁移需求的Component不要标记。
- 同类型组件只挂一个；可选依赖使用`TryGetComponent`。
- 不直接`new SkillComponent()`，必须走`AddComponent`，否则绕过生命周期和Update注册。

## Component下的多个业务对象

道具、任务和成就都遵循同一个所有权规则，但不强制使用相同的数据形状：

```text
PlayerUnit
├── ItemComponent          -> Item ChildEntity
├── BuffComponent          -> Buff ChildEntity
├── QuestComponent         -> 进行中的Quest ChildEntity + 已完成配置ID集合
└── AchievementComponent   -> AchievementState或动态Achievement ChildEntity
```

`XXXComponent`拥有集合并负责集合级操作。Core用`AddChild/GetChild/TryGetChild/GetChildren/RemoveChild`统一维护所有权、EntityRoot和销毁，不需要每个业务Component再写生命周期Map。Entity不等于Actor：Item和Buff即使是Entity，也没有mailbox，不能作为跨Process消息目标。

```ts
const item = items.AddChild(Item, itemId, { configId, count });
const same = items.GetChild(Item, itemId);
const optional = items.TryGetChild(Item, itemId);
const snapshot = items.GetChildren(Item);
items.RemoveChild(Item, itemId);
```

`GetChildren`返回稳定数组快照，适合低频管理和持久化，不应在高频广播中每帧调用。高频路径由所属Component维护dirty集合或紧凑索引。

### 什么时候创建子Entity

满足以下任一条件时，优先使用有稳定实例ID的子Entity：

- 同一配置可能产生多个不同实例。
- 对象有强化、耐久、绑定、随机词条、锁定等独立状态。
- 对象有独立创建、销毁、持久化或计时生命周期。
- 其他领域需要稳定引用这个具体实例。

如果数据只由配置ID唯一确定，并且只有进度、状态或数量，优先使用普通State、Map、数组或Numeric。普通Quest和Achievement默认不创建Entity；可重复任务、动态任务实例或独立计时任务再升级。

### 查询对象，修改经过Component

读取一件道具时可以取得短期只读视图；当前Item实现本身就是ChildEntity，但调用者只依赖`ItemView`：

```ts
const items = unit.GetComponent(ItemComponent);
const item = items.GetItem(itemId);
if (item?.quality === 5) {
  // 只读取，不长期保存item。
}
```

集合操作必须经过拥有它的Component：

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

### 地图坐标与空间模式

服务端和公共客户端SDK只使用引擎无关的米制`x/y/z/yaw`：X/Z是地面平面，Y是高度，Yaw是绕Y轴弧度。任何位置都必须同时知道`MapInstanceId`；不得把Cocos `Vec3`、Unity `Vector3/float3`或屏幕像素写进协议、Native数据或地图业务。

Grid2D业务使用`cellX/cellZ`和`inputX/inputZ`。Cocos 2D与Pixi在客户端边界将服务端X/Z映射为屏幕X/Y，服务端Y通常为零；3D客户端直接把普通数值转换为引擎向量。禁止再次引入`cellY/inputY`表示地面纵轴，否则2D与3D地图会产生相反语义。

Grid2D客户端只上报移动意图：按下、转向和松开立即发送，按住不变时每`500ms`发送一次保活，静止时不周期发送。窗口隐藏、浏览器失焦和地图销毁必须立即清除按键并发送停止。业务不得把这项`2Hz`输入心跳当成服务端模拟频率；权威移动仍由20Hz Game.Update推进，AOI下行和渲染平滑各自独立。`C2M_MapProbe`只用于测量完整Actor RPC链路延迟，容量基线默认每5秒一次；`C2G_Ping`是Gate存活探测，也固定每5秒一次，不能用二者替代移动或游戏Tick。

Cell是最小空间单位：Grid2D一步移动一个Cell，NavMesh3D允许在Cell内连续移动。AOI只按Grid边界重算，默认15×15 Cell组成一个Grid；Grid从地图最小Cell开始编号，地图宽高必须是Grid边长的整数倍。默认3×3是Enter和20Hz高频区，已可见关系移到5×5外圈后降为5Hz，移到7×7外圈后降为1Hz并保留迟滞，再越界才Leave。外圈不会让一个从未Enter的单位直接可见。

创建地图前先从`GameConfigs.MapConfig`读取`spatialMode`。当前只有`Grid2D`运行时可用；`NavMesh3D`配置虽然已经具备资源、版本和哈希字段，但必须等Rust导航运行时完成后才能启用。业务不能捕获“不支持NavMesh”的异常后回退到Grid2D。空间模式、字段结构和导航资源身份属于Model发布边界；改变正在运行地图的空间实现需要重启Process并重建MapInstance。

详细字段、Rust所有权和客户端进入校验见[地图空间与3D坐标契约](../design/spatial-world.md)。

### 玩家地图传送

静态地图与动态副本都只调用：

```ts
await player.TransferToMap(targetMapInstanceId);
```

业务不得传MapHost、IP、端口或判断目标是否同进程。静态地图的`MapInstanceId == MapConfigId`；动态副本使用`DynamicMapProxy.CreateOn(mapHostName, mapConfigId)`返回的全局实例号。只有创建副本时业务需要决定放置在哪个MapHost，之后保存并传递实例号即可。Gate先打开Actor迁移屏障，再由源PlayerUnit mailbox解析实例路由，协调Location锁、目标Unit恢复、位置提交和源Actor清理。迁移保持UnitId，使用目标`MapConfig`出生点，Actor InstanceId与Location revision必须更新。客户端收到RPC和`MapReady`后销毁旧地图作用域Dispatcher，再用`G2C_EnterMap`全量快照重建视图。

MapHost配置静态地图：

```json
{
  "name": "map_1",
  "sceneType": "MapHost",
  "staticMapIds": [1, 3],
  "ip": "127.0.0.1",
  "port": 7301
}
```

启动时MapHost逐个调用统一`CreateMap`，随后向Location注册实际实例；`knownScenes`中的路由副本不重复填写`staticMapIds`。动态副本由Demo层`DynamicMapManagerComponent`管理，连续无人五分钟自动销毁只是业务兜底策略，不属于Core。正常副本结束应先让业务把玩家逐个`TransferToMap`到入口或其他地图，再调用`DynamicMapProxy.Dispose(instanceId)`。销毁非空地图会明确失败，框架不会暗中踢人、保存或决定回退点。玩家重登时可用`DynamicMapProxy.Exists(instanceId)`判断原副本是否存在，并由业务选择入口地图。

完整开发步骤与代码示例见[地图实例与动态副本教程](../tutorials/11-map-instance-and-dungeon.md)。

Component迁移遵循显式选择：默认不迁移，只有稳定Model类型加`@transferable()`并实现同步`ITransfer<TState>`才会参加。`@transferable()`本身就是稳定能力声明，生成器会检查`CaptureTransfer/RestoreTransfer`是否位于Model或对应`@systemFor`实现中；运行时仍保留最后一道防线。`CaptureTransfer`必须返回脱离旧Entity和Native handle的值快照，`RestoreTransfer`写入目标Factory已经创建的同类型Component，两者都不能返回Promise。当前Numeric与Item迁移完整业务值；Position只迁移速度、朝向和存活，故意不迁移旧坐标与移动中间态；Gate绑定、Persistence和Native handle由目标Factory重建。临时仇恨、施法过程、副本局部状态等组件不加标记即可丢弃。

`RestoreTransfer`只恢复权威数据，不负责恢复后的运行时加工。需要重建Timer、派生字典、配置缓存或索引的Component，在Model声明`@lifecycle({ deserialize: true })`，并在Hotfix System实现同步`IDeserialize.Deserialize()`。Entity会先恢复所有可传送Component，再统一调用这些Component的`Deserialize`；持久化加载器以后也复用`CompleteDeserialize()`调用同一生命周期。以Buff为例：传送快照保存Buff及结束时间，`RestoreTransfer`重建Buff数据，`Deserialize`根据剩余时间移除过期Buff或重新注册Timer。框架只保证完整数据图之后、Entity发布之前调用一次，不包含任何Buff规则；`Deserialize`不得再次访问数据库、返回Promise或依赖尚未恢复的外部Entity。

Entity迁移快照只用于一次进程内迁移，不能长期缓存、写数据库或当作跨进程协议。跨MapHost使用稳定protobuf `PlayerTransferSnapshot`和`MapTransfer.Prepare/Commit/Abort`；Location以revision和operationId保护唯一权威地址，Gate的有界屏障按Proto `duringTransfer`处理并发Actor消息。必须执行一次的RPC标记`queue`，查询类可标记`reject`，可覆盖单向状态使用`drop/latest`。业务代码不得扫描所有MapHost、不得把本地`PlayerDirectoryComponent`当全局目录，也不得手写msgcode分支控制迁移。完整语义见[Entity地图迁移](../design/entity-transfer.md)和[Location路由](../design/location-routing.md)。

只知道UnitId的服务端业务使用`new MessageHelper(this.scenes).CallUnit/SendUnit`。已经持有PlayerUnit或明确Actor地址时直接调用；普通Gate转发使用连接路由缓存，不查询Location。公会等批量扇出先`ResolveUnits`，再按MapHost/Gate聚合，禁止循环调用单Unit Location RPC。

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
- 账号重进若与旧实例销毁交叠，应重新查询账号目录，禁止继续使用先前缓存的Unit引用。

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

`ItemComponent`通过Core子Entity容器拥有`Item`；每个Item内部持有自己的`NativeItemRef`，其InstanceId与子Entity真实生命周期一致，不再由ItemComponent伪造ID。外部读取使用`GetItem`返回的`ItemView`，集合修改使用Component领域方法，Item局部状态修改使用Item领域方法；只有对应System可以直接操作可变Native句柄。

### Buff与AOI

Buff作为ChildEntity只解决身份、生命周期、热更方法和Timer归属，不负责选择网络接收者，也不使用通用dirty字段同步：

```text
创建Buff -> 向当前AOI广播BuffAdded
Buff Tick -> 执行Action -> Numeric/Move/其他领域各自同步
删除Buff -> 向当前AOI广播BuffRemoved
进入AOI -> Buff列表随Unit整体Snapshot发送
离开AOI -> 移除Unit，不逐个发送BuffRemoved
```

- Buff创建和删除是不可覆盖的生命周期Event，分别广播一次Add/Remove。
- `BuffPublicView`只放外观、层数和结束时间；吸收量等受限数据放`BuffDetailView`，禁止用`0`伪装“无权限”。
- 公开事件发送给`AOI观察者 ∪ 队伍`，详情状态发送给`自己 ∪ 队伍`；`ClientAudience.Union`按UnitId去重，同一玩家不会收到两份。
- `G2C_BuffDetail`是以`(unitId,buffInstanceId)`为key的latest状态，同帧多次扣盾只保留最终吸收量；Add/Remove绝不能改成latest。
- Tick不修改或广播Buff本身，只执行Action；Action修改哪个领域，就复用哪个领域已有的同步机制。
- 客户端从BuffAdded或Unit Snapshot携带的开始/结束时间自行计算剩余时间，服务端不逐Tick同步倒计时。
- 进入AOI时Buff列表包含在Unit整体Snapshot中；离开AOI时Unit整体消失，不逐个发送BuffRemoved。
- 不扫描EntityRoot收集Buff，也不让每个Buff成为Actor。未来AOI直接从目标Unit的BuffComponent取得快照。
- 少量Buff允许使用`Buff.NewOnceTimer/NewRepeatedTimer`；大量Buff推荐在BuffComponent保存`nextTickAt/expireAt`，使用最小堆和一个最近到期Timer统一调度。持久化保存时间戳，不保存TimerId。

如果未来出现层数刷新、图标变化等确实需要客户端立即知道的Buff元数据变化，应新增明确的`BuffUpdated`事件，或者将旧Buff Remove后重新Add；不要为了少数需求让全部Buff每帧维护dirty和Delta。

### Quest生命周期与可见范围

任务系统区分“正在进行的实例”和“已经完成的事实”：

```text
QuestComponent
├── activeQuests: Quest ChildEntity集合
└── completedQuestConfigIds: Set/Bitmap
```

- 玩家没有进行中任务时，QuestComponent可以不包含任何Quest子Entity。
- 接受任务时通过`AddChild(Quest, questInstanceId, ...)`创建进行中实例。
- 进度变化默认立即通知任务拥有者客户端，不广播给普通地图观察者。
- 只有组队共享任务明确需要时，才向`PartyAudience`发送必要的进度摘要；不要把完整Quest对象发送给队友。
- 完成时由QuestComponent统一执行奖励结算、写入已完成Quest配置ID、`RemoveChild`和客户端完成通知，Handler不应分别修改这几处状态。
- 登录或重连时向本人发送活动Quest和已完成摘要的全量快照。队友进入AOI时，可随Unit整体Snapshot取得允许共享的任务摘要；普通观察者的Unit快照不包含Quest。离开AOI时只移除Unit。

如果同一配置任务不会同时存在多个活动实例，可以直接用配置ID作为ChildEntity Id；可重复任务、限时活动任务等允许并存时，必须使用独立Quest实例ID，并单独保存`configId`。已完成集合始终记录稳定配置ID，不保存已经销毁的InstanceId。

## 广播给谁与如何广播

业务层只产生逻辑`ClientAudience`：AOI观察者、自己、队伍、公会在线成员等。`ClientBroadcast`在发送时批量解析UnitId到Gate；同地图成员同步直取Gate，跨地图关系成员通过Location批量查询并短期缓存。业务看不到`BroadcastAudience`、Gate route、连接或内网帧。Core的`BroadcastHub`处理编码、event队列、latest合并、single-flight和指标。Movement等已经由框架提供专用Rust热路径的状态，业务仍只修改权威数据或调用领域方法。

业务开发者不创建、不读取AOI的Audience签名，也不维护迟滞关系集合。Rust会为最终受众相同的状态共享编码；`tiangz_aoi_lingering_relations`和`tiangz_aoi_rejected_relations`只用于诊断。设计地图和移动速度时应让Grid尺寸明显大于单Tick移动距离；若大量Unit持续跨Grid，成本近似“跨Grid次数 × 附近候选人数”，这属于空间负载模型，不应通过在Handler中缓存观察者列表规避。

```ts
const map = player.DomainScene().GetComponent(MapComponent);
const nearby = map.Audience.ObserversOf(player); // 谁能看见player，不是player能看见谁
const party = ClientAudience.ForUnits(`party:${partyId}`, partyMemberUnitIds);

await Promise.all([
  map.Broadcast.Publish(
    ClientAudience.Union(nearby, party),
    ClientBroadcasts.BuffAdded,
    { buff: publicView },
  ),
  map.Broadcast.Publish(
    ClientAudience.Union(ClientAudience.Self(player.UnitId), party),
    ClientBroadcasts.BuffDetail,
    detailView,
    serverTick,
  ),
]);
```

规则：

- `ObserversOf(subject)`表示“谁能看见这个Subject”；`VisibleSubjectsOf(observer)`表示“这个Observer能看见谁”，命名方向不能互换。
- `ClientAudience`的key描述稳定业务身份，例如`party:42`；不能把当前成员列表拼入key，否则latest频道无法连续覆盖。
- 不在BroadcastHub中写地图AOI、队伍或公会查询；对应业务域只负责产生UnitId集合。
- 不为每种广播新增`M2G_Xxx`；业务只调用`map.Broadcast`。框架按数量自动选择内部单发或批发，业务不得直接构造内网广播协议。
- latest descriptor必须有稳定key。
- event队列满必须显式失败，不能静默丢弃。
- AOI已经接管Movement、Numeric和Unit固定字段的接收者选择；新增业务广播必须选择明确Audience，不能重新构造全地图玩家列表。

通用广播不会把多个Encoded Audience逐组跨进程发送。`BroadcastHub`通过Transport的`SendMany`提交逻辑作业，`SceneBroadcastTransport`在同一同步Game Tick内按Gate合并；批量元素仍保持独立客户端frame边界，Gate只完成Unit到connection的路由与下行扇出。Movement热路径更进一步：Rust AOI在Attach时记录框架分配的紧凑delivery route，帧尾直接生成每个Gate的完整内网批帧，TS只做至多Gate数量的routeId到Scene映射并原样发送。业务不得分配routeId、调用`MapTakeMovementAoiRouteFrames`、`SceneMessageHelper.sendFrame`，或直接构造`S2G_ClientBroadcastBatch`。Numeric、UnitState和即时不可覆盖Event仍走通用路径；不能为了追求“一Tick一包”而延迟战斗事件或把多个客户端msgcode拼成私有payload。

## 定时器和Update

Component拥有的周期任务使用组件定时器：

```ts
this.NewRepeatedTimer(100, "RegenerateHp");

protected RegenerateHp(): void {
  this[NumericType.CurrentHp] += 1;
}
```

Component和Actor业务Timer必须传方法名，不能传匿名闭包。触发时框架从当前prototype解析方法，因此现有Timer会自然进入新Hotfix generation；Timer仍随owner销毁自动取消。

需要区分正常结束与主动打断时，保存返回的`TimerId`并声明取消方法：

```ts
this.castTimerId = this.NewOnceTimer(
  3_000,
  "FinishCast",
  { skillId, targetId },
  { onCancelled: "CancelCast" },
);

this.CancelTimer(this.castTimerId, "player-moved");
```

正常到期只调用`FinishCast(args)`；主动取消只调用一次`CancelCast(args, context)`。Owner销毁属于生命周期清理，不回调业务取消方法。不要把`TimerId`写入数据库。

Developer Tools会检查Timer方法名和取消回调是否存在、取消回调是否接收`(args, context)`、异步Scene Event是否遗漏`await`，以及持久化Snapshot是否错误声明`InstanceId/TimerId`。命令面板可执行“TiangZ：运行 Runtime Foundation 自测”，其结果与`npm run test:runtime-foundation`一致。

逐固定帧逻辑实现同步`Update()`，帧末复制实现`FrameFlush()`。不要在Update中创建未等待的异步任务：

```ts
// 错误：每帧都可能堆积一个尚未完成的RPC。
Update(): void {
  void this.scenes.callOne("Rank", descriptor, request);
}
```

需要异步串行时，用Actor定时器或给Actor发送消息，使工作进入其mailbox。

## 业务Id、局部锁与Scene事件

- 玩家、Item、动态副本等长期实体保存稳定`Id`；`InstanceId`只用于当前Process中的EntityRoot和Actor路由，禁止持久化。
- 新Item由`GlobalIdSystem`生成ID；数据库恢复使用`CreateItemById`保留原ID并获得新的InstanceId。
- 同一Scene内按门派、队伍、交易单等业务键防重入时使用`await scene.Locks.RunExclusive(domain, key, callback)`。它不跨Process，不替代数据库事务。
- 同一Scene的功能解耦使用`defineSyncEvent/defineAsyncEvent`和`scene.Events`。同步事件不能I/O；异步事件必须await。
- 跨Scene、跨Process、需要mailbox顺序或需要响应的交互仍使用生成的Message/RPC，不能拿Event代替。

详细API和错误边界见[运行时基础能力](../design/runtime-foundations.md)。

## 玩家下线和持久化

玩家保存应封装在玩家内部的生命周期能力中。断线、踢下线和Process停机共用同一个幂等Promise：

```ts
await player.Offline(reason);
```

业务Handler不要直接调用Repository，否则会绕过幂等保存和统一移除流程。普通socket断开只销毁`GateSession`，不能直接调用玩家`Offline()`；`GatePlayerRoute`在Gate继续保留30秒等待重连。宽限期结束后只能由Gate调用`MapProtocol.PlayerOffline`，Map保存、移除Unit并广播AOI离开后，Gate再删除Route。

玩家Unit只保存长期`gateName`，不得保存`connectionId`、`GateSessionId`或自行创建断线Timer。重连使用`SecondEnterMap`恢复客户端全量视图，不创建替代Unit、不触发AOI进入、不修改Gate归属。客户端空闲时每5秒发送`C2G_Ping`；任何入站消息都会续期，服务端出站消息不会续期。Ping是框架已经接管的Gate控制帧，在Session mailbox之前同步消费；业务不再编写`C2G_PingHandler`，也不得把技能、道具等业务消息放进控制帧入口。

Gate初始分配统一复用`SelectStickyGate`，业务不得另写取模、随机或自定义账号哈希。它通过Rendezvous Hash保证拓扑稳定时同账号固定归属，并对公共前缀账号做分布自测；Location不参与每次登录的Gate负载均衡。

当前正式数据库链路尚未实现，持久化已调整到Phase 4.5，作为`0.4.x`最后一个基础阶段建设Rust `PersistenceProxy`和Redis/永久DB分层。业务开发暂时继续依赖`PlayerRepository`与`PlayerPersistenceComponent`，禁止在Handler、Entity或Component中直接创建Redis、MongoDB、MySQL或PostgreSQL客户端。

## AOI业务规则

地图业务不再构造“全地图玩家列表”广播Movement、Numeric或Unit固定字段。`MapAoiComponent`拥有Rust推导的最终可见结果；Movement由Rust在帧尾直接生成按Gate路由的完整批帧，`MapComponent`只调用框架封装并提交结果，不把recipientId数组拉回TS。Enter内默认关系由AOI Grid即时推导，Rust只保存Enter与Detach之间的迟滞关系、业务拒绝覆盖和本帧净变化；状态复制按Subject Grid合并相同受众，不按每名接收者复制记录索引。业务过滤属于稀疏例外。业务TS不得镜像全量关系表、管理delivery route、手工合并Grid受众或直接发送内网帧。开发普通移动、传送、上线或下线时不得手工调用底层Native AOI op；X/Z FastOP、`PlayerEntered`和`RemovePlayer`生命周期已经接管。

普通Unit进入/离开视野也不由业务逐个发送。框架把同一帧、相同受众的不可覆盖变化合成`G2C_AoiDelta`，客户端SDK的Handler负责遍历`enters/leaves`。新增Buff、任务摘要等领域可见事件时，应先判断它属于Unit整体Snapshot、独立不可覆盖Event还是可覆盖状态；不得把业务字段塞进通用AOI Delta，也不得恢复逐关系`Publish`。

阵营、隐身、位面等规则实现同步过滤器：

```ts
class PhaseVisibilityFilter implements IAoiVisibilityFilter {
  CanObserve(observer: Unit, subject: Unit): boolean {
    return observer.GetComponent(PhaseComponent).PhaseId ===
      subject.GetComponent(PhaseComponent).PhaseId;
  }
}
```

`CanObserve`只能读取内存中的Component并立即返回`boolean`，禁止`async`、Promise、RPC、数据库、发消息和修改Entity；异常会按不可见处理。过滤器不会每帧运行。业务状态变化后，必须按影响方向显式通知地图：只影响“我能看见谁”调用`InvalidateObserver(unit)`；只影响“谁能看见我”调用`InvalidateSubject(unit)`；双向规则调用`Invalidate(unit)`。AOI当前只筛选接收者，技能命中、组队权限等业务权威判定仍由各自领域逻辑负责。

空间配置只通过Luban Cold表维护：`MapConfig.cellSizeMeters`定义米制Cell；`AoiConfig.gridSizeCells`定义一个AOI Grid包含多少个Cell；`enterRangeGrids`和`detachRangeGrids`分别控制建立与移除可见关系；`AoiSyncTierConfig`只控制已经可见关系的可覆盖状态频率。范围填写奇数边长，例如3表示3×3 Grid。同步范围可以大于Enter，但不会提前Enter；同步最大范围也可以小于Detach，迟滞外圈此时只保持可见，不接收周期可覆盖状态。Movement的开始、停止和转向不受节流；低频档由框架按Subject Grid稳定错峰。Numeric、技能、Buff等仍按自己的状态或事件语义发送。业务代码不得根据距离自行重复一套频率判断。

`MapConfig`、`AoiConfig`、`AoiSyncTierConfig`是Cold表，任何值变化都必须完整构建并重启Process；`ItemConfig`和`PlayerConfig`当前是Hot表，可以在线替换数据。表结构始终属于Model。新增配置表时必须在`ConfigTablePolicy.xlsx`登记整表策略，不允许一张表内混合Hot与Cold字段。

### 地图入图节流

首次登录或`TransferToMap`到达目标地图时，业务不应直接调用底层AOI Attach，也不需要自己创建Loading队列。`MapComponent.PlayerEntered`会进入当前MapInstance的等待队列，地图每Tick最多按`MapConfig.entryPlayersPerTick`放行；`entryQueueCapacity`满时明确拒绝，防止无限积压。Gate保持连接并等待`EnterMap`或传送响应，客户端继续显示Loading。首次进图和传送链路由框架统一使用10分钟Admission事务上限，不继承普通Scene RPC的5秒默认值；业务不得自己套一层更短超时破坏队列语义。断线重连调用`SecondEnterMap`并复用原Unit，因此不进入该队列。

这套机制只处理同一地图瞬时进入洪峰。它不检查区服总人数，不显示排队名次，不保证某张地图适合继续接收玩家，也不代替副本分配和MapHost容量规划。业务仍只调用统一传送入口，不为静态地图、动态副本、同进程或跨进程分别写节流代码。

业务不得使用`EntrySyncMode`跳过新玩家Snapshot或老玩家Enter；非Full模式只编入Bench Handler，用于`perf:map-entry-stages`拆分性能。排查进图慢时依次观察MapHost请求、Admission等待、Attach、Snapshot对象数、AOI Delta逻辑投递量和Gate下行，不得通过删减客户端必需状态制造虚假的容量结果。Prometheus标签中禁止加入account、UnitId和connectionId。

计划中的开发者语义只保留三种存储域：

- `transient`：连接、移动中间态等运行时数据，不保存。
- `snapshot`：位置、普通数值、任务进度等最终状态；业务保持普通属性写法，生成setter自动标脏，框架短窗口合并后批量写Redis并异步落永久DB。
- `transactional`：Wallet、Inventory、Trade等经济数据；不能直接赋值，只通过领域事务方法修改，永久DB提交成功后才更新Redis缓存和内存状态。

同一字段只能属于一个存储域。Redis中的事务字段只是永久DB结果的带版本缓存，不是第二个业务写入口；普通快照也不得覆盖Wallet、Inventory等事务域。未来由`.native`在Entity/Component级声明模式并由codegen生成约束，在该语法正式落地前不要自行发明`@redis`、`@mongodb`或每字段保存频率注解。

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

`0.3.10`框架稳定化和`0.4.0` Phase 4.0空间契约已经完成，当前继续沿`0.4.x`开发线推进。Model/Hotfix双Bundle、`@systemFor`、兼容指纹、Watcher Reload、Rust有界投递屏障、超时拒绝、事务回滚、Prometheus指标、3000玩家1Hz Reload A/B、8秒慢RPC屏障、Timer跨generation和100代资源长稳均已完成。热更按整个Process原子提交Hotfix behavior，现有Entity/Component和Rust handle不重建。Model绝对不能热更；字段、构造、继承、公开System签名、协议、空间模式或Native schema变化必须完整部署并重启Process，不存在字段migration旁路。完整约束见[热更设计](../design/typescript-hot-reload.md)。

本地只修改Hotfix行为时，可运行`npm run dev -- configs/local/StartMachine.json`后直接保存TS文件；开发宿主会自动生成注册入口、类型检查、构建不可变候选并Reload。构建失败时旧generation继续运行。这个便利入口不适用于Model字段、Core、Proto或`.native`变化，也不用于正式部署。Developer Tools把Model长期状态中的显式`any`、可选字段、基本类型与`undefined`联合、跨基本类型联合、`delete`字段和`as any`写属性视为错误；请使用稳定默认值或明确的数据结构。对象`T | null`、判别联合、显式Map/Record和普通DTO仍可正常使用。

| 修改类型 | 最少验证 |
|---|---|
| 纯TS业务Component/Handler | `npm run typecheck`和对应自测 |
| 只修改Hotfix行为 | `npm run build:hotfix`、`npm run test:hotfix` |
| Model字段、类型、构造或继承 | `npm run build`、相关测试并重启Process；不得使用Hotfix-only |
| proto或客户端Push | `npm run codegen`、`npm run test:protocol`、对应Client测试 |
| Luban游戏配置 | 纯数据用`npm run build:game-config`、`npm run test:game-config`和Reload验收；结构变化追加完整构建、重启与客户端类型检查 |
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

性能结果必须注明机器、配置、玩家数、Gate数、频率、持续时间、是否AOI以及指标口径。不要把Probe基线或全地图可见Demo结果描述为正式业务容量。自动容量推荐延后到Phase 5，必须等Rust AOI和首版真实怪物、战斗、Buff、任务及持久化负载具备后，按负载模型分别校准；业务代码和配置当前不得读取测试报告自行生成准入人数、Gate数或Process数。

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
15. 提交标题是否使用中文，并避免把无必要的英文Conventional Commit格式带入TiangZ及配套插件仓库？

## 可观测性边界

业务代码使用 Scene/Actor 上下文 Logger 和框架已有自定义指标入口，不得创建 Observer Scene、定时 RPC 或业务内广播来汇总 Process 指标。每个 Process 的 `/metrics` 由 Rust Host 暴露，Prometheus 按 `StartMachine.json` 直接抓取。业务新增指标必须使用有限枚举标签，不能把玩家 ID、道具 ID、RPC ID 等无界值放入 Prometheus label。`CustomMetricSnapshot.values` 默认按 Gauge 导出；只增不减、进程生命周期累计的字段必须在 `kinds` 中显式声明为 `counter`，不得仅靠 `_total` 命名猜测语义。修改观测契约后必须执行 `npm run verify:observability`。
