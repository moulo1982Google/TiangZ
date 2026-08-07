# 所有权与对象形态

## 规则卡

| 规则ID | 推荐 |
|---|---|
| `ownership.single-owner` | 每个运行时对象只有一个直接所有者，集合增删经过所有者Component |
| `entity.actor-target` | 只有需要mailbox和网络寻址的Scene、Session、ActorUnit成为Actor目标 |
| `entity.local-child` | 有稳定身份和独立生命周期、但不接收网络消息的对象使用ChildEntity |
| `entity.value-state` | 没有独立身份的数据使用字段、Map、数组、Set或Numeric |

## 典型结构

```text
MapScene
└── UnitComponent
    ├── PlayerUnit（ActorUnit，拥有mailbox）
    └── MonsterUnit（普通Unit，无mailbox）
        ├── ItemComponent
        │   └── Item（ChildEntity）
        ├── BuffComponent
        │   └── Buff（ChildEntity）
        └── QuestComponent
            └── Active Quest（ChildEntity）
```

只有需要被Gate或其他Scene按InstanceId发送消息的Unit才继承ActorUnit。普通怪物由MonsterComponent批量更新，没有mailbox。Item、Buff和Quest只在所属Unit内部运行，由Component管理，同样不创建mailbox。

ChildEntity通过`AddChild/GetChild/TryGetChild/GetChildren/RemoveChild`管理。集合操作由Component协调；单个对象的局部规则写在对应Hotfix System。
