# TiangZ 开发日志

本文记录已经发生的工程变更、验证结果和当时的取舍。未来计划仍以 [路线图](roadmap.md) 为准，稳定架构约束以 [AI 项目上下文](ai/project-context.md) 和 [AI 业务开发手册](ai/business-development-manual.md) 为准。

维护约定：

- 最新记录放在最前面，使用日期和版本作为标题。
- 记录目标、实现、验证、设计决定和遗留问题，不复制完整提交清单。
- 公共 API、配置、数据所有权或业务开发方式发生变化时，同步更新对应教程以及两份 AI 文档。
- 性能数字必须注明拓扑、负载和边界，微基准不得直接写成整服容量结论。
- TiangZ主工程及配套插件仓库的提交标题默认使用中文；代码标识、命令、版本号和无法自然翻译的专有名词保留原文。

## 2026-07-30 - MapInstance入图节流与3000人基线复核

Rust AOI接入后的同屏压测暴露两类非稳态开销：状态复制曾在没有实际可见性任务时仍等待Promise微任务屏障；批量进入同一出生点又会集中产生近似O(N²)的Attach关系和初始Snapshot。前者已改为仅在真实空间投递在途时等待，2000人同条件Map CPU由66.7%降至40.1%。后者增加每MapInstance独立的隐藏式Loading队列，由Cold `MapConfig.entryPlayersPerTick/entryQueueCapacity`控制逐Tick放行和有界等待；首次进入及传送使用，断线重连跳过。

默认每Tick放行1人后，3000人、16 Gate、5Hz Move、1Hz Probe、单AOI Grid测试完成全部入图，队列峰值16且零失败，Map CPU平均78.8%。但正式窗口仍出现1774次背压，Probe p95/p99为1814/2568ms，因此只能证明Attach洪峰被削平，不能作为合格容量点。容量报告同时修复了遗漏“零背压”过滤的判定错误。

## 2026-07-30 - AOI可见范围、同步档位与冷热配置解耦

地图空间统一使用可配置米制Cell；AOI宽阶段更名为AOI Grid，并由`gridSizeCells`声明一个Grid包含多少个Cell。Rust `AoiWorld`把Enter和Detach迟滞分开：Enter内关系仍由Grid即时推导，只物化已经进入后停留在迟滞外圈的稀疏关系，保持密集同屏的低内存特性。可覆盖Movement再使用独立同步档位，档位只作用于已可见关系；开始、停止和转向强制立即发送。当前Demo为150×150 Cell、每Grid 15×15 Cell、Enter 3×3@20Hz、5×5外圈@5Hz、Detach 7×7外圈@1Hz。

AOI Grid改为从地图最小Cell建立相对原点，避免225 Cell等奇数Grid世界被世界零点切成16列。容量工具新增10×10、15×15、20×20 Grid冷地图矩阵；`grid-uniform`严格把玩家轮询放到每个Grid中央Cell并限制为1 Cell/s。10×10世界的1000/2000/3000人对应每Grid 10/20/30人；静态布局只验证3×3 Enter稳态，5Hz/1Hz迟滞档另做迁移回归。

拆链路复测发现，1000人纯Move（5k Move/s、约15.9万Push/s）时Map CPU平均68.2%、零背压；1000人纯Probe在1k RPC/s和15k RPC/s时Map CPU分别为6.7%和37.3%，后者p95/p99为3.44/4.45ms。3000人纯Move下，10×10、15×15、20×20世界的Map CPU依次为103%、143%、205%。虽然可见关系随世界扩大由约70.7万降至18.8万，但Gate batch由约2.17万/s升至8.70万/s、每批接收者由14.84降至4.04，证明当前瓶颈是稀疏Audience产生的大量小型内部发送，而不是Probe RPC或Rust AOI查询本身。下一步应在不改变AOI语义的前提下，将同一Tick的多组frame按Gate合并为一次内部批量发送。

容量工具同时修复Rust客户端`--probe-only`仍沿用默认5Hz Move的问题：现在该模式在统一参数层强制`moveRate=0`，报告中`move/s`和`push/s`必须同时为0才可接受。

