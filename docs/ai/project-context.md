# TiangZ AI 项目上下文

本文把长期对话中形成的架构世界观、关键决策、当前状态和暂缓事项固化到仓库中，帮助新的开发者或AI在缺少聊天记录时继续工作。它不是代码的替代品；如果本文与当前代码或测试冲突，以代码和测试为准，并在同一改动中修正文档。

维护契约：任何架构、目录边界、数据所有权、协议语义或业务开发流程的设计变更，都必须同时更新本文和[AI业务开发手册](business-development-manual.md)。设计改动未同步这两份文档，视为尚未完成。

更新时间：2026-07-30。

## 一句话定位

TiangZ是一套正在验证中的MMORPG服务端框架：Rust/Tokio提供网络和宿主能力，一个操作系统进程创建一个V8，TypeScript在单业务线程中承载多个Scene、Actor和Component；高频跨帧Entity数据可以下沉到Rust，TS通过生成句柄操作。

当前版本是`0.4.0`，`v0.3.10`是框架能力的首个稳定基线。Phase 0到Phase 3.10.5的实现、专项验收以及Windows/Linux最终发布矩阵已经完成；Phase 4.0空间契约和Phase 4.1 Rust AOI功能链也已完成。工程已有登录、选服、进入地图、多人移动、状态广播、WebSocket/Cocos Web、KCP/Cocos Native和Pixi/H5验收链路，并完成Windows 3000玩家AOI正式容量回归；尚未完成NavMesh3D运行时、Linux/分布式空间负载、完整商业MMORPG业务和生产运维方案。

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
              -> UnitComponent（地图Unit集合）
                  -> Unit（玩家、怪物、NPC）
                      -> Component（Numeric、Item、Buff等状态与能力）
                          -> ChildEntity（Item、Buff、动态Quest等本地子实例）
