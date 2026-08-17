# 任务系统设计

## 目标

任务系统用于把已经发生的业务事实投影为玩家自己的任务进度。它不接管怪物、道具、地图或奖励模块，也不要求这些模块反向引用`QuestComponent`。

```text
击杀怪物 / 使用道具 / 进入地图
  -> MapScene同步发布QuestEvents.Progress
  -> QuestProgressEventHandler
  -> PlayerUnit.GetComponent(QuestComponent).ApplyProgress()
  -> G2C_QuestProgress（仅发给任务拥有者，latest合并）

C2M_CompleteQuest
  -> PlayerUnit有序mailbox
  -> QuestComponent.CompleteQuest()
      -> Inventory规划奖励后的纯快照，不修改Entity
      -> DBProxy提交inventory+quest记录与原始业务结果
      -> 确认后提交Item计划
      -> 记录completedQuestConfigIds并RemoveChild(Quest)
  -> RPC响应与奖励道具推送
```

核心原则：业务模块只发布“发生了什么”，任务模块决定“哪些目标因此前进”。击杀代码不能遍历任务，道具代码不能写任务进度，任务代码也不能复制背包或怪物逻辑。

## 数据模型

```text
PlayerUnit
  -> QuestComponent
      -> Quest ChildEntity（每个活动任务一个）
          -> questConfigId
          -> objectives[]
          -> status: InProgress | ReadyToTurnIn
          -> revision
      -> objectiveIndex: (ObjectiveType, TargetConfigId) -> Quest/Objective ID
      -> completedQuestConfigIds: Set<number>
```

- `QuestComponent`是玩家任务集合和唯一写入口。
- `Quest`是活动任务子实体，使用`questConfigId`作为其稳定Child ID；它没有mailbox，也不能被跨Process直接寻址。
- 已完成任务只记录配置ID，不保留空壳Quest Entity。
- `ReadyToTurnIn`表示目标已经达成但奖励尚未领取；领奖成功后Quest才从活动集合移入完成集合。客户端不能用进度自行删除任务。
- 接取任务时会把目标ID和要求数量冻结到Quest实例。热更配置只影响之后新接取的任务，不会让进行中的任务突然改变要求。
- `objectiveIndex`只保存稳定ID，是由活动Quest重建的运行时缓存，不进入协议、传送或未来持久化快照。接取、领奖、反序列化和跨地图恢复必须同步维护或重建索引。
- 当前Demo会把活动任务与已完成ID保存进玩家快照；任务GrantItem奖励使用DBProxy单记录关键事务。跨地图继续传输相同纯值并重建运行时索引。

## 配置表

### QuestConfig

一行描述一个任务：名称、说明、目标ID列表、奖励Action、是否由Demo自动接取、前置任务列表和最低等级。

- `required_quest_ids`要求对应任务已经领取奖励并进入完成集合，不接受“目标已达成但未领奖”。
- `minimum_level`读取玩家`NumericType.Level`。
- 配置生成会拒绝不存在、重复、自引用和循环的前置任务；当前“首次创建自动接取”任务不能配置前置任务。
- 5004“进阶试炼”不自动接取，用于演示完成5001且等级达到2后才能接取。

### QuestObjectiveConfig

一行描述一个目标：所属任务、目标类型、目标配置ID和要求数量。当前支持：

| 类型 | `target_config_id`含义 | Demo事实来源 |
|---|---|---|
| `KillMonster` | `MonsterConfig.id` | 怪物首次死亡提交后 |
| `UseItem` | `ItemConfig.id` | 道具成功消费并执行效果后 |
| `EnterMap` | `MapConfig.id` | 玩家成功完成AOI Attach后 |

奖励通过统一Action执行。当前演示使用`GrantItem(ItemConfigId, Count)`，不会在任务Handler里直接操作背包。

## 业务调用示例

### 发布进度事实

```ts
scene.Events.PublishSync(QuestEvents.Progress, {
  player,
  objectiveType: QuestObjectiveType.KillMonster,
  targetConfigId: monster.MonsterConfigId,
  count: 1,
});
```

发布点必须在业务事实成功提交之后。例如击杀事件只能在怪物从存活变为死亡的那一次发布；失败攻击、重复死亡处理和未消费的道具不能推进任务。

