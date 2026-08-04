# TiangZ 路线图

## 最终目标

构建一套重工程体验、可观测性和部署弹性的 MMORPG 示例栈：Rust/Tokio 负责网络与宿主，单线程 TypeScript 负责业务，Cocos/PixiJS 客户端通过可复用 TS SDK 接入。

当前统一世界观：

```text
Machine -> Process(one V8, EntityRoot) -> EntryScene -> MapScene -> Unit(Actor) -> Component
```

## Phase 0：工程与配置基础

状态：完成。

- Rust + deno_core + TypeScript 正式构建链。
- Core、Generated、Model、Hotfix目录边界。
- 环境配置目录和 StartMachine。
- protobuf codegen、Decorator Registry、系统/业务错误码。

## Phase 1：协议、RPC 与运行时可靠性

状态：完成。

- length-prefix + msgcode + protobuf payload。
- IRequest/IResponse payload rpcId，不占公共帧头。
- 同步/异步 Handler 快路径。
- Inner TCP 长连接和 rpcId 多路复用。
- 有界入站/出站队列、背压、慢连接隔离。
- Runtime/Protocol/Actor 性能测试和验收文档。
- V8 Inspector、sourcemap 与自动调试测试。

### Phase 1.11：Process/Scene 架构统一

状态：完成（2026-07）。

- 移除“一 Service 一 V8”的旧隔离模型。
- 一个配置文件只创建一个 Process/V8/TS 业务线程。
- `scenes` 可启动多个可寻址 EntryScene。
- 本地 Scene call 进入目标 mailbox，远程 call 走 Inner TCP。
- 本地单向 send 只投递，不等待目标 Handler，避免 ordered 调用环。
- Scene Listener 共享 Process queue、writer map 和全局 connectionId。
- Debug/Inspector 从 Service 配置提升到 Process 配置。
- codegen 从 `services.ts` 改为 `scenes.ts`。
- EntryScene 支持 Component 容器；协议 Handler 可独立成 class，并由 codegen 自动发现。
- all-in-one 与 split 完整游戏链路通过。

## Phase 2：可进入游戏的纵向切片

状态：完成。

- LoginMgr 选登录入口。
- Login与Gate的客户端协议进入unordered Session mailbox；共享状态转换按连接、账号等稳定Key使用协程锁，PlayerUnit保持ordered。
- GateSession作为Entity只管理一次物理连接；GatePlayerRoute保存跨Session的玩家路由、心跳时间和30秒重连宽限。
- MapHost 创建多个 MapScene；UnitComponent 统一管理 PlayerUnit/MonsterUnit/NpcUnit。
- 服务端权威移动、多人 AOI 可见性和实体进出 Push。
- Cocos 2D Preview 可多开互相看到移动。

### Phase 2.11：ET 风格 Entity/Unit/Mailbox 统一

状态：完成（2026-07）。

- ProcessHost.Root 建立 InstanceId -> Entity 的 O(1) 生命周期索引。
- Entity 区分业务 Id 与生命周期 InstanceId，并具有 Parent/DomainScene。
- Actor 自动挂载 MailBoxComponent；旧 InstanceId 在重建后失效。
- UnitComponent 作为 MapScene 的统一 Unit 集合，玩家和后续怪物共享模型。
- PlayerDirectory 仅承担账号重连辅助索引，不参与普通 Actor 消息定位。
- ActorLocationEnvelope 携带 InstanceId，Unit Handler 直接取得 PlayerUnit。
- Scene ProtocolRegistry 与 Actor ProtocolRegistry 分离。
- 单进程、拆进程登录、重连、移动、实体进出链路通过。

### Phase 2.12：固定 Game.Update 与游戏定时器

状态：完成（2026-07）。

- Runtime Pump 保持事件驱动，Game.Update 独立为默认 20Hz 固定业务帧。
- `TimeSystem`、`TimerSystem`、`UpdateSystem` 和 `Game` 使用可复用的进程级 SingletonRegistry。
- 实现 `Update()` 的 Component 自动注册与注销，无需维护业务 Update 表。
- 一次性、重复、取消和 WaitAsync 游戏定时器使用单调时钟与最小堆。
- Actor 与 Actor Component 定时器进入实体 mailbox，并随实体生命周期自动取消。
- 固定帧补偿有 `maxCatchUpSteps` 上限，并输出 skipped、Update、Timer 指标。
- `npm run test:game-update` 验证固定帧、生命周期、定时器和 ordered Actor 不重入语义。

## Phase 2.9：文档与开发体验

状态：本轮完成核心部分，持续维护。

- 从架构、首个 Scene、协议、mailbox、游戏链路到部署的中文教程。
- 配置/API/命令/排错参考。
- 维护者指南明确 Rust/TS 边界和运行时不变量。
- README 与代码保持 Process/Scene 术语一致。

后续要求：新增公共 API、配置字段或运行时不变量时，代码与教程同一提交更新。

## Phase 2.10：全链路性能基线

状态：测试体系、Snapshot 投影、上下行批处理和内部 RPC 热路径第二轮整改完成，持续维护。

