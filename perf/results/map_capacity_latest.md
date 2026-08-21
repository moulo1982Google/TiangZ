# 单 MapHost 全图均匀 AOI 容量测试报告

- 时间：2026-08-21T01:11:27.111Z
- 拓扑：1 MapHost / 12 Gate / 1 Login / 1 LoginMgr / 1 Location
- I/O Backend：IOCP（Tokio/Mio；兼容配置值 epoll）
- 地图：10x10 AOI Grid（MapConfig 1）
- Unit 数据：Rust 权威存储，Rust 批处理并直接编码移动快照
- 玩家布局：轮询全部AOI Grid并从Grid中央Cell开始（各档平均40人/Grid）
- 进图同步模式：full（正式完整语义）
- 负载：每玩家 2Hz Move + 每玩家 0.2Hz MapProbe + 0.1Hz真实道具/技能
- 移动输入：每 2 次上报保持同一方向
- 移动画像：80%玩家在Grid内闭环；20%玩家每2秒跨越一次相邻Grid，预期跨Grid约400次/s
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
| 4000 | 64.5/69/69% | 5 | 93.2/111.5% | 7994 | 99.9% | 2127747 | 799 | 208.66ms | 291.28ms | 316.7ms | 365.84ms | 475.21ms | 0/0 | 0/0/0/0 | 2436.8MB |

## 真实业务闭环

| 玩家 | business/s | 达标率 | 成功 | 业务拒绝 | 传输错误 | p50/p90/p95/p99/max |
|---:|---:|---:|---:|---:|---:|---:|
| 4000 | 400 | 100% | 7992 | 4002 | 0 | 265.45/387.54/422.22/483.41/603.71ms |

## 客户端两阶段Setup

| 玩家 | 总耗时 | 连接/Login耗时 | Map Enter耗时 | Map Enter/s |
|---:|---:|---:|---:|---:|
| 4000 | 102.21s | 2.15s | 100.06s | 39.98 |

## 背压责任分解

| 玩家 | Map Frame 正式窗口 waits/total ms | 生命周期 max wait/depth | control waits/depth | data waits/depth | Map Completion waits | Gate manager/connection/call-writer/send-writer/target-ingress overload |
|---:|---:|---:|---:|---:|---:|---:|
| 4000 | 0/0 | 0/391 | 0/328 | 0/81 | 0 | 0/0/0/0/0 |

## AOI 空间指标

| 玩家 | World/Entity/Grid | candidate/visible | 迟滞关系 | 拒绝关系 | 跨Grid/s（达标率） | 可见变化/s | 过滤覆盖/s |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 4000 | 1/4002/100 | 1395653/1395653 | 143160 | 0 | 164.4（41.1%） | 4035.8 | 0 |

## MapHost进图阶段

| 玩家 | 请求/失败/max in-flight | 全链路 avg/max | ID分配 avg/max | 创建Player avg/max | Location注册 avg/max | MapReady avg/max | Location确认 avg/max |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 4000 | 4000/0/6 | 102.57/148ms | 2.27/20ms | 0.2/3ms | 0.88/20ms | 0.16/2ms | 1.68/15ms |

## Admission与新玩家快照

| 玩家 | 结束队列/峰值 | 放行/失败 | 排队 avg/max | Attach avg/max | 可见变化 | Snapshot calls/items(avg) | Snapshot avg/max |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 4000 | 0/4 | 4000/0 | 68.97/113ms | 0.089/3ms | 625200 | 4000/630180(157.5) | 0.592/3ms |

## AOI Enter/Leave下行

| 玩家 | batch | enter/leave items | recipients | entity deliveries | prepare ms | publish wait ms |
|---:|---:|---:|---:|---:|---:|---:|
| 4000 | 23805 | 63950/34970 | 816851 | 988889 | 1916 | 40178 |

## NativeData 边界指标

| 玩家 | 指标样本 | scalar gets/s | scalar sets/s | batch calls/s | encoded frames/items | encoded bytes/s | live E/U/I | Pool/Scratch | scratch grows/s (total) | TS refs | Map V8 Heap peak |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 4000 | 5 | 79883.7 | 8038 | 65.8 | 398.4/73556 | 29.6MB/s | 12002/4002/8000 | 2.7MB/0.3MB | 0 (39) | 12002 | 159.6MB |

## NumericType复制指标

| 玩家 | NumericType | changes/s | encoded records/s | recipient deliveries/s | logical bytes/s |
|---:|---|---:|---:|---:|---:|
| 4000 | CurrentHp (1) | 29423.2 | 3315.8 | 1160054.7 | 11.06MB/s |
| 4000 | CurrentMp (2) | 2201.2 | 5280.9 | 5280.9 | 0.05MB/s |
| 4000 | Level (3) | 0 | 0 | 0 | 0.00MB/s |
| 4000 | MaxHp (1000) | 0 | 0 | 0 | 0.00MB/s |
| 4000 | MaxMp (1001) | 0 | 0 | 0 | 0.00MB/s |
| 4000 | Attack (2000) | 0 | 0 | 0 | 0.00MB/s |
| 4000 | AttackSpeed (2001) | 0 | 0 | 0 | 0.00MB/s |
| 4000 | MoveSpeed (3000) | 0 | 0 | 0 | 0.00MB/s |
| 4000 | Numeric (10001) | 0 | 0 | 0 | 0.00MB/s |
| 4000 | Numeric (10002) | 0 | 0 | 0 | 0.00MB/s |
| 4000 | Numeric (10011) | 0 | 0 | 0 | 0.00MB/s |
| 4000 | Numeric (20001) | 0 | 0 | 0 | 0.00MB/s |
| 4000 | Numeric (20012) | 0 | 0 | 0 | 0.00MB/s |
| 4000 | Numeric (30001) | 0 | 0 | 0 | 0.00MB/s |

## Map 广播 single-flight

| 玩家 | 指标样本 | pending 采样峰值/生命周期峰值 | queued/s | coalesced/s (%) | superseded/s | sent/s | batch/s | frames/batch | 广播 avg/max | 排队 avg/max | failures/capacity rejects |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 4000 | 5 | 48021/52031 | 621676 | 0 (0%) | 0 | 621676 | 6466.1 | 96.1 | 77.89/292ms | 2.94/291ms | 0/0 |

## 批量下行 Bridge

| 玩家 | Gate batch/s | recipients/s | recipients/batch | Bridge copy | logical outbound |
|---:|---:|---:|---:|---:|---:|
| 4000 | 84344 | 2584975 | 30.65 | 15.06MB/s | 405.82MB/s |

## Gate 到 Map latest Actor 输入

| 玩家 | input/s | coalesced/s (%) | forwarded/s | batch/s | items/batch | pending peak | failed batch/frame | dropped |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 4000 | 8004.5 | 0 (0%) | 8004.1 | 373.7 | 21.4 | 257 | 0/0 | 0 |

## 容量判断

- 本轮没有同时满足 CPU 目标、零超时、零内部过载的容量点。
- 最接近 80% 的测试点：4000 玩家，Map CPU 平均 64.5%。

## Transport Backend

| 玩家 | Map read frames/op | Map write frames/op | Gate read frames/op | Gate write frames/op |
|---:|---:|---:|---:|---:|
| 4000 | 1.00 | 10.59 | 1.00 | 23.09 |

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
