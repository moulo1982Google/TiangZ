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
| FW-06 | 怪物、战斗、技能、Buff | `tools/combat_self_test.ts`、`tools/buff_action_self_test.ts`、动态Boss运行时夹具 | 已有演示 | Boss已复用正式Combat、死亡事件和尸体掉落；复杂阶段留后续 |
| FW-07 | 协议生成与多客户端 SDK | `client_sdk/`、各客户端 Demo | 已有 | Starter 只指定 Cocos3D 为完整 UI 客户端 |
| FW-08 | Hotfix、失败回滚 | `tools/hotfix_system_self_test.ts`、`tools/hotfix_reload_self_test.mjs` | 底层已有 | 补正式操作入口和 Starter 验收 |

## Starter 业务层

| 编号 | 业务链路 | 当前状态 | 完成条件 |
| --- | --- | --- | --- |
| ST-01 | 登录、创建角色、选择角色 | 已完成运行时链路：账号粘性登录、角色目录、创建角色、显式选角和 `characterId` 贯穿 Gate/Location/Map；`npm run starter:character-smoke` 已覆盖 all-in-one 与 split-process | 接入 DBProxy 后重启仍能列出同一角色；无 DBProxy 模式只保证进程生命周期内的目录一致性 |
| ST-02 | 进入主城 | MapHost 和玩家快照已有 | 新角色加载快照后进入主城，并收到完整初始状态 |
| ST-03 | 主城进入野外 | 跨地图和 MapInstance 路由已有 | 使用统一 `TransferToMap`，业务不区分静态地图和动态地图 |
| ST-04 | 野外战斗 | 已完成：怪物、普通攻击、技能和Buff已有；刷怪槽与尸体生命周期分离，旧尸体保留拾取窗口时同槽可以按`respawn_seconds`生成新怪 | `starter:acceptance`在all-in-one与split-process中各自通过正常导航和攻击连续击杀15只任务怪，验证死亡、尸体、重生和仇恨链路 |
| ST-05 | 掉落、拾取、背包 | 已完成：`MonsterConfig -> DropTableConfig -> LootContainer -> C2M_LootMonster -> Inventory`；任务掉落按账号和剩余需求判定，普通掉落归第一次有效攻击者账号，DBProxy事务和operationId幂等已接通 | 击杀后尸体保留掉落；未接任务或需求已满时任务行留在尸体；有资格拾取后背包增加，重复请求不重复增加；无归属账号不能抢走普通掉落 |
| ST-06 | 任务接取、进度和奖励 | 已完成：Map 100放置任务NPC，远端放置3只被动怪A和2只主动怪B；5001击杀5只A，交付后解锁5005击杀5只B，再交付解锁5006收集5个徽记；接取、进度、前置、事务奖励和跨图快照已有 | `starter:acceptance`在两种部署中通过正常NPC RPC、攻击、查看/单项拾取和跨图恢复完成整条任务链；PC与移动端继续验收对话和HUD交互不穿透 |
| ST-07 | 动态副本与 Boss | 已完成：Map 200由Gate通过MapManager幂等创建；Boss 3复用正式Monster/Combat，死亡后提交120经验，尸体固定掉落三种药水各5个和150铜币；每个角色有持久化10分钟进入CD；Cocos3D按钮显示倒计时 | `starter:acceptance`自动击杀、查看并拾取四行奖励，断言Level 2/Experience 120、背包/金币与CD拒绝；客户端验证倒计时和地图切换 |
| ST-08 | 断线重连和跨地图 | Gate 重连、Location、MapInstance 路由已有 | 断线宽限内恢复原 Unit；传送中请求有明确状态和幂等结果 |
| ST-09 | 重启恢复 | 五领域快照、关键事务和静态MapHost有界重启已有；Boss经验与个人CD走progression，尸体领取走inventory/quest/wallet事务 | `starter:acceptance:persistent`重启后断言等级经验、三种药水、150铜币与CD仍在且不重复；动态副本战斗现场不恢复 |
| ST-10 | 在线热更和回滚 | Hotfix 事务底层已有 | 修改一个技能行为能切换；候选失败后旧行为继续服务，连接不丢失 |
| ST-11 | 同地图玩家交易 | 已完成MapScene临时会话、双方报价/确认、DBProxy双记录原子提交和Cocos3D交易面板；`npm run test:player-trade`覆盖幂等与Revision冲突 | 两个真实客户端同图5米内交换铜币和物品；重复确认不重复转移，任一Revision冲突时双方都不改变 |

## 运维与开发体验层

