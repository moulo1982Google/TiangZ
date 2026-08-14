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
- `monster/`、`npc/`：刷怪、仇恨、NPC交互和Monster/NPC Unit。
- `gate/`、`scenes/`、`broadcast/`：当前服务拓扑和地图客户端路由。
- `persistence/`、`native/`：当前Player快照、协议投影和MMORPG Native facade。
- `skill/SkillMapComponent`、`numeric/MovementNumeric`：地图调度和移动单位适配。

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
```

`MoveSpeed` 仍可以在 MMORPG 代码中使用，但它是游戏单位和移动规则，不是通用 Numeric 字段。新增卡牌或模拟经营领域时，可以有完全不同的“行动点/生产速度”，而不必继承地图移动语义。

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
- Buff：`domains/buff` 负责 Buff 生命周期数据；`mmorpg/buff` 负责 BuffConfig、冲突策略、Timer、Action和AOI投影。
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