```

## 核心名词

### Process

Process是操作系统进程、V8、TS线程、Inspector和故障隔离边界。一个配置文件描述一个Process，一个Process可以创建多个EntryScene。它不等于业务功能，也不等于旧Skynet语义中的一个Service。

### EntryScene

EntryScene是可配置、可寻址的顶层业务边界，例如`LoginMgr`、`Login`、`Gate`和`MapHost`。未来的`Social`可以作为一个EntryScene，再挂载`GuildComponent`和`FriendComponent`。

### Scene

普通Scene是Process内动态创建的业务容器。一个MapHost可以创建多个MapScene，让低负载地图共享同一线程；扩容时再增加MapHost Process或EntryScene实例。静态地图与动态副本都由MapHost的同一个`CreateMap({ mapConfigId, mapInstanceId, dynamic })`创建，不为每个副本启动V8。静态地图在所属MapHost的`staticMapIds`启动配置中声明，实例号恒等于配置号；动态地图由Demo业务`DynamicMapManagerComponent`分配全局实例号。Location的MapInstance目录只保存`instance -> MapHost/config`路由，MapHost周期重报可恢复目录。

### Actor、Scene、Session、Unit与Mailbox

Actor是运行时路由概念，不是要求业务继承并随意创建的第四种实体。Scene、Session、Unit拥有`MailBoxComponent`后都是Actor消息目标：Scene表示业务边界，Session表示网络连接，Unit表示玩家、怪物、NPC。业务代码直接选择这三种明确类型，不创建`LoginActor`之类只为获得mailbox而存在的包装类。

- `Id/UnitId`是业务身份。
- `InstanceId`是本次生命周期地址，Entity重建后旧值失效。
- Session和Unit消息根据InstanceId在EntityRoot中O(1)定位。
- `ordered`保证同一mailbox的消息跨越`await`仍然串行。
- `unordered`允许异步调用重叠，但所有CPU代码仍在同一TS线程执行。

这解决了Skynet协程在`call`让出时可能处理后续消息而造成逻辑重入的问题。Session和Unit默认使用ordered mailbox。Login/Gate入口Scene使用unordered，使不同连接可以并行；同一连接跨`await`仍由Session串行。账号级并发不是连接级并发，只有真实账号业务需要时才使用账号Location或领域锁，不能用永久`LoginActor`伪装账号状态。

Gate连接状态分成两层：`GateSession`只代表一次物理连接，断开即销毁；`GatePlayerRoute`按账号保存`UnitId -> MapHost/Map/ActorInstanceId`和当前`connectionId`，在30秒重连宽限期内继续存在。客户端每5秒发送单向`C2G_Ping`，但Gate收到任意客户端帧都会刷新`lastReceiveTime`；出站排队只更新`lastSendTime`，绝不能延长存活期限。Ping由Gate的同步控制帧入口在Session mailbox之前消费，不创建Handler Promise，保证长时间Loading/EnterMap期间仍能续期；其他客户端业务帧不得借此绕过Handler和mailbox。Gate使用一个1秒合并扫描器检查全部Route，不为每名玩家创建Timer。

同账号新连接会在Gate内原子替换旧`connectionId`。旧socket迟到的disconnect只销毁旧Session，不能清理新连接或Map Unit。重连后Gate以现有Actor路由调用`SecondEnterMap`，Map只清除旧移动意图并返回权威全量快照，不创建Unit、不重新广播AOI进入、不改绑Gate。宽限期结束后Gate才调用`PlayerOffline`；Map完成保存、Unit移除和AOI离开广播后响应，Gate最后删除Route。Map不拥有断线Timer，也不保存`gateSessionId`。

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

ChildEntity拥有稳定`Id/InstanceId`并进入EntityRoot，但没有mailbox、网络地址和跨Process路由能力。它的Parent是所属Component，DomainScene仍是玩家所在地图。其Awake必须同步；Component删除或玩家下线时，Core按所有权链自动取消Timer、销毁子Entity并移除Root。

领域边界采用“可以读取对象，集合变化经过拥有它的Component”：单个Item/Buff的局部规则写在自身Hotfix System，新增、删除、转移、堆叠合并和对外同步由所属Component协调。Native可变句柄只在对应System内部使用，不得跨`await`或所有者生命周期长期保存。

Buff需要被AOI玩家看到，不代表Buff需要mailbox，也不需要通用dirty Delta。Buff创建/删除分别使用不可覆盖的`BuffAdded/BuffRemoved`事件；进入AOI时公开Buff随Unit整体Snapshot发送，离开只移除Unit。公开`BuffPublicView`与受限`BuffDetailView`是两套Projection：前者发给AOI观察者与队伍，后者只发给自己与队伍，不能用字段值`0`表达无权限。详情以`(unitId,buffInstanceId)`为latest key，同帧可覆盖。业务只组合逻辑`ClientAudience`，`ClientBroadcast`负责UnitId到Gate及跨地图Location解析。Buff Tick只执行Action，不同步Buff本身：Numeric、Move及其他效果走各自领域协议。少量Buff可使用ChildEntity Timer；大量Buff应由BuffComponent使用到期时间堆和一个最近到期Timer合并调度。

Quest默认是玩家私有状态。接受任务时创建Quest子Entity，进度变化默认只通知拥有者客户端；只有任务规则明确要求共享时，才向`PartyAudience`发送队友所需的进度摘要。完成任务时，QuestComponent在一个领域操作中结算奖励、记录已完成配置ID、RemoveChild并发送完成通知。登录或重连时向本人发送活动Quest与已完成摘要的全量快照；队友进入AOI时，可在Unit整体Snapshot中携带允许共享的任务摘要，普通观察者不包含Quest数据；离开AOI时仍只移除Unit。

### 领域设计规则与开发助手

业务系统设计先查[`docs/patterns`](../patterns/README.md)。其中用稳定规则编号描述所有权、Entity形态、Audience、状态复制、生命周期、Timer和数据位置；这些文档是人类可读的设计依据，不是自动生成的业务代码。

TiangZ Developer Tools `v0.15.0`把可机械判断的部分固化到不依赖VS Code的共享核心，并向上提供设计向导、`@tiangz`聊天解释、`tiangz-design` CLI、只读`tiangz-design-mcp`和Runtime Foundation诊断。相同结构化输入必须得到相同确定性结论；AI模型只在用户主动聊天时解释报告，不能改变规则结论、虚构API，或把普通业务引向Core、Rust Runtime和Generated。主工程固定依赖该Tag，`verify:design-rules`要求design-core与`docs/patterns`规则ID集合、归属文档和文件路径完全一致。

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
- `FrameTime`是不可持久化单调时间；活动时间和跨重启截止时间使用`ServerNow`及deadline helper。
- `Scene.Locks`提供`Scene InstanceId + domain + key`的本Process FIFO协程锁，不是分布式锁；跨Process先路由到唯一所有者。
- Developer Tools会检查StartMachine实际部署集合中的`process.identity`、Timer方法名与取消回调、Scene Event同步/异步契约，以及`InstanceId/TimerId`误入持久化结构；这些规则与Runtime Foundation自测共同守住业务侧用法。
- `Scene.Events`只发布当前Scene的同步/异步Event；跨Scene必须使用Message/RPC。

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

Numeric使用`NumericType -> i32`动态字典和dirty表；Unit固定字段使用`.native @replicated + @memberId`生成`u64` dirty mask；Item变更演示不可覆盖的即时Event。

帧尾复制采用`Peek -> Send -> Ack`：只有发送成功才确认revision，发送失败保留Dirty，发送期间的新修改不会被旧Ack清除。Audience只决定收件人，数据Projection决定字段权限，Broadcast descriptor只决定event/latest语义。业务使用只含UnitId的`ClientAudience`；物理`BroadcastAudience`和Gate route是Core内部类型。

AOI已由Rust稀疏X/Z Grid接管。Cell是移动和空间数据的基础单位，AOI关系只在跨Grid边界时重算；默认一个Grid为15×15 Cell。默认可见关系从实体所在Grid即时推导，不常驻保存候选边或全量可见边；Rust只保存迟滞关系、业务过滤拒绝项、本帧净变化和用于共享编码的增量Audience签名，TS不得建立镜像关系表。密集迟滞Audience按`Grid + 最终受众签名 + 强制发送状态`共享一次受众计算，再按实际受众合并编码；业务不得依赖签名或管理该缓存。Prometheus提供当前迟滞与拒绝关系Gauge。`single-grid`是稳定全可见广播基线，`same-point`是高频跨Grid迟滞压力测试，两者不能混为容量曲线。

Rust按最终Audience编码Movement、Numeric和UnitState。通用路径由`BroadcastHub`把Encoded batch交给Transport，并由`SceneBroadcastTransport`在同步Game Tick内按Gate重组；Movement高频路径进一步由Rust利用Attach时登记的紧凑delivery route直接生成每个Gate的完整`S2G_ClientBroadcastBatch`帧，TS每Tick只映射至多Gate数量的routeId并原样投递，不展开recipient数组，也不重复编码内网protobuf。Gate不解码业务payload，只完成Unit到connection的路由与下行扇出。Numeric、UnitState和即时Event继续使用通用路径。业务层不得管理routeId、调用底层route-frame Native op、调用`sendFrame`，也不得直接构造内网广播协议。

## 地图空间契约

`0.4.0`冻结服务端地图局部坐标为米制`X/Y/Z + Yaw`：X/Z是地面平面，Y是高度，Yaw是绕Y轴弧度。坐标必须和`MapInstanceId`一起解释，不建立跨大陆的巨大浮点世界坐标。protobuf与Native schema使用普通`float/f32`，客户端适配层再转换为Cocos `Vec3`、Unity `Vector3/float3`或二维屏幕坐标。

`MapConfig.SpatialMode`区分`Grid2D`与`NavMesh3D`。Grid2D已经运行在X/Z Cell上；NavMesh3D目前只冻结资源、版本、哈希及生命周期契约，Runtime遇到该模式会明确拒绝，不能静默退化。只读导航资产未来按MapConfig版本共享，每个MapInstance仍独占AOI、动态障碍和Unit空间状态；Scene销毁必须幂等释放实例空间。完整约束见[地图空间与3D坐标契约](../design/spatial-world.md)。

## 客户端与Transport

`client_sdk/typescript`是TypeScript Client SDK唯一源码，codegen将正式协议副本分发给Cocos和Pixi；Bench协议只保留在规范SDK供工具使用。SDK Core与引擎无关，平台通过Transport Adapter接入。

当前验收范围：

- Cocos Web：WebSocket。
- PixiJS/H5：WebSocket。
- Cocos Native Windows：TCP/KCP。

服务端将I/O Backend和Endpoint协议分成两个维度：epoll/io_uring负责操作系统I/O，TCP/WebSocket/KCP负责传输协议。不支持的平台选择KCP等Transport时应立即报错，不能静默降级。

客户端RPC使用生成的`LoginMgrClient/LoginClient/GateClient/MapClient`。服务端Push使用独立`@clientMessageHandler`，避免把所有监听堆在一个构造函数中。网络回调只入队，客户端游戏循环调用SDK的`update()`进行分发。

## 目录所有权

```text
app/core/                    TypeScript框架
app/core/public.ts           业务唯一Stable Core API入口
app/model/                   不可热更的状态、稳定类型与启动结构
app/model/demo/              当前MMORPG演示的稳定类型和状态
app/model/bench/             仅由build:bench装配的稳定基准结构
app/model/public.ts          Hotfix唯一允许导入的Model入口
app/hotfix/                  可热更的Handler和领域方法实现
app/hotfix/demo/             当前MMORPG演示的可热更行为
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
cocos_client2D/.../Demo/     Cocos业务和表现
cocos_client2D/.../Generated 自动分发SDK和Handler入口
cocos_client3D/              Phase 4.3的Cocos Creator 3D客户端；Generated/SDK由公共TS SDK自动分发，业务仍未开始
pixi_client/src/             Pixi业务及SDK验收
configs/<environment>/       环境、Process与Scene正式部署配置
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