首次矩阵发现旧Bench流程先在公共出生点Attach、再用ActorLocation RPC搬运，建角会制造不属于稳态的临时Enter/Leave并让定位RPC排队超时。现改为Bench Gate RPC计算冷配置出生点，经可信内网字段在Unit创建时预定位；外网正式EnterMap不能提交坐标。定位RPC仅校验并停止每100ms的Demo回血Timer，避免`state-sync-mode=off`仍混入Numeric广播。统一结果见`perf/results/aoi_grid_matrix_20260730.md`：1000@10×10完整通过但Map CPU平均86.1%略超85%目标；2000/3000在正式负载中出现Actor RPC超时，扩大到15×15和20×20虽显著降低可见关系和移动编码耗时，仍未越过3000玩家18k/s入站消息上限。

Luban增加`ConfigTablePolicy`整表策略，生成完整、Hot、Cold三套数据及独立指纹。Item/Player为Hot；Map/AOI/策略为Cold。Rust验证分区可无重叠还原完整数据，TS和构建工具拒绝运行期Cold变化。空间尺寸、范围和频率即使只改数值也必须完整构建并重启Process。

## 2026-07-30 - Phase 4顺序调整

持久化基础从原Phase 4.1调整到Phase 4.5，作为`0.4.x`最后一个基础阶段。当前优先推进地图主链路：`0.4.1` Rust AOI、`0.4.2` NavMesh3D、`0.4.3` Cocos 3D Demo、`0.4.4`怪物与战斗，最后由`0.4.5`完成持久化。旧日志中的Phase 4.1是当时排期记录，不再代表当前执行顺序。

## 2026-07-30 - Phase 4.1 Rust AOI功能链

新增地图实例私有Rust `AoiWorld`：稀疏X/Z宽阶段格推导默认候选与可见关系，只保存业务拒绝覆盖和本帧净变化，TS不再镜像全量关系边。Native X/Z setter只标脏，跨宽阶段格才重算邻域；该宽阶段格后来统一更名为AOI Grid。玩家Attach/Detach与Location提交、Native Unit销毁顺序对齐。Movement、Numeric和UnitState不再默认全地图广播，而是在Rust按最终可见集合分组编码，TS只解析接收者外壳并交给稳定latest频道；多组投递全部成功后才Ack。

首次3000人同Cell诊断在建角阶段暴露复制分组的二次方临时数据：每名玩家的Numeric定时变化会把“每名接收者看到哪些记录”展开成矩阵，Map满核后使EnterMap RPC超时。编码入口改为默认按Subject Cell共享frame与受众列表；仅带业务拒绝覆盖的Subject计算精确受众。该改动已经消除该临时矩阵，但正式容量数据必须等同口径复测通过后再记录。

随后3000人诊断又发现Gate分配热点：原始FNV-1a Rendezvous分数对公共账号前缀相关，12 Gate实测连接数约为94到687。Gate选择器增加32位avalanche最终混合，并新增12000账号、12 Gate、单Gate偏差不超过10%的回归测试。该轮仍未形成有效正式性能窗口。

容量工具现在会在失败时保留Process health诊断，而不是丢弃预热样本。诊断还发现Rust虚拟玩家原先从同一时刻启动周期任务，会在每个Move/Probe周期制造全员同步脉冲；现按UnitId为每种周期负载生成稳定相位，总QPS不变但请求均匀铺开。旧同步脉冲失败结果不再用于容量判断。

AOI状态复制进一步按相同受众合并宽阶段格frame；容量报告补充World、Entity、Grid、候选/可见关系、跨Grid和可见变化速率。900人诊断确认约845次跨Grid/s会产生约6.11万条可见变化/s，旧路径按Subject调度约7437次广播/s并出现背压。新增不可覆盖`G2C_AoiDelta`，把同帧相同受众的Enter/Leave批量发送；Cocos 2D、Pixi和all-in-one/split Runtime smoke均通过。改后900人短窗广播约297次/s、平均约0.95ms且无背压；1000人短窗可跑完但Map CPU约98.1%。最终850人、12 Gate、5Hz Move、1Hz Probe、10秒预热加60秒正式窗口通过：Map CPU平均77.2%，Probe p95/p99为39.05/82.16ms，零错误、零过载、零超时、零背压。该结果是当时的Windows候选，不等于生产MMORPG容量；旧实现A/B与分布式空间负载仍待补充。

