# Starter MMORPG：从登录到副本恢复

Starter 是 TiangZ 的唯一完整业务样例。它用少量地图、怪物和技能串起框架能力，方便新团队照着扩展。

## 先启动

```powershell
cd E:\gitee\TiangZ
npm install
npm run starter:dev
```

`starter:dev`会生成调试Bundle并启动all-in-one。只做静态完整性检查时运行：

```powershell
npm run starter:verify
```

另开终端运行完整进程冒烟，验证all-in-one和split-process：

```powershell
npm run starter:smoke
```

这个命令会分别验证 all-in-one 和 split-process。业务代码不应该根据部署模式写两套分支。

只验证创建角色、选角和稳定身份贯穿两种部署时运行：

```powershell
npm run starter:character-smoke
```

这个命令会创建一个角色，使用返回的 `characterId` 登录并进入地图，然后分别在 all-in-one 和 split-process 中重复验证。它不做长时间压测。

## 一条命令验收

完成代码生成后，可以运行不接触数据库的完整Starter验收：

```powershell
npm run starter:acceptance
```

它会先重建Debug Rust runtime，再依次覆盖运行时登录/进图/战斗链路、技能与Buff、创建角色和选角，并把结果写入`temp/test-logs/starter-acceptance-*.json`。默认会验证all-in-one和split-process；只跑其中一种运行时时可以使用：

```powershell
node tools/starter_acceptance.mjs --mode all
node tools/starter_acceptance.mjs --mode split
```

需要验证真实 DBProxy 恢复时，先按[DBProxy玩家快照持久化](19-dbproxy-player-persistence.md)启动本地 PostgreSQL、Redis 和 DBProxy，再运行：

```powershell
npm run starter:acceptance:persistent
```

该命令会生成带时间后缀的测试账号，执行“进入地图 -> 使用道具 -> Gate最终下线保存 -> 停止并重启TiangZ -> 重新读取快照”，不会删除数据库，也不会启动Docker。它要求DBProxy仓库已经存在本地`.env`和可运行的Debug二进制；若7800端口已有DBProxy，则直接复用。

故障矩阵是单独的破坏性测试入口：

```powershell
npm run starter:acceptance:faults
```

它会调用独立仓库的`tools/fault_matrix.ps1`，可能重启本地Redis/PostgreSQL容器，只能在测试环境运行。当前命令已经把故障验证接入Starter验收，但还没有把“击杀5只A -> 交付 -> 击杀5只B -> 任务掉落5个 -> 动态副本Boss奖励”做成无人工客户端夹具；Map 100当前只有3只A和2只B，且带掉落尸体按设计保留较长时间，所以这部分仍属于客户端验收项，不在自动脚本中冒充已完成。

## 业务入口在哪里

Starter 的稳定状态位于 `app/model/mmorpg`，可热更行为位于 `app/hotfix/mmorpg`：

```text
app/model/mmorpg/
  scenes/       Gate、MapHost、MapManager
  map/          地图和玩家进入、传送、生命周期
  monster/      Monster Unit 和地图刷怪状态
  npc/          NPC Unit、Starter任务使者和交互校验
  skill/        Skill 状态与稳定定义
  buff/         Buff 状态和生命周期
  item/         Item、Inventory 和道具状态
  quest/        Quest 状态、目标索引和任务快照
  persistence/  Player Snapshot 与 DBProxy边界

app/hotfix/mmorpg/
  mapHost/handlers/  网络协议薄适配
  monster/           怪物行为和受击规则
  skill/             技能执行、Action和命中效果
  quest/             任务条件、进度和奖励编排
  reward/            奖励计划与提交后的领域通知
```

Handler只负责把协议转换成领域调用。状态、验证、持久化和广播分别由拥有它们的 Component 或 Scene 负责。

## 从NPC接取第一个任务

Starter第一版在3D地图100的玩家出生点附近创建一个紫色方块任务使者。Map 100 的演示布局是固定的：

- 玩家出生点为 `(-3, 1, -18)`；NPC 位于出生点东侧约3米。
- Map 100 使用 Demo 专用宽视野配置`AoiConfig=2`：7×7 Grid为Enter范围，9×9 Grid为Detach迟滞范围，出生点可以观察到远端刷怪区。
- `10004`、`10005`、`10008` 是三只被动怪，位于地图远端刷怪区，客户端显示黄色。
- `10006`、`10007` 是两只主动怪，位于另一组远端刷怪区，客户端显示红色。
- NPC和怪物仍是普通地图Unit，位置和颜色是演示配置/表现，不改变服务端的Unit、AOI和Combat边界。

