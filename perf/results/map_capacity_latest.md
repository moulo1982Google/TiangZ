# 单 MapHost 全图均匀 AOI 容量测试报告

- 时间：2026-08-19T15:39:14.041Z
- 拓扑：1 MapHost / 4 Gate / 1 Login / 1 LoginMgr / 1 Location
- I/O Backend：IOCP（Tokio/Mio；兼容配置值 epoll）
- 地图：10x10 AOI Grid（MapConfig 1）
- Unit 数据：Rust 权威存储，Rust 批处理并直接编码移动快照
- 玩家布局：轮询全部AOI Grid并从Grid中央Cell开始（各档平均10/20/30人/Grid）
- 进图同步模式：full（正式完整语义）
- 负载：每玩家 2Hz Move + 每玩家 0.2Hz MapProbe + 0.1Hz真实道具/技能
- 移动输入：每 2 次上报保持同一方向
- 移动画像：80%玩家在Grid内闭环；20%玩家每2秒跨越一次相邻Grid，预期跨Grid约100/200/300次/s
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
| 1000 | 21.3/26.2/26.2% | 5 | 53/69% | 2000 | 100% | 370711 | 200 | 0.56ms | 4.05ms | 6ms | 9.44ms | 30.84ms | 0/0 | 0/0/0/0 | 800.9MB |
| 2000 | 42.2/47.8/47.8% | 5 | 168.2/200% | 4000 | 100% | 1128267 | 400 | 3.62ms | 16.56ms | 22.72ms | 32.09ms | 112.66ms | 0/0 | 0/0/0/0 | 1004.8MB |
| 3000 | 55.8/64.6/64.6% | 5 | 264.5/302.2% | 6000 | 100% | 1719166 | 600 | 124.83ms | 190.9ms | 212.92ms | 262.79ms | 380.75ms | 0/0 | 0/0/0/0 | 1223.7MB |

## 真实业务闭环

| 玩家 | business/s | 达标率 | 成功 | 业务拒绝 | 传输错误 | p50/p90/p95/p99/max |
|---:|---:|---:|---:|---:|---:|---:|
| 1000 | 100 | 100% | 2000 | 1000 | 0 | 1.65/7.16/9.11/12.59/21.46ms |
| 2000 | 200 | 100% | 3999 | 2000 | 0 | 4.74/22.6/27.91/38.1/130.31ms |
| 3000 | 300 | 100% | 6002 | 3000 | 0 | 162.76/245.23/272.46/327.79/428.98ms |

## 客户端两阶段Setup

| 玩家 | 总耗时 | 连接/Login耗时 | Map Enter耗时 | Map Enter/s |
|---:|---:|---:|---:|---:|
| 1000 | 25.79s | 0.59s | 25.2s | 39.69 |
| 2000 | 51.27s | 1.17s | 50.1s | 39.92 |
| 3000 | 76.72s | 1.61s | 75.11s | 39.94 |

## 背压责任分解

| 玩家 | Map Frame 正式窗口 waits/total ms | 生命周期 max wait/depth | control waits/depth | data waits/depth | Map Completion waits | Gate manager/connection/call-writer/send-writer/target-ingress overload |
|---:|---:|---:|---:|---:|---:|---:|
| 1000 | 0/0 | 0/15 | 0/13 | 0/4 | 0 | 0/0/0/0/0 |
| 2000 | 0/0 | 0/32 | 0/28 | 0/5 | 0 | 0/0/0/0/0 |
| 3000 | 0/0 | 0/247 | 0/234 | 0/20 | 0 | 0/0/0/0/0 |

## AOI 空间指标

| 玩家 | World/Entity/Grid | candidate/visible | 迟滞关系 | 拒绝关系 | 跨Grid/s（达标率） | 可见变化/s | 过滤覆盖/s |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1000 | 1/1002/100 | 87186/87186 | 8875 | 0 | 100.3（100.3%） | 583.3 | 0 |
| 2000 | 1/2002/100 | 352664/352664 | 36188 | 0 | 204.6（102.3%） | 2143.2 | 0 |
| 3000 | 1/3002/100 | 784773/784773 | 80848 | 0 | 282.3（94.1%） | 2865.5 | 0 |

