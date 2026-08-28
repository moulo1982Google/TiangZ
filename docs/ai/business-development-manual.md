# TiangZ AI 业务开发手册

本文面向承担TiangZ业务需求的AI和开发者。目标是用已有Scene、Session、Unit、Component、协议、状态复制和Client SDK完成业务，不把普通需求升级成框架或Rust Runtime改造。

维护契约：任何架构、目录边界、数据所有权、协议语义或业务开发流程的设计变更，都必须同时更新本文和[AI项目上下文](project-context.md)。设计改动未同步这两份文档，视为尚未完成。

业务代码、教程、测试结果和工具脚本不得写死开发者的仓库目录、软件安装盘符或私网IP。仓库内文件使用相对路径；外部工具通过环境变量或命令行参数定位；性能报告由公共清洗器把仓库内路径转换为相对路径。提交前运行`npm run verify:no-local-traces`，不要通过新增宽泛白名单绕过门禁。

## 默认立场

收到“新增技能、背包、公会、地图、怪物、任务”等业务需求时，先按[能力归属表](../design/capability-ownership.md)判断是稳定契约还是MMORPG适配，默认修改范围是：

```text
app/model/domains/      跨游戏稳定状态形状、ChildEntity和Component容器
app/model/mmorpg/       MMORPG新增或改变状态、字段、构造、继承和稳定适配器时
app/hotfix/mmorpg/      MMORPG普通Handler与可热更领域行为
proto/
game_config/                 策划静态配置Excel；结构完整部署，纯数据可生成候选热更
client_demo/cocos_client2D_3.8.6/assets/scripts/Demo/
client_demo/cocos_client3D_3.8.8/assets/       3D客户端业务与灰盒；Generated/SDK禁止手改
client_demo/ue_client3D_5.4.4/                 UE客户端业务与表现；插件ThirdParty SDK禁止手改
client_demo/pixi_client_8.19.0/src/
configs/
tests或tools中的对应业务自测
```

### 先保护通用内核，再扩展领域

当前Starter是MMORPG领域样例，不要把它反向当作框架定义。AOI、MapHost、地图传送、NavMesh、怪物、NPC、目标选择、Combat、Skill、技能地图调度和掉落协议属于`app/model/mmorpg`、`app/hotfix/mmorpg`或`src/game/<domain>`；Process、Scene、Actor、Component、mailbox、协议路由、热更和宿主队列属于Core；Numeric、Action、Reward、Item、Quest、Buff的稳定状态契约位于`app/model/domains`。不要把当前MMORPG执行器为了目录好看强行搬进domains。

新业务优先沿用现有领域组件和Stable API。只有当现有API无法表达需求，并且需求不是单纯的MMORPG规则时，才申请Core扩展。不要为了“以后支持卡牌、SLG或MOBA”提前新增通用Manager、万能配置扩展或第二套Actor入口。第二个真实领域出现后，使用重复需求和验收结果反推边界。

修改分层入口后运行`npm run verify:domain-boundaries`。它检查Core、Model、Hotfix和Rust游戏模块的依赖方向；通过门禁不代表业务语义正确，仍需运行对应领域测试。

### 领域契约与 MMORPG 适配

共享领域层只放不依赖生成配置、协议、地图或游戏Native句柄的稳定契约：

```text
app/model/domains/numeric/  Numeric字典和派生规则
app/model/domains/action/   ActionDefinition
app/model/domains/reward/   RewardPlan
app/model/domains/item/     Item ChildEntity和背包容器
app/model/domains/quest/    Quest ChildEntity和任务容器
app/model/domains/buff/     Buff生命周期容器
app/model/mmorpg/combat/    当前MMORPG的伤害、治疗、护盾和平A状态
app/model/mmorpg/skill/     当前MMORPG的读条、引导、冷却和技能定义
```

MMORPG适配层继续放：`ActionExecutor`、`RewardExecutor`、`CombatComponentSystem`、`SkillComponentSystem`、`SkillMapComponentSystem`、NPC/地图目标选择、Luban ActionType和协议投影。它们读取`PlayerUnit`、`MapComponent`、`GameConfigs`或`ItemSnapshot`，所以不能伪装为跨游戏Core。

`ActionDefinition`和`RewardPlan`的最小用法：

```ts
import { ActionType, type RewardPlan } from "#tiangz/model";

const reward: RewardPlan = {
  operationId: "quest:5001:character:1001",
  actions: [{ type: ActionType.GrantItem, parameters: [1101n, 5n] }],
};
```

`ActionDefinition`只描述效果和`bigint`参数，不选择目标、不调用RPC、不修改Entity；`RewardPlan`只描述有序奖励Action和可选幂等键。MMORPG执行链仍是`RewardPlan -> PlanTransactionalReward -> ItemComponent.PlanGrantItems -> DBProxy -> CommitGrantPlan`。规划阶段不能修改Entity，确认前不能回复成功。当前`RewardDefinition`是`RewardPlan`的兼容别名，新代码优先使用`RewardPlan`。

Numeric的`MoveSpeed`不属于通用Numeric字段。通用层只保留HP、攻击、等级等可复用数值；米/秒到Rust毫米/秒、移动位置同步和MoveSpeed默认值放`app/model/mmorpg/numeric/MovementNumeric.ts`及对应System。这样卡牌或模拟经营可以复用Numeric，而不会继承地图移动语义。

Item、Quest、Buff本轮只拆稳定Model契约；Combat、Skill仍完整留在`mmorpg`，因为当前实现含有平A、伤害学校、读条、引导和技能配置语义。第二个游戏真实使用后，再从两套实现中抽取已经重复的行为，不按目录名猜通用性。

### await 后的 Entity 存活检查

JavaScript 的 `await` continuation 不能被运行时抢占。ordered Actor 在等待外部 IO、Timer 或 RPC 时可能被销毁；框架会在 mailbox 结果结算时拒绝旧调用，但不能撤销业务已经执行的后续代码。业务在 `await` 后准备读取或修改 Entity/Component 前，应调用：

```ts
await externalCall();
player.AssertAlive();
player.GetComponent(InventoryComponent).Commit(...);
```

`AssertAlive()` 是协作式生命周期门禁，不是自动取消机制。需要强制串行边界时，应把后续工作拆成新的 Actor mailbox 消息或由 Entity Timer 重新投递，不要把长时间 Promise 当作锁。

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

Unity业务客户端的默认边界是：

```text
client_sdk/csharp/                         C# SDK唯一源码；协议和网络Core
client_demo/Unity2022.3.62f3c1_demo/Assets/TiangZClient/Runtime  生成副本，禁止手改
client_demo/Unity2022.3.62f3c1_demo/Assets/TiangZClient/Demo     Unity场景、输入、相机和表现
```

协议变化后执行`npm run codegen:csharp-client-sdk`，然后用`dotnet build client_sdk/csharp/TiangZ.Client.csproj`做引擎无关验证。Unity业务不得自己编码protobuf、分配rpcId或直接访问`RpcSocket`的内部字典；只通过生成的`LoginMgrClient/LoginClient/GateClient/MapClient`和消息描述符调用。每帧在Unity主线程调用`RpcSocket.Update()`，网络回调线程不得触碰GameObject、Transform或其他Unity API。当前SDK只提供桌面WebSocket，TCP/KCP没有Adapter时必须报错。

需要在真人客户端中观察多人广播时，运行`npm run robot:walk -- <人数>`。这些机器人通过正式SDK进入游戏并遛弯，不是服务端业务Entity模板；业务Handler不得识别或特殊处理机器人账号。

地图HUD需要显示延迟时，读取`LoginFlow.latestGatePing.latencyMs`，不要另外创建Ping定时器。`serverTimeMs`和`clockOffsetMs`用于服务器时间换算；不要直接相减本地时间与服务器时间来冒充网络RTT。

基准Scene放在`app/model/bench`，压测专用Handler放在`app/hotfix/bench`，并通过`npm run build:bench`显式装配。正常`npm run build`不得包含Bench Scene/Handler；Cocos/Pixi分发SDK也不得携带Bench协议。

Bench Hotfix可以通过`#tiangz/model`调用真实业务API，但Demo不得引用Bench。正式、压测等装配分别写在`app/model/main*.ts`与`app/hotfix/main*.ts`；不要为了消除依赖诊断把Bench实现搬回Demo。

只有现有公共能力无法表达需求时才进入Core。只有明确的数据所有权或性能证据支持时才进入Rust或`native_data`。开始修改前必须能用一句话说明业务边界和权威状态归属。

## 云部署地址怎么填写

外网演示时，前端只需要配置一个LoginMgr公网IP和端口。后续地址由服务端逐级返回：LoginMgr返回Login的外网地址，Login返回Gate的外网地址。

```json
{
  "name": "gate_1",
  "sceneType": "Gate",
  "innerIp": "192.0.2.5",
  "bindIp": "0.0.0.0",
  "outerIp": "203.0.113.10",
  "port": 7201,
  "outerPort": 7201
}
```

- `bindIp`只控制本机监听；云服务器通常使用`0.0.0.0`。
- `innerIp`只给Login、Gate、Location、MapHost等服务间通信使用。
- `outerIp/outerPort`只给客户端登录链路使用；没有外网入口的MapHost、Location和Manager不填写。
- `0.0.0.0`绝不能写入`knownScenes`、MapHost Endpoint或任何返回客户端的地址。
- 同一个入口在`scenes`和共享`knownScenes`中重复时，`outerIp/outerPort`可以只写一边；如果两边都写，必须一致，否则 Runtime 会拒绝启动。
- 旧配置的`ip`仍能读取，但新配置使用`innerIp`，避免开发者误把监听地址当成路由地址。

Model业务代码只从`app/core/public.ts`导入Core能力。`app/model/main.ts`是Rust宿主启动桥接，允许使用Runtime Internal完成启动、更新、停止和二进制事件转发，但不是业务模块的参考写法；`app/model/bench`也必须使用Stable入口。Hotfix代码只能从`#tiangz/model`取得Model类型、协议和Stable Core API；禁止深层导入`app/model`或`app/core`。其他Core路径属于Internal，即使当前可以被TypeScript解析，也不能直接依赖。Stable API需要调整时，按[公共API与版本稳定性](../reference/api-stability.md)完成影响说明、迁移、显式API锁更新和验证。

ordered Scene mailbox的同步任务由Runtime循环排空，不依赖递归调用栈；业务Handler仍应保持短小，长耗时工作使用明确的RPC、Timer或有界`Scene.Tasks.Spawn`，不能用连续同步投递制造无限队列。配置索引、缓存等可变状态必须归属于Scene或Component；Hotfix模块不得使用模块级可变变量或全局单例。

## Starter MMORPG 开发目标

TiangZ的完整业务参考是一个小而完整的Starter MMORPG，不是把Demo扩展成商业游戏。开发主线固定为：登录/选角 -> 主城 -> 野外战斗 -> 掉落/背包 -> 任务/奖励 -> 动态副本/Boss -> 断线重连 -> 重启恢复。执行细节见[Starter MMORPG教程](../tutorials/20-starter-mmorpg.md)，验收标准见[Starter验收矩阵](../starter/acceptance-matrix.md)。

开发Starter时遵循四条硬规则：

- 框架案例可以很小，但Starter必须调用正式Stable API，不得绕过Mailbox、Component、协议生成或DBProxy边界。
- 一个业务状态只能有一个权威所有者；Handler只做协议适配，不能保存玩家状态、编排持久化或直接操作数据库。
- 配置、Model结构、协议和`.native`契约走生成链路；可热更规则放Hotfix，Model和存储结构不能在线修改。
- 新功能必须能在all-in-one和split-process运行，并有失败、重试、重连或重启后的明确结果；只有代码存在不能算Starter完成。

Starter阶段只保留一个职业、一个主城、一个野外地图、一个动态副本、三种普通怪、一个Boss和少量技能。组队、社交、商城、活动和大量客户端美术不是当前框架验收前提。

Starter的第一个动态副本使用MapConfig 200和MonsterConfig 3。客户端调用Gate的`C2G_EnterStarterDungeon`并提供稳定`operationId`；客户端不得指定MapHost或MapInstanceId。Gate以角色和operationId生成幂等请求，交给`DynamicMapProxy -> MapManager`选择动态Host，再复用正式进图流程。Boss死亡只发布通用`MonsterEvents.Killed`，经验规则由`app/hotfix/mmorpg/dungeon`监听，不把副本奖励写进Monster或Combat。

经验是`NumericType.Experience`累计值，等级由`50 * (level - 1) * level`计算，当前上限60。奖励先规划新的Numeric快照并以稳定operationId只提交`progression`记录，DBProxy确认后才更新在线Numeric和发送`G2C_ProgressionChanged`；网络重试必须恢复原事务回执，不能重复加经验。Map 200的试炼守卫奖励120经验，因此新角色从1级升到2级。动态实例无人5分钟后由现有回收逻辑销毁；副本Boss、仇恨和现场状态属于临时运行态，MapHost崩溃后不恢复。

本地入口固定为：`npm run starter:verify`检查目录和生成物，`npm run starter:dev`编译并启动all-in-one，`npm run starter:smoke`验证all-in-one与split-process，`npm run starter:character-smoke`验证创建角色、选角和稳定身份，`npm run starter:acceptance`运行不改数据库的完整Starter验收。三个Starter验收命令都会先重建Debug Rust runtime；`npm run starter:acceptance:persistent`会使用`tools-projects/TiangZ-DBProxy/deploy/local/.env`启动或连接本地DBProxy，写入测试账号、重启TiangZ并读取快照；`npm run starter:acceptance:faults`通过`test:tiangz-fault-matrix`运行交易故障切换、提交后响应丢失、双Endpoint不可用、MapHost接管和独立DBProxy故障矩阵，可能重启本地Redis/PostgreSQL容器，只能在测试环境运行。不要把长时间压测塞进Starter命令；压测必须使用`perf/`的独立入口，并在开始前确认机器资源。

### 账号、角色和运行时Unit

Starter中三种ID必须严格分开：

- `account`只用于登录认证和LoginMgr的稳定路由选择；不要用账号字符串在Map中查找玩家。
- `characterId`是角色长期身份，作为CharacterRepository、Player快照、Location和跨地图传送的稳定键。客户端通过`S2C_Login.characters`显示目录，并把用户选择的ID放进`C2S_Login`。
- 首次账号必须走`C2S_Register`，注册时把用户名作为初始角色名；`C2S_Login`必须携带密码。账号不存在时返回“用户未注册”，服务端禁止用登录请求隐式创建游客账号。客户端确认密码只做表单校验，不发送到服务端。
- `CharacterCatalog`保存密码盐值和摘要，不保存明文；配置`process.persistence.dbProxy`时目录可跨TiangZ重启恢复，未配置时是进程内调试目录，不能用于上线或重启恢复验收。
- `unitId`是当前MapHost里的运行时Unit ID，只用于当前进程的Actor/mailbox/AOI路由；角色迁移或重建后它可能改变，禁止保存到数据库。
- `mapInstanceId`描述地图实例，静态地图和动态副本都通过同一个`TransferToMap`入口处理；业务不根据部署方式分叉。

创建和选角的客户端调用示例：

```ts
const created = await flow.createCharacter(account, "法师一号", 1);
await flow.enterGame(account, 1, () => {}, created.character.characterId);
```

`CharacterRepository`配置DBProxy时负责版本和幂等重试；未配置DBProxy时只是进程内Demo目录，不能宣称支持重启恢复。跨MapHost传送可以把角色快照交给目标内存仓库接管，但这不是把内存数据写回永久存储。业务Handler不得读取或记录密码，只能把认证结果交给LoginScene和后续Gate链路。

