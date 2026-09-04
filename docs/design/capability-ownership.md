# TiangZ 能力归属与领域拆分

更新时间：2026-08-13

本文回答一个容易混淆的问题：`app/core`、可复用领域能力和 MMORPG 示例分别应该放什么。它不是“把所有业务都做成框架”的计划，而是当前代码的所有权地图。

## 1. 三层边界

```text
① 框架运行时
   app/core + src
   Process / Scene / Actor / Component / mailbox / Transport / Hotfix屏障

② 可复用领域契约
   app/model/domains
   Numeric / Action / Reward / Item / Quest / Buff 的稳定状态形状

③ 具体游戏领域
   app/model/mmorpg + app/hotfix/mmorpg + src/game
   AOI / MapHost / NavMesh / Monster / NPC / 目标选择 / 配置和协议适配
```

| 层 | 当前目录 | 可以拥有 | 不应该拥有 |
|---|---|---|---|
| 框架运行时 | `app/core/`、`src/` | 生命周期、mailbox、路由、传输、宿主、热更和Native Store | AOI、地图、怪物、任务、技能、战斗规则 |
| 可复用领域契约 | `app/model/domains/` | 跨游戏稳定的数据结构、Component容器、ChildEntity形状、Action数据 | Luban配置、具体协议、Map、PlayerUnit、Gate、Native游戏句柄 |
| MMORPG领域 | `app/model/mmorpg/`、`app/hotfix/mmorpg/`、`src/game/` | 地图、AOI、移动、NavMesh、刷怪、仇恨、NPC、目标选择、协议投影和配置适配 | 运行时底座和第二套“万能”框架入口 |

“准框架”不是 Core。它是已经被多个游戏形态验证后，才可能复用的业务模式；当前只冻结契约，不提前承诺第二个游戏一定能直接复用全部执行代码。

外置模块是横跨②/③的打包方式，不是第四层：Core可以拥有模块发现、依赖图、独立类型检查、Model导出桥、强类型Entity装配、Hotfix组合和兼容指纹，但模块内的Scene、Component、Handler和规则仍按本表归属。具体游戏模块不得因为由Core装载就变成Core代码，详见[外置游戏模块](external-game-modules.md)。

模块自有技能通过MMORPG层的`SkillDefinitionProfileComponent`进入现有技能状态机：注册表只保存地图级只读定义并拒绝覆盖，施法、伤害、死亡和刷新仍由TiangZ领域组件负责。具体职业、技能ID、数值和客户端动作栏属于模块；该组件不是Core，也不是让协议网关自行结算伤害的后门。

`SkillComponent`还保存中立的已学技能ID与`proficiencyId/rank/maximumRank`轨道，供通用训练师、采集交互、持久化和跨地图迁移复用。Core只保证单调授予、前置检查与事务恢复；“草药学”“采矿”、具体SkillLine编号、训练法术和客户端字段仍属于外置模块/协议网关，不能写进TiangZ Core。

模块批量地图内容通过MMORPG层的`MonsterContentProfileComponent`进入现有刷怪运行时：目录只原子保存中立模板与稳定刷点并在地图发布前冻结，`MonsterComponent`继续拥有Unit、AOI、战斗、尸体和重生。具体来源数据库、表结构、坐标转换、地图编号和内容指纹属于模块；不得把外部世界库schema或生成行放入Core。

## 2. 当前文件归属

### ① 框架运行时

这里的代码由框架维护者负责，业务开发者通常只通过 Stable API 使用：

- `app/core/runtime`：Entity、Component、Scene、Session、Unit和生命周期。
- `app/core/process`：EntryScene、协议注册、Scene mailbox和本地/远程调用。
- `app/core/broadcast`、`app/core/persistence`：通用广播和DBProxy边界。
- `src/`：Rust Host、Transport、Native Store、背压、健康检查和Inspector。

业务不能因为某个 MMORPG 需求方便，就把 `MonsterComponent`、`Buff` 或 `MapAoiComponent` 加进这里。

### ② 可复用领域契约

