# TiangZ AI 项目上下文

本文把长期对话中形成的架构世界观、关键决策、当前状态和暂缓事项固化到仓库中，帮助新的开发者或AI在缺少聊天记录时继续工作。它不是代码的替代品；如果本文与当前代码或测试冲突，以代码和测试为准，并在同一改动中修正文档。

维护契约：任何架构、目录边界、数据所有权、协议语义或业务开发流程的设计变更，都必须同时更新本文和[AI业务开发手册](business-development-manual.md)。设计改动未同步这两份文档，视为尚未完成。

更新时间：2026-08-13。

## 普通Entity持久化生成

- `.native`中的具体Entity可用`@persistent(version)`声明稳定存储结构；字段默认进入快照，`@transient`排除`instanceId`等运行时字段。
- codegen生成`NativeXxxPersistenceSnapshot`、严格Codec、schema/version和`CreateNativeXxxRepository(processName)`；通用Repository负责Revision CAS和同`requestId`重试。
- DBProxy继续只维护固定通用表并把Payload视为不透明字节，不得认识TiangZ Entity。普通Entity无需手工设计数据库表；复杂查询、二级索引和跨玩家事务仍需领域Repository与专门存储设计。
- 当前`Item.native`是最小示范。Player是跨Numeric、Item、Buff、Skill、Quest的聚合快照，仍保留手写`PlayerRepository`，不能机械替换成单Entity Repository。

## Starter MMORPG 纵向切片

TiangZ的业务参考目标是一个小而完整的Starter MMORPG，而不是内容庞大的商业游戏。唯一验收主线为：登录/选角、主城、野外战斗、掉落、背包、任务、动态副本/Boss、断线重连和重启恢复。完整矩阵见[Starter验收矩阵](../starter/acceptance-matrix.md)，开发教程见[Starter MMORPG教程](../tutorials/20-starter-mmorpg.md)。

- 框架能力案例负责解释单项能力；Starter负责证明这些能力能组合成真实业务，不能维护两套重复的网络、Actor、持久化或战斗入口。
- Starter固定一个职业、一个主城、一个野外地图、一个动态副本、三种普通怪、一个Boss和少量技能。社交、商城、运营活动和大量美术资源留在后续示例。
- 新功能只有同时具备Stable API调用、正式配置/协议来源、状态所有者、失败语义和可重复验收，才算进入Starter。
- 账号注册、登录和角色目录已经完成运行时闭环：`C2S_Register`通过`CharacterRepository`写入账号密码盐值/摘要并创建同名初始角色，`C2S_Login`必须携带密码且不会再自动创建游客账号；`C2S_Login.characterId`明确选择角色，`characterId`贯穿Gate、Location、Map和Player持久化。配置DBProxy时账号目录与角色记录写入版本化快照，未配置时仅用于当前进程调试。`LoginMgr`对带账号请求使用稳定哈希保持同一账号落到同一Login。`npm run starter:character-smoke`已覆盖all-in-one和split-process。
- Starter第一版已接入固定任务NPC：Map 100由`NpcComponent`创建`NpcUnit`（`npcConfigId=9001`、`unitId=0x40000001`），NPC作为普通Unit的Subject进入AOI，Cocos3D以紫色方块展示。玩家出生点为`(-3, 1, -18)`，NPC位于出生点东侧约3米；Demo专用`AoiConfig=2`把Enter/Detach扩大为7×7/9×9 Grid，确保出生点能观察到远端刷怪区。10004、10005、10008是三只被动黄色怪，10006、10007是两只主动红色怪，仍分布在远端刷怪区；`MapEntitySnapshot.displayName`由服务端统一提供玩家、NPC和怪物的公开名称，Cocos3D在实体头顶显示名称，怪物额外显示HP。当前所有Starter `QuestConfig`都关闭自动接取；客户端靠近NPC 5米内显示统一“交互”按钮，点击后打开NPC对话框，再点击对话框中的接取/交付按钮才调用`Map.AcceptQuest({ questConfigId, npcUnitId })`或`Map.CompleteQuest({ questConfigId, npcUnitId })`。任务5001由NPC提供，目标是击败5只怪A；在NPC交付5001后，配置前置解锁任务5005，目标是击败5只怪B。服务端在PlayerUnit有序mailbox内校验NPC存在、任务提供关系和5米交互距离，再由`QuestComponent`创建或完成Quest ChildEntity。`npm run starter:smoke`已覆盖NPC快照和接取。
- 当前业务缺口按掉落串联、Boss副本奖励、完整重启恢复和正式Hotfix入口排序；无DBProxy时角色目录只保证进程生命周期内一致，重启恢复必须使用DBProxy；DBProxy v0.5.0的多Endpoint和双实例基础已接入，TiangZ端到端故障切换矩阵仍按独立阶段验收。
- Starter入口固定为`npm run starter:verify`、`npm run starter:dev`、`npm run starter:smoke`和`npm run starter:character-smoke`；完整纵向验收使用`npm run starter:acceptance`。三个Starter验收命令都会先重建`target/debug/TiangZ`，避免使用旧Rust运行时；`starter:acceptance:persistent`负责DBProxy快照写入、TiangZ重启和恢复读取，`starter:acceptance:faults`会先停止Starter临时DBProxy，再调用独立DBProxy故障矩阵。两个持久化命令需要本地数据库环境，不能对生产数据执行。所有Starter命令只负责静态检查、开发启动和短时运行时验收，不代替容量压测。

### Starter身份约束

- `account`是登录与LoginMgr路由粘性的账号身份，不是角色存储主键。
- `characterId`是角色长期身份，角色目录、Player快照、Location和跨地图传送都以它为稳定键。
- `unitId`是当前Map中的运行时Unit路由ID，可以随着重建或迁移变化，禁止作为持久化角色ID。
- `mapInstanceId`只表示当前地图实例；静态地图和动态副本统一使用同一`TransferToMap`语义。
- 无DBProxy时，跨MapHost传送会用快照接管目标进程的内存目录；这不是重启持久化，重启恢复验收必须启动DBProxy。

### Starter NPC与任务接取

- NPC不是特殊的网络入口，也不是`QuestComponent`的替代品。它是`MapScene.UnitComponent`拥有的普通`Unit`，由`NpcComponent`维护地图内索引并以Subject身份挂入AOI；NPC不创建mailbox、不持有玩家状态。
- 客户端只能从AOI快照得到可见NPC的`unitId/configId`。当前Starter的所有QuestConfig都关闭`auto_accept`，玩家出生时没有默认任务；靠近NPC 5米内才显示交互按钮，按钮打开对话框，接取或交付按钮才发起请求。任务达到`ReadyToTurnIn`后不能从任务追踪面板直接领奖，完成请求必须携带NPC实例ID。点击或选中NPC本身不能改变任务状态，不能把“看见NPC”当作任务已接取。桌面端的`F`只是交互按钮快捷键，移动端和桌面端走同一套对话框流程；服务端仍以PlayerUnit有序mailbox内的`NpcComponent.ValidateQuestInteraction`为最终校验。
- NPC的静态位置、提供哪些任务和显示名属于业务配置/创建流程；Starter固定值只用于第一版演示，未来扩展NPC配置时保持同一Unit和协议语义。任务状态仍由`QuestComponent`拥有，NPC销毁或离开AOI不能删除玩家任务。

## 一句话定位

TiangZ是一套正在验证中的MMORPG服务端框架：Rust/Tokio提供网络和宿主能力，一个操作系统进程创建一个V8，TypeScript在单业务线程中承载多个Scene、Actor和Component；高频跨帧Entity数据可以下沉到Rust，TS通过生成句柄操作。

TypeScript仍是默认业务语言；开发者明确选择Rust实现的稳定、高负载领域统一放在`src/game/<domain>`，例如Buff执行引擎、战斗计算或移动算法。`src/native_data.rs`属于框架权威Store，不继续混入新的游戏业务。Rust业务随Process编译、不能Hotfix；Actor Handler即使调用Rust算法，也必须先经过TS的Location、Unit/Session定位、传送屏障和mailbox，不能在网络入口旁路Actor语义。

### 通用内核与首个领域

TiangZ的内核不是“MMORPG内核”，而是先用MMORPG验证的通用运行时。`app/core`负责Process、Scene、Actor、Component、mailbox、生命周期、协议路由、热更屏障和宿主边界；它不拥有AOI、地图、NavMesh、怪物、任务、技能或战斗规则。当前这些能力位于`app/model/mmorpg`、`app/hotfix/mmorpg`和`src/game`，是第一个领域的可读实现。

这不是现在就抽象第二套游戏的理由。只有第二个领域真正接入后，才根据重复的稳定需求调整边界。当前代码只做三项约束：Core不能依赖Demo/Hotfix，Model不能反向依赖Hotfix或Core内部文件，Rust `src/game`不能绕过`native_data`访问宿主Transport/Process。`npm run verify:domain-boundaries`把这些规则变成门禁。

`SceneConfig`中的`staticMapIds`和`acceptDynamicMaps`是当前MapHost的可选部署能力描述，不是Core执行地图规则；0.4.x保留它们以避免把配置迁移误当成通用性工作。第二个领域需要复用同一Runtime时，再根据实际冲突把它们迁移到领域配置扩展，不提前引入无类型的万能`extensions`。

### 三层能力归属与领域契约

当前代码把能力分成三层，完整表格见[能力归属与领域拆分](../design/capability-ownership.md)：

1. `app/core`和`src`是框架运行时，只负责Process、Scene、Actor、Component、mailbox、Transport、Hotfix屏障和Native Store。
2. `app/model/domains`是可复用领域契约层，当前承载Numeric、ActionDefinition、RewardPlan、Item、Quest和Buff的稳定状态形状。Combat和Skill目前仍包含MMORPG的平A、伤害学校、施法和引导语义，完整实现保留在`app/model/mmorpg`，不维护未使用的类型影子。
3. `app/model/mmorpg`、`app/hotfix/mmorpg`和`src/game`是第一个具体领域，承载AOI、MapHost、NavMesh、移动、怪物、NPC、目标选择、Combat/Skill执行、技能地图调度和协议/配置适配。

本轮已完成`demo -> mmorpg`的服务端业务目录重命名；`native_data/demo`也已改为`native_data/mmorpg`并重新生成Native代码。`.native`中的`namespace demo/native`保留为持久化schema和Native ABI标识，不能随目录整理静默修改。生成协议仍保留`server/demo`和客户端SDK的`Model/demo`路径，因为它们是已发布线协议命名空间，重命名会构成协议兼容性变更。`ActionDefinition + RewardPlan`是第一组跨游戏试点：MMORPG继续在`app/hotfix/mmorpg`执行Action和奖励，`RewardDefinition`只作为旧代码兼容别名，不把当前执行器误宣称为通用框架能力。

Numeric的`MoveSpeed`已从通用Numeric表拆到`app/model/mmorpg/numeric/MovementNumeric.ts`；米/秒到Rust毫米/秒以及写入后同步位置，属于MMORPG移动适配。Item、Quest、Buff已先拆出稳定Model容器和数据契约；Combat、Skill仍完整位于MMORPG适配层，因为当前实现包含平A、伤害学校、读条、引导和技能配置。第二个真实游戏领域出现后，才根据重复实现继续抽取执行代码。

异步业务在外部`await`返回后必须调用Entity的`AssertAlive()`，再读取或修改Entity/Component。JavaScript不能抢占已经开始执行的Promise continuation；框架会在Actor mailbox结算时拒绝已销毁Actor的调用，但不能撤销await之后已经执行的业务代码。需要新的串行边界时，应重新投递Actor mailbox消息或Entity Timer，不要把长Promise当作锁。

开发期可见机器人位于`tools/walk_robots.ts`，只使用正式TypeScript SDK完成登录、进图、Ping和Move。机器人是外部测试客户端，不得为它在Core、Demo Handler或Map业务中增加专用分支。

公共`LoginFlow.latestGatePing`保存最近一次Gate Ping的RTT、服务端Unix毫秒时间、估算时钟偏差和本地接收时间。客户端显示网络延迟必须使用RTT，不能直接用`Date.now() - serverTime`，否则客户端与服务器的时钟差会被误算成网络延迟。

当前版本是`0.4.0`，`v0.3.10`是框架能力的首个稳定基线。Phase 0到Phase 3.10.5的实现、专项验收以及Windows/Linux最终发布矩阵已经完成；Phase 4.0空间契约、Phase 4.1 Rust AOI和Phase 4.2.5 NavMesh3D动态障碍链已经完成。工程已有登录、选服、进入地图、2D/3D多人移动、状态广播、WebSocket/Cocos Web、KCP/Cocos Native、Pixi/H5和Godot 4.7.1验收链路，并完成Windows 3000玩家AOI正式容量回归；角色与怪物之间的动态阻挡和动态避让明确不做，尚未完成Linux/分布式空间负载、完整商业MMORPG业务和生产运维方案。

## 为什么形成这套模型

项目最初从“用Rust、deno_core和TypeScript仿照Skynet”开始，随后逐步融合了ET更适合MMORPG业务组织的Scene、Actor、Entity和Component思想。

