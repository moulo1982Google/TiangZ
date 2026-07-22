# 单 MapHost 同屏容量测试报告

- 时间：2026-07-22T10:27:24.895Z
- 拓扑：1 MapHost / 16 Gate / 1 Login / 1 LoginMgr
- I/O Backend：IOCP（Tokio/Mio；兼容配置值 epoll）
- 负载：每玩家 5Hz Move + 每玩家 1Hz MapProbe
- Probe in-flight：每连接 1
- 压测客户端：Rust
- 正式测试：15s；预热：5s；轮数：1
- Map CPU 目标：80%（100% 表示一个逻辑核）
- 机器：13th Gen Intel(R) Core(TM) i7-13700F / 24 逻辑核 / 65292.4MB

## 1 轮中位数

| 玩家 | Map CPU avg/p90/peak | Map 窗口样本 | Gate max avg/peak | move/s | Move 达标率 | push/s | Probe/s | Probe p50 | p90 | p95 | p99 | max | move/probe errors | overload/timeout/backpressure/slow | RSS |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 4250 | 76.4/79.2/79.2% | 2 | 85.3/93.4% | 20417 | 96.1% | 84957 | 4250 | 152.58ms | 264.41ms | 300.45ms | 404.97ms | 733.79ms | 0/0 | 0/0/356/0 | 2888.2MB |

## Map 广播 single-flight

| 玩家 | 指标样本 | pending 采样峰值/生命周期峰值 | queued/s | coalesced/s (%) | sent/s | batch/s | frames/batch | 广播 avg/max | 排队 avg/max | failures |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 4250 | 2 | 0/4250 | 76822 | 0 (0%) | 76822 | 20 | 3833.4 | 11.49/66ms | 0.25/67ms | 0 |

## 批量下行 Bridge

| 玩家 | Gate batch/s | recipients/s | recipients/batch | Bridge copy | logical outbound |
|---:|---:|---:|---:|---:|---:|
| 4250 | 4635 | 89173 | 19.24 | 26.16MB/s | 6940.30MB/s |

## 容量判断

- 保守容量点：4250 玩家，Map CPU 平均 76.4%，Probe p95/p99 300.45/404.97ms。
- 最接近 80% 的测试点：4250 玩家，Map CPU 平均 76.4%。

## Transport Backend

| 玩家 | Map read frames/op | Map write frames/op | Gate read frames/op | Gate write frames/op |
|---:|---:|---:|---:|---:|
| 4250 | 1.00 | 9.08 | 1.00 | 1.01 |

## 指标口径

- `MapProbe` 是 ActorLocation RPC，链路为客户端 -> Gate -> MapHost -> Gate -> 客户端，不产生 AOI 广播。
- Map/Gate CPU 使用正式测试窗口内的 5 秒进程 CPU 样本；平均值用于容量判断。
- Map 正式窗口至少需要 2 个 CPU 样本；不足时该测试点只作故障诊断，不参与容量候选。
- Move 按固定频率开环发送，吞吐只统计正式窗口内实际写入的请求；容量点要求实际吞吐至少达到目标的 95%。
- `backpressure` 表示入口有界队列满后等待重试，是削峰信号，不等于丢包；容量候选要求零业务错误、零 overload、零内部超时和零慢连接断开。
- 虚拟客户端只拆分并计数 AOI 帧，不逐连接反序列化全员移动快照；端到端延迟由 MapProbe 独立测量。
- `push/s` 仍是全地图全量可见广播，代表最坏同屏 O(N^2) 场景。
- Map 移动广播采用 single-flight；前一批未完成时，同一 Unit 的后续帧只保留最新状态。`pending`、合并率、广播耗时和排队时间用于判断下行是否跟不上 Game.Update。
- Gate 数量用于分摊连接、编码和下行发送；MapHost 始终只有一个。