## MapHost进图阶段

| 玩家 | 请求/失败/max in-flight | 全链路 avg/max | ID分配 avg/max | 创建Player avg/max | Location注册 avg/max | MapReady avg/max | Location确认 avg/max |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1000 | 1000/0/5 | 79.5/164ms | 0.95/14ms | 0.14/1ms | 0.45/14ms | 0.05/1ms | 0.85/14ms |
| 2000 | 2000/0/5 | 81.85/146ms | 1.18/16ms | 0.14/2ms | 0.54/13ms | 0.07/1ms | 1.06/16ms |
| 3000 | 3000/0/5 | 79.14/151ms | 1.62/21ms | 0.17/3ms | 0.69/14ms | 0.09/1ms | 1.09/15ms |

## Admission与新玩家快照

| 玩家 | 结束队列/峰值 | 放行/失败 | 排队 avg/max | Attach avg/max | 可见变化 | Snapshot calls/items(avg) | Snapshot avg/max |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1000 | 0/3 | 1000/0 | 48.2/76ms | 0.038/1ms | 38700 | 1000/39931(39.9) | 0.146/1ms |
| 2000 | 0/3 | 2000/0 | 48.15/86ms | 0.052/1ms | 155800 | 2000/158301(79.2) | 0.239/1ms |
| 3000 | 0/3 | 3000/0 | 47.17/89ms | 0.057/2ms | 351300 | 3000/355069(118.4) | 0.42/2ms |

## AOI Enter/Leave下行

| 玩家 | batch | enter/leave items | recipients | entity deliveries | prepare ms | publish wait ms |
|---:|---:|---:|---:|---:|---:|---:|
| 1000 | 8505 | 12060/7433 | 60367 | 75238 | 159 | 8698 |
| 2000 | 18966 | 35622/20781 | 231570 | 290620 | 476 | 19361 |
| 3000 | 25853 | 52308/31065 | 474128 | 576861 | 2068 | 33035 |

## NativeData 边界指标

| 玩家 | 指标样本 | scalar gets/s | scalar sets/s | batch calls/s | encoded frames/items | encoded bytes/s | live E/U/I | Pool/Scratch | scratch grows/s (total) | TS refs | Map V8 Heap peak |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1000 | 5 | 23621.8 | 2020 | 80 | 143.1/21583 | 3.3MB/s | 3002/1002/2000 | 0.7MB/0.1MB | 0 (31) | 3002 | 57.7MB |
| 2000 | 5 | 49082.7 | 4035.2 | 80.9 | 151.5/43086 | 7.7MB/s | 6002/2002/4000 | 1.3MB/0.1MB | 0 (31) | 6002 | 74.7MB |
| 3000 | 5 | 70969.9 | 6055.4 | 79.2 | 158.7/64328 | 13.0MB/s | 9002/3002/6000 | 2.7MB/0.3MB | 0 (38) | 9002 | 115.0MB |

## NumericType复制指标