`ProcessHost`、`Singleton/SingletonRegistry`和`InstanceIdSystem`属于Core Internal，不从业务入口导出。动态地图等业务通过`EntryScene.SpawnChildScene/DespawnChildScene`管理子Scene；只有已经解析出的本地Actor操作才使用`RunLocalActorMailbox`，跨进程仍走Location与消息路由。业务不得任意查询整个Process Entity目录或取得进程销毁权；长期索引由所属Scene Component显式持有并在销毁时清理。配置JSON同样是强契约：未知根字段、Process字段和嵌套字段都会让Rust拒绝启动，不能依赖拼错字段被静默忽略。Native Store诊断使用Rust正式配置`process.observability.nativeData`，不得恢复旧的根级Demo扩展。

## 开始设计前

新增Item、Buff、Quest、Achievement、Numeric或其他业务系统前，先阅读[领域设计模式](../patterns/README.md)，按下面七个问题写清楚设计：

1. 谁拥有状态：PlayerUnit、MapScene、EntryScene还是Session。
2. 数据是普通值、Component、本地ChildEntity，还是需要跨Process寻址的Actor。
3. 谁创建、删除、保存，并负责清理Timer和外部句柄。
4. 谁能看到：自己、队伍、AOI还是全局。
5. 变化是Snapshot、可覆盖Latest、不可丢Event，还是无需网络同步。
6. 变化频率和持久化频率分别是多少。
7. TypeScript是否已经足够；只有明确性能或权威所有权收益时才进入Native。

安装TiangZ Developer Tools `v0.15.0`后，可执行“TiangZ：设计业务系统”、输入`@tiangz /design quest`，运行`tiangz-design`，或执行“TiangZ：运行 Runtime Foundation 自测”。CLI和向导使用确定性规则；聊天模型只负责解释。输出是设计起点，不会自动创建代码，也不能绕过目录依赖、Generated锁和验证命令。修改`docs/patterns`稳定规则时必须同步修改design-core并升级固定Tag；`npm run verify:design-rule-sync`只检查插件规则与文档登记是否同步，源码约束另外由`check:project`、`verify:hotfix-boundary`和各专项自测执行。

## Model与Hotfix怎么选

- 新增字段、默认值、构造参数、继承关系、Scene/Entity/Component类型：写`app/model`，完整构建并重启Process。
- 新增或修改Handler、校验、流程编排和领域方法实现：写`app/hotfix`，可使用Hotfix-only构建。
- Hotfix通过`@systemFor(ModelType)`提供生命周期和领域方法；System没有字段、构造函数或静态成员，也不会被实例化。
- Developer Tools 会把 `@systemFor`、`@hotfixFor`、网络 Handler 和 Scene Event Handler 中的字段、构造函数、静态块与静态方法直接标为错误（`tiangz.hotfix.instance-state`）。行为类只承载可热更方法；缓存、TimerId、索引和其他长期状态必须放到 Model 的 Entity/Component，日常修改先运行 `npm run verify:fast`。
- Model不手写“System未安装”的抛错空壳。codegen从System公开方法生成`app/generated/bootstrap/systems/*.d.ts`，调用方仍直接写`unit.Move()`或`component.UseItem()`。
- System公开方法必须显式写参数和返回类型。只改方法体可热更；修改公开签名会改变Model声明，必须完整构建并重启。
- `Awake/OnDestroy/Deserialize`都是可选能力。需要Hotfix承担某个生命周期时，Model使用`@lifecycle({ awake: true, destroy: true, deserialize: true })`只声明实际需要的项，System提供实现；未声明的钩子不要求空实现。Reload不重跑现有对象的`Awake`；新对象使用新版本Awake，现有对象后续方法和销毁使用当前generation。
- `@transferable()`是迁移能力的唯一声明，同时要求Model自身或对应System提供同步`CaptureTransfer/RestoreTransfer`，不再重复写`transfer: true`。codegen缺方法会直接失败，Hotfix候选缺少Model已声明的方法会整包拒绝并保留旧generation。
- Model绝对不能在线热更，不设计字段migration。`npm run build:hotfix`拒绝时，说明这次改动已经越过行为边界，不能规避检查。
- `npm run build:hotfix`生成`dist/hotfix-candidates/<hash>`不可变候选，不覆盖当前Bundle。在Watcher终端输入`reload <候选目录>`才会触发每个Process独立校验和提交；禁止手工覆盖`dist/hotfix.js`。
- Hotfix候选必须重新注册当前generation的完整Handler集合；删除或重命名Handler必须完整构建并重启，不能通过“候选里省略”继续沿用旧入口。所有Scene/Session/Unit/Event Handler类都禁止字段、构造、静态初始化块和可变静态成员；状态写入目标Scene、Session、Unit或Component。

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

## 怪物模块的最小做法

怪物业务默认采用“MapScene上的一个`MonsterComponent` + `UnitComponent`里的普通`MonsterUnit`”模型。`MonsterUnit extends Unit`，不声明`@actor`，不拥有mailbox；不要为每只怪物创建一个`MonsterActor`、Gate连接或独立V8，也不要在Handler收到请求后扫描所有地图找怪物。

```text
MonsterConfig                 怪物模板：模型、数值、攻击模式、复活时间
MonsterAreaConfig             固定刷怪槽：地图、坐标和初始是否生成
MapHost -> MapScene
  -> MonsterComponent          刷怪、AI、战斗、死亡和重生的唯一拥有者
      -> MonsterUnit            普通Unit，可被UnitComponent和AOI索引，无mailbox
```

开发流程：

1. 在`game_config/Datas`增加或修改模板、刷点，执行`npm run build:game-config`。
2. 需要新协议时先改`proto`，执行`npm run codegen:proto`，不要手写msgcode或Codec。
3. 稳定身份放`app/model/mmorpg/monster`，生命周期和行为放`app/hotfix/mmorpg/monster`。
4. Handler保持一层胶水，例如`C2M_AttackMonster -> PlayerUnit.AttackMonster -> MonsterComponent.Attack`。
5. 通过`MonsterComponent.Get/GetAll`取得怪物；死亡状态、AOI和重生只能由MonsterComponent完成。

当前最小模块的生命周期是“生成、主动索敌/仇恨追击、攻击、玩家攻击、死亡、刷怪槽重生、独立尸体清理”。死亡怪物先以`alive=false`保留原Unit和AOI身份，停止AI、移动和受击；有掉落的尸体保留5分钟，无掉落的尸体保留10秒，首个造成有效伤害的账号拥有普通掉落，归属账号领取完后可以提前清理。死亡时刷怪槽立即释放，`MonsterConfig.respawn_seconds`到期后在同一`AreaId`创建新的MonsterUnit和UnitId，不等待旧尸体窗口；旧尸体继续留在独立集合，清理时才执行`Detach`、AOI Leave和`Remove`。同一个掉落操作重试时由DBProxy回执恢复，不重新计算掉落。被动怪没有仇恨时不主动寻找玩家；平A和技能造成最终实际伤害后都必须通过`MonsterComponent.AddThreat`按1:1增加仇恨，5Hz桶按本地图最高仇恨者追击。12米只负责主动怪在无仇恨时索敌，不能过滤已有仇恨；脱战回出生点应另设冷配置，不能复用主动索敌距离。不能把“被攻击”直接等同于“追击”，也不能绕过`ApplyPlayerDamage`只调用Combat，否则会漏掉仇恨和死亡边界。掉落、技能、任务奖励和持久化是上层业务，应在这个闭环上追加Component或System，不要先改Core。

怪物只作为AOI Subject；进入视野用`MapEntitySnapshot(entityType=2, configId=MonsterConfig.id)`，死亡先通过`EntityState.alive=false`表现为尸体，尸体清理才通过AOI Leave移除旧Unit，复活通过AOI Enter发送新Unit的完整快照。需要不同观众看到不同字段时，新增Projection，不把权限判断写进通用AOI关系表。演示客户端可以读取冷配置中的`attack_mode`做非权威颜色提示：自己蓝色，其他玩家绿色，被动怪黄色，主动怪红色；业务逻辑仍必须以服务端配置和System为准。角色和怪物之间的动态阻挡、动态避障当前明确不做。

自动平A追加在玩家Unit上的`CombatComponent`，不新增`MonsterActor`、每玩家Timer或每玩家Update目标。固定桶分工如下：`Update()`为20Hz基础地图逻辑，`Update10Hz()`判定玩家平A是否开始/中断读条，`Update5Hz()`处理主动怪AI，`Update1Hz()`处理尸体清理和新Unit重生。业务不配置任意Hz；需要完整规则时参考[固定更新桶与自动平A设计](../design/auto-attack-and-fixed-update.md)。

玩家按`1`只是发送`C2M_ToggleAutoAttack`切换攻击意图。服务端要求目标存活、同一MapScene、距离不超过`PlayerConfig.attack_range`且处于角色前方120°，否则保持激活但把当前读条清零；再次满足条件必须从零开始。`G2C_AutoAttackState`只同步状态边界，并且是每个玩家本人频道上的`latest`可覆盖状态，不是不可丢失事件；客户端可以用服务器时间绘制读条，但不能自行结算命中。目标死亡、距离/朝向失效、玩家死亡或主动关闭会结束或重置平A，广播队列不会在固定次数后自动停止。攻击命中、道具消耗等不可逆事实仍使用`event`。目标、范围、朝向、伤害和仇恨都由Map的Hotfix System掌握；怪物攻击距离读取`MonsterConfig.attack_range`。

完整示例和文件位置见[怪物模块教程](../tutorials/16-monster-module.md)。

## 第二步：找到最接近的样例

- 玩家创建和组件装配：`app/model/mmorpg/map/MapComponent.ts::CreatePlayer`。
- 玩家Unit：`app/model/mmorpg/map/PlayerUnit.ts`。
- Unit RPC：`app/hotfix/mmorpg/mapHost/handlers/C2M_UseItemHandler.ts`。
- Unit Message：`app/hotfix/mmorpg/mapHost/handlers/C2M_MoveHandler.ts`。
- Session RPC：`app/hotfix/mmorpg/gate/handlers/C2G_LoginGateHandler.ts`。
- EntryScene RPC：`app/hotfix/mmorpg/mapHost/handlers/G2M_EnterMapHandler.ts`。
- Numeric字典Delta：`app/model/mmorpg/numeric/NumericComponent.ts`。
- Item即时Event：`app/model/mmorpg/item/ItemComponent.ts`、`app/hotfix/mmorpg/item/ItemComponentSystem.ts`和`C2M_UseItemHandler.ts`。
- 帧尾同步：`app/model/mmorpg/map/MapComponent.ts::FrameFlush`。
- 玩家下线保存：`app/model/mmorpg/persistence/PlayerPersistenceComponent.ts`。
- Model/System领域方法范例：`app/model/mmorpg/login/LoginComponent.ts`与`app/hotfix/mmorpg/login/LoginComponentSystem.ts`。
- 客户端Push：`client_demo/cocos_client2D_3.8.6/assets/scripts/Demo/Map/Handlers`。
- Scene发现和调用：`app/core/process/SceneMessageHelper.ts`及`docs/guides/business-cookbook.md`。

先复用这些形状，不重新发明Manager、ServiceLocator或事件总线。

## 部署配置规则

日常本地开发只选择`configs/local/cluster/StartMachine.json`或`configs/local/all-in-one.json`。前者是支持Watcher与热更的多进程默认入口，后者在单一Process/V8中同时演示多Gate、静态地图和动态副本Host。新增独立Process时，在对应部署包目录中新增一个语义明确的JSON，并把文件名加入同目录的`StartMachine.json`。

`cluster/`中的`known-scenes.json`只保存多个Process共用、不可热更的稳定路由；`debug/`只保存Inspector等显式调试变体，不参与默认启动。不要在`local/`根目录再堆放临时Process JSON，不要在`all-in-one.json`中把本进程`scenes`重复写入`knownScenes`。压测、自测和传输实验分别进入`configs/bench`、`configs/tests`和`configs/experiments`。

## 游戏配置开发规则

静态策划配置统一维护在`game_config/Datas`，启动部署配置继续维护在`configs/<environment>`，两者不能混用。新增或修改配置时：

1. 在Excel中维护字段和值；新增整张表时同步登记`__tables__.xlsx`。
2. 用`##group`明确字段属于客户端`c`、服务端`s`或两端`c,s`；服务端秘密和校验数据不得为了省事发给客户端。
3. 跨表ID使用Luban `#ref`，让生成阶段拒绝悬空引用。
4. 纯数据变化如果准备重启服务器，执行`npm run build:game-config:startup`和`npm run test:game-config`；如果要在线热更，执行`npm run build:game-config`并把候选目录交给Watcher的`reload-config`；结构变化执行完整`npm run build`。
5. 服务端通过`GameConfigs`读取，客户端通过分发SDK中的同名入口读取；禁止直接读Excel/JSON、手改Generated或自行维护第二份配置缓存。

`PlayerConfig`表示创建玩家时的基础模板，不表示某个玩家升级后的等级、经验、当前生命或背包结果。运行时状态属于Entity/Component和持久化记录。配置对象与数组只读；`GetAll()`只用于低频初始化和管理流程，帧内热路径应按ID查询或预先建立明确索引。

技能业务统一调用`unit.GetComponent(SkillComponent).Cast({ skillId, targetUnitId })`；外网Handler应调用`PlayerUnit.CastSkill`，玩家Handler和怪物AI不得各写一套施法逻辑。SkillComponent只保存冷却deadline和一个ActiveCast；Cast不是Actor、Entity或Timer。地图唯一`SkillMapComponent`用10Hz桶推进活跃读条和弹道。施法期间`SkillComponent.IsCasting()`为真，平A只能保留攻击意图，不能继续推进读条；移动仍按技能配置决定是否中断。Demo中玩家受到一次没有被护盾吸收的有效攻击时，地图技能调度器把普通读条`finishAtMs`延后800ms；如果当前是引导，则把结束时间提前800ms，但不立即清除引导，二者都会广播新的`G2C_SkillCastState`。真言术·盾吸收本次攻击时，普通读条和引导时间都不调整。这不是通用Combat副作用，不能在Combat里查询Skill或Buff；攻击来源应使用`Combat.ApplyDamage`的结果决定是否调用施法惩罚边界。是否允许移动、何时重置平A均读取`SkillConfig`显式策略，不按技能名称或伤害类型猜测。目标选择、Cast时间线和Action效果必须分层：`SkillConfig.xlsx`描述施法规则，服务端`SkillEffectConfig.xlsx`描述有序Action，伤害/治疗进入Combat、Buff进入BuffComponent。`ChangeNumeric(CurrentHp, delta)`会被配置codegen、`ActionFromConfig`和运行时执行共同拒绝；HP增加必须使用`Heal`，HP减少必须使用`DealDamage`。配置Reload后，已接受的ActiveCast和Projectile继续使用冻结旧定义，新Cast读取新配置。第一阶段开放友方/敌方Unit目标和Instant/Cast，完整调用示例见[技能与施法系统设计](../design/skill-system.md)和[配置化技能教程](../tutorials/18-configured-skill.md)。

游戏配置的表名、字段、类型、分组、索引和引用关系属于Model，不能热更；变化后必须完整构建、重启相关Process并同步客户端SDK。只修改数据行或字段值时，`build:game-config:startup`会重新生成并覆盖服务器重启使用的`dist/game-config`；`build:game-config`只生成独立候选，可通过Watcher的`reload-config`原子切换服务端快照。`test:game-config`只验证，不更新启动目录。Reload不重跑Awake、不修改既有Entity状态；业务不要长期缓存配置行，应在真正使用数值时通过`GameConfigs`查询。客户端数据仍随SDK发布，不能把服务端Reload当作客户端配置下发。详细格式和示例见[游戏配置教程](../tutorials/10-game-config.md)。

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

