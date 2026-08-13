# 全链路性能测试

本测试用于观察真实 Demo 游戏链路。框架空 Handler 的 RPC 基线由 `npm run perf:rpc-baseline` 单独测试，避免把两种口径混在一份报告里。

## 测试链路

真实游戏链路：

```text
GetLoginServiceAddr
  -> Login
  -> 断开 Login，连接 Gate
  -> LoginGate
  -> EnterMap
  -> MapReady
  -> 循环发送 C2M_Move（IActorLocationMessage）
  -> Gate Core 自动定位 Unit 所在 MapHost 并转发
  -> 地图 Actor + NativeUnitRef/Rust 移动批处理
  -> MapHost 发布 latest 移动状态，BroadcastHub 通过通用 S2G_ClientBroadcast 按 Gate 聚合
  -> Gate 向 targetUnitIds 下发同一个批量 G2C_EntityMove
  -> 客户端收到自身 G2C_EntityMove，完成一次闭环
```

`all` 使用一个操作系统进程、一个 V8 和多个 EntryScene；`split` 使用六个进程，Scene 调用经过内部 TCP 和 rpcId 多路复用。

## 一键运行

在 `TiangZ` 目录执行：

```powershell
npm run perf:full-chain
```

该命令跨平台运行，Windows 和 Linux 使用同一个 Node 调度脚本。默认矩阵：

- 玩家数：10、50、100。
- 部署：`all` 和 `split`。
- 稳定负载：每个玩家目标 2Hz（500ms）持续移动心跳。
- 极限负载：每个玩家收到自身权威移动后立即发送下一条。
- 每个案例预热 10 秒、正式采样 60 秒、独立运行 3 轮并报告中位数。

开发期间可缩小矩阵：

```bash
npm run perf:full-chain -- \
  --mode all --players 10,50 --move-rates 2,0 \
  --warmup 2 --duration 10 --rounds 1
```

旧 PowerShell 调度器暂时保留为 `npm run perf:full-chain:legacy`，只用于历史结果复现。

## 真实业务链路

在普通移动链路之外，可以给每个玩家增加低频业务操作，验证背包、奖励/Action边界和技能施法是否在真实网络链路上工作：

```bash
npm run perf:business-chain -- \
  --mode all --players 50,100 --move-rates 2 \
  --business-rate 0.1 --warmup 10 --duration 60 --rounds 3
```

`business-rate`是每个玩家每秒的业务请求数。压测客户端交替发送1001道具使用和以自己为目标的3005技能施法；业务拒绝（例如公共CD或道具CD）计入`businessRejected`，只有超时、连接断开和协议解码失败计入`businessTransportErrors`。这保证“规则拒绝”不会被误判成框架丢包。

该命令会构建Bench、业务链路客户端和Release Runtime，并在本机启动Runtime；远程机器可先执行`npm run build:perf:full-chain`与Release构建，再使用调度脚本的`--remote`。它会占用CPU和内存，正式运行前必须准备独立、无其他负载的测试机；当前只完成了入口和编译验证，尚未运行正式压力窗口。组队任务不在本测试范围内，因为Party系统尚未实现。

## 独立压测机

先在服务端机器启动对应配置，并确保配置返回给客户端的 Login/Gate IP 是压测机可访问的地址。随后在压测机执行：

```bash
npm run build
npm run build:perf:full-chain
node perf/full_chain/run_full_chain_perf.mjs \
  --remote --host 192.168.1.100 --manager-port 7000 \
  --players 10,50,100 --move-rates 10,0 \
  --warmup 10 --duration 60 --rounds 3
```

远程模式报告压测机 CPU/RSS/GC；服务端 CPU/RSS/V8 Heap/GC 从服务端日志的 `[process-metrics]` 采集。两类指标不会混算。

## 框架热路径低分配准备

在真正的 A/B 压测前，先运行一次就绪检查：

```powershell
npm run perf:hotpath:prepare
```

这个命令会构建 Bench Bundle、全链路客户端和 Release Runtime，检查 Model/Hotfix/客户端/Runtime 制品、读取本地 all-in-one 与 split 测试端口，并确认测试端口当前没有被其他进程占用。它不会启动 Runtime，也不会创建玩家，不属于压力测试。

准备成功后，再在空闲机器上分别保存优化前、优化后的报告：

