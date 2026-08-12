# 怪物模块最小闭环

本教程给出一个完整但刻意保持简单的怪物模块：固定刷点、统一Unit、局部行为树、简单追击、玩家自动平A、两米内普通攻击、死亡状态和重生。它用于验证业务开发链路，不是完整商业战斗系统。

## 1. 配置放在哪里

怪物模板和刷点都是冷配置，表结构属于Model，修改字段后需要完整生成并重启Process。

```text
game_config/Datas/MonsterConfig.xlsx
game_config/Datas/MonsterAreaConfig.xlsx
```

`MonsterConfig`描述“是什么怪物”：

| 字段 | 作用 |
| --- | --- |
| `id` | 怪物模板ID |
| `name` | 显示名称 |
| `model_id` | 客户端表现资源标识 |
| `max_hp` | 初始最大生命值 |
| `attack_damage` | 普通攻击伤害 |
| `move_speed` | 移动速度，米/秒；创建时换算为Numeric.MoveSpeed的毫米/秒整数 |
| `attack_range` | 普通攻击距离，单位米；当前演示值为2.5，必须大于0且不超过4米 |
| `attack_interval_ms` | 普通攻击间隔，毫秒；创建/复活时写入Numeric.AttackSpeedAdd |
| `attack_mode` | `0`被动，`1`主动 |
| `skill_id` | 预留技能配置ID，当前演示只支持普通攻击 |
| `respawn_seconds` | 从死亡时刻计时的最短重生秒数；实际生成取尸体窗口结束与该时刻两者较晚值 |

`MonsterAreaConfig`描述“在哪里刷”：一行就是一个固定刷怪槽位，包含地图配置ID、模板ID、坐标和是否在地图创建时生成。复活时间属于怪物模板，不属于刷点，避免同一个怪物模板在不同地图拥有隐含的生命周期差异。当前版本没有随机刷怪池、多个候选点、掉落表和持久化。

3D演示地图`MapConfig.id = 100`已经配置两个刷怪槽：`10004`生成怪A（被动），`10005`生成怪B（主动）。两个位置避开中央障碍和动态门，Cocos 3D进入`Map 100`后即可观察两种颜色。

修改后执行：

```powershell
npm run build:game-config:startup
npm run test:game-config
```

不要手工编辑`game_config/generated`，也不要在业务代码里解析Excel或JSON。

## 2. 地图如何挂载

`MapHostComponent`创建MapScene时自动挂载：

```text
MapScene
  -> UnitComponent       所有玩家和怪物的统一Unit集合
  -> MapAoiComponent     Rust AOI关系
  -> MapComponent         地图、移动和帧尾广播
  -> MonsterComponent     刷怪、AI、战斗、死亡和重生
```

静态地图和动态副本共用这一套组件。MapHost启动或创建MapScene时，`MonsterComponentSystem.Awake`读取当前地图的`MonsterAreaConfig`，生成标记为`initial_spawn`的怪物。

## 3. Unit与生命周期

怪物是统一`UnitComponent`里的`MonsterUnit`，不是单独的一套地图对象：

```ts
const monster = map.GetComponent(MonsterComponent).Get(monsterId);
const numeric = monster?.GetComponent(NumericComponent);
```

`MonsterUnit`只保存稳定身份：地图、刷怪槽位和怪物模板ID。行为位于：

```text
app/model/demo/monster/MonsterUnit.ts
app/hotfix/demo/monster/MonsterUnitSystem.ts
app/model/demo/monster/MonsterComponent.ts
app/hotfix/demo/monster/MonsterComponentSystem.ts
app/hotfix/demo/monster/MonsterBehaviorTree.ts
app/model/demo/combat/CombatComponent.ts
app/hotfix/demo/combat/CombatComponentSystem.ts
```

地图固定桶统一驱动怪物和战斗，不为每个怪物或玩家创建长期Timer。当前使用怪物模块内部的轻量行为树，不是通用AI框架：

```text
出生
  -> 无目标：待机
  -> 主动怪找到范围内玩家：追击
  -> 距离不超过MonsterConfig.attack_range：停止移动并按Numeric.AttackSpeed普通攻击
  -> 玩家通过AttackMonster造成伤害
  -> CombatComponent结算伤害；HP为0，旧MonsterUnit以alive=false留在AOI
  -> 有掉落尸体最多保留5分钟，无掉落尸体保留10秒
  -> 普通掉落全部领取后也可提前触发尸体离开AOI
  -> 尸体离开AOI并销毁
  -> 等待尸体窗口结束且MonsterConfig.respawn_seconds最短时刻已满足
  -> 同一AreaId刷怪槽创建新的MonsterUnit，取得新的UnitId
```

