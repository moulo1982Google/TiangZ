# 单 MapHost 同屏容量测试报告

- 时间：2026-07-13T09:57:15.157Z
- 拓扑：1 MapHost / 8 Gate / 1 Login / 1 LoginMgr
- 负载：每玩家 10Hz Move + 1Hz MapProbe
- 正式测试：30s；预热：10s；轮数：3
- Map CPU 目标：85%（100% 表示一个逻辑核）
- 机器：13th Gen Intel(R) Core(TM) i7-13700F / 24 逻辑核 / 65292.4MB

## 3 轮中位数

| 玩家 | Map CPU avg/p90/peak | Gate max avg/peak | move/s | Move 达标率 | push/s | Probe/s | Probe p50 | p90 | p95 | p99 | max | move/probe errors | overload/backpressure | RSS |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 200 | 143.3/155.6/155.6% | 137.9/167.1% | 2000 | 100% | 400000 | 196 | 15.28ms | 60.12ms | 74.49ms | 108.94ms | 167.32ms | 0/0 | 0/0 | 655.9MB |

## 批量下行 Bridge

| 玩家 | Gate batch/s | recipients/s | recipients/batch | Bridge copy | logical outbound |
|---:|---:|---:|---:|---:|---:|
| 200 | 16178 | 399869 | 24.72 | 0.21MB/s | 5.34MB/s |

## 容量判断

- 本轮没有同时满足 CPU 目标、零超时、零内部过载的容量点。
- 最接近 85% 的测试点：200 玩家，Map CPU 平均 143.3%。

## 指标口径

- `MapProbe` 是 ActorLocation RPC，链路为客户端 -> Gate -> MapHost -> Gate -> 客户端，不产生 AOI 广播。
- Map/Gate CPU 使用正式测试窗口内的 5 秒进程 CPU 样本；平均值用于容量判断。
- 容量点要求实际 Move 吞吐至少达到设定频率的 95%，避免闭环变慢后 CPU 被动下降造成误判。
- `push/s` 仍是全地图全量可见广播，代表最坏同屏 O(N^2) 场景。
- Gate 数量用于分摊连接、编码和下行发送；MapHost 始终只有一个。
