# 固定更新桶与自动平A设计

## 设计目标

这部分只解决两个问题：

1. 地图上有很多玩家和怪物时，不为每个对象创建一个Timer或Update目标。
2. 平A保持“激活意图”和“武器计时”两个概念；计时到点但命中窗口暂时无效时保持就绪，避免移动目标反复重置完整武器间隔。

它不是完整战斗框架，也不提前加入技能、Buff、掉落或动态避障；当前只提供最小的伤害仇恨入口。

## 固定更新桶

默认Process固定逻辑帧为20Hz，`UpdateSystem`把业务对象登记到固定集合：

```text
Update()       -> 每个20Hz逻辑帧
Update10Hz()   -> 每2个20Hz逻辑帧
Update5Hz()    -> 每4个20Hz逻辑帧
Update1Hz()    -> 每20个20Hz逻辑帧
LateUpdate()   -> 每个20Hz逻辑帧的后处理
FrameFlush()   -> 每个20Hz逻辑帧的帧尾复制
```

业务不填写`hz`参数，也不在配置中给每个对象选择频率。频率是框架固定语义：

- 20Hz：Rust移动推进、AOI关系和地图基础逻辑；
- 10Hz：战斗可用性、读条开始/中断；
- 5Hz：主动怪AI、仇恨目标选择和追击判断；
- 1Hz：刷怪重生、尸体清理和低频维护。

Rust仍由一个Game固定帧入口承接批量移动和AOI，TS只在同一个V8线程中按桶遍历组件。这样没有额外的Rust调度循环，也没有每个玩家一次跨语言调用的固定成本。

当前演示中，`MonsterConfig.attack_mode=1`的主动怪没有仇恨时会在5Hz桶中寻找最近玩家；所有玩家对怪物造成的实际伤害都会按“1点伤害=1点仇恨”累加，之后主动怪和被动怪都优先追击范围内仇恨最高的玩家。`attack_mode=0`的被动怪没有仇恨时保持待机，不因为“收到一次攻击事件”直接追击。攻击距离分别从`PlayerConfig.attack_range`和`MonsterConfig.attack_range`读取，伤害仍按最终`NumericType.Attack`扣除目标`CurrentHp`。玩家创建时从`PlayerConfig`初始化HP/MP Numeric，3D客户端HUD只显示快照和`G2C_EntityNumeric`增量，不复制这套战斗判定。

新增桶的位置：

```text
app/core/runtime/UpdateSystem.ts
app/core/public.ts
```

现有业务的`Update()`仍然是20Hz，不需要迁移。新组件只实现需要的固定接口，例如：

```ts
@systemFor(MonsterComponent)
export class MonsterComponentSystem extends MonsterComponent {
  Update10Hz(): void { /* 战斗判定 */ }
  Update5Hz(): void { /* 主动怪AI */ }
  Update1Hz(): void { /* 重生和清理 */ }
}
```

不要这样写：

```ts
// 不要：每个玩家创建一个Timer或自定义频率字段。
player.NewRepeatedTimer(100, "CheckAttack");
component.updateHz = 7;
```

## 平A状态机

`CombatComponent`是玩家Unit上的稳定状态容器，Hotfix实现位于：

```text
app/model/mmorpg/combat/CombatComponent.ts
app/hotfix/mmorpg/combat/CombatComponentSystem.ts
```

状态：

```text
Inactive  未激活
Waiting   已激活，尚未开始本轮武器计时
Swinging  武器计时推进中，或到点后等待有效命中窗口
```

关键规则：

