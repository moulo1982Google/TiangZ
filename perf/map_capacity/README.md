# 单 MapHost AOI 容量测试

这个测试用于回答：在增加 Gate 数量、避免 Gate 先成为瓶颈后，一个单线程业务 MapHost 在可重复的全图均匀行为负载下能承载多少玩家。全量同屏保留为单独边界测试，不再作为默认容量基线。

测试拓扑固定为一个 MapHost，可通过 `--gates` 横向增加 Gate。每个玩家同时执行：

- `2Hz C2M_Move`，对应移动中每500ms方向保活；按下、转向、松开在真实客户端仍立即发送。所有玩家位于同一Cell时仍是最坏同屏全可见负载。
- `0.2Hz C2M_MapProbe`，即每5秒一次；经过客户端、Gate、MapHost 和返回链路，但不触发广播。

服务端 `Game.Update` 默认固定为 20Hz。每帧由 Rust 批量推进地图内 Unit，并直接编码仍在移动或本帧状态改变的权威快照。压测客户端按固定频率开环发送 Move，吞吐只统计正式窗口内实际写入的请求，不等待广播确认后再发送。每个Rust虚拟玩家依据UnitId获得稳定周期相位，Move、Probe和可选状态请求均匀铺在周期内；总QPS不变，但不会在周期边界制造全员同步尖峰。虚拟客户端只拆分并计数移动广播帧，不为每个模拟玩家反序列化整份全员快照；端到端延迟由独立的 `MapProbe` 测量。这样可以避免单机压测器的 `O(N^2)` 解码成本或同步定时脉冲先于服务端成为瓶颈。

默认执行：

```bash
npm run perf:map-capacity
```

默认命令固定为3000玩家、16 Gate、Rust客户端、10×10 AOI Grid均匀分布。每Grid 30人，其中80%在Grid内移动，20%以服务端权威速度每2秒跨越一次相邻Grid；理论跨Grid约300次/s。

2026-08-01首轮10×10正式基线实测跨Grid`310.3/s`（理论值的`103.4%`）、Move`6004/s`、Movement Push约`211.6万/s`，Map CPU平均`82.1%`，Probe p95/p99为`128.49/156.05ms`，全部错误、超时、过载、背压和慢连接为0。它略高于80% CPU目标，因此用于持续回归和定位优化，不代表3000人已经是保守容量；原始报告固定为`perf/results/map_capacity_20260801_015926.md`，最新三档密度对照见`perf/results/map_capacity_grid_matrix_latest.md`。

常用参数：

```bash
npm run perf:map-capacity -- \
  --gates 16 \
  --players 3000 \
  --client rust \
  --spawn-layout grid-uniform \
  --world-grids 10 \
  --move-rate 2 \
  --probe-rate 0.2 \
  --warmup 10 \
  --duration 30 \
  --rounds 1 \
  --target-map-cpu 80
```

Linux 上可以用同一套完整业务链路选择 I/O Backend：

```bash
npm run perf:map-capacity -- \
  --io-backend io-uring \
  --gates 12 \
  --players 525 \
  --move-rate 2 \
  --probe-rate 0.2 \
  --warmup 10 \
  --duration 30 \
  --rounds 3
```

相关参数：

- `--io-backend epoll|io-uring`，默认 `epoll`；旧参数 `--network-backend` 暂时仍可使用；
- `--uring-entries 2048`；
- `--uring-read-buffer-bytes 65536`；
- `--movement-hold-messages N`，Grid内移动组连续 N 次 Move 保持同一方向，默认2；在默认2Hz上报下每秒换向一次并形成小闭环；跨Grid组固定每2秒换向，不受该参数改变；
- `--spawn-layout same-point|single-grid|grid-uniform`，默认 `grid-uniform`；`single-grid`把玩家固定到一个AOI Grid内做1 Cell/s安全闭环；`grid-uniform`轮询全部Grid，从中央Cell出发，每个Grid内确定性选择80%玩家做1 Cell/s小闭环，20%玩家以`gridSizeCells/2` Cell/s在相邻Grid中心间往返；
- `--world-grids 10|15|20`，默认10；分别选择150、225、300 Cell的Cold MapConfig。该参数当前只支持Rust压测客户端；
- `--post-setup-settle N`，全部玩家进图后空闲排空N秒再开始负载预热，默认0；用于把批量AOI Enter成本与稳态Move容量分开，不能用它掩盖独立的批量进图验收失败；
- `--skip-rust-build`，只在已经确认目标二进制 feature 正确时使用。