- 已覆盖 TCP、Rust 有界队列、V8、protobuf、Handler、跨进程 Scene 调用、地图 Actor、移动和客户端 AOI Push。
- 已建立 64B 到 16KB Payload、10/50/100 玩家、单进程/拆分进程、10Hz/极限闭环矩阵。
- 客户端移动由 Core ActorLocation 自动转发，并通过 InstanceId 直达 PlayerUnit mailbox。
- 已增加 Core BroadcastHub 与 Proto `@ets.broadcast` codegen，明确 `event` 不丢事件和 `latest` 同 key 覆盖两种语义。
- Map/AOI 只负责生成 Audience；框架通过通用 `S2G_ClientBroadcast(targetUnitIds, frame)` 自动按 Gate 聚合，新增广播不再编写业务专用内网消息和 Gate Handler。
- MapScene 的 UnitComponent 直接读取本地 PlayerUnit 轻量 Snapshot，不产生跨 Actor 请求。
- Core `sendClientMany` 使用单个 `OutboundBatch`；Rust 一次接收目标列表和帧，并通过 `Bytes` 向多个 writer 共享帧内存。
- TS 每个 update 只执行一次 packed outbound Host Op；Rust 对整包复制一次，各批次通过 `Bytes::slice` 共享 backing storage。
- Gate 的 ActorLocation RPC 转发改为原始 protobuf frame 替换 rpcId，不再为路由完整 decode/encode 业务对象。
- ActorLocation 外层改为固定 14 字节二进制头，Rust 可直接读取内部 rpcId，不解析业务 protobuf。
- TS 到 Rust 的远程 Scene 操作按 update 打包提交；Rust 共享批包 backing storage、每批一个调度任务，并把批内并发限制为 256。
- 单向 Message 不再创建 Promise completion；RPC call 和 timer 才回 completion，避免进图广播产生海量无意义唤醒。
- Actor 同步 Handler 走真正同步的 mailbox 快路径；Raw TCP、WebSocket 和内部 TCP writer 都已批量写出。
- Process completion 与网络 frame 统一进入同一有界事件队列，并增加 frame/completion/update/batch 累计指标。
- Rust 到 TS 的入站事件改为一个连续二进制批包，每个 update 只跨一次 Host Op；不再逐事件调用 `__hostTakeBinaryArg`。
- V8 启动后缓存三个 Runtime 入口 Function，移除每 tick 动态 `execute_script`；Scene metrics 改为每 5 秒采样一次，普通 update 不再 stringify/parse JSON。
- 单连接 response 复用 connectionId 二进制表示，`packFrame` 只分配最终帧；Unit Handler 首次按 `instanceof` 匹配后按构造器缓存。
- Process 提供 `low-latency`、`throughput`、`adaptive` 三种调度模式；默认 adaptive 在高负载下使用微秒级 yield 聚合，避免 Windows 亚毫秒定时器放大延迟。
- 200 玩家、8 Gate、全员 10Hz 移动下，约 40 万 recipients/s 合并为 1.62 万 batch/s，V8 到 Rust 的帧复制带宽约为逻辑下行的 1/25。
- 批量 Bridge 后最忙 Gate 三轮中位 CPU 从 197.9% 降至 137.9%；下一层瓶颈是逐连接 writer enqueue 和网络消息数量。
- 2026-07-20 第三轮优化后，600 玩家、8 Gate、单 MapHost、每玩家 70Hz Probe Only 的完整链路三轮中位数为 4.20 万 RPC/s，Map CPU 54.3%，p50/p95/p99 为 4.05/8.23/10.38ms，最忙 Gate 平均/峰值 CPU 为 66.3/85.9%，三轮均为零 RPC 错误、零 transport overload、零 Process 背压。同一负载口径在本轮开始前的短时单轮样本为 Map CPU 89.1%、p95/p99 5.87/8.22ms；CPU 明显下降，聚合引入了约 1 到 2ms 的可控尾延迟。该结果仍是纯 Probe 框架基线，不是业务容量承诺。
- 默认性能命令升级为 60 秒、三轮中位数，并采集服务端与压测端 CPU/RSS/GC；支持独立压测机。
- 网格 AOI 保留到 Phase 4，当前继续用全地图可见性验证链路和聚合收益。
- 可重复命令、指标口径和报告位置见 `perf/full_chain/README.md`。

### Phase 2.13：Rust 权威实体数据

状态：迁移完成，旧双后端于 2026-07 清理。

- 增加 `.native` 原型和 codegen，生成 Rust Entity/Unit 数据结构与 TS 强类型 handle Component。
- 保持 Handler、Actor mailbox 和协议不变，Unit 跨帧状态统一由 Rust Arena 持有。
- Rust Arena 使用 generation handle，Unit 销毁自动释放；旧 handle 会被拒绝。
- 已下沉移动输入、20Hz 权威坐标更新，并由 Rust 直接生成最终 `G2C_EntityMove` protobuf frame。
- `.native` codegen 已生成 TS 数值属性与 Rust `op2(fast)` 标量访问器；Rust 后端的 TS Component 只持有 generation handle，不保留字段镜像，允许开发人员直接写 `native.x += 1`。
- `.native` 已泛化为多文件 Entity schema：显式 `@typeId`、抽象继承、默认值、普通 handle 与 `@component` handle 共用通用 Arena/Host op；Item 作为第二种实体通过生成与生命周期回归。
- Native op ABI 已纳入 `.native` codegen：自动生成 Rust Extension、Host bootstrap 和 TS `NativeOps` facade，业务不再维护 `__demoXxx` 全局桥或 `>>> 0` 参数截断。
- `.native` 工具链已升级到 `v0.11.2`；独立仓库同时提供 language-core 与无文件系统依赖的 codegen-core。TiangZ 和 VS Code 语言工具共用 Lexer、Parser、AST、Validator、Entity API 投影及 Rust/TS 生成模板；主工程生成器已缩减为扫描、路径校验、落盘和 `rustfmt`。升级后 Native codegen 生成文件零漂移，Actor 自测与 Rust NativeData 测试通过。
- `.native` VS Code 插件当前仅通过本地 VSIX 供项目内部使用；Marketplace、公开 CI 和 `1.0.0` 发布计划暂停，不作为后续 MMORPG 业务 Phase 的前置条件。
- 标量访问阈值只用于可观测性提醒，不作为框架策略；NativeData 调用链固定为 TS -> fast op -> Rust Arena，禁止 Rust 回调 TS 获取权威实体数据。
- 增加 `scalar_gets/scalar_sets/batch_calls/live_units` 指标，地图容量报告固定采集该组指标。
- 迁移阶段的 A/B runner、TypeScript 数据后端和专用配置开关已经删除；历史报告继续保留作决策证据。
- 3500 玩家/16 Gate 下，Rust 的 Map CPU 中位数从 54.3% 降至 50.6%（-6.8%），p99 从 216.22ms 降至 210.33ms（-2.7%），工作量差异小于 0.1%。
- 直接 protobuf 广播轮次中，Map CPU 从 55.1% 降至 48.1%（-12.8%），p95/p99 降低 17.7%/6.3%，两边工作量约为 7 万 item/s。
- 阶段结论：长期目标升级为“Rust 拥有 Entity/Component 跨帧权威状态，TS 使用生成句柄并保留 Handler/Actor 语义”，按数据域逐步迁移。
- 下一步设计通用 protocol projection codegen、句柄调试器与热更状态迁移；不可覆盖事件仍使用普通 Message/Event 广播。

