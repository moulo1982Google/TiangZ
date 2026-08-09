# 教程：用道具驱动Action与Buff

本教程只做两个道具：

- 小型生命药水：立即恢复150点HP。
- 大型生命药水：添加一个持续30秒、每3秒恢复50点HP的Buff。

本教程聚焦效果层；技能如何复用Action见[新增一个配置化技能](18-configured-skill.md)。

## 1. 配置表

在`game_config/Datas/ItemConfig.xlsx`中：

```text
1001  小型生命药水  use_effect=2  use_params=6,150  cooldown_ms=30000  global_cooldown_ms=1000
1002  大型生命药水  use_effect=1  use_params=2001   cooldown_ms=30000  global_cooldown_ms=1000
```

`use_effect=2`时，`use_params`的第一个值是ActionType，所以`6,150`表示`Heal(150)`；`2001`是Buff配置ID。

`cooldown_ms`是同配置药品的自身CD，`global_cooldown_ms`进入玩家与技能共享的GCD。服务端在扣除道具前原子提交两条deadline，并通过`M2C_UseItem`返回给客户端绘制；客户端按钮变灰不能代替服务端校验。

在`game_config/Datas/BuffConfig.xlsx`中：

```text
2001  持续恢复  duration_seconds=30  tick_interval_ms=3000
      tick_action_type=6  tick_action_params=50
```

`ActionType.Heal`为`6`。添加和移除阶段在这个示例中为空。

修改表后执行：

```powershell
npm run build:game-config:startup
npm run test:game-config
```

只改数据可以走Hot配置候选；第一次接入新列、改类型或改引用关系必须完整生成并重启Process。

## 2. 运行时调用链

```text
C2M_UseItem
 -> C2M_UseItemHandler
 -> ItemComponent.UseItemTransactional
 -> Inventory/CD/Effect纯数据Planner
 -> DBProxy ApplyTransaction
 -> 确认后无await提交
    -> Heal: Combat.CommitHealingPlan
    -> AddBuff: BuffComponent.ApplyCommittedBuff
       -> Buff.Awake（restoring模式，不重复AddAction）
       -> Tick Timer
       -> RemoveAction
```

Handler只转发`itemId + operationId`。它不关心“红药应该怎样回血”，不编排DBProxy，也不创建一个临时Actor。客户端每次新使用生成新的`CreateOperationId("item")`，只有同一次网络重试才复用。

## 3. 写一个新Buff

如果效果只是在固定时间点改变HP，优先新增一行Buff配置：

```ts
player.GetComponent(BuffComponent).AddBuff(2001);
```

如果少数业务需要临时覆盖时长或Tick，可以传纯数据：

```ts
player.GetComponent(BuffComponent).AddBuff(2001, {
  durationMs: 10_000,
  tickIntervalMs: 500,
  tickAction: { type: ActionType.Heal, parameters: [5n] },
});
```

不要把闭包作为Action参数。热更、传送和销毁都需要能追踪这条生命周期。

## 4. 护盾类Buff怎么接

护盾不是让Combat去查Buff，而是Buff的AddAction注册Combat修改器。当前`BuffConfig 4003`已经配置：

```text
add_action_type=5
add_action_params=200
```

`ActionType.RegisterDamageAbsorber`为`5`。Buff保存注册结果，Combat保存并消费唯一剩余量；Buff到期或被替换时注销修改器，受伤入口始终不反向查询Buff。

## 5. 验收

```powershell
npm run codegen:game-config
npm run codegen:scenes
npm run typecheck
npm run test:game-config
npm run test:combat
npm run test:buff-action
```

自测至少确认：小红立即治疗、大红添加Buff、Tick按服务器时间执行、重复Remove幂等、Buff传送不重复AddAction、Unit销毁只执行一次RemoveAction。
