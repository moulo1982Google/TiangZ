# 教程：新增一个配置化技能

本教程说明如何只通过Luban配置组合现有Action与Buff，并让服务端和Cocos 3D使用同一份技能基础数据。当前演示技能不持久化“已学习列表”，请求仍由服务端校验配置、目标、距离、GCD和CD。

## 1. 先判断改哪一层

```text
SkillConfig       -> 目标关系、读条、CD/GCD、距离、弹道、移动和平A策略
SkillEffectConfig -> 命中后按顺序执行哪些Action
BuffConfig        -> 持续时间、冲突/刷新、Add/Tick/Remove Action
ActionType        -> 最小原子效果；不选择目标、不管理读条
```

新技能如果只是“已有Action的新组合”，只改Excel。只有现有Action无法表达一个原子效果时，才增加ActionType、执行器分支和配置校验；不要为每个技能新增Handler。

## 2. 填写SkillConfig

在`game_config/Datas/SkillConfig.xlsx`增加一行。例如新增一个1秒读条、10米直接治疗技能：

```text
id=3010
name=快速治疗
target_relation=Friendly
cast_time_ms=1000
cooldown_ms=0
global_cooldown_ms=1000
range_meters=10
delivery=Direct
projectile_speed_meters_per_second=0
movement_policy=InterruptWhileCasting
auto_attack_policy=ResetOnStart
revalidate_on_complete=true
required_absent_buff_config_id=0
```

`Direct`的弹道速度必须为`0`；`Projectile`必须填写正数。所有字段都是明确策略，不能根据“物理技能”“法术技能”或技能名称推导移动和平A行为。

## 3. 填写SkillEffectConfig

在`game_config/Datas/SkillEffectConfig.xlsx`增加效果行：

```text
id=301001
skill_id=3010
order=1
target=PrimaryTarget
action_type=6
action_params=200
description=为主目标恢复200点生命
```

`ActionType.Heal`为`6`。一个技能可以有多行效果，例如寒冰箭先执行`DealDamage(50,Frost)`，再执行`AddBuff(4001)`。同技能的`order`必须为正整数且不能重复；运行时按`order`、再按效果行`id`确定顺序。

如果效果是持续状态，先在`BuffConfig.xlsx`定义Buff，再让技能效果执行`AddBuff`。Buff的Tick伤害必须用`DealDamage`，Tick治疗必须用`Heal`，不能用`ChangeNumeric(CurrentHp, ...)`绕过Combat。

## 4. 生成与校验

```powershell
npm run codegen:game-config
npm run codegen:client-sdk
npm run typecheck
npm run typecheck:cocos3d-demo
npm run test:game-config
npm run test:buff-action
```

生成器会在覆盖Generated文件前校验：

- Skill与Buff外键是否存在。
- 技能是否至少有一条效果、效果顺序是否重复。
- Action ID、参数数量、伤害类型和Numeric写入是否合法。
- Direct/Projectile与弹道速度是否匹配。
- 阻止施法的Buff是否存在。

`SkillConfig`进入客户端SDK，供名称、距离、读条和CD表现使用；`SkillEffectConfig`只生成到服务端，客户端不会得到伤害和Buff结算规则。所有Generated文件禁止手工修改。

## 5. 服务端如何使用

外网协议入口保持扁平：

```ts
// C2M_CastSkillHandler
return unit.CastSkill(request.skillId, request.targetUnitId);
```

内部调用链：

```text
PlayerUnit.CastSkill
 -> SkillComponent.Cast
 -> SkillMapComponent.Cast
 -> SkillCatalog按当前配置指纹解析SkillDefinition
 -> 固定校验 + BeforeCast Veto
 -> 瞬发立即结算，或登记ActiveCast给10Hz桶
 -> Direct直接执行Action；Projectile到达后执行Action
 -> Combat / Buff / Numeric各自处理状态与广播
```

业务AI也应调用同一个`SkillComponent.Cast({ skillId, targetUnitId })`，不能复制一套怪物技能结算。Handler不查目标集合、不直接扣HP、不创建Timer、不广播命中。

## 6. 配置热更语义

表结构、字段类型、枚举和Action参数协议属于Model冷结构，修改后必须完整生成并重启。只改Hot表的数据行时，可以生成候选并执行配置Reload。

`SkillCatalog.ts`按配置指纹整体重建索引。请求被接受时，ActiveCast或Projectile会冻结本次`SkillDefinition`：

```text
Reload前已开始的读条/弹道 -> 继续使用旧规则完成
Reload后新发起的技能     -> 使用新规则
```

禁止在Unit或Component中长期缓存`GetSkillDefinition()`返回值，否则会把旧配置代永久挂住。

## 7. 客户端如何使用

Cocos 3D只保留快捷键到SkillId的Demo映射，名称和目标关系从生成配置读取：

```ts
const skill = GameConfigs.SkillConfig.Get(skillId);
showName(skill.name);
showRange(skill.rangeMeters);
```

客户端仍只发送`skillId + targetUnitId`。伤害、命中时刻、Buff和施法成功都以服务端消息为准；不能上传伤害、读条完成或客户端自算命中。

## 8. 何时需要写代码

以下情况才进入代码改造：

1. 新的原子效果无法用现有Action表达。
2. 新的目标类型需要Skill领域解析，例如地面点或方向锥形。
3. 新的时间线需要明确状态，例如Channel或多段引导。
4. 新的同步事实需要协议，例如可见但不可覆盖的多段命中事件。

此时先更新Model枚举/数据形状和配置校验，再实现Hotfix行为与测试，并同步`docs/ai/project-context.md`和`docs/ai/business-development-manual.md`。不要先在某个技能Handler里写特例。