`XXXComponent`拥有集合并负责集合级操作。Core用`AddChild/GetChild/TryGetChild/GetChildren/RemoveChild`统一维护所有权、EntityRoot和销毁，不需要每个业务Component再写生命周期Map。`ChildEntity`带名义类型标记，编译期和Runtime都会拒绝把普通Unit传给`AddChild`。Entity不等于Actor：Item和Buff即使是Entity，也没有mailbox，不能作为跨Process消息目标。

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

前端背包只做快照投影：使用`ItemSnapshot.itemId`作为格子稳定键，使用`ItemConfig`补齐名称、说明和图标。上线、重连和进图使用`G2C_EnterMap.items`全量初始化，运行期间的使用、拾取、购买、出售和任务奖励都通过`G2C_ItemChanged`发送受影响的单行增量；拾取RPC的`M2C_LootMonster.items`也是本次增量，客户端按`ItemSnapshot.version`合并RPC与Push的重复到达。打开NPC商店时额外使用`M2C_OpenNpcShop.inventory`校正一次当前玩家的私有权威背包投影；这个快照只用于恢复客户端显示，不替代购买、出售时的服务端校验，也不把完整背包塞进普通拾取回包。快捷栏和完整背包必须复用同一个`C2M_UseItem(itemId, operationId)`入口；UI可以禁用按钮、显示冷却和排序，但不能本地扣数量、创建Item或伪造成功消息。移动端背包按钮和面板必须阻止触摸继续传给全屏镜头/寻路层。Cocos Creator 3.8.8 Web会错误降级`[...map.values()]`一类迭代器展开，集合展示必须使用`Array.from(...)`并通过`typecheck:cocos3d-demo`；出现“服务端有数据、UI为空”时必须检查构建后的`assets/main/index.js`，不能只看源码或网络回包。

当服务端判断请求使用、购买或出售的ItemId/数量已经过期时，业务错误响应可以携带可选`inventory_recovery`。该字段存在时，无论`items`是否为空，都代表一次权威整包替换；客户端应先应用快照再显示错误。只有状态冲突错误使用这个修复载荷，冷却、距离、金币不足等普通业务拒绝不应无条件发送整包。

## 编写Handler

Handler只负责协议适配、基础校验和调用领域能力。先按消息目标选择唯一对应的形状：

| 目标 | 装饰器 | Handler首个业务对象 |
|---|---|---|
| 配置Scene | `@rpcHandler/@messageHandler` | Scene |
| 客户端连接 | `@sessionRpcHandler/@sessionMessageHandler` | Scene、Session |
| 可直接寻址的玩家等ActorUnit | `@unitRpcHandler/@unitMessageHandler` | ActorUnit |

不要新增泛化`XxxActor`来承接普通业务请求。连接状态放Session，地图实体状态放Unit，全局业务状态放Scene或其Component。只有`ActorUnit + @actor`能注册Unit Handler并直接拿到目标Unit；普通MonsterUnit没有消息入口，客户端攻击请求先进入PlayerUnit，再调用地图`MonsterComponent`按UnitId取得怪物：

不要使用字符串`@handler`、`ProcessHost.call/send`或给Component动态注册网络入口；这些旧旁路已从Runtime移除。Scene间调用使用`SceneMessageHelper`，Session/Unit入口使用上表中的类型化Handler。

```ts
@unitRpcHandler(PlayerUnit, MapProtocol.UseItem)
export class C2M_UseItemHandler implements UnitRpcHandler<
  PlayerUnit,
  C2M_UseItem,
  M2C_UseItem
> {
  handle(unit: PlayerUnit, request: C2M_UseItem): Promise<M2C_UseItem> {
    return unit.GetComponent(ItemComponent).UseItemTransactional(
      request.itemId,
      request.operationId,
    );
  }
}
```

这里的Handler不发布Veto、不调用DBProxy、不解释Action，也不手工广播。`ItemComponent`拥有道具使用这一条领域用例，负责同步Veto、纯数据事务计划、持久化确认、Entity提交和领域通知；以后增加同类校验或效果时不要把编排重新堆回Handler。

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
6. C++/UE客户端只从`client_sdk/cpp/include/tiangz/generated`使用生成协议；UE插件中的ThirdParty副本由codegen覆盖，禁止手改msgcode、Codec或rpcId。
6. 执行`npm run test:protocol`和相关业务测试。
7. Godot客户端只通过`client_demo/godot-3d-4.7.1/scripts/tiangz_client.gd`调用登录、RPC和Push；协议Codec由`npm run codegen:godot-client-sdk`生成到`scripts/generated/tiangz_proto.gd`，`main.gd`只做节点表现。Godot当前是WebSocket演示适配，不能自行补TCP/KCP或把Godot的`Vector3`写入协议。

不得手工修改`opcode.lock.json/schema.lock.json`来绕过生成器，也不得在业务代码中硬编码msgcode、rpcId或codec。

## EntryScene、动态Scene、Unit和ActorUnit怎么选

使用EntryScene的情况：

- 需要配置启动和跨进程寻址。
- 是独立的顶层业务域，例如Rank、Social、Gate、MapHost。
- 需要部署多个实例并由Directory或业务负载均衡。

使用动态Scene的情况：

- 地图实例、副本实例等进程内业务容器。
- 大量低负载实例需要共享一个Process/V8。

使用普通Unit的情况：

- 对象属于地图，需要UnitId、Component、AOI和完整生命周期。
- 它由地图Component批量更新，不需要其他Scene按InstanceId直接投递消息。
- 典型对象是MonsterUnit和批量NPC。

使用ActorUnit的情况：

- 消息需要以某个Entity为串行和生命周期边界。
- 其他Scene或Gate需要按InstanceId直接投递类型化Unit消息。
- 典型对象是`PlayerUnit extends ActorUnit`并声明`@actor({ mailbox: "ordered" })`。

使用Component的情况：

- 给Scene或Unit组合一项状态和领域能力。
- 它不需要成为独立部署和网络寻址边界。

不要为每张地图、每只怪物、每个组件创建EntryScene。

### 地图坐标与空间模式

服务端和公共客户端SDK只使用引擎无关的米制`x/y/z/yaw`：X/Z是地面平面，Y是高度，Yaw是绕Y轴弧度，Yaw=0朝+Z，前向量为`(sin(Yaw),0,cos(Yaw))`。任何位置都必须同时知道`MapInstanceId`；不得把Cocos `Vec3`、Unity `Vector3/float3`、UE `FVector/FRotator`或屏幕像素写进协议、Native数据或地图业务。UE业务变量必须明确保存TiangZ Yaw，只在Actor表现边界换算成`90°-TiangZYaw`，不得把`FRotator::Yaw`回传。

Grid2D业务使用`cellX/cellZ`和`inputX/inputZ`。Cocos 2D与Pixi在客户端边界将服务端X/Z映射为屏幕X/Y，服务端Y通常为零；3D客户端直接把普通数值转换为引擎向量。禁止再次引入`cellY/inputY`表示地面纵轴，否则2D与3D地图会产生相反语义。

Grid2D客户端只上报移动意图：按下、转向和松开立即发送，按住不变时每`500ms`发送一次保活，静止时不周期发送。窗口隐藏、浏览器失焦和地图销毁必须立即清除按键并发送停止。业务不得把这项`2Hz`输入心跳当成服务端模拟频率；权威移动仍由20Hz Game.Update推进，AOI下行和渲染平滑各自独立。`C2M_MapProbe`只用于测量完整Actor RPC链路延迟，容量基线默认每5秒一次；`C2G_Ping`是Gate存活探测，也固定每5秒一次，不能用二者替代移动或游戏Tick。

Cell是最小空间单位：Grid2D一步移动一个Cell，NavMesh3D允许在Cell内连续移动。AOI只按Grid边界重算，默认15×15 Cell组成一个Grid；Grid从地图最小Cell开始编号，地图宽高必须是Grid边长的整数倍。默认3×3既是Enter区域，也是20Hz高频区；已可见关系移到5×5外圈后降为5Hz，5×5同时是Detach迟滞边界，越界立即Leave。外圈不会让一个从未Enter的单位直接可见，不再保留7×7或1Hz档位。

Enter、Detach和同步频率不是代码常量。开发者在`AoiConfig.xlsx`配置Enter/Detach，在`AoiSyncTierConfig.xlsx`为同一`aoi_config_id`填写任意数量的奇数范围与同步Hz；最外层同步范围必须等于Detach。需要`7×7/1Hz`时，将Detach改为7并增加对应档位即可，不修改Rust或TS。两张表都是Cold配置，必须重新生成并重启，禁止热更。

Cell和AOI Grid尺寸同样属于Cold配置：`MapConfig.cell_size_meters`定义一个Cell的米制边长，`AoiConfig.grid_size_cells`定义每个Grid每条边包含多少Cell。地图制作决定物理宽深并导出为`width_cells/depth_cells`；Grid数量由宽深Cell数除以`grid_size_cells`推导，不另设可冲突的`grid_count`。宽深不能整除时必须调整Cell/Grid划分或在制作阶段显式补边。

容量验收不能只测单一地图密度。框架基线固定用`npm run perf:map-capacity:grid-matrix`比较3000人在10×10、15×15、20×20 Grid中的均匀分布，保持80% Grid内移动、20%每2秒跨Grid以及消息频率不变。业务新增地图时应按实际平均人数/Grid选择最接近的结果，不得把稀疏世界结果当作主城同屏容量。进图并发属于初始化压力，必须受控并与正式稳态窗口分开解读。

创建地图前先从`GameConfigs.MapConfig`读取`spatialMode`。`Grid2D`与`NavMesh3D` Map Runtime均已可创建；NavMesh3D业务通过`MapComponent.ProjectPosition/FindPath`查询，通过`PlayerUnit.NavigateTo`提交权威移动目标，不读取Detour句柄、不逐节点跨V8，也不能捕获导航错误后回退到Grid2D。空间模式、字段结构、Agent烘焙参数和导航资源身份属于Model发布边界；改变正在运行地图的空间实现需要重启Process并重建MapInstance。

动态障碍必须由Map业务使用稳定`ObstacleId`调用`MapComponent.UpsertNavigationBoxObstacle/RemoveNavigationObstacle`，并传入门或路障的真实物理尺寸；Rust会按导航资源烘焙的`agentRadius`自动扩大X/Z占用，业务禁止手工重复增加半径。这里的动态障碍只包括门、路障等业务物体，不包括玩家、怪物、NPC之间的动态阻挡和动态避让；角色之间可以在表现层重叠或由业务技能规则处理，但不进入权威NavMesh TileCache。客户端只能发送业务意图并根据服务端结果更新表现。Cocos、UE或其他引擎中的门模型和碰撞体都不是权威导航数据；禁止客户端先改门状态后补发请求，也禁止用引擎本地寻路结果替代Rust TileCache。Cocos可以为本地预测增加非权威的视觉约束，UE等只插值权威位置的客户端不需要复制碰撞。Cocos 3D与UE灰盒的`E`键动态门是这一调用边界的演示。

导航源网格由制作工具导出到`navigation/maps/<map>/source`，开发者只维护冷清单并执行`npm run navigation:bake`，不得在TS Handler、Game.Update或服务器启动流程中调用烘焙。`C2M_FindPath`是无副作用查询；`C2M_NavigateTo`的Handler只调用`unit.NavigateTo(request)`，方向移动的Handler只调用`unit.NavigateInput(request)`。点击移动由Rust保存路径走廊，在拐点先连续转身再消费剩余Tick时间移动；方向移动由Rust保存输入、1.5秒租约和polygon引用并在固定Tick调用`moveAlongSurface`。客户端的点击预测必须使用相同转向规则，方向输入每500ms续期，零方向输入必须立即停止，断续期也会自动停止。客户端表现层应分别保存权威、可视角色和本地相机朝向；活跃路径预测期间权威Push只能更新校正目标，不能直接覆盖可视朝向，预测结束后再平滑收敛。相机只能按最短角度追随，不能写回权威状态，也不能对角色两侧的摄像机目标位置直接做XYZ插值。客户端可以保存按键和预测路径，以`G2C_EntityNavigate`校正，但业务不得在TS复制权威路径进度或坐标。业务可通过`MapComponent.Raycast/SampleHeight`做NavMesh边界和地面查询，不能把Raycast当成角色物理碰撞。技能冲锋、AI移动等新意图应复用Unit入口或增加同层粗粒度操作，不能在Handler手写逐Tick位移。Demo灰盒是工具与客户端回归输入，不要求程序员手工制作正式3D地图。

门、升降桥和临时路障使用地图内稳定`ObstacleId`，业务调用`map.UpsertNavigationBoxObstacle(id, { center, halfExtents, yawRadians })`与`map.RemoveNavigationObstacle(id)`，不读取或保存Detour引用。相同ID代表同一个业务对象，重复提交相同最终状态必须依赖框架幂等，不要先Remove再Add模拟更新。框架在固定Tick限额提交命令和重建Tile，Handler只提交一次意图，禁止循环等待`upToDate`。完成后Rust会自动重算尚未结束的点击路径；方向输入直接使用新表面。障碍只属于当前MapInstance，同模板副本互不影响，Map销毁自动释放。障碍几何、稳定ID来源、权限、持久化和客户端门表现仍由业务Component负责；`C2M_ToggleDemoDoor`仅用于Cocos灰盒验收，不是正式通用协议。

动态障碍的客户端表现必须采用两步同步：地图进入完成后，`MapSnapshotReady`响应提供当前状态；状态变化后，Map再向该地图所有在线玩家发送状态事件。不能只把状态放在发起者的`M2C`响应中，否则第二个玩家可能看不到门，但服务端导航已经把门当作阻挡。客户端只更新模型显示，不复制Rust TileCache或本地权威碰撞；正式业务应把这套模式封装在自己的Map/Obstacle业务组件中。

详细字段、Rust所有权和客户端进入校验见[地图空间与3D坐标契约](../design/spatial-world.md)。

### 玩家地图传送

静态地图与动态副本都只调用：

```ts
await player.TransferToMap(targetMapInstanceId);
```

业务不得传MapHost、IP、端口或判断目标是否同进程。静态地图的`MapInstanceId == MapConfigId`；动态副本调用`DynamicMapProxy.Create(requestId, mapConfigId)`。`requestId`必须稳定标识一次业务尝试，例如`teamId + dungeonId + attemptId`；网络超时重试必须复用它，新一轮副本必须换新ID，同一ID不得改用其他MapConfig。MapManager选择宿主并返回全局实例号，业务随后只保存并传递实例号。Gate先打开Actor迁移屏障，再由源PlayerUnit mailbox解析实例路由，协调Location锁、目标Unit恢复、位置提交和源Actor清理。迁移保持UnitId，使用目标`MapConfig`出生点，Actor InstanceId与Location revision必须更新。客户端收到RPC和`MapReady`后销毁旧地图作用域Dispatcher，再用`G2C_EnterMap`全量快照重建视图。

MapHost配置静态地图：

```json
{
  "name": "map_1",
  "sceneType": "MapHost",
  "staticMapIds": [1, 3],
  "innerIp": "127.0.0.1",
  "port": 7301
}
```

启动时MapHost逐个调用统一`CreateMap`并向Location注册实际实例。只有`acceptDynamicMaps=true`的Host向单例MapManager注册自身地址、generation、负载和动态创建关系；`staticMapIds`与该开关可组合为静态专用、动态专用或混合承载。Manager与Location共享同一个MapHost generation和15秒租约，MapHost每5秒续租；超时Host不再获得新实例。单独重启Manager时，存活MapHost重发完整创建关系。Manager与动态MapHost双失时，Location删除过期动态路由和旧玩家Actor路由，Gate重连后进入PlayerConfig初始静态地图；同一旧requestId不能静默创建第二份副本。MapInstance与PlayerLocation响应携带MapHost Endpoint，业务不得再用`scenes.byName(dynamicHostName)`。连续无人五分钟自动销毁由MapHost本地`DynamicMapLifecycleComponent`提供，只是业务兜底策略。