```powershell
npm run perf:full-chain -- --mode all --players 200,1000,3000 --move-rates 2 --warmup 10 --duration 60 --rounds 3 --output-prefix hotpath_before
npm run perf:full-chain -- --mode all --players 200,1000,3000 --move-rates 2 --warmup 10 --duration 60 --rounds 3 --output-prefix hotpath_after
npm run perf:hotpath:compare -- --before perf/results/hotpath_before_<时间>.json --after perf/results/hotpath_after_<时间>.json
```

报告除了原有吞吐、P99、CPU、RSS、V8 GC 和 Rust 队列，还会列出两类 Mailbox：Scene Mailbox 是按 Scene 汇总的业务入口队列；Actor Mailbox 是整个 Process 内所有 Actor 的总计，不能把它复制到每个 Scene 后再累加。`single-way queued` 应接近零；它必须与 `stalled`、Probe 错误、transport overload、P99 一起判断，不能单独作为性能结论。

`npm run perf:hotpath:compare` 只接受可比报告：before/after 的参数、案例集合和轮数必须一致；每个案例必须有完整资源与 Mailbox 指标，且 `stalled`、Probe 错误、业务传输错误、背压、Inner 超载和 Inner 超时都必须为零。缺字段不会再按 `0` 处理，而是让 `comparisonValid=false`。

这轮观测仍然不是“精确每消息分配多少字节”的分配器实验：服务端使用 `/metrics` 的 V8 GC/RSS/Heap，GC 使用正式窗口的首尾累计值差分；压测端使用 Node `PerformanceObserver` 和进程资源统计，并在正式窗口边界差分。精确堆分配需要另开 V8 heap/profile 实验，不能把 GC 次数直接当成分配字节数。

## 指标口径

- `登录 users/s`：本轮有限玩家并发完成完整登录进图的启动速率。10/50/100 个样本只用于链路对比，不等于登录服容量上限。
- `move/s`：采样窗口内，客户端从发送 Move 到收到自身权威 `G2C_EntityMove` 的闭环完成数。
- `push/s`：所有客户端收到的批量 `G2C_EntityMove` 网络包总数除以完整移动窗口。一个包可以携带多个玩家的 `CellMovementState`；当前仍是同地图全量可见，因此客户端可见状态量仍为 O(N²)，但 MapHost 到 Gate 的跨进程消息和 Gate 下行编码都按批次聚合。
- `p50/p95/p99`：已完成移动闭环的端到端延迟。
- `stalled`：在总测试截止时间后仍未收到自身权威移动的玩家数。延迟分位数不包含这些未完成请求，因此必须和 `stalled` 一起判断。
- `overloads`：内部 TCP transport 有界队列拒绝的消息数，可在对应 Runtime 日志的 `[metrics:inner_transport]` 中查看。
- `Server CPU/RSS/GC`：Runtime 周期输出的进程 CPU、RSS、V8 Heap；GC 报告正式窗口的次数增量、暂停时间增量和 `GC ms/s`，另保留生命周期累计值用于诊断；split 模式按进程汇总。
- `Load CPU/RSS/GC`：Node 压测客户端自身资源，仅用于判断压测机是否先成为瓶颈。
- 业务链路报告额外输出`business/s`、成功数、拒绝数、传输错误数和业务响应p50/p95/p99；必须同时检查错误和服务端队列，不能只看延迟分位数。

目标 10Hz 是客户端调度目标；Windows 定时器、Node 事件循环和 AOI Push 解码都会影响实际 `move/s`，报告以实际完成数为准。

## 输出文件

每次执行生成：

- `perf/results/full_chain_<时间>.md`：人读报告。
- `perf/results/full_chain_<时间>.json`：结构化结果。
- `perf/results/full_chain_<时间>_raw.json`：每轮完成后立即更新，异常中断时也能保留已完成数据。
- `perf/results/logs/<时间>/`：每个 Runtime 的 stdout/stderr，可用于关联队列和 Handler 指标。
- `perf/results/full_chain_latest.*`：最近一次完整报告。

## 判读边界

这套测试回答“当前框架和 Demo 链路在哪里开始退化”，不能单独替代生产容量规划。正式容量结论还需要：

- 固定 CPU 频率并减少后台进程干扰。
- 默认命令已经覆盖 60 秒、三轮中位数；正式结论仍应保留每轮原始值观察波动。
- 使用 `--remote` 在独立压测机上测试真实网络，而不是只用 `127.0.0.1`。
- 接入真正网格 AOI 后，按视野内实体数设计玩家分布。
- Runtime CPU、RSS、V8 Heap、GC 已采集；网络带宽与更细的队列时序仍需后续补充。
