# TiangZ 开发日志

本文记录已经发生的工程变更、验证结果和当时的取舍。未来计划仍以 [路线图](roadmap.md) 为准，稳定架构约束以 [AI 项目上下文](ai/project-context.md) 和 [AI 业务开发手册](ai/business-development-manual.md) 为准。

维护约定：

- 最新记录放在最前面，使用日期和版本作为标题。
- 记录目标、实现、验证、设计决定和遗留问题，不复制完整提交清单。
- 公共 API、配置、数据所有权或业务开发方式发生变化时，同步更新对应教程以及两份 AI 文档。
- 性能数字必须注明拓扑、负载和边界，微基准不得直接写成整服容量结论。
- TiangZ主工程及配套插件仓库的提交标题默认使用中文；代码标识、命令、版本号和无法自然翻译的专有名词保留原文。

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