普通Rust/TS单测、BroadcastHub多受众Ack测试以及all-in-one、split-process Runtime smoke均已通过。边界冒烟覆盖Enter、Leave、范围外不接收新sequence和重新Enter。正式地图容量A/B尚未完成，当前不记录性能收益。

## 2026-07-30 - v0.4.0 Phase 4.0空间契约

Phase 4从空间契约开始，而不是直接堆叠3D业务。服务端、Native Entity和protobuf统一为地图局部米制`X/Y/Z + Yaw`：X/Z是地面，Y是高度，Yaw为绕Y轴弧度；Grid2D同步迁移到`cellX/cellZ`和`inputX/inputZ`。Cocos 2D与Pixi只在显示边界将X/Z映射到屏幕X/Y，公共SDK不依赖任何引擎向量类型。

Luban `MapConfig`增加`SpatialMode`、三维出生点、Grid/AOI米制Cell及导航资源`asset/version/hash`。Rust按MapInstance创建和释放Grid2D空间状态；NavMesh3D只冻结资源共享和实例生命周期契约，当前启用会明确失败。协议schema lock通过仅供破坏性版本使用的显式命令替换，旧`0.3.10`客户端不得与`0.4.x`混连。

## 2026-07-29 - 静态地图与动态副本统一

地图身份正式拆为模板`MapConfigId`和运行时`MapInstanceId`。静态实例号等于配置号，由所属MapHost读取`staticMapIds`后创建；动态副本由Demo业务`DynamicMapManagerComponent`使用全局ID创建。两者共享MapHost唯一`CreateMap`、MapScene/Component组合、Rust本地索引与销毁路径。MapHost向Location注册实际托管实例并周期重报，`knownScenes`不再复制地图归属。

玩家业务统一调用`player.TransferToMap(instanceId)`，不传MapHost或判断本地/远程。动态副本显式销毁只接受空地图，框架不替业务踢人、保存或选择回退点；连续无人五分钟的回收放在Demo DynamicMapManager作为兜底策略。单进程与拆分进程Runtime smoke继续通过，新增MapInstance目录测试覆盖幂等注册、冲突保护、静态删除拒绝和动态删除。

## 2026-07-29 - 运行时基础能力收口

Entity正式区分可持久业务`Id`与本次生命周期`InstanceId`。新增63位`GlobalIdSystem`，使用永久来源服、时间、Process worker和秒内序列保证合服身份隔离；Runtime配置增加`process.identity`，Watcher在启动任何子进程前检查整套StartMachine中的重复生成槽位。Item协议升级为`uint64`，新建使用新GlobalId，数据库/迁移恢复保留原ItemId。

Timer新增唯一`TimerId`、原样用户参数、主动取消原因和至多一次取消回调；Actor所有权链继续通过mailbox保持顺序，Owner销毁静默清理。TimeSystem补齐墙钟deadline helper。新增Scene范围的FIFO协程锁与同步/异步Event；锁等待和超时已接入Process指标与Prometheus。`test:runtime-foundation`和Rust Watcher测试覆盖核心语义，完整说明见[运行时基础能力](design/runtime-foundations.md)。

## 2026-07-29 - Location路由与跨MapHost传送

新增ordered Location Scene与版本化玩家目录，权威记录包含Unit/account、长期Gate、MapHost/Map实例、Actor InstanceId、revision和`active/moving/removing`状态。注册、迁移和最终下线使用operationId与CAS语义；只知道UnitId的服务端业务通过`MessageHelper`解析一次，Gate普通ActorLocation消息继续使用连接本地缓存，不把Location变成流量中心。MapHost每5秒幂等重报实际持有Unit，可恢复Location内存进程重启后的active目录。