| 编号 | 能力 | 当前状态 | 完成条件 |
| --- | --- | --- | --- |
| OP-01 | 一键启动 | all-in-one、cluster 配置和 `npm run test:runtime` 已有 | 新机器按教程可启动完整 Starter，不手工改十几个文件 |
| OP-02 | 配置与代码生成 | Luban、Proto、Native codegen 已有 | 修改技能/道具/任务只改 Model、Hotfix 或配置源，再执行明确命令 |
| OP-03 | 日志、指标、健康检查 | Runtime 日志和 Prometheus/Grafana 已有 | Starter 能看到登录、进图、战斗、DBProxy和队列错误 |
| OP-04 | 故障恢复 | DBProxy `v0.5.0` 多Endpoint、双实例、多记录事务和 TiangZ 端到端故障矩阵已接入 | 明确区分可恢复快照、关键事务和临时运行态；连接中断、提交后丢响应、双Endpoint全不可用和备用节点接管后有安全结果 |
| OP-05 | 真实业务压测 | 已完成首轮真实业务 A/B：Node 全链路覆盖 50/100/200 玩家 all/split；Rust 容量组覆盖 1000/2000/3000 玩家，并对 1000 玩家业务做三轮复核；报告见[OP-05压测报告](op05-real-business-load.md) | 当前保守有效点为 1000 个均匀分布玩家；2000 需先处理 Probe 尾延迟和 Map frame/completion 背压；DBProxy 事务压力另行验收 |

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
| `npm run starter:acceptance` | all-in-one与split-process运行时、完整5001/5005/5006任务链、技能/Buff、动态副本/Boss、创建角色/选角 | 无数据库写入 |
| `npm run starter:acceptance -- --mode all` | 只跑all-in-one运行时部分 | 无数据库写入 |
| `npm run starter:acceptance -- --mode split` | 只跑split-process运行时部分 | 无数据库写入 |
| `npm run starter:acceptance:persistent` | DBProxy快照写入、停止/重启TiangZ、恢复读取 | 写入带时间后缀的测试账号，不删除数据库 |
| `npm run test:tiangz-fault-matrix` | 玩家交易故障、双Endpoint全不可用、MapHost接管和独立DBProxy存储故障 | 可能重启本地Redis/PostgreSQL容器，只能用于测试环境 |
| `npm run starter:acceptance:faults` | 重建Debug Runtime后运行完整TiangZ端到端故障矩阵 | 可能重启本地Redis/PostgreSQL容器，只能用于测试环境 |

自动脚本的结果写入被Git忽略的`temp/test-logs/starter-acceptance-*.json`。三个Starter验收命令都会先执行`cargo build --bin TiangZ`，确保Rust配置解析器与当前源码一致。持久化命令不会自动启动Docker；它会复用7800端口已有的DBProxy，或使用`tools-projects/TiangZ-DBProxy/target/debug`中的Debug服务，并从独立仓库的`deploy/local/.env`读取连接参数。常规Starter验收不应连接外网数据库。

当前自动脚本已经覆盖完整任务链和动态副本：测试客户端通过正式RPC接取5001，击杀5只A并回NPC交付，接取5005后击杀5只B，再接取5006并逐具查看尸体、只领取徽记，最后跨图验证三项完成记录、5个徽记和任务奖励。该链路在all-in-one与split-process中都运行；Cocos3D人工验收只负责画面、对话框、移动端按钮和事件穿透等客户端表现。

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

## 玩家交易持久化与故障切换

`npm run test:player-trade:persistent`使用两个临时账号先经NPC商店出售药品获得铜币，再交换铜币、小红和小蓝。验收器重启TiangZ后核对双方权威快照，并在第二轮最终确认前停止首选DBProxy `7800`，确认通过备用`7801`只提交一次。它还会在Debug Host中注入一次“DBProxy已提交、Host响应丢失”，验证交易通过同一`operationId`查询原始多记录回执，不重复转移；最后让两个Endpoint同时不可用，确认UseItem失败时内存背包不变，恢复Endpoint后复用同一`operationId`只提交一次。该命令需要本地PostgreSQL、Redis、两个DBProxy Debug二进制和TiangZ Debug二进制，不会清空数据库或执行容量压力测试。

## 玩家领域快照与MapHost故障恢复

`npm run test:player-domain-recovery`创建三个唯一账号，分别验证立即优雅停机的最终Flush、等待30秒周期窗口后强杀all-in-one，以及在`configs/local/cluster-dbproxy`中精确强杀承载地图100的`map-2`。前两轮重启后、MapHost轮在同一Watcher内拉起新PID后，均由新连接核对wallet金币、inventory背包、quest任务和runtime位置。MapHost轮还要求Location用更高所有权代次清除旧Actor路由，Gate在`ActorLocationNotFound`后重新进入恢复后的静态地图。怪物、仇恨、AI、移动意图和动态副本现场不在恢复范围。

`npm run test:tiangz-fault-matrix`按顺序运行上述玩家交易故障、玩家领域/MapHost接管，以及独立DBProxy存储故障矩阵，并把阶段结果写入`temp/test-logs/tiangz-fault-matrix-report.json`。其中Rust响应丢失注入只存在于Debug构建，Release构建不会主动丢弃DBProxy响应；它不是线上开关，也不能替代真实网络设备故障演练。