地图停机和主动销毁有固定的清理顺序：`MapHostScene.onStop -> MapHostComponent.Shutdown/DisposeMap -> MapComponent.Shutdown/PrepareForDespawn`。静态、动态地图共用这套本地流程：先保存并移除玩家，再清理所有剩余Unit（包括怪物和等待进图的玩家）；每个仍在AOI中的Unit必须先`Detach`，然后通过`UnitComponent.Remove`销毁。该入口会为普通Unit清理本地所有权，为ActorUnit额外清理Actor路由和mailbox，最后才由Scene组件释放AOI。动态地图的Scene本地销毁成功后，MapHost再通过`MapHostControl.DynamicMapDisposed`通知MapManager减少动态实例负载；通知是幂等的，Manager暂时不可用时由MapHostRegistration重试。`ProcessHost`是通用运行时，不知道AOI，不要在业务中直接调用底层Scene销毁来绕过这个入口；`await map.Dispose()`也不会替业务把仍在地图中的玩家强制踢到别处。

稳定基础Scene集中写入共享`knownSceneFiles`；新增动态副本Host只引用该文件，禁止要求所有Gate/MapHost反向追加它。共享文件不可热更，只负责启动依赖；MapManager注册才负责动态发现。完整样例见`configs/local/cluster/known-scenes.json`和`configs/local/cluster/dungeon-1.json`。

完整开发步骤与代码示例见[地图实例与动态副本教程](../tutorials/11-map-instance-and-dungeon.md)。

Component迁移遵循显式选择：默认不迁移，只有稳定Model类型加`@transferable()`并实现同步`ITransfer<TState>`才会参加。`@transferable()`本身就是稳定能力声明，生成器会检查`CaptureTransfer/RestoreTransfer`是否位于Model或对应`@systemFor`实现中；运行时仍保留最后一道防线。`CaptureTransfer`必须返回脱离旧Entity和Native handle的值快照，`RestoreTransfer`写入目标Factory已经创建的同类型Component，两者都不能返回Promise。当前Numeric与Item迁移完整业务值；Position只迁移速度、朝向和存活，故意不迁移旧坐标与移动中间态；Gate绑定、Persistence和Native handle由目标Factory重建。临时仇恨、施法过程、副本局部状态等组件不加标记即可丢弃。

`RestoreTransfer`只恢复权威数据，不负责恢复后的运行时加工。需要重建Timer、派生字典、配置缓存或索引的Component，在Model声明`@lifecycle({ deserialize: true })`，并在Hotfix System实现同步`IDeserialize.Deserialize()`。Entity会先恢复所有可传送Component，再统一调用这些Component的`Deserialize`；持久化加载器以后也复用`CompleteDeserialize()`调用同一生命周期。以Buff为例：传送快照保存Buff及结束时间，`RestoreTransfer`重建Buff数据，`Deserialize`根据剩余时间移除过期Buff或重新注册Timer。框架只保证完整数据图之后、Entity发布之前调用一次，不包含任何Buff规则；`Deserialize`不得再次访问数据库、返回Promise或依赖尚未恢复的外部Entity。

Entity迁移快照只用于一次进程内迁移，不能长期缓存、写数据库或当作跨进程协议。跨MapHost使用稳定protobuf `PlayerTransferSnapshot`和`MapTransfer.Prepare/Commit/Abort`；Location以revision和operationId保护唯一权威地址，Gate的有界屏障按Proto `duringTransfer`处理并发Actor消息。必须执行一次的RPC标记`queue`，查询类可标记`reject`，可覆盖单向状态使用`drop/latest`。业务代码不得扫描所有MapHost、不得把本地`PlayerDirectoryComponent`当全局目录，也不得手写msgcode分支控制迁移。完整语义见[Entity地图迁移](../design/entity-transfer.md)和[Location路由](../design/location-routing.md)。

给PlayerUnit新增需要跨图保留的Component时，除了实现`CaptureTransfer/RestoreTransfer`，还必须扩展`PlayerTransferSnapshot`并升级`PLAYER_TRANSFER_SCHEMA_VERSION`。快照生成和目标校验只能引用这个共同常量，不得各写一个数字；验收至少包含Map1到Map2的真实跨MapHost传送，否则同进程内普通玩法测试发现不了版本不一致。

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

适合开发者维护稳定整数枚举的数值。创建时也直接传`NumericType -> bigint`字典，不要为每个数值再设计一个参数字段：

```ts
const initial: NumericInitialValues = {};
initial[NumericType.MaxHpBase] = BigInt(config.maxHp);
initial[NumericType.CurrentHp] = BigInt(config.maxHp);
monster.AddComponent(NumericComponent, initial);

const numeric = unit.GetComponent(NumericComponent);
numeric[NumericType.CurrentHp] += 1n;
```

Rust自动维护`NumericType -> i64`值与dirty表，TS使用`bigint`，业务字面量应写`1n`。`NumericComponentSystem.Awake`只遍历创建者传入的初始化字典，未传入的普通属性保持Rust默认值`0`；因此玩家、怪物、NPC的默认值应写在各自的创建流程，而不是塞回通用Numeric系统。初始化字典的类型别名不会随着Numeric字段增长而修改；普通属性和Base/Add/Pct来源可以写，`MaxHp`、`Attack`等1000..9999派生结果不能写，错误的key或非`bigint`值会在创建时失败。`1..999`是普通属性；`1000..9999`是只读派生结果；结果编号乘10后加`1/2/3`分别表示Base/Add/Pct。Rust只识别编号关系，不重复维护业务枚举。当前`CurrentHp=1`、`CurrentMp=2`、`MaxHp=1000`、`Attack=2000`、`AttackSpeed=2001`、`MoveSpeed=3000`，对应来源按结果编号乘10加`1/2/3`生成，公式为`(Base+Add)*(100+Pct)/100`。`AttackSpeed`表示每次攻击间隔毫秒，`MoveSpeed`的Numeric单位是毫米/秒，配置表仍填写米/秒。写来源时Rust先计算后原子提交，来源和变化后的结果分别标脏；直接写派生结果会被拒绝。新增同类属性只改TS编号，复杂跨属性公式应写独立Rust领域op。Numeric协议使用`int64`，FrameFlush按`(unitId, numericType)`合并。复制可见性默认Owner-only；只有`NumericReplication.ts`白名单中的公开类型进入AOI受众，当前公开`CurrentHp/MaxHp/Level`。新增Numeric时必须先判断其他玩家是否确实需要它，不能为了省事把MP、经验、攻击或Base/Add/Pct来源加入公开列表。AOI进入快照与增量使用同一公开投影，Owner登录/重连快照保留全量值。

玩家初始魔法值由冷配置`PlayerConfig.initial_mp/max_mp`共同决定当前值和上限；当前演示模板两者均为`200`，因此新玩家进入地图时显示`200/200`，不要在创建逻辑中另写一套默认值。

用`npm run perf:numeric`评估派生计算本身。默认业务仍使用清晰的单字段写入；只有基准和真实业务Profile都证明同一逻辑点会集中修改多个来源时，才考虑新增一次提交多个来源的粗粒度op，不能为了微基准数字强迫所有业务使用批量API。

### 固定字段Dirty Mask

适合字段集合稳定且类型明确的状态，例如Unit速度、存活和显式传送坐标。在`.native`中使用`@replicated`和稳定`@memberId`，codegen生成setter置脏、强类型Delta和Peek/Ack。

普通业务不得仅为了少写TS就选择Native字段。只有权威状态确实需要Rust保存、批量计算或直接编码时才使用。

`.native`是生成器输入。普通业务Entity放在`native_data/<game>`；只有确实需要跨边界粗粒度批处理时，才在同目录新增`XxxOps.native`并实现对应Rust op。`native_data/core`属于框架ABI，业务不得修改。移动等确定性状态机的黄金数据放`tests/fixtures`，不能放进`native_data`伪装成模型定义。

### Rust业务模块目录

开发者明确选择Rust实现的稳定、高负载领域统一放在`src/game/<domain>/`，例如`src/game/buff/`、`src/game/combat/`。`.native`只描述Entity数据和op ABI；`src/game`实现规则、批处理和协议投影。`src/native_data.rs`拥有句柄目录、类型Pool、脏版本和受控存储访问，不再接收新的Buff、技能或战斗业务实现。若业务缺少必要的Store能力，应先增加窄而明确的框架访问函数，禁止把`NativeEntityStore`整体公开给业务模块。

Rust模块随Process编译，不能Hotfix。选择它必须同时满足：状态或算法有明确性能收益、规则相对稳定、能够接受重新构建和重启。活动、任务编排和频繁调整的规则仍优先使用TS Hotfix。

Actor消息不能因为Handler算法位于Rust就绕过TS。正式链路保持`TS定位ActorUnit/Session/Scene -> Actor mailbox -> Native op -> Rust领域模块`；薄适配层可以由codegen生成，但Location、传送屏障、RPC错误和mailbox顺序仍由TS框架拥有。普通MonsterUnit没有Actor入口，它由Map Handler或所属MonsterComponent进入Rust批处理。只有Ping、握手等不访问业务Actor的基础设施控制帧允许在Rust网络入口直接消费。

### Item等即时Event

库存、技能命中和奖励是不可覆盖事实。修改权威状态后立即发布event；如果同一次操作还改变可覆盖属性，例如速度，则该属性继续走帧尾Delta。

`ItemComponent`通过Core子Entity容器拥有`Item`；每个Item内部持有自己的`NativeItemRef`，其InstanceId与子Entity真实生命周期一致，不再由ItemComponent伪造ID。外部读取使用`GetItem`返回的`ItemView`，集合修改使用Component领域方法，Item局部状态修改使用Item领域方法；只有对应System可以直接操作可变Native句柄。

### Buff与AOI

Buff作为ChildEntity只解决身份、生命周期、热更方法和Timer归属，不负责选择网络接收者，也不使用通用dirty字段同步：

```text
创建Buff -> 给使用者回显M2C_UseItem.buff，并向当前AOI广播BuffAdded
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
- Buff冲突由`stack_group + stack_scope + sourceUnitId`形成稳定冲突键，再由`conflict_policy`决定Stack、Refresh、Replace、Reject或HigherWins。不要用`unique`布尔值或ConfigId大小硬编码。Refresh默认不重复执行AddAction；是否更新来源、Tick节奏和运行状态只读对应配置列。
- 客户端从BuffAdded或Unit Snapshot携带的开始/结束时间自行计算剩余时间，服务端不逐Tick同步倒计时。
- 进入AOI时Buff列表包含在Unit整体Snapshot中；离开AOI时Unit整体消失，不逐个发送BuffRemoved。
- 不扫描EntityRoot收集Buff，也不让每个Buff成为Actor。未来AOI直接从目标Unit的BuffComponent取得快照。
- 少量Buff允许使用`Buff.NewOnceTimer/NewRepeatedTimer`；大量Buff推荐在BuffComponent保存`nextTickAt/expireAt`，使用最小堆和一个最近到期Timer统一调度。持久化保存时间戳，不保存TimerId。

如果未来出现层数刷新、图标变化等确实需要客户端立即知道的Buff元数据变化，应新增明确的`BuffUpdated`事件，或者将旧Buff Remove后重新Add；不要为了少数需求让全部Buff每帧维护dirty和Delta。

### 战斗伤害与效果解耦

受到伤害不能反向调用`BuffComponent`。目标Unit统一挂载`CombatComponent`，攻击者只负责选择目标并提交`DamageRequest`：

```text
Monster / Skill / Action
  -> target.GetComponent(CombatComponent).ApplyDamage(request)
  -> CombatComponent执行已注册的受伤处理器
  -> 剩余伤害修改Numeric.CurrentHp
  -> 返回DamageResult
```

`CombatComponent`负责目标本身的伤害、治疗、护盾消耗、死亡标记和结果；不负责找目标、距离、朝向、AI、重生、AOI或Gate。`MonsterComponent`、技能System和Action只负责攻击者侧规则，不能直接写`CurrentHp`。道具回血统一调用`ApplyHealing`，治疗上限和死亡限制由CombatComponent处理。

护盾Buff添加时调用`RegisterDamageAbsorber`并保存返回的`modifierId`，Buff删除或过期时调用`RemoveDamageAbsorber`。伤害入口不查询Buff，也不调用`TryAbsorbDamage`。护盾剩余量以Combat注册处理器为权威，Buff不与Combat各维护一份会分叉的副本；需要持久化或投影时通过ID读取或更新。

```ts
const combat = unit.GetComponent(CombatComponent);
const modifierId = combat.RegisterDamageAbsorber(5_000n, 100);
const result = combat.ApplyDamage({ amount: 300n, sourceUnitId: attacker.UnitId });
combat.RemoveDamageAbsorber(modifierId);
```

Numeric HP是可覆盖状态：旁观者走1Hz帧尾latest；受击者和有效攻击者走只含参与者的私有`G2C_CombatResult`即时事件，收到精确CurrentHp、实际伤害/治疗和`serverTick`。技能命中、死亡、掉落和道具消耗是不可覆盖事实，走event。Combat不选择广播受众，Buff公开外观和受限详情继续沿用前面的AOI Projection规则。完整调用关系、生命周期和禁用示例见[战斗伤害与效果管线](../design/combat-damage-pipeline.md)。

### Quest生命周期与可见范围

任务系统区分“正在进行的实例”和“已经完成的事实”：

```text
QuestComponent
├── activeQuests: Quest ChildEntity集合
└── completedQuestConfigIds: Set/Bitmap
```

- 玩家没有进行中任务时，QuestComponent可以不包含任何Quest子Entity。
- 接受任务时通过`QuestComponent.AcceptQuest(questConfigId)`创建进行中实例；当前不可重复任务直接以`BigInt(questConfigId)`作为Child ID。
- 活动Quest状态只有`InProgress`和`ReadyToTurnIn`；达到要求只切换为待交付，领取奖励成功后才写完成集合并移除ChildEntity。`ReadyToTurnIn`不能从任务追踪面板直接领奖，必须在NPC交互范围内提交NPC实例ID，由服务端再次校验。
- 接取时冻结`objectiveId/current/required`。热配置切换只影响新接取任务，不能让进行中的要求数量漂移。
- 怪物、道具和地图只在事实成功提交后同步发布`QuestEvents.Progress`；稳定事件Handler负责调用`ApplyProgress`。`QuestComponent`按`(objectiveType,targetConfigId)`运行时索引定位目标，来源模块禁止遍历Quest或直接改进度。索引只保存稳定ID并在接取、领奖、Deserialize和RestoreTransfer时维护，不能进入持久化快照。
- 接取前统一执行同步`QuestEvents.BeforeAccept` Veto；前置任务和最低等级是配置最终不变量，阵营、职业、NPC关系等扩展条件注册独立监听器。Veto只能读内存和返回错误码，禁止Promise、RPC、数据库、修改Entity或Spawn后台任务。
- 进度变化通过owner-only `G2C_QuestProgress`通知拥有者客户端，并按QuestConfigId在同帧latest合并，不广播给普通地图观察者。
- 只有组队共享任务明确需要时，才向`PartyAudience`发送必要的进度摘要；不要把完整Quest对象发送给队友。
- 完成时由`QuestComponent.CompleteQuest`在PlayerUnit有序mailbox内等待一次关键事务：Inventory先生成纯数据计划，DBProxy提交奖励后的玩家记录和业务结果，成功后再写入Item/已完成Quest并`RemoveChild`；Handler只负责RPC与提交后的奖励同步，不能直接访问Repository或把步骤拆散。
- 登录或重连时向本人发送活动Quest和已完成摘要的全量快照。队友进入AOI时，可随Unit整体Snapshot取得允许共享的任务摘要；普通观察者的Unit快照不包含Quest。离开AOI时只移除Unit。

如果同一配置任务不会同时存在多个活动实例，可以直接用配置ID作为ChildEntity Id；可重复任务、限时活动任务等允许并存时，必须使用独立Quest实例ID，并单独保存`configId`。已完成集合始终记录稳定配置ID，不保存已经销毁的InstanceId。

当前配置入口为`QuestConfig.xlsx`和`QuestObjectiveConfig.xlsx`，奖励复用Action；`required_quest_ids`和`minimum_level`声明基础接取条件。演示目标覆盖击杀怪物、使用道具和进入地图；Starter任务链为5001击杀5只怪A，NPC交付后按`required_quest_ids=[5001]`解锁5005击杀5只怪B。5004继续验证“完成5001且达到2级”。`GrantItem(ItemConfigId, Count)`和`GrantItems(...)`必须通过Inventory，由Inventory填充已有堆叠并按`max_stack`拆分新Item。普通同步奖励仍可使用`ExecuteReward`；关键任务奖励使用`PlanTransactionalReward -> ItemComponent.PlanGrantItems -> PlayerPersistenceComponent.ApplyTransaction -> CommitGrantPlan`。规划阶段不能修改Entity，提交成功前不能响应客户端。当前事务Planner只支持GrantItem，新增其他Action必须先实现纯数据规划和恢复规则。组队任务需要Party与PartyAudience，当前不要在Quest里提前实现队员共享。完整代码和协议调用见[任务系统设计](../design/quest-system.md)。

### NPC接取任务

Starter第一版的任务使者遵循“普通Unit + QuestComponent”的最小边界：

```text
MapHostScene
  -> UnitComponent.Create(NpcUnit)
  -> NpcComponent维护地图内NPC索引
  -> MapAoiComponent.Attach(npc, observer=false, subject=true)
  -> 客户端收到MapEntitySnapshot(entityType=3)
  -> 玩家选择NPC
  -> C2M_AcceptQuest / C2M_CompleteQuest(questConfigId, npcUnitId)
  -> PlayerUnit ordered mailbox
  -> NpcComponent.ValidateQuestInteraction
  -> QuestComponent.AcceptQuest
