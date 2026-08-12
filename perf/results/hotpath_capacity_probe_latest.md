# 全链路性能测试报告

- 时间：2026-08-12T10:20:48.852Z
- 正式测试：30s；预热：5s；轮数：1
- 服务端：127.0.0.1；独立部署：否
- 压测机：13th Gen Intel(R) Core(TM) i7-13700F / 24 逻辑核 / 65292.4MB

## 1 轮中位数

| 部署 | 负载 | 玩家 | move/s | push/s | 确认数 | move p95 | business/s | business成功 | business拒绝 | business传输错 | business p95 | stalled | Server CPU% | Server RSS | Queue峰值(启动至今) | Backpressure | Inner超载 | Inner超时 | Load CPU ms | Load RSS |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| all | steady-2hz | 200 | 400 | 4006 | 12000 | 61.92 | 0 | 0 | 0 | 0 | 0 | 0 | 31.6 | 196.9MB | 20 | 0 | 0 | 0 | 6282 | 189.4MB |
| all | steady-2hz | 500 | 721 | 9025 | 21617 | 4230.92 | 0 | 0 | 0 | 0 | 0 | 0 | 68.7 | 548.1MB | 249 | 0 | 0 | 0 | 25359 | 749.7MB |
| all | steady-2hz | 750 | 782 | 11930 | 23462 | 9831.59 | 0 | 0 | 0 | 0 | 0 | 0 | 113.2 | 995.2MB | 223 | 0 | 0 | 0 | 35078 | 1029.0MB |

## Mailbox 低分配观测

| 部署 | 负载 | 玩家 | 有序调用排队 | 单向消息排队 | 单向异步 | Mailbox峰值深度 |
|---|---|---:|---:|---:|---:|---:|
| all | steady-2hz | 200 | 0 | 0 | 0 | 0 |
| all | steady-2hz | 500 | 0 | 0 | 0 | 0 |
| all | steady-2hz | 750 | 0 | 0 | 0 | 0 |

## 指标口径

- `move/s` 是客户端发送移动到收到自身权威位置 Push 的闭环吞吐。
- `business/s` 是真实 UseItem 与 CastSkill 请求的响应吞吐；`business成功/拒绝`按服务端业务响应分类，`business传输错`才表示连接、超时或协议层异常。
- 业务负载默认交替使用1001道具和3005友方技能；压测客户端从EnterMap快照读取1001的ItemId，服务端仍是唯一权威。
- `确认数` 统计所有匹配 `acknowledgedSequence` 的权威 Push；延迟分位数使用每玩家最多约 1024 个均匀样本，避免长稳工具自身内存线性增长。
- `push/s` 是所有客户端实际收到的 EntityMove 数；当前仍为同地图全量可见，尚未启用 AOI。
- Server CPU/RSS/GC/队列来自各 Runtime 的 `/metrics` 采样；若旧 Runtime 没有健康端点才回退到 `[process-metrics]` 日志，split 模式按进程汇总。
- `Queue峰值(启动至今)` 是进程启动以来的 Rust 队列 max_depth；当前队列深度另保存在 raw JSON，Backpressure/Inner超载/Inner超时为正式采样窗口内的累计事件。
- `Mailbox低分配观测` 来自每个 Scene 的 Prometheus 序列汇总；单向消息排队应尽量接近零，Mailbox 峰值必须结合 stalled、P99 和业务语义判断。
- Load CPU/RSS/GC 只代表压测客户端，独立压测机模式用于排除它与服务端争抢资源。
- MapHost 发布 latest 移动状态；BroadcastHub 通过通用 `S2G_ClientBroadcast` 按 UnitId 聚合下行。