`.native`是codegen输入而不是生成物。框架通用ABI只放`native_data/core`；游戏新增Rust批处理能力时在`native_data/<game>/XxxOps.native`声明，生成器聚合产生Rust Extension、Host bootstrap和TS `NativeOps`。状态机黄金数据属于`tests/fixtures`，禁止混入原型目录。

正常`npm run build`装配Demo的Model与Hotfix双Bundle；压测入口必须使用`npm run build:bench`显式加入`app/model/bench`和`app/hotfix/bench`。服务端`app/generated`不再生成客户端协议副本，工具和性能测试统一从`client_sdk/typescript/Generated`导入。

Bench Hotfix可以通过`#tiangz/model`调用稳定业务API来测量生产路径，普通Demo不得反向依赖Bench。`app/model/main*.ts`与`app/hotfix/main*.ts`分别是两层组合入口；根`app/main*.ts`只保留源码兼容入口。Developer Tools与`tiangz-check-project`共同强制依赖方向。

Actor Runtime只保留Scene、Session、Unit的生命周期、InstanceId与mailbox。旧式`@handler("字符串")`、动态组件Handler hooks和`ProcessHost.call/send`已移除；业务入口只能使用生成descriptor绑定的Scene/Session/Unit类型化Handler。

测试和压测专用的裸帧构造、响应解码、Fake与Fixture必须放在`tools/support`、`perf`或对应测试文件中，禁止放入`app/core`或`app/<game>`。正式客户端能力只能进入`client_sdk`及其Generated分发目录。