Prometheus自定义指标增加`location_directory`与`actor_transfer_barrier`，分别观察位置数量/状态/冲突，以及迁移屏障数量、排队帧/字节、超时、拒绝、丢弃和过载；标签保持低基数。

同MapHost和跨MapHost传送统一由Gate `EnterMap`发起。Gate必须在第一个`await`前打开每连接有界屏障，Proto `duringTransfer`生成`queue/reject/drop/latest`策略；源PlayerUnit mailbox协调Location Lock、目标Prepare/Commit、Location Commit和源Actor延后销毁。真实smoke发现并修复了“先await解析Location、后开屏障”导致UseItem抢先进入旧Unit的竞态，同时把测试客户端从FIFO响应改为按rpcId多路复用。单进程与拆分进程均验证Map1到Map2传送保持UnitId/Numeric/Item，且并发UseItem只在目标Unit执行一次。

目标已经提交但Location结果不确定时，不允许把缓冲消息重放给旧Actor；Gate拒绝请求并断开连接，Location保留moving诊断态。自动事务恢复、MapHost租约、死亡节点接管、etcd发现和Gate故障转移仍属于后续生产高可用范围。完整语义见[Location路由](design/location-routing.md)和[Entity地图迁移](design/entity-transfer.md)。

## 2026-07-29 - Gate断线重连所有权重构

Gate连接状态拆为一次性`GateSession`与跨连接`GatePlayerRoute`。Login改用账号Rendezvous Hash稳定选择Gate；同账号新连接原子替换connectionId，旧socket迟到的disconnect不会再删除新连接或Map Unit。客户端继续每5秒发送单向`C2G_Ping`，Gate统一记录所有入站消息的`lastReceiveTime`，出站排队时间只用于观测。

普通transport断开现在进入30秒重连宽限。重连通过Actor RPC `SecondEnterMap`取得原PlayerUnit的权威全量快照，不创建Unit、不广播AOI进入、不改绑Gate；Map只清除旧移动输入。宽限或入站心跳超时后，Gate调用带响应的`PlayerOffline`，Map保存玩家、移除Unit并广播AOI离开，随后Gate回收Route。`UnitGateComponent`、传送快照和持久化快照已删除GateSessionId。

新增`test:gate-reconnect`覆盖连接替换、迟到close、收发时间语义、宽限状态机、重复最终下线与多Login稳定选Gate；Actor、协议、持久化和迁移自测同步适配。同进程与拆分进程Runtime smoke均复用原Unit完成重连；`test:gate-timeout-runtime`实际等待32秒后确认旧UnitId 1000被Map移除，再进入创建UnitId 1001。完整设计见[Gate断线重连与最终下线](design/gate-reconnect.md)。

## 2026-07-29 - 地图迁移事务与Developer Tools 0.14.0

同进程迁移改为“准备候选、目录提交、源对象清理”：目标Unit先完成全部Component恢复和Deserialize，`PlayerDirectory.Replace`成功后才销毁源Unit。目标恢复或目录竞争失败会销毁候选并保留旧玩家，避免玩家从两个地图同时消失。

跨进程目标端增加内网`MapTransfer.Prepare/Commit/Abort`协议、可序列化`PlayerTransferSnapshot`、有界幂等暂存和超时回收；协议只进入服务端生成物。当前没有全局Location/Directory，源端协调尚未开放。新增`test:entity-transfer`覆盖回滚、重复请求、载荷冲突和TTL回收。

TiangZ Developer Tools `v0.14.0`已经发布并成为主工程固定依赖，包含生命周期/迁移契约诊断和生成输入索引修复。

## 2026-07-28 - Map1/Map2进程内传送

Phase 4地图链路开始推进。MapHost现在把Map1和Map2按需创建为独立MapScene；玩家在同一Gate Session中再次调用`EnterMap`即可切图。迁移保持UnitId，旧Scene销毁旧Actor并广播离开，目标Scene使用配置出生点创建新Actor InstanceId。

