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
- Core、Generated、Demo 目录边界。
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
- LoginActor 同账号有序 mailbox。
- GateSession 登录、重连和断线生命周期。
- MapHost 创建多个 MapScene；UnitComponent 统一管理 PlayerUnit/MonsterUnit/NpcUnit。
- 服务端权威移动、多人 AOI 可见性和实体进出 Push。
- Cocos 2D Preview 可多开互相看到移动。

### Phase 2.11：ET 风格 Entity/Unit/Actor 统一

状态：完成（2026-07）。

- ProcessHost.Root 建立 InstanceId -> Entity 的 O(1) 生命周期索引。
- Entity 区分业务 Id 与生命周期 InstanceId，并具有 Parent/DomainScene。
- Actor 自动挂载 MailBoxComponent；旧 InstanceId 在重建后失效。
- UnitComponent 作为 MapScene 的统一 Unit 集合，玩家和后续怪物共享模型。
- PlayerDirectory 仅承担账号重连辅助索引，不参与普通 Actor 消息定位。
- ActorLocationEnvelope 携带 InstanceId，Actor Handler 直接取得 PlayerUnit。
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
- 已在 Demo 业务层按 Gate 聚合 `M2G_EntityMove(targetUnitIds)`；它不是框架对广播语义的假设。
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
- 单连接 response 复用 connectionId 二进制表示，`packFrame` 只分配最终帧；Actor Handler 首次按 `instanceof` 匹配后按构造器缓存。
- Process 提供 `low-latency`、`throughput`、`adaptive` 三种调度模式；默认 adaptive 在高负载下使用微秒级 yield 聚合，避免 Windows 亚毫秒定时器放大延迟。
- 200 玩家、8 Gate、全员 10Hz 移动下，约 40 万 recipients/s 合并为 1.62 万 batch/s，V8 到 Rust 的帧复制带宽约为逻辑下行的 1/25。
- 批量 Bridge 后最忙 Gate 三轮中位 CPU 从 197.9% 降至 137.9%；下一层瓶颈是逐连接 writer enqueue 和网络消息数量。
- 2026-07-20 第三轮优化后，600 玩家、8 Gate、单 MapHost、每玩家 70Hz Probe Only 的完整链路三轮中位数为 4.20 万 RPC/s，Map CPU 54.3%，p50/p95/p99 为 4.05/8.23/10.38ms，最忙 Gate 平均/峰值 CPU 为 66.3/85.9%，三轮均为零 RPC 错误、零 transport overload、零 Process 背压。同一负载口径在本轮开始前的短时单轮样本为 Map CPU 89.1%、p95/p99 5.87/8.22ms；CPU 明显下降，聚合引入了约 1 到 2ms 的可控尾延迟。该结果仍是纯 Probe 框架基线，不是业务容量承诺。
- 默认性能命令升级为 60 秒、三轮中位数，并采集服务端与压测端 CPU/RSS/GC；支持独立压测机。
- 网格 AOI 保留到 Phase 4，当前继续用全地图可见性验证链路和聚合收益。
- 可重复命令、指标口径和报告位置见 `perf/full_chain/README.md`。

## Phase 3：可复用 TypeScript Client SDK

计划：

1. 从 ProtocolModel 生成完整 TS SDK 文件夹。
2. SDK 包含帧、RPC pending、超时、断线、Push 订阅与错误模型。
3. Transport Adapter 隔离 WebSocket、Cocos Native Socket 和平台差异。
4. 验收矩阵：Cocos Web、PixiJS/H5、Cocos Native Windows。
5. SDK v2 再评估微信/抖音小游戏，无账号环境不作为 v1 阻塞项。

## Phase 4：MMORPG 业务扩展

计划：

- 账号/角色选择与持久化。
- 地图传送和动态副本 Directory。
- AOI 数据结构与批量广播优化。
- 怪物 Actor、巡逻、仇恨和战斗。
- Location/Online Scene，支持按 UnitId 定位 Gate/Map。
- Guild/Friend/Chat 等 EntryScene + Component 业务域。

## Phase 5：生产工程化

计划：

- 结构化日志、traceId、指标导出和分布式追踪。
- 提供 Prometheus 指标端点和 Grafana Dashboard，将吞吐、p50/p95/p99、错误率、队列水位、背压、CPU、RSS、V8 Heap 与 GC 纳入长期观测。
- 在目标 Linux 上用同一协议、连接数、并发和 Payload 矩阵比较 epoll/io_uring；只有 Raw TCP、WebSocket、Inner TCP 全链路均有稳定收益时，才把 io_uring 提升为正式 Runtime Backend。
- Process 监管、优雅退出、滚动更新和崩溃恢复。
- 配置中心、服务发现和生产级 Inner 身份认证。
- TS Hotfix 边界、版本校验、回滚和状态迁移。
- 压测基线：单地图容量、AOI 广播、跨进程 RPC 和内存稳定性。

## 当前验收命令

```powershell
npm run check
cargo test --all-targets
npm run test:runtime
npm run test:mailbox-parity
npm run test:backpressure
npm run perf:full-chain
```

阶段历史文件保留旧实现数据，但当前架构事实以 README、tutorials、reference 和 maintainer-guide 为准。
