# TiangZ 性能基线与容量报告

本文记录 TiangZ 当前可重复的单 MapHost 完整业务容量基线。最新正式结果是在一台 Windows 开发机上，以 `1 MapHost / 10 Gate` 承载 3500 名玩家：每名玩家持续发送 `2Hz` 移动、`0.2Hz` MapProbe 和 `0.1Hz` 真实道具/技能请求时，Map 保持 `20Hz` 且正式窗口零跳帧，Probe P95/P99 为 `183.33/220.21ms`，窗口内无传输错误、过载、超时或背压。

这是一条用于持续回归和容量规划的工程基线，不是生产环境容量承诺。

## 最新结果

| 玩家 | Gate | Map CPU avg/p90 | 最忙 Gate CPU avg/peak | Move/s | Probe P95/P99 | 业务 P95/P99 | Map Tick | 传输异常 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 500 | 10 | 12.8/13.1% | 9.9/13.1% | 1000 | 3.23/6.22ms | 7.64/14.06ms | 20Hz，零跳帧 | 0 |
| 3500 | 10 | 69.7/80.6% | 91.3/115.3% | 6998 | 183.33/220.21ms | 228.29/270.40ms | 20Hz，零跳帧 | 0 |

3500 人正式窗口的其他关键指标：

- 移动目标达成率 `100%`，Movement Push `2,903,454/s`；
- 真实道具/技能请求约 `350/s`，目标达成率 `99.9%`，传输错误为 `0`；
- 下行 recipients `3,271,501/s`，Gate write frames/op 为 `38.52`；
- AOI 跨 Grid `342.3/s`，达到预期负载的 `97.8%`；
- 总 RSS `2197.3MB`，Map V8 Heap 峰值 `140.2MB`；
- overload、timeout、backpressure 和 slow connection 均为 `0`。

“业务拒绝”不计入传输异常。技能公共 CD、药品 CD、目标距离等业务规则会正常拒绝一部分请求，这表示业务闭环完成并返回了有效结果。

## 测试口径

- 平台：Windows、Tokio/Mio IOCP；测试机为 Intel Core i7-13700F、24 逻辑核、约 64GB 内存；
- 拓扑：`1 MapHost / 10 Gate / 1 Login / 1 LoginMgr / 1 Location`；
- 地图：`10x10` AOI Grid，3500 人时平均每 Grid 35 人；
- 移动：每玩家 `2Hz`，80% 玩家在 Grid 内闭环移动，20% 玩家周期性跨越相邻 Grid；
- 控制链路：每玩家 `0.2Hz MapProbe`，经过客户端、Gate、MapHost 和返回链路；
- 业务链路：每玩家 `0.1Hz`，交替执行真实道具使用和技能施放；
- 进图：连接/Login 与 Map Enter 分阶段执行，Map Enter 开环速率约 40 人/秒；
- 正式 3500 人窗口：预热 15 秒、排空 15 秒、测量 30 秒。

3500 人不是“同屏 3500 人”。玩家均匀分布在 100 个 AOI Grid 中；全量同屏属于另一种最坏边界测试，不能与本报告的容量数字互换。

## 优化效果

在相同的 3500 人、10 Gate 和完整业务负载口径下，Map 调度与 Gate 下行批处理优化前后的结果如下：

| 指标 | 优化前 | 当前 | 变化 |
|---|---:|---:|---:|
| 最忙 Gate CPU avg | 113.9% | 91.3% | -19.8% |
| Probe P95 | 325.24ms | 183.33ms | -43.6% |
| Probe P99 | 374.20ms | 220.21ms | -41.2% |
| Map Tick | 19.4Hz | 20Hz | 恢复目标帧率 |
| 固定帧跳过 | 13 | 0 | 消除 |
| Movement Push | 2,309,182/s | 2,903,454/s | +25.7% |
| 下行 recipients | 约 274 万/s | 327 万/s | +19.3% |
| Gate write frames/op | 24.30 | 38.52 | +58.5% |

该对比说明当前优化主要降低了 Gate 热点和排队延迟，同时提升了下行批量效率；它不意味着所有硬件或部署拓扑都会获得相同比例的收益。

## 复现

先完成项目依赖安装，然后在仓库根目录执行：

```powershell
npm run perf:map-capacity -- `
  --client rust `
  --players 3500 `
  --gates 10 `
  --spawn-layout grid-uniform `
  --world-grids 10 `
  --move-rate 2 `
  --probe-rate 0.2 `
  --business-rate 0.1 `
  --post-setup-settle 15 `
  --warmup 15 `
  --duration 30 `
  --rounds 1
```

单次结果会受到后台进程、CPU 调度、温度和构建状态影响。容量判断应使用相同机器、相同提交、相同参数进行多轮测试，并关注趋势而非孤立数字。完整参数和验收语义见[单 MapHost AOI 容量测试说明](perf/map_capacity/README.md)。

## 原始报告

- [当前 3500 人正式报告](perf/results/map_capacity_20260821_131109.md)
- [当前 500 人低负载报告](perf/results/map_capacity_20260821_130910.md)
- [3500 人优化前对照报告](perf/results/map_capacity_20260821_122259.md)
- [最新容量报告入口](perf/results/map_capacity_latest.md)

## 结果边界

本基线尚未覆盖以下生产变量：

- 任务掉落专项压力和 DBProxy 持久化压力；
- Redis/PostgreSQL 延迟、跨机网络和公网抖动；
- 多 MapHost 容量、节点故障切换和恢复期间的负载；
- 全量同屏、极端 AOI 聚集和不同业务请求组合；
- Linux epoll/io_uring 与生产硬件上的容量差异。

因此，这组数据适合回答“当前提交在固定开发机和固定负载下是否退化”，也可以作为部署规划的起点；正式上线前仍需在目标 Linux 拓扑、数据库和网络环境中重新验收。
