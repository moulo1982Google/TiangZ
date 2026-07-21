# 单 MapHost 同屏容量测试

这个测试用于回答：在增加 Gate 数量、避免 Gate 先成为瓶颈后，一个单线程业务 MapHost 在最坏全量同屏广播下能承载多少玩家。

测试拓扑固定为一个 MapHost，可通过 `--gates` 横向增加 Gate。每个玩家同时执行：

- `5Hz C2M_Move`，触发同地图全量广播；这是 Demo 客户端默认输入上报频率。
- `1Hz C2M_MapProbe`，经过客户端、Gate、MapHost 和返回链路，但不触发广播。

服务端 `Game.Update` 默认固定为 20Hz。当前移动消息到达后立即更新并广播，因此 20Hz 是游戏逻辑刷新频率，不代表网络位置广播也固定为 20Hz。

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

Rust 客户端会真实完成 `LoginMgr -> Login -> Gate -> EnterMap -> MapProbe`，并在每条 Gate 长连接上按 `rpcId` 多路复用。当前只支持 `--probe-only`；Move/AOI 场景继续使用默认 Node.js 客户端。

报告生成到 `perf/results/map_capacity_*.md`。容量点必须同时满足：

- MapHost 平均 CPU 不超过目标值。
- 实际 Move 吞吐至少达到设定频率的 95%。
- Move 和 MapProbe 没有超时。
- 内部传输没有 overload。

CPU 的 100% 表示占满一个逻辑核。当前广播仍是全地图全量可见，因此结果代表没有 AOI 切割时的最坏同屏模型。

## 2026-07-20 RPC 容量回归

在 i7-13700F Windows 开发机上，使用 Rust 客户端、600 玩家、8 Gate、单 MapHost、Probe Only 完整链路：

| 目标负载 | 并发窗口 | 实际 Probe/s | Map CPU avg/p90 | p95/p99 | 结果 |
|---:|---:|---:|---:|---:|---|
| 42,000/s | 4 | 41,998/s | 60.6% / 64.3% | 79.7 / 102.18ms | 稳定低压点 |
| 54,000/s | 8 | 48,777/s | 74.3% / 79.1% | 125.76 / 161.03ms | 当前容量边界 |

两组均为三轮中位数，RPC 错误和 transport overload 均为 0。继续扩大客户端窗口只增加排队延迟，没有提高吞吐，因此当前框架在该机器上的真实完整链路甜点位约为 4.2 万/s，饱和边界约为 4.9 万/s。结果文件分别为 `perf/results/map_capacity_20260720_113159.md` 和 `perf/results/map_capacity_20260720_113530.md`。