## Phase 3：可复用 TypeScript Client SDK

计划：

1. 从 ProtocolModel 生成完整 TS SDK 文件夹。
2. SDK 包含帧、RPC pending、超时、断线、Push 订阅与错误模型。
3. Transport Adapter 隔离 WebSocket、Cocos Native Socket 和平台差异。
4. 验收矩阵：Cocos Web、PixiJS/H5、Cocos Native Windows。
5. SDK v2 再评估微信/抖音小游戏，无账号环境不作为 v1 阻塞项。

完成状态：Phase 3 已完成。公共 SDK 以 `client_sdk/typescript` 为唯一源码，codegen 生成协议 Client、协议指纹并向 Cocos/Pixi 分发完整副本；Runtime 已覆盖有界 Update 队列、RPC pending/超时/断线、Push、错误模型与不支持协议检查。Cocos Web 完成 Creator Preview bundle，PixiJS/H5 完成 Edge 自动登录进图，Cocos Native Windows 延续已通过的 TCP/KCP 全链路验收。SDK v2 的微信/抖音小游戏 Adapter 等具备账号与真机后再立项。

## Phase 3.5：状态复制基础

完成状态：

- 固定逻辑帧增加 `Update -> LateUpdate -> FrameFlush` 三阶段，帧尾同步不再依赖 Component 注册顺序。
- Numeric 改为 Rust Unit 上的动态 `NumericType -> i64` 值表和 dirty 表；TS 仅持有 Unit handle并通过`bigint`保留`numeric[type]`业务写法。
- Rust 在帧尾直接生成 Numeric protobuf Delta，通过 revision 执行 `Peek -> Send -> Ack`，失败不清脏。
- latest 广播支持复合键，Numeric 使用 `(unitId,numericType)` 合并。
- `.native v0.12.0` 支持 `@replicated`、`@memberId(1..63)`、`u64` dirty mask、字段 revision、强类型 `XxxDelta` 以及可靠的 `Peek/Ack` 生成。
- Cocos 与 Pixi 客户端按 NumericType 应用增量；动态 dirty map 与固定 mask 有独立微基准。
- Snapshot 已与 Dirty 分离，玩家进入通过 `G2C_EnterMap` 定向取得实体 Numeric 和 Item 全量数据，不再调用 `MarkAllDirty`。
- Core `StateReplicationSystem` 统一调度 Numeric 与 Player 固定字段来源；发送成功才 Ack，发送期间的新修改不会被旧 Ack 清除。
- ItemComponent 演示不可覆盖的即时事件：`UseItem` 修改 Rust 数据后立即推送 `G2C_ItemChanged`；速度效果则作为 Player 固定字段在帧尾合并。
- 本阶段不实现接收者空间筛选；状态提取、编码和广播对象选择保持彼此独立。

## Phase 3.9：Phase 4 准入收尾

状态：完成（2026-07）。

- 修正拆分进程 Numeric 稳定性验收：进入地图全量快照提供初始值，后续脏增量只要求变化字段，不再错误等待未变化的 MaxHp。
- protobuf opcode lock 成为发布契约；新增消息必须显式更新，历史编号不允许静默变更或复用。
- protobuf schema lock 同时固定消息基类、RPC Response 关联以及字段编号、名称、类型和 repeated 语义；协议变化必须显式更新两份锁。
- `uint64/int64` 在服务端和 TypeScript Client SDK 统一为无损 `bigint`，并覆盖边界值与 repeated 默认值回归。
- Watcher 对 Windows/Linux 子进程使用统一控制管道，等待 TS `onStop` 与玩家保存，超时才强杀且向操作员返回失败。
- Watcher 会检测任一子进程提前退出，优雅关闭其余进程后整体失败；自动重启仍保留给 Phase 5。
- Process 可选提供 `/live` 与 `/ready`，就绪状态覆盖端口绑定、TS Scene 启动屏障和停机摘流；`/metrics` 已在 3.10.4 以最小形态接入。
- 新增只读生成物校验、快速质量门和包含拆分进程、mailbox、背压、Watcher 的完整 `npm run verify`。
- Core、Model、Hotfix与Rust宿主建立中英文函数注释规范，并由`verify:comments`自动检查，重点记录副作用、生命周期、不应怎样使用以及设计原因。
- 已准备按分钟指定时长的完整链路长稳入口和 RSS/V8 Heap 每小时增长报告；10 小时正式样本使用 `--minutes 600`，由专用空闲机器手工执行，不纳入日常 CI。

## Phase 3.10：框架稳定化

已发布版本：`0.3.10`。

本阶段不扩展MMORPG业务，集中验证框架在接口演进、异常、断线、过载、热更和发布场景下的确定性。子编号是工作项，不使用`0.3.10.1`等四段版本号；重要预发布节点使用`0.3.10-alpha.N/beta.N/rc.N`。

### Phase 3.10.1：公共API冻结

状态：完成（2026-07）。

