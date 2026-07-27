# 100 次 Hotfix generation 长稳报告

- 时间：2026-07-27T09:16:37.709Z
- 最终 generation：101
- 资源基线 generation：11（前 10 次用于预热）
- 增长门槛：V8 Heap < 4.00 MB，RSS < 16.00 MB
- 损坏候选：已拒绝，active generation 未变化

| Process | Timer | Native Entity | V8 Heap增长 MB | RSS增长 MB | pending/async |
|---|---:|---:|---:|---:|---:|
| mgr | 0 | 0 | 1.71 | 6.95 | 0/0 |
| login1 | 0 | 0 | 1.73 | 5.57 | 0/0 |
| login2 | 0 | 0 | 1.82 | 5.30 | 0/0 |
| gate1 | 1 | 0 | 1.83 | 5.59 | 0/0 |
| map1 | 0 | 0 | 1.72 | 5.59 | 0/0 |