关键认识如下：

1. Skynet Service擅长消息隔离，但如果把每个业务能力都拆成独立V8，会增加跨Isolate通信、部署和业务组合成本。
2. ET用Process承载多个Scene，用Scene和Component组成业务边界，更符合地图、副本、玩家Unit和社交域的开发习惯。
3. TiangZ最终不把“Service”同时用作部署边界和业务边界，而是明确区分Process、EntryScene、动态Scene、Actor与Component。
4. 一个Process只有一个V8和一个TS业务线程，可以启动多个EntryScene；网络与宿主可以多线程，TS业务保持单线程。
5. 同进程与跨进程只应是部署差异，业务Handler不应因为拆分配置而改调用代码。

因此当前统一模型是：

```text
Machine
  -> Process（OS进程、一个V8、一个TS业务线程、Inspector和故障边界）
      -> EntityRoot（InstanceId到Entity的生命周期索引）
      -> 配置 Scene / EntryScene（Login、Gate、MapHost、Social等业务入口）
          -> Session（网络连接）
          -> 动态 Scene（map:1、副本实例等业务容器）
              -> UnitComponent（地图Unit统一集合与创建入口）
                  -> Unit（普通地图实体，无mailbox，例如怪物、NPC）
                  -> ActorUnit（可寻址Unit，有mailbox，例如玩家）
                      -> Component（Numeric、Item、Buff等状态与能力）
                          -> ChildEntity（Item、Buff、动态Quest等本地子实例）
```

## 核心名词

### Process

Process是操作系统进程、V8、TS线程、Inspector和故障隔离边界。一个配置文件描述一个Process，一个Process可以创建多个EntryScene。它不等于业务功能，也不等于旧Skynet语义中的一个Service。

### EntryScene

EntryScene是可配置、可寻址的顶层业务边界，例如`LoginMgr`、`MapManager`、`Login`、`Gate`和`MapHost`。未来的`Social`可以作为一个EntryScene，再挂载`GuildComponent`和`FriendComponent`。

### 云部署网络地址

Scene配置把三个地址语义分开：`bindIp`是本机监听地址，`innerIp`是Process之间的内网路由地址，`outerIp/outerPort`是客户端连接地址。旧配置中的`ip`仍兼容读取为`innerIp`，但新配置不得把含义混用。

云服务器的公网EIP/NAT可能不会出现在虚机`ip addr`中，因此公网地址由部署配置显式填写。`0.0.0.0`只能作为`bindIp`，不能写入`knownScenes`，不能放进Location/MapHost Endpoint，也不能返回给客户端。服务间RPC和Actor路由使用`innerIp`；外网演示由前端写死LoginMgr公网地址，LoginMgr返回Login的`outerIp/outerPort`，Login返回Gate的`outerIp/outerPort`。同一入口在`scenes`与共享`knownScenes`重复出现时，外网字段可以只填写一处；两处都填写时必须一致。

外网测试机的安全边界是“公网端口属于Nginx，TiangZ只属于回环地址”。`external-multiprocess`中的LoginMgr、两个Login、两个Gate、两个静态MapHost和Location各自运行在独立Process/V8中；LoginMgr、Login和Gate使用`bindIp=127.0.0.1`，并把实际监听端口与客户端端口分开：`27000/27001/27002/27201/27202`是内网端口，`17000/17001/17002/17201/17202`是`outerPort`。Nginx按公网端口转发到对应回环端口；MapHost和Location也只绑定`127.0.0.1`，不经过Nginx。动态副本节点和MapManager暂缓启动，MapHost使用`acceptDynamicMaps=false`。不能让Nginx与TiangZ抢占同一个端口，也不能把“页面能打开”误认为游戏WebSocket链路已经可用。

### Scene

普通Scene是Process内动态创建的业务容器。一个MapHost可以创建多个MapScene，让低负载地图共享同一线程；扩容时再增加MapHost Process或EntryScene实例。静态地图与动态副本共享同一个MapHost实现和`CreateMap`入口，不拆两套服务；`staticMapIds + acceptDynamicMaps`组合出静态专用、动态专用和混合Host。动态地图由单例`MapManagerScene`调度：启用动态承载的MapHost主动注册并每5秒报告实例数与玩家数，Manager按最少动态实例、最少玩家、名称稳定排序分配宿主，并用业务`requestId`固定唯一MapInstanceId。Location保存MapInstance路由并在地图实例、玩家位置结果中携带MapHost Endpoint；Gate与MapHost缓存或直接使用该地址，动态Host不进入其他进程的静态knownScenes。

部署配置允许`knownSceneFiles`引用共享稳定目录。Rust启动器把本地Scene、共享目录和本地追加项做冲突校验后合并，再把普通`knownScenes`传给TS。该文件组合是不可热更的启动能力，不是服务发现；本地示例集中在`configs/local/cluster/known-scenes.json`。新增空载副本Host只创建自身Scene并引用共享目录，不修改其他进程配置。本地人工入口只有`cluster/StartMachine.json`和`all-in-one.json`；`cluster/`是一套可整体复制的多进程部署包，包含Watcher入口、各Process和共享`known-scenes.json`，Inspector变体单独归入`debug/`。`all-in-one.json`在同一Process/V8中保留两个Gate、静态MapHost和空载动态副本Host，用于验证单进程快路不改变业务语义。

Rust配置加载器对根对象、Process及所有嵌套配置执行未知字段拒绝；字段拼写错误必须在启动期失败。TS中的`ProcessConfig`只是Rust宿主传给业务V8的只读投影，监听、健康检查、Hotfix超时和宿主队列等Rust专有字段有意不暴露，不能用两侧字段数量不同判断配置遗漏。

MapHost停机和动态地图`Dispose`都必须先经过`MapComponent`的业务清理入口：先完成玩家保存/下线，再让所有剩余Unit（包括Monster和仍在进图队列中的Unit）脱离AOI，最后通过`UnitComponent.Remove`按真实所有权销毁普通Unit或ActorUnit，Scene组件随后才释放AOI世界。通用`ProcessHost`不理解AOI，不能直接销毁仍附着的Native Unit；业务也不得在`OnDestroy`里补救已经错误的销毁顺序。`MapComponent.Shutdown`还会停止地图Tick，避免停机等待期间继续创建或移动实体。静态和动态地图共用这套本地销毁流程；只有动态地图在Scene销毁成功后通过`MapHostControl.DynamicMapDisposed`通知MapManager，通知失败会由MapHostRegistration保留并重试。

### Actor、Scene、Session、Unit、ActorUnit与Mailbox

Actor是“拥有mailbox并能按InstanceId路由”的运行时能力，不是所有Entity或Unit的默认属性。Scene和Session天然是Actor消息目标；地图实体只有显式继承`ActorUnit`并声明`@actor`时才获得该能力。普通`Unit`只表示玩家、怪物、NPC等地图身份与生命周期，不创建mailbox，也不进入Actor路由。业务不创建`LoginActor`之类只为获得mailbox而存在的包装类。

- `Id/UnitId`是业务身份。
- `InstanceId`是本次生命周期地址，Entity重建后旧值失效。
- Session和ActorUnit消息根据InstanceId在EntityRoot中O(1)定位；普通Unit虽然也有生命周期InstanceId，但不能把它当Actor地址。
- `ordered`保证同一mailbox的消息跨越`await`仍然串行。
- `unordered`允许异步调用重叠，但所有CPU代码仍在同一TS线程执行。

怪物的`AreaId`和`UnitId`不是同一个概念：`AreaId`是长期存在的固定刷怪槽位，`UnitId`是一次MonsterUnit实体生命周期的身份。`MonsterUnit extends Unit`，由地图固定更新桶驱动，不声明`@actor`，没有每怪物mailbox。怪物死亡后以`alive=false`保留原Unit和AOI身份，供倒地、命中、Buff清理和未来掉落表现引用；当前最小Demo在`respawn_seconds`到期时先从AOI Detach、发布Leave并从UnitComponent Remove，再只复用AreaId创建新的MonsterUnit、UnitId和Native句柄。任何战斗、任务或客户端引用都不能把旧UnitId当成复活后的实体。

这解决了Skynet协程在`call`让出时可能处理后续消息而造成逻辑重入的问题，但不能把所有对象都设为ordered。Session默认使用unordered，允许同一连接的无关RPC跨`await`重叠；`PlayerUnit extends ActorUnit`并显式使用ordered，保持单玩家权威业务串行。MonsterUnit等批量实体保持普通Unit，由所属Component的固定桶推进。Login/Gate入口Scene同样使用unordered。Gate的登录、进图、重连、传送、快照确认和最终下线按连接或账号使用`Scene.Locks`，Ping不加锁。账号级并发只有真实业务需要时才使用账号Location或领域锁，不能用永久`LoginActor`伪装账号状态。

Gate连接状态分成两层：`GateSession`只代表一次物理连接，断开即销毁；`GatePlayerRoute`按账号保存`UnitId -> MapHost/Map/ActorInstanceId`和当前`connectionId`，在30秒重连宽限期内继续存在。客户端每5秒调用`C2G_Ping -> G2C_Ping`，响应携带Gate生成响应时的Unix毫秒`serverTime`；Gate收到任意客户端帧都会先刷新`lastReceiveTime`，出站排队只更新`lastSendTime`，绝不能延长存活期限。Ping是无锁的普通TS RPC Handler；Session为unordered，所以它不会排在长时间EnterMap之后。会修改Route的操作按账号进入协程锁，断线和超时下线取得锁后必须重新校验连接所有权或超时条件。Gate使用一个1秒合并扫描器检查全部Route，不为每名玩家创建Timer。

同账号新连接会在Gate内原子替换旧`connectionId`。旧Session会先失去账号、角色、Token和Route所有权，再收到`G2C_SessionReplaced`（错误码`10040`），最后请求关闭旧Socket；旧socket迟到的disconnect和在途Handler只会失败，不能清理新连接或Map Unit。服务端传输层在关闭前会排空已入队的下行帧，客户端`RpcSocket`也会保留关闭前已经收到但尚未由`update()`分发的单向消息，因此Cocos/Web/Pixi可以可靠显示“账号已在其他设备登录”。客户端SDK通过`LoginFlow.onSessionReplaced`暴露通知，业务回调负责清理本地场景并回到登录界面。该机制是Gate本地的连接代次替换，不是跨Gate全局会话服务；稳定Gate归属仍由Login的Rendezvous Hash保证。

重连后Gate以现有Actor路由调用`SecondEnterMap`，Map只清除旧移动意图并返回权威全量快照，不创建Unit、不重新广播AOI进入、不改绑Gate。宽限期结束后Gate才调用`PlayerOffline`；Map完成保存和Location移除后先响应Unit RPC，再由下一轮Map Timer完成AOI离开和Actor销毁，不能在PlayerUnit自己的mailbox中同步`DespawnActor`自己，否则运行时会把正常下线误判为Actor在mailbox执行期间消失。Map不拥有断线Timer，也不保存`gateSessionId`。

Login使用带最终avalanche混合的Rendezvous Hash按账号稳定选择Gate。所有Login实例对同一Gate拓扑必须给出相同结果；公共前缀账号的批量分配也必须通过分布自测，不能用原始弱哈希分数造成少数Gate热点。该策略只负责稳定初始归属，运行时位置仍以Gate Route和Location为准。

### Component

Component用于组合状态和领域能力。创建Entity时由Factory决定挂载哪些Component，运行时通过`AddComponent/GetComponent/RemoveComponent`管理。Handler不必依赖单一Component，可以协调玩家身上的多个Component。

生命周期采用“默认可选，声明后强约束”。稳定Model通过`@lifecycle({ awake, destroy, deserialize })`声明对应Hotfix System必须实现的业务钩子；未声明项不要求空方法。迁移继续以`@transferable()`作为唯一能力标记，并要求同步`CaptureTransfer/RestoreTransfer`。`codegen:scenes`在构建期检查声明与System实现，Hotfix提交前再次检查候选prototype；缺失或异步生命周期会拒绝整个候选并保留旧generation，Core继承到的空`Awake/OnDestroy`不能冒充业务实现。

推荐业务链路是：

```text
C2M_UseItemHandler
  -> PlayerUnit或ItemComponent领域方法
      -> ItemComponent修改库存
      -> Position/Skill等其他Component响应业务结果
      -> MapComponent选择同步方式
```

不要为了扁平调用增加只转发一次的Sink或Delegate层。

### Component拥有的子对象

Component既是能力组合点，也是某类子对象集合的唯一所有者。Core提供`AddChild/GetChild/TryGetChild/GetChildren/RemoveChild`，统一维护Component所有权索引、EntityRoot、Timer和级联销毁；业务Component不再重复手写一套生命周期Map。

子对象是否继承Entity取决于它是否真的具有独立身份和生命周期，而不是为了统一外观：

