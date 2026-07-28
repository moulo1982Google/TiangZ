# TiangZ 领域设计模式

本目录保存业务系统设计时可复用的决策规则。它回答“状态归谁、是否成为Entity、谁能看见、如何同步、何时销毁”，不替代具体业务需求。

推荐先按顺序回答：

1. [所有权与对象形态](ownership-and-entity.md)
2. [可见范围](audience.md)
3. [状态同步](state-replication.md)
4. [生命周期与持久化](lifecycle-and-persistence.md)
5. [Timer、Update与Action](timer-update-and-action.md)
6. [TypeScript与Rust数据位置](data-placement.md)

Developer Tools 的设计助手使用相同的稳定规则ID生成建议。文档是解释依据，`design-core`是确定性决策实现；两者发生冲突时必须在同一次改动中修正。

## 快速判断

```text
需要独立部署或跨进程寻址？ -> EntryScene
需要独立mailbox和消息串行？ -> Scene、Session或Unit
有稳定身份和独立生命周期，但不接收网络消息？ -> ChildEntity
只是宿主的一组状态或能力？ -> Component字段、Map、数组或Numeric
```

不要因为对象需要被AOI看到就把它变成Actor。AOI决定接收者，Actor决定消息寻址与串行边界，两者不是一回事。
