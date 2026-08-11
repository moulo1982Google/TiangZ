# 掉落、任务物品与尸体拾取

这份设计定义Starter的最小掉落语义。它解决的是“任务物品什么时候可以被某个玩家拿走”，不是最终的拍卖行、随机词条或共享战利品系统。

## 世界观

```text
MonsterUnit死亡
  -> MonsterComponent创建Map内LootContainer
  -> 尸体继续留在AOI
  -> 玩家提交C2M_LootMonster
  -> MonsterComponent按玩家Quest状态筛选掉落行
  -> Inventory/Quest生成纯数据计划
  -> PlayerPersistence提交DBProxy事务
  -> 确认后提交Entity并向该玩家推送结果
```

掉落属于尸体和地图，不属于玩家，也不是`MonsterUnit`上的可传送子Entity。尸体复活或销毁时，容器一起清理。玩家不能因为看到尸体快照就本地增加Item或Quest进度。

## 配置

`MonsterConfig.drop_table_id`指向一组`DropTableConfig`行：

| 字段 | 作用 |
| --- | --- |
| `drop_table_id` | 掉落组ID |
| `item_config_id` | 静态道具配置ID |
| `min_count/max_count` | 掉落数量范围 |
| `chance_permille` | 千分比掉落概率 |
| `quest_objective_id` | `0`为普通掉落，非零为任务资格掉落 |

生成阶段验证掉落组、道具、数量、概率和任务目标的引用关系。任务掉落必须引用`CollectItem`目标，并且目标的`target_config_id`必须等于掉落行的`item_config_id`。

## 任务资格

任务掉落不使用全局“尸体已被拾取”标记，而是按账号判断：

1. 玩家必须已经接取引用该掉落行的任务。
2. 任务必须处于`InProgress`，并且目标还存在剩余数量。
3. 一次拾取的数量截断为该目标的剩余数量。
4. 达到要求数量后，再拾取同一尸体不会生成更多道具，任务掉落行仍留在尸体上。
5. 没接任务的玩家看不到可领取的任务行，但不能因此消耗其他玩家的资格。

这就是“接了任务后才能掉任务物品”的最小实现：掉落行在尸体生成时固定，但是否对当前玩家产生掉落在拾取时决定。这样一个玩家先杀怪、另一个玩家随后接任务，也不会因为尸体生成时机导致任务无法完成。

普通掉落在Starter中是全局一次性领取；任务掉落按账号领取。将来若做队伍共享，应新增明确的`LootAudience`/队伍归属规则，不要把任务掉落偷偷改成全局一次。

## 持久化与幂等

`C2M_LootMonster`只包含`monster_id`和调用方为本次逻辑操作生成的`operation_id`。服务端先同步预留掉落行，避免同一个账号或多个账号的并发请求重复消费普通行；随后规划Inventory和Quest快照。DBProxy确认前，不修改Item Entity、Quest ChildEntity或任务索引。

提交成功后：

- 静态掉落才创建永久ItemId并写入Inventory；
- 任务进度应用到QuestComponent；
- 通过`M2C_LootMonster`只给拾取者返回道具和任务快照；
- 相同`operation_id`再次请求返回第一次回执，不重复发放。

事务失败且没有持久回执时释放预留；如果数据库已经提交但响应丢失，则按原`operation_id`读取回执，不能重新计算第二份掉落。客户端的尸体按钮只展示意图，距离、任务资格、剩余数量和数据库结果都以服务端为准。

## 静态掉落与动态ItemInstance

1101“任务怪物徽记”是静态配置道具，所以当前尸体容器只保存`item_config_id + count`，永久ItemId在拾取事务确认后生成。带随机词条、耐久、绑定来源或其他动态状态的道具不能套用这个快捷路径；它们需要保存完整`ItemInstance`或等价的实例数据，拾取只负责转移/确认实例，而不是到拾取时凭空重建。

## 业务调用

Handler保持扁平，只转交给玩家和地图掉落模块：

```ts
@unitRpcHandler(PlayerUnit, MapProtocol.LootMonster)
export class C2M_LootMonsterHandler {
  handle(unit: PlayerUnit, request: C2M_LootMonster) {
    return unit.LootMonster(request.monsterId, request.operationId);
  }
}
```

业务模块不要：

- 在客户端根据击杀表现直接加任务进度；
- 在Handler中查询Quest或扣Inventory；
- 把`ItemId`作为掉落配置ID；
- 用“尸体从AOI消失”表示玩家已经拾取；
- 因为某个玩家没有任务而删除全局任务掉落。
