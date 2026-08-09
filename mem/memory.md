# TiangZ开发记忆

## 工程与协作约定

- 每次开始 TiangZ 相关任务前，先读取本文件；它是项目协作规则和历史决策的第一入口，不先扫描外部上下文。
- 主工程目录固定为 `E:\gitee\TiangZ`，不要误操作 `E:\VsCode\skynet`。
- 默认使用中文交流、中文文档和中文 Git 提交信息。
- 架构或业务语义变更必须同步更新 `docs/ai/project-context.md` 和 `docs/ai/business-development-manual.md`。
- Core、Demo 和 Rust 层的函数注释使用中英文对照，说明作用、副作用、禁止用法和设计原因。
- 需要高 CPU 或长时间压测前先告知；验收以真实运行结果、构建产物、服务器状态或客户端画面为准。

## TiangZ架构

- 运行时主层次为 `Process -> Scene -> Component -> Entity/Unit`。
- 一个 Process 对应一个 V8；Process 是部署和 V8 隔离边界，Scene 是业务上下文和消息范围。
- `Unit`默认是UnitComponent本地拥有的地图Entity，没有mailbox和Actor路由；需要按InstanceId直接寻址和跨`await`串行时才继承`ActorUnit`并显式声明`@actor`。PlayerUnit是ordered ActorUnit，MonsterUnit是由地图固定桶驱动的普通Unit。
- 普通Unit与ActorUnit统一使用`UnitComponent.Create/Get/Remove`；框架根据类型选择本地所有权或Actor路由。`@unitRpcHandler/@unitMessageHandler`只能绑定ActorUnit，不要给批量怪物机械增加mailbox。
- Scene Event 不能跨 Scene；跨 Scene、跨 Process 或需要 mailbox 顺序时使用 Message/RPC。
- Scene Event只保留同步语义：`SyncEvent`用于事后通知，`VetoEvent`用于操作前只读检查并返回第一个非0错误码。监听器按稳定`id`注册到Hotfix槽，不给每个Entity动态保存业务闭包。
- 不关心完成时点的有界短异步工作使用`scene.Tasks.Spawn`；它统一记录错误并进入Hotfix排空。否决、事务、有序玩家状态、精确定时和永久循环不能使用Spawn。
- 业务优先使用 `AddComponent`、`GetComponent`、`RemoveComponent`，不要为简单功能增加额外胶水层。
- Unit、Item、Buff、Quest 等子对象遵循 Entity 生命周期语义。
- `Awake`、`Destroy`、`Deserialize`、`Transfer` 是可选能力；恢复后的业务加工由 Hotfix System 实现，框架只负责调用时机。
- Model 不热更，Hotfix 可以热更；稳定数据结构、Native schema、冷热标记和类型边界属于 Model/生成边界。
- Rust 负责权威数据、批量热路径、Native Entity/Unit/Item、AOI 和编码；TS 通过句柄/FastOP 使用，是否频繁调用由开发者决定，框架不阻止。
- Numeric创建时直接传`NumericType -> bigint`初始化字典；`NumericInitialValues`只是类型别名，不是逐字段配置接口。NumericSystem只遍历创建者传入的值，玩家、怪物、NPC的默认值写在各自创建流程，未传入的普通属性由Rust保持为0。普通属性和Base/Add/Pct来源可以初始化，MaxHp、MaxMp、Attack等派生结果禁止直接写，避免绕过Rust链式计算。
- 重要设计教训：接口字典化不能只替换参数外形，还要一起移除通用System中的业务默认值和身份分支；通用ComponentSystem只负责生命周期、校验、遍历和Native写入，具体初始数据必须由Unit创建者注入。
- 游戏配置命令语义：`build:game-config:startup`负责重新生成并覆盖`dist/game-config`供Process重启读取；`build:game-config`只生成在线热重载候选；`test:game-config`只验证，不能替代启动包构建。

## 动态地图与路由

