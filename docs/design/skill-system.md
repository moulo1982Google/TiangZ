# 技能与施法系统设计

> 当前实现状态：五技能演示闭环已落地。稳定数据形状位于`app/model/demo/skill/`，可热更规则位于`app/hotfix/demo/skill/`，玩家协议入口为`C2M_CastSkillHandler`，地图统一由一个`SkillMapComponent.Update10Hz()`推进读条和弹道。首批数值暂存于Hotfix `SkillCatalog.ts`；后续接入Luban时只替换数值来源，不改变Component、Handler或Action调用面。

## 1. 目标与边界

技能系统负责回答四件事：

1. Unit是否学会并且现在可以使用某个技能。
2. 这次技能以什么目标、什么时间线执行。
3. 施法何时完成、为何中断，以及冷却何时开始。
4. 完成时向哪些目标执行哪些Action。

技能系统不直接修改HP、不自己实现护盾、不广播AOI，也不把伤害规则复制一份：

```text
SkillComponent
  -> 选择并冻结目标
  -> 创建一次ActiveCast
  -> 完成时ExecuteAction
       -> CombatComponent.ApplyDamage/ApplyHealing
       -> BuffComponent.AddBuff/RemoveBuff
       -> NumericComponent（非派生普通数值）
```

已有边界保持不变：Combat负责目标侧结算，Buff负责持续生命周期，Action表达效果，Map/Audience负责广播，客户端只做输入和表现。

## 2. 核心对象

### 2.1 SkillConfig

`SkillConfig`是计划接入Luban的技能模板，描述一次技能如何发起，不保存某个玩家的运行状态。当前五技能由`SkillCatalog.ts`提供同形状纯数据，建议字段：

| 字段 | 作用 |
|---|---|
| `id/name/icon` | 稳定配置ID、显示名和客户端资源键 |
| `target_type` | Self、Unit；Ground和Direction留到后续 |
| `target_relation` | Self、Ally、Enemy或Any；只描述合法关系，不用AOI可见性代替阵营判断 |
| `cast_mode` | Instant、Cast；Channel留到后续 |
| `cast_time_ms` | 普通读条时间，Instant必须为0 |
| `range_meters` | 权威技能距离，Self忽略 |
| `front_angle_degrees` | 权威朝向角；120表示左右各60度 |
| `requires_line_of_sight` | 是否进行NavMesh/空间遮挡检查 |
| `movement_policy` | Allow、RejectOnStart、InterruptWhileCasting |
| `cooldown_ms` | 技能自身冷却 |
| `cooldown_start` | Accepted或Completed |
| `gcd_group/gcd_ms` | 公共冷却分组和时长；0表示不触发GCD |
| `cost_numeric_type/cost_amount` | 从施法者Numeric扣除的资源及数量；0表示无消耗 |
| `auto_attack_policy` | Keep、ResetOnStart、ResetOnComplete、Cancel |
| `revalidate_on_complete` | 完成时是否重新检查目标、距离、朝向和视线 |

伤害类型、是否瞬发、是否重置平A必须是独立维度。不能用“物理技能”推导不重置，也不能用“法术技能”推导一定读条。压制可以是物理、瞬发、`Keep`；火球术可以是法术、读条、`ResetOnComplete`。

### 2.2 SkillEffectConfig

技能可能同时造成伤害、添加Buff或修改多个目标，不把可变长度Action硬塞进`SkillConfig`的一格Excel。正式表格化时使用独立`SkillEffectConfig`表；当前由`SkillDefinition.effects`按数组顺序表达：

| 字段 | 作用 |
|---|---|
| `id` | 效果行稳定ID |
| `skill_id` | 外键指向SkillConfig |
| `phase` | Start、Complete；Tick留给Channel |
| `order` | 同阶段确定性执行顺序 |
| `target` | Caster或PrimaryTarget |
| `action_type` | 复用ActionType |
| `action_params` | 当前Action的i64参数列表 |

加载配置时按`skill_id + phase + order + id`建立只读索引。第一版最多支持Caster和PrimaryTarget，不在ActionExecutor里做AOI查询或随机选目标。

### 2.3 SkillComponent

每个可以使用技能的Unit挂一个`SkillComponent`。它拥有：

```ts
knownSkills: Set<number>;              // SkillConfigId
skillCooldowns: Map<number, number>;  // skillId -> deadlineMs
groupCooldowns: Map<number, number>;  // gcdGroup -> deadlineMs
activeCast: ActiveCastState | null;
```

