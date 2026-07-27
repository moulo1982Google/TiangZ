# 单 MapHost 同屏容量测试报告

- 时间：2026-07-27T05:37:21.873Z
- 拓扑：1 MapHost / 16 Gate / 1 Login / 1 LoginMgr
- I/O Backend：IOCP（Tokio/Mio；兼容配置值 epoll）
- Unit 数据：Rust 权威存储，Rust 批处理并直接编码移动快照
- 负载：每玩家 5Hz Move + 每玩家 1Hz MapProbe
- 移动输入：每 5 次上报保持同一方向
- Probe in-flight：每连接 1
- 压测客户端：Rust
- 正式测试：30s；预热：10s；轮数：3
- Map CPU 目标：80%（100% 表示一个逻辑核）
- 机器：13th Gen Intel(R) Core(TM) i7-13700F / 24 逻辑核 / 65292.4MB

## 3 轮中位数

| 玩家 | Map CPU avg/p90/peak | Map 窗口样本 | Gate max avg/peak | move/s | Move 达标率 | push/s | Probe/s | Probe p50 | p90 | p95 | p99 | max | move/probe errors | overload/timeout/backpressure/slow | RSS |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 3000 | 49.9/55.7/55.7% | 5 | 63.7/76.9% | 14992 | 99.9% | 59938 | 3000 | 122.14ms | 184.94ms | 238.11ms | 314.73ms | 418.2ms | 0/0 | 0/0/0/0 | 3252.8MB |

## NativeData 边界指标

| 玩家 | 指标样本 | scalar gets/s | scalar sets/s | batch calls/s | encoded frames/items | encoded bytes/s | live Entities/Units | Map V8 Heap peak |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 3000 | 0 | 0 | 0 | 0 | 0/0 | 0.0MB/s | 0/0 | 35.7MB |

## Map 广播 single-flight

| 玩家 | 指标样本 | pending 采样峰值/生命周期峰值 | queued/s | coalesced/s (%) | sent/s | batch/s | frames/batch | 广播 avg/max | 排队 avg/max | failures |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 3000 | 0 | 0/0 | 0 | 0 (0%) | 0 | 0 | 0 | 0/0ms | 0/0ms | 0 |

## 批量下行 Bridge

| 玩家 | Gate batch/s | recipients/s | recipients/batch | Bridge copy | logical outbound |
|---:|---:|---:|---:|---:|---:|
| 3000 | 3634 | 120751 | 33.23 | 27.23MB/s | 5101.61MB/s |

## 容量判断

- 保守容量点：3000 玩家，Map CPU 平均 49.9%，Probe p95/p99 238.11/314.73ms。
- 最接近 80% 的测试点：3000 玩家，Map CPU 平均 49.9%。

## Transport Backend

| 玩家 | Map read frames/op | Map write frames/op | Gate read frames/op | Gate write frames/op |
|---:|---:|---:|---:|---:|
| 3000 | 1.00 | 15.82 | 1.00 | 1.78 |

## 指标口径

- `MapProbe` 是 ActorLocation RPC，链路为客户端 -> Gate -> MapHost -> Gate -> 客户端，不产生 AOI 广播。
- Map/Gate CPU 使用正式测试窗口内的 5 秒进程 CPU 样本；平均值用于容量判断。
- Map 正式窗口至少需要 2 个 CPU 样本；不足时该测试点只作故障诊断，不参与容量候选。
- Move 按固定频率开环发送，吞吐只统计正式窗口内实际写入的请求；容量点要求实际吞吐至少达到目标的 95%。
- `backpressure` 表示入口有界队列满后等待重试，是削峰信号，不等于丢包；容量候选要求零业务错误、零 overload、零内部超时和零慢连接断开。
- 虚拟客户端不完整构造业务对象；状态测试会扫描 protobuf 顶层 repeated 字段，分别统计协议帧、状态项和消息体字节。端到端延迟由 MapProbe 独立测量。
- `push/s` 仍是全地图全量可见广播，代表最坏同屏 O(N^2) 场景。
- Map 可覆盖状态广播采用 single-flight；前一批未完成时保留最新 dirty revision，发送成功后按 revision Ack。`pending`、合并率、广播耗时和排队时间用于判断下行是否跟不上 Game.Update。
- Gate 数量用于分摊连接、编码和下行发送；MapHost 始终只有一个。
