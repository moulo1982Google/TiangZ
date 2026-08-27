# 单 MapHost 全图均匀 AOI 容量测试报告

- 时间：2026-08-25T13:19:49.879Z
- 拓扑：1 MapHost / 4 Gate / 1 Login / 1 LoginMgr / 1 Location
- I/O Backend：IOCP（Tokio/Mio；兼容配置值 epoll）
- 地图：10x10 AOI Grid（MapConfig 1）
- Unit 数据：Rust 权威存储，Rust 批处理并直接编码移动快照
- 玩家布局：轮询全部AOI Grid并从Grid中央Cell开始（各档平均20人/Grid）
- 进图同步模式：full（正式完整语义）
- 负载：每玩家 2Hz Move + 每玩家 0.2Hz MapProbe + 0.1Hz真实道具/技能
- 移动输入：每 2 次上报保持同一方向
- 移动画像：80%玩家在Grid内闭环；20%玩家每2秒跨越一次相邻Grid，预期跨Grid约200次/s
- Probe in-flight：每连接 1
- 压测客户端：Rust
- 正式测试：30s；预热：10s；轮数：1
- Setup后空闲排空：10s（不发送Move/Probe）
- Map CPU 目标：80%（100% 表示一个逻辑核）
- 机器：11th Gen Intel(R) Core(TM) i5-11300H @ 3.10GHz / 8 逻辑核 / 16167.3MB

## 1 轮中位数

| 玩家 | Map CPU avg/p90/peak | Map 窗口样本 | Gate max avg/peak | move/s | Move 达标率 | push/s | Probe/s | Probe p50 | p90 | p95 | p99 | max | move/probe errors | overload/timeout/backpressure/slow | RSS |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2000 | 54.1/62/62% | 5 | 71.4/81.5% | 3999 | 100% | 1134843 | 400 | 51.22ms | 103.82ms | 121.1ms | 162.22ms | 245.78ms | 0/0 | 0/0/0/0 | 964.6MB |

## Map Tick健康度

| 玩家 | 配置Tick | Runtime frame/s | Map update/s（中位/最差达标率） | 跳过固定帧max | 入口frames/ms | Movement/AOI/Encode 每次Update |
|---:|---:|---:|---:|---:|---:|---:|
| 2000 | 20Hz (50ms) | 20 | 20（99.9%/99.9%） | 0 | 6.6/0.4ms | 0.9/0.09/5.47ms |

## 真实业务闭环

| 玩家 | business/s | 达标率 | 成功 | 业务拒绝 | 传输错误 | p50/p90/p95/p99/max |
|---:|---:|---:|---:|---:|---:|---:|
| 2000 | 200 | 100% | 4002 | 1997 | 0 | 58.56/114.31/136.6/196.02/293ms |

## 背压责任分解

| 玩家 | Map Frame 正式窗口 waits/total ms | 生命周期 max wait/depth | control waits/depth | data waits/depth | Map Completion waits | Gate manager/connection/call-writer/send-writer/target-ingress overload |
|---:|---:|---:|---:|---:|---:|---:|
| 2000 | 0/0 | 0/343 | 0/359 | 0/14 | 0 | 0/0/0/0/0 |

## AOI 空间指标

| 玩家 | World/Entity/Grid | candidate/visible | 迟滞关系 | 拒绝关系 | 跨Grid/s（达标率） | 可见变化/s | 过滤覆盖/s |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 2000 | 1/2002/100 | 350957/350957 | 33695 | 0 | 201.8（100.9%） | 1727.6 | 0 |

## MapHost进图阶段

| 玩家 | 请求/失败/max in-flight | 全链路 avg/max | ID分配 avg/max | 创建Player avg/max | Location注册 avg/max | MapReady avg/max | Location确认 avg/max |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 2000 | 2000/0/512 | 11133.02/12908ms | 8.53/35ms | 0.18/5ms | 13.33/83ms | 0.23/5ms | 4.08/84ms |

## Admission与新玩家快照

| 玩家 | 结束队列/峰值 | 放行/失败 | 排队 avg/max | Attach avg/max | 可见变化 | Snapshot calls/items(avg) | Snapshot avg/max |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 2000 | 0/512 | 2000/0 | 11071.71/12818ms | 0.119/3ms | 155800 | 2000/158517(79.3) | 0.54/4ms |

## AOI Enter/Leave下行

| 玩家 | batch | enter/leave items | recipients | entity deliveries | prepare ms | publish wait ms |
|---:|---:|---:|---:|---:|---:|---:|
| 2000 | 14294 | 28254/14616 | 211847 | 256741 | 983 | 21744 |

## NativeData 边界指标

| 玩家 | 指标样本 | scalar gets/s | scalar sets/s | batch calls/s | encoded frames/items | encoded bytes/s | live E/U/I | Pool/Scratch | scratch grows/s (total) | TS refs | Map V8 Heap peak |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2000 | 5 | 49134.7 | 4061.3 | 86.4 | 177.2/43060 | 7.7MB/s | 6002/2002/4000 | 1.3MB/0.3MB | 0 (23) | 6002 | 78.4MB |

## NumericType复制指标