- 静态地图和动态副本共用 `MapHostScene/MapHostComponent`，通过 `staticMapIds` 和 `acceptDynamicMaps` 区分静态、动态或混合承载。
- `MapManager` 负责动态 MapHost 注册、心跳、租约、幂等创建和 MapInstance 分配。
- `MapConfigId` 是地图模板，`MapInstanceId` 是运行时路由权威。静态和动态地图都使用同一套 `TransferToMap(mapInstanceId)` 业务流程。
- `Location` 保存玩家当前 MapInstance 和完整 MapHost Endpoint，用于路由查询，不应成为所有消息的流量中心。
- `knownSceneFiles` 是共享稳定启动拓扑，属于启动配置，不是运行时服务发现；新增空载副本 Host 不需要修改其他进程的 Scene 配置。

## AOI约定

- Cell 是基础空间单位；2D 可以以 Cell 为移动单位，3D 可以在 Cell 内连续移动。
- 默认一个 AOI Grid 为 `15 x 15 Cell`，AOI 关系按 Grid 边界计算，不按 Cell 边界计算。
- Rust 主方案为 Flat Grid + `Vec<EntityIndex>` + `slotInGrid`，跨 Grid 使用 O(1) swap-remove/push。
- Observer/Subject 使用双向连续位图；热点 Grid 使用稀疏数组和位图混合策略。这些是 Rust 内部优化，业务不依赖签名或缓存细节。
- 默认同步层级：`3 x 3 Grid` 为 Enter/高频 20Hz，`5 x 5 Grid` 为 Leave 迟滞/中频 5Hz；暂不使用 7 x 7。
- 业务通过 MapComponent 的 Audience/Publish API 广播，不能自行维护 AOI 关系表或绕过地图生命周期。
- AOI 只筛选接收者；阵营、隐身、位面、队伍权限等业务规则由业务提供同步查询接口。

## 固定更新桶与普通攻击

- Game默认20Hz；`Update()`就是20Hz兼容入口，框架另外提供固定`Update10Hz()`、`Update5Hz()`和`Update1Hz()`，业务不填写任意Hz，也不为每个玩家/怪物创建Timer或Update目标。
- 10Hz用于玩家自动平A开始/中断读条，5Hz用于主动怪AI，1Hz用于尸体清理和重生；Rust仍只通过一个Game固定帧入口处理批量移动、AOI和Native权威数据。
- 怪物复活只复用稳定的`AreaId`刷怪槽，不复用旧`UnitId`。死亡MonsterUnit先以`alive=false`作为不可交互尸体保留在AOI中，当前Demo到`respawn_seconds`到期后才Detach、发布Leave并Remove，再创建新UnitId并通过AOI Enter发送新快照；`UnitId`代表一次实体生命周期，AreaId代表出生配置位置。
- `CombatComponent`只保存平A意图和读条状态：`Inactive/Waiting/Swinging`。按1只是切换意图，不等于立即命中；目标存活、同Map、距离不超过`PlayerConfig.attack_range`且位于角色前方120度时才从零开始读条。
- 离开距离或前方±60度时保留自动攻击激活状态，但必须清零当前读条；重新满足条件不能恢复旧进度。读条完成前和完成瞬间都由服务端再次校验，客户端进度条只做表现。
- 平A状态不进入地图Transfer快照；传送后需要重新激活。Cocos3D使用独立`G2C_AutoAttackStateHandler`和键盘`1`演示，协议源仍只编辑`proto`后运行codegen。
- `G2C_AutoAttackState`是每个玩家本人频道上的`latest`可覆盖状态，只同步当前读条；攻击命中、道具消耗等不可逆事实必须使用`event`。平A不会因广播队列达到固定次数而自动停止，只有目标死亡、距离/朝向失效、玩家死亡或主动关闭会结束/重置。
- 玩家死亡时，10Hz平A桶要显式推送`Inactive`，不能只`continue`；否则客户端会把死亡前最后一轮读条显示成“计时器停了”。
- 当前演示的怪物目标语义是“主动索敌 + 统一仇恨”：`MonsterConfig.attack_mode=1`没有仇恨时在12米主动索敌范围内找最近玩家，`attack_mode=0`没有仇恨时保持待机；平A和技能每造成1点最终实际伤害都通过`MonsterComponent.AddThreat`增加1点仇恨，之后两种怪都按本地图最高仇恨追击，不能再用12米主动索敌距离过滤已有仇恨，也不能在受击事件中直接设置目标。当前未定义脱战回出生点距离，后续必须使用独立冷配置。玩家创建从`PlayerConfig.initial_hp/max_hp/initial_mp/max_mp`写入HP/MP Numeric，攻击距离从`PlayerConfig.attack_range`读取，怪物攻击距离从`MonsterConfig.attack_range`读取，二者都是独立米制配置而不是Numeric链式属性。Cocos3D、UE、Unity、Godot的HUD只消费快照和`G2C_EntityNumeric`，不能由客户端自行扣血。

