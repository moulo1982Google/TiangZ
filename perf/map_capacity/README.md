# 单 MapHost AOI 容量测试

这个测试用于回答：在增加 Gate 数量、避免 Gate 先成为瓶颈后，一个单线程业务 MapHost 在最坏全量同屏或全图均匀分布下能承载多少玩家。

测试拓扑固定为一个 MapHost，可通过 `--gates` 横向增加 Gate。每个玩家同时执行：

- `5Hz C2M_Move`，触发当前AOI内广播；所有玩家位于同一Cell时仍是最坏同屏全可见负载。这是容量测试的默认参数，不等于Cocos客户端的20Hz预测输入频率。
- `1Hz C2M_MapProbe`，经过客户端、Gate、MapHost 和返回链路，但不触发广播。

服务端 `Game.Update` 默认固定为 20Hz。每帧由 Rust 批量推进地图内 Unit，并直接编码仍在移动或本帧状态改变的权威快照。压测客户端按固定频率开环发送 Move，吞吐只统计正式窗口内实际写入的请求，不等待广播确认后再发送。每个Rust虚拟玩家依据UnitId获得稳定周期相位，Move、Probe和可选状态请求均匀铺在周期内；总QPS不变，但不会在周期边界制造全员同步尖峰。虚拟客户端只拆分并计数移动广播帧，不为每个模拟玩家反序列化整份全员快照；端到端延迟由独立的 `MapProbe` 测量。这样可以避免单机压测器的 `O(N^2)` 解码成本或同步定时脉冲先于服务端成为瓶颈。

默认执行：

```bash
npm run perf:map-capacity
```

常用参数：

```bash
npm run perf:map-capacity -- \
  --gates 4 \
  --players 100,125,150,175,200 \
  --move-rate 5 \
  --probe-rate 1 \
  --warmup 10 \
  --duration 30 \
  --rounds 1 \
  --target-map-cpu 85
```

Linux 上可以用同一套完整业务链路选择 I/O Backend：

```bash
npm run perf:map-capacity -- \
  --io-backend io-uring \
  --gates 12 \
  --players 525 \
  --move-rate 5 \
  --probe-rate 1 \
  --warmup 10 \
  --duration 30 \
  --rounds 3
```

相关参数：

- `--io-backend epoll|io-uring`，默认 `epoll`；旧参数 `--network-backend` 暂时仍可使用；
- `--uring-entries 2048`；
- `--uring-read-buffer-bytes 65536`；
- `--movement-hold-messages N`，连续 N 次 Move 保持同一方向，默认5；在默认5Hz上报下即每秒换向一次，四个方向形成闭合轨迹，避免把高频转向事件误当成普通持续移动；
- `--spawn-layout same-point|single-grid|grid-uniform`，默认 `same-point`；`single-grid`通过Bench专用RPC把玩家固定到同一AOI Grid的四个内侧起点；`grid-uniform`把玩家轮询分配到全部AOI Grid并固定在各Grid中央Cell。两种Bench布局都把速度限制为1 Cell/s，消息仍保持5Hz、服务端仍保持20Hz，用于测稳定Grid密度；
- `--world-grids 10|15|20`，默认10；分别选择150、225、300 Cell的Cold MapConfig。该参数当前只支持Rust压测客户端；
- `--post-setup-settle N`，全部玩家进图后空闲排空N秒再开始负载预热，默认0；用于把批量AOI Enter成本与稳态Move容量分开，不能用它掩盖独立的批量进图验收失败；
- `--skip-rust-build`，只在已经确认目标二进制 feature 正确时使用。

Runtime会按照每张地图Cold `MapConfig`中的`entry_players_per_tick`逐Tick完成AOI Attach，`entry_queue_capacity`限制仍在Loading中的等待人数。该队列用于削平地图Attach和初始Snapshot洪峰，不是区服登录排队。报告的“地图进入队列”段会显示测量结束长度、生命周期峰值、累计放行和失败数；正式稳态窗口开始前队列必须归零。

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

每个 Rust 玩家完成 EnterMap 后会立即启动常驻 socket reader，即使其他玩家仍在setup，也会持续消费EntityEnter等Push；Move、Probe和状态负载在全部玩家setup完成后才统一启用。`--setup-concurrency`因此表示真实的并发登录/进图压力：较大的值用于测试批量上线能力；要隔离“稳定在线后的Move/AOI容量”，应降低该值并单独记录setup耗时。批量进图容量和稳态地图容量是两个不同指标。

测试即使在预热或setup后失败，也会生成`map_capacity_<run>_<case>_failure.json`。其中保留失败前最后几次Process health样本、CPU、背压、NativeData和广播指标，禁止只依据客户端的`1006`错误猜测瓶颈。