第一版不为每个已学技能创建Skill子Entity，原因是同一Unit不能重复学习同一SkillConfig，配置ID已经是稳定身份，而且它没有独立生命周期、Timer或Actor消息。如果以后出现独立符文、词缀、耐久或可交易技能实例，再引入子Entity，不提前支付复杂度。

玩家和怪物复用同一个`SkillComponent`。玩家通过Handler发起，怪物AI直接调用同一方法；不能再写一套MonsterSkill。

### 2.4 ActiveCastState

一次施法是短生命周期运行状态，不是Actor，也不是持久化Entity：

```ts
interface ActiveCastState {
  castId: bigint;
  skillId: number;
  sourceUnitId: number;
  targetUnitId: number;
  acceptedAtMs: number;
  finishAtMs: number;
  configFingerprint: string;
  resolvedRules: ResolvedSkillCast;
}
```

开始施法时把本次需要的时间、距离、目标、Action和策略冻结为纯数据。配置在读条期间Reload不会改变已经开始的Cast；新Cast使用新配置。Cast取消、完成、下线、死亡、传送或Unit销毁后立即清除，不参加地图传送和数据库保存。

`castId`使用全局InstanceId生成器并通过`bigint/uint64`传输。它只用于区分客户端迟到的开始、完成和中断消息，不是永久EntityId。

## 3. 状态机

```text
Idle
  -> TryCast
  -> Validate
  -> Veto BeforeCast
  -> PayCost + StartGCD
  -> Instant: Resolve -> Cooldown -> Idle
  -> Cast: Casting

Casting
  -> 10Hz检查移动/死亡/目标有效性
  -> Interrupted: 清除ActiveCast -> 通知客户端 -> Idle
  -> finishAtMs到达
       -> 可选重新校验距离/朝向/视线
       -> Resolve Actions
       -> StartCooldown（若配置为Completed）
       -> 清除ActiveCast -> Idle
```

第一版一个Unit同一时间只能有一个ActiveCast；只要已有普通读条，新的瞬发和读条请求都直接拒绝。以后确实需要“读条期间允许特定瞬发”时，再增加显式冲突策略和验收矩阵，不能靠“瞬发”二字猜测。Channel和技能队列后续扩展，不在第一版伪实现。

## 4. 校验与Veto

固定不变量由`SkillComponent.TryCast`直接检查：

1. Skill已学习、配置存在。
2. 当前没有互斥Cast。
3. 技能冷却和GCD已结束。
4. Numeric资源足够。
5. 目标存在、存活、属于同一MapInstance，并满足Self、Ally、Enemy或Any关系。
6. 距离、朝向、视线和移动条件满足。

可由其他模块扩展的规则走同步Veto：

```text
SkillEvents.BeforeCast
  -> 沉默
  -> 眩晕/冰冻/混乱
  -> 地图禁用技能
  -> 武器或姿态要求
  -> 特殊Buff限制
```

Veto Handler只能同步、只读、返回错误码，不动态为每个Buff注册闭包。通过后才扣资源、启动GCD或执行Action。

目标关系通过稳定的Unit关系查询接口判断，不能用“目标当前在AOI可见集合中”推导敌我。AOI决定谁能收到表现，技能规则决定谁可以成为目标，两者必须分开。

第一版资源和GCD在请求被接受时扣除/启动；读条随后被中断不退款、不返还GCD。技能自身冷却仍按`cooldown_start`选择Accepted或Completed。以后若个别技能需要退款，必须增加显式退款策略，不能在中断Handler里私自补数值。

死亡、下线、传送和Scene销毁属于确定的生命周期中断，不走Veto。中断已发生后发布普通同步Event，不能用Veto回滚。

## 5. 时间、调度和性能

- Instant在当前PlayerUnit ordered mailbox内完成，不创建Update目标。
- Cast由`SkillComponent`保存deadline并登记到地图唯一`SkillMapComponent`，统一在10Hz检查；客户端最多只看到约100ms的完成抖动，命中仍以服务器时间为准。
- 没有每Unit空Update。地图只遍历活动Cast和在途弹道集合；3000个无施法Unit不会产生3万次技能空检查/秒。
- 技能和GCD冷却只保存deadline，不为每个冷却创建Timer。
- Channel后续使用同一10Hz桶和`nextTickAtMs`，不创建每技能Timer。