```

客户端调用只使用可见快照中的NPC UnitId：

```ts
const npc = visibleEntities.find((entity) => entity.entityType === 3);
if (npc) {
  await mapClient.acceptQuest({
    questConfigId: 5001,
    npcUnitId: npc.unitId,
  });
  await mapClient.completeQuest({
    questConfigId: 5001,
    npcUnitId: npc.unitId,
  });
}
```

- NPC UnitId只是当前地图实例的运行时实体地址，不能保存为任务归属或玩家数据；任务保存的是`questConfigId`和Quest状态。
- Handler只转换协议，不能直接判断距离、修改Quest状态或绕过mailbox。服务端必须同时检查NPC仍在当前Map、确实提供该任务、玩家在交互范围内以及Quest自身的Veto/前置条件。
- Starter的Map 100固定创建`npcConfigId=9001`的紫色方块任务使者，交互范围为5米；Map 100使用Demo专用宽视野`AoiConfig=2`，7×7 Grid建立可见关系、9×9 Grid作为Detach边界，远端刷怪区放置三只被动黄色怪和两只主动红色怪，任务5001要求击败5只怪A，任务5005要求交付5001后击败5只怪B，避免新玩家出生即进入战斗。`MapEntitySnapshot.displayName`是服务端提供的公开名称：玩家使用角色名，NPC和怪物使用各自冷配置名称；客户端只负责显示，不能通过`configId`猜测或硬编码业务名称。Starter当前所有QuestConfig都关闭自动接取，任务只能由NPC/剧情等明确业务入口发起。Cocos3D的桌面端和移动端都遵循“靠近5米显示交互按钮 -> 打开NPC对话 -> 点击接取/交付任务”流程；选中NPC、看到NPC或打开对话框都不能直接改变任务状态。后续对话、多个NPC和可重复任务只扩展配置与领域行为，不复制第二套NPC网络系统。
- 完整任务链验收必须调用正式协议，禁止夹具直接写Quest或Inventory。`starter:acceptance`会在all-in-one与split-process中接取5001、击杀5A并交付、接取5005、击杀5B并交付、接取5006、逐尸体领取5个徽记并最终交付，再跨图核对完成集合与奖励快照。

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
- 业务不得把AOI Enter/Leave当作可随意丢弃的普通latest；关系变化先按`observer + subject`合并最终状态，再进入可靠发布。若未来增加关系快照重同步，必须由框架显式标记，不能只靠“丢旧Leave/Enter”猜最终视图。
- AOI已经接管Movement、Numeric和Unit固定字段的接收者选择；新增业务广播必须选择明确Audience，不能重新构造全地图玩家列表。

通用广播按`descriptor + audience + Gate`建立独立频道，不再让一个慢Gate成为跨Gate完成屏障。同一次逻辑发布跨Gate时复用一份不可变编码帧；只有某个Gate的pending latest与后续发布合并后才单独重编码最终项，业务和Transport都不得为了路由隔离重复编码相同payload。`event`是每Gate有界可靠FIFO，满载必须失败；`latest`是每Gate single-flight，未发送旧状态可被同key新状态覆盖。被覆盖的发布Promise表示“已由更新状态接管”并立即完成，只有当前最终版本继续等待Transport结果；业务不能把latest Promise理解为每个中间版本都实际到达客户端。框架对latest待发item、编码字节和等待年龄设有上限，`latest_capacity_rejections_total`非零意味着容量或链路故障，不能靠扩大上限掩盖。

`SceneBroadcastTransport`只合并相同Gate、相同投递类别的作业；内网`delivery_class=1`表示可靠事件，`2`表示可覆盖状态。Gate将客户端出站分成control response、reliable event和latest state三个队列，按该优先级在同一Update中交给Host批量写出，最终仍共享一个客户端TCP连接并保留每条客户端frame边界。Movement和Numeric的Rust route frame自带每Gate itemCount及latest类别；共享Numeric revision必须等待全部相关Gate成功后Ack，任一路失败都保留Dirty。业务不得分配routeId、调用任何`*AoiRouteFrames` Native op、调用`SceneMessageHelper.sendFrame`，或直接构造`S2G_ClientBroadcastBatch`。不能为了追求“一Tick一包”而延迟技能、Buff、道具、伤害等可靠事件，也不能把多个客户端msgcode拼成私有payload。

跨进程Transport的call与send流拥有独立保留容量和公平调度；目标Process入口也把`eventQueueCapacity`按1:3划分为控制流与数据流，内部RPC、断线和Host completion走控制流，内部单向帧走数据流，每连续32个控制事件至少调度一个数据事件。业务不应自行扩大队列或依赖重试风暴；收到`SystemErrCode.SceneOverloaded`时立即结束当前业务请求并向客户端返回明确业务错误，不能把它包装成普通超时。目标控制入口队满时Rust宿主会按原`rpcId`立即返回过载，来源进程不会继续占用pending waiter；单向广播本来就不占用RPC pending waiter。Disconnect可能先于旧数据帧到达TS，Core会用30秒有界墓碑丢弃该连接残留帧并增加`connection_ingress.dropped_frames_after_disconnect_total`；业务Handler不需要也不允许把这种宿主顺序修复成ActorLocation重试。排查过载或超时时查看按msgcode、source、target、traffic和queue stage细分的`/metrics`指标，并同时检查`queueStages.control_ingress/data_ingress`，不要只看聚合`frame`深度。

对“同一玩家较新的输入可以完全替代旧输入”的ActorLocation单向协议，可以声明`// @ets.msg ... forwarding=latest`。Core会在Gate按`connectionId + msgcode`合并20ms窗口，并按目标Scene批量跨进程转发；Map解包后仍逐条进入目标Unit mailbox。它适合移动意图，不适合RPC、技能释放、道具使用、背包变化、交易和伤害事件。代码生成会拒绝把该策略放到RPC或非ActorLocation协议上；业务不得手写Core批量msgcode。压测和线上诊断查看`actor_latest_forward`的输入、覆盖、转发、批次、失败和丢弃计数。

## 定时器和Update

Component拥有的周期任务使用组件定时器：

```ts
const numeric = player.GetComponent(NumericComponent);
const attack = numeric[NumericType.Attack]; // 玩家由AttackBase=5n推导得到
```

Numeric不再内置100ms回血Timer。需要回血、Buff或其他周期规则时，由对应业务Component显式创建Timer；玩家创建时设置`AttackBase`，怪物创建时根据配置设置`AttackBase`，普通攻击统一读取最终的`NumericType.Attack`。当前不增加Armor字段，伤害是多少就扣多少CurrentHp。

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

Developer Tools会检查Timer方法名和取消回调是否存在、取消回调是否接收`(args, context)`、同步/Veto Event Handler是否错误声明`async`，以及持久化Snapshot是否错误声明`InstanceId/TimerId`。命令面板可执行“TiangZ：运行 Runtime Foundation 自测”，其结果与`npm run test:runtime-foundation`一致。

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
- 同一Scene内按门派、队伍、交易单等业务键防重入时使用`await scene.Locks.RunExclusive(domain, key, callback)`。它不跨Process，不替代数据库事务。无竞争时回调会同步开始，因此需要阻止后续消息抢跑的标记必须放在回调第一个`await`之前。
- 同一Scene已经发生的功能通知使用`defineSyncEvent + scene.Events.Publish`；可扩展的操作前置条件使用`defineVetoEvent + scene.Events.Check`。两类Handler都必须同步，不能I/O或返回Promise。
- Veto Handler返回`0`放行，返回第一个非零业务错误码时立即停止。它只能读取上下文，不能在检查中扣道具、加Buff、改Numeric或启动任务。监听器在Hotfix中按稳定`id`注册，不为每个Unit动态保存闭包；模块是否激活由Handler读取Component/Native状态判断。
- 明确不等待结果且完成时间不影响当前业务的短任务使用`scene.Tasks.Spawn(name, body)`。框架捕获错误并纳入Hotfix排空；每个Scene最多256个在途任务，超过10秒记录告警。永久循环、事务、玩家有序状态修改、精确定时和需要响应的RPC禁止使用Spawn，任何Update/FrameFlush中也禁止逐帧Spawn。
- 跨Scene、跨Process、需要mailbox顺序或需要响应的交互仍使用生成的Message/RPC，不能拿Event代替。

详细API和错误边界见[运行时基础能力](../design/runtime-foundations.md)与[Veto Event和后台任务设计](../design/veto-events-and-spawn.md)。

## 玩家下线和持久化

玩家保存应封装在玩家内部的生命周期能力中。断线、踢下线和Process停机共用同一个幂等Promise：

```ts
await player.Offline(reason);
```

业务Handler不要直接调用Repository，否则会绕过幂等保存和统一移除流程。普通socket断开只销毁`GateSession`，不能直接调用玩家`Offline()`；`GatePlayerRoute`在Gate继续保留30秒等待重连。宽限期结束后只能由Gate调用`MapProtocol.PlayerOffline`，Map先完成保存和Location移除并返回Unit RPC，再由下一轮Map Timer执行`RemovePlayer`、AOI离开和Actor销毁。`PlayerOffline`运行在PlayerUnit自己的ordered mailbox时，禁止在当前调用中同步销毁这个Unit；否则RPC返回前Actor已经消失，运行时会报告`actor despawned during mailbox execution`。停机批量清理可在不占用Unit mailbox的地图清理阶段直接完成，但仍须遵守先保存、再脱离AOI、最后销毁Actor的顺序。

玩家Unit只保存`gateName + gateEpoch`，不得保存`connectionId`、`GateSessionId`或自行创建断线Timer。同Gate重连使用`SecondEnterMap`恢复客户端全量视图，不创建替代Unit、不触发AOI进入。跨Gate故障接管必须由PlayerUnit邮箱调用Location完整CAS，提交后原地更新UnitGate、Actor fence和AOI delivery route；业务不得直接改gateName或复用旧epoch。客户端空闲时每5秒调用`C2G_Ping -> G2C_Ping`；任何入站消息都会续期，服务端出站消息不会续期。Session默认unordered，Ping作为普通TS Handler直接返回`TimerSystem.ServerTime()`产生的Unix毫秒且不加锁。登录按连接与账号加锁；进图、重连、传送、快照确认和最终下线按账号加锁。业务只锁会修改共享状态的事务，禁止为了省事把整个Session改回ordered。

同一账号在同一Gate再次登录时属于“顶号”，不是一次普通断线重连。Gate必须在账号锁内先把旧`GateSession`失效，再发送`G2C_SessionReplaced`，最后关闭旧连接；旧连接的迟到断线、在途请求和旧Promise都不能影响新`GatePlayerRoute`。客户端只需要订阅SDK事件，不要把顶号当成普通网络错误自动重试：

```ts
const stop = loginFlow.onSessionReplaced((message) => {
  message.reasonCode; // 10040
  clearLocalGameState();
  showLoginPanel(`连接已被顶号：${message.reason}`);
});
```

服务端关闭连接前会排空已经入队的通知；SDK的`RpcSocket`会保留关闭前已经收到、但尚未由游戏循环`update()`分发的单向消息。客户端仍必须持续驱动`update()`，不能只依赖网络回调。同Gate顶号使用连接代次；跨Gate故障接管使用Location gateEpoch与ActorLocation fencing。两者都不会迁移原Socket。

Gate候选排序统一复用`RankStickyScenes/SelectStickyGate`，业务不得另写取模、随机或自定义账号哈希。Login先保留Location记录的当前健康Gate；仅当它不可达时才依Rendezvous顺序探测其他Gate。恢复节点不自动回切现存玩家；绕过Login连接旧Gate也必须在旧所有者健康探测和Location CAS处被拒绝。

DBProxy独立仓库已发布`v0.5.0`：除PostgreSQL权威快照、Revision/CAS、幂等事务与回执查询、Redis缓存与持久Backlog、Rust客户端池和运行时无关TypeScript SDK外，还提供多Endpoint故障切换、两个共享存储的无状态对等实例，以及跨记录全量CAS原子事务。TiangZ主工程配置通过`endpoint + failoverEndpoints`声明地址，业务层不得复制协议或自行实现第二套故障切换。30秒周期快照、有限并发最终Flush、静态MapHost有界重启和双Gate强杀接管均已验收。Gate接管保留存活MapHost上的PlayerUnit，不依赖DBProxy重建；它不恢复原Socket、Gate本地队列、怪物/仇恨或动态副本现场。

跨玩家关键操作的固定写法是：领域Component先同步冻结会话，最终提交者保留自身PlayerUnit ordered mailbox，并通过地图宿主进入另一参与者的真实ordered mailbox；持有双方邮箱后，Planner再从权威快照生成全部`expectedRevision + nextPayload + result`，领域Repository按稳定顺序调用一次多记录事务，提交成功后各Participant无await应用结果。只锁会话对象不能阻止另一玩家在`await`期间使用道具或改金币。响应不确定时用同一`operationId`查询回执；业务冲突直接结束会话，不能换operationId重试。玩家交易参考`app/hotfix/mmorpg/trade`和[玩家交易设计](../design/player-trade.md)。Handler只转发到PlayerUnit ordered mailbox，不得直接调用DBProxy。

## AOI业务规则

完整的数据结构、生命周期、Movement直达Gate链路和函数调用图见[AOI完整设计与函数调用关系](../design/aoi-architecture.md)。本节只保留业务开发规则。