Runtime会按照每张地图Cold `MapConfig`中的`entry_players_per_tick`逐Tick完成AOI Attach，`entry_queue_capacity`限制仍在Loading中的等待人数。该队列用于削平地图Attach和初始Snapshot洪峰，不是区服登录排队。报告的“地图进入队列”段会显示测量结束长度、生命周期峰值、累计放行和失败数；正式稳态窗口开始前队列必须归零。

当前进图报告还区分两类快照成本：`player_entry_snapshot_items_total`是所有玩家逻辑上收到的实体条数，`player_entry_snapshot_materialized_items_total`是实际构造的实体对象条数；`player_entry_snapshot_builds_total`是本批次实际生成的不同可见集合，`player_entry_snapshot_audience_reuse_hits_total`和`player_entry_snapshot_unit_reuse_hits_total`分别表示数组和Unit快照复用。生产路径的`EnterMap`响应不再携带新玩家全量实体；客户端注册`G2C_AoiDelta`后调用生成SDK的`GateClient.mapSnapshotReady({ unitId })`，初始实体经既有批量广播下发。调整`entry_players_per_tick`前，必须同时比较这些指标、Map到Gate初始AoiDelta下行队列和Loading耗时。

2026-08-01的3000人、16 Gate、单Grid完整进图A/B中，每Tick放行`1/4/8/16`人的Map Enter吞吐分别为`19.97/78.88/131.09/164.39人/s`，四档均零错误、零过载；Map广播pending生命周期峰值同时从`7`增长到`56/136/272`，Location确认平均耗时从`7.17ms`增长到`29.62/127.75/284.46ms`。因此正式Cold配置继续保持`1`；`4`是后续长窗口候选，`8/16`不能仅凭更短Loading直接采用。详见`perf/results/map_entry_admission_ab_latest.md`。

进图洪峰使用独立A/B命令定位：

```bash
npm run perf:map-entry-stages -- --players 1000 --gates 8
```

该命令只使用Rust客户端和Bench Bundle，依次运行`attach-only`、`new-observer-only`、`existing-observers-only`、`full`，输出`perf/results/map_entry_stages_latest.md`。前三种模式会故意省略一部分客户端状态，只能用于性能拆分；最后的`full`才具有正式完整进图语义，并会成为最终`map_capacity_latest`。报告同时列出MapHost全链路、ID分配、Player创建、Location、Admission排队、AOI Attach、新玩家Snapshot、老玩家Enter投递及Map/Gate生命周期字节。命令还会自动断言四种模式的Snapshot和Enter路径互不串扰、进图无失败；语义不符时直接以失败状态退出。

单独调用容量工具时也可传`--entry-sync-mode`，但非`full`要求`--client rust`且布局必须为`single-grid`或`grid-uniform`。不要用诊断模式生成容量结论，也不要把Snapshot对象重新编码一遍来测字节；对象条数由TS指标统计，真实字节使用Transport生命周期计数比较。

io_uring 模式会自动使用 `--features io-uring` 构建 Runtime，并把临时 Scene 配置设为 `protocol=tcp`。报告中的 `Transport Backend` 表格会输出 read/write 的 `frames/op`。

只测完整链路 pingpong，不测 Move 与 AOI 广播：

`--probe-only`会在容量调度器中强制把`move-rate`设为0，并同时关闭Node/Rust客户端的Move发送；报告中的`move/s`与`push/s`必须为0，否则该轮不能作为Probe基线。

