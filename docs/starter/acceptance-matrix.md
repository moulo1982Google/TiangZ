# Starter MMORPG 纵向切片验收矩阵

这份矩阵定义 TiangZ 的唯一 Starter MMORPG 业务样例。它不是商业游戏内容清单，而是用一条小而完整的业务链路证明框架可以被中小团队复制。

## 目标

Starter 只保留以下内容：

- 一个玩家职业；
- 一个主城、一个野外地图、一个动态副本；
- 三种普通怪、一个 Boss；
- 当前技能、Buff、道具、背包、掉落、任务和奖励能力；
- Cocos3D 作为完整演示客户端，其他客户端验证 SDK 兼容；
- all-in-one、split-process、断线重连、跨地图、重启恢复和热更回滚。

Starter 的完成标准不是“功能文件存在”，而是每一项都满足：

1. 使用正式 Stable API；
2. 有配置、协议或 `.native` 的正式来源；
3. all-in-one 与 split-process 的业务行为一致；
4. 有可重复的自测或运行时验收；
5. 没有把业务状态直接放进 Handler、Gate 缓存、Redis 客户端或 Rust Runtime 内部。

## 框架能力层

| 编号 | 能力 | 当前证据 | 状态 | 还需要的工作 |
| --- | --- | --- | --- | --- |
| FW-01 | 登录、LoginMgr、Login、Gate、Map | `docs/tutorials/01-architecture-and-quickstart.md`、`npm run test:runtime` | 已有 | 纳入 Starter 总验收 |
| FW-02 | all-in-one 与 split-process | `tools/smoke_runtime.mjs` | 已有 | 同一业务脚本跑两种部署 |
| FW-03 | Scene、Actor、Mailbox、Component、ChildEntity | `tools/actor_self_test.ts`、`docs/design/unit-actor-boundary.md` | 已有 | Starter 不得绕过 mailbox |
| FW-04 | AOI 与状态同步 | `tools/map_broadcast_self_test.ts`、Rust AOI | 已有 | 用 Starter 的怪物尸体和掉落拾取验收 |
| FW-05 | 3D 移动、寻路、动态障碍 | `docs/tutorials/13-navmesh3d.md`、Cocos3D/UE/Godot Demo | 已有 | 只补入 Starter 的地图流程 |
| FW-06 | 怪物、战斗、技能、Buff | `tools/combat_self_test.ts`、`tools/buff_action_self_test.ts` | 已有演示 | 补Boss规则和更复杂掉落 |
| FW-07 | 协议生成与多客户端 SDK | `client_sdk/`、各客户端 Demo | 已有 | Starter 只指定 Cocos3D 为完整 UI 客户端 |
| FW-08 | Hotfix、失败回滚 | `tools/hotfix_system_self_test.ts`、`tools/hotfix_reload_self_test.mjs` | 底层已有 | 补正式操作入口和 Starter 验收 |

## Starter 业务层

| 编号 | 业务链路 | 当前状态 | 完成条件 |
| --- | --- | --- | --- |
| ST-01 | 登录、创建角色、选择角色 | 已完成运行时链路：账号粘性登录、角色目录、创建角色、显式选角和 `characterId` 贯穿 Gate/Location/Map；`npm run starter:character-smoke` 已覆盖 all-in-one 与 split-process | 接入 DBProxy 后重启仍能列出同一角色；无 DBProxy 模式只保证进程生命周期内的目录一致性 |
| ST-02 | 进入主城 | MapHost 和玩家快照已有 | 新角色加载快照后进入主城，并收到完整初始状态 |
| ST-03 | 主城进入野外 | 跨地图和 MapInstance 路由已有 | 使用统一 `TransferToMap`，业务不区分静态地图和动态地图 |
| ST-04 | 野外战斗 | 怪物、普通攻击、技能和 Buff 已有 | 击杀普通怪、死亡、尸体和仇恨状态可重复验证 |
| ST-05 | 掉落、拾取、背包 | 已完成：`MonsterConfig -> DropTableConfig -> LootContainer -> C2M_LootMonster -> Inventory`；任务掉落按账号和剩余需求判定，普通掉落归第一次有效攻击者账号，DBProxy事务和operationId幂等已接通 | 击杀后尸体保留掉落；未接任务或需求已满时任务行留在尸体；有资格拾取后背包增加，重复请求不重复增加；无归属账号不能抢走普通掉落 |
| ST-06 | 任务接取、进度和奖励 | Starter第一版已在Map 100放置紫色任务NPC；玩家出生点靠近NPC，远端四角放置2个被动黄色怪和2个主动红色怪；靠近NPC 5米内显示交互按钮，按钮打开对话框后通过`C2M_AcceptQuest(questConfigId, npcUnitId)`接取，服务端校验5米范围；Quest状态、目标索引、条件和奖励已有；完成5005后可接取收集5个1101的5006 | PC与移动端都按“交互按钮 -> NPC对话 -> 接取任务”操作，击杀/拾取/使用道具推进、提交任务、领取奖励形成闭环；选中NPC或点击模型不能自动接取 |
| ST-07 | 动态副本与 Boss | 动态 MapHost/MapManager 已有；Starter Boss 流程尚未固定 | 请求幂等创建副本、进入、击杀 Boss、领取副本奖励、返回入口 |
| ST-08 | 断线重连和跨地图 | Gate 重连、Location、MapInstance 路由已有 | 断线宽限内恢复原 Unit；传送中请求有明确状态和幂等结果 |
| ST-09 | 重启恢复 | Player Snapshot、任务奖励和 UseItem 事务已有 | 重启后恢复背包、任务、Buff、技能冷却和安全位置；关键奖励不重复 |
| ST-10 | 在线热更和回滚 | Hotfix 事务底层已有 | 修改一个技能行为能切换；候选失败后旧行为继续服务，连接不丢失 |