地图业务不再构造“全地图玩家列表”广播Movement、Numeric或Unit固定字段。`MapAoiComponent`拥有Rust推导的最终可见结果；Movement由Rust在帧尾直接生成按Gate路由的完整批帧，`MapComponent`只调用框架封装并提交结果，不把recipientId数组拉回TS。Rust内部使用扁平AOI Grid、紧凑`EntityIndex`、连续成员数组和双向可见位图；热点Grid会由框架自动增加成员位图。这些都是框架实现细节：业务不得读取或保存`EntityIndex/slotInGrid`，不得假设UnitId等于位图下标，不得配置热点阈值，也不得按Tick重建自己的空间索引。业务过滤仍通过`IAoiVisibilityFilter`和显式Invalidate改变最终可见位图。状态复制按Subject Grid合并相同受众，不按每名接收者复制记录索引。业务TS不得镜像全量关系表、管理delivery route、手工合并Grid受众或直接发送内网帧。开发普通移动、传送、上线或下线时不得手工调用底层Native AOI op；X/Z FastOP、`PlayerEntered`和`RemovePlayer`生命周期已经接管。

普通Unit进入/离开视野也不由业务逐个发送。框架把同一帧、相同受众的不可覆盖变化合成`G2C_AoiDelta`，客户端SDK的Handler负责遍历`enters/leaves`。新增Buff、任务摘要等领域可见事件时，应先判断它属于Unit整体Snapshot、独立不可覆盖Event还是可覆盖状态；不得把业务字段塞进通用AOI Delta，也不得恢复逐关系`Publish`。

同一批次内重复的`ObserverId + SubjectId`关系只发布最后状态，并保持首次出现顺序；Enter→Leave或Leave→Enter的中间状态会被丢弃。这个规则只适用于尚未发布的AOI空间关系，不能用于掉落、伤害、奖励、背包变化等不可覆盖事实；显式Invalidate的返回值仍必须交给`MapComponent.PublishVisibilityChanges`。

阵营、隐身、位面等规则实现同步过滤器：

```ts
class PhaseVisibilityFilter implements IAoiVisibilityFilter {
  CanObserve(observer: Unit, subject: Unit): boolean {
    return observer.GetComponent(PhaseComponent).PhaseId ===
      subject.GetComponent(PhaseComponent).PhaseId;
  }
}
```

`CanObserve`只能读取内存中的Component并立即返回`boolean`，禁止`async`、Promise、RPC、数据库、发消息和修改Entity；异常会按不可见处理。过滤器不会每帧运行。业务状态变化后，必须按影响方向显式通知地图：只影响“我能看见谁”调用`InvalidateObserver(unit)`；只影响“谁能看见我”调用`InvalidateSubject(unit)`；双向规则调用`Invalidate(unit)`。三个Invalidate方法只返回关系变化，不自行发消息；调用方必须继续调用`await map.PublishVisibilityChanges(changes)`，由地图统一合并并发布Enter/Leave。AOI当前只筛选接收者，技能命中、组队权限等业务权威判定仍由各自领域逻辑负责。

空间配置只通过Luban Cold表维护：`MapConfig.cellSizeMeters`定义米制Cell；`AoiConfig.gridSizeCells`定义一个AOI Grid包含多少个Cell；`enterRangeGrids`和`detachRangeGrids`分别控制建立与移除可见关系；`AoiSyncTierConfig`只控制已经可见关系的可覆盖状态频率。范围填写奇数边长，例如3表示3×3 Grid。同步范围可以大于Enter，但不会提前Enter；同步最大范围也可以小于Detach，迟滞外圈此时只保持可见，不接收周期可覆盖状态。Movement的开始、停止和转向不受节流；低频档由框架按Subject Grid稳定错峰。Numeric、技能、Buff等仍按自己的状态或事件语义发送。业务代码不得根据距离自行重复一套频率判断。

`MapConfig`、`AoiConfig`、`AoiSyncTierConfig`是Cold表，任何值变化都必须完整构建并重启Process；`ItemConfig`和`PlayerConfig`当前是Hot表，可以在线替换数据。表结构始终属于Model。新增配置表时必须在`ConfigTablePolicy.xlsx`登记整表策略，不允许一张表内混合Hot与Cold字段。

### 地图入图节流

首次登录或`TransferToMap`到达目标地图时，业务不应直接调用底层AOI Attach，也不需要自己创建Loading队列。`MapComponent.PlayerEntered`会进入当前MapInstance的等待队列，地图每Tick最多按`MapConfig.entryPlayersPerTick`放行；`entryQueueCapacity`满时明确拒绝，防止无限积压。Gate保持连接并等待`EnterMap`或传送响应，客户端继续显示Loading。首次进图和传送链路由框架统一使用10分钟Admission事务上限，不继承普通Scene RPC的5秒默认值；业务不得自己套一层更短超时破坏队列语义。断线重连调用`SecondEnterMap`并复用原Unit，因此不进入该队列。

同一Tick放行的玩家会先统一完成AOI Attach，再准备初始实体快照。生产进入流程中，`EnterMap`只返回小型进入信息；客户端创建地图对象并注册`G2C_AoiDelta`监听后调用生成SDK中的`GateClient.mapSnapshotReady({ unitId })`，框架随后通过已有广播接口发送初始`AoiDelta`。业务不应手写Gate路由，也不应把初始实体数组重新塞回EnterMap。快照暂存由`MapComponent`管理，玩家移除和地图销毁自动清理。`player_entry_snapshot_items_total`是逻辑发送条数，不能拿它直接当成对象分配数；性能分析还要看`player_entry_snapshot_materialized_items_total`和复用命中指标。不要为了追求更高进图吞吐直接把`entryPlayersPerTick`调大，必须通过分批A/B同时观察Map CPU、初始AoiDelta下行队列和Loading时延。

当前Starter地图正式值是每Tick `2`人，其他地图以各自`MapConfig`为准。业务开发者不得在Hotfix中动态修改该值，也不得只根据平均Loading时间调整；修改Cold表后必须完整重启，并至少验证完整`full`语义、队列峰值、Location延迟、Gate下行、错误和长窗口稳态CPU。

这套机制只处理同一地图瞬时进入洪峰。它不检查区服总人数，不显示排队名次，不保证某张地图适合继续接收玩家，也不代替副本分配和MapHost容量规划。业务仍只调用统一传送入口，不为静态地图、动态副本、同进程或跨进程分别写节流代码。

业务不得使用`EntrySyncMode`跳过新玩家Snapshot或老玩家Enter；非Full模式只编入Bench Handler，用于`perf:map-entry-stages`拆分性能。排查进图慢时依次观察MapHost请求、Admission等待、Attach、Snapshot对象数、AOI Delta逻辑投递量和Gate下行，不得通过删减客户端必需状态制造虚假的容量结果。Prometheus标签中禁止加入account、UnitId和connectionId。

计划中的开发者语义只保留三种存储域：