- 道具实例拥有稳定`ItemId`，并可能有强化、耐久、绑定、随机词条、交易锁等独立状态，适合成为`Item extends ChildEntity`。Buff和进行中的Quest在具有独立生命周期时使用同一语义。
- `QuestComponent`只为当前进行中的任务创建Quest子Entity；初始可以为空。任务完成时删除Quest，并把稳定的Quest配置ID写入已完成集合。已完成记录不是运行时Entity，可按规模使用Set、位图或持久化索引。
- 金币、材料数量等没有实例差异的数据使用整数、Map或Numeric，不为每个值创建Entity。

运行时对象、协议快照和持久化记录必须分开命名：`Item`/`NativeItemRef`表示运行时权威对象或句柄，`ItemSnapshot`表示跨边界副本，`ItemRecord`表示数据库记录。不要用`ItemDB`同时承担三种语义。

ChildEntity拥有稳定`Id/InstanceId`并进入EntityRoot，但没有mailbox、网络地址和跨Process路由能力。它带有独立名义类型标记，`AddChild`在TypeScript编译期和Runtime创建边界都会拒绝普通Unit伪装成ChildEntity。它的Parent是所属Component，DomainScene仍是玩家所在地图。其Awake必须同步；Component删除或玩家下线时，Core按所有权链自动取消Timer、销毁子Entity并移除Root。

领域边界采用“可以读取对象，集合变化经过拥有它的Component”：单个Item/Buff的局部规则写在自身Hotfix System，新增、删除、转移、堆叠合并和对外同步由所属Component协调。Native可变句柄只在对应System内部使用，不得跨`await`或所有者生命周期长期保存。

Buff需要被AOI玩家看到，不代表Buff需要mailbox，也不需要通用dirty Delta。Buff创建/删除分别使用不可覆盖的`BuffAdded/BuffRemoved`事件；进入AOI时公开Buff随Unit整体Snapshot发送，离开只移除Unit。公开`BuffPublicView`与受限`BuffDetailView`是两套Projection：前者发给AOI观察者与队伍，后者只发给自己与队伍，不能用字段值`0`表达无权限。详情以`(unitId,buffInstanceId)`为latest key，同帧可覆盖。业务只组合逻辑`ClientAudience`，`ClientBroadcast`负责UnitId到Gate及跨地图Location解析。Buff Tick只执行Action，不同步Buff本身：Numeric、Move及其他效果走各自领域协议。少量Buff可使用ChildEntity Timer；大量Buff应由BuffComponent使用到期时间堆和一个最近到期Timer合并调度。

战斗伤害入口已经统一到Unit上的`CombatComponent`：Monster、Skill和Action只提交`DamageRequest`，CombatComponent依次执行已注册的护盾/受伤处理器、修改`NumericType.CurrentHp`并返回`DamageResult`；治疗使用`ApplyHealing`并由CombatComponent限制`MaxHp`。伤害入口严禁查询或调用`BuffComponent`，Buff只能在添加/移除生命周期中注册或注销`DamageAbsorber`，保存`modifierId`而不是让Buff和Combat各维护一份护盾剩余量。MonsterComponent负责找目标、距离、AI、仇恨和重生，不能直接写目标HP；Combat不负责AOI、Gate、目标选择或Unit销毁。完整规则见[战斗伤害与效果管线](../design/combat-damage-pipeline.md)。

Quest默认是玩家私有状态。`QuestComponent`拥有进行中的`Quest ChildEntity`和已完成配置ID集合；活动任务显式区分`InProgress/ReadyToTurnIn`，接取时冻结目标ID与要求数量，配置Reload只影响后续新任务。怪物击杀、道具成功使用和AOI Attach完成后只同步发布`QuestEvents.Progress`领域事实，稳定Hotfix事件Handler再调用`QuestComponent.ApplyProgress`；组件按`(ObjectiveType,TargetConfigId)`运行时索引定位目标，索引不传送、不持久化并从Quest快照重建。接取统一经过`QuestEvents.BeforeAccept`同步Veto，配置内置前置任务与最低等级最终校验。进度使用以QuestConfigId为key的owner-only latest消息；登录、重连和跨地图传送携带活动Quest与已完成ID全量快照。领取必须在PlayerUnit有序mailbox内等待DBProxy关键事务：Inventory先用`PlanGrantItems`在纯快照上规划，`PlayerPersistenceComponent`提交奖励后的完整玩家记录和业务结果，确认后才`CommitGrantPlan`、写完成记录和RemoveChild，最后广播。失败时Entity保持原状；ACK丢失时按稳定operationId读取首次回执并补齐内存，不重复发奖。当前事务Planner只接受`GrantItem`，新增Heal/Buff等事务奖励必须先提供对应纯数据Planner，组队共享任务等待Party系统。完整设计见[任务系统设计](../design/quest-system.md)。

### 领域设计规则与开发助手

业务系统设计先查[`docs/patterns`](../patterns/README.md)。其中用稳定规则编号描述所有权、Entity形态、Audience、状态复制、生命周期、Timer和数据位置；这些文档是人类可读的设计依据，不是自动生成的业务代码。

TiangZ Developer Tools `v0.15.0`把可机械判断的部分固化到不依赖VS Code的共享核心，并向上提供设计向导、`@tiangz`聊天解释、`tiangz-design` CLI、只读`tiangz-design-mcp`和Runtime Foundation诊断。相同结构化输入必须得到相同确定性结论；AI模型只在用户主动聊天时解释报告，不能改变规则结论、虚构API，或把普通业务引向Core、Rust Runtime和Generated。主工程固定依赖该Tag，`verify:design-rule-sync`只要求design-core与`docs/patterns`规则ID集合、归属文档和文件路径完全一致；源码规则执行由`check:project`、`verify:hotfix-boundary`和专项自测负责。

这套助手用于降低开始设计时的心智负担，不取代工程事实。权威顺序仍是：当前代码与测试、项目检查和生成锁，高于设计报告；发现规则与真实实现冲突时，应修正规则库和对应测试，而不是让AI临时圆回来。

### Rust Entity Store（历史上也称Rust Arena）

它表示Rust侧集中保存Entity数据的仓库。TS持有带generation的handle，通过生成的Native Ref和Fast Op访问；对象删除后旧handle被拒绝。`Arena`只是可选实现术语，不是Rust语言关键字，也不是业务开发必须直接使用的API。

当前长期方向是：Rust拥有高频、跨帧Entity/Component权威状态；TS保留Handler、Actor mailbox、Component组合和热更业务语义。

## 线程、Update与定时器

- Tokio负责网络和宿主异步任务。
- 每个Process的TS业务代码只在一个V8线程执行。
- Runtime Pump处理宿主事件和mailbox。
- Game.Update默认固定`50ms`，即`20Hz`。
- Grid2D客户端移动输入的持续心跳默认每`500ms`一次，即`2Hz`；按下、转向和松开必须立即发送，静止时不发送周期Move。容量基线的`C2M_MapProbe`默认每5秒一次，即`0.2Hz`；客户端SDK的`C2G_Ping`同样每5秒一次。三者用途不同，均不能改变20Hz服务端权威推进、AOI同步档位或客户端渲染频率。
- 每个固定帧严格执行`Update -> LateUpdate -> FrameFlush`。
- `Update/LateUpdate/FrameFlush`必须同步，不得返回Promise。
- 需要异步顺序的工作应通过消息或Actor定时器重新进入mailbox。
- Component和ChildEntity定时器在所有者销毁时自动取消；挂在Actor下时回调遵循该Actor mailbox。
- 所有者Timer返回唯一`TimerId`，支持原样业务参数和主动取消方法；取消至多通知一次，Owner销毁时静默清理。
- `FrameTime`是不可持久化单调时间；活动时间和跨重启截止时间使用`ServerNow`及deadline helper。业务需要协议时间戳时调用`TimerSystem.ServerTime()`取得当前Unix毫秒；框架不再提供容易被误解为Entity Component的`TimerComponent`别名。
- `Scene.Locks`提供`Scene InstanceId + domain + key`的本Process FIFO协程锁，不是分布式锁；跨Process先路由到唯一所有者。无竞争锁必须同步进入回调，保证第一个`await`前建立的传送屏障等状态不会被后续unordered消息抢跑。
- Developer Tools会检查StartMachine实际部署集合中的`process.identity`、Timer方法名与取消回调、同步/Veto Scene Event契约，以及`InstanceId/TimerId`误入持久化结构；这些规则与Runtime Foundation自测共同守住业务侧用法。
- `Scene.Events`只处理当前Scene的同步通知和同步否决链；框架不提供异步Event。`SyncEvent`用于事后通知，失败只记录；`VetoEvent`用于操作前只读检查，按`order/id`稳定排序并返回第一个非零错误码。监听器是Hotfix稳定绑定，不为每个Entity动态注册闭包。跨Scene必须使用Message/RPC。
- `Scene.Tasks.Spawn`只承载调用方明确不等待的有界短任务：每个Scene最多256个在途任务，超过10秒仍未结束会记录一次告警；错误统一记录，ProcessHost聚合入口Scene和动态MapScene的在途任务并阻止Hotfix提交，Scene销毁更新TiangZ轻量`signal.aborted/reason`。它不依赖浏览器`AbortController`，也不能替代Veto、Timer、事务、ordered mailbox或需要结果的RPC；永久任务会持续占用容量并永久阻塞Hotfix。

`await`只释放当前异步调用，不会让JavaScript获得多线程并行。是否允许同一业务目标重入，由目标mailbox决定。

所有Entity均具有业务`Id`和本次生命周期`InstanceId`。永久Item等实体使用`GlobalId bigint`；数据库保存`Id`并丢弃`InstanceId`。`GlobalId`编码永久`originServerId`，同服并发Process由`workerId`隔离；Watcher在整套StartMachine启动前拒绝重复组合。完整语义见[运行时基础能力](../design/runtime-foundations.md)。

## Scene发现和跨进程调用

配置中的`scenes`表示当前Process实际启动的EntryScene，`knownScenes`表示当前Process可以路由到的完整目录。目标可以位于本进程或其他进程。

业务调用规则：

- 唯一实例：`scenes.callOne("Rank", descriptor, request)`。
- 多实例：`scenes.many("Gate")`后由业务选择，再`call(target, ...)`。
- 已绑定实例：按保存的Scene name执行`byName`和`call/send`。
- 单向通知使用`send`，不要伪造无意义的Response。

同Process调用直接进入目标mailbox；跨Process调用使用持久Inner TCP和`rpcId`多路复用。某个RPC等待Response时不会阻塞同连接上的其他RPC。

Location Scene已经负责`UnitId/account -> Gate/MapHost/MapInstance/ActorInstance`的跨进程权威定位，并以revision、operationId和`active/moving/removing`状态保护迁移与下线。普通客户端Actor消息仍走Gate本地连接路由缓存，不逐消息查询Location；只知道UnitId的服务端业务使用`MessageHelper`解析一次后直达Actor，批量业务使用`ResolveMany`后按Gate/MapHost分组。账号Rendezvous Hash继续稳定选择Gate，连接代次完全留在Gate的Route/Session层。Location内存进程可由MapHost周期重报恢复，但尚无MapHost租约、死亡节点接管、在途事务日志或Gate故障转移。详见[Location与玩家Actor路由](../design/location-routing.md)。

## 协议模型

外层网络帧固定为：

```text
[length: u32 big-endian][msgcode: u16 big-endian][protobuf payload]
```

Rust负责length-prefix分帧，并把不含length的二进制帧批量交给TS。TS根据msgcode取得descriptor，完成protobuf decode、Handler分发和response encode。

`rpcId`不是帧头字段，而是`IRequest/IResponse`的payload字段，由生成代码和RPC框架处理。单向`IMessage`不需要rpcId。

消息层级参考ET但不硬套：

- `IMessage`：单向消息。
- `IRequest/IResponse`：普通RPC，通常以连接或EntryScene为目标。
- `IActorMessage/IActorRequest/IActorResponse`：明确Actor目标。
- `IActorLocation*`：由玩家位置路由到具体Unit。

消息编号按proto文件起始编号和定义顺序生成，并由`opcode.lock.json`与`schema.lock.json`锁定。已有消息始终沿用lock编号，删除消息的编号永久保留，新消息自动跳过保留号。生成器负责请求响应关联、descriptor、codec、客户端Client和Handler导入，不让开发者手工维护msgcode表。

## 状态复制模型

TiangZ明确区分三种语义：

| 类型 | 用途 | 行为 |
|---|---|---|
| Snapshot | 进入视野、重连、主动全量同步 | 发送完整当前状态，不修改Dirty |
| Delta | 位置、Numeric、速度等可覆盖状态 | 字典或字段级置脏，帧尾Peek/Send/Ack |
| Event | 技能、道具、掉落、伤害事实 | 立即可靠排队，不允许latest覆盖 |

Numeric使用`NumericType -> i64`动态字典与dirty表，TS边界是`bigint`；创建Numeric时第二个参数也是按`NumericType`索引的初始化字典，`NumericInitialValues`只是它的类型别名，不维护逐字段接口。`NumericComponentSystem.Awake`只遍历创建者传入的字典并挂载Rust存储，不猜测玩家、怪物或NPC默认值；未传入的普通Numeric保持Rust默认值`0`。`MaxHp`、`Attack`、`AttackSpeed`、`MoveSpeed`等1000..9999派生结果由`result*10+1/+2/+3`的Base/Add/Pct来源自动重算，不能直接赋值；初始化只能写普通属性或Base/Add/Pct来源。`AttackSpeed`表示毫秒/次，`MoveSpeed`在Numeric中表示毫米/秒，配置表仍使用米/秒。Unit固定字段使用`.native @replicated + @memberId`生成`u64` dirty mask；Item变更演示不可覆盖的即时Event。