## 战斗时间轴约定

- 自动攻击状态和自动攻击读条分离。`StartAutoAttack`只激活状态并锁定目标，不代表立即造成伤害。
- 只有目标存活、同一MapInstance、距离在攻击范围内且朝向有效时，才开始推进平A读条。
- 离开攻击范围或朝向失效时，平A状态不取消，但当前读条清零；重新满足条件后必须从0秒重新开始读条，不能恢复离开前的进度。
- 移动本身不调用`StopAutoAttack`；右键加A/D用于保持角色朝向并侧移绕目标，右键拖动改变角色的权威Yaw。
- 普通攻击、瞬发技能和施法技能分开描述：伤害类型、执行方式、是否重置平A是三个独立配置维度。

## 战斗伤害与Buff解耦约定

- 所有可受击玩家和怪物挂载`CombatComponent`；攻击、技能和Action只调用`target.GetComponent(CombatComponent).ApplyDamage(request)`，道具和持续治疗调用`ApplyHealing`，不能在Handler、MonsterComponent或Buff中直接写`NumericType.CurrentHp`。
- `CombatComponent`是目标侧的统一结算边界，负责受伤处理器、护盾消耗、最终扣血、MaxHp治疗限制、死亡标记和`DamageResult`；它不负责找目标、距离、朝向、AI、重生、AOI或Gate。
- Buff不参与伤害入口。Buff添加时调用`RegisterDamageAbsorber`并保存`modifierId`，移除/过期时调用`RemoveDamageAbsorber`；伤害流程不能查询`BuffComponent`或调用`TryAbsorbDamage`。
- 护盾剩余量以Combat注册处理器为唯一运行时权威，Buff和Combat不能各存一份会分叉的`absorbRemaining`；处理器只存数据，不保存旧Hotfix闭包。HP是Numeric latest，命中/死亡/消耗是event。
- 设计与实现见`docs/design/combat-damage-pipeline.md`；验证命令为`npm run test:combat`，新增业务先复用这套入口。

## 3D客户端与导航

- 3D 地图使用 NavMesh3D、离线导航资源和动态门障碍；角色与怪物之间的动态避让明确不做。
- 后端坐标统一为 `x/y/z: float32`，前端转换为各引擎自己的 `Vec3/Vector3/float3`，引擎类型不能进入协议。
- Cocos3D、UE、Godot 共享协议和 SDK，但各自负责输入、摄像机和表现层坐标转换。
- Cocos3D玩家使用“中心点Unit根节点 + 可替换Visual子树”：`BlueChibi.glb`是脚底原点的低模骨骼Prefab，挂载时下移0.9米；`Idle/Walk`只消费移动表现状态，不得写坐标、参与碰撞/AOI或启用Root Motion。使用`npm run asset:cocos3d:blue-chibi`通过Blender 5.2 LTS重复生成。
- Cocos3D、UE、Godot 的 A/D 方向必须以实际画面验收：A 向视觉左侧转，D 向视觉右侧转。
- Cocos3D 按住鼠标右键时：A 向左平移，D 向右平移。不能只依据代码中的正负号判断，必须验证最终画面。
- Cocos3D桌面左键拖动只环绕角色并维护本地`cameraYawOffset`，不能改变角色朝向或发协议；拖动超过5像素后必须吞掉鼠标抬起，不能误触发地面寻路，短点击仍可选择怪物或寻路。

## Cocos构建与发布

