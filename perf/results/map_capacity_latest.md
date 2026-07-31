# 单 MapHost 全图均匀 AOI 容量测试报告

- 时间：2026-07-31T05:01:44.367Z
- 拓扑：1 MapHost / 16 Gate / 1 Login / 1 LoginMgr / 1 Location
- I/O Backend：IOCP（Tokio/Mio；兼容配置值 epoll）
- 地图：15x15 AOI Grid（MapConfig 1015）
- Unit 数据：Rust 权威存储，Rust 批处理并直接编码移动快照
- 玩家布局：轮询全部AOI Grid，固定在Grid中央Cell（各档平均13.33人/Grid）
- 负载：每玩家 5Hz Move + 每玩家 0Hz MapProbe
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
| 3000 | 48.3/57.1/69.6% | 11 | 50.6/67.2% | 15000 | 100% | 511810 | 0 | 0ms | 0ms | 0ms | 0ms | 0ms | 0/0 | 0/0/0/0 | 1568.1MB |

## 背压责任分解

| 玩家 | Map Frame 正式窗口 waits/total ms | 生命周期 max wait/depth | Map Completion 正式窗口 waits | Gate 正式窗口 manager/connection/call-writer/send-writer overload |
|---:|---:|---:|---:|---:|
| 3000 | 0/0 | 0/1286 | 0 | 0/0/0/0 |

## AOI 空间指标

| 玩家 | World/Entity/Grid | candidate/visible | 跨Grid/s | 可见变化/s | 过滤覆盖/s |
|---:|---:|---:|---:|---:|---:|
| 3000 | 1/3000/225 | 329370/329370 | 2.8 | 73.5 | 0 |

## 地图进入队列

| 玩家 | 测量结束队列 | 生命周期峰值 | 已放行 | 失败 |
|---:|---:|---:|---:|---:|
| 3000 | 0 | 16 | 3000 | 0 |

## NativeData 边界指标

| 玩家 | 指标样本 | scalar gets/s | scalar sets/s | batch calls/s | encoded frames/items | encoded bytes/s | live E/U/I | Pool/Scratch | scratch grows/s (total) | TS refs | Map V8 Heap peak |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 3000 | 11 | 320.1 | 14998.9 | 80 | 319.9/59974 | 26.6MB/s | 6000/3000/3000 | 2.5MB/0.2MB | 0 (15) | 6000 | 40.5MB |

## Map 广播 single-flight

| 玩家 | 指标样本 | pending 采样峰值/生命周期峰值 | queued/s | coalesced/s (%) | sent/s | batch/s | frames/batch | 广播 avg/max | 排队 avg/max | failures |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 3000 | 11 | 0/3000 | 59976 | 0 (0%) | 59976 | 22.1 | 2719.9 | 1.9/78ms | 0/1ms | 0 |

## 批量下行 Bridge

| 玩家 | Gate batch/s | recipients/s | recipients/batch | Bridge copy | logical outbound |
|---:|---:|---:|---:|---:|---:|
| 3000 | 73648 | 507305 | 6.89 | 24.74MB/s | 169.34MB/s |

## 容量判断

- 保守容量点：3000 玩家，Map CPU 平均 48.3%，Probe p95/p99 0/0ms。
- 最接近 85% 的测试点：3000 玩家，Map CPU 平均 48.3%。

## Transport Backend

| 玩家 | Map read frames/op | Map write frames/op | Gate read frames/op | Gate write frames/op |
|---:|---:|---:|---:|---:|
| 3000 | 1.00 | 0.00 | 1.00 | 8.05 |

## 指标口径

- `MapProbe` 是 ActorLocation RPC，链路为客户端 -> Gate -> MapHost -> Gate -> 客户端，不产生 AOI 广播。
- Map/Gate CPU 使用正式测试窗口内的 5 秒进程 CPU 样本；平均值用于容量判断。
- Map 正式窗口至少需要 2 个 CPU 样本；不足时该测试点只作故障诊断，不参与容量候选。
- Move 按固定频率开环发送，吞吐只统计正式窗口内实际写入的请求；容量点要求实际吞吐至少达到目标的 95%。
- `backpressure`、overload、timeout 和 slow disconnect 都按正式测试窗口的 Counter 增量计算；Setup/入场期历史值不会污染稳态容量判断。
- 背压责任分解使用固定 stage 标签：Map 的 `frame` 是网络入站业务帧，`completion` 是异步 Scene 操作完成；Gate 内部传输依次为 manager、目标连接、RPC writer 与单向 send writer 队列。waits/total 是正式窗口增量，max wait/max depth 是进程生命周期峰值。
- 虚拟客户端不完整构造业务对象；状态测试会扫描 protobuf 顶层 repeated 字段，分别统计协议帧、状态项和消息体字节。端到端延迟由 MapProbe 独立测量。
- `push/s` 是虚拟客户端实际收到的移动帧数；Bench布局使用Grid内闭合轨迹，正式窗口应没有持续跨Grid或可见关系变化。
- AOI进入/离开是不可覆盖事件，但同一逻辑帧内受众完全相同的变化会合并为一个`G2C_AoiDelta`；Movement、Numeric等可覆盖状态仍走latest。
- Map 可覆盖状态广播采用 single-flight；前一批未完成时保留最新 dirty revision，发送成功后按 revision Ack。`pending`、合并率、广播耗时和排队时间用于判断下行是否跟不上 Game.Update。
- Gate 数量用于分摊连接、编码和下行发送；MapHost 始终只有一个。