当前已经拆出的稳定 Model 契约如下：

| 能力 | 稳定入口 | 当前职责 |
|---|---|---|
| Numeric | `app/model/domains/numeric/` | `NumericType -> i64/bigint`、派生数值规则和组件容器 |
| Action | `app/model/domains/action/ActionDefinition.ts` | 有序原子效果的数据定义，不选择目标、不执行网络操作 |
| Reward | `app/model/domains/reward/RewardPlan.ts` | 一组Action和可选幂等键，不持有玩家或数据库连接 |
| Item | `app/model/domains/item/` | Item ChildEntity、背包集合的稳定状态形状 |
| Quest | `app/model/domains/quest/` | Quest ChildEntity、活动任务和完成记录的容器 |
| Buff | `app/model/domains/buff/` | Buff ChildEntity、生命周期数据和集合容器 |
| Combat | `app/model/mmorpg/combat/` | 当前MMORPG的伤害、治疗、护盾和普通攻击状态；尚未冻结为跨游戏契约 |
| Skill | `app/model/mmorpg/skill/` | 当前MMORPG的读条、引导、CD和技能效果；尚未冻结为跨游戏契约 |

这些目录只能依赖 `app/core/public.ts` 和同一 `domains` 层。它们不能依赖 `app/model/mmorpg`、生成协议、Luban配置或某个游戏的Native句柄。当前 Combat/Skill 的执行状态仍与MMORPG的伤害学校、平A、施法和引导语义绑定，因此保留在 `mmorpg`，不为了目录对称制造一份“类型影子”。`npm run verify:domain-boundaries` 会检查这条规则。

### ③ MMORPG 适配层

`app/model/mmorpg/`保留当前游戏的稳定适配：

- `map/`、`mapHost/`、`mapManager/`、`location/`、`movement/`：地图、AOI、传送和NavMesh。
- `monster/`、`npc/`：刷怪、仇恨、NPC交互、Monster/NPC Unit与模块怪物内容目录。
- `gate/`、`scenes/`、`broadcast/`：当前服务拓扑和地图客户端路由。
- `persistence/`、`native/`：当前Player快照、协议投影和MMORPG Native facade。
- `skill/SkillMapComponent`、`skill/SkillDefinitionProfileComponent`、`numeric/MovementNumeric`：地图调度、模块技能资料边界和移动单位适配。

`app/hotfix/mmorpg/`保留当前游戏的可热更执行器、Handler和配置适配。例如 `ActionExecutor`、`RewardExecutor`、`SkillMapComponentSystem` 仍然会读取 MMORPG 的 `ActionType`、生成配置、Combat/PlayerUnit和地图目标。它们不能为了“看起来通用”搬进 Core。

## 3. Numeric 的空间同步拆分

Numeric 本身是通用字典，不应认识地图坐标或 AOI：

```text
app/model/domains/numeric/NumericType.ts
  CurrentHp / MaxHp / Attack / AttackSpeed / Level ...

app/model/mmorpg/numeric/MovementNumeric.ts
  MoveSpeed / 米每秒 -> Rust Numeric 的毫米每秒换算

app/hotfix/mmorpg/numeric/NumericComponentSystem.ts
  Rust getter/setter、脏标记、MoveSpeed写入后同步 Position

app/model/mmorpg/numeric/NumericRegenerationComponent.ts
app/hotfix/mmorpg/numeric/NumericRegenerationComponentSystem.ts
  任意当前值/上限字段的固定量或 Numeric 动态量脉冲恢复运行态，不包含具体资源语义或公式

app/model/mmorpg/movement/DirectionalMovementProfileComponent.ts
  PlayerUnit拥有的前进/后退/横移服务端倍率；不保存按键，也不接受客户端速度
```

`MoveSpeed` 仍可以在 MMORPG 代码中使用，但它是游戏单位和移动规则，不是通用 Numeric 字段。新增卡牌或模拟经营领域时，可以有完全不同的“行动点/生产速度”，而不必继承地图移动语义。

