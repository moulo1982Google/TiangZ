# Action与Buff设计

本文定义TiangZ的通用效果层。道具、Buff Tick和技能命中都复用Action；Cast只负责目标与时间线，不把伤害、治疗或Buff生命周期再实现一遍。

## 一、先看世界观

```text
客户端 C2M_UseItem
        |
        v
PlayerUnit上的UseItem Handler
        |
        +--> ItemComponent消费一个道具
        |
        +--> ActionExecutor.ExecuteAction(player, action)
                    |
                    +--> ChangeNumeric -> Numeric
                    +--> Heal/DealDamage -> Combat
                    +--> AddBuff      -> BuffComponent.AddBuff
                    +--> RemoveBuff   -> BuffComponent.RemoveBuff
                    +--> RegisterDamageAbsorber -> Combat modifier

BuffComponent
  +-- Buff ChildEntity
        +-- AddAction（创建时一次）
        +-- TickAction（按墙钟间隔）
        +-- RemoveAction（移除/到期/销毁时一次）
```

核心原则只有三条：

1. **Item只声明效果，不实现效果。** 道具表提供Action类型和整数参数，Handler负责校验和消费，执行器负责路由。
2. **Buff只拥有自己的生命周期。** Buff是`BuffComponent`拥有的ChildEntity，不是Actor，不接收网络消息；Timer属于Buff，Timer触发时执行Action。
3. **Action不负责目标选择和广播。** Action只操作调用方已经解析出的目标。HP通过`CombatComponent.ApplyDamage/ApplyHealing`，Buff通过`BuffComponent`，广播由Map/Audience完成。

这样做以后，“小红药”和“每3秒回血，持续30秒”只是配置不同：前者是一条立即Action，后者是一个带TickAction的Buff。

## 二、目录对应关系

```text
app/model/demo/action/ActionType.ts       # 稳定Action类型和参数形状
app/model/demo/buff/Buff.ts               # Buff数据形状、传送值快照、ChildEntity
app/model/demo/buff/BuffComponent.ts      # Buff集合能力边界
app/hotfix/demo/action/ActionExecutor.ts  # Action解释与组件路由
app/hotfix/demo/buff/BuffSystem.ts         # 单个Buff的Awake、Tick、Destroy
app/hotfix/demo/buff/BuffComponentSystem.ts# 添加、移除、传送、AOI事件
game_config/Datas/ItemConfig.xlsx          # 道具使用效果
game_config/Datas/BuffConfig.xlsx          # Buff生命周期和Action配置
game_config/Datas/SkillConfig.xlsx         # 技能时间线和目标关系
game_config/Datas/SkillEffectConfig.xlsx   # 服务端有序Action列表
```

Model只冻结字段和生命周期；Action解释、配置读取、Timer安排和业务规则都在Hotfix，所以调整回血数值或Tick行为不需要改Rust，也不需要新增一个`XxxActor`。

## 三、道具使用范例

业务代码不需要自己拼Buff字段，也不应该直接改HP：

```ts
const item = unit.GetComponent(ItemComponent).GetItem(itemId);
if (!item) throw new RpcError(GameErrCode.ItemNotFound, "item not found");

const config = GameConfigs.ItemConfig.Get(item.configId);
const cooldown = unit.GetComponent(SkillComponent).TryCommitItemCooldown(
  config.id,
  config.cooldownMs,
  config.globalCooldownMs,
);
if (!cooldown.accepted) throw new RpcError(GameErrCode.ItemCooldown, "item cooldown");
const action = config.useEffect === 1
  ? ActionFromConfig(ActionType.AddBuff, config.useParams)
  : ActionFromConfig(config.useParams[0], config.useParams.slice(1));

unit.GetComponent(ItemComponent).UseItem(itemId);
ExecuteAction(unit, action, { reason: "item-use" });
```

正式入口使用`app/hotfix/demo/mapHost/handlers/C2M_UseItemHandler.ts`，上面的片段只是说明调用关系。道具消耗是不可覆盖事实，使用后的HP/Numeric是可覆盖状态，Buff添加/删除是不可覆盖生命周期事件。

当前药品和技能共享玩家GCD；药品自身CD按`ItemConfigId`存储。Handler必须在扣除道具前通过`TryCommitItemCooldown`一次性完成检查和写入，不能拆成“先查、稍后再写”两个步骤。GCD和药品CD都会进入跨地图快照，客户端快捷栏只根据服务端返回的deadline绘制倒计时，不能作为权威判定。

## 四、Buff创建、Tick和移除

```ts
const buffs = player.GetComponent(BuffComponent);
const buff = buffs.AddBuff(2001);

// 2001由配置提供：持续30秒，每3秒执行一次 Heal(50)。
// BuffSystem会创建自己的到期Timer和Tick Timer。

buffs.RemoveBuff(buff.Id as bigint, "manual");
```

`AddBuff`可以用`BuffAddOptions`覆盖时长、Tick间隔或Action：

```ts
buffs.AddBuff(2001, {
  durationMs: 10_000,
  tickIntervalMs: 1_000,
  tickAction: { type: ActionType.Heal, parameters: [10n] },
});
```

覆盖值必须是纯数据，不能放闭包、Promise、TimerId或Entity引用。传送快照保存配置ID、层数、开始/结束时间、Tick时间、来源、冲突优先级、运行时Add/Tick/Remove Action及护盾剩余量；目标Process按纯值重建Timer和Combat修改器，不会重新执行普通AddAction。协议只携带Action类型和i64参数，绝不传Hotfix函数或对象引用。

### Buff冲突域与刷新

Buff的“不可叠加”必须拆成冲突域、冲突决策和刷新行为，不能只增加一个`unique`布尔值：