被动怪没有仇恨时不会主动寻找玩家；玩家对怪物造成实际伤害后，`MonsterComponent.ApplyPlayerDamage`按“1点实际伤害=1点仇恨”调用`MonsterComponent.AddThreat`，5Hz桶选择本地图存活玩家中的最高仇恨目标，之后被动怪才会追击。主动怪没有仇恨时只在12米主动索敌范围内寻找最近玩家；一旦有仇恨，主动和被动怪都优先按仇恨选目标，不能再用12米主动索敌范围过滤已有仇恨，否则30米远程技能命中后怪物会错误待机。当前Demo尚未定义回出生点脱战距离；以后应作为独立冷配置加入，不能复用主动索敌距离。当前行为树只有待机、追击、攻击和攻击冷却停留四个动作；玩家技能与Buff已复用统一Combat入口，掉落和复杂战斗结算尚未加入。3D演示客户端会在HUD显示服务端推送的HP/MP、施法和Buff状态，不允许客户端自行计算扣血。

行为树的调用关系保持在业务模块内部：

```text
MonsterComponent.Update5Hz
  -> MonsterBehaviorTree.Evaluate
  -> MonsterComponentSystem执行Idle/Chase/Hold/Attack
  -> target.GetComponent(CombatComponent).ApplyDamage(...)
  -> 实际伤害调用MonsterComponent.AddThreat
```

固定更新桶的语义是框架约定，不是业务可选参数：

| 桶 | 入口 | 当前用途 |
| --- | --- | --- |
| 20Hz | `Update()` | 地图移动、AOI和帧尾前的基础逻辑 |
| 10Hz | `Update10Hz()` | 玩家自动攻击是否能开始/中断读条 |
| 5Hz | `Update5Hz()` | 主动怪追击、攻击决策 |
| 1Hz | `Update1Hz()` | 尸体清理和新Unit重生 |

不要在Handler里直接调用行为树，也不要为每只怪物或玩家创建一个Actor、Timer或Update目标。行为树只负责选择动作，距离、伤害、死亡和Numeric修改仍由`MonsterComponent`负责。`Update()`是默认20Hz兼容入口；需要中频逻辑时只实现固定名称的方法，不增加`hz`字段或业务频率配置。

## 4. 玩家如何攻击

协议定义在`proto/OuterMessage_C_10001.proto`：

```proto
message C2M_AttackMonster {
  uint32 monster_id = 1;
}
```

业务调用链保持很短：

```text
C2M_AttackMonsterHandler
  -> PlayerUnit.AttackMonster(monsterId)
  -> MonsterComponent.Attack(player, monsterId)
  -> monster.GetComponent(CombatComponent).ApplyDamage(...)
  -> 0时Kill，旧Unit执行Detach/Remove，后续由地图Tick创建新Unit
```

Handler只负责把协议参数交给Unit，不查找地图、不遍历全局Unit、不直接操作Native句柄：

```ts
@unitRpcHandler(PlayerUnit, MapProtocol.AttackMonster)
export class C2M_AttackMonsterHandler {
  Handle(unit: PlayerUnit, request: C2M_AttackMonster): M2C_AttackMonster {
    return unit.AttackMonster(request.monsterId);
  }
}
```

实际工程中的Handler位于`app/hotfix/demo/mapHost/handlers/C2M_AttackMonsterHandler.ts`，协议和类型由`npm run codegen:proto`生成。

### 4.1 伤害和治疗为什么经过CombatComponent

`MonsterComponent`不直接修改目标Numeric，Item Handler也不直接写CurrentHp。所有可受击Unit都挂载`CombatComponent`：

```ts
const result = target.GetComponent(CombatComponent).ApplyDamage({
  amount: attacker.GetComponent(NumericComponent)[NumericType.Attack],
  sourceUnitId: attacker.UnitId,
});
```

如果未来加入真言术·盾，Buff添加时注册处理器：

```ts
const modifierId = target.GetComponent(CombatComponent)
  .RegisterDamageAbsorber(5_000n, 100);
```

伤害入口只执行Combat中已有的处理器，不查询`BuffComponent`。Buff移除时用保存的`modifierId`调用`RemoveDamageAbsorber`。这样护盾、护甲和减伤可以逐步加入Combat规则，攻击者和Buff之间不会互相知道实现细节。完整规则、返回值和错误示例见[战斗伤害与效果管线](../design/combat-damage-pipeline.md)。

## 5. 玩家自动平A

自动平A不是“每次按键立刻打一下”，而是一个持续意图加一段可被打断的读条：

