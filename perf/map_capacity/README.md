# 单 MapHost 同屏容量测试

这个测试用于回答：在增加 Gate 数量、避免 Gate 先成为瓶颈后，一个单线程业务 MapHost 在最坏全量同屏广播下能承载多少玩家。

测试拓扑固定为一个 MapHost，可通过 `--gates` 横向增加 Gate。每个玩家同时执行：

- `5Hz C2M_Move`，触发同地图全量广播；这是容量测试的默认负载参数，不等于 Cocos 客户端的 20Hz 预测输入频率。
- `1Hz C2M_MapProbe`，经过客户端、Gate、MapHost 和返回链路，但不触发广播。

服务端 `Game.Update` 默认固定为 20Hz。每帧由 Rust 批量推进地图内 Unit，并直接编码仍在移动或本帧状态改变的权威快照。压测客户端按固定频率开环发送 Move，吞吐只统计正式窗口内实际写入的请求，不等待广播确认后再发送。虚拟客户端只拆分并计数移动广播帧，不为每个模拟玩家反序列化整份全员快照；端到端延迟由独立的 `MapProbe` 测量。这样可以避免单机压测器的 `O(N^2)` 解码成本先于服务端成为瓶颈。

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
- `--movement-hold-messages N`，连续 N 次 Move 保持同一方向，默认 1；
- `--skip-rust-build`，只在已经确认目标二进制 feature 正确时使用。

io_uring 模式会自动使用 `--features io-uring` 构建 Runtime，并把临时 Scene 配置设为 `protocol=tcp`。报告中的 `Transport Backend` 表格会输出 read/write 的 `frames/op`。

只测完整链路 pingpong，不测 Move 与 AOI 广播：

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

每个 Rust 玩家完成 EnterMap 后会立即启动常驻 socket reader，即使其他玩家仍在 setup，也会持续消费 EntityEnter 等 Push。`--setup-concurrency` 因而表示真实的并发登录/进图压力：较大的值用于测试批量上线能力；要隔离“稳定在线后的 Move/AOI 容量”，应降低该值并单独记录 setup 耗时。批量进图容量和稳态地图容量是两个不同指标。

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

`backpressure` 表示入口有界队列满后等待重试，是需要观察趋势的削峰信号，但不等于丢包或 overload，因此不会单独否决容量候选。若它持续加速并伴随吞吐下降、超时或慢连接断开，才表示消费者已经长期落后。

报告中的“Map 广播 single-flight”会额外给出待发 Unit 峰值、状态合并率、实际发送帧率、批次数、每批帧数、广播耗时、排队时间和失败数。前一批广播未完成时，同一 Unit 的后续状态只保留最新值，因此 `coalesced` 增长表示框架在主动淘汰过时状态；若 `pending`、广播耗时和排队时间同时持续升高，才说明 MapHost 到 Gate 的下行链路已经落后于 Game.Update。

CPU 的 100% 表示占满一个逻辑核。当前广播仍是全地图全量可见，因此结果代表没有 AOI 切割时的最坏同屏模型。

## 2026-07-20 RPC 容量回归

在 i7-13700F Windows 开发机上，使用 Rust 客户端、600 玩家、8 Gate、单 MapHost、Probe Only 完整链路：

| 目标负载 | 并发窗口 | 实际 Probe/s | Map CPU avg/p90 | p95/p99 | 结果 |
|---:|---:|---:|---:|---:|---|
| 42,000/s | 4 | 41,998/s | 60.6% / 64.3% | 79.7 / 102.18ms | 稳定低压点 |
| 54,000/s | 8 | 48,777/s | 74.3% / 79.1% | 125.76 / 161.03ms | 当前容量边界 |

两组均为三轮中位数，RPC 错误和 transport overload 均为 0。继续扩大客户端窗口只增加排队延迟，没有提高吞吐，因此该次历史回归在这台机器上的完整链路甜点位约为 4.2 万/s，饱和边界约为 4.9 万/s。仓库只保留各基准的 `*_latest.json/md`，带时间戳的运行流水由执行者自行归档。
