# 单 MapHost 全图均匀 AOI 容量测试报告

- 时间：2026-08-20T04:57:01.992Z
- 拓扑：1 MapHost / 8 Gate / 1 Login / 1 LoginMgr / 1 Location
- I/O Backend：IOCP（Tokio/Mio；兼容配置值 epoll）
- 地图：10x10 AOI Grid（MapConfig 1）
- Unit 数据：Rust 权威存储，Rust 批处理并直接编码移动快照
- 玩家布局：轮询全部AOI Grid并从Grid中央Cell开始（各档平均30人/Grid）
- 进图同步模式：full（正式完整语义）
- 负载：每玩家 2Hz Move + 每玩家 0.2Hz MapProbe + 0.1Hz真实道具/技能
- 移动输入：每 2 次上报保持同一方向
- 移动画像：80%玩家在Grid内闭环；20%玩家每2秒跨越一次相邻Grid，预期跨Grid约300次/s
- Probe in-flight：每连接 1
- 压测客户端：Rust
- 两阶段进图：连接/Login并发256；全部就绪后Map Enter并发256；开环释放40人/秒
- 正式测试：30s；预热：15s；轮数：1
- Setup后空闲排空：15s（不发送Move/Probe）
- Map CPU 目标：80%（100% 表示一个逻辑核）
- 机器：13th Gen Intel(R) Core(TM) i7-13700F / 24 逻辑核 / 65292.4MB

## 1 轮中位数

| 玩家 | Map CPU avg/p90/peak | Map 窗口样本 | Gate max avg/peak | move/s | Move 达标率 | push/s | Probe/s | Probe p50 | p90 | p95 | p99 | max | move/probe errors | overload/timeout/backpressure/slow | RSS |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 3000 | 41.1/41.6/41.6% | 4 | 45.1/61.6% | 6003 | 100% | 1027463 | 600 | 297.43ms | 414.37ms | 459.62ms | 578.21ms | 758.2ms | 0/0 | 0/0/0/0 | 1710.7MB |

## 真实业务闭环

| 玩家 | business/s | 达标率 | 成功 | 业务拒绝 | 传输错误 | p50/p90/p95/p99/max |
|---:|---:|---:|---:|---:|---:|---:|
| 3000 | 300 | 100% | 6003 | 3000 | 0 | 378.43/548.7/605.99/750.51/948.94ms |

## 客户端两阶段Setup

| 玩家 | 总耗时 | 连接/Login耗时 | Map Enter耗时 | Map Enter/s |
|---:|---:|---:|---:|---:|
| 3000 | 76.44s | 1.29s | 75.15s | 39.92 |

## 背压责任分解

| 玩家 | Map Frame 正式窗口 waits/total ms | 生命周期 max wait/depth | control waits/depth | data waits/depth | Map Completion waits | Gate manager/connection/call-writer/send-writer/target-ingress overload |
|---:|---:|---:|---:|---:|---:|---:|
| 3000 | 0/0 | 0/393 | 0/317 | 0/76 | 0 | 0/0/0/0/0 |

## AOI 空间指标

| 玩家 | World/Entity/Grid | candidate/visible | 迟滞关系 | 拒绝关系 | 跨Grid/s（达标率） | 可见变化/s | 过滤覆盖/s |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 3000 | 1/3002/100 | 784465/784465 | 81498 | 0 | 97.8（32.6%） | 1525.5 | 0 |

## MapHost进图阶段

| 玩家 | 请求/失败/max in-flight | 全链路 avg/max | ID分配 avg/max | 创建Player avg/max | Location注册 avg/max | MapReady avg/max | Location确认 avg/max |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 3000 | 3000/0/9 | 117.62/269ms | 3.76/59ms | 0.19/5ms | 2.26/58ms | 0.14/4ms | 4.44/32ms |

## Admission与新玩家快照

| 玩家 | 结束队列/峰值 | 放行/失败 | 排队 avg/max | Attach avg/max | 可见变化 | Snapshot calls/items(avg) | Snapshot avg/max |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 3000 | 0/6 | 3000/0 | 78.86/173ms | 0.068/4ms | 351300 | 3000/355022(118.3) | 0.646/6ms |

## AOI Enter/Leave下行

| 玩家 | batch | enter/leave items | recipients | entity deliveries | prepare ms | publish wait ms |
|---:|---:|---:|---:|---:|---:|---:|
| 3000 | 11614 | 33975/13984 | 432971 | 510295 | 1497 | 30692 |

## NativeData 边界指标

| 玩家 | 指标样本 | scalar gets/s | scalar sets/s | batch calls/s | encoded frames/items | encoded bytes/s | live E/U/I | Pool/Scratch | scratch grows/s (total) | TS refs | Map V8 Heap peak |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 3000 | 4 | 43331.9 | 6004.9 | 48.5 | 196.4/41097 | 11.7MB/s | 9002/3002/6000 | 2.7MB/0.3MB | 0 (40) | 9002 | 112.4MB |

## NumericType复制指标

