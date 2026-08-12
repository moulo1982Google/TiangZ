# 全链路性能测试报告

- 时间：2026-08-12T02:13:48.740Z
- 正式测试：60s；预热：10s；轮数：1
- 服务端：127.0.0.1；独立部署：否
- 压测机：13th Gen Intel(R) Core(TM) i7-13700F / 24 逻辑核 / 65292.4MB

## 1 轮中位数

| 部署 | 负载 | 玩家 | move/s | push/s | 确认数 | move p95 | business/s | business成功 | business拒绝 | business传输错 | business p95 | stalled | Server CPU% | Server RSS | Queue峰值(启动至今) | Backpressure | Inner超载 | Inner超时 | Load CPU ms | Load RSS |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| all | steady-2hz+business-0.1hz | 100 | 200 | 2000 | 12001 | 59.07 | 10 | 300 | 300 | 0 | 57.48 | 0 | 20.5 | 154.0MB | 104 | 0 | 0 | 0 | 4359 | 87.4MB |
| all | steady-2hz+business-0.1hz | 300 | 600 | 6004 | 36000 | 66.7 | 30 | 697 | 1103 | 0 | 168.18 | 0 | 51.9 | 305.5MB | 232 | 0 | 0 | 0 | 16656 | 241.8MB |
| all | steady-2hz+business-0.1hz | 600 | 991 | 10932 | 59448 | 495.01 | 60 | 879 | 2721 | 0 | 7345.73 | 0 | 75.7 | 858.0MB | 929 | 0 | 0 | 0 | 47938 | 292.7MB |

## 指标口径

- `move/s` 是客户端发送移动到收到自身权威位置 Push 的闭环吞吐。
- `business/s` 是真实 UseItem 与 CastSkill 请求的响应吞吐；`business成功/拒绝`按服务端业务响应分类，`business传输错`才表示连接、超时或协议层异常。
- 业务负载默认交替使用1001道具和3005友方技能；压测客户端从EnterMap快照读取1001的ItemId，服务端仍是唯一权威。
- `确认数` 统计所有匹配 `acknowledgedSequence` 的权威 Push；延迟分位数使用每玩家最多约 1024 个均匀样本，避免长稳工具自身内存线性增长。
- `push/s` 是所有客户端实际收到的 EntityMove 数；当前仍为同地图全量可见，尚未启用 AOI。
- Server CPU/RSS/GC/队列来自各 Runtime 的 `/metrics` 采样；若旧 Runtime 没有健康端点才回退到 `[process-metrics]` 日志，split 模式按进程汇总。
- `Queue峰值(启动至今)` 是进程启动以来的 Rust 队列 max_depth；当前队列深度另保存在 raw JSON，Backpressure/Inner超载/Inner超时为正式采样窗口内的累计事件。
- Load CPU/RSS/GC 只代表压测客户端，独立压测机模式用于排除它与服务端争抢资源。
- MapHost 发布 latest 移动状态；BroadcastHub 通过通用 `S2G_ClientBroadcast` 按 UnitId 聚合下行。