```text
按1开启
  -> 记录 enabled=true 和目标UnitId
  -> 10Hz检查目标存活、同地图、距离<=PlayerConfig.attack_range、目标位于前方120度
  -> 条件满足：从0开始推进swingProgress
  -> 条件不满足：只清零当前读条，保留enabled
  -> 再次满足：重新从0开始读，不能恢复旧进度
  -> 读条完成：MonsterComponent.Attack，命中后开始下一轮
按1取消
  -> enabled=false，目标和读条清除
```

朝向范围是角色前方`±60°`，共120°。服务端使用`PositionComponent.yaw`判断，客户端不能因为画面上“看起来朝向目标”就直接造成伤害。移动、右键环绕和A/D转身只改变权威位置/朝向；它们不会偷偷取消自动攻击。

调用链保持一层胶水：

```text
C2M_ToggleAutoAttackHandler
  -> PlayerUnit.ToggleAutoAttack(targetUnitId, enabled)
  -> CombatComponent.ToggleAutoAttack(...)
  -> MonsterComponentSystem.Update10Hz()
  -> MonsterComponent.Attack(player, targetUnitId)
  -> target.GetComponent(CombatComponent).ApplyDamage(...)
```

`CombatComponent`只保存状态，不实现找怪、距离、朝向和伤害。平A间隔由玩家Numeric的最终`AttackSpeed`设置，玩家攻击距离读取`PlayerConfig.attack_range`，怪物攻击距离读取`MonsterConfig.attack_range`，二者都不是Numeric链式属性。修改攻击速度不会偷偷重置已经开始的读条。平A状态不放入地图Transfer快照，传送到新地图后需要重新按`1`激活。服务端通过`G2C_AutoAttackState`通知本人，消息只在状态改变、读条开始、命中或中断时发送；客户端用最近一次`C2M_Ping`得到的服务器时钟偏差绘制进度条，进度条永远只是表现，不是命中依据。

Cocos3D演示的快捷键和UI位于：

```text
client_demo/cocos_client3D_3.8.8/assets/scripts/Demo/GameBootstrap3D.ts
client_demo/cocos_client3D_3.8.8/assets/scripts/Demo/Handlers/G2C_AutoAttackStateHandler.ts
```

协议增加后执行：

```powershell
npm run codegen:proto:update-lock
npm run codegen
npm run typecheck
npm run typecheck:cocos3d-demo
```

## 6. AOI和客户端数据

怪物加入AOI时只作为`Subject`，不作为`Observer`，因此怪物不会拥有玩家连接，也不会主动管理Gate广播。玩家进入视野时，`MapEntitySnapshot`携带：

```text
entityType = 2
configId   = MonsterConfig.id
account    = ""
position / yaw / speed / alive / numerics
```

客户端通过`entityType`选择怪物表现资源，通过`configId`读取对应模型标识，通过`displayName`显示服务端提供的公开名称。当前演示还把`attack_mode`作为客户端只读的表现提示：自己是蓝色，其他玩家是绿色，被动怪（0）是黄色，主动怪（1）是红色。这个颜色只服务于识别，不是客户端权限判断，也不改变服务端AI。怪物死亡时通过AOI Leave移除旧实体，复活时通过AOI Enter接收新实体快照。客户端可以清理旧表现，但不能把“隐藏”当作服务端生命周期；新实体必须使用新的`UnitId`。

这里要区分两个ID：`AreaId`是固定刷怪槽位的业务配置ID，表示“在哪里刷”；`UnitId`是一次怪物实体生命周期的身份，表示“当前是哪一只实体”。复活只复用`AreaId`，绝不复用旧`UnitId`。这样可以避免客户端、任务、战斗引用把已经销毁的旧怪物误认为新怪物。

本模块不把怪物之间的动态阻挡或动态避障塞进怪物组件。导航门等场景障碍仍由地图导航能力负责，角色和怪物的动态避让明确不属于本阶段。

## 7. 新增怪物业务时的边界

- 新字段和稳定身份放Model；可调整规则放Hotfix System。
- 新模板数值和复活规则放`MonsterConfig`，新刷点和坐标放`MonsterAreaConfig`，不要把策划数据写死在System。
- 任务、掉落、Buff等系统通过`MonsterComponent.Get/GetAll`取得怪物，不维护第二份怪物集合。
- 需要广播的内容先区分Snapshot、Numeric Delta和不可丢Event；不要为了一个战斗事件复制整张怪物表。
- 只有性能证据证明TS或V8边界是瓶颈时，才讨论把怪物计算下沉Rust；不要先把普通AI写进`src/native_data.rs`。