```bash
npm run perf:map-capacity -- \
  --probe-only \
  --gates 4 \
  --players 600 \
  --move-rate 0 \
  --probe-rate 20 \
  --probe-concurrency 4 \
  --warmup 10 \
  --duration 30 \
  --rounds 3 \
  --target-map-cpu 80
```

`--probe-concurrency` 表示每个客户端连接最多同时挂起多少个 `MapProbe` RPC。默认值是 1，更接近“玩家串行请求”；大于 1 时用于测框架完整链路吞吐上限。

真实 Move/AOI 压测超过单个 Node.js 事件循环能力时，可以增加 `--client-shards 8`。容量脚本会启动多个独立 Node 进程；所有分片完成登录和进图后经屏障统一进入预热与正式窗口，再汇总吞吐、错误和资源。延迟分位数采用各分片中最差值，避免平均值掩盖慢分片。测试结束时玩家分批退出，避免集中 teardown 污染正式容量。该参数默认是 `1`，Rust 客户端暂不分片。Node 和 Rust 客户端都会在 LoginGate 成功后每 5 秒发送 `C2G_Ping`，避免把 Gate 的 30 秒失活清理误判为容量故障。

在 `127.0.0.1` 上压测时，每个 Node 虚拟玩家会自动绑定独立的 `127/8` 源地址，避免大量 LoginMgr/Login 短连接耗尽 Windows 临时端口四元组。远程压测不启用该行为。

定位链路瓶颈时可以增加 `--latency-sample-rate 100`，让 Core 每 100 条消息采样一次 `ingress.queue`、编解码、Handler 和跨进程调用耗时。该参数默认是 `0`，正式吞吐测试应保持关闭，避免采样时钟和直方图污染基线。

使用 Rust 全链路客户端排除 Node.js 定时器、GC 和 socket 调度开销：

```bash
npm run perf:map-capacity -- \
  --client rust \
  --probe-only \
  --gates 4 \
  --players 600 \
  --move-rate 0 \
  --probe-rate 50 \
  --probe-concurrency 4 \
  --warmup 5 \
  --duration 15 \
  --rounds 3 \
  --target-map-cpu 80
```

Rust 客户端会真实完成 `LoginMgr -> Login -> Gate -> EnterMap`，支持固定频率 `C2M_Move`、`G2C_EntityMove` Push 计数以及按 `rpcId` 多路复用的 `MapProbe`。它只按 msgcode 统计移动 Push，不反序列化全员快照，因此适合判断服务端 Move/AOI 容量；需要验证 TS SDK 行为时仍使用默认 Node.js 客户端。结果 JSON 的 `loadGenerator.cpuTotalMs` 和 `loadGenerator.rssBytes` 用于观察 Rust 压测进程自身开销。

Rust玩家在LoginGate成功后立即启动常驻socket reader和5秒心跳，等待进图队列期间会持续消费Push，不会被Gate按失活连接清理；Move、Probe和状态负载仍在全部玩家进图后统一启用。默认不传`--map-entry-concurrency`时，`--setup-concurrency`控制`Login -> Gate连接 -> LoginGate -> EnterMap`整条setup链路，适合测试真实批量上线能力。

需要单独测Map入场洪峰时，增加`--map-entry-concurrency`启用两阶段模式：第一阶段按`--setup-concurrency`平稳完成连接和LoginGate，全部连接就绪后，第二阶段按独立并发度同时发送EnterMap。该模式把TCP/Login洪峰与Map Admission洪峰分开，报告会分别给出连接耗时、Map Enter耗时和Enter吞吐。例如：

```bash
npm run perf:map-capacity -- \
  --players 3000 \
  --gates 16 \
  --client rust \
  --spawn-layout single-grid \
  --setup-concurrency 512 \
  --map-entry-concurrency 3000 \
  --timeout 300000 \
  --probe-only
```

不要用`--setup-concurrency 3000`替代上述隔离测试：它会同时冲击TCP短连接、Login、Gate和Map，连接错误不能用于判断Map Admission容量。批量上线、Map入场洪峰和稳态地图容量是三个不同指标。

