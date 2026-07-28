# TypeScript与Rust数据位置

## 规则卡

| 规则ID | 推荐 |
|---|---|
| `data.ts-default` | 普通业务状态和行为默认留在Model/Hotfix TypeScript |
| `data.native-measure-first` | 只有高频跨帧权威数据或Rust批处理有指标收益时才使用`.native` |
| `data.coarse-op` | TS与Rust之间使用粗粒度批处理，避免Update中逐对象逐字段往返 |
| `data.generated-boundary` | Native Ref、Rust Pool和FastOp由codegen生成，业务不手写桥代码 |

对象是ChildEntity不代表数据必须下沉Rust。Item当前使用Native是框架验证样例；Quest、Achievement和多数Buff规则默认先写TypeScript。

出现以下证据后再考虑Native：每Tick连续扫描、需要Rust AOI直接读取、需要Rust批量编码、V8 Heap或跨边界调用已经成为实测瓶颈。改变数据位置属于Model/schema变更，需要重启Process并重新跑专项基准。
