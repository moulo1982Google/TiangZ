# 地图进图阶段A/B报告

- 时间：2026-07-31T09:52:08.044Z
- 顺序：Attach Only -> 新玩家快照 -> 老玩家Enter -> 完整语义
- 诊断模式只用于拆分成本；只有`full`具备可上线的完整进图语义。
- 四阶段语义断言：通过。禁用路径为0，启用路径在多人场景产生对应数据，且进图无失败。

## 客户端Setup

| 模式 | 玩家 | setup耗时 | setup/s | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| attach-only | 20 | 1.08s | 18.5 | 0.00ms | 0.00ms | 0.00ms | 0.00ms |
| new-observer-only | 20 | 1.11s | 18.0 | 0.00ms | 0.00ms | 0.00ms | 0.00ms |
| existing-observers-only | 20 | 1.03s | 19.5 | 0.00ms | 0.00ms | 0.00ms | 0.00ms |
| full | 20 | 1.03s | 19.5 | 0.00ms | 0.00ms | 0.00ms | 0.00ms |

## MapHost与Admission

| 模式 | max in-flight | Enter avg/max | 排队 avg/max | Attach avg/max | 可见变化 |
|---|---:|---:|---:|---:|---:|
| attach-only | 4 | 188.05/283.00ms | 160.00/243.00ms | 0.100/1.000ms | 190 |
| new-observer-only | 4 | 185.50/283.00ms | 148.80/219.00ms | 0.000/0.000ms | 190 |
| existing-observers-only | 4 | 192.60/261.00ms | 162.05/243.00ms | 0.050/1.000ms | 190 |
| full | 4 | 186.40/263.00ms | 155.20/243.00ms | 0.050/1.000ms | 190 |

## 初始状态与下行

| 模式 | Snapshot calls/items(avg) | Snapshot avg/max | Enter items | recipients | deliveries | Map写入 | Gate逻辑下行 |
|---|---:|---:|---:|---:|---:|---:|---:|
| attach-only | 0/0(0.0) | 0.000/0.000ms | 0 | 0 | 0 | 2.01KB | 7.09KB |
| new-observer-only | 20/225(11.3) | 0.150/1.000ms | 0 | 0 | 0 | 19.44KB | 7.61KB |
| existing-observers-only | 0/0(0.0) | 0.000/0.000ms | 19 | 190 | 190 | 2.03KB | 22.22KB |
| full | 20/226(11.3) | 0.050/1.000ms | 19 | 190 | 190 | 19.28KB | 22.16KB |

## 判断方法

- `new-observer-only - attach-only`主要反映给新玩家构造并返回全量视图的成本。
- `existing-observers-only - attach-only`主要反映给已有玩家发布新Subject的成本。
- `full`是最终权威结果；异步批处理和共享编码使它不一定等于前三项简单相加。