Model代码只能从`app/core/public.ts`导入Core能力；Hotfix只能从`#tiangz/model`取得Model与Stable Core API，不得深层导入。`public-api.lock.json`锁定Stable导出；其余Core实现默认Internal。NativeData、io_uring和部分KCP能力仍按专项文档视为Experimental或平台限定。公共API变化必须提供迁移记录，并同步更新本文和AI业务开发手册。

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

Cocos Demo完整类型检查依赖编辑器生成的`cocos_client2D/temp/tsconfig.cocos.json`和`cc`类型，不得把该缓存提交或复制到CI。`typecheck:cocos-demo`在编辑器环境执行完整tsc，在干净Linux/CI环境执行入口bundle检查；引擎无关Client SDK始终由`typecheck:cocos-net`完整检查。

热更粒度固定为整个Process的TS行为世界，而不是单个Scene，也不为每个EntryScene增加V8。TS分为绝对不可热更的Model和可热更Hotfix：Model拥有字段、构造、继承和稳定类型，Process运行中不存在Model reload API；Hotfix只提交方法与Handler。候选先在隔离V8预检，再在当前V8暂存；第一版暂停入站并等待在途任务归零后原子提交，不做字段migration或双generation长期并存。任何Model/Core/协议/Native schema变化都必须重启Process。详见[热更设计](../design/typescript-hot-reload.md)。