AOI报告同时记录World/Entity/Grid、候选/可见关系、跨Grid/s和可见变化/s。进入/离开属于不可覆盖事件，但服务端会把同一帧、相同受众的变化合并为`G2C_AoiDelta`；因此判断AOI调度开销时应同时观察“可见变化/s”和“Map广播batch/s”，不能把两者当成同一个数量。

```bash
npm run perf:map-capacity -- \
  --client rust \
  --gates 12 \
  --players 2000 \
  --move-rate 5 \
  --probe-rate 1 \
  --warmup 5 \
  --duration 15
```

报告生成到 `perf/results/map_capacity_*.md`。容量点必须同时满足：

- MapHost 平均 CPU 不超过目标值。
- 实际 Move 吞吐至少达到设定频率的 95%。
- Move 和 MapProbe 没有超时。
- 内部传输没有 overload 或 timeout，且没有因下行过慢主动断开客户端。

`backpressure` 表示入口有界队列已经满并发生等待重试。它不等于丢包或 overload，但说明该测试点没有充足余量，因此正式容量候选要求窗口内为0；非零结果仍可作为故障诊断保存。

容量测试会为每个 Process 临时启用独立的 health 端口，并直接抓取 CPU、RSS、V8、Transport、NativeData 与 Map 广播指标。正式窗口中的累计计数按相邻采样差值换算为每秒速率，不依赖标准输出日志。

`scratch grows/s (total)` 左侧是正式窗口内帧尾临时缓冲的扩容速率，右侧括号是进程启动后的累计扩容次数。稳态速率为 0 说明缓冲容量已复用并稳定，单纯累计值不代表持续分配。

报告中的“Map 广播 single-flight”会额外给出待发 Unit 峰值、状态合并率、实际发送帧率、批次数、每批帧数、广播耗时、排队时间和失败数。前一批广播未完成时，同一 Unit 的后续状态只保留最新值，因此 `coalesced` 增长表示框架在主动淘汰过时状态；若 `pending`、广播耗时和排队时间同时持续升高，才说明 MapHost 到 Gate 的下行链路已经落后于 Game.Update。

CPU 的 100% 表示占满一个逻辑核。`same-point`和`single-grid`代表最坏同屏；`grid-uniform`代表Rust AOI切割后的均匀空间密度，两类结果不能混为一条容量曲线。

使用当前冷配置验证10×10 AOI Grid的实际切割效果：

```bash
npm run perf:map-capacity -- \
  --client rust \
  --spawn-layout grid-uniform \
  --world-grids 10 \
  --gates 16 \
  --players 1000,2000,3000 \
  --move-rate 5 \
  --probe-rate 1 \
  --post-setup-settle 15 \
  --warmup 10 \
  --duration 60
```

10×10世界的1000/2000/3000人分别是平均每Grid 10/20/30人。固定3000人比较地图面积时，分别运行`--world-grids 10`、`15`、`20`；三轮必须保持Gate数、频率、预热和正式窗口一致。

`grid-uniform`使用Bench专用Gate RPC，在创建Unit时通过可信内网字段传入服务端出生点；正式`C2G_EnterMap`没有坐标字段。玩家因此在AOI Attach前已经位于目标Grid，后续ActorLocation核对RPC只停止Demo自动回血、限制速度并校验位置，不再先从公共出生点搬运。玩家落在Grid中央Cell且采用小范围闭合轨迹，避免边界出生、临时Enter/Leave或Numeric演示Timer混进Move/AOI稳态。正式窗口开始前应确认Grid数量等于地图配置中的已占用Grid数，并且`visible`显著小于`N×(N-1)`；否则该结果不得标记为AOI均匀分布容量。

静态均匀出生只会建立3×3 Enter关系。5×5@5Hz和7×7@1Hz只作用于已经进入后移动到迟滞外圈的关系；验证两档频率需要单独的“先Enter、再向外移动”回归，不能从静态均匀容量结果推断。

## 2026-07-20 RPC 容量回归

在 i7-13700F Windows 开发机上，使用 Rust 客户端、600 玩家、8 Gate、单 MapHost、Probe Only 完整链路：

| 目标负载 | 并发窗口 | 实际 Probe/s | Map CPU avg/p90 | p95/p99 | 结果 |
|---:|---:|---:|---:|---:|---|
| 42,000/s | 4 | 41,998/s | 60.6% / 64.3% | 79.7 / 102.18ms | 稳定低压点 |
| 54,000/s | 8 | 48,777/s | 74.3% / 79.1% | 125.76 / 161.03ms | 当前容量边界 |

两组均为三轮中位数，RPC 错误和 transport overload 均为 0。继续扩大客户端窗口只增加排队延迟，没有提高吞吐，因此该次历史回归在这台机器上的完整链路甜点位约为 4.2 万/s，饱和边界约为 4.9 万/s。仓库只保留各基准的 `*_latest.json/md`，带时间戳的运行流水由执行者自行归档。
