# 状态同步

## 三个问题

1. 新观察者是否需要完整当前状态？需要则提供Snapshot。
2. 连续变化只保留最终值是否正确？正确则使用Latest/Delta。
3. 每次发生都是不可丢事实？是则使用Event。

## 规则卡

| 规则ID | 推荐 |
|---|---|
| `sync.snapshot` | 登录、重连、进入AOI时发送当前完整状态 |
| `sync.latest` | 位置、方向、HP最终值等可覆盖状态在帧尾合并 |
| `sync.event` | 使用道具、技能命中、Buff增删、任务完成等不可覆盖事实立即排队 |
| `sync.none` | 纯服务端过程不产生网络同步 |

Buff Tick属于`sync.none`：它只执行Action。Action修改Numeric时走Numeric Latest；造成移动时走Move；Buff创建和删除分别是Add/Remove Event。

Quest进度默认向本人发送Event或当前值通知；共享任务只向Party受众发送摘要。不因为Quest存在ChildEntity就自动进入AOI同步。