| 玩家 | NumericType | changes/s | encoded records/s | recipient deliveries/s | logical bytes/s |
|---:|---|---:|---:|---:|---:|
| 1000 | CurrentHp (1) | 8311.3 | 998 | 87526.1 | 0.83MB/s |
| 1000 | CurrentMp (2) | 549.5 | 549.7 | 549.7 | 0.01MB/s |
| 1000 | Level (3) | 0 | 0 | 0 | 0.00MB/s |
| 1000 | MaxHp (1000) | 0 | 0 | 0 | 0.00MB/s |
| 1000 | MaxMp (1001) | 0 | 0 | 0 | 0.00MB/s |
| 1000 | Attack (2000) | 0 | 0 | 0 | 0.00MB/s |
| 1000 | AttackSpeed (2001) | 0 | 0 | 0 | 0.00MB/s |
| 1000 | MoveSpeed (3000) | 0 | 0 | 0 | 0.00MB/s |
| 1000 | Numeric (10001) | 0 | 0 | 0 | 0.00MB/s |
| 1000 | Numeric (10002) | 0 | 0 | 0 | 0.00MB/s |
| 1000 | Numeric (10011) | 0 | 0 | 0 | 0.00MB/s |
| 1000 | Numeric (20001) | 0 | 0 | 0 | 0.00MB/s |
| 1000 | Numeric (20012) | 0 | 0 | 0 | 0.00MB/s |
| 1000 | Numeric (30001) | 0 | 0 | 0 | 0.00MB/s |
| 2000 | CurrentHp (1) | 16644.4 | 1999.2 | 351554.1 | 3.35MB/s |
| 2000 | CurrentMp (2) | 1098 | 1098 | 1098 | 0.01MB/s |
| 2000 | Level (3) | 0 | 0 | 0 | 0.00MB/s |
| 2000 | MaxHp (1000) | 0 | 0 | 0 | 0.00MB/s |
| 2000 | MaxMp (1001) | 0 | 0 | 0 | 0.00MB/s |
| 2000 | Attack (2000) | 0 | 0 | 0 | 0.00MB/s |
| 2000 | AttackSpeed (2001) | 0 | 0 | 0 | 0.00MB/s |
| 2000 | MoveSpeed (3000) | 0 | 0 | 0 | 0.00MB/s |
| 2000 | Numeric (10001) | 0 | 0 | 0 | 0.00MB/s |
| 2000 | Numeric (10002) | 0 | 0 | 0 | 0.00MB/s |
| 2000 | Numeric (10011) | 0 | 0 | 0 | 0.00MB/s |
| 2000 | Numeric (20001) | 0 | 0 | 0 | 0.00MB/s |
| 2000 | Numeric (20012) | 0 | 0 | 0 | 0.00MB/s |
| 2000 | Numeric (30001) | 0 | 0 | 0 | 0.00MB/s |
| 3000 | CurrentHp (1) | 23980.9 | 2933.2 | 770043.6 | 7.34MB/s |
| 3000 | CurrentMp (2) | 1648.2 | 2695.6 | 2695.6 | 0.03MB/s |
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
| 1000 | 5 | 0/1002 | 22010 | 0 (0%) | 22010 | 467.6 | 47.1 | 1.94/53ms | 0.25/15ms | 0 |
| 2000 | 5 | 0/2004 | 44011 | 0 (0%) | 44011 | 966.2 | 45.6 | 2.75/52ms | 0.21/21ms | 0 |
| 3000 | 5 | 15/4838 | 52086 | 0 (0%) | 52086 | 1319.4 | 39.5 | 30.73/182ms | 5.89/181ms | 0 |

## 批量下行 Bridge

| 玩家 | Gate batch/s | recipients/s | recipients/batch | Bridge copy | logical outbound |
|---:|---:|---:|---:|---:|---:|
| 1000 | 19295 | 409579 | 21.23 | 2.12MB/s | 42.60MB/s |
| 2000 | 29524 | 1265926 | 42.88 | 4.24MB/s | 168.68MB/s |
| 3000 | 31936 | 1989538 | 62.3 | 4.95MB/s | 293.43MB/s |

## Gate 到 Map latest Actor 输入

| 玩家 | input/s | coalesced/s (%) | forwarded/s | batch/s | items/batch | pending peak | failed batch/frame | dropped |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1000 | 1999.7 | 0 (0%) | 2000.3 | 170.6 | 11.7 | 31 | 0/0 | 0 |
| 2000 | 4001.3 | 0 (0%) | 3999.3 | 164.2 | 24.4 | 79 | 0/0 | 0 |
| 3000 | 6009.9 | 0 (0%) | 6010 | 114.7 | 52.4 | 57 | 0/0 | 0 |

## 容量判断

- 保守容量点：3000 玩家，Map CPU 平均 55.8%，Probe p95/p99 212.92/262.79ms。
- 最接近 80% 的测试点：3000 玩家，Map CPU 平均 55.8%。

## Transport Backend

| 玩家 | Map read frames/op | Map write frames/op | Gate read frames/op | Gate write frames/op |
|---:|---:|---:|---:|---:|
| 1000 | 1.00 | 1.06 | 1.00 | 13.15 |
| 2000 | 1.00 | 1.22 | 1.00 | 15.37 |
| 3000 | 1.00 | 14.55 | 1.00 | 14.42 |

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