- `Cargo.toml`成为项目版本源，`package.json`、lockfile和README由`verify:version`检查一致性。
- Runtime支持`--version/-V`，启动结构化日志携带版本。
- `app/core/public.ts`成为服务端业务唯一Stable入口，其他Core实现路径默认Internal。
- `public-api.lock.json`锁定TypeScript真实导出集合；变更必须显式评审并执行`core-api:update-lock`。
- 自动拒绝Demo深层import Core、Core反向依赖Demo/Generated。
- 最小业务夹具只依赖Stable入口定义EntryScene、Unit、Component和Handler。
- Demo与当前教程迁移到公共入口，未改变运行时语义。

### Phase 3.10.2：RPC与Actor正确性

状态：完成（2026-07）。

- `SceneCallContext`预留在途`rpcId`，uint32回绕时跳过未完成调用；Response继续校验msgcode、payload id和错误码。
- 显式本地timeout使用Host timer，远程timeout由Rust transport管理；迟到或重复Response只记指标，不会完成其他调用。
- 连接断开拒绝该连接全部等待者；Process停机拒绝TS bridge pending操作并清空未提交队列。
- Actor销毁拒绝排队调用，旧InstanceId永久失效，正在await的旧实例不能返回成功。
- ordered跨await保持串行；unordered允许并发和自调用，单个异常相互隔离。
- RPC框架错误返回对应Response；单向Message只记日志和指标，不生成ErrorResponse。
- 新增`test:rpc-actor-correctness`和Rust transport状态机矩阵，并接入`verify:quick`。

### Phase 3.10.3：故障注入

状态：完成（2026-07）。

- 新增`test:fault-injection`一键矩阵，并拆分Core快速夹具和Runtime真实故障两个入口。
- Process退出在所有端口就绪后终止真实Watcher子进程，断言兄弟进程清理和非零退出。
- Inner断线、慢客户端和队列过载分别验证pending清理、定向断连和有界背压。
- Handler异常与非法帧验证错误返回、单向Message语义和故障后继续服务。
- 5000次Location换代与1000次Gate Session改绑验证迟到断线不会破坏最新所有权。
- Repository固定失败验证错误传播、保存幂等和无重复写入。
- 故障注入只存在于测试Fake、测试进程和Rust测试模块，不增加可误启用的生产配置。

### Phase 3.10.4：Prometheus与Grafana

状态：完成（2026-07）。每个 Process 通过健康端口提供 `/metrics`，Target 按 `StartMachine.json` 中实际启动清单原子生成；延迟使用可跨 Process 聚合的 Histogram，Grafana 已提供核心运行诊断面板。

- `/live`、`/ready` 继续输出生命周期 JSON；新增`/metrics`输出 Prometheus 文本格式的 `tiangz_process_live`、`tiangz_process_ready`、`tiangz_process_uptime_seconds`。
- 提供 `tools/observability/docker-compose.yml` 与 `docs/reference/observability.md`，默认在 `http://127.0.0.1:3000`（Grafana）访问。
- `/ready` 使用 V8 Runtime 心跳识别“HTTP 仍响应但业务线程卡死”；Prometheus 提供 12 条基础告警判定规则。
- 自定义 Scene 指标显式区分 Counter/Gauge；`verify:observability` 验收 Target、Dashboard、规则、Histogram 与累计 Counter。
- 多机部署使用 `StartMachine.innerIp` 作为抓取地址；远程 Process 必须监听管理 IP 或 `0.0.0.0`，不得用 loopback 伪装成可远程抓取端点。

### 0.3.10-alpha.3：业务目标模型收口

状态：完成（2026-07）。

- Actor收口为Scene、Session、Unit三类mailbox目标的统称，业务不再继承泛化Actor基类。
- Login删除永久`LoginActor`；Login与Gate的客户端消息进入连接Session mailbox。
- GateSession成为Entity，由SessionComponent统一创建、索引、断线销毁和停机清理。
- Unit Handler公共API改为`unitRpcHandler/unitMessageHandler`，与Session Handler、Scene Handler形成三种明确入口。
- 配置EntryScene与动态Scene统一挂入ProcessHost的EntityRoot和MailBoxComponent。
- 新增同连接跨`await`串行、不同连接并行、断线销毁测试；单进程和拆分进程完整冒烟均通过。

### 0.3.10-alpha.4：工程边界清理

状态：完成（2026-07）。

- 删除LogScene演示链、旧字符串Actor Handler旁路和未使用的协议基类。
- 正常构建只装配Demo，Bench改为`build:bench`显式入口。
- 客户端协议只生成到规范TypeScript SDK，Cocos/Pixi分发副本不再携带Bench。
- opcode生成器沿用历史lock并跳过删除消息保留号，不要求业务手写编号。
- 删除旧3D Cocos空项目和历史压测流水，只保留各基准latest摘要。

### Phase 3.10.5：TypeScript热更闭环

状态：完成（2026-07-27）。`0.3.10-alpha.5`明确把TS拆成绝对不可热更的Model与可热更Hotfix；`alpha.6`加入`@systemFor`，让Model拥有状态、字段、构造、继承和稳定身份，Hotfix拥有生命周期、领域方法和Handler；`alpha.7`把Hotfix改为固定脚本名IIFE，补齐慢RPC、Timer和连续100 generation资源长稳。Runtime支持不可变候选目录、实际文件与Model/Core/协议/Native schema指纹校验、隔离V8预检、staging registry、Watcher Reload、Rust有界投递屏障、超时拒绝、prototype/Handler事务提交和失败回滚，现有Entity/Component与Rust handle不重建。codegen从System公开方法生成Model类型声明，Model不再维护抛错空壳。`npm run dev`在本地初次完整构建后监听Hotfix，自动完成生成、类型检查、不可变候选构建和Reload；正式部署仍只接收不可变候选，不执行源码监听。

3000玩家基线与1Hz Reload各3轮已完成：Move吞吐中位数差异`+0.02%`，90/90次Reload成功且无错误；Reload组Probe p95/p99约增加`31.91%/31.14%`，说明切换屏障有可测尾延迟。8秒慢RPC使屏障等待约`7.7s`后提交；一次性与重复Timer跨generation调用当前prototype；100次Reload到generation 101后，损坏候选被拒绝，Timer、Native实体和pending无漂移，预热后的V8 Heap/RSS增长通过`4MB/16MB`硬门槛。第一版必须排空到零再切换，不做字段migration，也不允许Model在线替换。详见[Process级TypeScript热更设计](design/typescript-hot-reload.md)、`perf/results/hotfix_latest.md`与`perf/results/hotfix_soak_latest.md`。