如果实测空检查成为问题，再把活跃SkillComponent登记到Map的连续ActiveCast集合；该优化不得改变业务API。

## 6. 平A关系

`auto_attack_policy`只控制平A时间线，不改变技能伤害类型：

| 策略 | 行为 |
|---|---|
| Keep | 保留平A激活状态和已有节奏，例如压制 |
| ResetOnStart | 技能被接受时清零平A读条，但仍保持激活 |
| ResetOnComplete | 技能成功完成后清零平A读条；中断不重置 |
| Cancel | 取消平A激活状态和目标 |

“清零”沿用现有`ResetAutoAttackSwing`语义：仍处于自动攻击激活状态，重新满足条件后从0开始，不能恢复旧进度。

## 7. Action改造

当前`ExecuteAction(owner, action)`只适合道具和Buff对Owner生效。技能接入前必须把来源和目标明确分开：

```ts
ExecuteAction(target, action, {
  sourceUnitId: caster.UnitId,
  abilityId: skillId,
  castId,
  reason: "skill-complete",
});
```

增加稳定Action：

- `DealDamage(amount)`：调用目标Combat的`ApplyDamage`，正确携带sourceUnitId、abilityId和castId。
- `Heal(amount)`：调用目标Combat的`ApplyHealing`。

`ChangeNumeric(CurrentHp, delta)`保留兼容，但新技能不得用它表达伤害或治疗。Action只执行明确目标上的效果，绝不在内部寻找Unit、遍历AOI或决定敌我。

多Action按配置顺序依次执行。第一版采用“前置完整校验，开始执行后不回滚已完成Action”的事件语义；需要经济原子性的效果未来必须走独立事务，不把战斗Action伪装成数据库事务。

## 8. 调用链

玩家单位目标技能：

```text
C2M_CastSkillHandler
  -> PlayerUnit.CastSkill(skillId, targetUnitId)
  -> SkillComponent.Cast(...)
  -> SkillMapComponent.Cast(...)
       -> 固定校验
       -> Scene.Events.Check(SkillEvents.BeforeCast)
       -> 创建ActiveCast或立即Resolve
  -> MapComponent.PublishCastState（本人/AOI按表现需求）
```

10Hz完成：

```text
SkillMapComponent.Update10Hz
  -> ValidateActiveCast
  -> ResolveSkillEffects
       -> ExecuteAction(target, action, context)
       -> Combat/Buff/Numeric
  -> Scene.Events.Publish(CastCompleted)
  -> MapComponent.PublishCastState
```

Handler只负责协议转换和调用PlayerUnit，不查目标集合、不扣蓝、不启动Timer、不直接广播伤害。

## 9. 网络同步

第一版协议分开“可覆盖状态”和“不可丢事实”：

- `C2M_CastSkill/M2C_CastSkill`：发起请求和明确错误码。
- `G2C_SkillCastState`：`latest`状态，包含castId、skillId、目标、开始/结束服务器时间、GCD/CD截止时间和phase；客户端据Ping时间绘制读条与冷却。
- `G2C_SkillProjectile/G2C_SkillImpact`：不可覆盖事件，分别表达弹道开始与权威命中结果。
- 伤害、治疗、Buff添加/删除继续走各自既有事件或状态同步，不塞进CastState。

客户端不能上传castTime、damage、range、cooldown或“施法完成”。客户端只提交skillId和目标描述。

SkillConfig/SkillEffectConfig的表结构、枚举和字段类型属于Model冷结构；数据行可以按现有游戏配置流程热更新。ActiveCast在接受请求时已经冻结规则和Action，因此Reload只影响之后创建的新Cast。

## 10. 中断规则

中断原因使用稳定枚举，至少包括：

- ManualCancel
- Moved
- Dead
- TargetInvalid
- OutOfRange
- FacingInvalid
- LineOfSightBlocked
- Transfer
- Offline
- ReplacedBySkill

是否移动中断由SkillConfig决定；目标在读条期间离开距离是否中断由`revalidate_on_complete`和技能规则决定。不要把所有变化都解释成“施法失败”，客户端需要区分请求被拒绝和已开始后被中断。

## 11. 首个演示闭环

第一版演示五个法术，全部触发1秒公共冷却，并在技能被接受时清零平A进度；读条期间暂停平A，成功或中断后都从0重新计时，但不关闭平A激活状态或清除目标。