持久化基础设施放在独立的[TiangZ-DBProxy](https://github.com/moulo1982Google/TiangZ-DBProxy)仓库中，不能成为`src/game`下的TiangZ Rust业务模块。DBProxy核心提供与游戏无关的`RecordKey`、快照Payload、Revision/CAS、幂等写入、普通批量Load/Save/Enqueue、单记录`TransactionalWrite`、多记录原子事务、Redis AOF backlog和独立网络服务；PostgreSQL是权威端，Redis只承载已提交快照缓存与可恢复的普通快照积压。TiangZ Rust Host通过连接池和有序多Endpoint接入DBProxy，业务层不得直接连接Redis/数据库。30秒周期快照、静态MapHost有界接管、双Gate接管和动态副本安全回退已验收；旧schema迁移、跨机器仲裁和跨地域容灾仍未收口。

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

本地只修改Hotfix行为时，可运行`npm run dev -- configs/local/cluster/StartMachine.json`后直接保存TS文件；开发宿主会自动生成注册入口、类型检查、构建不可变候选并Reload。需要在VS Code断点调试中持续Reload时使用`npm run dev:debug`：初始和后续候选都带内联sourcemap，Process/V8/Inspector连接不重启，新脚本会重新绑定TS断点。若V8正停在断点必须先Resume；当前栈继续旧代码，后续调用才使用新generation。构建失败时旧generation继续运行。这个便利入口不适用于Model字段、Core、Proto或`.native`变化，也不用于正式部署。Developer Tools把Model长期状态中的显式`any`、可选字段、基本类型与`undefined`联合、跨基本类型联合、`delete`字段和`as any`写属性视为错误；请使用稳定默认值或明确的数据结构。对象`T | null`、判别联合、显式Map/Record和普通DTO仍可正常使用。

正式环境先把完整`dist/hotfix-candidates/<hash>`原子发布到目标机器，再执行`npm run hotfix -- plan`预览；确认后用`apply`提交，用`status`核对generation与active/previous候选，必要时用`rollback`重新提交previous候选。目标Process必须显式配置`process.lifecycle.hotfixOperations.authTokenEnv`，实际令牌只放环境变量。管理路由仅允许本机Bearer鉴权访问，不能加入公网反向代理。CLI可用重复`--target`选择Process，并在同机多目标部分失败时补偿回滚本次成功目标；跨机器尚无Prepare/Commit，不能宣称全局原子。每次操作必须保留operationId与`temp/hotfix-operations/audit.jsonl`审计，但禁止记录令牌。

| 修改类型 | 最少验证 |
|---|---|
| 纯TS业务Component/Handler | `npm run typecheck`和对应自测 |
| 只修改Hotfix行为 | `npm run build:hotfix`、`npm run test:hotfix`；涉及操作入口或调试重绑时追加`npm run test:hotfix-operations` |
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

Cocos业务脚本提交前应在打开过工程的Cocos环境运行`typecheck:cocos-demo:engine`；CI中的`typecheck:cocos-demo`只保证入口及依赖可bundle，不伪造引擎类型。客户端SDK本身仍必须通过与引擎无关的`typecheck:cocos-net`。Web包只使用统一命令`npm run build:cocos3d:web`、`npm run build:cocos3d:mobile`或对应的2D命令；这些命令默认是Release，Debug只能使用带`:debug`后缀的命令。命令会匹配Creator版本、清除`ELECTRON_RUN_AS_NODE`、清理并检查标准输出；`npm run check:cocos-build`可在不启动编辑器时预检。Creator 3.8.x本机的`code=36`只有在`index.html`、`application.js`和`assets`均生成时才接受，其他非零码不得忽略。不要手工调用Creator CLI，不要提交`library/temp/build`缓存，也不要把Cocos Native误当成Web构建；Native必须先生成原生工程后再走CMake/Visual Studio。

## 后续Map同步策略

同步方式属于Map的玩法策略，不属于整个Process或Runtime。Phase 4后续允许普通大世界使用状态同步、竞技场等独立Map使用帧同步，以及少数高精度场景使用高频状态同步。同一个部署中可以同时存在这些Map，但玩家切换同步方式应通过退出旧Map、进入新Map完成。

当前业务继续使用已有状态同步链路，不要提前在Handler中散落同步模式判断，也不要自行建立另一套帧号、输入队列或广播接口。后续实现应由Map创建配置选择策略，并由对应Component承接输入、模拟和广播；Handler仍只表达移动、施法等领域意图。逻辑Tick、网络同步频率与客户端渲染频率必须分别配置，提升其中一项不能隐式提高其他两项。

## 怪物基础AI开发约束

当前怪物只支持固定刷点、主动追击、两米内普通攻击、Numeric扣血、死亡和重生。调用链保持为：

```text
C2M_AttackMonsterHandler
  -> PlayerUnit.AttackMonster
  -> MonsterComponent.Attack
```

固定刷点和实体身份必须分开：`MonsterAreaConfig.id`对应稳定的`AreaId`刷怪槽位，`MonsterUnit.UnitId`只对应一次实体生命周期。死亡时槽位清空当前活怪并启动`respawn_seconds`，旧Unit以`alive=false`进入独立尸体集合；重生截止时间到达后，同一`AreaId`创建新MonsterUnit并通过AOI Enter发送新快照，不等待旧尸体。尸体窗口结束或全部普通掉落领取完成后，旧Unit才Detach、发布AOI Leave并Remove。业务不得复用旧UnitId表示“新怪物”，也不能假设一个`AreaId`同一时刻只有一个Unit；客户端必须按UnitId区分新活怪和旧尸体。拾取响应丢失时，客户端必须用原`operationId`重试，由持久化回执返回第一次结果。

怪物主动行为由`MonsterComponent.Update`统一驱动，并在Hotfix内部调用局部`MonsterBehaviorTree`。行为树只负责从待机、追击、攻击和冷却停留中选择一个动作；它不能直接操作Native句柄、广播消息或修改其他地图的Unit。距离、伤害、死亡和Numeric变更仍由MonsterComponent负责。

不要为每只怪物创建Actor、长期Timer或独立V8。不要在Handler里扫描地图或绕过`MonsterComponent`查找怪物。技能和Buff已经接入统一Component/Action边界；复杂仇恨、巡逻路点和回出生点尚未接入，新增这些能力前先保持当前普通攻击、七技能和引导闭环可测试、可观测。

### 自动攻击与朝向

普通攻击不是客户端每次点击产生一条伤害消息，而是`CombatComponent`上的持续状态：`StartAutoAttack(targetId)`只激活状态并锁定目标。Map固定Tick检查目标是否存活、是否同一MapInstance、是否在攻击距离内以及角色朝向是否有效；全部满足时才推进平A读条并在完成时结算一次伤害。

距离过远或朝向不正确时，必须清零当前平A读条，但不能清除自动攻击状态。玩家重新靠近并恢复正确朝向后，从0秒重新读条。移动Handler不得调用`StopAutoAttack`。Cocos3D右键加A/D的侧移正是为了保持Yaw、围绕目标移动；右键拖动必须同步改变角色的权威Yaw，不能只改变摄像机角度。

技能配置必须把以下维度分开：伤害类型（Physical/Magic/True）、执行方式（Instant/Cast/Channel）和对平A时间轴的影响（Keep/RestartAfterCast，后续可扩展PauseResume）。例如战士的压制是物理、瞬发且Keep，不得因为它是物理技能或瞬发技能就自动推断平A行为。

主动怪不要只写“靠近玩家”的表现逻辑：当前演示中`MonsterConfig.attack_mode=1`表示主动追击，进入攻击距离后由`MonsterComponentSystem`按最终`NumericType.Attack`扣玩家`CurrentHp`；`attack_mode=0`才是不主动寻找玩家的被动怪。因为玩家确实可能死亡，玩家创建时必须从`PlayerConfig.initial_hp/max_hp/initial_mp/max_mp`初始化Numeric，Cocos3D、UE、Unity和Godot的HUD只订阅进入快照与`G2C_EntityNumeric`，显示HP/MP，不能在客户端复制伤害规则。

客户端发现Gate连接已经关闭时必须退出旧世界并清除旧`UnitId`，不能让断线画面继续向Map发送请求。当前Starter没有正式玩家复活玩法，因此持久化死亡角色重新创建PlayerUnit时会在地图出生点满血恢复；正式项目应新增显式Revive流程，并决定墓地、复活时间、Buff和持久化规则，不要把Demo恢复策略扩散进Combat Core。

## DBProxy持久化接入边界

独立DBProxy工作区已发布`v0.5.0`，提供Rust TCP服务、Protobuf版本/指纹握手、内部令牌、Rust客户端池、运行时无关TypeScript SDK、事务回执查询、双Endpoint故障切换、多记录原子事务和真实PostgreSQL/Redis适配。TiangZ主工程已经切换到`v0.5.0`，Rust Host Bridge和TypeScript Transport已接入多Endpoint配置及多记录API；业务开发者仍不能在Handler、Component或System中直接连接Redis/PostgreSQL，也不能引用`dbproxy-storage`。

正式接入后的固定调用层次应是：

```text
Handler
  -> PlayerUnit / DomainComponent
  -> 领域Repository
  -> @tiangz/dbproxy-sdk
  -> HostDbProxyTransport
  -> 独立DBProxy
```

接口必须按数据等级选择：

- `LoadSnapshot`：登录、恢复或接管时读取权威记录；`None`表示记录不存在。
- `SaveSnapshot`：调用方需要等待PostgreSQL提交的普通快照；网络失败时保留原`request_id`重试。`SaveMultiSnapshot`只批量独立记录，不提供跨记录业务原子性；DBProxy可以在同一连接分片内合并一次数据库commit和缓存往返，Revision/幂等冲突仍逐条返回。关键背包、货币和交易不能为了批量性能改走这个入口。
- `EnqueueSnapshot`：只用于位置、普通任务进度等允许小范围回退的数据；成功只表示Redis AOF backlog接收，不代表PostgreSQL已落库。
- `ApplyTransaction`：用于Wallet、Inventory、Reward、Trade等关键单记录事务；必须携带原`operation_id`、期望Revision、提交后的完整Payload和可重试业务结果。

同一个`DbProxyClient`连接只允许一个在途RPC；高并发服务使用Rust`DbProxyClientPool`按RecordKey稳定分片。DBProxy网络工作运行在多线程Rust Host Runtime，业务V8只等待Promise；不得在TS中自行打开Socket或实现第二套连接池。业务不能为了躲开PlayerUnit ordered mailbox而改用`Spawn`异步确认关键经济操作：关键事务必须在可靠提交成功后才向客户端确认。普通快照可以合并并进入backlog，但不得把关键事务降级成“稍后保存”。

DBProxy服务层的集群边界已经冻结：Rust客户端接受多个有序内网Endpoint，按RecordKey选择首选实例，基础设施错误时携带原`request_id/operation_id`切换；部署两个共享同一套云Redis/PostgreSQL的对等DBProxy实例；通过故障注入验证请求中断、提交后丢响应和Backlog lease接管。业务拒绝、Revision冲突、协议指纹或鉴权错误不能触发换节点重试。DBProxy实例之间不选主、不复制业务状态，也不实现Redis/PostgreSQL高可用；存储高可用直接使用云厂商能力。TiangZ侧已经用真实商店、双玩家交易和首Endpoint中断完成端到端验收；这仍不等于存储HA或MapHost透明接管。

DBProxy观测端口与业务TCP端口分离，只提供`/live`、`/ready`和Prometheus`/metrics`，不得经过公网Nginx。服务端按固定操作名、固定错误码记录QPS、逻辑记录数、失败和延迟Histogram，Backlog记录提交/空轮询/失败；TiangZ Rust客户端Observer使用最多8个配置Endpoint的固定原子数组，Process `/metrics`导出连接尝试、请求失败、累计耗时和from/to切换。禁止把RecordKey、玩家ID、requestId或operationId放入Prometheus标签；单次请求只允许进入Debug结构化日志。Grafana是展示层，不替代Prometheus，也不冒充PostgreSQL/Redis内部监控。

当前`CreatePlayerRepository(process)`是MapHost选择实现的唯一入口：省略`process.persistence.dbProxy`时使用内存Repository，配置后使用`DbProxyPlayerRepository`。加载必须在玩家Unit发布到PlayerDirectory、Location和AOI之前完成。`PlayerPersistenceComponent`持有inventory、progression、quest、runtime、wallet五个Revision；Map每秒错峰扫描到期玩家，把捕获与一次批量保存送进PlayerUnit ordered mailbox，默认每30秒保存五域。批量结果逐领域应用，单域失败不会抹掉其他成功领域的新Revision；重试必须复用第一次生成的各域requestId。断线、踢下线和停机只调用`player.Offline(reason)`并复用同一个最终Flush Promise。Handler不得直接调用Repository。

普通、独立、按稳定Key整体读写的Entity不需要重复手写Codec和Repository。例如：

```native
@typeId(2)
@persistent(1)
entity Item extends Entity {
  readonly configId: u32;
  count: u32 = 1;
}
```

运行`npm run codegen:native-data`后，业务使用生成的`NativeItemPersistenceCodec`或`CreateNativeItemRepository(processName)`。`Entity.instanceId`已经标记`@transient`，恢复时必须由当前运行时重新分配，不能从数据库带回。当前Codec是严格当前版本读取，任何持久字段的增加、删除、改名或改类型都必须递增`@persistent(version)`；旧schema迁移注册尚未完成，因此做结构升级前必须先补迁移器。需要“按ownerId查询全部道具”、拍卖行索引、跨玩家交易等能力时，应建立Item/Trade领域Repository，不能把通用Payload表当作查询型ORM。

当前玩家记录已拆成五个一致性域：wallet=`gold`，inventory=`items`，progression=`numerics`，quest=`quests`，runtime=`map/position/alive/buffs/skill cooldowns`。任务GrantItem奖励和拾取提交inventory+quest；UseItem提交inventory+progression+runtime；NPC商店提交inventory+wallet；同地图交易一次提交双方inventory+wallet。每次事务只推进参与领域Revision。周期/退出快照按规范化编码后的领域Payload判脏，诊断`reason`变化不写库；首次未知基线仍保存全部领域，关键事务成功后同步该领域基线，批量部分失败不重复推进已经成功且未再变化的领域。该优化只减少普通快照写放大，不改变交易事务边界。`npm run test:player-domain-recovery`验证30秒周期快照、最终Flush、all-in-one强杀，以及静态MapHost强杀后的Watcher有界重启、Location代次接管和Gate新连接恢复；`npm run test:gate-failover`验证双Gate强杀后接管同一PlayerUnit、旧Gate重启不回切和绕过Login重入拒绝；`npm run test:player-trade:persistent`验证首选Endpoint接管、Debug模拟“DBProxy已提交但响应丢失”后的原始回执恢复，以及双Endpoint同时不可用时失败不改Entity、恢复后同一operationId只提交一次。普通状态允许最多一个周期窗口回退，已经确认的关键事务不得依赖周期快照。系统仍没有跨地图交易、邮件/拍卖行事务或动态地图现场恢复；Gate接管只覆盖同一已知拓扑，不代表跨地域租约HA。完整运行步骤见[DBProxy玩家快照持久化](../tutorials/19-dbproxy-player-persistence.md)。

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

## 外网演示部署

业务开发不应把公网IP、云主机密码或部署机器的内网地址写进业务代码。外网2C2G演示使用`configs/deploy/external-multiprocess/StartMachine.json`，由Watcher启动10个独立Process：LoginMgr、MapManager、两个Login、两个Gate、两个静态MapHost、一个动态副本MapHost和Location。MapManager与所有MapHost只走回环Inner TCP，外网入口仍只由LoginMgr、Login和Gate配置的`outerIp/outerPort`提供。Cocos3D编辑器预览自动读取`assets/resources/Config/tiangz-local.json`连接本机`127.0.0.1:7000`，只有非预览发布包读取`tiangz-external.json`；不要为了本机调试修改公网配置文件。
客户端只配置LoginMgr公网地址；LoginMgr再返回Login公网地址，Login再返回Gate公网地址。外网测试机由Nginx持有这些公网WebSocket端口，TiangZ入口只绑定`127.0.0.1`的独立内网端口：`17000→27000`、`17001→27001`、`17002→27002`、`17201→27201`、`17202→27202`。MapHost、Location和MapManager也只保持回环内网路由；它们没有公网入口。

这个端口分离不是业务路由逻辑，开发者不需要在Handler中处理。修改外网配置时必须同时检查`scenes`、共享`known-scenes.json`和`configs/deploy/cocos3d-nginx.conf.example`，保证`port`表示TiangZ实际监听端口，`outerPort`表示客户端连接端口；若把二者写成同一个端口，Nginx与Runtime会启动冲突。

当需要验证外网演示时，使用统一的“部署到外网测试机”流程：重新生成代码、构建后端和Cocos3D Web，确认是本次最新产物；后端先解压到`.next`目录，通过配置预检后在短维护窗口原子交换并保留上一目录，失败时立即回滚；两个Web目录仍按入口分别覆盖。Cocos3D前端使用`npm run build:cocos3d:external`一次生成两个入口：`build/external/desktop`部署到根路径`/`，`build/external/m`部署到`/m/`；根路径只能使用桌面`web-desktop`包，横屏`web-mobile`包只能放在`/m/`。
外网构建会在页面顶部显示`Build <版本>-<UTC构建时间>-<Git短提交号>`，Nginx对两个Demo入口发送`Cache-Control: no-cache, must-revalidate`。验收时应先确认Build标识已经变化，再检查Buff、快捷栏等业务表现；这样可以明确区分客户端缺陷和旧包缓存。
不要只看Nginx页面能打开就判断网络链路完成；云安全组必须放行实际的WebSocket入口端口。

后端正式发布使用本机Docker的Linux构建环境生成`linux-amd64` Release制品。外网机器只接收可执行文件、`dist`、`configs`、导航资源、版本信息和校验文件，不接收源码、Cargo工程、Node依赖或构建缓存。Runtime会从当前发布目录解析资源，因此制品可以从构建机复制到任意部署路径。

外网2C2G要验证账号和玩家数据重启恢复时，还要部署独立DBProxy。Ubuntu 24.04安装`docker.io`和`docker-compose-v2`后，使用DBProxy仓库的Compose文件启动Redis/PostgreSQL；两个容器只绑定`127.0.0.1`。DBProxy服务监听`127.0.0.1:7800/7801`，全部TiangZ Process的`persistence.dbProxy`都必须启用，令牌放进systemd环境文件。TiangZ的systemd单元必须用`Wants=`关联两个对等DBProxy，禁止用`Requires=`把任一候选故障传播成整组Runtime停机。不要把本机开发`.env`、数据库密码或公网凭据复制进仓库，也不要让业务Handler直接访问Redis/PostgreSQL。

日常Linux发布执行`npm run release:linux`。固定Builder镜像只保存Node、Rust、.NET Runtime、Luban和依赖，不保存业务源码；工具指纹未变化时不得重新下载工具链。每次发布仍必须重新执行Excel/Luban生成、全部codegen、TS构建和Rust Release编译，不能因为复用镜像而复用旧生成代码。只有修改`package-lock.json`、Cargo依赖/锁、Rust工具链、Luban版本或Builder Dockerfile时，才允许自动重建一次镜像。

## 开发阶段与Release锁定

当前主工程、两个VS Code插件和独立DBProxy都处于持续开发阶段。开发者可以迭代`package.json`/`package-lock.json`、`Cargo.toml`/`Cargo.lock`、插件版本和协议原型；日常使用`npm install`与普通Cargo命令，不要求版本副本、Stable API快照、opcode/schema锁或依赖解析完全冻结。生成物过期检查、类型检查、边界检查和运行时Protocol Fingerprint仍然有效，因为它们分别保护代码生成一致性、架构边界和在线连接兼容性。

准备正式发布时再开启冻结门禁：主工程运行`npm run verify:release`，它会设置`TIANGZ_LOCK_VERSIONS=1`并强制比较项目版本、`public-api.lock.json`和协议锁；开发阶段可运行`npm run verify:locks:warn`，它只报告漂移、不阻塞提交。插件与DBProxy由各自仓库执行发布前的版本、依赖锁、协议指纹和完整测试审查。除非明确进入Release，不要手工更新锁文件来“让检查变绿”，也不要把Release命令加入普通开发流程。

## Action、Buff与Skill的当前规则

外部道具使用统一遵循`C2M_UseItemHandler -> ItemComponent.UseItemTransactional -> Planner -> DBProxy -> Commit`。`ItemConfig.use_effect=0`表示不可用，`1`表示添加Buff，`2`表示把`use_params`解释为`[ActionType, ...parameters]`。开发者优先改配置，不要为了不同药水复制Handler。`cooldown_ms`表示按ItemConfigId隔离的自身CD，`global_cooldown_ms`进入与技能共享的玩家GCD；Inventory、CD和效果必须先生成纯数据计划，DBProxy确认后才无await提交。当前事务Planner支持1001的`Heal(150)`和1002添加无AddAction的Stack Buff 2001；两者自身CD均为30秒、共享GCD均为1秒，2001后续Tick仍通过普通`ActionExecutor -> Heal(50)`执行。新增事务Action必须先定义操作后Payload和回执恢复，不能在执行副作用后再补保存。

`BuffComponent`拥有`Buff` ChildEntity；Component负责集合、实例ID、传送和AOI生命周期事件，BuffSystem负责Add/Tick/Remove和Timer。Buff传送只保存纯值及墙钟时间，目标重建Timer但不重复AddAction；不保存TimerId、闭包、Promise或Entity。Buff Tick只执行Action，Numeric和Combat沿用自身同步边界。

Combat不查询Buff。护盾类Buff在添加/移除边界注册/注销Combat modifier，伤害统一进入`CombatComponent.ApplyDamage`；禁止再设计`BuffComponent.TryAbsorbDamage`作为受伤入口。运行时Action和护盾剩余量会以纯值跨地图恢复。七技能Cast与3006/3007持续效果已接入：3006瞬发添加恢复Buff，8次治疗由Buff Tick负责；无护盾吸收的受击会让普通读条后移800毫秒、让引导提前800毫秒，真言术·盾吸收的受击不产生这两种惩罚；移动仍会取消可移动中断的Cast，客户端只显示服务端状态。Cocos3D的引导连线仅是表现，不参与战斗判定；复杂地面目标、技能持久化和AOE仍不属于当前闭环。

技能只在`SkillConfig.xlsx`填写目标与时间线，在服务端专有的`SkillEffectConfig.xlsx`按顺序组合Action；客户端只生成SkillConfig用于名称、距离、读条和CD表现。若一个新技能可由现有Action与Buff组合完成，只改Excel并重新生成，禁止新增专用Handler或把伤害数值写回Hotfix目录。普通业务不得长期缓存`GetSkillDefinition()`结果；配置索引由`SkillCatalog.ts`按指纹统一维护。

## 道具出生与快捷栏

当前出生规则：新角色首次创建时获得`1001×3`小红和`1003×3`小蓝；读档、重连和跨地图不重复发放。快捷栏药品槽按配置ID引用`1001/1003`，数量以服务端进入快照和增量事件为准。

新角色出生时由`MapComponent`显式发放`1001×3`小红和`1003×3`小蓝；`ItemComponentSystem.Awake`不负责赠送道具。Starter任务奖励仍由任务事务单独追加；`RestoreTransfer`、重连和数据库恢复必须使用快照，不能在创建Unit时再次发放。快捷栏固定引用`1001/1003`的配置ID，数量从服务端快照读取；不能把快捷键映射误当作创建道具。

`ItemConfig.icon`放在客户端分组，填写相对`assets/resources`的Cocos资源键，例如`UI/Icons/Items/1001`，前端通过配置解析图标。Cocos3D Web的快捷栏固定约定为`1`切换平A、`2`发送1001使用请求、`3`发送1003使用请求；显示数量先读进图`G2C_EnterMap.items`，后续只接受`G2C_ItemChanged`更新。快捷栏是`ItemConfigId`的配置引用，不是某个永久`ItemId`的绑定：最后一件消耗后，服务端移除背包Item，客户端保留对应槽位并显示`×0`；同配置道具再次进入背包时，即使它拥有新的`ItemId`，槽位也会重新选择可用实例。按键或按钮不能直接修改本地数量，也不能把`itemId`写死；使用时应先按`configId`汇总服务端快照、选择一个数量大于0的具体Item实例，再调用生成的`MapClient.useItem`。

玩家3D模型必须挂在Unit表现根节点下，禁止直接用骨骼Prefab充当权威Unit节点。当前Cocos3D示例由`PlayerCharacterVisual3D`加载`BlueChibi`骨骼Prefab，模型原点在脚底，Unit根节点继续沿用身体中心和既有碰撞尺寸。业务只向表现控制器提交`moving/idle`等状态；`Idle/Walk/Attack`动画不能写坐标、参与寻路、决定命中或启用Root Motion。换模型时优先替换Visual资源，不复制或改写Map移动链路。

镜头环绕同样属于纯表现：Cocos3D左键拖动只维护本地`cameraYawOffset`，不能修改Unit朝向或发送移动协议。输入手势必须有拖动阈值；环绕手势结束后要消费鼠标抬起，避免一次操作同时触发地面寻路。短点击的怪物选择与寻路仍走原有射线入口。

Cocos3D的Buff栏从Unit快照的`buffs`或不可覆盖的`G2C_BuffAdded`创建图标，按`UI/Icons/Buff/<BuffId>`加载资源，文字读取`BuffConfig.name`显示中文名，不把BuffId暴露给玩家。倒计时使用服务端结束时间和客户端估算的服务器时钟，只显示`分钟:秒`，分钟不换算成小时；无限Buff显示`永久`。客户端显示到`00:00`后不得删除图标，删除只能由`G2C_BuffRemoved`驱动，不要把本地倒计时归零当成服务器已经移除。

## 多引擎客户端开发边界

当前Cocos3D、Unity、UE和Godot都可以作为技能、Buff、任务、道具和怪物协议的演示客户端。新增客户端表现时，先复用生成SDK的消息和配置，再实现该引擎的输入、状态缓存、HUD和视觉对象：Unity接入`LoginFlow`，UE接入`FTiangZLoginFlow`，Godot接入`TiangZClient`。不要在客户端重新计算伤害、Buff叠加、任务奖励、怪物死亡或技能距离；客户端只根据服务端的Cast、Impact、Buff、Quest、Numeric和EntityState消息更新表现。协议字段、msgcode和Codec变更必须回到Proto/codegen链路，不能直接改各引擎的Generated副本。

## 可观测性边界

业务代码使用 Scene/Actor 上下文 Logger 和框架已有自定义指标入口，不得创建 Observer Scene、定时 RPC 或业务内广播来汇总 Process 指标。每个 Process 的 `/metrics` 由 Rust Host 暴露，Prometheus 按 `StartMachine.json` 直接抓取。业务新增指标必须使用有限枚举标签，不能把玩家 ID、道具 ID、RPC ID 等无界值放入 Prometheus label。`CustomMetricSnapshot.labels` 只用于同一 Scene 内有限数量实例（例如静态 `map_id`），标签名必须是合法 Prometheus 名称，且不能覆盖 Host 固定的 `process/scene/scene_type/name/key`；实例身份不能继续伪装成 `values` 数值，否则同名快照会生成重复序列。`CustomMetricSnapshot.values` 默认按 Gauge 导出；只增不减、进程生命周期累计的字段必须在 `kinds` 中显式声明为 `counter`，不得仅靠 `_total` 命名猜测语义。修改观测契约后必须执行 `npm run verify:observability`。

跨Process追踪由Core自动建立和传播。业务Handler只使用`context.logger`和普通Scene/Actor调用，不得导入、构造或解析Trace Envelope，也不得把`traceId/spanId`作为业务幂等键。`requestId/operationId`负责业务身份和重试，`traceId`只负责诊断。日志中的`traceId/spanId`由框架注入；不要手工覆盖，也不要把玩家ID、请求ID、Trace ID放入Prometheus标签或Loki索引label。业务日志不得记录密码、Token、完整协议Payload或其他敏感数据。

修改Trace传播、采样、日志采集或Grafana数据源后，先执行`npm run verify:observability`，再用`npm run test:observability:faults`真实验证Gate故障和动态副本安全回退。后者会启动测试拓扑并停止测试进程，不能连接生产环境。

生产测试部署只允许Grafana经Nginx HTTPS开放；Prometheus、Alertmanager、Loki、Tempo、Alloy以及Node/PostgreSQL/Redis Exporter必须绑定回环或运维内网。告警Webhook、Grafana管理员密码和数据库Exporter连接串只能放在服务器`0600`密钥文件中。业务仓库不能保存这些秘密，也不能为了“方便看指标”把内部端口转发到公网。

Developer Tools 的“查看运行时指标”命令是只读的 `/metrics` 查看器，只能回答“这个 Process 当前有多忙”，不能回答某个 Unit、Actor 或组件的业务详情。不要为了调试临时增加业务 RPC、遍历全地图或暴露 V8 任意执行入口。按 UnitId、Scene、Gate 和 ActorLocation 查询的 Inspector 采用独立的、版本化的只读协议；当前只冻结了协议草案，正式接入前仍需完成 Runtime 控制通道、调试令牌、超时、限流、响应上限和快照一致性验收。

## 框架热路径与低分配约定

“0 GC”不是业务可以依赖的运行时承诺。开发目标是稳态下框架热路径少制造临时对象，并通过mailbox、队列和延迟指标验证收益；不要为了追求一个宣传数字把所有业务代码改成难以维护的手写循环。

### 业务开发者应遵守

1. 有结果要等待时使用RPC；无结果只通知时使用Message。不要为了“看起来统一”给单向消息增加`await`或人为回执。
2. 单向消息的Handler不能假设发送方知道处理完成时间。需要确认时改成RPC或显式业务事件，不要读取mailbox内部队列。
3. `SceneMessageHelper.send/sendActor/sendFrame`的返回类型是`MaybePromise<void>`。本地同步mailbox或远程入队通常直接返回`void`，`await`只为兼容确实异步的Transport；它永远不是目标Handler完成通知。
4. `LengthPrefixedFrameDecoder.pushEach`的回调只在当前调用内同步消费帧；不得缓存传入的帧视图、跨异步边界持有它，若要长期保存必须复制。
5. 广播状态选择`latest`或`event`必须先看语义：可覆盖状态用latest，不可逆事实用event。业务只提供Audience和数据，不维护Gate路由表。
6. 不在每个Unit、每个Cast或每条消息上创建框架Timer、Promise或长期闭包。高频状态使用已有Update桶、批量Snapshot和Component索引；真正需要等待结果的业务流程再使用Promise。
7. 不把`map/filter/spread`列为绝对禁用语法。只有性能报告证明它位于热路径时，才局部改为复用数组、循环或批处理，并补自测说明副作用。

### 框架已经提供

- ordered Actor/Scene mailbox忙时的队列节点回收与单向Message无完成Promise路径；RPC仍保留正常Promise语义。
- 协议流解码的回调消费路径，以及跨分片时才发生的必要复制。
- 编码latest广播的单批次路径和多批次空受众过滤。
- `/metrics`中的mailbox快路径、排队、异步、单向消息、当前深度和峰值指标。出现尾延迟时先比较这些指标、Handler耗时、Rust队列和网络下行，再决定是否优化。

### 压测前准备与低分配 A/B

框架热路径或Runtime改动后，先执行`npm run perf:hotpath:prepare`。它负责构建`build:bench`、`build:perf:full-chain`和Release Runtime，随后执行`verify:codegen`、`verify:comments`、`verify:hotfix-boundary`，检查生成物、Manifest哈希和本机测试端口；它不会启动服务、连接客户端或制造压测负载。

前后版本必须使用同一组参数，例如：

```powershell
npm run perf:full-chain -- --mode all --players 200,1000,3000 --move-rates 2 --warmup 10 --duration 60 --rounds 3 --output-prefix hotpath_before
npm run perf:full-chain -- --mode all --players 200,1000,3000 --move-rates 2 --warmup 10 --duration 60 --rounds 3 --output-prefix hotpath_after
npm run perf:hotpath:compare -- --before perf/results/hotpath_before_<时间>.json --after perf/results/hotpath_after_<时间>.json
```

`full-chain`报告中的Mailbox指标分为两类：Scene mailbox是所有Scene序列的聚合值，Actor mailbox是整个Process的单一汇总，不能把Actor总计复制到每个Scene后再次相加。单向消息排队应与尾延迟、Probe错误、Transport队列和业务错误一起判断；如果排队为零但p99上升，应继续看Handler耗时、编码、连接写出和客户端消费速度。`perf:hotpath:compare`要求参数、案例集合、轮数和资源字段完整一致；缺字段或存在stalled、Probe/传输错误、背压、内部超载时，比较结果无效。该流程还不能给出“每条消息分配多少字节”，精确分配量需要独立的V8 heap/profile实验，不能用GC次数替代。

### OP-05真实业务压测

Starter的真实业务容量必须使用同一场景做无业务/业务A/B。当前标准业务负载是每玩家每秒交替`UseItem`和`CastSkill`；公共CD、道具CD、距离或法力不足等规则拒绝计入`businessRejected`，只有超时、断连、RPC错配和协议解析失败计入`businessTransportErrors`。容量结论还必须同时检查`stalled`、Probe、Map frame/completion背压、Inner overload/timeout、慢连接和尾延迟。

容量工具还必须对比Runtime固定帧与Map业务Update频率。Map Update是同步回调；Runtime Pump先处理Scene mailbox和V8 microtask，再推进到期固定帧，高入站负载可能让Runtime固定帧与Map Update一起降频而CPU仍未达到目标。正式容量候选要求每轮Map Update都达到`1000 / fixedUpdateMs`的95%以上，并且所有正式窗口没有新增`skipped fixed updates`；否则即使Move输入、CPU和错误计数达标，也只能保存为失速诊断结果。

高入站负载还要检查Runtime Pump处理的Scene帧数与耗时。Runtime受`maxEventsPerUpdate`总量约束，并按轮转起点公平分配EntryScene。TS仍有入口积压时，Rust暂停新的data批次，但每轮最多注入128条control，为TS保留排空旧队列的能力；新事件继续留在有界宿主队列中接受明确背压。监控应同时查看`tiangz_scene_last_ingress_pump_frames`、`tiangz_scene_last_ingress_pump_cost_ms`、TS/Rust control/data队列和固定Tick。同步Handler仍不可抢占，业务Handler必须短小；修改批量或追帧参数后必须重新验证吞吐和p95/p99。

2026-08-21完成入站调度A/B后，Rust客户端在8 Gate、10x10 Grid、3000玩家、40人/秒进图下通过完整业务容量门：2Hz Move、0.2Hz Probe和0.1Hz技能/道具请求均达标，Map 20Hz且正式窗口零跳帧，Probe/业务传输错误、overload、timeout和backpressure均为0。该结果使用Map `maxCatchUpSteps=3`覆盖150ms内偶发尖峰，Probe p95/p99为190/234ms；它是当前机器与该负载画像的保守有效点，不是通用生产人数承诺。`DBProxy`商店、拾取、交易和跨玩家事务属于另一类持久化业务压力，不能被这组内存Repository的技能/道具结果代替。

## 怪物掉落与任务物品

任务掉落不能写成“怪物死亡时给附近所有玩家发一件物品”。开发者在`DropTableConfig`中用`quest_objective_id`声明它对应的`CollectItem`目标；`MonsterComponent`在尸体上保存掉落行，玩家调用`LootMonster`时再根据自己的Quest状态筛选。未接任务或已经达到要求数量时，拾取结果为无可用掉落，尸体行保留，不能删除或消耗别人的任务资格。普通掉落和任务掉落的领取范围不同，必须在配置/代码中明确，不能用一个全局`claimed`集合代替。

拾取属于一次关键玩家事务：先规划Inventory/Quest/Currency纯数据，再使用稳定`operationId`提交DBProxy，成功后才创建静态Item、推进任务、应用金币和广播。只有道具行时提交`inventory + quest`；包含金币行时原子提交`inventory + quest + wallet`，不能先加钱再保存。Handler只转发`monsterId + operationId`，不查询Quest、不扣库存、不手工发消息。动态词条、耐久、绑定等ItemInstance必须保存实例数据，不能把“拾取时生成静态ItemId”的Starter快捷路径误当成通用规则。完整流程见[`docs/design/loot-and-task-items.md`](../design/loot-and-task-items.md)。

### 尸体窗口调用约定

尸体拾取不是一次性按钮事件，而是一个可持续操作的窗口：

1. 点击尸体交互按钮只调用`inspectLootMonster`，打开服务端返回的掉落列表。
2. 点击某一行时调用`lootMonster({ monsterId, operationId, dropId, lootAll: false })`，只领取该行。
3. Shift+点击、鼠标右键、F键或移动端的“全部拾取”按钮调用`lootAll: true`。
4. 使用回执的`remainingDrops`重绘列表，并把本次获得的道具追加到窗口结果区；窗口由玩家主动关闭。

`LootDropSnapshot.gold > 0`表示铜币行，此时`itemConfigId/count`保持0；客户端显示铜币而不是尝试读取`ItemConfig(0)`。`M2C_LootMonster.gold`是提交后的权威余额，`gainedGold`是本次增量。

列表显示的是服务端资格筛选后的预览，不代表客户端已经拥有道具。不要在点击前修改背包数量，也不要用短暂Toast替代回执中的掉落结果。

尸体的显示时长和下一只怪物的重生间隔是两个独立时间轴：有掉落的尸体默认保留5分钟，无掉落的尸体保留10秒；全部普通掉落领取完成后可以立即清理尸体。`MonsterConfig.respawn_seconds`从死亡时刻计时，到期后刷怪槽直接创建新Unit，不等待旧尸体消失。任务掉落属于按账号判定的资格，不能因为一个玩家领取完成就删除尸体。客户端收到AOI Leave后关闭对应旧UnitId的拾取窗口，不能继续用旧UnitId发起新的拾取请求；丢响应重试仍复用原`operationId`读取持久化回执。

## Starter金币、NPC商店与法力恢复

Starter的普通掉落表1按每行独立概率判定：破旧布料1201为80%、小型生命药水1001为15%、大型生命药水1002为5%；三行可以同时掉落，也可以全部未命中。`ItemConfig.sell_price`分别为10、20、50铜币，Map 100的9002杂货商读取服务端商品目录出售红药和蓝药。NPC商店不是客户端配置价格表：客户端先调用`OpenNpcShop`拿目录和金币，再调用购买/出售RPC；服务端在PlayerUnit ordered mailbox中校验NPC、距离、商品、Item归属和金币，创建Inventory/Currency纯数据计划，最后使用DBProxy的稳定`operationId`事务提交。提交成功后才应用内存和发布ItemChanged；失败或重试不能由客户端预扣或重复发放。快捷栏只能引用ItemConfigId，不能绑定出售后失效的ItemId。

`CurrencyComponent`只负责非负`bigint`余额，不加入商店名词；`NpcShopComponent`负责编排，`ItemComponent`负责Item实体。玩家交易已经在同一边界上使用DBProxy多记录事务，不能把两个玩家的单人购买/出售请求在客户端拼起来。商店示例见[`docs/design/currency-and-npc-shop.md`](../design/currency-and-npc-shop.md)，玩家交易见[`docs/design/player-trade.md`](../design/player-trade.md)。

Starter Boss的表3固定掉落小红、大红、蓝药各5个和150铜币，用于验证同一尸体拾取事务同时修改Inventory与Wallet。进入Map 200则是另一条`progression`事务：个人10分钟CD归`ProgressionComponent`，先在当前PlayerUnit ordered mailbox持久化，再允许Gate创建/复用动态实例。Gate、MapManager和副本实例都不保存个人CD；跨MapHost传送通过`PlayerTransferSnapshot.starterDungeon`携带，登录/重连响应返回截止时间供客户端按钮倒计时。

技能费用当前暂由Hotfix的`SkillManaCost.ts`维护，服务端在创建ActiveCast前检查并扣除MP；法力不足直接拒绝，读条中断不返还。`CombatStateComponent`记录仍持有玩家仇恨的怪物集合：怪物死亡、回归出生点或清除仇恨时移除来源；集合为空才脱战。战斗状态不恢复MP，脱战后按180秒从当前值恢复到MaxMp，固定更新桶用整数余数累积。该状态是地图临时运行态，传送时清空，不写入持久化快照。

### DBProxy就绪边界

启用DBProxy持久化后，Runtime会在`/ready`成功前建立连接池。业务Handler不需要也不允许自行预热连接；若全部Endpoint不可用，Process不会对外宣称ready。部署编排应以健康检查决定接流量，并由监督器负责重启失败进程。
