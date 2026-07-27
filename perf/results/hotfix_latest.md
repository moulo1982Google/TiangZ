# 3000 人在线 Hotfix A/B 性能报告

- 时间：2026-07-27T05:37:23.818Z
- 拓扑：1 MapHost / 16 Gate / 1 Login / 1 LoginMgr
- 负载：3000 玩家，Move 5Hz，Probe 1Hz
- 正式窗口：30s x 3 轮；Reload 周期 1000ms

| 指标 | 不 Reload | 每秒 Reload | 变化 |
|---|---:|---:|---:|
| Move/s | 14988.97 | 14991.67 | +0.02% |
| Probe p50 ms | 94.83 | 122.14 | +28.80% |
| Probe p95 ms | 180.51 | 238.11 | +31.91% |
| Probe p99 ms | 239.99 | 314.73 | +31.14% |
| Map CPU % | 52.76 | 49.86 | -5.50% |
| 最忙 Gate CPU % | 61.27 | 63.68 | +3.94% |
| 服务端 RSS MB | 3088.29 | 3252.77 | +5.33% |

## Reload 结果

- 正式窗口请求/完成/未在周期内完成：90/90/0
- Map preflight p50/p95：23.73/43.25 ms
- Map barrier p50/p95：4.93/55.00 ms
- Map eval p50/p95：1.12/3.13 ms
- Map commit p50/p95：0.13/0.43 ms
- Map total p50/p95：38.94/100.12 ms

## 硬性正确性

- 基线 Move/Probe 错误：0/0
- Reload Move/Probe 错误：0/0
- Reload 内部 overload/timeout/slow disconnect：0/0/0