帧尾复制采用`Peek -> Send -> Ack`：只有发送成功才确认revision，发送失败保留Dirty，发送期间的新修改不会被旧Ack清除。Audience只决定收件人，数据Projection决定字段权限，Broadcast descriptor只决定event/latest语义。业务使用只含UnitId的`ClientAudience`；物理`BroadcastAudience`和Gate route是Core内部类型。

AOI已由Rust扁平X/Z Grid接管。Cell是移动和空间数据的基础单位，AOI关系只在跨Grid边界时重算；默认一个Grid为15×15 Cell。`UnitId -> EntityIndex`哈希只在API入口使用，实体元数据与Audience签名按EntityIndex连续存放。Grid成员默认使用紧凑EntityIndex数组；128人以上的热点Grid额外建立成员位图，降到96人以下释放。空间候选和最终可见关系使用双向连续位图；Rust同时保存本帧净变化和用于共享编码的增量Audience签名，TS不得建立镜像关系表。密集迟滞Audience按`Grid + 最终受众签名 + 强制发送状态`共享一次受众计算，再按实际受众合并编码；业务不得依赖签名或管理该缓存。业务只从`MapComponent.Audience`取得`ObserversOf/VisibleSubjectsOf`；显式Invalidate返回的变化必须交给`MapComponent.PublishVisibilityChanges`统一发布。Prometheus提供当前迟滞与拒绝关系Gauge。`single-grid`是稳定全可见广播基线，`same-point`是高频跨Grid迟滞压力测试，两者不能混为容量曲线。完整分层、代码范例和Demo位置见[AOI完整设计](../design/aoi-architecture.md)。

Rust按最终Audience编码Movement、Numeric和UnitState。通用路径由`BroadcastHub`把Encoded batch交给Transport，并由`SceneBroadcastTransport`在同步Game Tick内按Gate重组；Movement高频路径进一步由Rust利用Attach时登记的紧凑delivery route直接生成每个Gate的完整`S2G_ClientBroadcastBatch`帧，TS每Tick只映射至多Gate数量的routeId并原样投递，不展开recipient数组，也不重复编码内网protobuf。Gate不解码业务payload，只完成Unit到connection的路由与下行扇出。Numeric、UnitState和即时Event继续使用通用路径。业务层不得管理routeId、调用底层route-frame Native op、调用`sendFrame`，也不得直接构造内网广播协议。

## 地图空间契约

`0.4.0`冻结服务端地图局部坐标为米制`X/Y/Z + Yaw`：X/Z是地面平面，Y是高度，Yaw是绕Y轴弧度，Yaw=0朝+Z，前向量固定为`(sin(Yaw),0,cos(Yaw))`。坐标必须和`MapInstanceId`一起解释，不建立跨大陆的巨大浮点世界坐标。protobuf与Native schema使用普通`float/f32`，客户端适配层再转换为具体引擎坐标。UE边界使用`(X,Z,Y)×100`和`90°-TiangZYaw`转换；协议状态不能保存或回传UE原生`FVector/FRotator`。

玩家跨MapHost使用稳定protobuf `PlayerTransferSnapshot`。生成端和目标校验端统一引用`PLAYER_TRANSFER_SCHEMA_VERSION`；新增Buff、Skill等可传送Component或修改传送字段时必须显式升级该常量，并通过真实跨图Runtime smoke，不能在两处手写不同版本号。

`MapConfig.SpatialMode`区分`Grid2D`与`NavMesh3D`。Grid2D运行在X/Z Cell上；NavMesh3D固定官方Recast/Detour `v1.6.0`，具备确定性灰盒、v2压缩高度层资源、SHA-256元数据、Map启动装载、Rust投影/寻路/射线/高度和动态障碍。相同资源的MapInstance共享不可变高度层模板，各自独占`dtNavMesh + dtTileCache + Query`、路径、AOI和Unit空间状态；Scene销毁通过`SpatialRelease`幂等释放。动态障碍只表示门、路障等业务物体，不包含角色或怪物之间的动态阻挡与动态避让。业务用稳定地图内`ObstacleId`调用`MapComponent.UpsertNavigationBoxObstacle/RemoveNavigationObstacle`并提交真实物理盒体，Rust按烘焙`agentRadius`扩张X/Z导航占用、合并目标状态并按Tick限制命令和Tile重建；业务不得重复增加半径。提交完成后未结束的点击路径自动重算。`C2M_FindPath`只查询，`C2M_NavigateTo`提交路径目标，`C2M_NavigateInput`提交相对朝向的离散方向；点击路径由Rust先连续转向再前进，方向状态由Rust每个20Hz Tick通过`moveAlongSurface`贴地推进，并缓存Unit当前polygon引用。客户端采用相同的路径转向预测，并每500ms续期1.5秒方向输入租约；断续期后Rust自动停止。Cocos 3D与UE 5.4.4均以`E`键调用同一个动态门RPC，并且只在服务端响应后更新红门表现；Cocos为本地预测增加表现约束，UE只插值权威位置，客户端门Actor均不参与权威导航计算。权威位置以`G2C_EntityNavigate`按AOI批量广播。完整约束见[地图空间与3D坐标契约](../design/spatial-world.md)。

动态障碍的可见状态不能只放在请求者的RPC响应里。地图状态变化时，业务必须向当前地图所有在线客户端广播状态事件；客户端完成`MapSnapshotReady`时还必须从响应读取当前状态，避免“后来进入的玩家看不到门，但服务端仍然阻挡”的分叉。`G2C_DemoDoorState`是灰盒演示的具体例子，正式门系统应沿用“进图全量状态 + 变化事件”的模式。

## 客户端与Transport

`client_sdk/typescript`是TypeScript Client SDK唯一源码，codegen将正式协议副本分发给Cocos和Pixi；`client_sdk/cpp`是C++ SDK唯一源码，Proto生成无Google protobuf runtime依赖的C++20结构、Codec和类型化描述符，再由`codegen:cpp-client-sdk`分发到UE 5.4.4插件；`client_demo/godot-3d-4.7.1/scripts/generated/tiangz_proto.gd`由`codegen:godot-client-sdk`从Proto生成，`scripts/tiangz_client.gd`和`main.gd`只维护Godot连接流程与表现适配。所有客户端SDK Core都不能依赖其他引擎；平台只实现Transport、Update驱动、坐标和表现适配。UE和Godot当前只支持WebSocket，TCP/KCP未实现时必须立即报错。

当前验收范围：

- Cocos Web：WebSocket。
- PixiJS/H5：WebSocket。
- Cocos Native Windows：TCP/KCP。
- Godot 4.7.1：WebSocket。

服务端将I/O Backend和Endpoint协议分成两个维度：epoll/io_uring负责操作系统I/O，TCP/WebSocket/KCP负责传输协议。不支持的平台选择KCP等Transport时应立即报错，不能静默降级。

客户端RPC使用生成的`LoginMgrClient/LoginClient/GateClient/MapClient`。服务端Push使用独立`@clientMessageHandler`，避免把所有监听堆在一个构造函数中。网络回调只入队，客户端游戏循环调用SDK的`update()`进行分发。

## 目录所有权

```text
app/core/                    TypeScript框架
app/core/public.ts           业务唯一Stable Core API入口
app/model/                   不可热更的状态、稳定类型与启动结构
app/model/mmorpg/              当前MMORPG演示的稳定类型和状态
app/model/bench/             仅由build:bench装配的稳定基准结构
app/model/public.ts          Hotfix唯一允许导入的Model入口
app/hotfix/                  可热更的Handler和领域方法实现
app/hotfix/mmorpg/             当前MMORPG演示的可热更行为
app/hotfix/bench/            仅由build:bench装配的压测Handler
app/generated/               服务端与Native自动生成代码
app/generated/bootstrap/     自动生成的Model Scene启动入口
app/generated/hotfix/        自动生成的Hotfix Handler和补丁入口
src/                         Rust Runtime、Transport和宿主
src/generated/               Rust自动生成代码
proto/                       protobuf唯一源文件
game_config/                 Luban Excel游戏配置唯一源文件
native_data/core/            框架内置Entity op原型，业务不得修改
native_data/<game>/          游戏Entity和粗粒度Native op原型
client_sdk/typescript/       引擎无关TS SDK唯一源码
client_demo/cocos_client2D_3.8.6/.../Demo/     Cocos业务和表现
client_demo/cocos_client2D_3.8.6/.../Generated 自动分发SDK和Handler入口
client_demo/cocos_client3D_3.8.8/              Cocos Creator 3D灰盒客户端；Generated/SDK自动分发，Demo脚本只做登录、查询与显示
client_demo/ue_client3D_5.4.4/                 UE 5.4.4 C++插件与灰盒客户端；ThirdParty SDK由codegen覆盖
client_demo/godot-3d-4.7.1/              Godot 4.7.1 GDScript WebSocket灰盒客户端；协议层由codegen生成
client_demo/pixi_client_8.19.0/src/             Pixi业务及SDK验收
configs/<environment>/       环境、Process与Scene正式部署配置；一个子目录对应一套可复制部署包
configs/bench|tests|experiments/ 压测、自动测试与传输实验配置
tests/fixtures/              不进入生产运行时的确定性回归数据
perf/                        性能与长稳工具、历史报告
tools/                       codegen和工程工具
tools/support/               冒烟测试和压测共享的低层协议辅助，不属于业务API
docs/                        教程、参考、设计和阶段记录
docs/patterns/               MMORPG领域设计原则与稳定规则编号
```

Generated目录禁止手工编辑。新建平级游戏目录时，codegen通过`codegen.config.json`的搜索根发现Scene和Handler，不维护手工类型表。

游戏静态配置与部署配置严格分离：`configs/<environment>`只描述Machine、Process、Scene、端口和Runtime参数；`game_config`保存策划维护的Luban Excel。仓库固定Luban `4.10.2` CLI，按`c/s`分组生成服务端Model类型、客户端SDK类型和独立JSON数据包。表、字段、类型、分组、索引和引用关系属于绝对不可热更的Model；数据重载策略由`ConfigTablePolicy`按整表声明，不能在一张表内混合Hot/Cold。当前ItemConfig、PlayerConfig为Hot，MapConfig、AoiConfig、AoiSyncTierConfig和策略表为Cold。生成包同时携带完整/Hot/Cold数据及指纹；Rust验证三者分区一致，TS拒绝Cold指纹变化。只有Hot数据可由Watcher通过`reload-config`原子替换，Cold任何值变化都必须完整构建并重启Process。业务统一通过只读`GameConfigs.Xxx.Get/TryGet/GetAll`读取，不直接解析Excel/JSON，不长期缓存整行对象。Reload不重跑Awake、不回写既有Entity状态，旧引用仍指向旧快照。客户端配置仍随SDK发布，服务端Reload不会远程替换Cocos/Pixi数据。

游戏配置命令明确区分启动包和在线候选：`npm run build:game-config:startup`会重新生成并覆盖`dist/game-config`，Process重启时读取这里；`npm run build:game-config`只生成`dist/game-config-candidates/<指纹>`，必须配合Watcher的`reload-config`在线切换。`npm run test:game-config`只验证生成物和指纹，不会更新启动目录。

`.native`是codegen输入而不是生成物。框架通用ABI只放`native_data/core`；游戏新增Rust批处理能力时在`native_data/<game>/XxxOps.native`声明，生成器聚合产生Rust Extension、Host bootstrap和TS `NativeOps`。状态机黄金数据属于`tests/fixtures`，禁止混入原型目录。

正常`npm run build`装配Demo的Model与Hotfix双Bundle；压测入口必须使用`npm run build:bench`显式加入`app/model/bench`和`app/hotfix/bench`。服务端`app/generated`不再生成客户端协议副本，工具和性能测试统一从`client_sdk/typescript/Generated`导入。Developer Tools 的 `tiangz.hotfix.instance-state` 诊断会在编辑器中拦截Hotfix行为类字段、构造函数和静态执行状态；日常改动先用`npm run verify:fast`反馈。

Bench Hotfix可以通过`#tiangz/model`调用稳定业务API来测量生产路径，普通Demo不得反向依赖Bench。`app/model/main*.ts`与`app/hotfix/main*.ts`分别是两层组合入口；根`app/main*.ts`只保留源码兼容入口。Developer Tools与`tiangz-check-project`共同强制依赖方向。

Actor Runtime只负责Scene、Session、ActorUnit的InstanceId路由与mailbox；普通Unit由`UnitComponent`本地拥有。旧式`@handler("字符串")`、动态组件Handler hooks和`ProcessHost.call/send`已移除；`@unitRpcHandler/@unitMessageHandler`只能绑定`ActorUnit + @actor`，批量MonsterUnit的业务入口由Map Handler转入其所属Component。