### Phase 3.10.6：性能回归门

状态：完成（2026-07-26）。`npm run verify:perf`统一执行RPC payload、local/remote Inner RPC和Numeric/PlayerInfo/Item状态复制，三轮取中位数并按机器身份比较吞吐、p99与错误；Windows物理机和Linux虚拟机已有独立版本化基线并通过比较模式。`perf:gate:update -- --reason ...`是唯一基线更新入口。完整链路、背压和长稳继续由各自专项测试负责。

### Phase 3.10.7：发布与跨平台收口

状态：完成（2026-07-26）。核心Runtime、mailbox和背压入口已迁移为跨平台Node runner；固定Rust 1.97.1、Node 24和npm 11，增加Windows/Linux CI、依赖审计策略以及携带版本和SHA-256的Release制品。Windows和Ubuntu Linux均通过完整`verify`、0 advisory依赖审计，以及最终制品目录内的登录、进图、状态同步和移动smoke。

### 0.3.10-alpha.9：子Entity与领域设计规则

状态：实现完成，等待本轮提交与Release候选总验收。

- Core提供Component拥有的ChildEntity生命周期语义，Item迁移为真实子Entity，并增加独立性能基准。
- 固化Buff生命周期事件、Quest活动实例与完成配置ID、Audience和同步语义，避免把“需要被看见”错误等价为Actor或通用Dirty Delta。
- `docs/patterns`成为领域设计原则入口；Developer Tools `v0.13.0`提供确定性设计核心、VS Code向导、聊天解释、CLI与只读MCP服务。
- 设计助手不生成业务代码，不覆盖工程检查、Generated锁和测试；主工程已固定`v0.13.0`并用`verify:design-rules`阻止规则与文档漂移。

### 2026-07-26成熟度审计

状态：R1至R4实现与专项验收完成，`0.3.10-rc.1` Windows与Linux最终矩阵、依赖审计、制品smoke和哈希校验均已通过，`v0.3.10`作为首个稳定框架基线发布。详细证据与验收条件见[Phase 4前框架成熟度审计](design/framework-readiness-audit.md)。

## Phase 4：MMORPG 业务扩展

状态：已进入`0.4.x`开发线；Phase 4.0空间契约、Phase 4.1 Rust AOI、Phase 4.2.5导航动态障碍和Phase 4.4最小怪物闭环已完成，复杂战斗与持久化仍在后续阶段。

计划：

- 已固定Luban 4.10.2工具链，建立`game_config` Excel源目录、服务端/客户端分组生成、只读强类型查询、外键校验、配置指纹与自测；首批接入`ItemConfig`、`MapConfig`和不含等级成长数据的`PlayerConfig`。表结构属于不可热更Model，纯数据可生成内容寻址候选并由Watcher令各Process原子切换；部署配置仍独立留在`configs`。
- 账号/角色选择与持久化。
- 地图生命周期与传送已统一：静态与动态地图共享MapHost实现，`staticMapIds + acceptDynamicMaps`区分静态专用、动态专用和混合承载。动态副本由单例MapManager按稳定requestId幂等分配；MapHost每5秒注册/心跳。Location把MapHost Endpoint随MapInstance和玩家位置返回，新增空载副本Host无需进入其他进程knownScenes即可完成首次进入、Actor路由、跨图传送和销毁。稳定启动目录通过`knownSceneFiles`集中复用。Manager与MapHost同时丢失后的持久幂等、死亡节点接管和事务自动恢复仍留给Phase 5高可用。
- Rust AOI功能链和Windows容量工具已经落地：`.native`生成Unit/Item类型池、Unit冷热结构与访问器，稀疏Grid推导默认可见关系，Rust只保存迟滞关系、过滤拒绝和本帧净变化；TS NativeRef、Rust Pool、AOI规模和分阶段背压均已可观测。历史单Grid与5Hz结果只保留为边界证据。正式3000玩家、16 Gate、10×10 Grid均匀分布基线已经完成：每Grid 30人，其中80%在Grid内移动、20%每2秒跨Grid一次；实测跨Grid `310.3/s`、Move `6004.2/s`、Map CPU平均`82.1%`，错误、过载和背压均为0。该结果略高于80% CPU目标，定位为接近容量边界的回归基线，而不是保守容量点。
- 从2026-08-01起，新容量基线默认采用每玩家`2Hz`（500ms）持续移动心跳与`0.2Hz`（5秒）MapProbe；按下、转向和停止仍立即发送，Gate Ping保持5秒一次。AOI Cold配置固定为3×3 Enter/20Hz与5×5 Detach/5Hz，不再使用7×7/1Hz。历史负载结果只保留原口径，不与新行为基线直接横向比较。
- 3000人AOI密度矩阵已经覆盖10×10、15×15和20×20 Grid。扁平Grid与连续位图改造后，Map CPU平均由旧`74.1%/56.7%/57.3%`降至`55.0%/50.7%/42.9%`，正式窗口均无错误、过载、超时和背压。`perf:map-capacity:grid-matrix`支持一键回归，`--report-runs`可在单档复测后从三份有效原始报告重建矩阵；Bench后置Place RPC仍会在稀疏地图形成初始化突发，后续应并入Bench进图事务。
- Map 级同步策略：允许不同地图分别选择状态同步、帧同步或高频状态同步；逻辑 Tick、状态广播和客户端渲染频率保持解耦。先完成普通状态同步与 Rust AOI，再为竞技场等独立地图接入帧同步，不把同步模式做成全局 Runtime 配置。
- 怪物 Actor、巡逻、仇恨和战斗。
- Location Scene基础已完成，支持按UnitId/account定位Gate/MapHost/Actor、批量解析和迁移锁；Online/Presence业务索引后续按需求增加。
- Guild/Friend/Chat 等 EntryScene + Component 业务域。

