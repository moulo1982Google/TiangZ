# 生命周期与持久化

## 规则卡

| 规则ID | 推荐 |
|---|---|
| `lifecycle.owner-cascade` | 所有者销毁时自动销毁子Entity、组件、Timer和Native handle |
| `lifecycle.active-instance` | 只为当前存在且有行为的实例创建ChildEntity |
| `persistence.record` | 数据库记录与运行时Entity、协议Snapshot使用不同类型 |
| `persistence.stable-id` | 持久化稳定业务ID和时间戳，不保存InstanceId或TimerId |

QuestComponent初始可以没有Quest。接受任务时创建活动Quest；完成时结算、记录Quest配置ID并RemoveChild。已完成集合是Set、位图或持久化索引，不为历史任务保留空Entity。

Buff持久化保存配置ID、来源、层数、开始/结束时间等业务数据。重新加载后重建Timer；TimerId只在本次进程生命周期有效。