```text
stack_group + stack_scope + sourceUnitId -> 冲突键
conflict_policy                         -> Stack/Refresh/Replace/Reject/HigherWins
refresh_source/tick/runtime_state       -> 刷新哪些运行数据
```

`Target`作用域让任意来源共享一个实例，例如冰冷；`Source`把施法者放进冲突键，例如每名法师各自拥有一份灼烧。`HigherWins`显式比较`conflict_priority`：高值替换、相同值刷新、低值拒绝，不能拿ConfigId推断等级。Refresh只修改配置允许的数据，默认不重复执行AddAction；Replace必须先清理旧Buff注册的Modifier，再创建新Buff。Reject是正常业务结果，不应抛成未知服务器异常。

`BuffComponent.AddBuff`实现这些策略时必须保持同步且不在判断与提交之间`await`。同一Map V8内的目标状态因此能原子决策；真言术·盾还应在一个目标侧业务方法中完成“检查虚弱灵魂、替换盾、添加虚弱灵魂”，底层Shield唯一键和WeakSoul Reject作为第二层兜底。

## 五、和Combat的关系

受到伤害不能这样写：

```ts
// 错误：Combat入口反向寻找Buff，领域边界互相依赖。
target.GetComponent(BuffComponent).TryAbsorbDamage(damage);
```

正确做法是Buff在添加/移除阶段向Combat注册数据型修改器：

```text
Buff AddAction
  -> target.Combat.RegisterDamageAbsorber(amount, priority)
  -> Buff保存modifierId

受到伤害
  -> target.Combat.ApplyDamage(request)
  -> Combat按优先级消费modifierId对应的数据
  -> 剩余伤害扣CurrentHp

Buff RemoveAction
  -> target.Combat.RemoveDamageAbsorber(modifierId)
```

Combat不认识Buff；Buff也不保存一份会和Combat分叉的护盾剩余量。公开的Buff外观走`BuffAdded/BuffRemoved`和Unit Snapshot，受限的吸收量以后走明确的Detail Projection，不能用字段值`0`冒充没有权限。道具使用的RPC响应会额外回显本次给使用者新增的公开Buff，避免“Action已成功但客户端刚好错过事件”造成自己的HUD缺项；AOI事件仍然是其他观察者的广播来源。

### 客户端Buff图标与倒计时

Cocos3D Web的本地Buff栏只消费公开的`BuffPublicView`，不读取Buff内部Action或自定义状态：

```text
MapEntitySnapshot.buffs / M2C_UseItem.buff / G2C_BuffAdded
        -> BuffStateStore
        -> UI/Icons/Buff/<BuffId>
        -> 服务端结束时间 - 服务器时钟偏差
        -> MM:SS
G2C_BuffRemoved
        -> 删除图标
```

倒计时只显示分钟和秒，分钟可以超过99；例如两小时显示`120:00`。`expireTimeMs=0`表示无限时长，客户端显示`永久`。倒计时到`00:00`时只停止递减并保留图标，不能因为本地时钟到期就删除；只有收到`G2C_BuffRemoved`，或Unit因AOI离开整体移除时，才能清理对应表现。这样可以避免网络延迟、客户端与服务端时钟误差造成“图标先消失、服务器仍认为Buff存在”的状态分叉。

## 六、传送和销毁

- 传送只复制`BuffTransferState`，目标Unit先恢复`BuffComponent`，再由生命周期完成Timer重建。
- 运行时Action覆盖会随快照传输；护盾只按`damageAbsorberRemaining`恢复剩余吸收量，不会重新填满。
- 快照使用服务器墙钟时间，不保存TimerId；目标Process根据`expireAtMs/nextTickAtMs`判断剩余时间。
- 已经过期的Buff不在目标创建；未过期Buff不会重新执行AddAction，避免传送一次重复加血或重复注册护盾。
- `Unit.Dispose()`通过ChildEntity所有权链销毁Buff，Buff的RemoveAction只执行一次。RemoveAction必须幂等，不能假设Unit仍然连接客户端。
- Buff添加/移除由BuffComponent调用Map的公开事件；Buff自身不找Gate、不扫描AOI、不调用Location。

## 七、Action明确不拥有的内容

- Cast、技能目标选择、施法读条、打断、公共冷却和平A策略；这些属于SkillComponent。
- 跨Unit目标、范围伤害、队伍权限和复杂Action图。
- 生产级Buff持久化策略。当前传送快照已经支持生命周期恢复，但是否下线计时、是否写数据库要由后续持久化域设计决定。

当前SkillEffect已经复用Action执行器，但目标仍由SkillComponent解析。以后增加地面AOE或多目标时，也应先在技能领域得到明确目标列表，再逐个执行Action，不能把ActionExecutor变成一个知道所有游戏规则的巨型分支。

## 八、开发检查表

新增一个道具、Buff或技能效果时，按顺序检查：

1. 是否能用已有Action表达；能表达就只改Excel，不新写Handler分支。
2. 是否需要一个新的稳定ActionType；需要时先改Model枚举、配置校验和执行器，再生成代码。
3. HP/伤害是否经过Combat；不要在Action、Handler或Buff里直接写`CurrentHp`。
4. Buff是否需要AOI公开；公开外观走Map事件，私有数值另定义受众。
5. 是否需要跨地图；需要就确保状态是纯值、时间戳可恢复，不能传Timer或闭包。
6. 是否需要下线保存；这属于后续持久化策略，不要在Buff里直接连接Redis或数据库。

生成命令：

```powershell
npm run codegen:game-config
npm run codegen:proto
npm run codegen:scenes
npm run typecheck
npm run test:buff-action
```