### Phase 4.0：3D空间契约冻结

状态：完成（`0.4.0`）。

- 服务端坐标统一为地图局部米制`X/Y/Z + Yaw`：X/Z为地面，Y为高度，Yaw为绕Y轴弧度；坐标必须与`MapInstanceId`一起解释。
- Grid2D统一使用`cellX/cellZ`和`inputX/inputZ`，Rust权威位置改为米；Cocos 2D与Pixi仅在客户端适配边界把X/Z映射到屏幕X/Y。
- Luban `MapConfig`增加`SpatialMode`、三维出生点、米制Cell、AOI配置引用以及导航资源`asset/version/hash`。
- Rust空间状态按MapInstance创建和释放；NavMesh只读资产未来按MapConfig与版本共享，AOI、动态障碍和Unit状态始终按实例隔离。
- 协议、Native schema与客户端SDK完成显式破坏性升级；旧`0.3.10`客户端不得连接`0.4.x`服务端。
- 详细契约见[地图空间与3D坐标契约](design/spatial-world.md)。

### Phase 4.1：Rust AOI

状态：功能链、Runtime冒烟和Windows正式地图容量回归已完成；Linux/分布式空间负载和真实业务容量仍待后续阶段验证。

- 已在`MapInstanceId`私有空间中建立Rust稀疏AOI索引；`AoiConfig`把AOI Grid大小、Enter范围、Detach迟滞范围分开，`AoiSyncTierConfig`再独立定义已可见关系的可覆盖状态频率。Enter内默认关系从Grid推导，仅迟滞外圈、业务拒绝项与本帧净变化需要存储，不在Rust或TS物化全量关系边。全部空间和AOI表为Cold配置，必须重启才能变更。
- 玩家是Observer+Subject，自身状态单独保留；后续怪物/NPC支持Subject-only。完整组件图提交后Attach，退出/传送先Detach，Rust拒绝销毁仍挂载的Native Unit。
- FastOP修改X/Z自动标记空间脏，同AOI Grid不扫描，跨Grid才重建相关边。阵营、隐身、位面通过同步业务过滤器收窄候选关系，业务状态变化必须显式Invalidate。
- Movement、Numeric和Unit固定字段在Rust编码；默认按变化Subject所在Grid求受众，并把相同受众继续合成一份frame，不展开接收者乘记录数的临时矩阵，只有带业务拒绝覆盖的Subject计算精确受众。Movement在Rust内利用Attach时登记的紧凑delivery route直接生成每个Gate的完整内网批帧，TS不再接收recipientId数组或重复编码protobuf；Numeric、UnitState和Event保留通用BroadcastHub路径。全部发送成功后才Ack。
- 跨AOI Grid的Enter/Leave仍是不可覆盖事件，但同帧相同受众会批量编码为`G2C_AoiDelta`；Cocos 2D、Pixi和Runtime smoke已适配。容量工具会保留失败诊断并报告跨Grid/可见变化速率。
- 进图初始视野已与`EnterMap`大RPC解耦：客户端注册`G2C_AoiDelta`后调用`GateClient.mapSnapshotReady`，Gate校验路由，MapHost通过既有批量广播下发。后续优化重点是初始视野的区域共享、分批和受控下行，不再直接扩大`entryPlayersPerTick`。
- 业务广播新增逻辑`ClientAudience`：`ObserversOf/VisibleSubjectsOf`明确AOI关系方向，`Self/ForUnits/Union/Intersect/Except`组合自己、队伍和公会等受众；`ClientBroadcast`隐藏Gate、连接和跨地图Location解析。Buff协议以公开Event和受限latest详情验证字段Projection，TypeScript Client SDK提供引擎无关的revision合并与移除墓碑。
- all-in-one与split-process Runtime smoke均已验证同屏可见、跨边界Leave、范围外不再收到新移动sequence、返回后Enter。容量工具现以3000玩家、16 Gate、均匀分布的80/20移动画像为默认基线，并要求实际跨Grid速率达到理论值的80%至120%；首轮10×10结果固定在`perf/results/map_capacity_20260801_015926.md`，10×10、15×15、20×20对照写入`perf/results/map_capacity_grid_matrix_latest.md`。旧单Grid和历史5Hz结果只保留原口径。
- Prometheus与Grafana已增加AOI World、Entity、Grid、候选关系、最终关系、跨Grid、关系变化和过滤覆盖指标。
- 分阶段指标已经区分Process `frame/completion/disconnect/shutdown`等待，以及Transport `manager/connection/call-writer/send-writer`过载。容量报告仅使用正式窗口Counter增量判定稳态，生命周期峰值只用于解释历史洪峰；后续优化必须继续先定位责任阶段再做同拓扑A/B。
- 进图洪峰增加独立A/B链路：MapHost、ID分配、Player创建、Location、Admission、AOI Attach、新玩家Snapshot、老玩家Enter与Gate下行均可分别计数。Bench支持`attach-only/new-observer-only/existing-observers-only/full`四种模式，只有`full`拥有正式语义；容量结论禁止采用残缺诊断模式。

### Phase 4.2：NavMesh3D

状态：4.2.5 动态障碍、实例隔离和Cocos 3D开关门验收已完成。

- 固定并接入Recast/Detour兼容的tiled NavMesh资源格式，校验`navigationVersion/navigationHash`。
- Rust实现位置投影、寻路、射线、高度查询、动态障碍与地图实例生命周期。
- TS只调用粗粒度空间API，不逐节点跨越V8边界，也不在TS保存第二份权威坐标。

