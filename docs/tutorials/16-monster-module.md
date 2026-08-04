# 怪物模块最小闭环

本教程给出一个完整但刻意保持简单的怪物模块：固定刷点、统一Unit、局部行为树、简单追击、两米内普通攻击、死亡尸体、移除和重生。它用于验证业务开发链路，不是完整商业战斗系统。

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
| `move_speed` | 移动速度，米/秒 |
| `attack_range` | 普通攻击距离，必须大于0且不超过2米 |
| `attack_interval_ms` | 普通攻击间隔 |
| `attack_mode` | `0`被动，`1`主动 |
| `skill_id` | 预留技能配置ID，当前演示只支持普通攻击 |

`MonsterAreaConfig`描述“在哪里刷”：一行就是一个固定刷怪槽位，包含地图配置ID、模板ID、坐标、尸体保留时间和重生时间。当前版本没有随机刷怪池、多个候选点、掉落表和持久化。

修改后执行：

```powershell
npm run build:game-config
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
```

地图固定Tick统一驱动所有怪物，不为每个怪物创建一个长期Timer。当前使用怪物模块内部的轻量行为树，不是通用AI框架：

```text
出生
  -> 无目标：待机
  -> 主动怪找到范围内玩家：追击
  -> 距离不超过2米：停止移动并按配置间隔普通攻击
  -> 玩家通过AttackMonster造成伤害
  -> HP为0，保留尸体
  -> 尸体时间到，Detach并Remove Unit
  -> 重生时间到，在原刷怪槽位重新创建
```

被动怪只作为可攻击目标，不会主动寻找玩家。当前行为树只有待机、追击、攻击和攻击冷却停留四个动作；玩家死亡、掉落、技能、Buff、仇恨列表和复杂战斗结算尚未加入。

行为树的调用关系保持在业务模块内部：

```text
MonsterComponent.Update
  -> MonsterBehaviorTree.Evaluate
  -> MonsterComponentSystem执行Idle/Chase/Hold/Attack
  -> NumericComponent修改CurrentHp
```

不要在Handler里直接调用行为树，也不要为每只怪物创建一个Actor或Timer。行为树只负责选择动作，距离、伤害、死亡和Numeric修改仍由`MonsterComponent`负责。

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
  -> Monster NumericComponent.CurrentHp
  -> 0时Kill，后续由地图Tick完成尸体移除和重生
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

## 5. AOI和客户端数据

怪物加入AOI时只作为`Subject`，不作为`Observer`，因此怪物不会拥有玩家连接，也不会主动管理Gate广播。玩家进入视野时，`MapEntitySnapshot`携带：

```text
entityType = 2
configId   = MonsterConfig.id
account    = ""
position / yaw / speed / alive / numerics
```

客户端通过`entityType`选择怪物表现资源，通过`configId`读取对应模型标识。怪物死亡时先用已有状态和Numeric同步，尸体移除时走AOI Leave，重生时走AOI Enter和完整Snapshot。

本模块不把怪物之间的动态阻挡或动态避障塞进怪物组件。导航门等场景障碍仍由地图导航能力负责，角色和怪物的动态避让明确不属于本阶段。

## 6. 新增怪物业务时的边界

- 新字段和稳定身份放Model；可调整规则放Hotfix System。
- 新模板数值放`MonsterConfig`，新刷点和时间放`MonsterAreaConfig`，不要把策划数据写死在System。
- 任务、掉落、Buff等系统通过`MonsterComponent.Get/GetAll`取得怪物，不维护第二份怪物集合。
- 需要广播的内容先区分Snapshot、Numeric Delta和不可丢Event；不要为了一个战斗事件复制整张怪物表。
- 只有性能证据证明TS或V8边界是瓶颈时，才讨论把怪物计算下沉Rust；不要先把普通AI写进`src/native_data.rs`。