| 玩家 | NumericType | changes/s | encoded records/s | recipient deliveries/s | logical bytes/s |
|---:|---|---:|---:|---:|---:|
| 2000 | CurrentHp (1) | 15974 | 1916.2 | 336761.4 | 3.21MB/s |
| 2000 | CurrentMp (2) | 1099.6 | 1112.4 | 1112.4 | 0.01MB/s |
| 2000 | Level (3) | 0 | 0 | 0 | 0.00MB/s |
| 2000 | MaxHp (1000) | 27.6 | 28.7 | 4941.2 | 0.05MB/s |
| 2000 | MaxMp (1001) | 0 | 0 | 0 | 0.00MB/s |
| 2000 | Attack (2000) | 0 | 0 | 0 | 0.00MB/s |
| 2000 | AttackSpeed (2001) | 0 | 0 | 0 | 0.00MB/s |
| 2000 | MoveSpeed (3000) | 0 | 0 | 0 | 0.00MB/s |
| 2000 | Numeric (10001) | 0 | 0 | 0 | 0.00MB/s |
| 2000 | Numeric (10002) | 27.6 | 28.7 | 28.7 | 0.00MB/s |
| 2000 | Numeric (10011) | 0 | 0 | 0 | 0.00MB/s |
| 2000 | Numeric (20001) | 0 | 0 | 0 | 0.00MB/s |
| 2000 | Numeric (20012) | 0 | 0 | 0 | 0.00MB/s |
| 2000 | Numeric (30001) | 0 | 0 | 0 | 0.00MB/s |

## Map 广播 single-flight

| 玩家 | 指标样本 | pending 采样峰值/生命周期峰值 | queued/s | coalesced/s (%) | superseded/s | sent/s | batch/s | frames/batch | 广播 avg/max | 排队 avg/max | failures/capacity rejects |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2000 | 5 | 4/8014 | 170603 | 0 (0%) | 0 | 170603 | 1981.4 | 86.1 | 8.92/81ms | 0.41/79ms | 0/0 |

## 批量下行 Bridge

| 玩家 | Gate batch/s | recipients/s | recipients/batch | Bridge copy | logical outbound |
|---:|---:|---:|---:|---:|---:|
| 2000 | 29671 | 1274270 | 42.95 | 4.22MB/s | 168.86MB/s |

## Gate 出站通道

| 玩家 | reliable enqueue/s | latest enqueue/s | last control/reliable/latest | 单Gate max control/reliable/latest/total |
|---:|---:|---:|---:|---:|
| 2000 | 1486 | 27186 | 4/10/6 | 113/153/759/784 |

## Gate 到 Map latest Actor 输入

| 玩家 | input/s | coalesced/s (%) | forwarded/s | batch/s | items/batch | pending peak | failed batch/frame | dropped |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2000 | 3996.4 | 0 (0%) | 3999.2 | 134.4 | 29.7 | 138 | 0/0 | 0 |

## 容量判断

- 保守容量点：2000 玩家，Map CPU 平均 54.1%，Probe p95/p99 121.1/162.22ms。
- 最接近 80% 的测试点：2000 玩家，Map CPU 平均 54.1%。

## Transport Backend

| 玩家 | Map read frames/op | Map write frames/op | Gate read frames/op | Gate write frames/op |
|---:|---:|---:|---:|---:|
| 2000 | 1.00 | 1.01 | 1.00 | 23.01 |

## 指标口径

- `MapProbe` 是 ActorLocation RPC，链路为客户端 -> Gate -> MapHost -> Gate -> 客户端，不产生 AOI 广播。
- Map/Gate CPU 使用正式测试窗口内的 5 秒进程 CPU 样本；平均值用于容量判断。
- Map 正式窗口至少需要 2 个 CPU 样本；不足时该测试点只作故障诊断，不参与容量候选。
- 容量候选要求Map业务Update达到配置固定Tick的95%以上，且正式窗口没有跳过固定帧。Map Update是同步回调；高入站负载会拉长固定帧之前的Scene mailbox与V8 microtask泵送，使Runtime frame/s和Map update/s一起下降。
- Move 按固定频率开环发送，吞吐只统计正式窗口内实际写入的请求；容量点要求实际吞吐至少达到目标的 95%。
- `backpressure`、overload、timeout 和 slow disconnect 都按正式测试窗口的 Counter 增量计算；Setup/入场期历史值不会污染稳态容量判断。
- `forwarding=latest` 的 ActorLocation 单向输入在 Gate 以 connectionId + msgcode 覆盖等待窗口内的旧值，并按目标 Scene 形成内部批量帧；`input/s` 是客户端输入，`forwarded/s` 是进入目标 Actor mailbox 的最终条目，`batch/s` 是实际跨进程帧。
- 背压责任分解使用固定 stage 标签：Map 的 `frame` 是网络入站业务帧，`control_ingress/data_ingress` 是物理保留队列，`completion` 是异步 Scene 操作完成；Gate 内部传输依次为 manager、目标连接、RPC writer、单向 send writer 与目标控制入口。waits/total 是正式窗口增量，max wait/max depth 是进程生命周期峰值。
- 虚拟客户端不完整构造业务对象；状态测试会扫描 protobuf 顶层 repeated 字段，分别统计协议帧、状态项和消息体字节。端到端延迟由 MapProbe 独立测量。
- `push/s` 是虚拟客户端实际收到的移动帧数；均匀基线固定20%玩家每2秒跨Grid一次，必须结合AOI空间指标中的实际跨Grid速率和Map update达标率判断负载是否成立。
- AOI进入/离开是不可覆盖事件，但同一逻辑帧内受众完全相同的变化会合并为一个`G2C_AoiDelta`；Movement、Numeric等可覆盖状态仍走latest。
- Map 可覆盖状态广播采用 single-flight；前一批未完成时保留最新 dirty revision，发送成功后按 revision Ack。`pending`、合并率、广播耗时和排队时间用于判断下行是否跟不上 Game.Update。
- Gate 数量用于分摊连接、编码和下行发送；MapHost 始终只有一个。
