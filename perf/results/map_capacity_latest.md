# 单 MapHost 全图均匀 AOI 容量测试报告

- 时间：2026-07-30T11:31:25.440Z
- 拓扑：1 MapHost / 16 Gate / 1 Login / 1 LoginMgr / 1 Location
- I/O Backend：IOCP（Tokio/Mio；兼容配置值 epoll）
- 地图：10x10 AOI Grid（MapConfig 1）
- Unit 数据：Rust 权威存储，Rust 批处理并直接编码移动快照
- 玩家布局：轮询全部AOI Grid，固定在Grid中央Cell（各档平均10人/Grid）
- 负载：每玩家 5Hz Move + 每玩家 1Hz MapProbe
- 移动输入：每 5 次上报保持同一方向
- Probe in-flight：每连接 1
- 压测客户端：Rust
- 正式测试：60s；预热：10s；轮数：1
- Setup后空闲排空：15s（不发送Move/Probe）
- Map CPU 目标：85%（100% 表示一个逻辑核）
- 机器：13th Gen Intel(R) Core(TM) i7-13700F / 24 逻辑核 / 65292.4MB

## 1 轮中位数

| 玩家 | Map CPU avg/p90/peak | Map 窗口样本 | Gate max avg/peak | move/s | Move 达标率 | push/s | Probe/s | Probe p50 | p90 | p95 | p99 | max | move/probe errors | overload/timeout/backpressure/slow | RSS |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1000 | 86.1/102.6/106.1% | 12 | 27/45.3% | 5000 | 100% | 162898 | 1000 | 5.54ms | 14.94ms | 18.72ms | 24.25ms | 54.72ms | 0/0 | 0/0/0/0 | 1501.4MB |

## AOI 空间指标

| 玩家 | World/Entity/Grid | candidate/visible | 跨Grid/s | 可见变化/s | 过滤覆盖/s |
|---:|---:|---:|---:|---:|---:|
| 1000 | 1/1000/100 | 78376/78376 | 1.2 | 17.7 | 0 |

## 地图进入队列

| 玩家 | 测量结束队列 | 生命周期峰值 | 已放行 | 失败 |
|---:|---:|---:|---:|---:|
| 1000 | 0 | 16 | 1000 | 0 |

## NativeData 边界指标

| 玩家 | 指标样本 | scalar gets/s | scalar sets/s | batch calls/s | encoded frames/items | encoded bytes/s | live E/U/I | Pool/Scratch | scratch grows/s (total) | TS refs | Map V8 Heap peak |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1000 | 12 | 79.2 | 5001.8 | 80 | 2071.9/20010 | 1.2MB/s | 2000/1000/1000 | 0.6MB/0.1MB | 0 (13) | 2000 | 26.3MB |

## Map 广播 single-flight

| 玩家 | 指标样本 | pending 采样峰值/生命周期峰值 | queued/s | coalesced/s (%) | sent/s | batch/s | frames/batch | 广播 avg/max | 排队 avg/max | failures |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1000 | 12 | 0/1000 | 20011 | 0 (0%) | 20011 | 20.7 | 968.4 | 6.65/78ms | 0/1ms | 0 |

## 批量下行 Bridge

| 玩家 | Gate batch/s | recipients/s | recipients/batch | Bridge copy | logical outbound |
|---:|---:|---:|---:|---:|---:|
| 1000 | 33552 | 164088 | 4.89 | 7.99MB/s | 39.49MB/s |

## 容量判断

- 本轮没有同时满足 CPU 目标、零超时、零内部过载的容量点。
- 最接近 85% 的测试点：1000 玩家，Map CPU 平均 86.1%。

## Transport Backend

| 玩家 | Map read frames/op | Map write frames/op | Gate read frames/op | Gate write frames/op |
|---:|---:|---:|---:|---:|
| 1000 | 1.00 | 1.25 | 1.00 | 3.80 |

## 指标口径

- `MapProbe` 是 ActorLocation RPC，链路为客户端 -> Gate -> MapHost -> Gate -> 客户端，不产生 AOI 广播。
- Map/Gate CPU 使用正式测试窗口内的 5 秒进程 CPU 样本；平均值用于容量判断。
- Map 正式窗口至少需要 2 个 CPU 样本；不足时该测试点只作故障诊断，不参与容量候选。
- Move 按固定频率开环发送，吞吐只统计正式窗口内实际写入的请求；容量点要求实际吞吐至少达到目标的 95%。
- `backpressure` 表示入口有界队列满后等待重试，是削峰信号，不等于丢包；容量候选要求零业务错误、零 overload、零内部超时和零慢连接断开。
- 虚拟客户端不完整构造业务对象；状态测试会扫描 protobuf 顶层 repeated 字段，分别统计协议帧、状态项和消息体字节。端到端延迟由 MapProbe 独立测量。
- `push/s` 是虚拟客户端实际收到的移动帧数；Bench布局使用Grid内闭合轨迹，正式窗口应没有持续跨Grid或可见关系变化。
- AOI进入/离开是不可覆盖事件，但同一逻辑帧内受众完全相同的变化会合并为一个`G2C_AoiDelta`；Movement、Numeric等可覆盖状态仍走latest。
- Map 可覆盖状态广播采用 single-flight；前一批未完成时保留最新 dirty revision，发送成功后按 revision Ack。`pending`、合并率、广播耗时和排队时间用于判断下行是否跟不上 Game.Update。
- Gate 数量用于分摊连接、编码和下行发送；MapHost 始终只有一个。