初版把Numeric和Item直接写入玩家迁移DTO，无法让开发者选择组件，随后在本轮内废弃。正式机制由Core Entity统一提供：Component默认不迁移，稳定Model类型显式`@transferable()`并实现同步`ITransfer`后才参加。Numeric、Item各自导出值快照；Position只保留速度、朝向和存活，不带坐标；Gate、Persistence、Native handle和临时组件由目标Factory重建。进程内快照以稳定Model构造器为键，只服务一次Scene切换，不替代持久化记录、跨进程DTO或全局Location。

补充`IDeserialize`二阶段生命周期：`RestoreTransfer`只写回状态，Entity在全部可传送Component恢复后调用一次业务`Deserialize`，用于Buff Timer、派生索引和非序列化缓存等二次加工。Core只负责同步调用顺序和重复调用保护，具体恢复规则留在Hotfix System；未来持久化加载器通过`CompleteDeserialize`复用同一钩子。

补齐生命周期声明契约：Model使用`@lifecycle`按需声明`Awake/OnDestroy/Deserialize`，`@transferable`继续作为迁移能力唯一标记。`codegen:scenes`会检查对应System是否提供同步实现，热更候选提交前再次检查自己的prototype，缺方法或异步实现会拒绝整包并保留旧generation；未声明能力仍不要求空方法。新增生成负例与Hotfix回滚自测。

Cocos Web/Native和Pixi/H5均增加`T`键切换Map1/Map2，客户端等待RPC与`MapReady`后重建地图及消息Dispatcher。Runtime smoke增加传送断言，覆盖UnitId、目标出生点、背包版本和Numeric不回退。跨MapHost/跨进程事务与动态副本Directory保留后续实现。

## 2026-07-28 - 后续容量规划调整

自动容量推荐与部署参数生成延后到Phase 5。当前业务负载尚未覆盖Rust AOI、怪物、战斗、Buff、任务和持久化，现阶段根据Probe或全地图可见Move测试推导正式在线人数会产生错误承诺。

保留`perf:gate`作为框架热路径回归门，保留`perf:map-capacity`作为特定拓扑与负载的版本化证据；二者暂不自动生成Map准入人数、Gate数量或Process数量。后续容量规划必须在代表性业务链路具备后，按不同负载模型分别校准，并把CPU、吞吐、p95/p99、队列趋势、错误和安全余量共同纳入结论。

## 2026-07-28 - v0.3.10

`0.3.10-rc.1`冻结提交为`d31437c`，运行时代码、Stable API、协议指纹和Native Schema在正式版本中保持不变。Windows完整`npm run verify`耗时350.2秒，制品构建与目录内smoke耗时63.1秒；Windows制品包含28个文件、27条SHA-256，约49.1MiB。

Linux使用Git Bundle从同一提交创建干净克隆，`npm ci`耗时29秒且0个漏洞，npm/Cargo联合审计为0个漏洞、0个例外；完整`verify`耗时约295.3秒，制品构建与目录内smoke耗时147.7秒。Linux制品同样包含28个文件、27条SHA-256，约70.6MiB，哈希逐项校验通过。

最终矩阵覆盖codegen幂等、Stable API、Model/Hotfix边界、协议锁、TypeScript与Rust测试、Clippy、真实拆进程、ordered/unordered mailbox、背压、Watcher优雅停机、Hotfix Reload和慢RPC切换屏障。Windows仍会报告已知MSVC `LNK4098 libcmt.lib`警告，但没有链接失败或测试失败；该警告继续作为构建工具链事项跟踪，不阻塞本次发布。

`v0.3.10`是Phase 0至Phase 3.10的稳定框架基线，不等于完整商业MMORPG产品。后续容量规划、AOI、动态副本与业务系统使用新版本演进，不回写本Tag。

## 2026-07-28 - v0.3.10-alpha.9

### 本次目标

把Item、Buff、动态Quest和Achievement等“Component拥有的多个实例”收敛为框架级子Entity语义，同时验证新增生命周期索引不会成为性能瓶颈。

### 完成内容

