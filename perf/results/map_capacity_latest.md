# 单 MapHost 同屏容量测试报告

- 时间：2026-07-21T03:12:15.626Z
- 拓扑：1 MapHost / 12 Gate / 1 Login / 1 LoginMgr
- 负载：每玩家 5Hz Move + 每玩家 1Hz MapProbe
- Probe in-flight：每连接 1
- 压测客户端：Node.js
- 正式测试：30s；预热：10s；轮数：3
- Map CPU 目标：80%（100% 表示一个逻辑核）
- 机器：13th Gen Intel(R) Core(TM) i7-13700F / 24 逻辑核 / 65292.4MB

## 3 轮中位数

| 玩家 | Map CPU avg/p90/peak | Gate max avg/peak | move/s | Move 达标率 | push/s | Probe/s | Probe p50 | p90 | p95 | p99 | max | move/probe errors | overload/backpressure | RSS |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 525 | 73.9/79.3/79.3% | 69.5/90.4% | 2625 | 100% | 1378125 | 525 | 13.73ms | 78.29ms | 97.23ms | 117.09ms | 150.34ms | 0/0 | 0/0 | 968.3MB |

## 批量下行 Bridge

| 玩家 | Gate batch/s | recipients/s | recipients/batch | Bridge copy | logical outbound |
|---:|---:|---:|---:|---:|---:|
| 525 | 32025 | 1378709 | 43.05 | 0.41MB/s | 17.91MB/s |

## 容量判断

- 保守容量点：525 玩家，Map CPU 平均 73.9%，Probe p95/p99 97.23/117.09ms。
- 最接近 80% 的测试点：525 玩家，Map CPU 平均 73.9%。

## 指标口径

- `MapProbe` 是 ActorLocation RPC，链路为客户端 -> Gate -> MapHost -> Gate -> 客户端，不产生 AOI 广播。
- Map/Gate CPU 使用正式测试窗口内的 5 秒进程 CPU 样本；平均值用于容量判断。
- 容量点要求实际 Move 吞吐至少达到设定频率的 95%，避免闭环变慢后 CPU 被动下降造成误判。
- `push/s` 仍是全地图全量可见广播，代表最坏同屏 O(N^2) 场景。
- Gate 数量用于分摊连接、编码和下行发送；MapHost 始终只有一个。