1. `3001 寒冰箭`：敌方Unit目标、1.5秒读条、15米、20米/秒抛射物；命中造成50点冰霜伤害并添加5秒冰冷。
2. `3002 火焰冲击`：敌方Unit目标、瞬发、5米、12秒冷却；造成100点火焰伤害并添加6秒灼烧。
3. `3003 惩击`：敌方Unit目标、1.5秒读条、15米、直接命中；演示伤害暂定60点神圣伤害。
4. `3004 真言术·盾`：自己或友方Unit目标、瞬发、15米、8秒冷却；添加30秒200点护盾和15秒虚弱灵魂。
5. `3005 真言术·韧`：自己或友方Unit目标、瞬发、15米；添加30分钟MaxHpAdd+500的真言术·韧。

对应Buff的冲突语义由BuffConfig表达：冰冷按目标共享并刷新；灼烧按`目标+来源`独立，同来源刷新；盾按目标替换并重置吸收状态；虚弱灵魂重复添加拒绝；韧以HigherWins比较显式优先级。Refresh默认不重复执行AddAction。

玩家出生临时学习这些技能；快捷栏增加技能按钮。选中怪物或友方Unit后按键施放，显示读条、GCD和技能冷却。该预置属于Demo，未来由持久化恢复已学技能。

验收至少覆盖：

1. 同时请求两个技能只能接受一个。
2. 五个法术被接受时都清零平A；读条技能中断不触发命中效果。
3. 寒冰箭只在抛射物命中时结算，惩击在读条完成时直接结算。
4. 距离、朝向、移动、死亡和目标重生均不会命中旧Unit。
5. 重复请求、迟到客户端状态和配置Reload不造成重复结算。
6. 3000个无ActiveCast Unit不会显著增加Map CPU；活跃Cast压力测试无队列积压和丢工作。

## 12. 当前代码权威

当前运行时以代码而不是上文规划字段为准：

```text
C2M_CastSkillHandler
  -> PlayerUnit.CastSkill
  -> SkillComponent.Cast
  -> SkillMapComponent.Cast
       -> 同步校验存活、目标关系、距离和GCD/CD
       -> Scene.Events.Check(SkillEvents.BeforeCast)
       -> SkillMap与Buff领域不变量再次兜底
       -> Instant立即Resolve
       -> Cast登记ActiveSkillCast，由地图唯一Update10Hz推进
       -> Projectile登记纯值弹道deadline，命中时按UnitId重取目标
       -> ExecuteAction(target)
            -> CombatComponent.ApplyDamage
            -> BuffComponent.ApplyBuff
```

- Unit没有独立技能Update，Cast没有独立Timer。
- 普通读条被接受时立即清除Rust旧移动租约；后续任意非零移动输入中断读条，转身输入本身不算移动。
- 可扩展施法限制使用同步只读`SkillEvents.BeforeCast`；当前虚弱灵魂由Hotfix Veto返回`SkillBlockedByBuff`，Buff冲突策略仍保留最终兜底。
- `G2C_SkillCastState`是latest状态，包含读条、GCD和技能CD截止时间；`G2C_SkillProjectile/G2C_SkillImpact`是不可覆盖事件。
- 冷却随玩家跨地图传输；活动读条不恢复，并记录`map-transfer`中断原因。
- Buff运行时Action覆盖、来源、冲突优先级和护盾剩余量均为纯值传输；普通Refresh不重放AddAction。
- 当前五技能数值位于`app/hotfix/demo/skill/SkillCatalog.ts`。Luban接入是后续的数据源替换，不允许修改上述业务调用链。

## 13. 后续实施顺序

1. 把Hotfix `SkillCatalog.ts`迁入Luban SkillConfig/SkillEffectConfig，并增加引用和Action参数校验。
2. 按需求同步UE、Unity和Godot的技能表现；公共SDK协议已经生成。
3. 增加SkillComponent语义自测和3000人空载/活跃Cast性能A/B。
4. 业务确实需要时再扩展已学技能、资源消耗、朝向/视线、地面目标和引导。

第一版明确不做：地面AOE、引导、多段选目标、技能队列、连招、复杂公式、技能持久化和客户端预测命中。寒冰箭的最小弹道已经实现；后续能力应沿已冻结边界逐项增加，而不是提前塞进一个万能Cast对象。
