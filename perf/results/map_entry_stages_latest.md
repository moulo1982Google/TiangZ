# 地图进图阶段A/B报告

- 时间：2026-07-31T11:52:55.976Z
- 顺序：Attach Only -> 新玩家快照 -> 老玩家Enter -> 完整语义
- 诊断模式只用于拆分成本；只有`full`具备可上线的完整进图语义。
- 四阶段语义断言：通过。禁用路径为0，启用路径在多人场景产生对应数据，且进图无失败。

## 客户端Setup

| 模式 | 玩家 | setup耗时 | setup/s | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| attach-only | 3000 | 150.06s | 20.0 | 0.00ms | 0.00ms | 0.00ms | 0.00ms |
| new-observer-only | 3000 | 150.50s | 19.9 | 0.00ms | 0.00ms | 0.00ms | 0.00ms |
| existing-observers-only | 3000 | 150.17s | 20.0 | 0.00ms | 0.00ms | 0.00ms | 0.00ms |
| full | 3000 | 150.36s | 20.0 | 0.00ms | 0.00ms | 0.00ms | 0.00ms |

## MapHost与Admission

| 模式 | max in-flight | Enter avg/max | 排队 avg/max | Attach avg/max | 可见变化 |
|---|---:|---:|---:|---:|---:|
| attach-only | 16 | 773.96/990.00ms | 734.87/861.00ms | 0.590/17.000ms | 4498500 |
| new-observer-only | 16 | 710.02/1001.00ms | 617.77/853.00ms | 0.697/19.000ms | 4498500 |
| existing-observers-only | 16 | 747.71/933.00ms | 699.99/862.00ms | 0.600/18.000ms | 4498500 |
| full | 16 | 707.35/910.00ms | 604.11/840.00ms | 0.587/8.000ms | 4498500 |

## 初始状态与下行

| 模式 | Snapshot calls/items(avg) | Snapshot avg/max | Enter items | recipients | deliveries | Map写入 | Gate逻辑下行 |
|---|---:|---:|---:|---:|---:|---:|---:|
| attach-only | 0/0(0.0) | 0.000/0.000ms | 0 | 0 | 0 | 340.77KB | 116.09MB |
| new-observer-only | 3000/4504049(1501.3) | 6.478/40.000ms | 0 | 0 | 0 | 345.57MB | 163.43MB |
| existing-observers-only | 0/0(0.0) | 0.000/0.000ms | 2999 | 4498500 | 4498500 | 342.30KB | 499.41MB |
| full | 3000/4504377(1501.5) | 6.165/42.000ms | 2999 | 4498500 | 4498500 | 345.61MB | 534.38MB |

## 判断方法

- `new-observer-only - attach-only`主要反映给新玩家构造并返回全量视图的成本。
- `existing-observers-only - attach-only`主要反映给已有玩家发布新Subject的成本。
- `full`是最终权威结果；异步批处理和共享编码使它不一定等于前三项简单相加。