业务行为采用ET风格System表达：`@systemFor(ModelType)`类写`Awake/OnDestroy`和公开领域方法，但不创建实例、不保存字段。codegen把公开方法生成到`app/generated/bootstrap/systems/*.d.ts`并合并回Model类型，所以调用方保持`unit.Move()`的面向对象写法，Model无需手写抛错空壳。运行时仍直接安装prototype描述符，没有逐次Registry查找。System首次安装后为必需项，候选遗漏会整体拒绝；Reload不重跑现有对象Awake，新对象使用新Awake，已有对象后续方法和销毁使用当前generation。

本地开发可使用`npm run dev -- configs/<环境>/StartMachine.json`：开发宿主初次完整构建并启动Watcher，随后监听`app/hotfix`和`game_config`源文件，串行构建不可变Hotfix或配置数据候选并分别执行`reload`/`reload-config`。它不改变生产模型，不监听Model源码，也不允许V8直接执行TS；正式部署仍需分发完整候选目录。Model以ESM加载一次，Hotfix以固定脚本名IIFE重复求值，避免ESM ModuleMap和每代脚本URL持续增长。Developer Tools对Model长期状态中的`any`、可选字段、基本类型与`undefined`联合、跨基本类型联合、`delete`和`as any`写入按错误处理；DTO、对象`T | null`、判别联合与显式Map/Record不受影响。

Prometheus/Grafana 已完成多 Process 采集和核心诊断面板；正式部署仍需补 node/windows exporter、通知路由和长期存储策略，这些属于Phase 5，不阻塞`0.3.10`框架准入。

Phase 4计划：