| 玩家 | NumericType | changes/s | encoded records/s | recipient deliveries/s | logical bytes/s |
|---:|---|---:|---:|---:|---:|
| 3000 | CurrentHp (1) | 17481.7 | 1898 | 497780.1 | 4.75MB/s |
| 3000 | CurrentMp (2) | 1651.4 | 3334.4 | 3334.4 | 0.03MB/s |
| 3000 | Level (3) | 0 | 0 | 0 | 0.00MB/s |
| 3000 | MaxHp (1000) | 0 | 0 | 0 | 0.00MB/s |
| 3000 | MaxMp (1001) | 0 | 0 | 0 | 0.00MB/s |
| 3000 | Attack (2000) | 0 | 0 | 0 | 0.00MB/s |
| 3000 | AttackSpeed (2001) | 0 | 0 | 0 | 0.00MB/s |
| 3000 | MoveSpeed (3000) | 0 | 0 | 0 | 0.00MB/s |
| 3000 | Numeric (10001) | 0 | 0 | 0 | 0.00MB/s |
| 3000 | Numeric (10002) | 0 | 0 | 0 | 0.00MB/s |
| 3000 | Numeric (10011) | 0 | 0 | 0 | 0.00MB/s |
| 3000 | Numeric (20001) | 0 | 0 | 0 | 0.00MB/s |
| 3000 | Numeric (20012) | 0 | 0 | 0 | 0.00MB/s |
| 3000 | Numeric (30001) | 0 | 0 | 0 | 0.00MB/s |

## Map 广播 single-flight

| 玩家 | 指标样本 | pending 采样峰值/生命周期峰值 | queued/s | coalesced/s (%) | sent/s | batch/s | frames/batch | 广播 avg/max | 排队 avg/max | failures |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 3000 | 4 | 3023/6025 | 32101 | 0 (0%) | 32291 | 869 | 37.2 | 91.65/440ms | 20.82/439ms | 0 |

## 批量下行 Bridge

| 玩家 | Gate batch/s | recipients/s | recipients/batch | Bridge copy | logical outbound |
|---:|---:|---:|---:|---:|---:|
| 3000 | 37597 | 1224266 | 32.56 | 5.88MB/s | 178.06MB/s |

## Gate 到 Map latest Actor 输入

| 玩家 | input/s | coalesced/s (%) | forwarded/s | batch/s | items/batch | pending peak | failed batch/frame | dropped |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 3000 | 5987.9 | 0 (0%) | 5990.8 | 214.5 | 27.9 | 169 | 0/0 | 0 |

## 容量判断

- 本轮没有同时满足 CPU 目标、零超时、零内部过载的容量点。
- 最接近 80% 的测试点：3000 玩家，Map CPU 平均 41.1%。

## Transport Backend

| 玩家 | Map read frames/op | Map write frames/op | Gate read frames/op | Gate write frames/op |
|---:|---:|---:|---:|---:|
| 3000 | 1.00 | 17.13 | 1.00 | 21.40 |

## 指标口径

- `MapProbe` 是 ActorLocation RPC，链路为客户端 -> Gate -> MapHost -> Gate -> 客户端，不产生 AOI 广播。
- Map/Gate CPU 使用正式测试窗口内的 5 秒进程 CPU 样本；平均值用于容量判断。
- Map 正式窗口至少需要 2 个 CPU 样本；不足时该测试点只作故障诊断，不参与容量候选。
- Move 按固定频率开环发送，吞吐只统计正式窗口内实际写入的请求；容量点要求实际吞吐至少达到目标的 95%。
- `backpressure`、overload、timeout 和 slow disconnect 都按正式测试窗口的 Counter 增量计算；Setup/入场期历史值不会污染稳态容量判断。
- `forwarding=latest` 的 ActorLocation 单向输入在 Gate 以 connectionId + msgcode 覆盖等待窗口内的旧值，并按目标 Scene 形成内部批量帧；`input/s` 是客户端输入，`forwarded/s` 是进入目标 Actor mailbox 的最终条目，`batch/s` 是实际跨进程帧。
- 背压责任分解使用固定 stage 标签：Map 的 `frame` 是网络入站业务帧，`control_ingress/data_ingress` 是物理保留队列，`completion` 是异步 Scene 操作完成；Gate 内部传输依次为 manager、目标连接、RPC writer、单向 send writer 与目标控制入口。waits/total 是正式窗口增量，max wait/max depth 是进程生命周期峰值。
- 虚拟客户端不完整构造业务对象；状态测试会扫描 protobuf 顶层 repeated 字段，分别统计协议帧、状态项和消息体字节。端到端延迟由 MapProbe 独立测量。
- `push/s` 是虚拟客户端实际收到的移动帧数；均匀基线固定20%玩家每2秒跨Grid一次，必须结合AOI空间指标中的实际跨Grid速率判断负载是否成立。
- AOI进入/离开是不可覆盖事件，但同一逻辑帧内受众完全相同的变化会合并为一个`G2C_AoiDelta`；Movement、Numeric等可覆盖状态仍走latest。
- Map 可覆盖状态广播采用 single-flight；前一批未完成时保留最新 dirty revision，发送成功后按 revision Ack。`pending`、合并率、广播耗时和排队时间用于判断下行是否跟不上 Game.Update。
- Gate 数量用于分摊连接、编码和下行发送；MapHost 始终只有一个。