- Stable Core新增`ChildEntity`以及`AddChild/GetChild/TryGetChild/GetChildren/RemoveChild`，统一Parent、DomainScene、InstanceId、EntityRoot、Timer与级联销毁。
- ChildEntity明确没有mailbox、Actor路由和网络地址；挂在Unit下的Timer仍经过所属Unit mailbox串行。
- Item从ItemComponent私有Map和伪InstanceId迁移为真实ChildEntity；每个Item拥有自己的NativeItemRef，局部规则与集合规则分别位于ItemSystem和ItemComponentSystem。
- 创建失败、异步Awake拒绝、重复Id、Timer取消、Root清理、Component/Actor级联销毁和Hotfix System候选均加入自动测试。
- 新增`npm run perf:child-entity`，独立测量框架对象语义，不把AOI、Native、protobuf和网络混入结果。
- 新增`docs/patterns`领域设计知识库，使用稳定规则编号描述所有权、Entity形态、Audience、同步、生命周期、Timer与数据位置。
- TiangZ Developer Tools `v0.13.0`增加确定性`design-core`、业务系统设计向导、`@tiangz`解释入口、CLI与只读MCP服务；AI不改变规则结论，也不自动修改业务代码。
- Developer Tools `v0.13.0`已发布Tag并成为主工程固定依赖；新增`verify:design-rules`交叉检查24条稳定规则及其领域文档归属。

### 性能验证

Windows Node 24、单进程、100,000个纯TS ChildEntity、1,000,000次随机查询：创建约47.24ms（2.12M/s），查询约92.93ms（10.76M/s），稳定数组遍历约4.15ms，销毁约22.80ms（4.39M/s），保留V8 Heap约506字节/实例。该结果只说明容器和生命周期开销可控，不能推导地图或AOI容量。

### Windows Release候选预演

2026-07-28在Windows x64完成`0.3.10-alpha.9` Release候选预演。依赖审计耗时26.3秒，完整`npm run verify`成功轮耗时231.0秒，`release:package`耗时43.8秒；稳定完整流程合计301.1秒，约5分01秒。

首轮`verify`在228.4秒发现Hotfix反转移动夹具漏装配新增的`ItemSystem`，候选预检正确拒绝不完整generation。补齐夹具后，针对性Reload测试用22.8秒验证5个Process两次切换到generation 3并拒绝损坏候选，随后完整`verify`重新通过。

最终制品`TiangZ-0.3.10-alpha.9-win32-x64`包含28个文件、27条SHA-256，约49.1MiB；在制品目录完成登录、GateSession重建、Numeric Timer、Item Event、权威移动与多人Entity生命周期smoke。Windows验收通过，Linux同版本Release候选仍待执行。

### Linux Release候选预演

2026-07-28在Ubuntu x64虚拟机完成同版本预演。使用Git Bundle克隆精确对象，避免Windows工作树`core.autocrlf`污染跨平台候选；`npm ci`耗时约25秒且0个已知漏洞，修复后完整`npm run verify`耗时142.7秒，`release:package`耗时165.8秒。稳定完整流程约333.5秒，即5分34秒。

首轮Linux运行时smoke暴露了Windows时序下未稳定复现的断线/重进竞态：新`EnterMap`缓存旧Unit后，旧连接恰好完成Actor销毁。MapHost现在只在权威账号目录确认旧实例已经消失时重新解析并重试；其他Handler异常仍原样抛出。同期修复RPC系统错误响应构造，错误包先从生成Codec创建完整默认对象，再写入`rpcId/error/message`，避免带repeated字段的响应在错误路径二次编码失败。

完整验收还发现背压脚本早于五秒指标采样周期读取`/metrics`。测试现等待首个真实队列快照，最长7秒，不修改生产采样周期。Linux背压实测队列容量64、最大深度64、背压等待8962、慢连接误断开0。最终制品`TiangZ-0.3.10-alpha.9-linux-x64`包含28个文件、27条SHA-256，约70.6MiB；哈希与制品目录smoke均通过。

### 设计决定