4.2.1已经固定官方Recast/Detour `v1.6.0`与上游提交，增加确定性灰盒OBJ、冷烘焙清单、`npm run navigation:bake`一键离线烘焙、稳定小端tiled资源格式和SHA-256元数据。Rust安全封装已完成资源加载、Hash拒绝、位置投影、绕障寻路，以及按Hash弱引用共享的资产缓存；同一输入重复烘焙必须字节一致。该阶段不要求美术地图，也不把Cocos资源导入或运行时烘焙混入服务端。

4.2.2已按冷配置在Map创建时加载NavMesh3D，按Hash共享不可变资产并为每个MapInstance创建独立查询上下文；Map 100完成出生点投影、AOI接入、真实单/拆分进程传送和`ProjectPosition/FindPath`粗粒度FastOP。`C2M_FindPath`只做Actor路径查询，不修改权威坐标。新增导航资产/实例Prometheus指标和受信项目根目录路径校验。

4.2.3新增`C2M_NavigateTo/C2M_NavigateInput`意图与`G2C_EntityNavigate`可覆盖状态。Rust从权威坐标寻路、持有路径和当前拐点，并由20Hz固定Tick连续推进`x/y/z/yaw`；TS每次目标或方向变化只跨一次Native边界。方向输入使用500ms短路径续期，零输入明确停止；后退和横移保留角色朝向。3D位置沿用Rust AOI同步档位和Gate批量路由，开始、换目标、停止强制立即发送。Cocos 3D支持左键寻路、W/S前后、A/D转向、按住右键时A/D横移和尾随相机；本地预测以权威Push纠偏，远端玩家只插值。

4.2.4将方向输入从“500ms重复生成短路径”改为Rust持有`forward/strafe/yaw`，每个20Hz Tick调用Detour `moveAlongSurface`贴地推进。Unit缓存当前polygon引用，撞墙不能穿越并允许沿边界移动；客户端每500ms续期1.5秒输入租约，断续期后Rust自动广播停止。新增`MapComponent.Raycast/SampleHeight`粗粒度查询，前者只检测NavMesh边界，不代替技能物理碰撞。Cocos方向预测只积分本地输入，墙面和高度误差由Rust权威Push校正；左键点击仍保留完整路径走廊。

4.2.5将导航资源升级为包含压缩高度层的v2格式；共享资产只保存不可变模板，每个MapInstance独立构建`dtNavMesh + dtTileCache + Query`。业务通过稳定地图内`ObstacleId`调用`MapComponent.UpsertNavigationBoxObstacle/RemoveNavigationObstacle`并提交真实物理尺寸，Rust按烘焙`agentRadius`扩张X/Z占用、合并同ID目标状态并按每Tick 16条命令、4个Tile的预算更新。障碍版本提交后，已有点击路径在Rust自动重算；方向移动继续直接查询最新表面。Prometheus Map指标包含障碍数、等待命令、重建Tile、耗时和失败。Cocos 3D以`E`键开关灰盒门，并为本地预测增加非权威防穿约束；真实all-in-one与split-process A/B均得到开门2点、关门4点、再开门2点。

### Phase 4.3：Cocos 3D Demo

状态：Cocos Creator 3.8.8灰盒、权威点击移动、本地纠偏、远端玩家插值和手机Web第一版已可运行；手机包使用`web-mobile`并部署在外网演示路径`/m/`。

- 已完成公共SDK、`Vec3`边界转换、Map 100登录、点击权威寻路、魔兽式方向输入、尾随相机、预测/校正和多人插值；正式角色资源继续按业务需求补充。
- 已完成手机Web第一版：左下虚拟摇杆控制前后与转向，右侧单指拖动控制环视，双指捏合调整相机距离，点击地面继续寻路，HUD按安全区和小屏尺寸适配；手机端和桌面端共用同一套WebSocket SDK与协议。
- 保留Cocos 2D与Pixi Grid2D回归，证明SDK协议结构不依赖具体引擎坐标类型。

### Phase 4.3.1：Unreal Engine 5.4.4客户端

状态：C++ SDK骨架、UE Runtime插件和Map 100灰盒主链已经完成；正式美术资源与Native TCP/KCP Adapter按项目需求后续增加。

- Proto生成引擎无关的C++20结构、Codec、msgcode、RPC/Push描述符，不依赖Google protobuf runtime；生成结果由`codegen:cpp-client-sdk`复制到UE插件ThirdParty目录。
- UE插件只实现WebSocket Transport与游戏线程Update，不把UObject、FVector或UE生命周期泄漏进公共SDK；选择未实现的TCP/KCP会立即报错，不能静默降级。
- Demo贯通LoginMgr、Login、Gate、Map 100、AOI Enter/Leave、Numeric、权威Navigate和5秒Gate Ping；地图坐标只在表现边界转换为UE厘米制与Z-Up。
- UE Automation覆盖嵌套消息、64位整数、RPC ID、未知字段和损坏包；MSVC 14.38与UE 5.4.4 Editor目标完成编译及真实WebSocket冒烟。
- UE灰盒已接入与Cocos相同的`Map.ToggleDemoDoor`：`E`键请求服务端开关门，响应后才显示或隐藏同坐标红门；UE不做本地位置预测，Actor不参与本地导航和碰撞判定，统一服从Rust含Agent半径的权威结果。

### Phase 4.3.2：Godot 4.7.1客户端

状态：Godot空工程已接入WebSocket登录、Map 100、权威NavMesh移动、动态门、Ping和基础AOI；Godot协议Codec已经接入主工程生成链路，TCP/KCP Adapter后续补齐。

- 使用Godot内置`WebSocketPeer`，不把Godot节点或`Vector3`泄漏进公共协议SDK。
- GDScript适配层按`Proto读取 -> WebSocket/RPC -> Godot表现`分层，主场景只处理输入、相机和单位表现。
- 左键寻路、W/S方向移动、A/D转身、`E`动态门和5秒Ping与Cocos3D、UE保持同一服务端语义。
- Godot只插值Rust通过`G2C_EntityNavigate`广播的权威位置，不复制NavMesh、TileCache、碰撞和Agent半径。
- `codegen:godot-client-sdk`从Proto锁文件生成完整GDScript字段Codec和消息常量；Godot演示仍只使用其中的Map 100业务流程，但不再维护手写协议子集。