测试和压测专用的裸帧构造、响应解码、Fake与Fixture必须放在`tools/support`、`perf`或对应测试文件中，禁止放入`app/core`或`app/<game>`。正式客户端能力只能进入`client_sdk`及其Generated分发目录。

Model业务代码只能从`app/core/public.ts`导入Core能力；`app/model/main.ts`是宿主启动桥接例外，只负责Runtime启动、更新、停止和Host事件转发，不是业务代码模板；Bench代码仍必须使用Stable入口。Hotfix只能从`#tiangz/model`取得Model与Stable Core API，不得深层导入。`public-api.lock.json`以schema 3记录Stable导出、顶层签名和完整可达`.d.ts`声明图；开发阶段`verify:core-api`仍检查边界和自测，但不强制快照锁，准备发布时由`npm run verify:release`开启完整比较。Hotfix第一代冻结Handler key集合，后续只能替换既有实现，新增、删除或重命名Handler必须重启。Native Store诊断是Rust Core正式配置`process.observability.nativeData`，由Rust负责默认值和校验；Native数据原型本身、io_uring和部分KCP能力仍按专项文档视为Experimental或平台限定。公共API变化必须提供迁移记录，并同步更新本文和AI业务开发手册。

ordered Scene mailbox的同步排空使用循环而不是递归，长串同步消息不会耗尽V8调用栈；这不改变单Mailbox串行语义。缓存和索引必须归属于Scene/Component等明确所有者，不能放在Hotfix模块级可变变量或全局单例中；配置Reload时按指纹在所有者内懒重建。

## 已完成阶段

- Phase 0：Rust/deno_core/TS构建、目录、配置、proto codegen和错误码。
- Phase 1：二进制协议、RPC、同步/异步Handler、Inner TCP多路复用、背压、Inspector和基础性能验证。
- Phase 1.11：统一为一Process一V8、多EntryScene，本地/远程调用语义一致。
- Phase 2：登录到地图纵向链路、GateSession、Unit、多人移动和客户端可见。
- Phase 2.12：固定Game.Update、TimeSystem和游戏定时器。
- Phase 2.13：Rust权威实体数据、generation handle、Native op codegen和Rust直接protobuf广播。
- Phase 3：可复用TypeScript Client SDK及Cocos/Pixi/Cocos Native验收。
- Phase 3.5：Numeric字典、固定字段dirty mask、Item Event和通用状态复制基础。
- Phase 3.9：协议锁、64位无损bigint、Watcher优雅停机、质量门、双语注释和长稳工具。
- Phase 3.10.1：项目版本身份、Stable Core入口、API锁、依赖方向检查和独立业务夹具。
- Phase 3.10.2：RPC在途id避让、本地/远程timeout、迟到/重复响应与断线/停机清理，以及Actor销毁、旧InstanceId、ordered/unordered正确性矩阵。
- Phase 3.10.3：Process退出、Inner断线、慢客户端、过载、Handler异常、非法帧、重连风暴和保存失败的一键故障注入矩阵。
- Phase 3.10.4：每个 Process 通过健康端口开放 `/metrics`；Prometheus 按 `StartMachine.json` 发现实际 Process，Grafana 提供 Process/Scene/延迟/队列/背压/Runtime 分层面板。`/ready` 依赖 V8 Runtime 心跳，Scene 自定义指标显式区分 Counter/Gauge，并有基础告警规则与 `verify:observability` 验收。禁止新增业务 Observer Scene 汇总指标。
- Developer Tools 的运行时查看目前只读取 Process 健康端口的 `/metrics`，用于观察队列、mailbox、pending RPC、Timer 和 Native 摘要；它不执行 RPC、不读取任意 V8 对象，也不改变业务状态。按 UnitId/Actor 查询的只读 Inspector 仍处于协议草案阶段，必须完成 Runtime 端点和权限边界后才能宣称可用。

## 已验证的稳定性事实

2026-07-25的正式长稳样本使用拆分进程、200玩家、每玩家5Hz Move，预热60秒后持续10小时：

- 发送35,999,865次Move，精确序号确认35,999,836次，其余29次被更高序号权威状态覆盖。
- 零错误、零stalled、服务端固定Game.Update零跳帧。
- p50/p95/p99为33.90/61.79/70.04ms。
- Gate和Map后四分之一RSS趋势约为`+0.3MB/h`与`+0.2MB/h`，V8 Heap没有持续增长证据。

详细口径见`perf/results/soak_latest.md`。这是特定机器和全地图可见Demo负载的稳定性证据，不是生产容量承诺。

## 当前未完成和明确暂缓

2026-07完成了[Phase 4前框架成熟度审计](../design/framework-readiness-audit.md)中的R1至R4实现与专项验收。`0.3.10-alpha.5`建立Model/Hotfix双Bundle和在线事务，`alpha.6`加入`@systemFor`和高负载验收，`alpha.7`把Hotfix改为固定脚本名IIFE、统一业务Timer方法名语义，并补齐8秒慢RPC屏障与100代资源长稳。3000玩家A/B已验证1Hz Reload吞吐无可见下降，但Probe p95/p99约增加32%/31%；100代测试中损坏候选被拒绝，Timer、Native实体和pending均无漂移，预热后的V8 Heap/RSS增长通过4MB/16MB硬门槛。Developer Tools `v0.15.0`已作为主工程固定依赖，VS Code、CLI和MCP共享确定性领域规则，并补充运行时基础能力诊断。

性能回归职责必须分层：`verify:perf` 比较三轮中位数吞吐、p99与错误；`test:backpressure` 验证有界队列和生产者等待；长稳测试判断RSS/V8 Heap趋势。不要把短时RSS噪声或故意过载指标混入普通性能基线。

Cocos Demo完整类型检查依赖编辑器生成的`client_demo/cocos_client2D_3.8.6/temp/tsconfig.cocos.json`和`cc`类型，不得把该缓存提交或复制到CI。`typecheck:cocos-demo`在编辑器环境执行完整tsc，在干净Linux/CI环境执行入口bundle检查；引擎无关Client SDK始终由`typecheck:cocos-net`完整检查。Cocos Web构建统一使用`npm run build:cocos3d:web`、`npm run build:cocos3d:mobile`以及对应的2D命令，默认明确传入Release模式；需要调试包时只能使用带`:debug`后缀的命令。脚本匹配Creator版本、清除`ELECTRON_RUN_AS_NODE`、清理并校验标准输出目录，`check:cocos-build`可在不启动编辑器时预检参数。Creator 3.8.x本机已知的`code=36`只有在完整Web产物存在时才接受，其他非零码必须失败。不要手工拼接`CocosCreator.exe --build`，也不要把`library/temp`当作发布产物。Cocos Native必须先生成原生工程，再单独执行CMake/Visual Studio编译。

热更粒度固定为整个Process的TS行为世界，而不是单个Scene，也不为每个EntryScene增加V8。TS分为绝对不可热更的Model和可热更Hotfix：Model拥有字段、构造、继承和稳定类型，Process运行中不存在Model reload API；Hotfix只提交方法与Handler。候选先在隔离V8预检，再在当前V8暂存；第一版暂停入站并等待在途任务归零后原子提交，不做字段migration或双generation长期并存。候选必须包含当前generation已有的完整Handler绑定集合，删除或重命名Handler属于Model/协议路由变化，必须重启；所有Scene/Session/Unit/Event Handler类都禁止字段、构造和可变静态成员，避免实例复用时泄漏共享状态。任何Model/Core/协议/Native schema变化都必须重启Process。详见[热更设计](../design/typescript-hot-reload.md)。

业务行为采用ET风格System表达：`@systemFor(ModelType)`类写`Awake/OnDestroy`和公开领域方法，但不创建实例、不保存字段。codegen把公开方法生成到`app/generated/bootstrap/systems/*.d.ts`并合并回Model类型，所以调用方保持`unit.Move()`的面向对象写法，Model无需手写抛错空壳。运行时仍直接安装prototype描述符，没有逐次Registry查找。System首次安装后为必需项，候选遗漏会整体拒绝；Reload不重跑现有对象Awake，新对象使用新Awake，已有对象后续方法和销毁使用当前generation。

本地开发可使用`npm run dev -- configs/<环境>/<部署包>/StartMachine.json`（当前为`configs/local/cluster/StartMachine.json`）：开发宿主初次完整构建并启动Watcher，随后监听`app/hotfix`和`game_config`源文件，串行构建不可变Hotfix或配置数据候选并分别执行`reload`/`reload-config`。它不改变生产模型，不监听Model源码，也不允许V8直接执行TS；正式部署仍需分发完整候选目录。Model以ESM加载一次，Hotfix以固定脚本名IIFE重复求值，避免ESM ModuleMap和每代脚本URL持续增长。Developer Tools对Model长期状态中的`any`、可选字段、基本类型与`undefined`联合、跨基本类型联合、`delete`和`as any`写入按错误处理；DTO、对象`T | null`、判别联合与显式Map/Record不受影响。

Prometheus/Grafana 已完成多 Process 采集和核心诊断面板；正式部署仍需补 node/windows exporter、通知路由和长期存储策略，这些属于Phase 5，不阻塞`0.3.10`框架准入。

Phase 4计划：