- Unit是带mailbox的地图Actor；Item/Buff/动态Quest是Component拥有的本地ChildEntity。是否需要被AOI看到不决定它是否是Actor。
- Buff采用生命周期事件而不是通用dirty Delta：创建广播Add、删除广播Remove，进入AOI时随Unit整体Snapshot发送；Tick只执行Action，产生的Numeric、Move等变化由对应领域同步。
- QuestComponent只为进行中任务持有Quest子Entity；完成时记录稳定配置ID并删除实例。任务进度默认只同步本人，组队共享通过显式Party受众发送摘要，不进入地图AOI。
- 少量子Entity可直接持有Timer；大量Buff由BuffComponent按`nextTickAt/expireAt`合并调度，避免每个Buff常驻重复Timer。
- `GetChildren`返回数组快照，只用于低频管理、保存和全量同步；高频帧尾路径必须维护dirty集合或紧凑索引。

## 2026-07-28 - v0.3.10-alpha.8

### 本次目标

验证 Rust 权威实体数据从通用 Handle Arena 迁移到类型分池、冷热分离后的收益，并减少帧尾状态编码与广播路径中的临时分配。同时补齐可观测指标和可重复执行的性能基准。

### 完成内容

- `.native` 增加实体存储和字段温度描述，由 codegen 生成 `NativeEntityPools`、类型 Pool、Unit 热/冷数据结构以及 TypeScript NativeRef 操作。
- Unit 与 Item 进入独立紧凑 Pool；Unit 的高频字段与低频字段分离存放。Rust 仍是权威数据源，TypeScript 只持有带 generation 校验的句柄。
- 帧尾移动快照直接编码到最终输出缓冲，复用 handles、records 和编码 scratch，避免逐玩家临时 `Vec` 与 Rust -> TypeScript -> Rust 往返。
- health/Prometheus 增加活跃 Entity、Unit、Item，Pool/Scratch 容量与增长次数、TypeScript NativeRef 数量、Native 编码吞吐等指标。
- 新增 `npm run perf:native-storage`，独立比较 Handle Arena、类型分池和 Unit 冷热分离。
- Map 容量工具在普通测试中也为每个 Process 启用临时 health 端口，直接采集 CPU、RSS、V8、Transport、NativeData 和广播指标；累计计数按正式窗口差值换算速率。
- TiangZ Developer Tools 升级到 `v0.12.0`，Native Language 升级到 `v0.14.0`，补齐 Model 稳定字段和 `.native` 存储语义支持。

### 性能验证

Native 数据布局微基准：50,000 Unit、每 Unit 10 Item、Release 构建，5 轮取中位数。

| 布局 | 更新吞吐 | 估算存储 | 相对前档 |
|---|---:|---:|---:|
| Handle Arena | 78.27M Unit/s | 323.5MiB | - |
| UnitPool + ItemPool | 175.81M Unit/s | 42.0MiB | +124.6% |
| UnitHotPool + UnitColdPool | 617.02M Unit/s | 42.2MiB | +251.0% |

完整游戏链路三轮基线：Windows IOCP、1 MapHost、16 Gate、3000 玩家、每玩家 5Hz Move + 1Hz MapProbe。

| 指标 | 三轮中位数 |
|---|---:|
| Map CPU | 47.5% |
| 最忙 Gate CPU | 56.6% |
| Move | 14,998/s，达标率 100% |
| Push | 59,913/s |
| Probe p95 / p99 | 175.76 / 229.85ms |
| 业务错误 / 内部超时 / 慢连接断开 | 0 / 0 / 0 |

边界探索中，3500 玩家时 Map CPU 为 60.1%，最忙 Gate 平均/峰值为 74.2%/83.3%，Probe p95/p99 上升到 473/633ms。4000 玩家在入图阶段因全地图可见快照形成瞬时下行洪峰，触发 Gate 慢连接保护，未进入正式测量窗口。

3000 玩家稳态复核中，帧尾 scratch 容量约 0.2MiB，正式窗口 `scratch grows/s` 为 0；进程启动后的累计扩容发生在容量爬升阶段。

详细结果见：

