# NativeData TypeScript/Rust direct A/B 报告

- 时间：2026-07-22T11:58:16.929Z
- 状态：完整
- 拓扑：1 MapHost / 16 Gate / 1 Login / 1 LoginMgr
- 负载：每玩家 5Hz Move + 1Hz MapProbe
- 移动输入：每 5 次上报保持同一方向
- A/B 模式：每个 20Hz tick 输出全部 Unit 的 Movement snapshot
- Rust 路径：直接生成最终 G2C protobuf frame，TS 不重建 Unit 对象
- 客户端：Rust Tokio；服务端：Windows IOCP（Tokio/Mio）
- 预热/正式窗口：10s / 30s
- 每个后端轮数：3，执行顺序按轮次交替
- 机器：13th Gen Intel(R) Core(TM) i7-13700F / 24 逻辑核 / 63.76GB

## 中位数对照

负数差值表示 Rust 低于 TypeScript；对于 CPU、延迟和内存通常是改善。

| 玩家 | 后端 | Map CPU avg/p90 | Gate max avg | Move 达标率 | push/s | Probe p95/p99 | RSS | Map V8 Heap |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 3500 | TypeScript | 55.1/61.3% | 67.2% | 99.9% | 69879 | 173.29/225.42ms | 2.71GB | 42.3MB |
| 3500 | Rust direct | 48.1/59% | 67.1% | 99.9% | 69917 | 142.67/211.25ms | 2.72GB | 40.5MB |
| 3500 | Rust 差值 | -12.8% / - | -0.2% | - | - | -17.7% / -6.3% | +0.5% | -4.2% |

## 工作量一致性

| 玩家 | 后端 | Push/s | Movement items/s | logical outbound |
|---:|---:|---:|---:|---:|
| 3500 | TypeScript | 69879 | 70046 | 5.24GB/s |
| 3500 | Rust direct | 69917 | 70017 | 5.21GB/s |

## Rust 边界调用

| 玩家 | scalar gets/s | scalar sets/s | batch calls/s | encoded frames/items | encoded bytes/s | live Units |
|---:|---:|---:|---:|---:|---:|---:|
| 3500 | 0 | 17496.8 | 20 | 20/70140 | 1.5MB/s | 3500 |

## 正确性门槛

- 两种后端都必须达到至少 95% 的 Move 目标频率。
- 两种后端的正式窗口 EntityMove Push 吞吐差异不得超过 10%。
- 两种后端的 Movement item 吞吐差异不得超过 5%。
- Movement item 吞吐必须达到 `players × 20Hz` 的 95%。
- Move/Probe 错误、内部 overload/timeout 和慢连接断开必须为 0。
- TypeScript 后端的 Rust Arena 存活 Unit 必须为 0。
- Rust 后端正式窗口的存活 Unit 必须等于在线玩家数。
- `backpressure` 是入口等待重试信号，单独记录但不等同于丢包。

## 单轮报告

- 顺序 1：第 1 轮，3500 玩家，typescript，`map_capacity_20260722_114643.md`
- 顺序 2：第 1 轮，3500 玩家，rust，`map_capacity_20260722_114940.md`
- 顺序 3：第 2 轮，3500 玩家，rust，`map_capacity_20260722_115208.md`
- 顺序 4：第 2 轮，3500 玩家，typescript，`map_capacity_20260722_115340.md`
- 顺序 5：第 3 轮，3500 玩家，typescript，`map_capacity_20260722_115512.md`
- 顺序 6：第 3 轮，3500 玩家，rust，`map_capacity_20260722_115644.md`
