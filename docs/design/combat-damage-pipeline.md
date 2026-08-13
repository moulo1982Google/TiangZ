# 战斗伤害与效果管线

本文定义 TiangZ 标准 Demo 的伤害、治疗和临时效果边界。核心目标是：

```text
攻击者决定“打谁、什么时候打”
目标的CombatComponent决定“实际受到多少伤害”
Buff只负责在生命周期变化时挂载或卸载效果
```

这套规则解决一个常见的错误依赖：受到伤害时直接去查找或调用
`BuffComponent.TryAbsorbDamage()`。伤害入口不应该知道目标身上有没有 Buff。

## 一、世界观

```text
Monster / Player / Skill / Action
          |
          v
CombatComponent.ApplyDamage(DamageRequest)
          |
          +-- 已注册的受伤处理器（护盾、减伤、护甲……）
          |
          +-- Numeric.CurrentHp
          |
          +-- DamageResult
```

反向的依赖是禁止的：

```text
错误：Damage -> BuffComponent -> TryAbsorbDamage -> CurrentHp
正确：Buff -> CombatComponent.RegisterDamageAbsorber
      Damage -> CombatComponent.ApplyDamage
```

`CombatComponent`是当前 Demo 中最小且稳定的目标战斗边界。暂时不额外拆出
`DamageSystem`、`HealthSystem`或全局`DamageEventBus`，避免开发者为了扣一次血需要理解过多对象。

## 二、组件职责

### CombatComponent

挂在所有可以被攻击或治疗的 Unit 上，当前玩家和怪物都必须挂载。它负责：

- `ApplyDamage`：统一伤害入口；
- 依优先级执行已注册的伤害吸收处理器；
- 修改权威`NumericType.CurrentHp`；
- 自动限制伤害不超过当前生命值；
- 返回吸收量、实际扣血、剩余生命和死亡结果；
- `ApplyHealing`：统一治疗入口并限制`MaxHp`；
- 目标死亡时把Rust权威Unit标记为不可用并停止移动；
- 管理受伤处理器的注册、更新和注销。

它不负责：

- 查找目标；
- 判断距离、朝向、技能射程；
- 选择攻击频率；
- 决定怪物是否重生；
- 选择AOI接收者；
- 读取或查询`BuffComponent`。

### MonsterComponent

`MonsterComponent`是地图级业务组件，负责刷怪、AI、目标选择、攻击距离、仇恨、死亡和重生。
它选择目标后调用目标的`CombatComponent`，不再直接改目标的`CurrentHp`。

玩家平A和技能伤害怪物时统一经过`MonsterComponent.ApplyPlayerDamage`：先由Combat结算护盾和实际扣血，再按`DamageResult.finalDamage`以1:1写入仇恨。主动怪无仇恨时的12米索敌只是“发现新目标”的规则，不能过滤已经由远程伤害建立的仇恨目标；否则伤害与AI会出现“记了仇但不追”的矛盾状态。脱战及返回出生点属于另一条规则，应使用独立冷配置，不能复用主动索敌距离。

### BuffComponent

未来的`BuffComponent`负责Buff实例的创建、删除、持续时间、Tick和配置效果。
护盾Buff添加时向目标的`CombatComponent`注册吸收处理器，移除或过期时注销。
伤害结算期间不调用`BuffComponent`。

### ItemComponent和Action

`ItemComponent`只负责拥有道具和消耗道具。道具效果由Hotfix Action执行：

- 直接回血：调用`owner.GetComponent(CombatComponent).ApplyHealing(amount)`；
- 加护盾：调用`RegisterDamageAbsorber`，并把返回的`modifierId`保存到效果实例；
- 造成伤害：构造`DamageRequest`并调用目标的`ApplyDamage`；
- 修改普通Numeric：只有不属于战斗结算的数值才直接调用Numeric。

Action不应该直接写`CurrentHp`，否则会绕过护盾、死亡、治疗上限和未来的战斗规则。

## 三、当前稳定API

### 伤害

```ts
const result = target.GetComponent(CombatComponent).ApplyDamage({
  amount: 100n,
  sourceUnitId: attacker.UnitId,
  abilityId: 0,
  actionId: 0,
});

// 只能读取结果，不能再对CurrentHp做第二次修改。
if (result.killed) {
  // 地图业务决定移除、掉落和重生；CombatComponent不直接销毁Unit。
}
```

`DamageResult`包含：

| 字段 | 含义 |
| --- | --- |
| `requestedDamage` | 请求造成的原始伤害 |
| `absorbedDamage` | 护盾或其他吸收处理器消耗的伤害 |
| `finalDamage` | 实际扣除CurrentHp的伤害 |
| `remainingHp` | 结算后的权威生命值 |
| `killed` | 本次是否把一个存活Unit打到0血 |
| `absorptions` | 每个处理器本次吸收量和剩余量 |

### 治疗

```ts
const result = owner.GetComponent(CombatComponent).ApplyHealing(50n);
```

治疗由服务端读取`MaxHp`并截断溢出。死亡Unit不会因为普通治疗自动复活；复活必须是单独的业务Action。

### 护盾注册