- Phase 4.0已完成：Native Unit、protobuf、MapConfig、Cocos 2D和Pixi统一采用米制`X/Y/Z + Yaw`契约；Grid2D使用X/Z Cell，MapScene按实例创建和释放Rust空间状态。此次为显式破坏性协议升级，旧`0.3.10`客户端不能混连。
- Luban游戏配置基础已先行落地：首批`ItemConfig`、`MapConfig`和不含等级成长数据的`PlayerConfig`已接入服务端、Cocos与Pixi；结构固定在Model，服务端纯数据可原子Reload，字段分端裁剪、外键、只读查询、配置指纹和失败回滚已有自测。后续业务表沿用同一入口，不新增私有加载器。
- Phase 4.5最后建设持久化基础，再进入正式账号、角色和经济业务：计划增加可分片Rust `PersistenceProxy`，`.native`按Entity/Component声明`transient/snapshot/transactional`存储域并生成快照、dirty、schema和恢复入口。`snapshot`由框架合并写Redis并异步落永久DB；`transactional`以永久DB事务为唯一权威写入，Redis只缓存带revision的提交结果。同一字段不得同时拥有两条权威写路径，版本按存储域隔离。第一版只实现一种永久DB Adapter，不提前维护MongoDB/MySQL/PostgreSQL三套实现。该能力尚未实现，当前业务不得直接连接Redis/DB或自行增加持久化注解。
- 账号与角色选择、正式持久化业务接入。
- 地图传送已经统一为`player.TransferToMap(mapInstanceId)`：业务不提供MapHost、IP、端口或本地/远程分支。Gate在第一个`await`前打开有界屏障，源PlayerUnit mailbox通过MapInstance目录解析目标后协调Location锁、目标候选、位置提交和源Actor清理；Proto `duringTransfer`决定Actor消息排队、拒绝、丢弃或latest覆盖。Map1/Map2拆为两个MapHost的Runtime smoke已经覆盖跨进程传送，并验证并发UseItem只在目标Unit执行一次。Component仍默认不迁移，Numeric、Item显式参与，Position只迁移速度/朝向/存活。目标提交后Location结果不确定时进入可诊断`moving`态，不向旧Actor重放；生产级事务日志和自动恢复仍属后续高可用工作。详见[Entity地图迁移](../design/entity-transfer.md)与[Location路由](../design/location-routing.md)。
- Phase 4.1 Rust AOI功能链和Windows正式容量回归已完成：每个MapInstance创建独立稀疏X/Z AOI Grid。`Cell`是可配置米制空间单位；`AoiConfig`定义每个Grid包含的Cell数，以及彼此独立的Enter与Detach迟滞范围；`AoiSyncTierConfig`独立定义已可见关系的可覆盖状态频率。同步范围大于Enter不会提前建立视野，未覆盖整个Detach也合法。Enter内关系从Grid推导，仅迟滞外圈、业务拒绝和本帧净变化需要存储，TS不镜像全量关系。FastOP X/Z写入自动标脏，跨AOI Grid才重算。Movement按同步档位节流，低频档按Subject Grid稳定错峰，但开始/停止/转向强制立即发送；Numeric、UnitState和不可覆盖事件保留各自同步语义。进入/离开同帧相同受众合并为`G2C_AoiDelta`。阵营/隐身/位面由同步`IAoiVisibilityFilter`查询并显式Invalidate。业务使用逻辑`ClientAudience`组合AOI、自己和关系成员，由`ClientBroadcast`隐藏Gate与Location路由。2026-07-31的3000玩家、16 Gate、`single-grid`安全轨迹、每玩家2Hz Move与0.2Hz Probe正式窗口中，Map CPU平均/p90为39.25%/44.17%，实际Move 5981.8/s（99.70%），Probe p95/p99为243.15/425.09ms，正式窗口零背压、零内部过载、零超时、零慢连接断开；证据见`perf/results/map_capacity_latest.md`。这是当前机器的框架负载证据，不是生产人数承诺。`same-point`高频跨Grid压力仍会在百万级迟滞关系下触达Map输入上限，必须单独标记为边界诊断。Phase 4.2接入NavMesh3D；Phase 4.3完成Cocos 3D Demo；Phase 4.4进入怪物与战斗；Phase 4.5最后完成持久化基础。
- 每个MapInstance有独立的隐藏式入图队列：连接和登录完成后，客户端停留在Loading，地图按`MapConfig.entryPlayersPerTick`逐Tick执行AOI Attach，队列上限由`entryQueueCapacity`控制。首次登录和地图传送进入队列；断线重连复用现有Unit，不重复Attach。它只削平单地图Attach与初始Snapshot洪峰，不是区服容量排队，也不替代地图人数上限或负载调度。配置属于Cold，默认Demo为每Tick 1人、最多等待10000人。首次进图、Gate到源Unit的传送调用以及跨MapHost目标Commit统一使用10分钟Admission事务上限，不得继承普通Scene RPC的5秒超时；该上限只是故障兜底，不能当成可接受的Loading时延。
- Admission在一个逻辑Tick内先完成本批次Attach，再准备新Observer的初始实体列表。生产路径不再把这份列表塞入`EnterMap`响应：`EnterMap`返回小型路由、坐标、物品和空间元数据；客户端注册`G2C_AoiDelta` Handler后调用`C2G_MapSnapshotReady`，Gate校验Unit路由，MapHost再通过既有`ClientBroadcast`发送初始`AoiDelta`。`MapComponent`拥有暂存快照，玩家移除和地图销毁时清理，发送失败可重试。`player_entry_snapshot_items_total`仍表示逻辑初始实体条数，`player_entry_snapshot_materialized_items_total`表示实际对象构造数；复用指标用于诊断构造成本。`entryPlayersPerTick`仍是Cold配置，批量参数必须同时观察初始AoiDelta下行队列后再决定生产值。
- 进图链路以低基数指标拆分MapHost全链路、ID分配、Player创建、Location注册/确认、MapReady、Admission等待、AOI Attach、新玩家Snapshot和老玩家AOI Delta；对象条数与真实Transport字节分开统计，禁止为了观测在TS重复编码protobuf。`perf:map-entry-stages`通过Bench专用`entrySyncMode`运行Attach Only、新玩家快照、老玩家Enter和Full四组A/B；普通`C2G_EnterMap`永远使用Full，前三种残缺模式不得进入生产配置或业务代码。
- Rust AOI前的权威Entity Store迁移已完成：generation handle目录只做定位与世代校验，`.native`生成Unit/Item类型池及Unit冷热布局；TS只持有生成NativeRef。Rust池容量、活跃实体、TS NativeRef和帧尾scratch扩容已进入Prometheus。迁移保留既有Native op语义；类型分池、冷热布局的微基准与地图容量报告仍须分开解释，不能把任一结果直接换算为生产服务器容量。
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