`C2M_NavigateInput`只提交离散方向和朝向。`PlayerUnitSystem`以最终`MoveSpeed`为基础，通过`DirectionalMovementProfileComponent`选择当前方向的有效速度，再交给Rust权威推进。默认倍率全部为1，现有游戏行为不变；外置游戏模块可以在Entity发布前配置倍率，但不能让客户端提交速度、在gateway节流模拟速度，或把某个游戏的常量写进Core。

服务端AI在Grid2D上追击、巡逻或游荡时使用`NativeData.SetGridMovementTarget`提交最终Cell，而不是反复模拟玩家按住方向键。最终目标和逐Cell推进状态归Rust Unit所有，Rust在同一固定更新中连续开始下一格并在目标格精确清除输入；怪物、NPC和召唤物只决定目标，不按AI判定频率猜测停止时刻。该能力属于MMORPG Native移动层，不进入`app/core`，也不包含任何具体游戏的地图坐标或移动协议。

唯一例外是地图资料显式启用的`externalMovementSnapshots`兼容模式：它用于接入已经完成同源场景碰撞的既有协议客户端，只在Grid2D上接受有最大位移上限的位置快照。PlayerUnit和Rust仍重复校验序号、边界与数值，网关不能提交速度；未启用地图与NavMesh3D一律拒绝。该能力属于MMORPG地图适配，不进入`app/core`，具体坐标原点、阈值与客户端协议仍由外置游戏模块拥有。

派生数值仍沿用 `result * 10 + 1/+2/+3` 的 Base/Add/Pct约定；这属于 Numeric 的稳定计算规则。具体哪个配置字段代表移动速度，由领域适配器决定。

## 4. ActionDefinition + RewardPlan 试点

共享层只描述纯数据：

```ts
import {
  ActionType,
  type ActionDefinition,
  type RewardPlan,
} from "#tiangz/model";

const reward: RewardPlan = {
  operationId: "quest:5001:character:1001",
  actions: [
    {
      type: ActionType.GrantItem,
      parameters: [1101n, 5n],
    },
  ],
};
```

`ActionType` 是 MMORPG 配置枚举的适配器；`ActionDefinition` 和 `RewardPlan` 不依赖它。执行仍在 `app/hotfix/mmorpg/action/ActionExecutor.ts` 和 `reward/RewardExecutor.ts`，因为执行时必须知道当前游戏的 Combat、Buff、Inventory、PlayerPersistence 和协议结果。

当前 `RewardDefinition` 是 `RewardPlan` 的兼容类型别名。旧任务/掉落代码可以继续使用原名称，新模块优先使用 `RewardPlan`。关键奖励仍须走：

```text
RewardPlan
 -> PlanTransactionalReward
 -> ItemComponent.PlanGrantItems
 -> DBProxy ApplyTransaction
 -> CommitGrantPlan
 -> 广播结果
```

规划阶段不得修改 Entity；数据库确认前不能给客户端成功响应。未来第二个游戏只要复用纯 Action/Reward 数据，不需要复制一套奖励计划结构；执行器是否能共享，必须由第二个游戏的真实需求决定。

## 5. Item、Quest、Buff、Combat、Skill 的拆分规则

本轮拆的是稳定状态和契约，不是假装所有运行逻辑已经与 MMORPG 无关：

- Item：`domains/item` 负责 Item ChildEntity 和集合容器；`mmorpg/item` 负责 `ItemSnapshot`、Luban ItemConfig、NativeItemRef、使用道具和持久化。
- Quest：`domains/quest` 负责活动 Quest 和完成记录容器；`mmorpg/quest` 负责 NPC、QuestConfig、目标索引、任务奖励和网络协议。
- Buff：`domains/buff` 负责 Buff 生命周期数据和集合契约；`mmorpg/buff` 负责 BuffConfig、冲突策略、Timer、Action和AOI投影。模块定义可携带不透明正整数效果标签，MMORPG执行器只提供按任一标签批量移除，不解释“眩晕”“诱捕”等游戏语义。
- Combat：当前完整实现位于 `mmorpg/combat`，负责伤害/治疗/护盾、普通攻击、Numeric和死亡表现。只有第二个真实领域证明同一状态形状后，才抽取无MMORPG语义的契约。
- Skill：当前完整实现位于 `mmorpg/skill`，负责Cast/CD/Channel、SkillConfig、目标距离、地图调度、弹道、命中和技能快捷栏协议；删除了未被运行时使用的 `domains/skill` 影子。