- `enabled`表示玩家仍想攻击目标，不代表当前一定在读条。
- 目标必须存活并属于当前MapScene，否则关闭本次自动攻击意图。
- 命中窗口要求距离不超过`PlayerConfig.attack_range`，且目标位于角色前方120°内，即目标方向与角色Yaw差值不超过60°。
- 激活且目标仍存活时调用`BeginAutoAttackSwing(now)`开始本轮武器计时；距离和朝向不阻止计时推进。
- 武器计时到点时，10Hz桶检查距离和朝向；暂时不满足则保留原起点并在下一帧重试，不重新等待完整武器间隔。
- 成功调用`MonsterComponent.Attack`后才用当前时间开始下一轮；施法策略等显式中断仍可调用`ResetAutoAttackSwing()`。
- 目标死亡后关闭自动攻击；如果只是移动离开范围，仍保持自动攻击激活。
- 玩家死亡时也显式关闭自动攻击并推送`Inactive`，避免客户端把最后一次读条状态误显示成仍在攻击。
- 平A状态不进入Entity Transfer快照，跨地图后必须重新激活。

调用关系：

```text
C2M_ToggleAutoAttack
  -> Gate/PlayerUnit ordered mailbox
  -> PlayerUnit.ToggleAutoAttack
  -> CombatComponent.ToggleAutoAttack
  -> MapComponent.PublishAutoAttackState (本人)

每个10Hz桶
  -> MonsterComponentSystem.TickPlayerAutoAttacks
  -> CombatComponent.BeginAutoAttackSwing
  -> 到点后CanAutoAttack (距离 + 前方120°)，失败则下个10Hz帧重试
  -> MonsterComponent.Attack
  -> Rust Numeric dirty
  -> FrameFlush/AOI广播 Numeric Delta
```

## 协议与客户端

源协议位于`proto/OuterMessage_C_10001.proto`：

```proto
C2M_ToggleAutoAttack
M2C_ToggleAutoAttack
G2C_AutoAttackState
```

`G2C_AutoAttackState`只发送状态边界，不按10Hz发送进度；它是每个玩家本人频道上的`latest`可覆盖状态，不是不可丢失事件。未发送的旧读条状态可以被同一玩家的最新状态覆盖。它包含服务器读条起点和间隔，客户端通过最近一次Ping的服务器时钟偏差绘制百分比。服务器不信任客户端的进度条，也不接受客户端“读条完成”的消息。攻击命中、道具消耗等不可逆事实仍必须使用`event`。

Cocos3D的业务入口：

```text
按键1
  -> MapClient.toggleAutoAttack
  -> C2M_ToggleAutoAttackHandler
  -> G2C_AutoAttackStateHandler
  -> GameBootstrap3D.ApplyAutoAttackState
```

业务客户端应该把Push Handler放在独立文件，不要把Socket监听器继续堆进构造函数。新增协议后只编辑proto源文件，然后运行`npm run codegen`。

## 未来扩展边界

普通攻击间隔、攻击距离、伤害和是否重置平A应属于战斗/武器配置。当前演示的玩家/怪物攻击距离先分别放在`PlayerConfig.attack_range`和`MonsterConfig.attack_range`，它们是独立米制距离，不写入Numeric。瞬发技能、施法技能、物理伤害不是同一维度：是否重置平A必须是独立规则字段。比如“压制”可以是物理、瞬发、但不重置平A。

### 最小仇恨规则

```text
玩家造成实际伤害
  -> MonsterComponent.AddThreat(monster, player, damage)
  -> 该玩家仇恨值 += damage
  -> 5Hz选择范围内仇恨最高者
  -> 被动怪开始追击并攻击
```

`MonsterComponentSystem.Attack`是当前普通攻击的唯一落点，已经在扣除怪物HP后调用`AddThreat`。技能、DoT、嘲讽等后续系统应复用这个入口或在同一处扩展规则；不要在“怪物受击回调”里直接设置`targetUnitId`，否则被动怪会失去仇恨系统的统一语义。

如果未来需要把计算下沉Rust，应先保持`CombatComponent`和协议语义不变，只替换`MonsterComponentSystem`调用的批量结算实现；不要让Rust回调TS逐玩家逐字段查询。当前版本先用TS验证开发体验和战斗语义。