```ts
const combat = owner.GetComponent(CombatComponent);
const modifierId = combat.RegisterDamageAbsorber(5000n, 100);

// Buff实例只保存这个ID，不接管CombatComponent的ApplyDamage。
const remaining = combat.GetDamageAbsorberRemaining(modifierId);

// Buff移除、过期或失效时：
combat.RemoveDamageAbsorber(modifierId);
```

规则如下：

- 优先级数字越大越先吸收；
- 同优先级按`modifierId`升序，保证结果确定；
- 护盾耗尽后保留处理器记录为0，是否移除由Buff生命周期决定；
- 恢复、天赋改写或反序列化时使用`UpdateDamageAbsorber`；
- 未知`modifierId`返回`undefined`或`false`，不伪造一个可用效果；
- 处理器只保存数据，不保存旧Hotfix闭包。

## 四、真言术·盾的正确调用关系

将来实现Buff后，调用关系应是：

```text
AddBuff(真言术·盾)
  -> 创建Buff ChildEntity
  -> 执行AddAction(AddDamageAbsorber, 5000)
  -> CombatComponent.RegisterDamageAbsorber(5000)
  -> Buff保存modifierId

受到伤害
  -> CombatComponent.ApplyDamage(request)
  -> CombatComponent内部消耗护盾
  -> 剩余伤害扣CurrentHp
  -> 返回DamageResult

RemoveBuff / Buff过期
  -> 执行RemoveAction(RemoveDamageAbsorber)
  -> CombatComponent.RemoveDamageAbsorber(modifierId)
  -> Remove Buff ChildEntity
```

这里`BuffComponent`和`CombatComponent`存在单向协作，但伤害系统没有反向依赖Buff。
`absorbRemaining`的权威运行时状态属于注册的伤害处理器；Buff可以通过`modifierId`
读取或在保存/投影时取得它，不应在Buff和Combat中各自维护一份会分叉的剩余值。

## 五、广播规则

伤害结算与广播分开：

```text
CombatComponent.ApplyDamage
  -> 修改Numeric.CurrentHp并标脏
  -> 返回DamageResult
Map/Combat业务
  -> Numeric帧尾latest同步HP
  -> 技能命中、死亡、掉落等事实另发event
```

- HP最终值是可覆盖状态，使用Numeric dirty/latest；
- 技能命中、道具消耗、死亡和掉落是不可逆事实，使用event；
- 护盾公开外观使用`BuffAdded/BuffRemoved`；
- 护盾剩余量只给自己或队友时，使用受限的`BuffDetail` latest；
- CombatComponent不选择AOI受众，也不直接访问Gate。

如果同一帧受到三次伤害，客户端只需要收到最新HP和最新护盾详情；但三次技能命中事实不能合并成一次。

## 六、生命周期与热更

`CombatComponent`和伤害处理器是Model承载的稳定数据边界，具体规则在Hotfix System实现。
Buff添加/移除时必须成对注册和注销，不能只删除Buff而留下处理器。
CombatComponent销毁时会清理所有处理器，防止Unit销毁后仍然吸收伤害。

处理器不能保存匿名Hotfix闭包或旧generation对象。长期状态只保存：

- `modifierId`；
- 优先级；
- 剩余量；
- 必要的稳定来源ID。

Hotfix Reload不会重建现有Unit，也不会依靠旧闭包继续运行。若未来Buff拥有长期Timer，Timer按方法名调用当前generation，Buff移除时主动取消或由Entity所有权级联取消。

## 七、开发禁用规则

以下写法在业务代码审核中应判定为错误：

```ts
// 错误：攻击入口查询BuffComponent。
target.GetComponent(BuffComponent).TryAbsorbDamage(amount);

// 错误：Handler或MonsterComponent直接修改战斗HP。
target.GetComponent(NumericComponent)[NumericType.CurrentHp] -= damage;

// 错误：Buff和Combat各保存一份没有同步协议的护盾剩余量。
buff.absorbRemaining -= damage;
combatShadowAbsorb -= damage;
```

推荐检查顺序：

1. 攻击者或技能系统确认目标、距离、朝向和施法状态；
2. 构造`DamageRequest`并调用目标`CombatComponent.ApplyDamage`；
3. 根据`DamageResult`处理仇恨、死亡、掉落或战斗事件；
4. 让Numeric和广播系统负责状态同步；
5. 让Buff系统只管理Buff生命周期和它注册的效果。

## 八、当前实现与验证

本规则当前落在：

```text
app/model/mmorpg/combat/CombatComponent.ts
app/hotfix/mmorpg/combat/CombatComponentSystem.ts
app/hotfix/mmorpg/monster/MonsterComponentSystem.ts
app/hotfix/mmorpg/mapHost/handlers/C2M_UseItemHandler.ts
tools/combat_self_test.ts
```

当前冒烟测试覆盖：

- 多个护盾按优先级和稳定ID依次吸收；
- 护盾剩余量更新和注销；
- 剩余伤害扣血；
- 治疗MaxHp截断；
- 负数伤害/治疗拒绝；
- 测试对象没有`BuffComponent`仍可完成完整伤害结算。

运行：

```powershell
npm run codegen:scenes
npm run typecheck
npm run test:combat
npm run test:monster-behavior
```

这是一套领域边界和标准Demo，不是要求所有项目都照抄同名类。项目可以把战斗数据继续下沉Rust，
但必须保持`CombatComponent.ApplyDamage/ApplyHealing`的业务语义和广播边界不变。