### Phase 4.3.3：Unity 2022.3 C#客户端

状态：C# SDK源码、协议生成、Unity 2022.3灰盒Demo已完成；当前只验收桌面WebSocket，不把Unity特定类型带入公共协议层。

- `client_sdk/csharp/`是C# SDK唯一源码，`codegen:csharp-client-sdk`从Proto锁生成消息、Codec、协议描述符、类型化Client，并复制到Unity `Assets/TiangZClient/Runtime`。
- SDK网络线程只接收并排队，Unity主线程通过`RpcSocket.Update()`分发Push和完成RPC；超时、断线、入站队列溢出和未知消息有明确错误语义。
- Unity Demo只编排登录、进图、AOI、权威寻路、WASD、点击寻路和Ping；`UnityEngine.Vector3`只能出现在表现边界，协议继续使用米制`x/y/z/yaw`。
- 当前C# Adapter只提供桌面WebSocket；TCP/KCP Adapter另立验收，不在Unity Demo中伪装支持。

### Phase 4.4：怪物与战斗

状态：最小完整流程已完成，复杂战斗仍未开始。

- 已完成`MonsterConfig`和`MonsterAreaConfig`冷配置，以及`MonsterComponent + MonsterUnit`的统一Unit模型。
- 已完成固定刷点、主动/被动模式、地图Tick追击、攻击距离、玩家攻击、Numeric扣血、死亡尸体、AOI Leave、原槽位重生和运行时冒烟验收。
- 已完成`C2M_AttackMonster -> PlayerUnit.AttackMonster -> MonsterComponent.Attack`的最小业务调用链；Handler不遍历地图、不直接操作Native句柄。
- 暂不实现随机刷怪池、巡逻路点、仇恨表、技能、掉落、战斗事件、持久化和角色/怪物动态避障；这些在最小闭环稳定后再按业务需求拆分。

### Phase 4.5：持久化基础

状态：仅完成设计讨论，尚未实现；调整为`0.4.x`最后一个基础阶段，在正式账号、角色和经济业务前实施。

- 建立独立、可按玩家ID分片的Rust `PersistenceProxy`，业务Handler继续只依赖`PlayerRepository`/领域Component，不直接访问Redis或永久数据库。
- 扩展`.native`持久化元数据，按Entity/Component声明`transient`、`snapshot`或`transactional`存储域；codegen生成稳定MemberId、快照codec、dirty收集、schema版本和恢复入口。存储结构属于Model，不能热更。
- `snapshot`字段保持普通属性写法；Rust setter只标脏，框架按短窗口合并并批量写Redis，再异步批量落永久数据库，禁止一次属性赋值对应一次网络请求。
- `transactional`存储域用于Wallet、Inventory、Trade等经济数据；字段不开放普通setter，只能通过领域事务方法修改。永久数据库提交是权威写入，Redis只接收带revision的事务结果缓存，不能成为第二个独立写入口。
- 同一字段只能属于一个一致性域；按Runtime、Wallet、Inventory、Quest等域分别维护revision，禁止巨型PlayerSnapshot跨域盲覆盖。跨域原子操作使用DB事务或可重放业务事件。
- 第一版只选择并完成一个永久数据库Adapter以及故障矩阵，不同时实现MongoDB、MySQL、PostgreSQL三套最低公共抽象；领域Repository接口保留后续替换空间。
- 验收覆盖进程崩溃、Redis短暂不可用、永久DB不可用、重复/乱序请求、幂等重试、积压背压、下线Flush和恢复；Prometheus至少暴露dirty数量、最老待落库年龄、Redis/DB延迟、失败、重试和版本冲突。

## Phase 5：生产工程化

计划：

- 生产化现有 Prometheus/Grafana：Alertmanager 通知路由、node/windows exporter、认证与 HTTPS、保留期和长期存储、HA。
- 接入 Loki 与跨进程 traceId/分布式追踪，统一日志、指标和 Trace 下钻。
- 已将 I/O Backend 与 Endpoint 协议拆为两个维度：`EpollIoBackend/UringIoBackend` 负责操作系统 I/O，`tcp/websocket/auto/kcp` 负责传输协议。KCP 已完成官方 C v1 静态集成、Outer Profile、Challenge 握手、UDP 会话、超时/CLOSE、Rust smoke 和 Cocos Native Windows 全链路；Inner KCP 要等内部身份认证后开放。io_uring TCP 已完成多帧接收、批量发送和与 epoll 同口径的完整链路报告；默认仍为 epoll。后续补多 Endpoint、注册 Buffer、KCP 弱网/长稳和攻击面测试。
- Process 监管、优雅退出、滚动更新和崩溃恢复。
- 配置中心、服务发现和生产级 Inner 身份认证。
- TS Hotfix 边界、版本校验、回滚和状态迁移。
- 压测基线：单地图容量、AOI 广播、跨进程 RPC 和内存稳定性。
- 容量规划与部署建议延后到Rust AOI、首版怪物/战斗和持久化负载完成后实施。届时按空载在线、移动同步、主城AOI、普通战斗和高密度战斗分别校准，自动爬升负载并以CPU、吞吐、p95/p99、队列趋势和错误共同确定推荐容量、准入上限、Gate数量及Process数量。当前`perf:gate`只负责框架性能回归，`perf:map-capacity`只记录明确负载下的容量证据，不生成生产推荐人数。

## 当前验收命令

```powershell
npm run verify:quick
npm run verify
npm run perf:full-chain
```

`verify:quick` 用于日常开发；修改进程、协议、mailbox、背压或生命周期边界后，合并前执行完整 `verify`。

阶段历史文件保留旧实现数据，但当前架构事实以 README、tutorials、reference 和 maintainer-guide 为准。