- 构建前清除 `ELECTRON_RUN_AS_NODE`，统一使用：
  - `npm run build:cocos3d:web`
  - `npm run build:cocos3d:mobile`
  - 对应 `:debug` 命令仅用于调试。
- 构建脚本负责匹配 Creator 版本、清理标准输出、校验 `index.html/application.js/assets`；Creator code 36 只有在完整产物存在时才接受。
- 编辑器 Preview 使用 `assets/resources/Config/tiangz-local.json`，连接本机 `127.0.0.1:7000`。
- 非 Preview 发布包使用 `tiangz-external.json`，连接公网 LoginMgr；本地和外网配置不能混用。
- 外网桌面资源部署到 `/var/www/tiangz-cocos3d/desktop`，网址为 `/`；手机资源部署到 `/var/www/tiangz-cocos3d/m`，网址为 `/m/`。
- 外网后端只上传 Linux Release 制品，不上传源码、Cargo 工程、`node_modules` 或 `target`；运行目录为 `/opt/tiangz-external`。
- 用户说“部署到外网测试机”时，默认重新生成代码、构建后端 Release、构建 Cocos3D Web，确认上传的是本次最新产物；远端只是可公网访问的 Demo 测试机，直接停止旧服务、覆盖 `/opt/tiangz-external` 与两个 Nginx 资源目录、重新启动，再做端口和登录链路冒烟。不要使用 `.next`、蓝绿目录、目录交换或自动回滚等生产发布流程；凭据不能写入仓库或日志。
- 外网Cocos3D双入口使用`npm run build:cocos3d:external`：`build/external/desktop`部署网站根路径`/`，必须保持`web-desktop`桌面布局；`build/external/m`部署`/m/`，由`web-mobile + landscape`生成，是唯一横屏移动入口。不要把移动包复制到根路径，也不要让根路径和`/m/`共用同一份构建目录。
- 外网Demo的Nginx对桌面与`/m/`资源发送`Cache-Control: no-cache, must-revalidate`；外网构建脚本在页面顶部注入`版本+UTC构建时间+Git短提交号`，排查问题时先核对页面Build标识，再判断是否加载了最新包。

## 当前状态与待办

- 最近提交：`dd68e08 完善怪物演示与Cocos3D发布配置`。
- 当前外网桌面版和 `/m/` 已使用最新 Cocos3D 包，页面 HTTP 200；前端发布不会自动重启后端。
- 标准 Cocos3D Web 包约 7.4 MB 原始大小，主要是 Cocos 核心、Bullet/Ammo、Spine 和内置渲染资源。小游戏 5 MB 主包需要独立轻量构建，不能直接拿标准 Web 包提交。
- 小游戏轻量包候选方向：移除未使用的 Bullet/Spine、主包只放启动链路、地图和资源放分包/远程资源，并增加 4.5 MB 构建预算检查。
- AOI 动态避障、角色/怪物动态避让和生产级持久化按路线图推进，不要在 Demo 中扩大范围。

## 常用验证命令

```powershell
npm run codegen
npm run verify:codegen
npm run typecheck
npm run typecheck:cocos3d-demo
npm run typecheck:cocos-net
npm run build:cocos3d:web
npm run build:cocos3d:mobile
```

## DBProxy独立项目决定