Admission事务使用独立10分钟故障上限，覆盖当前冷配置最坏约500秒的队列排空预算；普通Scene RPC仍保持短超时。GateSession使用unordered mailbox，`C2G_Ping -> G2C_Ping`是不加锁的普通TS Handler，因此长时间Loading不会阻塞心跳；EnterMap、重连、传送与下线按账号锁保持Route一致。洪峰验收必须同时满足：Map请求全部完成、Admission队列最终归零、放行数等于玩家数，并且客户端错误、内部超时、过载、背压和慢连接断开全部为0。最大等待时间仍是独立产品SLO，不能因为技术上没有丢请求就判定线上体验合格。

测试即使在预热或setup后失败，也会生成`map_capacity_<run>_<case>_failure.json`。其中保留失败前最后几次Process health样本、CPU、背压、NativeData和广播指标，禁止只依据客户端的`1006`错误猜测瓶颈。

AOI报告同时记录World/Entity/Grid、候选/可见关系、跨Grid/s和可见变化/s。进入/离开属于不可覆盖事件，但服务端会把同一帧、相同受众的变化合并为`G2C_AoiDelta`；因此判断AOI调度开销时应同时观察“可见变化/s”和“Map广播batch/s”，不能把两者当成同一个数量。

```bash
npm run perf:map-capacity -- \
  --client rust \
  --gates 12 \
  --players 2000 \
  --move-rate 2 \
  --probe-rate 0.2 \
  --warmup 5 \
  --duration 15
```

报告生成到 `perf/results/map_capacity_*.md`。容量点必须同时满足：

- MapHost 平均 CPU 不超过目标值。
- 实际 Move 吞吐至少达到设定频率的 95%。
- `grid-uniform`实际跨Grid速率达到理论值的80%至120%；默认3000人理论值为300次/s。
- Move 和 MapProbe 没有超时。
- 内部传输没有 overload 或 timeout，且没有因下行过慢主动断开客户端。

`backpressure` 表示入口有界队列已经满并发生等待重试。它不等于丢包或 overload，但说明该测试点没有充足余量，因此正式容量候选要求窗口内为0；非零结果仍可作为故障诊断保存。

容量测试会为每个 Process 临时启用独立的 health 端口，并直接抓取 CPU、RSS、V8、Transport、NativeData 与 Map 广播指标。正式窗口中的累计计数按相邻采样差值换算为每秒速率，不依赖标准输出日志。

`scratch grows/s (total)` 左侧是正式窗口内帧尾临时缓冲的扩容速率，右侧括号是进程启动后的累计扩容次数。稳态速率为 0 说明缓冲容量已复用并稳定，单纯累计值不代表持续分配。

报告中的“Map 广播 single-flight”会额外给出待发 Unit 峰值、状态合并率、实际发送帧率、批次数、每批帧数、广播耗时、排队时间和失败数。前一批广播未完成时，同一 Unit 的后续状态只保留最新值，因此 `coalesced` 增长表示框架在主动淘汰过时状态；若 `pending`、广播耗时和排队时间同时持续升高，才说明 MapHost 到 Gate 的下行链路已经落后于 Game.Update。

CPU 的 100% 表示占满一个逻辑核。`same-point`和`single-grid`代表最坏同屏；`grid-uniform`代表Rust AOI切割后的均匀空间密度，两类结果不能混为一条容量曲线。

`single-grid`是稳定的全可见广播基线：玩家位于同一AOI Grid中央附近，以1 Cell/s沿安全闭合轨迹移动，主要测量3000人互相可见时的Movement编码、Gate扇出和端到端延迟。`same-point`保留普通玩家10 Cell/s速度并从同一点开始移动，会快速制造大量跨Grid和迟滞关系；它是AOI边界维护压力测试，不是“静止同屏”的别名，也不能替代`single-grid`容量基线。

AOI报告中的`迟滞关系`与`拒绝关系`均为当前Gauge。迟滞关系持续增长时，应把`跨Grid/s × candidate`视为主要工作量，并同时检查Movement advance、Map Frame队列和Probe延迟。正式容量结果仍要求窗口内backpressure、overload、timeout和slow disconnect全部为0。