NPC交互遵循“按钮 -> 对话框 -> 接取”三步：

- `NpcUnit`是普通地图Unit，没有mailbox，也没有玩家账号；`NpcComponent`只维护本地图NPC索引。
- NPC以Subject加入AOI，所以玩家进入地图快照时能看到它；客户端不维护NPC全量列表，只处理已经进入AOI的实体。
- Starter当前所有QuestConfig都关闭自动接取，玩家出生时没有默认任务；任务必须由NPC或其他明确的剧情业务入口发起。
- Cocos3D在玩家距离NPC不超过5米时显示“交互：任务使者”按钮；桌面端和移动端都点击这个按钮打开对话框。
- 对话框显示NPC文字和任务按钮，点击“接取任务”才发送请求；桌面端`F`只是这个按钮的快捷键。选中NPC、点击NPC模型或打开对话框都不会自动接取任务。
- 服务端在有序PlayerUnit mailbox中检查NPC仍存在、NPC提供目标任务且玩家距离不超过5米，检查通过后调用`QuestComponent.AcceptQuest(questConfigId)`；接取5001后需要击败5只怪A。目标达成只进入`ReadyToTurnIn`，玩家必须回到NPC处交付5001，完成事务后才会解锁配置了`required_quest_ids=[5001]`的5005，继续击败5只怪B。

业务代码的核心调用形态如下，`npcUnitId`必须来自当前AOI快照：

```ts
const npc = visibleEntities.find((entity) => entity.entityType === 3);
if (!npc) throw new Error("任务使者不在当前视野");

// 这是对话框“接取任务”按钮的调用，不是点击NPC模型后的自动行为。
// This is the dialog's accept button action, not an automatic result of clicking the NPC model.
await mapClient.acceptQuest({
  questConfigId: 5001,
  npcUnitId: npc.unitId,
});

// 目标完成后仍需回到NPC交付，不能从任务追踪面板直接领奖。
// A ready quest must still be turned in near the NPC.
await mapClient.completeQuest({
  questConfigId: 5001,
  npcUnitId: npc.unitId,
});
```

不要在客户端直接把任务写入本地列表，也不要在Handler里复制距离判断。任务状态归`QuestComponent`，NPC的运行时地址只用于本次交互；NPC离开AOI、地图销毁或Unit重建都不应删除已接取任务。移动端的交互按钮必须使用客户端HUD的事件隔离方式，不能让点击按钮穿透成地面寻路。

## 任务物品与尸体拾取

Starter用任务5006演示“任务资格决定拾取资格”，它位于任务链5005之后：完成并交付5005后，再次和NPC对话接取5006，目标是收集5个怪物徽记。怪物A的`MonsterConfig.drop_table_id`指向掉落表，其中`quest_objective_id=5106`的行是任务掉落。

流程不是“击杀后立刻给所有人发道具”，而是：

```text
击杀怪物
  -> 尸体保存掉落配置ID和数量
  -> 玩家选中尸体并靠近
  -> C2M_LootMonster(monsterId, operationId)
  -> 服务端检查已接任务和剩余需求
  -> Inventory/Quest纯数据规划
  -> DBProxy事务提交
  -> 提交成功后生成Item、推进Quest、私有推送结果
```

业务代码只提交“拾取哪具尸体”，不能在客户端或Handler里判断任务数量：

```ts
const result = await mapClient.lootMonster({
  monsterId: corpseUnitId,
  operationId: CreateOperationId("loot"),
});
for (const item of result.items) applyItemChanged(item);
applyQuestSnapshots(result.quests);
```

任务掉落行只对已经接取且仍有剩余数量的`CollectItem`任务可见。没有接任务、已经达到要求数量、或同一账号已经拾取过该行时，服务端返回“没有可拾取掉落”，但不删除尸体上的任务掉落；其他有资格的玩家仍可拾取。普通掉落在本Demo中归第一次有效攻击者账号，任务掉落按账号记录领取状态。Cocos3D中选中死亡怪物后会显示尸体状态和拾取按钮，按钮距离、资格、幂等和持久化仍以服务端为准。

本例的1101是静态任务道具，因此尸体只保存配置ID和数量，永久ItemId在拾取事务确认后生成。带随机词条、耐久或绑定状态的动态道具必须改用ItemInstance数据，不能把它们错误地压缩成一个静态配置ID。

