# 单 MapHost 同屏容量测试报告

- 时间：2026-07-31T14:35:33.909Z
- 拓扑：1 MapHost / 16 Gate / 1 Login / 1 LoginMgr / 1 Location
- I/O Backend：IOCP（Tokio/Mio；兼容配置值 epoll）
- 地图：10x10 AOI Grid（MapConfig 1）
- Unit 数据：Rust 权威存储，Rust 批处理并直接编码移动快照
- 玩家布局：固定单个AOI Grid内的安全轨迹（不跨Grid）
- 进图同步模式：full（正式完整语义）
- 负载：Probe Only，每玩家 0.2Hz MapProbe
- Probe in-flight：每连接 1
- 压测客户端：Rust
- 两阶段进图：连接/Login并发512；全部就绪后Map Enter并发1000
- 正式测试：10s；预热：5s；轮数：1
- Map CPU 目标：80%（100% 表示一个逻辑核）
- 机器：13th Gen Intel(R) Core(TM) i7-13700F / 24 逻辑核 / 65292.4MB

## 1 轮中位数

| 玩家 | Map CPU avg/p90/peak | Map 窗口样本 | Gate max avg/peak | move/s | Move 达标率 | push/s | Probe/s | Probe p50 | p90 | p95 | p99 | max | move/probe errors | overload/timeout/backpressure/slow | RSS |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1000 | 4.1/4.1/4.1% | 1 | 2.5/2.5% | 0 | 100% | 0 | 200 | 1.05ms | 3.32ms | 4.34ms | 24.56ms | 39.02ms | 0/0 | 0/0/0/0 | 1179.6MB |

## 客户端两阶段Setup

| 玩家 | 总耗时 | 连接/Login耗时 | Map Enter耗时 | Map Enter/s |
|---:|---:|---:|---:|---:|
| 1000 | 51.41s | 1.03s | 50.38s | 19.85 |

## 背压责任分解

| 玩家 | Map Frame 正式窗口 waits/total ms | 生命周期 max wait/depth | Map Completion 正式窗口 waits | Gate 正式窗口 manager/connection/call-writer/send-writer overload |
|---:|---:|---:|---:|---:|
| 1000 | 0/0 | 0/621 | 0 | 0/0/0/0 |

## AOI 空间指标

| 玩家 | World/Entity/Grid | candidate/visible | 迟滞关系 | 拒绝关系 | 跨Grid/s | 可见变化/s | 过滤覆盖/s |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1000 | 1/1000/1 | 999000/999000 | 0 | 0 | 0 | 0 | 0 |

## MapHost进图阶段

| 玩家 | 请求/失败/max in-flight | 全链路 avg/max | ID分配 avg/max | 创建Player avg/max | Location注册 avg/max | MapReady avg/max | Location确认 avg/max |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1000 | 1000/0/1000 | 25116.79/50089ms | 84.34/114ms | 0.08/5ms | 88.1/126ms | 0.13/42ms | 8.17/87ms |

## Admission与新玩家快照

| 玩家 | 结束队列/峰值 | 放行/失败 | 排队 avg/max | Attach avg/max | 可见变化 | Snapshot calls/items(avg) | Snapshot avg/max |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1000 | 0/997 | 1000/0 | 24913.15/49864ms | 0.315/8ms | 499500 | 1000/500500(500.5) | 2.094/12ms |

## AOI Enter/Leave下行

| 玩家 | batch | enter/leave items | recipients | entity deliveries | prepare ms | publish wait ms |
|---:|---:|---:|---:|---:|---:|---:|
| 1000 | 999 | 999/0 | 499500 | 499500 | 710 | 15284 |

## NativeData 边界指标

| 玩家 | 指标样本 | scalar gets/s | scalar sets/s | batch calls/s | encoded frames/items | encoded bytes/s | live E/U/I | Pool/Scratch | scratch grows/s (total) | TS refs | Map V8 Heap peak |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1000 | 1 | 0 | 0 | 0 | 0/0 | 0.0MB/s | 2000/1000/1000 | 0.6MB/0.1MB | 0 (10) | 2000 | 33.7MB |

## Map 广播 single-flight

| 玩家 | 指标样本 | pending 采样峰值/生命周期峰值 | queued/s | coalesced/s (%) | sent/s | batch/s | frames/batch | 广播 avg/max | 排队 avg/max | failures |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1000 | 1 | 0/6 | 0 | 0 (0%) | 0 | 0 | 0 | 0/94ms | 0/8ms | 0 |

## 批量下行 Bridge

| 玩家 | Gate batch/s | recipients/s | recipients/batch | Bridge copy | logical outbound |
|---:|---:|---:|---:|---:|---:|
| 1000 | 0 | 0 | 0 | 0.00MB/s | 0.00MB/s |

## 容量判断

- 本轮没有同时满足 CPU 目标、零超时、零内部过载的容量点。

## Transport Backend

| 玩家 | Map read frames/op | Map write frames/op | Gate read frames/op | Gate write frames/op |
|---:|---:|---:|---:|---:|
| 1000 | 0.00 | 0.00 | 0.00 | 0.00 |

## 指标口径

- `MapProbe` 是 ActorLocation RPC，链路为客户端 -> Gate -> MapHost -> Gate -> 客户端，不产生 AOI 广播。
- Map/Gate CPU 使用正式测试窗口内的 5 秒进程 CPU 样本；平均值用于容量判断。
- Map 正式窗口至少需要 2 个 CPU 样本；不足时该测试点只作故障诊断，不参与容量候选。
- Probe Only 模式关闭 Move 和 AOI 广播，用于测 MapHost pingpong RPC 基线吞吐。
- `backpressure`、overload、timeout 和 slow disconnect 都按正式测试窗口的 Counter 增量计算；Setup/入场期历史值不会污染稳态容量判断。
- 背压责任分解使用固定 stage 标签：Map 的 `frame` 是网络入站业务帧，`completion` 是异步 Scene 操作完成；Gate 内部传输依次为 manager、目标连接、RPC writer 与单向 send writer 队列。waits/total 是正式窗口增量，max wait/max depth 是进程生命周期峰值。
- Probe Only 模式不包含 AOI 下行。
- `push/s` 是虚拟客户端实际收到的移动帧数；Bench布局使用Grid内闭合轨迹，正式窗口应没有持续跨Grid或可见关系变化。
- AOI进入/离开是不可覆盖事件，但同一逻辑帧内受众完全相同的变化会合并为一个`G2C_AoiDelta`；Movement、Numeric等可覆盖状态仍走latest。
- Map 可覆盖状态广播采用 single-flight；前一批未完成时保留最新 dirty revision，发送成功后按 revision Ack。`pending`、合并率、广播耗时和排队时间用于判断下行是否跟不上 Game.Update。
- Gate 数量用于分摊连接、编码和下行发送；MapHost 始终只有一个。