使用当前冷配置验证10×10 AOI Grid的实际切割效果：

```bash
npm run perf:map-capacity -- \
  --client rust \
  --spawn-layout grid-uniform \
  --world-grids 10 \
  --gates 16 \
  --players 1000,2000,3000 \
  --move-rate 2 \
  --probe-rate 0.2 \
  --post-setup-settle 15 \
  --warmup 10 \
  --duration 60
```

10×10世界的1000/2000/3000人分别是平均每Grid 10/20/30人。固定3000人比较地图面积时，使用一键密度矩阵：

```bash
npm run perf:map-capacity:grid-matrix
```

该命令依次测试10×10、15×15和20×20世界，保持3000人、16 Gate、2Hz Move、0.2Hz Probe、80/20移动画像、预热和正式窗口一致，并生成`perf/results/map_capacity_grid_matrix_latest.md`。矩阵固定Map Enter并发8，只隔离正式稳态的空间密度；不要用不同的瞬时进图洪峰解释AOI稳态性能。

2026-08-01 Windows IOCP正式矩阵结果：10×10、15×15、20×20的平均密度分别为30、13.33、7.5人/Grid；Map CPU平均为`74.1%/56.7%/57.3%`，Movement Push为`218.1万/140.9万/107.3万每秒`，Probe p95为`52.81/43.90/42.78ms`。三档Move均约6000/s、跨Grid均约300/s，正式窗口错误、过载、超时、背压和慢连接均为0。15×15之后CPU不再随接收人数同比下降，说明固定Move、20Hz Update和每帧编码扫描开始占据主要成本。

`grid-uniform`使用Bench专用Gate RPC，在创建Unit时通过可信内网字段传入服务端出生点；正式`C2G_EnterMap`没有坐标字段。玩家因此在AOI Attach前已经位于目标Grid，后续ActorLocation核对RPC停止Demo自动回血并设置Bench权威速度，不会先从公共出生点搬运。80%组保持在出生Grid中央附近；20%组沿X轴在相邻Grid中心间往返，每2秒跨一次Grid，边缘Grid先向地图内部移动。正式窗口必须确认Grid数量等于地图配置中的已占用Grid数、每Grid人数均匀、跨Grid达标率在80%至120%，并且`visible`显著小于`N×(N-1)`；否则不得标记为正式AOI行为基线。稀疏地图初始快照较小，会让这个Bench后置核对RPC更集中地释放；矩阵因此限制Map Enter并发，后续应把核对字段并入Bench进图事务，彻底删除第二次RPC。

当前Cold配置为3×3 Enter与20Hz高频区、5×5 Detach迟滞与5Hz低频区，越过5×5立即Leave；不再存在7×7和1Hz档位。20%跨Grid组会持续覆盖Enter、5Hz迟滞和Leave成本，报告中的`跨Grid/s`与`可见变化/s`必须同时保留。

## 2026-07-20 RPC 容量回归

在 i7-13700F Windows 开发机上，使用 Rust 客户端、600 玩家、8 Gate、单 MapHost、Probe Only 完整链路：

| 目标负载 | 并发窗口 | 实际 Probe/s | Map CPU avg/p90 | p95/p99 | 结果 |
|---:|---:|---:|---:|---:|---|
| 42,000/s | 4 | 41,998/s | 60.6% / 64.3% | 79.7 / 102.18ms | 稳定低压点 |
| 54,000/s | 8 | 48,777/s | 74.3% / 79.1% | 125.76 / 161.03ms | 当前容量边界 |

两组均为三轮中位数，RPC 错误和 transport overload 均为 0。继续扩大客户端窗口只增加排队延迟，没有提高吞吐，因此该次历史回归在这台机器上的完整链路甜点位约为 4.2 万/s，饱和边界约为 4.9 万/s。仓库只保留各基准的 `*_latest.json/md`，带时间戳的运行流水由执行者自行归档。