- Phase 4.0已完成：Native Unit、protobuf、MapConfig、Cocos 2D和Pixi统一采用米制`X/Y/Z + Yaw`契约；Grid2D使用X/Z Cell，MapScene按实例创建和释放Rust空间状态。此次为显式破坏性协议升级，旧`0.3.10`客户端不能混连。
- Luban游戏配置基础已先行落地：首批`ItemConfig`、`MapConfig`和不含等级成长数据的`PlayerConfig`已接入服务端、Cocos与Pixi；结构固定在Model，服务端纯数据可原子Reload，字段分端裁剪、外键、只读查询、配置指纹和失败回滚已有自测。后续业务表沿用同一入口，不新增私有加载器。
- Phase 4.5正在建设持久化基础。独立仓库[TiangZ-DBProxy](https://github.com/moulo1982Google/TiangZ-DBProxy)已发布`v0.5.0`：DBProxy继续独立拥有快照、Revision/CAS、幂等、单记录与多记录原子事务、可查询事务回执、PostgreSQL权威存储、Redis已提交缓存与AOF backlog，并提供版本化Protobuf、协议指纹、内部令牌、Rust客户端池和运行时无关TypeScript SDK。`v0.5.0`新增有序多Endpoint客户端、首Endpoint不可用和连接中断后的故障切换、两个共享PostgreSQL/Redis的无状态对等实例配置，以及跨玩家/跨记录的全量CAS原子提交；业务拒绝、鉴权、协议不匹配和Revision冲突不会误触发换节点。普通`.native @persistent(version)`实体的Codec与通用Repository已经由codegen生成，复杂查询和跨玩家交易仍由领域Repository编排。TiangZ主工程已将`Cargo.toml/package.json`切换到`v0.5.0`，Rust Host Bridge提供`applyMultiTransaction/loadMultiTransaction`，配置通过`failoverEndpoints`声明备用地址；不能在主工程中复制第二套DBProxy协议或客户端。TiangZ已经接入`HostDbProxyTransport -> DbProxyClient -> DbProxyPlayerRepository`真实链路；Rust Host Runtime负责多线程网络I/O，V8只等待Promise，主工程仍不得连接Redis/PostgreSQL或导入`dbproxy-storage`。`tiangz.demo.player@1`快照保存Numeric、Item、Buff、Skill冷却、Quest和地图状态。普通快照已通过重启恢复；任务领奖和UseItem已经成为关键单玩家事务：领域Component先规划操作后纯数据，DBProxy原子保存玩家记录与原始业务回执，成功后才无await修改Entity，ACK丢失后按operationId恢复。UseItem同时提交Inventory扣除、道具/GCD截止时间以及Heal或受限Buff效果；客户端为每次逻辑使用生成稳定operationId，重试复用。Redis/PostgreSQL高可用由云厂商托管，不在框架内实现；TiangZ端到端故障矩阵、周期快照、Wallet/Trade领域模型、按领域拆分revision、自动节点接管、Prometheus和生产部署仍未收口。单玩家巨型记录只是Phase 4.5验证载体，不能替代最终领域一致性设计。完整步骤见[DBProxy玩家快照持久化](../tutorials/19-dbproxy-player-persistence.md)。
- 技能系统第一阶段已经实现：Unit上的`SkillComponent`只保存技能/GCD deadline和唯一ActiveCast，地图唯一`SkillMapComponent.Update10Hz`推进活跃读条与弹道；不创建每Unit Update、每Cast Timer、Actor或Entity。瞬发在ordered PlayerUnit调用内完成，移动策略和平A策略均由配置显式决定。施法期间平A意图仍保留，但平A读条被冻结，不能继续累计；玩家受到一次**没有被护盾吸收**的有效攻击且读条仍有效时，Demo战斗规则对普通读条只把`finishAtMs`向后延长800ms，对引导只把结束时间提前800ms，不重置起点、不清除引导、不改变CD，并立即广播新的`G2C_SkillCastState`，客户端依据新的权威结束时间更新进度条。真言术·盾吸收本次攻击时，不后移普通读条，也不缩短引导；后续未被吸收的攻击仍按同一规则处理。冷却随玩家跨地图传输，活动读条在传送时终止。`SkillConfig.xlsx`描述目标关系与施法时间线并生成给前后端，服务端专有的`SkillEffectConfig.xlsx`描述有序Action；`SkillCatalog.ts`只按配置指纹组合只读定义，不再保存技能数值。ActiveCast和Projectile冻结接受请求时的定义，Reload只影响新Cast。技能只选择目标并执行Action，伤害/治疗进入Combat，Buff生命周期进入BuffComponent。Buff冲突使用`stack_group + stack_scope`和Stack/Refresh/Replace/Reject/HigherWins；运行时Action覆盖和护盾剩余量可跨地图恢复。完整方案见[技能与施法系统设计](../design/skill-system.md)和[配置化技能教程](../tutorials/18-configured-skill.md)。
- 账号与角色选择、正式持久化业务接入。
- 地图传送已经统一为`player.TransferToMap(mapInstanceId)`：业务不提供MapHost、IP、端口或本地/远程分支。Gate在第一个`await`前打开有界屏障，源PlayerUnit mailbox通过MapInstance目录解析目标后协调Location锁、目标候选、位置提交和源Actor清理；Proto `duringTransfer`决定Actor消息排队、拒绝、丢弃或latest覆盖。Map1/Map2拆为两个MapHost的Runtime smoke已经覆盖跨进程传送，并验证并发UseItem只在目标Unit执行一次。Component仍默认不迁移，Numeric、Item显式参与，Position只迁移速度/朝向/存活。目标提交后Location结果不确定时进入可诊断`moving`态，不向旧Actor重放；生产级事务日志和自动恢复仍属后续高可用工作。详见[Entity地图迁移](../design/entity-transfer.md)与[Location路由](../design/location-routing.md)。
- Phase 4.1 Rust AOI功能链和Windows正式容量回归已完成：每个MapInstance按有限地图边界创建扁平连续X/Z AOI Grid，Grid成员使用紧凑`EntityIndex`连续数组和`slotInGrid`做O(1)迁移；`UnitId -> EntityIndex`哈希只在API入口定位，实体元数据与Audience签名连续存放，候选循环不再逐实体查Hash。单Grid达到128人会额外建立成员位图，降至96人以下释放；微基准显示128人起优于数组去重。空间候选与业务过滤后的最终可见关系使用四张双向稠密位图，迟滞关系另用一张单向位图维持O(1)指标。位图使用单块连续`u64`矩阵并按512实体分段扩容，有意用内存换关系差分、正反向查询和缓存局部性；3000实体预留到3072时五张矩阵约5.6 MiB。当前每MapInstance硬限制16384个AOI实体，对应五张矩阵约160 MiB；更大Scene必须使用分块位图或空间分片。`Cell`是可配置米制空间单位；默认15×15 Cell组成一个Grid，3×3同时作为Enter和20Hz高频区，已可见关系进入5×5外圈后降为5Hz，5×5也是Detach边界，越界立即Leave；不再配置7×7和1Hz档位。TS不镜像关系。FastOP X/Z写入自动标脏，只有跨AOI Grid才更新索引；当前不做每Tick CSR重建。Movement按同步档位节流，开始/停止/转向强制立即发送；Numeric、UnitState和不可覆盖事件保留各自同步语义。进入/离开同帧相同受众合并为`G2C_AoiDelta`。阵营/隐身/位面由同步`IAoiVisibilityFilter`查询并显式Invalidate。3000人正式基线固定80% Grid内移动、20%每2秒跨Grid，理论跨Grid约300次/s。新旧同口径10×10、15×15、20×20 A/B中，Map CPU平均由`74.1%/56.7%/57.3%`降为`55.0%/50.7%/42.9%`，分别下降约`25.8%/10.6%/25.1%`；新30秒Probe p95/p99为`62.18/100.18ms`、`41.34/53.39ms`、`35.59/42.26ms`。三档正式窗口均零错误、过载、超时、背压和慢连接，跨Grid达到理论值的99.8%/101.2%/100.5%。第一次20×20尾延迟异常已通过同参数复测确认是不可重复的环境抖动；10×10另以60秒窗口复测得到CPU 56.2%、p95/p99 50.60/75.17ms，说明CPU收益稳定，但密集场景短窗口p99仍存在调度波动，不能宣称所有延迟分位同比下降。Phase 4.2接入NavMesh3D；Phase 4.3完成Cocos 3D Demo；Phase 4.4进入怪物与战斗；Phase 4.5最后完成持久化基础。Cocos3D手机Web第一版使用`web-mobile`构建，`/m/`部署路径只改变页面模板与输入表现，不改变服务端空间协议。
- Phase 4.2.5已完成导航主链：`tools/navigation`生成固定灰盒，`navmesh_bake`通过官方Recast离线烘焙v2压缩高度层并立即回读，输出稳定小端资源与SHA-256元数据；Rust提供投影、寻路、连续贴地移动、射线、高度、实例TileCache和动态障碍。开发者不手工烘焙，也不接触Detour句柄；真实地图仍需补展示模型与导航碰撞源的制作期一致性检查。
- Phase 4.4已接入首版完整怪物业务闭环：`MonsterConfig`描述模板、血量、攻击力、独立攻击距离和复活秒数，`MonsterAreaConfig`只描述固定刷怪槽位、坐标和初始是否生成，二者都是冷配置；`MapHost`创建每个MapScene时自动挂载`MonsterComponent`。怪物是`UnitComponent`中的普通`MonsterUnit`，AOI只把它作为Subject，不拥有Gate连接，也不作为Observer。Map固定桶统一处理主动索敌、仇恨追击、攻击间隔、玩家自动平A、死亡尸体和新Unit重生：20Hz保留既有地图移动，10Hz处理玩家平A读条，5Hz处理怪物AI/仇恨目标，1Hz处理尸体清理与重生。玩家和怪物的攻击力都使用链式Numeric：玩家默认写入`AttackBase=5n`，怪物写入配置攻击力到`AttackBase`，Rust推导只读`Attack`；攻击直接读取最终Attack扣除CurrentHp，当前不增加Armor。玩家实际伤害按1:1调用`MonsterComponent.AddThreat`写入仇恨表，攻击距离分别读取`PlayerConfig.attack_range`和`MonsterConfig.attack_range`，不混入Numeric。怪物死亡后以`alive=false`保留原Unit和AOI身份；有掉落的尸体保留5分钟、无掉落的尸体保留10秒，全部普通掉落领取完成后可以提前清理。尸体清理完成后仍按`respawn_seconds`等待，再Detach并发布AOI Leave、Remove旧Unit，只复用`AreaId`创建新的MonsterUnit、UnitId、InstanceId和Native句柄，通过AOI Enter发送新快照。拾取重试使用同一`operationId`读取DBProxy回执，不因尸体已离开而重复创建Item。NumericComponent不再内置100ms回血Timer；周期规则由具体业务Component显式拥有。玩家的`CombatComponent`只保存平A意图和读条，不创建每玩家Timer；目标必须在前方120°和玩家配置攻击距离内，离开条件只清零读条，重新满足后从零开始。业务Handler只调用`PlayerUnit.AttackMonster/ToggleAutoAttack`，不遍历地图或直接操作Native句柄。技能、掉落、Buff、任务和复杂仇恨扩展仍由业务层继续追加，完整开发示例见[怪物模块教程](../tutorials/16-monster-module.md)和[固定更新桶与自动平A设计](../design/auto-attack-and-fixed-update.md)。演示客户端读取`MonsterConfig.attack_mode`做表现提示：自己蓝色、其他玩家绿色、被动怪黄色、主动怪红色；这个字段只用于客户端识别，不承担服务端权威判断。
- Gate物理连接关闭后，Cocos3D必须立即清除旧地图状态和`UnitId`并回到登录界面，不能继续使用已经被Map移除的Actor发送技能或移动。Starter尚未实现墓地、灵魂或主动复活流程；DBProxy恢复到`alive=false`的玩家时，当前Demo只在重新创建PlayerUnit的进图边界于出生点满血恢复，正式业务应以独立Revive领域操作替换该策略。
- 怪物基础AI进一步收敛为Hotfix内部的`MonsterBehaviorTree`：只包含待机、追击、攻击和攻击冷却停留，不建立通用AI框架，不创建MonsterActor或每怪物Timer。普通攻击距离由各自配置控制，行为树只选择动作，伤害、仇恨、死亡和Numeric修改仍由`MonsterComponentSystem`执行。
- 战斗时间轴语义已冻结：玩家或怪物按下普通攻击后只激活`AutoAttack`状态；靠近目标且满足距离、存活、同MapInstance和朝向条件时才推进平A读条。距离过远或朝向失效会清零当前读条，但不取消AutoAttack状态，重新满足条件后从0秒重新开始。移动不停止AutoAttack，右键加A/D的侧移用于保持朝向绕目标移动。施法期间由`SkillComponent.IsCasting()`冻结平A累计，施法完成或中断后才允许重新开始平A读条；受击惩罚只由地图技能调度器在Combat确认本次没有护盾吸收且实际命中后调用，真言术·盾吸收的攻击不会后移读条或缩短引导，不能由客户端或通用Combat反向查询Buff。`G2C_AutoAttackState`是每个玩家本人频道上的`latest`可覆盖状态，只表达当前读条，不承载命中事实；命中、道具消耗等不可逆事实必须使用事件广播。技能配置把伤害类型、瞬发/施法方式和是否重置平A分成独立维度；例如压制是Physical + Instant + Keep，不应按“物理技能”或“瞬发技能”分支猜测平A行为。
- 主动怪没有仇恨时只在12米主动索敌范围内寻找最近玩家；被动怪没有仇恨时保持待机。平A和技能都必须经`MonsterComponent.ApplyPlayerDamage`按“1点最终实际伤害=1点仇恨”累计，产生仇恨后两类怪都选择本地图存活玩家中的最高仇恨目标，已有仇恨不能再被12米主动索敌距离过滤，因此30米远程命中也会触发追击。当前Demo未定义脱战回出生点范围，未来必须使用独立冷配置，不能复用主动索敌距离。玩家创建时由`PlayerConfig.initial_hp/max_hp`和`initial_mp/max_mp`初始化四个Numeric；当前演示模板的初始MP与最大MP均为200。Cocos3D、UE、Unity、Godot的玩家HUD只消费进入快照和`G2C_EntityNumeric`增量，显示当前/最大HP与MP。客户端不能根据怪物攻击自行扣血，也不能把HUD数值当作战斗权威。

- 标准Demo的战斗结算已收口到`CombatComponent.ApplyDamage/ApplyHealing`。玩家和怪物都挂载Combat；MonsterComponent只选择目标并提交请求，Item Handler通过ActionExecutor提交治疗或Buff，Combat内部按优先级消耗注册的伤害吸收器后再修改CurrentHp。Buff通过`RegisterDamageAbsorber/RemoveDamageAbsorber`在生命周期边界挂载能力，伤害流程不能反向查询BuffComponent；护盾处理器的数据是唯一运行时剩余量。HP使用Numeric latest，Buff添加/删除、命中/死亡/消耗等事实使用event。详见[战斗伤害与效果管线](../design/combat-damage-pipeline.md)和[Action与Buff设计](../design/action-buff.md)。
- 2026-08-03连续EntityIndex元数据与热点Grid位图完成后，3000人10×10同口径全链路回归的Map CPU平均为51.0%，较前一版55.0%再降约7.3%；Probe p95/p99为47.94/71.78ms，Move 6000/s、跨Grid 309.6/s且全部丢工作指标为0，正式证据在`perf/results/map_capacity_latest.md`。1000人单Grid热点验收得到精确999000条candidate/visible关系，说明混合成员结构不改变可见语义；该热点样本只作专项诊断，不替代正式均匀基线。
- AOI范围与频率全部由Cold配置驱动：`AoiConfig`定义Enter/Detach，`AoiSyncTierConfig`可定义任意数量的奇数范围与同步Hz，Map通过`aoiConfigId`选择配置。当前默认不启用7×7，但停服增加`7×7/1Hz`不需要修改框架代码。最外层同步范围必须等于Detach，TS生成期与Rust运行时都会拒绝未覆盖迟滞圈的配置；外层频率不能高于内层，且Hz必须整除Process逻辑Tick。
- Cell与Grid尺寸也是Cold配置：`MapConfig.cellSizeMeters`定义Cell米制边长，`AoiConfig.gridSizeCells`定义每个Grid每边Cell数。地图物理边界由制作流程决定并记录为`widthCells/depthCells × cellSizeMeters`；Grid数量只由宽深Cell数除以`gridSizeCells`推导，不增加独立`gridCount`。Grid2D必须整除，NavMesh3D在Phase 4.2由资源导出器按相同契约对齐或补边。
- 2026-08-01首轮10×10新行为基线实测跨Grid`310.3/s`、Move`6004/s`、Movement Push约`211.6万/s`，Map CPU平均`82.1%`，Probe p95/p99为`128.49/156.05ms`，零错误、零过载、零背压。该点略高于80% CPU目标，是接近边界的回归基线，不是保守容量点；原始证据固定在`perf/results/map_capacity_20260801_015926.md`，三档空间密度结论以`perf/results/map_capacity_grid_matrix_latest.md`为准。
- 每个MapInstance有独立的隐藏式入图队列：连接和登录完成后，客户端停留在Loading，地图按`MapConfig.entryPlayersPerTick`逐Tick执行AOI Attach，队列上限由`entryQueueCapacity`控制。首次登录和地图传送进入队列；断线重连复用现有Unit，不重复Attach。它只削平单地图Attach与初始Snapshot洪峰，不是区服容量排队，也不替代地图人数上限或负载调度。配置属于Cold，默认Demo为每Tick 1人、最多等待10000人。首次进图、Gate到源Unit的传送调用以及跨MapHost目标Commit统一使用10分钟Admission事务上限，不得继承普通Scene RPC的5秒超时；该上限只是故障兜底，不能当成可接受的Loading时延。
- Admission在一个逻辑Tick内先完成本批次Attach，再准备新Observer的初始实体列表。生产路径不再把这份列表塞入`EnterMap`响应：`EnterMap`返回小型路由、坐标、物品和空间元数据；客户端注册`G2C_AoiDelta` Handler后调用`C2G_MapSnapshotReady`，Gate校验Unit路由，MapHost再通过既有`ClientBroadcast`发送初始`AoiDelta`。`MapComponent`拥有暂存快照，玩家移除和地图销毁时清理，发送失败可重试。`player_entry_snapshot_items_total`仍表示逻辑初始实体条数，`player_entry_snapshot_materialized_items_total`表示实际对象构造数；复用指标用于诊断构造成本。`entryPlayersPerTick`仍是Cold配置，批量参数必须同时观察初始AoiDelta下行队列后再决定生产值。
- 2026-08-01的3000人、16 Gate、单Grid完整进图A/B验证`entryPlayersPerTick=1/4/8/16`均可零错误完成，Map Enter吞吐为`19.97/78.88/131.09/164.39人/s`；广播pending峰值为`7/56/136/272`，Location确认平均耗时为`7.17/29.62/127.75/284.46ms`。这说明初始视野解耦修复了原大RPC溢出，也说明批量越大并非无代价。当前正式Cold值仍为`1`，`4`只是下一轮长窗口候选；短窗口CPU样本不足，不得据此形成容量结论。
- 进图链路以低基数指标拆分MapHost全链路、ID分配、Player创建、Location注册/确认、MapReady、Admission等待、AOI Attach、新玩家Snapshot和老玩家AOI Delta；对象条数与真实Transport字节分开统计，禁止为了观测在TS重复编码protobuf。`perf:map-entry-stages`通过Bench专用`entrySyncMode`运行Attach Only、新玩家快照、老玩家Enter和Full四组A/B；普通`C2G_EnterMap`永远使用Full，前三种残缺模式不得进入生产配置或业务代码。
- Rust AOI前的权威Entity Store迁移已完成：generation handle目录只做定位与世代校验，`.native`生成Unit/Item类型池及Unit冷热布局；TS只持有生成NativeRef。Rust池容量、活跃实体、TS NativeRef和帧尾scratch扩容已进入Prometheus。迁移保留既有Native op语义；类型分池、冷热布局的微基准与地图容量报告仍须分开解释，不能把任一结果直接换算为生产服务器容量。
- Numeric权威值统一为Rust`i64`、protobuf`int64`和TS`bigint`。普通属性编号为1..999；1000..9999为只读派生结果；`result*10+1/+2/+3`为Base/Add/Pct来源。Rust按编号约定原子重算，不维护MaxHp等TS业务常量；复杂跨属性公式必须使用显式领域op。
- `npm run perf:numeric`是Numeric派生计算的纯Rust微基准，分开报告普通写、单来源重算、三次独立来源写和一次批量重算上限；结果不包含V8、protobuf、AOI或Socket，不能直接换算整服容量。
- Map级同步策略共存：普通大世界使用状态同步，竞技场等独立Map可使用帧同步，高精度场景可使用高频状态同步。同步模式由Map创建配置和对应Component决定，不是Process或Runtime的全局选项；逻辑Tick、网络同步频率和客户端渲染频率必须解耦。该项排在普通状态同步与Rust AOI之后。
- 怪物Actor、巡逻、仇恨和战斗。
- Online/Presence等面向在线状态的业务索引；Location Actor路由基础已完成。
- Guild、Friend、Chat等EntryScene与Component业务域。

Phase 5计划：

- 现有 Prometheus/Grafana 的生产化（Alertmanager、机器 Exporter、权限、长期存储）和分布式追踪。
- 生产级服务发现、Inner身份认证、崩溃恢复和滚动更新。
- KCP弱网/长稳与io_uring进一步优化。
- 在Rust AOI和首版真实怪物、战斗、Buff、任务及持久化负载完成后建设容量规划。容量工具按负载模型自动爬升和复测，以CPU、实际吞吐、p95/p99、队列趋势、错误与安全余量共同给出Map推荐容量、准入上限、Gate及Process部署建议；在此之前不得把`perf:gate`或`perf:map-capacity`结果转换为生产在线人数。

当前语言策略：

- TypeScript是唯一主业务脚本语言。
- Rust负责Runtime、权威数据和经过指标证明的性能热点。
- Wasm以后可用于确定性、粗粒度重计算模块，例如Rust编写的战斗核心；当前不接入。
- Rhai以后可以作为脚本后端候选，但要等异步、调试、类型工具和大型工程能力满足要求；当前不接入，也不提前增加兼容抽象。
- 不同时维护TS、Rhai和Wasm三套主业务模型。

## 对后续AI的工作要求

1. 接业务需求先阅读[AI业务开发手册](business-development-manual.md)、最接近的`app/model/mmorpg`状态定义和`app/hotfix/mmorpg`行为实现。
2. 不把阶段历史文档中的旧Service/V8模型恢复到当前设计。
3. 不因为性能猜测下沉Rust，先建立业务路径和指标；用户明确要求实验时再做最小A/B。
4. 不在收到Unit消息后通过账号、地图遍历或全局Manager再次定位Unit。
5. 不把不可覆盖Event塞进latest状态通道。
6. 不把AOI收件人选择写进BroadcastHub；AOI拥有Audience。通用路径由Core排队、编码和投递，Movement专用Rust热路径可在AOI内部把Audience直接投影为Gate route frame，但业务层不能看到或管理routeId。
7. 不为未来Wasm/Rhai设计当前用不到的多语言抽象。
8. 修改架构事实、目录所有权、协议语义或Phase状态时，同步更新本文、`README.md`和`docs/roadmap.md`。
9. Actor只表示Scene、Session、ActorUnit拥有的mailbox与路由能力；普通Unit没有mailbox。不要为普通业务身份新增泛化`XxxActor`，也不要给每只怪物机械增加`@actor`。
10. 新业务状态写Model，生命周期和行为写`@systemFor`；不要恢复Model方法空壳，也不要在每次方法调用前查System Registry。
11. Component拥有的子对象只能由所属Component维护集合和业务修改；不要从Handler直接操作Native Ref，也不要把每条Quest或Achievement机械地做成Entity。
12. TiangZ主工程及配套VS Code插件仓库的提交标题默认使用中文；代码标识、命令、版本号和专有名词可保留原文。
13. 外网演示使用`configs/deploy/external-multiprocess/StartMachine.json`和Cocos3D资源配置；8个TiangZ Process共享`known-scenes.json`。Cocos3D编辑器预览通过`PREVIEW`自动读取`assets/resources/Config/tiangz-local.json`连接本机`127.0.0.1:7000`；非预览发布包读取`tiangz-external.json`连接公网LoginMgr，不能把两种环境地址手工混用。外网Cocos3D发布使用`npm run build:cocos3d:external`：`build/external/desktop`只部署到根路径`/`，`build/external/m`只部署到`/m/`，后者是唯一横屏移动入口；构建脚本会在页面顶部注入`版本、UTC构建时间和Git短提交号`，Nginx对Demo资源发送`no-cache, must-revalidate`，排查时先核对页面Build标识。两个DBProxy对等实例分别监听`7800/7801`并共享Redis/PostgreSQL，TiangZ所有Process按首选/故障切换顺序连接。当用户说“部署到外网测试机”时，必须重新构建前端和后端并确认上传的是本次最新产物；远端直接停止旧服务、覆盖固定发布目录、重新启动并做冒烟。该主机只是Demo测试机，不使用`.next`、蓝绿目录、目录交换或自动回滚。凭据只存在运行环境，不能写入仓库。
14. 外网发布只上传Linux Release发布包，不上传`src`、Cargo工程、`node_modules`或`target`。Runtime优先从当前发布目录或可执行文件邻级目录寻找`dist`与`configs`，不能依赖编译机的`CARGO_MANIFEST_DIR`。
15. Linux正式发布统一使用`npm run release:linux`和固定镜像`tiangz-linux-builder:ubuntu-24.04`。镜像是工具/依赖底座，不含业务源码；普通TS、Rust、Excel变化只复制源码并完整运行Luban、codegen与Release编译。只有依赖锁、Rust工具链、Luban或Builder定义变化才重建镜像，Linux Cargo中间产物由`tiangz-linux-builder-target`命名卷复用。

16. 当前主工程、`tiangz-developer-tools`、`tiangz-native-language`和独立`TiangZ-DBProxy`都处于开发阶段：日常允许版本副本、Cargo/npm依赖和协议原型迭代，不要求强制使用`npm ci`、Cargo `--locked`或同步更新发布锁文件。开发CI可运行`npm run verify:locks:warn`报告漂移但不阻塞；准备正式Release时，主工程统一执行`npm run verify:release`；插件和DBProxy由各自仓库执行发布前的锁文件、版本、协议指纹和完整测试审查。不要把开发门禁误写成发布承诺。

## 新AI建议阅读顺序

1. 根目录`AGENTS.md`。
2. 本文。
3. [AI业务开发手册](business-development-manual.md)。
4. [架构与快速启动](../tutorials/01-architecture-and-quickstart.md)。
5. 与任务相关的教程、reference和现有Demo代码。
6. 只有维护Runtime时才阅读[运行时维护者指南](../design/maintainer-guide.md)和`src`。

## 最新效果系统校准

Phase 4.4现在已经包含Action/Buff、Luban SkillConfig/SkillEffectConfig、七技能Cast和3006/3007持续效果闭环；后文“Buff、Cast或技能表尚未开始”的历史描述均以本节、[Action与Buff设计](../design/action-buff.md)和[技能系统设计](../design/skill-system.md)为准。开发人员应先组合现有Action、Buff策略和SkillEffect，不要为每个技能新写Handler，也不要把Buff效果反向塞进Combat入口。3006恢复是瞬发AddBuff，8次治疗由Buff Tick负责；3007精神鞭笞由服务端10Hz推进，移动取消；只有Combat确认没有护盾吸收的受击才将结束时间提前800毫秒，真言术·盾吸收的攻击不缩短引导；Cocos3D连线只是本地表现。

## C# Client SDK与Unity边界

Unity客户端沿用和Cocos、Pixi相同的协议语义，但不把Unity类型带进公共SDK。C# SDK的唯一源码目录是`client_sdk/csharp/`，协议生成命令是`npm run codegen:csharp-client-sdk`；生成器从协议锁读取消息和opcode，生成C#消息、Codec、RPC/Push描述符和类型化Client，再复制到`client_demo/Unity2022.3.62f3c1_demo/Assets/TiangZClient/Runtime`。Unity目录中的`Runtime/Generated`和其他生成C#文件不能手工编辑，业务只改`Assets/TiangZClient/Demo`或自己的表现层目录。

`RpcSocket`的网络线程只接收完整帧并放入有界队列，Unity主线程在`Update()`调用`RpcSocket.Update()`后才执行Push Handler和完成RPC；超时、断线、未知消息和队列溢出都有明确结果。业务不得在接收线程直接修改Unity对象，也不得绕过Client手写msgcode、rpcId或Codec。当前C# Adapter只支持桌面WebSocket，选择TCP/KCP必须立即报不支持，不能静默切换到WebSocket。

Unity表现层使用`Vector3`、Transform和Camera，协议及服务端仍使用米制`x/y/z/yaw`：X/Z是地面平面，Y是高度，Yaw是绕Y轴弧度。坐标转换只允许出现在表现边界；不要把`Vector3`写入协议、Model或Native数据。Unity Demo的标准调用顺序是：`LoginFlow.EnterGameAsync`登录进图，注册Push，再调用`GateClient.MapSnapshotReadyAsync`请求初始AOI；运行期间每帧调用`LoginFlow.Update`，输入只调用生成的`MapClient.NavigateInputAsync/NavigateToAsync`。

## 道具出生数据与Cocos3D快捷栏

当前出生物品：新角色首次创建时获得`1001×3`小红和`1003×3`小蓝；读档、重连和跨地图不重复发放。快捷栏药品槽按配置ID引用`1001/1003`。

新角色出生时由`MapComponent`显式发放`1001×3`小红和`1003×3`小蓝；只有没有持久化快照且不是迁移目标的真正新角色可以走这条发放路径。读档、断线重连和跨地图传送都只以`ItemSnapshot`恢复，不会重复发放；`ItemComponentSystem.Awake`只负责生命周期。Starter任务奖励仍由任务事务单独追加。1001和1003各有30秒配置CD，并与技能共享1秒玩家GCD；服务端原子提交deadline，跨地图快照保留，客户端只绘制返回时间。道具使用RPC成功时，`M2C_UseItem.buff`会回显本次新增的公开Buff给使用者；AOI仍通过`G2C_BuffAdded`给其他观察者广播，客户端两条路径按实例ID幂等合并。

`ItemConfig.icon`是客户端字段，值是相对Cocos `assets/resources`且不含扩展名的资源键，例如`UI/Icons/Items/1001`。Cocos3D Web快捷栏固定为`1=平A`、`2=1001`、`3=1003`，初始数量来自`G2C_EnterMap.items`，使用和拾取后的数量来自不可覆盖的`G2C_ItemChanged`；拾取RPC只返回受影响的`items`，客户端按`ItemSnapshot.version`合并RPC与Push，不能把整包背包放进每次拾取回包。打开NPC商店时，`M2C_OpenNpcShop.inventory`会返回一次只对当前玩家可见的权威背包快照，用来校正拾取推送延迟或丢失造成的本地投影；商店本身仍由服务端重新校验出售资格。客户端不得在按键时先行扣数量。快捷栏槽位只绑定`ItemConfigId`，数量归零时服务端删除背包中的`Item`子实体，客户端移除该`ItemId`快照但保留快捷栏槽并显示`×0`；之后拾取或奖励同配置道具时，即使生成了新的`ItemId`，槽位也会按配置ID重新汇总并恢复可用。以后增加快捷栏时继续按`configId -> ItemConfig -> icon`解析，不能把道具图片路径硬编码到表现脚本。

Cocos3D还提供完整背包面板：桌面端点击“背包”或按`B`，移动端点击“包”按钮；面板按`ItemSnapshot.itemId`展示所有有库存的道具，名称、说明和图标来自客户端冷配置，使用按钮统一调用现有`MapClient.useItem`。面板只刷新服务端快照，不维护第二份库存；数量为0时等待`ItemSnapshot`后移除，触摸事件由HUD消费，不能穿透成地面寻路。Cocos Creator 3.8.8 Web不得对`Map/Set`的`values/keys/entries`结果使用展开语法，必须用`Array.from(...)`物化，并由`typecheck:cocos3d-demo`门禁；验收时还要检查编译后的JS。其他客户端可以采用自己的背包UI，但必须保留同样的服务端权威和`operationId`边界。

运行期间如果客户端带着过期ItemId或数量请求使用、购买或出售道具，服务端可以在业务错误响应里附带可选`inventory_recovery`。客户端先用其中的`InventorySnapshot.items`整体替换本地背包，再显示原错误；包装存在但items为空也必须清空本地旧数据。正常成功响应仍只返回受影响Item增量，不能把错误修复机制变成每次操作的全量广播。

Cocos3D玩家Unit保持“中心点实体根节点 + 可替换Visual子树”的边界。当前`BlueChibi.glb`由Blender脚本生成，导入后是包含`Idle/Walk`的骨骼Prefab；`PlayerCharacterVisual3D`只消费是否移动的表现状态，并将脚底原点相对实体中心下移0.9米。动画、模型和方块加载占位都不得修改Unit坐标、碰撞、AOI或权威Yaw。生成命令是`npm run asset:cocos3d:blue-chibi`，攻击动画仍属后续表现工作。

Cocos3D桌面输入区分角色朝向与本地观察：右键拖动继续同时修改`playerYaw/cameraYaw`并上报朝向，左键拖动只修改`cameraYawOffset`，不得写协议或权威状态。左键按下到抬起超过5像素视为环绕手势并吞掉寻路；未超过阈值仍按短点击处理怪物选择或地面寻路。

Cocos3D的本地Buff栏从`MapEntitySnapshot.buffs`、`M2C_UseItem.buff`和`G2C_BuffAdded`建立图标，资源键固定为`UI/Icons/Buff/<BuffId>`，例如Buff 2001使用`UI/Icons/Buff/2001`；界面文字读取客户端`BuffConfig.name`显示中文名，不展示BuffId。剩余时间使用最近一次Gate Ping得到的服务器时钟偏差计算，显示为`分钟:秒`，两小时显示`120:00`；无限时长显示`永久`。本地倒计时到`00:00`只冻结文字和保留图标，必须等`G2C_BuffRemoved`才删除，不能用客户端本地计时器提前清理Buff。

## 外网持久化部署校准

当前`external-multiprocess`的8份Process配置都显式使用同机DBProxy首选地址`127.0.0.1:7800`和故障切换地址`127.0.0.1:7801`。客户端按RecordKey稳定选择地址，只有连接不可用才切换，并保留原`requestId/operationId`；Revision冲突、业务拒绝、鉴权失败和协议错误直接返回。两个DBProxy实例共享同一套云Redis/PostgreSQL，不做实例间Leader、复制或内部RPC。DBProxy下的Redis和PostgreSQL只绑定回环地址，外网安全组不开放`5432`和`6379`。Ubuntu部署机用Docker Compose启动两个存储容器，DBProxy作为独立systemd服务运行，认证令牌只由systemd环境文件注入。只启动Redis/PostgreSQL而不启动两个DBProxy，或者只启动DBProxy而不在所有Process配置中声明`persistence.dbProxy`，都不算完成持久化接入。

## Unity、UE、Godot客户端收口

Cocos3D是业务表现参考，但不是唯一客户端实现。Unity C#、UE C++、Godot GDScript已经接入同一组生成协议：技能请求和读条/CD、Buff增删与详情、任务进度/接取/交付、怪物Numeric/Alive/死亡表现。三套客户端可以使用不同的HUD、节点和弹道样式，但都必须遵守“服务端结算，客户端表现”的边界。Unity使用`LoginFlow`，UE使用`FTiangZLoginFlow::SetFeatureCallbacks`，Godot使用`TiangZClient`信号；生成协议、msgcode和Codec禁止在客户端手工复制。

## 任务掉落与尸体拾取

Starter的掉落链是`MonsterConfig.drop_table_id -> DropTableConfig -> LootContainer -> C2M_LootMonster`。`quest_objective_id=0`表示归属于首个造成有效伤害账号的普通一次性掉落，非零表示按账号筛选的任务掉落；玩家必须先接取匹配的`CollectItem`任务，剩余数量为0时任务行继续留在尸体上，不会再生成Item。拾取在PlayerUnit有序mailbox中完成距离、归属、资格、数量和operationId检查，Inventory/Quest先生成纯数据计划，DBProxy确认后才提交Entity和私有结果。当前1101是静态任务道具，动态ItemInstance必须保存实例数据，不能套用“尸体只保存配置ID、拾取时生成ItemId”的快捷路径。完整规则见`docs/design/loot-and-task-items.md`。

## 框架热路径分配边界

TiangZ不承诺“关闭V8 GC”或绝对0 GC；可执行的目标是稳态下框架热路径的重复堆分配趋近于零，并用指标确认优化是否有效。Promise、protobuf解码对象、跨分片帧副本和业务临时对象仍可能存在，不能把“少分配”误写成“不会回收”。

- 有返回值的RPC仍保留Promise，因为调用方必须等待结果；ordered mailbox忙时的RPC队列节点会从回收池复用。
- 单向Message使用`runActorMailboxVoid`和Scene的单向mailbox路径。ordered mailbox忙时只排队回调节点，不创建完成Promise；Handler如果自身返回Promise，框架仍等待它来保持顺序并记录异常。
- `SceneMessageHelper.send/sendActor/sendFrame`返回`MaybePromise<void>`：本地同步mailbox和远程入队的常见路径返回`void`，只有底层实现确实异步时才返回Promise。`await send()`仍然合法，但只代表消息已被接受或入队，不代表目标Handler执行完成；需要结果必须使用RPC。
- 长度前缀协议流提供`LengthPrefixedFrameDecoder.pushEach`。完整帧在一个输入分片内时直接返回视图，跨分片时才复制；回调必须同步消费帧，不能把视图当成可长期持有的快照。
- `BroadcastHub.PublishEncodedLatestSnapshot`保留单批次专用路径，不为单批次创建包装数组；多批次只有在确实存在空受众时才创建过滤数组。latest仍然覆盖同频道旧状态，event仍然保留逐条语义。
- Scene和Actor都会暴露mailbox快路径、排队、异步、单向消息、当前深度和峰值指标；Scene指标保留`scene`标签，Actor指标是整个Process内所有Actor的唯一汇总，不能按Scene重复相加。Rust Host把两类指标分别导出到日志与Prometheus。观察到队列增长后再定位业务Handler、网络或广播，不凭GC猜原因。
- 这不是对业务代码一刀切禁止`map/filter/spread`。只有经过基准或火焰图确认的热路径，才按现有容器、批处理、复用节点和配置索引做局部优化；普通业务优先保持可读性。
- 低分配改动在压测前先执行`npm run perf:hotpath:prepare`。该命令构建Bench、完整链路客户端和Release Runtime，执行codegen、注释与Hotfix边界门禁，检查产物哈希和测试端口，但不会启动服务器或创建玩家。
- A/B结果使用`perf/full_chain/run_full_chain_perf.mjs`的同一负载参数，并用`npm run perf:hotpath:compare -- --before <before.json> --after <after.json>`按玩家数和业务场景对齐比较。比较器要求参数、案例集合和轮数完全一致，资源与Mailbox字段缺失时直接判无效；`stalled`、Probe错误、业务传输错误、背压、Inner超载和Inner超时必须为零。结论必须同时看吞吐、p50/p95/p99、CPU、RSS、V8 GC、Rust/Transport队列和Mailbox排队；单看GC或单个进程CPU不能判定收益。

## 尸体掉落交互

尸体掉落采用“查看”和“领取”两步语义。客户端先调用`C2M_InspectLootMonster`，服务端按当前账号的普通掉落归属和任务资格返回可领取的`LootDropSnapshot`，查看不会预留掉落、创建ItemId或写数据库。真正领取调用`C2M_LootMonster`：普通点击携带`drop_id`且`loot_all=false`，Shift、右键、F键或移动端“全部拾取”按钮携带`loot_all=true`。

Cocos3D的尸体窗口必须持续显示掉落行和领取结果，领取后使用回执的`remaining_drops`刷新列表，直到玩家主动关闭；不能只用一条短暂状态消息表示拾取结果。服务端仍以`operationId`、距离、任务资格和DBProxy事务为准，客户端不得本地扣除尸体或背包。

尸体生命周期与重生生命周期分开：有掉落的尸体保留5分钟，无掉落的尸体保留10秒；归属账号领取完普通掉落后可以立即发送AOI Leave。`MonsterConfig.respawn_seconds`从死亡时刻计时，实际新怪物生成取尸体窗口结束与最短重生时刻两者较晚值。任务掉落按账号保留，不能因为一个玩家领取完成就提前删除尸体。AOI Leave到达客户端后必须关闭掉落窗口并放弃旧UnitId。

## Starter金币、掉落与NPC商店

当前Starter的普通掉落表1按每行独立概率判定：破旧布料1201为80%、小型生命药水1001为15%、大型生命药水1002为5%；三行可以同时掉落，也可以全部未命中。任务掉落行仍按每个账号的任务资格独立判断。ItemConfig的出售价格为布料10、小红20、大红50铜币。Map 100的9002杂货商只出售小红和小型法力药水，商品和价格由服务端返回，客户端不能上传价格或自行改金币。

`CurrencyComponent`只拥有非负`bigint`铜币余额，`NpcShopComponent`负责NPC、距离、商品和交易编排，`ItemComponent`负责背包Item；购买和出售都在PlayerUnit ordered mailbox中生成Inventory/Currency计划，再通过DBProxy事务提交，成功后才应用内存状态。网络重试必须复用`operationId`，不能把购买或出售拆成两个客户端请求。快捷栏仍引用ItemConfigId，背包Item数量归零不删除快捷栏槽位，只显示0。

## 战斗状态与法力恢复

技能费用当前由Hotfix的`SkillManaCost.ts`维护，技能请求通过法力校验后立即扣除；法力不足不会创建ActiveCast。`CombatStateComponent`按“有效怪物仇恨来源集合”维护战斗状态：怪物死亡、回归出生点或清除仇恨时移除来源，来源为空才脱战。战斗状态不恢复MP；脱战后按180秒从当前MP恢复到MaxMp，固定更新桶用整数余数累计避免漂移。该组件是临时地图运行态，传送时清空，不进入持久化快照。设计细节见[`docs/design/currency-and-npc-shop.md`](../design/currency-and-npc-shop.md)。
