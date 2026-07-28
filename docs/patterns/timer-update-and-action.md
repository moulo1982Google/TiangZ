# Timer、Update与Action

## 规则卡

| 规则ID | 推荐 |
|---|---|
| `execution.update` | 每个固定逻辑帧必须执行的连续逻辑使用Update |
| `execution.timer` | 稀疏到期、周期触发使用Timer |
| `execution.coalesced-timer` | 同一所有者下大量定时对象使用最近到期Timer统一调度 |
| `execution.action-delegation` | Action修改哪个领域，就调用哪个领域能力并复用其同步机制 |

少量Buff可以各自持有Timer。数量较大时，BuffComponent保存`nextTickAt/expireAt`并通过最小堆维护一个最近到期Timer，减少常驻调度项。

Buff Tick不直接拼网络包：伤害Action修改Numeric，位移Action调用移动能力，添加Buff的Action调用目标BuffComponent。Action编排留在Hotfix，Timer、Entity和Component生命周期由Core保证。