## Cocos3D背包入口

Cocos3D的背包是服务端库存快照的展示层，不是第二份客户端背包。进入地图、重连或再次进图时读取`G2C_EnterMap.items`全量快照，运行期间接受`G2C_ItemChanged`增量；拾取RPC只返回本次受影响的`items`，客户端按`ItemSnapshot.version`合并RPC和Push的重复结果。每个格子按`ItemSnapshot.itemId`展示实例数量，并从客户端`ItemConfig`读取名称、说明和图标。数量为0的实例从界面移除，但客户端不会自行创建、删除或预扣道具。

- 桌面端点击右侧“背包”或按`B`打开，移动端点击右侧“包”按钮打开。
- `useEffect != 0`的道具显示“使用”按钮；任务道具等不可使用道具仍显示数量和说明，但不会伪造使用入口。
- 背包和快捷栏都调用同一个`MapClient.useItem({ itemId, operationId })`，冷却、公共CD、幂等和最终数量仍由服务端决定。
- 面板本身会拦截触摸和点击，不会穿透到全屏镜头层触发地面寻路；关闭按钮或点击遮罩可以关闭面板。

业务客户端需要复用这条边界：UI可以缓存和排序`ItemSnapshot`，但不能把点击按钮直接变成`item.count -= 1`，也不能绕过`operationId`自行广播使用结果。

## 角色目录与选角

Starter 把账号和角色拆成两个身份：`account` 只负责登录与路由粘性，`characterId` 才是角色数据、Location、跨地图和持久化的稳定键。`unitId` 只是当前地图里的运行时实体 ID，不能保存到角色表，也不能作为重连后的角色主键。

客户端 SDK 的最小用法是：

```ts
const created = await flow.createCharacter(account, "法师一号", 1);
await flow.enterGame(
  account,
  1,
  () => {},
  created.character.characterId,
);
```

如果已有角色目录，先从 `S2C_Login.characters` 选择一个 `characterId`，再把它放进 `C2S_Login`。不传时，Demo 为兼容旧客户端选择目录中的第一个角色；新业务界面应明确让玩家选择，不要依赖默认顺序。

角色目录由 `app/model/mmorpg/login/CharacterRepository.ts` 管理。配置了 DBProxy 时，它使用版本号和幂等重试保存；没有 DBProxy 时使用进程内目录，只能证明登录、创建、选角和路由链路，重启后恢复必须使用 DBProxy 验收。跨 MapHost 传送时，业务仍只携带 `characterId` 和传送快照，目标地图会接管运行时 `unitId`，不需要为静态地图和动态副本写两套角色代码。

## 推荐的开发顺序

1. 在 `game_config/` 修改技能、怪物、道具或任务数据；表结构变化需要完整生成和重启。
2. 在 `app/model/mmorpg/` 增加稳定状态、组件和协议需要的类型。
3. 在 `app/hotfix/mmorpg/` 增加可以热更的规则、Handler和事件处理。
4. 修改 `proto/` 后执行协议生成；不要手改 `app/generated` 或客户端 Generated 文件。
5. 执行对应的确定性自测，再跑 `npm run test:runtime`。
6. 使用 Cocos3D 操作 Starter 主链，最后做重启恢复和重复请求验收。

## 业务边界

- 玩家、怪物、Item、Buff、Quest仍由Unit/Component/ChildEntity拥有。
- 关键奖励、背包扣除和道具使用，必须先由领域生成纯数据计划，再通过DBProxy确认，不能先改内存再保存。
- 普通快照允许合并保存；关键事务必须携带稳定 `operationId`，重试返回首次结果。
- `instanceId`、Session、Timer、AOI关系和移动意图属于运行态，不写进普通玩家快照。
- 动态地图和静态地图都调用同一套 `TransferToMap` 语义；业务只决定 `MapInstanceId`，不根据部署模式分叉。
- Cocos3D是完整演示客户端；Unity、UE、Godot和Pixi主要验证SDK与协议兼容，不复制服务端权威逻辑。

## 纵向切片验收

按[Starter MMORPG验收矩阵](../starter/acceptance-matrix.md)执行。最小闭环必须包含：

```text
登录 -> 选角 -> 主城 -> 野外 -> 战斗 -> 掉落 -> 背包
  -> 任务 -> 动态副本 -> Boss -> 重连 -> 重启恢复
```

新增功能如果不能在这条链路中找到状态所有者、协议入口、持久化语义和验收命令，不应直接添加到 Starter。
