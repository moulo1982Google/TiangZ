# TiangZ 长稳测试报告

- 时间：2026-07-25T00:32:01.464Z
- 正式测试：36000s；预热：60s；轮数：1
- 服务端：127.0.0.1；独立部署：否
- 压测机：13th Gen Intel(R) Core(TM) i7-13700F / 24 逻辑核 / 65292.4MB

## 1 轮中位数

| 部署 | 负载 | 玩家 | move/s | push/s | 确认数 | 延迟样本 | p50 ms | p95 ms | p99 ms | stalled | Server CPU% | Server RSS | Server GC ms | Load CPU ms | Load RSS |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| split | steady-5hz | 200 | 1000 | 4000 | 35999836 | 204400 | 33.9 | 61.79 | 70.04 | 0 | 178.3 | 392.7MB | 10260.95 | 5058453 | 210.8MB |

## 服务端内存趋势

| 进程 | 样本 | RSS 起点 | RSS 终点 | RSS 首尾折算/小时 | RSS 后1/4斜率/小时 | V8 Heap 起点 | V8 Heap 终点 | Heap 首尾折算/小时 | Heap 后1/4斜率/小时 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| log | 7188 | 31.1MB | 32.8MB | +0.2MB/h | +0.1MB/h | 3.2MB | 3.5MB | +0.0MB/h | +0.0MB/h |
| mgr | 7188 | 33.3MB | 34.6MB | +0.2MB/h | +0.1MB/h | 2.7MB | 2.8MB | +0.0MB/h | -0.0MB/h |
| login1 | 7188 | 33.4MB | 34.6MB | +0.1MB/h | +0.1MB/h | 3.6MB | 3.5MB | -0.0MB/h | -0.0MB/h |
| login2 | 7188 | 30.8MB | 31.6MB | +0.1MB/h | +0.1MB/h | 3.6MB | 3.1MB | -0.1MB/h | -0.0MB/h |
| gate1 | 7203 | 110.4MB | 114.0MB | +0.4MB/h | +0.3MB/h | 18.0MB | 29.5MB | +1.3MB/h | -0.2MB/h |
| map1 | 7202 | 99.8MB | 102.2MB | +0.3MB/h | +0.2MB/h | 6.2MB | 15.0MB | +1.0MB/h | +0.0MB/h |

## 压测端内存趋势

| 部署 | 玩家 | 负载 | 样本 | RSS 起点 | RSS 终点 | RSS 首尾折算/小时 | RSS 后1/4斜率/小时 | Heap 起点 | Heap 终点 | Heap 首尾折算/小时 | Heap 后1/4斜率/小时 |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| split | 200 | steady-5hz | 7205 | 185.6MB | 194.1MB | +0.9MB/h | -0.0MB/h | 53.3MB | 16.3MB | -4.1MB/h | -1.9MB/h |

## 指标口径

- `move/s` 是客户端发送移动到收到自身权威位置 Push 的闭环吞吐。
- `确认数` 统计所有匹配 `acknowledgedSequence` 的权威 Push；延迟分位数使用每玩家最多约 1024 个均匀样本，避免长稳工具自身内存线性增长。
- `push/s` 是所有客户端实际收到的 EntityMove 数；当前仍为同地图全量可见，尚未启用 AOI。
- Server CPU/RSS/GC 来自各 Runtime 的 `[process-metrics]`；split 模式按进程汇总。
- Load CPU/RSS/GC 只代表压测客户端，独立压测机模式用于排除它与服务端争抢资源。
- MapHost 发布 latest 移动状态；BroadcastHub 通过通用 `S2G_ClientBroadcast` 按 UnitId 聚合下行。