- [Native 数据布局最新报告](../perf/results/native_storage_latest.md)
- [Map 容量最新报告](../perf/results/map_capacity_latest.md)
- [Map 容量测试说明](../perf/map_capacity/README.md)

### 设计决定

- 保留 `.native` 作为存储意图的唯一描述源，业务开发者不手写 Rust Pool 和 FastOp 胶水。
- 当前不引入 Bump allocator。帧尾 scratch 在稳态没有继续扩容，新增分配器的生命周期约束和维护成本高于可证明收益。
- 3000 玩家作为当前全地图互相可见模型的可重复基线；3500 是压力边界，不作为舒适容量承诺。
- 4000 人首先暴露的是入图全量状态与下行扇出问题，而非 Map CPU 上限。该问题应由后续 Rust AOI、分批入图快照和明确的客户端延迟 SLO 处理，不能通过放宽慢连接保护掩盖。

### 遗留问题

- 在 Rust AOI 落地后重新测量入图快照、增量广播和单 Map 容量。
- 为容量候选增加明确的 Probe p95/p99 SLO，避免只按 CPU 和错误数判断。
- Linux 环境补充 epoll/io_uring 同口径验证；本次数据只代表 Windows IOCP。
# 2026-07-28 - Phase 4.1持久化方案排期

- 持久化基础延后到Phase 4.1，在正式账号、角色和经济业务之前实施，当前不改Runtime代码。
- 计划使用可分片Rust `PersistenceProxy`；业务继续依赖Repository和领域Component，不直接连接Redis或永久数据库。
- `.native`未来按Entity/Component声明`transient/snapshot/transactional`。普通快照自动标脏、合并写Redis并异步落库；经济事务以永久DB为唯一权威，Redis只缓存带版本的事务结果。
- 同一字段禁止同时拥有Redis和DB两条权威写路径，版本按存储域隔离；第一版只实现一种永久数据库Adapter。

# 2026-07-28 - Luban游戏配置基础

## 目标

在进入完整MMORPG业务前建立统一静态配置链路，先覆盖道具、地图和玩家初始模板，并避免把策划数值、部署JSON和运行时持久化数据混在一起。

## 完成内容

- 固定引入Luban 4.10.2官方CLI及MIT许可证，生成过程不依赖在线下载。
- 新增`game_config` Excel源目录和`ItemConfig`、`MapConfig`、`PlayerConfig`三张表；玩家模板只含创建时基础值，不承载升级后状态。
- 按`c/s`生成服务端和客户端不同字段集合，使用`#ref`验证初始地图与初始道具引用。
- 生成只读`GameConfigs`入口及配置指纹，并随公共Client SDK自动分发到Cocos和Pixi。
- Demo的地图尺寸/出生点、玩家HP/速度、初始道具和道具回血改为读取配置；Rust地图移动边界由Map配置注册。
- 增加`test:game-config`，覆盖查询、缺失ID、外键、分端裁剪、只读对象和双端指纹一致性。

## 设计决定

- `configs`只负责部署，`game_config`只负责游戏静态数值。
- 配置结构属于不可热更Model；纯数据从Model Bundle拆出为带schema/data指纹的完整快照，可由Watcher在线切换。
- 业务只依赖`GameConfigs.Get/TryGet/GetAll`，不直接读取Excel、Luban JSON或Generated内部类。

## 数据热更补充

- `build:game-config`发布内容寻址的完整候选，Rust先校验文件哈希和Model schema，TS再构造、冻结并验证全部表，最后一次性替换当前快照。
- 失败候选不会污染当前快照；Prometheus暴露成功/失败次数、提交耗时、总耗时和当前数据指纹。
- Watcher新增`reload-config`，`npm run dev`同时监听Hotfix与游戏配置源文件；Release制品携带初始`dist/game-config`。
- 已增加5 Process真实Reload验收：有效数据全部生效，悬空引用候选全部拒绝且旧指纹保持。
- 当前只在线切换服务端配置；客户端配置仍通过Client SDK发布。跨机器Process可能短暂处于不同数据版本，后续有严格全局一致需求时再增加prepare/commit协调。