## 运维与开发体验层

| 编号 | 能力 | 当前状态 | 完成条件 |
| --- | --- | --- | --- |
| OP-01 | 一键启动 | all-in-one、cluster 配置和 `npm run test:runtime` 已有 | 新机器按教程可启动完整 Starter，不手工改十几个文件 |
| OP-02 | 配置与代码生成 | Luban、Proto、Native codegen 已有 | 修改技能/道具/任务只改 Model、Hotfix 或配置源，再执行明确命令 |
| OP-03 | 日志、指标、健康检查 | Runtime 日志和 Prometheus/Grafana 已有 | Starter 能看到登录、进图、战斗、DBProxy和队列错误 |
| OP-04 | 故障恢复 | DBProxy `v0.5.0` 多Endpoint、双实例基础和多记录事务已接入；TiangZ端到端故障矩阵待补 | 明确区分可恢复快照、关键事务和临时运行态；连接中断、提交后丢响应和备用节点接管后有安全结果 |
| OP-05 | 真实业务压测 | 压测工具和历史基线已有 | 等 Starter 链路固定后，使用同一场景做无业务/完整业务 A/B |

## 标准演示脚本

```text
账号登录
  -> 创建或选择角色
  -> 进入主城
  -> 接取“清理野外怪物”任务
  -> 进入野外地图
  -> 接取5001并击杀怪物
  -> 回NPC交付5001，再接取5005
  -> 击杀怪物并拾取普通掉落
  -> 回NPC交付5005，再接取5006
  -> 拾取任务徽记，直到5个后再回NPC交付
  -> 使用恢复道具
  -> 提交任务并领取奖励
  -> 请求创建动态副本
  -> 进入副本并击杀Boss
  -> 领取副本奖励并返回主城
  -> 断线重连
  -> 重启服务
  -> 验证背包、任务、技能冷却和位置恢复
```

## 自动验收入口

| 命令 | 范围 | 数据影响 |
| --- | --- | --- |
| `npm run starter:verify` | 检查Starter目录、生成物和命令入口 | 无 |
| `npm run starter:acceptance` | all-in-one与split-process运行时、技能/Buff、创建角色/选角 | 无数据库写入 |
| `npm run starter:acceptance -- --mode all` | 只跑all-in-one运行时部分 | 无数据库写入 |
| `npm run starter:acceptance -- --mode split` | 只跑split-process运行时部分 | 无数据库写入 |
| `npm run starter:acceptance:persistent` | DBProxy快照写入、停止/重启TiangZ、恢复读取 | 写入带时间后缀的测试账号，不删除数据库 |
| `npm run starter:acceptance:faults` | 持久化恢复后运行独立DBProxy故障矩阵 | 可能重启本地Redis/PostgreSQL容器，只能用于测试环境 |

自动脚本的结果写入被Git忽略的`temp/test-logs/starter-acceptance-*.json`。三个Starter验收命令都会先执行`cargo build --bin TiangZ`，确保Rust配置解析器与当前源码一致。持久化命令不会自动启动Docker；它会复用7800端口已有的DBProxy，或使用`tools-projects/TiangZ-DBProxy/target/debug`中的Debug服务，并从独立仓库的`deploy/local/.env`读取连接参数。常规Starter验收不应连接外网数据库。

当前自动脚本明确不宣称完整任务/副本业务已通过：Map 100演示配置当前有3只A怪和2只B怪，带掉落尸体还按规则保留较长时间；“击杀5只A、回NPC交付、解锁B、拾取5个任务物品、进入动态副本击杀Boss并领取奖励”仍需Cocos3D客户端操作验收，后续再增加专用测试夹具。

## 验收分级

- `代码已有`：可以找到正式实现，但还没有证明完整链路。
- `自测通过`：有确定性工具测试，但未覆盖真实进程和客户端。
- `运行时通过`：all-in-one 或 split-process 实际跑通。
- `Starter通过`：两种部署、客户端操作、重连和重启恢复都跑通。
- `发布候选`：文档、日志、指标、失败路径和可复制部署全部齐全。

没有运行证据时，不把“代码已有”写成“功能完成”。

## 身份边界

- `account` 是登录和路由粘性的账号身份。LoginMgr 收到账号提示后，会用稳定哈希把同一账号分配到同一个 Login；空账号请求仍保留旧的轮询兼容行为。
- `characterId` 是角色的长期身份，也是角色目录、Player 快照、Location 和跨地图传送使用的持久键。创建角色后，客户端选角必须把它传给 `C2S_Login`。
- `unitId` 是当前进程/地图中的运行时 Unit 路由 ID。它可以在重建、迁移或重新进入地图时变化，不能写成角色的数据库主键。
- `mapInstanceId` 是地图实例身份；它描述角色当前进入哪个地图实例，不替代 `characterId`。

无 DBProxy 的本地 Demo 使用进程内角色目录，适合协议、路由和客户端链路验收；进程重启后的角色恢复属于 ST-09，必须使用 DBProxy 配置验证，不能把内存目录冒充持久化。