1. 接业务需求先阅读[AI业务开发手册](business-development-manual.md)、最接近的`app/model/demo`状态定义和`app/hotfix/demo`行为实现。
2. 不把阶段历史文档中的旧Service/V8模型恢复到当前设计。
3. 不因为性能猜测下沉Rust，先建立业务路径和指标；用户明确要求实验时再做最小A/B。
4. 不在收到Unit消息后通过账号、地图遍历或全局Manager再次定位Unit。
5. 不把不可覆盖Event塞进latest状态通道。
6. 不把AOI收件人选择写进BroadcastHub；AOI拥有Audience。通用路径由Core排队、编码和投递，Movement专用Rust热路径可在AOI内部把Audience直接投影为Gate route frame，但业务层不能看到或管理routeId。
7. 不为未来Wasm/Rhai设计当前用不到的多语言抽象。
8. 修改架构事实、目录所有权、协议语义或Phase状态时，同步更新本文、`README.md`和`docs/roadmap.md`。
9. Actor只作为Scene、Session、Unit的统称和底层路由术语；不要为普通业务身份新增泛化`XxxActor`。
10. 新业务状态写Model，生命周期和行为写`@systemFor`；不要恢复Model方法空壳，也不要在每次方法调用前查System Registry。
11. Component拥有的子对象只能由所属Component维护集合和业务修改；不要从Handler直接操作Native Ref，也不要把每条Quest或Achievement机械地做成Entity。
12. TiangZ主工程及配套VS Code插件仓库的提交标题默认使用中文；代码标识、命令、版本号和专有名词可保留原文。

## 新AI建议阅读顺序

1. 根目录`AGENTS.md`。
2. 本文。
3. [AI业务开发手册](business-development-manual.md)。
4. [架构与快速启动](../tutorials/01-architecture-and-quickstart.md)。
5. 与任务相关的教程、reference和现有Demo代码。
6. 只有维护Runtime时才阅读[运行时维护者指南](../design/maintainer-guide.md)和`src`。