### 手工接取

```ts
const quest = player.GetComponent(QuestComponent).AcceptQuest(5001);
```

当前Demo使用`auto_accept`展示完整链路。正式业务通常由NPC对话、剧情或GM调用同一个入口。

接取顺序固定为：

```text
重复/已完成检查
  -> QuestEvents.BeforeAccept同步Veto
  -> 配置前置任务与最低等级最终校验
  -> 创建Quest ChildEntity
  -> 建立目标索引
```

阵营、职业、NPC关系或活动开关等模块使用稳定ID注册`QuestEvents.BeforeAccept`监听器。监听器只能同步读取内存并返回错误码，禁止创建Quest、修改Numeric、RPC、数据库、Promise或`Tasks.Spawn`。`QuestComponent`仍保留配置条件的最终校验，不能只依赖可热更监听器维持不变量。

### 目标索引

`ApplyProgress`使用`objectiveType:targetConfigId`直接取得相关Quest/Objective ID，不再遍历玩家全部活动任务。多个目标命中同一Quest时先完成全部推进，再为该Quest生成一份最终快照；已经进入`ReadyToTurnIn`的任务不会继续增加revision。

### 领取奖励

```ts
const reward = await player.GetComponent(QuestComponent).CompleteQuest(5001);
```

该调用必须位于PlayerUnit的有序mailbox内。`PlanTransactionalReward`和`PlanGrantItems`先计算奖励后的纯数据；`PlayerPersistenceComponent.ApplyTransaction`等待DBProxy把完整操作后记录和Protobuf结果一起提交，随后才修改Item/Quest Entity。客户端广播在提交后执行，不能参与事务。连接结果不确定时，同一Actor会先查询operationId回执；DBProxy返回首次结果，Inventory只补做一次精确version转换。

## 同步与传送

- 登录、重连和进图：`G2C_EnterMap`携带活动Quest全量快照与已完成ID。
- 进度变化：`G2C_QuestProgress`使用`questConfigId`作为latest key，同一帧只保留最终revision。
- 接取和领取：使用类型化RPC返回确定结果；奖励道具继续使用背包自己的同步消息。
- 跨地图：`PlayerTransferSnapshot`携带Quest纯值状态；目标Map重建ChildEntity，不重新执行接取逻辑。
- Quest默认只对拥有者可见，不进入AOI。组队共享任务以后应增加显式Party Audience投影，而不是把私有Quest塞入Unit公开快照。

## 当前限制与框架改进

1. **配置Facade仍需手工登记。** Luban能发现新表，但`tools/codegen_game_config.mjs`仍手工列出生成到服务端和客户端的表。新增Quest表因此修改了生成器。后续应从Luban表元数据生成Facade，开发者只维护Excel与分组。
2. **事务奖励当前只支持GrantItem。** 普通Action批次仍由`ExecuteActionBatch`同步执行；任务关键事务只接受能生成纯数据计划的`GrantItem`。Heal、Buff或跨玩家奖励不能塞进当前事务假装原子，必须先增加领域Planner，跨记录操作则需要新的DBProxy协议。
3. **奖励道具由Inventory统一规划和提交。** `PlanGrantItems`只在快照上填充已有堆叠、拆分新Item并分配稳定ID，不修改Entity；DBProxy确认后`CommitGrantPlan`校验完整base快照并无await提交。任务系统不能自行遍历或拼接背包。
4. **任务定义热更采用实例冻结。** 这是刻意的语义：活动任务不会随配置变更。若运营需要迁移进行中任务，必须提供显式版本和迁移工具，不能在读取时偷偷套用新配置。
5. **完成记录当前为Set。** 少量Demo足够；大规模任务可在持久化层使用分段位图或索引，但不能改变业务API。

## 验证

```powershell
npm run build:game-config:startup
npm run test:quest
npm run test:runtime
npm run verify:codegen
```

`test:quest`覆盖自动接取、无关目标不命中、状态切换、前置任务拒绝、等级拒绝、条件满足后接取、事务前失败不改内存、提交后ACK丢失回执恢复、重复领取返回首次结果、ChildEntity移除和跨地图索引恢复；真实Runtime冒烟覆盖击杀、用道具、进图三个事实来源以及动态MapHost传送。
