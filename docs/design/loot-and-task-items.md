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

## 尸体生命周期

尸体显示时间和怪物重生时间是两个时间轴：

- 有掉落的尸体最多保留5分钟；无掉落的尸体保留10秒。
- `MonsterConfig.respawn_seconds`从死亡时刻开始计时，只表示下一只怪物的最短重生时刻，不再直接决定尸体何时消失。
- 普通掉落全部领取后，尸体可以立即离开AOI；新怪物在尸体窗口结束且达到`respawn_seconds`最短时刻后生成。
- 任务掉落按账号判定资格，不能因为一个玩家领取完就删除尸体，否则其他后来接任务的玩家无法领取；这类尸体保留到5分钟窗口结束。
- 客户端收到尸体的AOI Leave后关闭掉落窗口，不能继续使用旧`UnitId`请求拾取。

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

同一掉落表中的普通行（`quest_objective_id=0`）逐行独立投掷，不要求概率总和为1000。Starter表1和表2的普通行都统一为：破旧布料1201为800/1000、小型生命药水1001为150/1000、大型生命药水1002为50/1000，即80%/15%/5%；因此一具尸体可能同时掉出三行，也可能没有普通掉落。任务掉落行不参与普通掉落判定，而是在玩家拾取时按任务资格独立判断。

## 任务资格

任务掉落不使用全局“尸体已被拾取”标记，而是按账号判断：

1. 玩家必须已经接取引用该掉落行的任务。
2. 任务必须处于`InProgress`，并且目标还存在剩余数量。
3. 一次拾取的数量截断为该目标的剩余数量。
4. 达到要求数量后，再拾取同一尸体不会生成更多道具，任务掉落行仍留在尸体上。
5. 没接任务的玩家看不到可领取的任务行，但不能因此消耗其他玩家的资格。

这就是“接了任务后才能掉任务物品”的最小实现：掉落行在尸体生成时固定，但是否对当前玩家产生掉落在拾取时决定。这样一个玩家先杀怪、另一个玩家随后接任务，也不会因为尸体生成时机导致任务无法完成。

普通掉落在Starter中归属于第一个造成有效伤害的账号，并且只能由该账号领取一次；任务掉落仍按账号领取。这样玩家自己打死的怪不会被路人先摸走普通掉落。将来若做队伍共享，应把`lootOwnerAccount`替换为明确的`LootAudience`/队伍归属规则，不要把任务掉落偷偷改成全局一次。

## 持久化与幂等

客户端先调用`C2M_InspectLootMonster`查看尸体，只返回当前账号有资格领取的`LootDropSnapshot`，不会预留、消耗掉落，也不会创建ItemId。真正领取时调用带`drop_id`、`loot_all`和`operation_id`的`C2M_LootMonster`。服务端先同步预留掉落行，避免同一个账号或多个账号的并发请求重复消费普通行；随后规划Inventory和Quest快照。DBProxy确认前，不修改Item Entity、Quest ChildEntity或任务索引。

提交成功后：

- 静态掉落才创建永久ItemId并写入Inventory；
- 任务进度应用到QuestComponent；
- 通过`M2C_LootMonster`只给拾取者返回本次受影响的堆叠和任务快照；客户端用这些增量更新本地投影，同时接收私有的`G2C_ItemChanged`事件；
- 相同`operation_id`再次请求返回第一次回执，不重复发放。
- 单项拾取只提交被点击的`drop_id`；全部拾取提交`loot_all=true`。回执中的`remaining_drops`是服务端确认后的最新列表，客户端必须用它刷新窗口，不能根据本地按钮推测剩余内容。`items`是本次变化的堆叠，和`G2C_ItemChanged`共同组成增量更新；完整背包只在`G2C_EnterMap.items`等明确的进图、重连快照中发送，不能把整包背包塞进每次拾取回包。

如果客户端带着过期的ItemId或数量请求使用、购买或出售道具，服务端返回业务错误时可以在同一个错误响应中附带`inventory_recovery`。它是一个可选的`InventorySnapshot`包装：字段不存在表示本次错误没有触发修复同步，字段存在但`items`为空则表示权威背包确实为空。客户端收到后先用该快照替换本地背包，再展示错误提示；不能把错误恢复快照当作成功扣除，也不能在正常成功路径上每次发送整包。

事务失败且没有持久回执时释放预留；如果数据库已经提交但响应丢失，即使尸体已经因普通掉落领取完成而离开地图，也必须按原`operation_id`读取回执，不能重新计算第二份掉落。普通掉落还必须先通过尸体归属账号校验；客户端的尸体按钮只展示意图，距离、归属、任务资格、剩余数量和数据库结果都以服务端为准。

## 静态掉落与动态ItemInstance

1101“任务怪物徽记”是静态配置道具，所以当前尸体容器只保存`item_config_id + count`，永久ItemId在拾取事务确认后生成。带随机词条、耐久、绑定来源或其他动态状态的道具不能套用这个快捷路径；它们需要保存完整`ItemInstance`或等价的实例数据，拾取只负责转移/确认实例，而不是到拾取时凭空重建。

## 业务调用

Handler保持扁平，只转交给玩家和地图掉落模块。查看与领取是两个明确动作：

```ts
@unitRpcHandler(PlayerUnit, MapProtocol.InspectLootMonster)
export class C2M_InspectLootMonsterHandler {
  handle(unit: PlayerUnit, request: C2M_InspectLootMonster) {
    return unit.InspectLootMonster(request.monsterId);
  }
}

@unitRpcHandler(PlayerUnit, MapProtocol.LootMonster)
export class C2M_LootMonsterHandler {
  handle(unit: PlayerUnit, request: C2M_LootMonster) {
    return unit.LootMonster(
      request.monsterId,
      request.operationId,
      request.dropId,
      request.lootAll,
    );
  }
}
```

Cocos3D的尸体窗口保持打开，普通点击一行只领取该行；Shift+点击、鼠标右键、F键或“全部拾取”按钮领取全部。领取结果和剩余行同时显示，窗口必须由玩家关闭，不能只用短暂状态提示代替。若全部普通掉落领取后服务端立即发送AOI Leave，客户端应关闭绑定旧`UnitId`的窗口；请求超时重试仍复用原`operationId`，由服务端回执恢复结果。

业务模块不要：

- 在客户端根据击杀表现直接加任务进度；
- 在Handler中查询Quest或扣Inventory；
- 把`ItemId`作为掉落配置ID；
- 用“尸体从AOI消失”表示玩家已经拾取；
- 因为某个玩家没有任务而删除全局任务掉落。