- DBProxy已经建立为独立Rust仓库：[TiangZ-DBProxy](https://github.com/moulo1982Google/TiangZ-DBProxy)，不作为TiangZ仓库中的模块，也不依赖TiangZ。
- `v0.1.0`冻结通用`RecordKey`、快照Payload、Revision/CAS、幂等写入和内存参考实现；DBProxy不认识Scene、Entity、Component、Buff、Hotfix或`.native`。
- 当前已增加`dbproxy-storage`：PostgreSQL是权威快照、Revision/CAS、幂等记录和单记录关键事务，Redis只缓存PostgreSQL已提交结果；Redis读取失败自动回源PostgreSQL，缓存失败可以复用原`request_id`或`operation_id`修复。
- 本机Docker开发使用PostgreSQL 18.4和Redis 8.8.1，仅绑定`127.0.0.1`；用户名和数据库为`tiangz`，密码为`tiangz_dev`，Redis密码也是`tiangz_dev`。DBProxy当前为`v0.4.0`，Redis使用AOF和命名卷；除进程内`SnapshotFlushQueue`外，`RedisSnapshotBacklog`通过lease/ACK和过期回收支持DBProxy重启后重新领取，PostgreSQL恢复后继续按原`request_id`写入。
- DBProxy独立协议固定为LoadSnapshot、SaveSnapshot、EnqueueSnapshot、ApplyTransaction和LoadTransaction；Save/Transaction成功表示PostgreSQL提交，Enqueue成功只表示Redis AOF backlog接收。`v0.4.0`提供运行时无关TypeScript SDK；客户端和服务端均按RecordKey做多连接分片，请求超时后连接不可复用，必须重新连接并保留原幂等ID。
- TiangZ已经接入首个`HostDbProxyTransport -> DbProxyPlayerRepository`：只有配置`process.persistence.dbProxy`才启用，Rust Host Runtime负责网络I/O，业务V8只等待Promise。玩家快照保存Numeric、Item、Buff、Skill冷却、Quest和地图状态，最终下线保存后重启TiangZ可以从PostgreSQL恢复；普通all-in-one仍使用内存Repository。
- 当前没有周期快照、批量RPC、Prometheus、TLS、Redis高可用和生产部署。任务GrantItem奖励已经成为首个`ApplyTransaction`业务：Inventory纯数据规划，DBProxy保存操作后Player记录与原始结果，成功后才修改Item/Quest；事务前失败和提交后ACK丢失均有自测。UseItem、Wallet、Trade、领域revision拆分和崩溃接管仍未完成，不得把单条任务链路描述成全部经济数据生产级不丢。
- 同一字段只能属于一个存储域；事务数据以PostgreSQL提交为权威，Redis只缓存带revision的提交结果。当前不同时实现MongoDB、MySQL和PostgreSQL三套Adapter。

## 技能系统第一阶段决定

- `SkillConfig.xlsx`描述目标关系和施法时间线，服务端专有的`SkillEffectConfig.xlsx`按顺序描述Action；不要把多Action参数硬塞进SkillConfig单元格。客户端只生成SkillConfig。
- Unit统一挂`SkillComponent`，玩家Handler和怪物AI复用同一API。当前Demo尚未实现已学技能持久化，也不创建Skill子Entity；以后需要时优先按SkillConfigId保存集合。
- `ActiveCast`是SkillComponent中的瞬时纯数据，不是Actor、Entity、Timer或持久化记录；普通读条由10Hz服务器deadline推进，冷却和GCD也只保存deadline。
- 技能只负责目标和时间线，完成时执行Action；伤害/治疗必须进入Combat，Buff进入BuffComponent，广播仍由Map/Audience负责。
- 伤害类型、Instant/Cast、移动中断和`Keep/ResetOnStart/ResetOnComplete/Cancel`平A策略是独立字段，不能互相推导。
- 第一版演示使用寒冰箭、火焰冲击、惩击、真言术·盾和真言术·韧；它们全部属于法术，接受时清零平A进度，读条期间暂停，成功或中断后都从0重新计时。寒冰箭需要最小抛射物，其他技能暂不扩展地面AOE、引导、技能队列和持久化。
- 六技能闭环已实现为`PlayerUnit.CastSkill -> SkillComponent -> 地图唯一SkillMapComponent.Update10Hz -> Action -> Combat/Buff`；3006额外验证引导Tick和单技能排队。不为Unit或Cast创建独立Timer/Update；冷却跨地图保留，活动读条在传送时终止。
- 可扩展施法前置条件统一走同步只读`SkillEvents.BeforeCast` Veto；底层SkillMap与BuffComponent仍必须保留最终不变量，不能只信Veto。
- 读条技能接受时立即清除Rust旧移动租约；后续非零移动输入打断施法，不能让玩家在旧输入租约期间继续滑行。
- Buff冲突已支持Target/Source作用域与Stack/Refresh/Replace/Reject/HigherWins；运行时Add/Tick/Remove Action和护盾剩余量必须随传送快照恢复，普通Refresh不重复执行AddAction。
- 玩家跨MapHost快照的生成和目标校验必须共同引用`PLAYER_TRANSFER_SCHEMA_VERSION`；新增可传送Component或字段时升级一次常量，并跑真实跨图Runtime smoke，禁止两端手写不同schema数字。
- 当前六技能数值已经迁入Luban；`SkillCatalog.ts`只按配置指纹组合只读定义。ActiveCast和Projectile冻结接受请求时的定义，Reload只影响新Cast；不得在Unit或Component长期缓存定义。

## 3D客户端左右输入约定

- TiangZ当前3D坐标和Yaw约定下，Cocos3D、UE、Godot等客户端的A/D左右转向必须以实际画面验收，不能只看代码表达式。
- 约定：按A应向视觉左侧转，按D应向视觉右侧转。
- 手机虚拟摇杆横轴也必须遵循同一约定：摇杆向左对应A，摇杆向右对应D。
- 修改输入映射、Yaw转换或相机跟随时，必须补一次客户端画面回归，避免引擎正方向与TiangZ正方向再次反转。

## Action、Buff与道具效果

- 道具使用统一走`ItemComponent.UseItem -> ActionFromConfig -> ExecuteAction`。`ItemConfig.use_effect=0`不可用，`1`添加Buff，`2`执行Action；不要为小红、大红或其他同类道具复制Handler分支。
- 当前Action类型为`None`、`ChangeNumeric`、`AddBuff`、`RemoveBuff`、`DealDamage`、`RegisterDamageAbsorber`和`Heal`。`ChangeNumeric`不能表达伤害或治疗，HP必须通过`DealDamage/Heal -> CombatComponent`。
- `BuffComponent`拥有`Buff ChildEntity`；Buff负责可追踪Timer和Add/Tick/Remove生命周期，Component负责实例ID、集合、传送和AOI事件。Buff不成为Actor、不查AOI、不找Gate、不调用Location。
- Buff传送只保存纯值和服务器墙钟时间，目标重建Timer但不重复执行AddAction；不保存TimerId、闭包、Promise或Entity引用。运行时Action覆盖和护盾剩余量已经随跨Process快照恢复。
- Combat不反向查询Buff。护盾等Buff在添加/移除边界注册/注销Combat数据型modifier，剩余量由Combat单独持有；禁止新增`BuffComponent.TryAbsorbDamage`式耦合。
- Buff叠加语义拆成冲突域、冲突决策和刷新行为：`stack_group + stack_scope + sourceUnitId`形成冲突键，策略支持Stack、Refresh、Replace、Reject和HigherWins；HigherWins比较显式priority，不比较ConfigId。Refresh默认不重复执行AddAction，来源、Tick节奏和运行状态分别配置。`BuffConfig.description`只进入服务端配置，不在客户端展示。
- 当前演示：1001小型生命药水执行`Heal(150)`，1002大型生命药水添加2001持续回血Buff，2001每3秒执行`Heal(50)`。两种药品各有30秒配置CD，并和技能共享1秒玩家GCD；服务端原子提交、跨地图保留，Cocos3D只按返回deadline绘制。六技能Cast与Luban SkillConfig/SkillEffectConfig已完成，3006验证引导Tick和单技能排队，寒冰箭/惩击30米、火焰冲击10米；复杂地面目标和Buff持久化暂不做。设计与调用示例见`docs/design/action-buff.md`、`docs/design/skill-system.md`和`docs/tutorials/18-configured-skill.md`。

## 本轮业务推进边界

- 当前优先顺序仍是Inventory与奖励、任务收口、技能扩展、真实业务链路压测；DBProxy已经进入独立仓库的真实存储适配阶段，但不把数据库客户端带回TiangZ主工程。
- 真实业务压测入口是`npm run perf:business-chain`，正式CPU或长时间窗口前必须告知用户并等待空闲机器；未获得机器确认时只做编译、自测和小规模非压力验证。
- 业务链路压测默认交替UseItem与友方CastSkill，报告必须区分业务拒绝、传输错误、p50/p95/p99和服务端队列，不能把规则拒绝当丢包。
- 组队任务依赖Party/PartyAudience，Party完成前不在Quest中增加队员共享逻辑。
- 未来部署与基准制品继续按“本机/CI编译 -> 上传Linux Release制品 -> 外网测试机只运行制品”的边界推进；外网不上传源码和开发依赖。

技能扩展补充：当前已经加入3006引导治疗，用于验证10Hz分段Tick、读条期间停止平A、移动打断、公共CD和单技能排队。`ActiveCast`仍是SkillComponent纯数据，不创建每Cast Timer或Update；复杂AOE、真实技能压测和技能持久化暂缓。

## 任务系统当前语义

- 玩家任务状态固定为`QuestComponent -> Quest ChildEntity`：活动任务是子实体，已完成任务只保存QuestConfigId；Quest默认没有mailbox且只对拥有者同步。
- 击杀、使用道具和进入地图模块只在事实成功提交后同步发布`QuestEvents.Progress`，稳定Hotfix事件Handler负责投影进度；来源模块不得查询QuestComponent或直接改任务。
- 接取时冻结目标ID与required，热配置Reload只影响新接取任务。领取必须在PlayerUnit有序mailbox中等待DBProxy事务，确认后才提交Item计划、完成ID和RemoveChild；广播只能发生在提交后。
- 进度使用owner-only latest消息；登录、重连和跨地图携带活动Quest及已完成ID全量快照。任务状态已经进入玩家持久化记录；组队共享和可重复任务暂未实现。
- `PlanTransactionalReward`当前只支持GrantItem；`ItemComponent.PlanGrantItems`不改Entity，`CommitGrantPlan`只在DB确认后无await提交。故障前失败保持内存原状，ACK丢失按operationId回执恢复首次结果。新增Heal/Buff或跨玩家事务奖励前必须先提供纯数据Planner，组队共享任务等待Party系统。
- 活动Quest显式使用`InProgress/ReadyToTurnIn`；目标达成只进入待交付，领奖成功后才写完成集合并移除Quest。协议status是新权威字段，旧`ready_to_complete`仅为SDK兼容镜像。
- `QuestComponent`按`objectiveType:targetConfigId`维护只含稳定ID的运行时目标索引；索引不传送、不持久化，接取/领奖时维护，Deserialize/RestoreTransfer时重建。
- 接取统一走同步`QuestEvents.BeforeAccept` Veto，配置内置`required_quest_ids/minimum_level`最终不变量；Veto只读且不可异步。`NumericType.Level=3`，Demo玩家默认1级，5004要求完成5001且达到2级。
- 设计变更继续同步`docs/ai/project-context.md`、`docs/ai/business-development-manual.md`、`docs/development-log.md`和本文件。

## 道具出生与Cocos3D快捷栏

- Demo新建玩家的`ItemComponentSystem.Awake`预置`1001×50`和`1002×20`；传送、重连和恢复只用`ItemSnapshot`替换默认背包，禁止重复发放。正式项目接入持久化后应移除这段Demo种子。
- `ItemConfig.icon`是客户端字段，使用相对`assets/resources`的不带扩展名Cocos资源键；当前为`UI/Icons/Items/1001`和`UI/Icons/Items/1002`。Cocos3D Web快捷栏固定`1=平A`、`2=1001`、`3=1002`，数量来自进图快照和`G2C_ItemChanged`，客户端不预扣库存。
- Cocos3D Buff栏从Unit快照、道具使用RPC的可选`M2C_UseItem.buff`或`G2C_BuffAdded`显示`UI/Icons/Buff/<BuffId>`图标，界面文字读取`BuffConfig.name`显示中文名，不显示BuffId；倒计时使用服务器结束时间，统一显示`分钟:秒`，两小时为`120:00`，无限时长显示`永久`。到`00:00`后保留图标，必须收到`G2C_BuffRemoved`才能删除，客户端不能按本地计时自行移除。三条路径按Buff实例ID幂等合并，RPC回显只给使用者，AOI事件仍给观察者。