Handler 仍然保持：

```text
协议 Handler
  -> PlayerUnit / MapScene 的领域方法
    -> domains Component 的稳定状态
      -> mmorpg 适配器执行配置、协议和广播
```

不要在 `domains` 中加入 `MapComponent`、`PlayerUnit`、`GameConfigs`、`ItemSnapshot` 或 `NativeUnitRef`。如果第二个游戏出现，再从两套适配器中抽取已经重复且语义稳定的执行规则。

## 6. demo 重命名与兼容边界

服务端业务目录已经统一为：

```text
app/model/mmorpg/
app/hotfix/mmorpg/
native_data/mmorpg/
```

`native_data/mmorpg/*.native` 中的 `namespace demo` 和 `namespace native` 暂时保持不变：它们是持久化 schema/Native ABI 标识，不是目录名。修改这些 namespace 需要单独做 schema 迁移和兼容验收，不能作为目录整理的一部分。

可交互物的通用所有权止于实体/AOI生命周期、可用性、使用距离、通用熟练度与奖励事务。无持久化副作用的模块动作通过正整数 `interactionActionId` 和 `InteractableEvents.ActionRequested` 扩展；Core 不解释动作语义。来源对象类型、槽位几何、动画状态和协议封包属于游戏模块/适配器，模块发起权威位移时复用 `MapComponent.RelocateUnit`。

地图内任意 Unit 对 PlayerUnit 造成伤害时，统一调用 MMORPG 层的 `MapComponent.ApplyDamageToPlayer`。该入口验证双方仍属于当前地图，以真实来源 UnitId 执行 Combat 结算，并统一完成私有战斗结果、施法受击处理、死亡清战斗状态及配置化耐久损耗。Monster/NPC 可以在调用前维护各自仇恨，环境机关或外置模块则不必伪造成怪物。具体陷阱、火焰、法术号、伤害骰和触发半径仍属于外置游戏配置。

MMORPG Numeric 必须维持“当前生命/资源不高于派生上限”的通用不变量。写入 `MaxHpBase/Add/Pct` 或 `MaxMpBase/Add/Pct` 后，运行时只在当前值超过新上限时向下夹紧；提高上限不会自动治疗或补充资源。Buff 的属性公式和具体增减值仍由外置游戏配置，Core 不解释耐力、智力或任何来源法术。

生成协议仍保留 `app/generated/model/server/demo`、`client_sdk/.../Model/demo` 等路径。这些是已经生成并可能被外部客户端引用的线协议命名空间，重命名它们会变成协议/SDK兼容性变更，不属于本次领域目录整理。新的游戏协议应使用自己的协议命名空间和锁文件，不要把 MMORPG 的 `demo` 线协议复制成 Core API。

## 7. 新领域的落地顺序

新增 Card、SLG 或 Simulation 领域时：

1. 先在自己的 `app/model/<game>` 和 `app/hotfix/<game>` 中实现完整最小链路。
2. 只从 `app/model/domains` 读取通用契约，不反向依赖 `mmorpg`。
3. 两个领域都真实使用后，比较状态、失败语义、事务和测试，而不是按文件名猜通用性。
4. 抽取第二个领域确实重复的执行规则，并补 Stable API、门禁和自测。
5. 不为了通用性提前增加 `GameManager`、万能 `EntityData` 或无类型 `extensions`。

验证命令：

```powershell
npm run codegen:native-data
npm run codegen:scenes
npm run typecheck
npm run verify:domain-boundaries
```

本轮目录拆分不需要压力测试；涉及吞吐的执行器共享或 Rust 下沉，另行建立基线后再测。
