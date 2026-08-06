# TiangZ 开发日志

本文记录已经发生的工程变更、验证结果和当时的取舍。未来计划仍以 [路线图](roadmap.md) 为准，稳定架构约束以 [AI 项目上下文](ai/project-context.md) 和 [AI 业务开发手册](ai/business-development-manual.md) 为准。

维护约定：

- 最新记录放在最前面，使用日期和版本作为标题。
- 记录目标、实现、验证、设计决定和遗留问题，不复制完整提交清单。

## 2026-08-06：简化外网Demo测试机发布流程

- 明确外网主机只是可公网访问的Demo测试机，不按生产环境执行蓝绿发布、`.next`目录交换或自动回滚。
- 构建端仍必须完整生成并编译最新后端Release及Cocos3D桌面/移动Web包；远端流程固定为停止旧服务、覆盖固定目录、重新启动，再检查端口、页面和登录链路。
- 后端固定覆盖`/opt/tiangz-external`，桌面与移动资源分别覆盖`/var/www/tiangz-cocos3d/desktop`和`/var/www/tiangz-cocos3d/m`。

## 2026-08-06：Cocos3D Buff图标与服务端驱动移除

- Cocos3D Web新增本地Buff栏：从Unit进入快照和`G2C_BuffAdded`恢复Buff图标，按`UI/Icons/Buff/<BuffId>`加载资源；当前Buff 2001使用`2001.png`。
- 修复进图/事件时序导致本人Buff栏可能错过首次事件的问题：`M2C_UseItem.buff`现在作为使用者确认结果，`G2C_BuffAdded`仍作为AOI事件发送给观察者；客户端三条来源按Buff实例ID幂等合并。
- `M2C_UseItem.buff`声明为可选嵌套消息；协议生成器补齐`optional`字段解析和嵌套消息编码，避免无Buff的道具返回伪造空Buff。
- 倒计时使用Gate Ping估算的服务器时钟，统一显示分钟和秒，例如两小时显示`120:00`；无限Buff显示`永久`。
- 倒计时归零后只停在`00:00`，不会因为客户端本地时间到期删除图标；收到`G2C_BuffRemoved`后才删除，AOI离开则随Unit整体清理。
- 新增独立`G2C_BuffAddedHandler`和`G2C_BuffRemovedHandler`，复用SDK的`BuffStateStore`处理快照、事件和移除墓碑。

## 2026-08-06：Cocos3D道具快捷栏与出生背包

- `ItemConfig`新增客户端字段`icon`，1001/1002分别绑定`UI/Icons/Items/1001`和`UI/Icons/Items/1002`；Cocos资源缺失时快捷栏回退为道具名称文字。
- Demo玩家出生时预置1001×50、1002×20。传送和重连仍通过Item快照恢复，不会重复发放；更新了Actor和Runtime smoke中的初始数量断言。
- Cocos3D Web新增三格快捷栏：1切换平A，2使用1001，3使用1002，数量从进图快照和`G2C_ItemChanged`刷新。道具使用仍由服务端Action/Buff链路结算，前端不提前扣库存。
- 验证：完成Luban/客户端配置与Handler生成，`npm run typecheck:cocos3d-demo`通过；Runtime全链路测试待本轮完整构建后复验。

## 2026-08-05：固化Cocos3D外网双入口发布

- 保留桌面`web-desktop`和手机`web-mobile + landscape`两个独立构建，不让移动横屏配置污染网站根路径。
- 新增`npm run build:cocos3d:external`：每次外网发布都重新构建两个目标，并整理为`build/external/desktop`（网站`/`）和`build/external/m`（网站`/m/`），同时生成`manifest.json`记录目标和路径。
- 根路径必须部署桌面目录，`/m/`必须部署移动目录；两者不能互换。验证重点从“文件存在”扩展为检查两个包的`src/settings.json.engine.platform`分别为`web-desktop`和`web-mobile`。

## 2026-08-05：区分游戏配置启动包与在线候选

- 定位到一个容易误用的流程：Excel和`game_config/generated`已经更新，但`npm run build:game-config`只生成`dist/game-config-candidates/<指纹>`，不会覆盖服务器启动读取的`dist/game-config`，因此重启后仍可能使用旧数值。
- 新增`npm run build:game-config:startup`，它会先运行Luban，再以`--initial`原子更新`dist/game-config`；修改配置后准备重启服务器时使用这个命令。
- 保留`npm run build:game-config`作为在线热重载流程；`npm run test:game-config`只验证生成物和指纹，不负责复制运行时启动包。构建工具输出现在会明确标记`startup`或`hot-reload-candidate`模式。

## 2026-08-05：补齐主动怪战斗下的玩家HP/MP HUD

- 明确演示语义：`MonsterConfig.attack_mode=1`的主动怪不仅追击，还会在攻击距离内按最终`NumericType.Attack`扣除玩家`CurrentHp`；被动怪仍不会主动寻找玩家。此前这件事没有向开发者解释清楚，现补入AI手册和怪物教程。
- `PlayerConfig.xlsx`新增`max_mp`和`initial_mp`，玩家创建时与HP一样写入`NumericType.MaxMpBase/CurrentMp`；Numeric仍由Rust维护，TS只传入初始化字典。
- Cocos3D新增红色HP、蓝色MP进度条；UE、Unity、Godot新增玩家HP/MP HUD。三套客户端都从进入快照和`G2C_EntityNumeric`更新，不复制服务器伤害逻辑；玩家死亡后HP保持为0，便于观察权威状态。
- 已验证：`npm run build`、`npm run typecheck`、`npm run typecheck:cocos3d-demo`、`node tools/check_godot_demo.mjs`通过。

## 2026-08-05：统一怪物仇恨和独立近战距离

- 被动怪不再因为“收到攻击事件”直接追击；玩家造成的实际伤害按1:1写入该怪物的运行时仇恨表，主动怪和被动怪都由5Hz桶选择范围内仇恨最高的玩家。没有仇恨时，只有`attack_mode=1`的主动怪会自动寻找最近玩家。
- `MonsterComponent.AddThreat`成为伤害、技能和未来嘲讽规则的统一扩展入口；当前普通攻击在扣除怪物HP后调用它，0伤害不产生仇恨，Unit死亡或离图时运行态随MonsterUnit销毁。
- `PlayerConfig.xlsx`新增独立`attack_range`，`MonsterConfig.attack_range`统一调整为2.5米；攻击距离不属于Numeric链式属性，玩家和怪物的战斗判定分别读取各自配置。
- Cocos3D修复初始AOI快照中本地Unit被当作远端忽略的问题，并增加玩家世界头顶HP/MP条；左侧面板和世界条都只消费服务端Numeric快照/增量。
- 验证：`npm run build:ts`、`npm run build:game-config:initial`、`node tools/smoke_runtime.mjs --mode all`通过；冒烟确认怪物死亡后等待10秒创建新的UnitId并恢复100点HP，自动平A连续结算未因仇恨逻辑中断。

## 2026-08-05：验证自动平A连续计时

- 排查“平A打四五次后停止”时确认：玩家平A由地图`Update10Hz()`统一推进，不是每个玩家一个Timer；正常命中后会以当前服务器时间开启下一轮读条。
- 修正冒烟客户端对Grid移动停止语义的误判：停止输入只阻止下一格，不取消已经开始的当前Cell移动；测试现在会等待当前Cell完成后再开启平A。
- `node tools/smoke_runtime.mjs --mode all`真实走登录、Gate、Map、Numeric和广播链路，连续观察到怪物HP `95 -> 90 -> 85 -> 80 -> 75 -> 70`，第6次仍正常结算。若实际客户端仍停止，应优先检查目标是否死亡、离开`PlayerConfig.attack_range`、离开前方120度、玩家是否死亡或客户端是否发送了关闭/移动输入。
- 平A状态协议改为`latest`可覆盖广播，并增加单频道覆盖回归测试；不可逆命中事实仍保持`event`语义。
- 补充玩家死亡分支：死亡玩家不再静默跳过平A状态，而是由10Hz桶显式推送`Inactive`，避免客户端进度条冻结在最后一次读条。

## 2026-08-05：Numeric创建参数改为类型字典

- `NumericInitialValues`从逐字段接口收敛为`Partial<Record<NumericType, bigint>>`。`AddComponent(NumericComponent, values)`现在直接接受按`NumericType`索引的初始化字典，新增普通Numeric或`Base/Add/Pct`来源不再需要修改一组重复的参数字段。
- `NumericComponentSystem.Awake`不再维护逐字段默认表，只遍历创建者传入的字典；玩家、怪物和NPC的默认值由各自创建流程提供，普通属性未传入时由Rust保持为`0`。普通属性和来源属性允许写入，`MaxHp`、`MaxMp`、`Attack`等Rust链式计算结果禁止直接初始化，错误NumericType、派生结果或非`bigint`会立即报错。
- 玩家和怪物创建样例统一使用计算属性键；怪物的`MaxMpBase`和`CurrentMp`仍由配置驱动，最终`MaxMp`由Rust计算。`npm run codegen`、`npm run verify:codegen`、`npm run typecheck`、`npm run test:monster-behavior`和`npm run test:game-config`通过。

## 2026-08-05：统一AttackSpeed与MoveSpeed数值单位

- `NumericType`补齐`AttackSpeed`和`MoveSpeed`的`Base/Add/Pct`链，修正`CurrentHp`与`CurrentMp`的重复编号；所有Numeric仍使用Rust侧`i64`和TS侧`bigint`。
- `MonsterConfig.attack_interval_ms`只在怪物创建/复活时写入`AttackSpeedAdd`，怪物AI读取最终`AttackSpeed`；玩家平A也从自己的Numeric读取最终攻击间隔，客户端使用服务端下发的读条间隔。
- `MoveSpeed`统一采用米制世界速度：配置表填写米/秒，Numeric按毫米/秒整数保存。Grid2D跨Cell耗时纳入`cell_size_meters`，避免Cell大小变化偷偷改变角色实际速度；旧协议字段名暂时保留兼容。

## 2026-08-05：收敛怪物Numeric、攻击与死亡复活语义

- `MonsterConfig.xlsx`现在统一提供`max_hp`和`respawn_seconds`，两个演示怪物的最大生命值均为100；`MonsterAreaConfig.xlsx`只保留刷点空间信息和`initial_spawn`，移除尸体保留时间与刷点级复活时间。
- 创建怪物时把最大生命值写入Numeric的`MaxHpBase`（Rust自动得到只读`MaxHp`），同时写入`CurrentHp`和配置攻击力的`AttackBase`；玩家创建时默认写入`NumericType.AttackBase = 5n`，由Rust推导只读`Attack=2000`。普通攻击统一读取攻击者的最终Numeric.Attack，当前不加入Armor，伤害是多少就扣多少CurrentHp。
- 删除Numeric内置的100ms回血Timer和Bench对它的特殊停止调用。回血、Buff等周期规则必须由具体业务Component显式拥有。
- 怪物死亡会先`Detach`并发布AOI Leave，再`Remove`旧MonsterUnit；Map只保留`AreaId`刷怪槽和复活时间。到模板复活时间后按同一刷怪槽创建新的MonsterUnit，分配新的UnitId并通过AOI Enter发送完整快照。`AreaId`代表出生位置，`UnitId`代表一次实体生命周期，二者不能混用；Cocos3D的旧表现随Leave销毁，新表现随Enter创建。
- 验证：`npm run codegen:game-config`、`npm run codegen:scenes`、`npm run codegen:client-sdk`、`npm run codegen:client-handlers`、`npm run typecheck`、`npm run typecheck:cocos3d-demo`、`npm run check:project`、`npm run test:game-config`、`npm run test:actor`、`npm run test:monster-behavior`和`npm run build:client`通过；重建`dist/model.js`、`dist/hotfix.js`和`dist/smoke_client.cjs`后，`node tools/smoke_runtime.mjs --mode all`确认旧UnitId收到AOI Leave，新UnitId在10秒后以100 HP进入视野。

## 2026-08-05：修复玩家最终下线时的 Actor 自销毁竞态

- 原因：`G2M_PlayerOffline`是在`PlayerUnit`自己的ordered mailbox中执行的；旧流程在保存后立即`RemovePlayer`，同步调用`DespawnActor`销毁当前Actor。Handler返回时运行时发现当前Actor已经不存在，于是报`actor despawned during mailbox execution`，Gate因此误记录为玩家下线失败。
- 修复：最终下线先完成玩家保存和Location移除，再返回`PlayerOffline`响应；`MapComponent`用一个共享的零延迟Timer批量完成AOI离开、Unit索引移除和Actor销毁。地图停机/批量清理仍使用原有的地图清理顺序，不为每个玩家创建长期Timer。
- 验证：`npm run typecheck`、`npm run build:ts`、`npm run verify:comments`、`cargo build --locked --bin TiangZ`通过；`node tools/smoke_runtime.mjs --mode all --gate-timeout-only`通过，Gate超时下线后可重新创建玩家，未再出现Actor自销毁错误。完整npm冒烟包装因本机Cocos编辑器占用生成文件而未执行，已用直接Runtime smoke覆盖同一链路。

## 2026-08-04：固定更新桶与玩家自动平A最小闭环

- `UpdateSystem`保留已有`Update()`作为20Hz入口，新增固定的`Update10Hz()`、`Update5Hz()`和`Update1Hz()`集合。调度器按20Hz帧计数分桶，不允许业务填写任意Hz，也不为每个玩家创建更新目标；`npm run test:game-update`新增分桶频率断言并通过。
- 新增Model `CombatComponent`和Hotfix `CombatComponentSystem`。它只保存`Inactive/Waiting/Swinging`状态，不保存不可迁移的读条Timer，也不把平A状态放进地图Transfer快照。
- 新增`C2M_ToggleAutoAttack`、`M2C_ToggleAutoAttack`和`G2C_AutoAttackState`协议。Handler只转发到`PlayerUnit.ToggleAutoAttack`，地图10Hz桶统一检查存活、同地图、`PlayerConfig.attack_range`和前方120度；离开条件保留自动攻击意图但清零读条，重新满足后从零开始。
- 怪物系统拆分为5Hz主动AI和1Hz尸体/重生维护；20Hz移动和帧尾Numeric同步边界不变。命中仍由`MonsterComponent.Attack`完成，Rust Numeric继续是权威数据源。
- Cocos3D增加键盘`1`切换最近可见怪物的自动平A、独立Push Handler、状态标签和服务端时钟驱动的读条条。客户端读条只用于表现，不决定命中。
- 协议、TypeScript、Cocos3D、Cocos2D协议SDK、Pixi、Godot、UE、Unity和C++制品均重新生成。通过`npm run typecheck`、`npm run typecheck:cocos3d-demo`、`npm run typecheck:cocos-net`、`npm run typecheck:pixi`、`npm run typecheck:cocos-demo`、`npm run check:godot-demo`、`npm run verify:codegen`、`npm run test:protocol-locks`、`npm run verify:comments`和`npm run verify:core-api`。
- 设计细节见[固定更新桶与自动平A设计](design/auto-attack-and-fixed-update.md)和[怪物模块教程](tutorials/16-monster-module.md)。该条记录当时仍未实现技能、Buff、仇恨、掉落和角色/怪物动态避障；统一仇恨已在后续的2026-08-05记录中补齐。

## 2026-08-04：固化 Cocos Creator Web 构建流程

- 新增`tools/build_cocos.mjs`，统一Cocos 2D/3D的桌面Web与横屏Mobile Web构建入口；工程版本分别固定到Creator 3.8.6和3.8.8。
- `npm run build:cocos3d:web`和`npm run build:cocos3d:mobile`默认生成Release包；带`:debug`后缀的命令才生成Debug包。脚本会清除`ELECTRON_RUN_AS_NODE`，只清理`build/standard-*`自身输出，并检查`index.html`、`application.js`和`assets`，避免“进程退出但没有产物”或旧包残留。
- 新增`npm run check:cocos-build`和`--dry-run`预检，不启动Creator即可确认版本、路径和最终参数；构建命令不再依赖开发者手工拼接Cocos CLI。
- 编辑器预览、Web资源构建、Cocos Native原生工程编译明确分层；Native不复用Web命令，外网发布只复制校验过的Web产物。
- 验证：脚本语法、无构建预检，以及Cocos3D桌面Web的Release/Debug实际构建均已通过；使用临时JSON配置后不再出现`debug`类型警告，Creator 3.8.x返回36时完整产物校验通过，其他非零码仍失败。
- 公共 API、配置、数据所有权或业务开发方式发生变化时，同步更新对应教程以及两份 AI 文档。
- 性能数字必须注明拓扑、负载和边界，微基准不得直接写成整服容量结论。
- TiangZ主工程及配套插件仓库的提交标题默认使用中文；代码标识、命令、版本号和无法自然翻译的专有名词保留原文。

## 2026-08-04：固定Linux Release Builder

- 新增`tiangz-linux-builder:ubuntu-24.04`工具镜像与`npm run release:linux`统一入口。镜像只固化Node 24、npm 11、Rust 1.97.1、.NET Runtime 8、Luban 4.10.2及项目依赖，不再把业务源码烘焙进镜像。
- Builder使用工具指纹判断是否需要重建；普通TS、Rust、Excel和版本号变化不会触发工具下载。Linux Cargo中间产物使用`tiangz-linux-builder-target`命名卷跨构建复用。
- 每次发布从当前工作树创建隔离源码副本，过滤Git、依赖、编译结果、性能报告和客户端引擎缓存，然后完整执行Luban表格生成、全部codegen、TS构建、Rust Release编译、发布包校验和制品smoke。
- 正式发布输出固定为`dist/release/TiangZ-<version>-linux-x64`；Ubuntu/Debian矩阵命令继续只负责跨发行版smoke，不作为正式发布入口。
- 本机首次初始化后，镜像展开大小约4.16GB，`tiangz-linux-builder-target`缓存卷约1.08GB；镜像工作目录为空且不包含业务源码。相同工具指纹检查耗时约1.64秒，完整缓存发布耗时约60.9秒，其中Rust Release约14.8秒；制品smoke和全部SHA-256校验通过。
- 发布smoke原先假设Map 100下一条导航广播一定来自测试玩家，加入自主寻路怪物后会偶发先消费怪物消息。测试现按`unitId + sequence + moving`筛选目标导航状态，不改变Runtime广播语义。

## 2026-08-04：外网2C2G拆分为登录/Gate与世界两个Process

- 新增`configs/deploy/external-2process/StartMachine.json`，作为外网2C2G演示的推荐启动入口。
- `login-gate.json`承载LoginMgr、两个Login和两个Gate；`world.json`承载MapManager、静态MapHost、Location和动态副本MapHost。两组服务各自只有一个V8，服务间仍通过统一的Scene路由通信。
- 两个Process共享`known-scenes.json`，避免每个配置文件重复维护启动拓扑；`external-all-in-one.json`继续保留为单Process回归配置。
- 外网发布包仍只包含Linux Release可执行文件、`dist`、配置、导航资源和校验文件，不包含源码或构建目录。此次配置通过JSON、项目检查、观测配置校验和共享Scene加载测试。
- 登录与Gate的共享路由使用`protocol: auto`和`audience: mixed`，同一监听端口同时承载浏览器WebSocket和世界Process内部TCP；若误写成纯WebSocket，地图回传Gate时会被解析为非法握手。

## 2026-08-03：云部署监听地址与外网通告地址分离

- `SceneConfig`新增`bindIp`、`innerIp`、`outerIp/outerPort`语义：监听使用`bindIp`，服务间路由使用`innerIp`，LoginMgr/Login/Gate返回客户端时使用外网地址；旧`ip`配置兼容读取为`innerIp`。
- TCP、WebSocket、KCP监听器不再把路由地址误当作绑定地址；`0.0.0.0`只允许用于监听，不能进入`knownScenes`、MapHost Endpoint或客户端响应。
- 外网演示链路固定为“前端写死LoginMgr公网地址 -> LoginMgr返回Login外网地址 -> Login返回Gate外网地址”。云服务器公网EIP不依赖`ip addr`自动发现，必须由部署配置显式提供。

## 2026-08-03：AOI扁平Grid与双向位图索引

- 新增`docs/design/aoi-architecture.md`，用分层图、数据结构图和时序图固定地图创建、入图、移动、业务过滤、Movement直达Gate、Numeric/UnitState复制、Enter/Leave和Detach的真实函数链；补充Buff公开事件、队伍私密详情、位面过滤、Item本人事件和Move自动热路径的可调用代码范例，并链接真实Demo位置。`MapComponent.PublishVisibilityChanges`成为显式Invalidate后的统一发布入口，Demo关键决策点增加中英文说明，避免开发者绕过地图生命周期或重复广播。
- 后续收紧候选热路径：`UnitId -> EntityIndex`哈希只保留在API入口，实体元数据与Audience签名改为按EntityIndex连续存放；Attach合并为一次邻域扫描，跨Grid候选不再逐实体回查哈希，Detach复用索引缓冲，关系位图可直接遍历置位索引。
- 增加稀疏Grid数组与热点Grid位图的混合策略。Release微基准在64人/Grid时位图仍慢约20%，128人起反超，256/512人时约为数组耗时的65%/53%；因此固定128人升级、96人降级并防止边界抖动。热点位图只由Rust自动维护，不增加配置或业务API；15项普通AOI测试、1项手工微基准和严格Clippy通过。
- 连续索引后的3000人、10×10 Grid正式全链路回归得到Map CPU平均51.0%，相对上一轮同口径55.0%再降约7.3%；Probe p95/p99为47.94/71.78ms，Move 6000/s、跨Grid 309.6/s，错误、过载、超时、背压和慢连接均为0，正式证据已更新到`perf/results/map_capacity_latest.md`。
- 热点结构另以1000人单Grid完整链路验收：candidate/visible均为999000，Move 2000/s，Probe p95/p99为23.88/33.52ms，正式窗口无持续跨Grid、无关系变化且全部丢工作指标为0，证明热点位图不改变同屏可见语义。该样本只验证热点结构，不替代均匀分布容量基线；带时间戳的本机原始报告按项目规则不提交。
- Rust `AoiWorld`由坐标Hash Grid改为按地图边界预分配的扁平Grid数组；每个Grid保存连续`EntityIndex`，实体通过`slotInGrid`执行`swap-remove + push`，跨Grid成员迁移为O(1)。地图宽深必须能被AOI Grid尺寸整除，超过四百万Grid的单实例会被拒绝。
- Scene内UnitId映射为可复用紧凑索引。空间候选关系与业务过滤后的最终可见关系各使用Observer/Subject双向稠密位图，迟滞关系另用一张单向位图，正向受众、反向观察者、关系差分和指标计数不再扫描Hash集合或全量关系；索引释放时清除全部行列，避免复用污染。
- 该实现明确选择用内存换吞吐：位图采用单块连续`u64`矩阵并按512实体分段扩容，3000实体预留到3072时五张矩阵约5.6 MiB。每MapInstance硬限制16384个AOI实体，对应约160 MiB；更大Scene后续使用分块位图或空间分片。当前80%移动不跨Grid，因此不引入逐Tick counting sort/CSR重建。
- 3×3 Enter/20Hz、5×5 Detach/5Hz、业务过滤、Audience签名和TS公开API均保持不变。14个Rust AOI测试覆盖迟滞、过滤、分组、槽位修复、索引复用和越界拒绝；20个NativeData测试、Clippy、TS类型与生成规则检查均通过。
- Windows IOCP正式A/B使用1 MapHost、16 Gate、3000名Rust客户端、2Hz Move、0.2Hz Probe、80% Grid内移动和20%每2秒跨Grid。10×10、15×15、20×20的Map CPU平均由旧`74.1%/56.7%/57.3%`降至`55.0%/50.7%/42.9%`，分别下降约`25.8%/10.6%/25.1%`；新Probe p95/p99为`62.18/100.18ms`、`41.34/53.39ms`、`35.59/42.26ms`。三档Move约6000/s、跨Grid约299.3/303.7/301.4次/s，正式窗口全部零错误、过载、超时、背压和慢连接。
- 首次15×15在正式窗口前由Bench后置Place RPC打满Map frame队列并超时，该样本按规则作废；Map Enter并发降为4后完整矩阵通过。20×20第一次尾延迟异常但无丢工作，单独同参数复测恢复并作为最终证据。矩阵工具修复进程Counter层级，并支持`--report-runs`从三份已验证原始报告重建汇总，避免因单档复测重复全矩阵。
- 10×10另跑60秒正式窗口校验密集场景尾延迟：Map CPU平均56.2%，Probe p95/p99为50.60/75.17ms，Move 6000/s、跨Grid 298.6/s且全部丢工作指标为0。它说明30秒矩阵中的p99=100.18ms偏高，但密集场景p99相对旧矩阵仍有约10.8ms波动；当前收益应表述为显著降低Map CPU，不承诺所有短窗口延迟分位都同比下降。

## 2026-08-01：Phase 4.2.1 NavMesh离线资产链路

- 固定官方Recast/Detour `v1.6.0`及提交`6dc1667f580357e8a2154c28b7867bea7e8ad3a7`，第三方源码保持原样，项目适配集中在独立C ABI与Rust安全封装。
- 增加确定性灰盒OBJ与冷烘焙清单；`npm run navigation:bake`自动生成灰盒、离线烘焙tiled NavMesh、计算SHA-256并让Detour立即回读自检，不需要Cocos或人工烘焙。
- 自定义资源头使用显式小端字段，记录Detour参数和每个Tile，避免直接持久化C++内存结构。元数据同时记录版本、Hash、边界、Agent参数和输入规模。
- Rust已提供位置投影、绕障寻路和按Hash弱引用共享的`NavigationAssetCache`。同一输入两次烘焙字节一致，Hash漂移在进入C++前拒绝，最后一个MapInstance引用释放后共享资产可回收。
- 本阶段尚未打开`MapConfig.NavMesh3D`：MapScene自动装载、射线/高度FastOP、动态障碍和3D权威移动继续在Phase 4.2后续实现。

## 2026-08-01：Gate Ping返回服务器时间

- Gate保活由单向`C2G_Ping`升级为TS RPC `C2G_Ping -> G2C_Ping`，响应返回`TimerComponent.ServerTime()`产生的Unix毫秒。
- Session与GateSession改为unordered，PlayerUnit显式保持ordered。Ping是无锁的普通TS Handler，不再使用控制帧快速路径；客户端SDK限制同一连接最多一个在途Ping，并在EnterMap等待期间继续保活。
- Gate认证使用连接与账号两级协程锁；进图、重连、传送、快照确认、Map踢人、断线和最终下线按账号锁串行。超时任务取得锁后重新检查条件，避免旧任务覆盖刚完成的重连。
- 修正`RunExclusive`的无竞争路径：空闲锁同步进入回调，只有竞争时才异步等待，避免unordered Session中紧随EnterMap的Actor消息在传送屏障建立前抢跑。
- `TimerComponent`是`TimerSystem`的同类型公开别名，共享现有`TimeSystem.ServerNow`，没有引入第二套时钟或定时器。

## 2026-08-01：增加可见遛弯机器人

- 增加`npm run robot:walk -- <人数>`，通过正式TypeScript SDK批量登录、进图、保活并按500ms移动续报。
- 机器人方向变化和停止立即上报，活动范围会向出生锚点收敛；优雅退出前先发送停止输入，服务端没有机器人专用代码。
- `LoginFlow`同时公开最近一次Gate Ping的RTT与服务端时钟偏差，Cocos 2D地图HUD显示并按区间着色，不重复创建保活请求。

## 2026-08-01：建立Rust游戏业务目录边界

- 新增`src/game`作为开发者可编写的Rust业务模块根目录，首个`movement`模块承载真实Native op入口；`src/native_data.rs`继续拥有句柄、类型Pool、脏版本和受控Store访问。
- Numeric Native op和派生规则迁入`src/game/numeric.rs`。Numeric值全链路统一为Rust`i64`、protobuf`int64`和TS`bigint`；native-language v0.15.0提供无损op绑定。派生结果使用1000..9999，Base/Add/Pct按`result*10+1/+2/+3`编号，Rust无需重复声明业务常量；来源与结果原子更新并分别置脏，直接写结果会被拒绝。
- 生成Extension暂时仍通过`crate::native_data`稳定导入op，Runtime只做`src/game`符号兼容转发。新增Buff、战斗等Rust业务不得继续堆入Host、Process或Native Store文件。
- 冻结混合Handler语义：Actor消息先经过TS Location、实体定位和mailbox，再调用Rust领域模块；Rust业务随Process编译部署，不参与TS Hotfix。
- 增加`npm run perf:numeric`纯Rust微基准，分别测普通写、单来源派生、Base/Add/Pct三次独立写和一次批量重算上限；派生公式抽为Runtime与基准共用内核，避免性能样例复制另一套算法。
- 本机i7-13700F、10,000 Entity、5轮结果：普通写`18.69ns`，单来源派生`57.65ns`，三来源分别写`163.98ns/Entity`，批量一次重算理论上限`87.54ns/Entity`。派生绝对成本很低，当前不增加批量业务API；完整数据见`perf/results/numeric_derivation_latest.md`。

## 2026-08-01：共享启动目录与动态MapHost完整路由

- Runtime进程配置增加`knownSceneFiles`，相对当前配置文件加载共享`{"knownScenes": [...]}`，再与本地Scene和追加目录去重合并；同名异址、同址异名在监听器启动前拒绝。本地拆分配置集中复用`configs/local/cluster/known-scenes.json`。
- MapHost增加`acceptDynamicMaps`，不再拆静态/动态两种服务实现。空`staticMapIds + true`表示纯副本Host；`cluster/dungeon-1.json`作为可直接启动的空载样例。
- MapInstance和PlayerLocation协议携带经过校验的MapHost Endpoint。Gate长期路由、首次进入、重连、下线、Actor消息，MapHost跨图传送及副本销毁全部删除对动态Host静态`byName`的依赖。
- 拆分Runtime smoke额外启动未列入共享目录的`dungeon_1:7310`；Manager成功分配动态实例，玩家完成Map1→Map2→dungeon_1跨进程传送，证明新增副本Host无需修改其他进程配置。

## 2026-08-01：动态地图改由MapManager幂等调度

- 新增单例`MapManagerScene`。MapHost启动后主动注册完整Inner地址与generation，并每5秒上报静态/动态地图数和玩家数；15秒未续租的Host不再参与新副本分配。默认策略依次比较动态实例数、玩家数和Host名称，调用方不再选择MapHost。
- `DynamicMapProxy.Create(requestId, mapConfigId)`成为唯一业务创建入口。Manager只生成一次全局MapInstanceId并固定目标Host，MapHost按指定ID幂等创建和注册Location；并发请求共享创建事务，但每个RPC独立返回自己的rpcId。
- MapHost注册会重报`requestId -> MapInstanceId`关系，单独重启Manager能够恢复。Manager与对应MapHost同时丢失后的跨重启幂等需要后续Redis持久化。本地空图五分钟回收改名为`DynamicMapLifecycleComponent`，避免与中央Manager混淆。

## 2026-08-01：AOI范围与同步档位完全冷配置化

- 明确`AoiConfig`只负责Grid大小、Enter和Detach，`AoiSyncTierConfig`按行定义任意数量的范围与同步Hz；Map通过`aoiConfigId`选择配置。当前默认仍为3×3/20Hz和5×5/5Hz，没有重新启用7×7。
- 增加完整覆盖约束：最外层同步范围必须等于Detach。TS配置生成期和Rust AOI创建期都会拒绝`Detach=7`但同步档位只到5×5的配置，避免单位保持可见却没有普通状态同步。
- 配置自测已验证`Enter=3、Detach=7、3×3/20Hz、5×5/5Hz、7×7/1Hz`能够直接加载，删除7×7档后会按预期失败。该扩展只需修改Luban Excel、完整构建并重启Process，不修改TS或Rust业务代码，也不允许热更。
- Cell边长与Grid边长同样保持冷配置：`MapConfig.cellSizeMeters`决定Cell米制大小，`AoiConfig.gridSizeCells`决定每Grid每边Cell数，地图Grid数量由制作产出的宽深Cell数推导。框架不增加重复的`gridCount`字段；Grid2D尺寸不能整除时在配置生成期拒绝。

## 2026-08-01：3000人AOI Grid密度矩阵

- 新增固定3000玩家的10×10、15×15、20×20世界对照。三档分别平均30、13.33、7.5人/Grid，保持1 MapHost、16 Gate、Rust客户端、2Hz Move、0.2Hz Probe、80% Grid内移动和20%每2秒跨Grid不变。
- 正式稳态结果：Map CPU平均为`74.1%/56.7%/57.3%`，Movement Push为`218.1万/140.9万/107.3万每秒`，Probe p95/p99为`52.81/64.39ms`、`43.90/50.66ms`、`42.78/50.93ms`。三档Move均约6000/s，跨Grid为`299.9/314.5/303.3次/s`，错误、过载、超时、背压和慢连接均为0。
- 可见候选关系从10×10的78.6万降到15×15的36.5万和20×20的21.1万。15×15以后Map CPU基本持平，说明固定6000 Move/s、20Hz Update和每帧编码扫描开始成为主要成本；继续扩大地图只降低扇出，不能消除固定帧成本。
- 稀疏地图初始快照更小，Bench后置`MapCapacityPlace` RPC会更集中释放并把Map帧队列推到4096。该现象发生在正式窗口之前，不是20×20稳态容量不足；一键矩阵固定Map Enter并发8，后续应把Bench速度和停止回血并入进图事务，删除第二次RPC。汇总见`perf/results/map_capacity_grid_matrix_latest.md`。
- 新增`npm run perf:map-capacity:grid-matrix`，一次构建后顺序执行三档并输出独立原始报告及矩阵汇总。

## 2026-08-01：3000人均匀AOI行为基线

- 正式容量基线改为1 MapHost、16 Gate、Rust客户端、3000玩家均匀分布到10×10 AOI Grid，每Grid 30人。人数或世界Grid数变化时仍轮询全部Grid平均放置，不再把全部玩家同屏或完全不跨Grid的轨迹当作默认容量模型。
- 每个Grid内固定24人以1 Cell/s做不跨边界的小闭环，6人以7.5 Cell/s在相邻Grid中心间往返；跨Grid组每2秒换向一次，因此稳定窗口理论产生约300次跨Grid/s。分组按Grid索引和Grid内玩家序号确定，避免20%玩家集中到特定列。容量候选要求实际跨Grid速率达到理论值的80%至120%，否则直接视为负载模型未成立。
- Cold AOI配置收敛为3×3 Enter与20Hz高频区、5×5 Detach迟滞与5Hz低频区；删除7×7可见范围和1Hz档位。跨Grid由服务端20Hz权威移动自然产生，不使用坐标传送伪造。
- 100玩家语义样本覆盖100个Grid、每Grid 1人，其中20人跨Grid：25秒正式窗口实际跨Grid`9.4/s`，达到理论`10/s`的`93.9%`；Move为`200/s`，业务错误、超时、过载和背压均为0。该样本只验证负载行为，不是容量结论。
- 正式3000人、16 Gate、30秒窗口新基线完成：实际Move`6004/s`、跨Grid`310.3/s`（理论值的`103.4%`）、客户端收到Movement Push约`211.6万/s`，Probe p50/p95/p99为`70.93/128.49/156.05ms`；Map CPU平均/p90/峰值为`82.1/95.5/95.5%`，Gate最高平均/峰值为`55.6/65.1%`。窗口内业务错误、超时、过载、背压和慢连接均为0。由于Map平均CPU略高于80%目标，3000人是接近边界的回归基线，不是保守容量点；原始证据固定为`perf/results/map_capacity_20260801_015926.md`，不依赖会被后续测试覆盖的`latest`文件。

## 2026-08-01：3000人进图Admission批量A/B

- 在初始视野与`EnterMap`响应解耦后，使用Windows IOCP、1 MapHost、16 Gate、Rust客户端、3000人瞬时Map Enter、单Grid全可见和完整`full`语义，对`entry_players_per_tick=1/4/8/16`做独立A/B。四档均3000/3000进入成功，业务错误、超时、内部过载、背压和慢连接断开全部为0，证明此前MapHost到Gate的大RPC队列溢出已经消失。
- 每Tick放行`1/4/8/16`人时，Map Enter分别为`150.19/38.03/22.88/18.25s`，吞吐为`19.97/78.88/131.09/164.39人/s`。Probe p95均约`1.3ms`，p99为`7.29/6.89/10.78/9.75ms`；这些Probe位于入场后的5秒短窗口，只用于确认链路没有持续拥塞。
- 提高批量会增加瞬时在途压力：Map广播pending生命周期峰值为`7/56/136/272`，Location确认平均耗时为`7.17/29.62/127.75/284.46ms`。`8`到`16`的入场吞吐只增加约25%，但pending翻倍、Location确认平均耗时增加约123%，边际收益已经明显下降。
- `4/8/16`短测正式窗口都不足两个CPU样本，报告中的单点CPU受到入场尾部污染，不能用于稳态容量比较。正式Cold配置恢复并保持每Tick `1`人；`4`只作为下一轮较长稳态与弱Gate环境复测的候选值，不直接改成生产默认。完整证据见`perf/results/map_entry_admission_ab_latest.md`。

## 2026-07-31：初始视野与进图 RPC 解耦

- 3000 人进图洪峰的责任点进一步确认：Admission Attach完成后，如果每个玩家都把全量 `MapEntitySnapshot` 放进独立 `EnterMap` 响应，MapHost 到 Gate 的下行队列会同时积压；仅提高 `entry_players_per_tick` 会把洪峰推迟到内部发送队列，不能解决根因。
- 新增 `C2G_MapSnapshotReady` 握手。客户端完成地图对象创建和 `G2C_AoiDelta` Handler注册后才发送确认；Gate只校验当前Unit路由，再让MapHost发送初始视野。`EnterMap` 保留玩家坐标、物品和地图空间元数据，不再携带新玩家的大型实体数组。
- 初始视野继续使用既有 `G2C_AoiDelta` 和 `ClientBroadcast`/`ClientBroadcastBatch`，没有增加第二套广播协议。快照暂存归 `MapComponent` 所有，玩家移除和地图销毁时自动清理；发送失败保留暂存，重复确认可重新生成当前权威视图。
- Cocos、PixiJS 和 Rust压测客户端均已接入握手。Rust客户端在正式 `full` 进图模式下会等待初始 `AoiDelta`，因此容量测试不会通过关闭快照来掩盖问题。
- 1000人、16 Gate、Windows IOCP、Rust客户端、单Grid、Probe Only冒烟通过：1000人全部进入，错误/超时/过载/背压/慢连接均为0；Map Enter约19.85人/s，完整进图约50.38s。当前测试点Map正式窗口样本不足，不作为稳态容量结论。初始进入阶段仍可见约49.95万Entity Enter，这是业务真实同屏广播量，下一步应做区域级共享/分批下行，而不是继续放大Admission批量。

## 2026-07-31：进图洪峰分阶段观测与A/B工具

- MapHost新增进图请求、在途峰值、端到端耗时、ID分配、Player创建、Location注册/确认和MapReady阶段指标；Map增加Admission等待、AOI Attach、初始Snapshot对象数，以及AOI Delta批次、接收者和逻辑实体投递量。指标只按Process/Scene/阶段聚合，不使用玩家身份标签，也不为测字节而在TS重复编码protobuf。
- Bench进图协议新增受限`entrySyncMode`，可分别运行Attach Only、新玩家快照、老玩家Enter和Full。普通客户端协议无法设置该字段，正式Gate路径默认Full；前三种模式故意破坏客户端完整状态，只能用于拆分成本。
- 新增`npm run perf:map-entry-stages -- --players 1000 --gates 8`。命令一次构建后顺序运行四组Rust客户端测试，并生成`map_entry_stages_latest.md/json`；Full最后执行，保证通用`map_capacity_latest`最终仍保存完整语义结果。脚本会自动断言四种模式的Snapshot、已有观察者Enter及失败数，避免诊断开关语义回归。
- 1000人与3000人、16 Gate、单AOI Grid、每Tick放行1人的四阶段A/B全部通过。3000人Full在平稳16并发入场下保持约20人/s，产生4498500次可见变化、4504377个Snapshot对象和4498500次老玩家逻辑投递；Snapshot平均/最大6.165/42ms，Map写入345.61MiB、Gate逻辑下行534.38MiB，Probe p95/p99为3.403/5.579ms，业务错误、内部超时、背压和慢连接断开均为0。Attach Only平均0.590ms，说明主要成本位于全量Snapshot和老玩家扇出，而不是Rust AOI Attach本身。
- Rust客户端和容量驱动新增可选`--map-entry-concurrency`两阶段模式：先按`--setup-concurrency`完成Login、Gate连接和LoginGate，再保持socket reader与5秒心跳并单独同时释放Map Enter。直接把`setup-concurrency`设为3000会先制造Windows TCP/Login洪峰并触发`10054`，不能代表Map Admission容量；20人冒烟已验证连接并发4时Map `max in-flight`和队列峰值都能达到20。
- 首次3000人隔离洪峰使Map `max in-flight=3000`、队列峰值2998，但暴露Gate首次进图固定120秒RPC超时与默认最长500秒Admission预算冲突；首次进图、Gate到源Unit的传送调用和跨MapHost目标Commit现统一使用10分钟Admission故障上限。随后又定位到Ping排在长EnterMap的Session mailbox后面，累计等待Promise会占满Gate异步槽并造成误判下线；Ping现由Gate同步控制帧入口提前消费，旧`C2G_PingHandler`已删除，普通业务消息仍走原Handler和mailbox。
- 最终3000人瞬时Map Enter完整通过：连接/Login耗时1.54秒，Map Enter耗时167.52秒，`requests/completed/failures=3000/3000/0`，`max in-flight=3000`，Admission结束队列/峰值`0/2998`，放行/失败`3000/0`。队列平均/最大等待76.99/166.87秒，Snapshot平均/最大10.474/85ms，Map写入351.20MiB、Gate逻辑下行594.00MiB；排空10秒后的Probe约599.6/s，p95/p99为9.656/38.829ms。全部20个Process生命周期均为零业务错误、零内部超时、零过载、零背压和零慢连接断开。该结果证明队列可保住突发请求，不表示线上可以接受167秒Loading；生产仍需限制同时入场人数并为Loading时延建立SLO。
- 进图快照优化先保持协议和业务调用不变：一个逻辑Tick内先完成整批AOI Attach，再按完全相同的可见Unit集合共享快照数组；不同集合之间继续复用已物化的Unit快照。Admission返回快照后，MapHost不再在RPC尾部重复扫描AOI。新增`player_entry_snapshot_builds_total`、`player_entry_snapshot_materialized_items_total`、`player_entry_snapshot_audience_reuse_hits_total`和`player_entry_snapshot_unit_reuse_hits_total`，用来区分逻辑发送条数与实际对象构造条数。该优化不改变新Observer初始全量、已有Observer Enter和Bench诊断模式语义；后续再用`entry_players_per_tick=1/4/8/16`做独立A/B，不能直接把批量参数改成生产默认值。

## 2026-07-31：统一2D移动输入与500ms基线

- Cocos 2D与Pixi/H5统一为“状态变化立即发送、持续移动每500ms保活、静止零周期消息”；失焦、隐藏和地图销毁都会立即清除输入并发送停止，避免遗漏KeyUp后角色继续移动。Pixi此前的周期采样改为方向变化即时上报，Cocos的道具/传送快捷键忽略按键重复。
- 容量、长稳和热更测试的默认Move频率改为2Hz，MapProbe改为0.2Hz（5秒一次）；客户端SDK和两种压测客户端的Gate Ping均确认保持5秒一次。服务端20Hz权威推进和客户端渲染不变。既有5Hz Move + 1Hz Probe容量结果是历史证据，不改写，也不能与新口径直接比较。

## 2026-07-30 - AOI路由帧下沉与3000人稳态回归

针对3000玩家AOI压测补齐了分阶段责任指标：Process队列固定区分`frame/completion/disconnect/shutdown`，Transport过载固定区分`manager_queue/connection_queue/call_writer_queue/send_writer_queue`。容量判定只使用正式窗口Counter增量，避免Setup和入图期历史背压污染稳态；生命周期最大等待与最大深度仍保留用于解释洪峰。重复的单向`scene-overloaded`日志改由指标承载，其他发送错误继续保留日志。

首轮诊断中Map实际只读取约4694 frame/s，Gate `send_writer_queue`累计过载363717次，客户端仅收到约291720 Push/s；该样本在丢工作，不能用于比较CPU。优化先把Rust AOI的相同Audience索引编码改为直接protobuf写入，再让Movement在Attach时登记框架拥有的紧凑Gate routeId，由Rust帧尾直接生成每个Gate完整的`S2G_ClientBroadcastBatch`。TS不再接收大规模recipient数组，也不再按Gate重组和二次编码；通用Numeric、UnitState和即时Event路径保持不变。AOI内部权威整数/Grid集合使用`FxHashMap/FxHashSet`，不用于外部不可信字符串。

最终同口径为Windows、1 MapHost、16 Gate、15×15 AOI Grid、3000玩家均匀位于Grid中央、每玩家5Hz Move、10秒预热、15秒排空、60秒正式窗口。实际Move 14997/s、Push 500678/s，Map CPU平均/p90/峰值为47.7%/52.2%/62.2%，Movement编码平均2.759ms，广播平均1.636ms；正式窗口零业务错误、零Process背压、零Transport过载、零内部超时和零慢连接断开。把delivery route复制进每个Audience元素的实验使CPU和编码耗时回升，已回退；当前保留稠密route bucket方案。证据见`perf/results/map_capacity_latest.md`，它是框架负载回归，不是生产地图人数承诺。

## 2026-07-30 - MapInstance入图节流与3000人基线复核

Rust AOI接入后的同屏压测暴露两类非稳态开销：状态复制曾在没有实际可见性任务时仍等待Promise微任务屏障；批量进入同一出生点又会集中产生近似O(N²)的Attach关系和初始Snapshot。前者已改为仅在真实空间投递在途时等待，2000人同条件Map CPU由66.7%降至40.1%。后者增加每MapInstance独立的隐藏式Loading队列，由Cold `MapConfig.entryPlayersPerTick/entryQueueCapacity`控制逐Tick放行和有界等待；首次进入及传送使用，断线重连跳过。

默认每Tick放行1人后，3000人、16 Gate、5Hz Move、1Hz Probe、单AOI Grid测试完成全部入图，队列峰值16且零失败，Map CPU平均78.8%。但正式窗口仍出现1774次背压，Probe p95/p99为1814/2568ms，因此只能证明Attach洪峰被削平，不能作为合格容量点。容量报告同时修复了遗漏“零背压”过滤的判定错误。

## 2026-07-30 - AOI可见范围、同步档位与冷热配置解耦

地图空间统一使用可配置米制Cell；AOI宽阶段更名为AOI Grid，并由`gridSizeCells`声明一个Grid包含多少个Cell。Rust `AoiWorld`把Enter和Detach迟滞分开：Enter内关系仍由Grid即时推导，只物化已经进入后停留在迟滞外圈的稀疏关系，保持密集同屏的低内存特性。可覆盖Movement再使用独立同步档位，档位只作用于已可见关系；开始、停止和转向强制立即发送。当前Demo为150×150 Cell、每Grid 15×15 Cell、Enter 3×3@20Hz、Detach 5×5@5Hz。

AOI Grid改为从地图最小Cell建立相对原点，避免225 Cell等奇数Grid世界被世界零点切成16列。容量工具新增10×10、15×15、20×20 Grid冷地图矩阵；`grid-uniform`严格把玩家轮询放到每个Grid中央Cell。10×10世界的1000/2000/3000人对应每Grid 10/20/30人；当前默认行为基线进一步加入80% Grid内移动和20%受控跨Grid移动。

拆链路复测发现，1000人纯Move（5k Move/s、约15.9万Push/s）时Map CPU平均68.2%、零背压；1000人纯Probe在1k RPC/s和15k RPC/s时Map CPU分别为6.7%和37.3%，后者p95/p99为3.44/4.45ms。3000人纯Move下，10×10、15×15、20×20世界的Map CPU依次为103%、143%、205%。虽然可见关系随世界扩大由约70.7万降至18.8万，但Gate batch由约2.17万/s升至8.70万/s、每批接收者由14.84降至4.04，证明当前瓶颈是稀疏Audience产生的大量小型内部发送，而不是Probe RPC或Rust AOI查询本身。下一步应在不改变AOI语义的前提下，将同一Tick的多组frame按Gate合并为一次内部批量发送。

容量工具同时修复Rust客户端`--probe-only`仍沿用默认5Hz Move的问题：现在该模式在统一参数层强制`moveRate=0`，报告中`move/s`和`push/s`必须同时为0才可接受。

AOI拆链路结果进一步推动Map到Gate批量投递：Core的`BroadcastTransport`增加可选`SendMany`，旧自定义Transport自动回退逐组`Send`；正式`SceneBroadcastTransport`在同步Tick尾把多个广播作业按Gate重组，通过新增`S2G_ClientBroadcastBatch`一次携带多组接收者和最终客户端frame。Gate保持frame边界逐组下行，不解析业务payload；即时单帧Event继续使用原协议。单元测试覆盖批量能力、兼容回退、跨作业同Gate合并和protobuf二进制往返，单进程/拆分进程Runtime smoke均通过。

3000人纯Move同口径复测中，10×10、15×15、20×20世界的Map CPU由优化前`103%/143%/205%`降为`83.9%/86.6%/91.4%`；20×20内部过载由36,469降为0，广播平均耗时由58.35ms降为17.19ms，客户端收到的Push由约35.2万/s升至52.4万/s。三个点仍存在2,774/3,535/3,797次入口背压，10×10仍有高密度总扇出字节造成的内部过载，因此3000人不能标记为保守容量。

首次矩阵发现旧Bench流程先在公共出生点Attach、再用ActorLocation RPC搬运，建角会制造不属于稳态的临时Enter/Leave并让定位RPC排队超时。现改为Bench Gate RPC计算冷配置出生点，经可信内网字段在Unit创建时预定位；外网正式EnterMap不能提交坐标。定位RPC仅校验并停止每100ms的Demo回血Timer，避免`state-sync-mode=off`仍混入Numeric广播。统一结果见`perf/results/aoi_grid_matrix_20260730.md`：1000@10×10完整通过但Map CPU平均86.1%略超85%目标；2000/3000在正式负载中出现Actor RPC超时，扩大到15×15和20×20虽显著降低可见关系和移动编码耗时，仍未越过3000玩家18k/s入站消息上限。

Luban增加`ConfigTablePolicy`整表策略，生成完整、Hot、Cold三套数据及独立指纹。Item/Player为Hot；Map/AOI/策略为Cold。Rust验证分区可无重叠还原完整数据，TS和构建工具拒绝运行期Cold变化。空间尺寸、范围和频率即使只改数值也必须完整构建并重启Process。

## 2026-07-30 - Phase 4顺序调整

持久化基础从原Phase 4.1调整到Phase 4.5，作为`0.4.x`最后一个基础阶段。当前优先推进地图主链路：`0.4.1` Rust AOI、`0.4.2` NavMesh3D、`0.4.3` Cocos 3D Demo、`0.4.4`怪物与战斗，最后由`0.4.5`完成持久化。旧日志中的Phase 4.1是当时排期记录，不再代表当前执行顺序。

## 2026-07-30 - Phase 4.1 Rust AOI功能链

新增地图实例私有Rust `AoiWorld`：稀疏X/Z宽阶段格推导默认候选与可见关系，只保存业务拒绝覆盖和本帧净变化，TS不再镜像全量关系边。Native X/Z setter只标脏，跨宽阶段格才重算邻域；该宽阶段格后来统一更名为AOI Grid。玩家Attach/Detach与Location提交、Native Unit销毁顺序对齐。Movement、Numeric和UnitState不再默认全地图广播，而是在Rust按最终可见集合分组编码，TS只解析接收者外壳并交给稳定latest频道；多组投递全部成功后才Ack。

首次3000人同Cell诊断在建角阶段暴露复制分组的二次方临时数据：每名玩家的Numeric定时变化会把“每名接收者看到哪些记录”展开成矩阵，Map满核后使EnterMap RPC超时。编码入口改为默认按Subject Cell共享frame与受众列表；仅带业务拒绝覆盖的Subject计算精确受众。该改动已经消除该临时矩阵，但正式容量数据必须等同口径复测通过后再记录。

随后3000人诊断又发现Gate分配热点：原始FNV-1a Rendezvous分数对公共账号前缀相关，12 Gate实测连接数约为94到687。Gate选择器增加32位avalanche最终混合，并新增12000账号、12 Gate、单Gate偏差不超过10%的回归测试。该轮仍未形成有效正式性能窗口。

容量工具现在会在失败时保留Process health诊断，而不是丢弃预热样本。诊断还发现Rust虚拟玩家原先从同一时刻启动周期任务，会在每个Move/Probe周期制造全员同步脉冲；现按UnitId为每种周期负载生成稳定相位，总QPS不变但请求均匀铺开。旧同步脉冲失败结果不再用于容量判断。

AOI状态复制进一步按相同受众合并宽阶段格frame；容量报告补充World、Entity、Grid、候选/可见关系、跨Grid和可见变化速率。900人诊断确认约845次跨Grid/s会产生约6.11万条可见变化/s，旧路径按Subject调度约7437次广播/s并出现背压。新增不可覆盖`G2C_AoiDelta`，把同帧相同受众的Enter/Leave批量发送；Cocos 2D、Pixi和all-in-one/split Runtime smoke均通过。改后900人短窗广播约297次/s、平均约0.95ms且无背压；1000人短窗可跑完但Map CPU约98.1%。最终850人、12 Gate、5Hz Move、1Hz Probe、10秒预热加60秒正式窗口通过：Map CPU平均77.2%，Probe p95/p99为39.05/82.16ms，零错误、零过载、零超时、零背压。该结果是当时的Windows候选，不等于生产MMORPG容量；旧实现A/B与分布式空间负载仍待补充。

普通Rust/TS单测、BroadcastHub多受众Ack测试以及all-in-one、split-process Runtime smoke均已通过。边界冒烟覆盖Enter、Leave、范围外不接收新sequence和重新Enter。正式地图容量A/B尚未完成，当前不记录性能收益。

## 2026-07-30 - v0.4.0 Phase 4.0空间契约

Phase 4从空间契约开始，而不是直接堆叠3D业务。服务端、Native Entity和protobuf统一为地图局部米制`X/Y/Z + Yaw`：X/Z是地面，Y是高度，Yaw为绕Y轴弧度；Grid2D同步迁移到`cellX/cellZ`和`inputX/inputZ`。Cocos 2D与Pixi只在显示边界将X/Z映射到屏幕X/Y，公共SDK不依赖任何引擎向量类型。

Luban `MapConfig`增加`SpatialMode`、三维出生点、Grid/AOI米制Cell及导航资源`asset/version/hash`。Rust按MapInstance创建和释放Grid2D空间状态；NavMesh3D只冻结资源共享和实例生命周期契约，当前启用会明确失败。协议schema lock通过仅供破坏性版本使用的显式命令替换，旧`0.3.10`客户端不得与`0.4.x`混连。

## 2026-07-29 - 静态地图与动态副本统一

地图身份正式拆为模板`MapConfigId`和运行时`MapInstanceId`。静态实例号等于配置号，由所属MapHost读取`staticMapIds`后创建；动态副本由Demo业务`DynamicMapManagerComponent`使用全局ID创建。两者共享MapHost唯一`CreateMap`、MapScene/Component组合、Rust本地索引与销毁路径。MapHost向Location注册实际托管实例并周期重报，`knownScenes`不再复制地图归属。

玩家业务统一调用`player.TransferToMap(instanceId)`，不传MapHost或判断本地/远程。动态副本显式销毁只接受空地图，框架不替业务踢人、保存或选择回退点；连续无人五分钟的回收放在Demo DynamicMapManager作为兜底策略。单进程与拆分进程Runtime smoke继续通过，新增MapInstance目录测试覆盖幂等注册、冲突保护、静态删除拒绝和动态删除。

## 2026-07-29 - 运行时基础能力收口

Entity正式区分可持久业务`Id`与本次生命周期`InstanceId`。新增63位`GlobalIdSystem`，使用永久来源服、时间、Process worker和秒内序列保证合服身份隔离；Runtime配置增加`process.identity`，Watcher在启动任何子进程前检查整套StartMachine中的重复生成槽位。Item协议升级为`uint64`，新建使用新GlobalId，数据库/迁移恢复保留原ItemId。

Timer新增唯一`TimerId`、原样用户参数、主动取消原因和至多一次取消回调；Actor所有权链继续通过mailbox保持顺序，Owner销毁静默清理。TimeSystem补齐墙钟deadline helper。新增Scene范围的FIFO协程锁与同步/异步Event；锁等待和超时已接入Process指标与Prometheus。`test:runtime-foundation`和Rust Watcher测试覆盖核心语义，完整说明见[运行时基础能力](design/runtime-foundations.md)。

## 2026-07-29 - Location路由与跨MapHost传送

新增ordered Location Scene与版本化玩家目录，权威记录包含Unit/account、长期Gate、MapHost/Map实例、Actor InstanceId、revision和`active/moving/removing`状态。注册、迁移和最终下线使用operationId与CAS语义；只知道UnitId的服务端业务通过`MessageHelper`解析一次，Gate普通ActorLocation消息继续使用连接本地缓存，不把Location变成流量中心。MapHost每5秒幂等重报实际持有Unit，可恢复Location内存进程重启后的active目录。

Prometheus自定义指标增加`location_directory`与`actor_transfer_barrier`，分别观察位置数量/状态/冲突，以及迁移屏障数量、排队帧/字节、超时、拒绝、丢弃和过载；标签保持低基数。

同MapHost和跨MapHost传送统一由Gate `EnterMap`发起。Gate必须在第一个`await`前打开每连接有界屏障，Proto `duringTransfer`生成`queue/reject/drop/latest`策略；源PlayerUnit mailbox协调Location Lock、目标Prepare/Commit、Location Commit和源Actor延后销毁。真实smoke发现并修复了“先await解析Location、后开屏障”导致UseItem抢先进入旧Unit的竞态，同时把测试客户端从FIFO响应改为按rpcId多路复用。单进程与拆分进程均验证Map1到Map2传送保持UnitId/Numeric/Item，且并发UseItem只在目标Unit执行一次。

目标已经提交但Location结果不确定时，不允许把缓冲消息重放给旧Actor；Gate拒绝请求并断开连接，Location保留moving诊断态。自动事务恢复、MapHost租约、死亡节点接管、etcd发现和Gate故障转移仍属于后续生产高可用范围。完整语义见[Location路由](design/location-routing.md)和[Entity地图迁移](design/entity-transfer.md)。

## 2026-07-29 - Gate断线重连所有权重构

Gate连接状态拆为一次性`GateSession`与跨连接`GatePlayerRoute`。Login改用账号Rendezvous Hash稳定选择Gate；同账号新连接原子替换connectionId，旧socket迟到的disconnect不会再删除新连接或Map Unit。客户端继续每5秒发送单向`C2G_Ping`，Gate统一记录所有入站消息的`lastReceiveTime`，出站排队时间只用于观测。

普通transport断开现在进入30秒重连宽限。重连通过Actor RPC `SecondEnterMap`取得原PlayerUnit的权威全量快照，不创建Unit、不广播AOI进入、不改绑Gate；Map只清除旧移动输入。宽限或入站心跳超时后，Gate调用带响应的`PlayerOffline`，Map保存玩家、移除Unit并广播AOI离开，随后Gate回收Route。`UnitGateComponent`、传送快照和持久化快照已删除GateSessionId。

新增`test:gate-reconnect`覆盖连接替换、迟到close、收发时间语义、宽限状态机、重复最终下线与多Login稳定选Gate；Actor、协议、持久化和迁移自测同步适配。同进程与拆分进程Runtime smoke均复用原Unit完成重连；`test:gate-timeout-runtime`实际等待32秒后确认旧UnitId 1000被Map移除，再进入创建UnitId 1001。完整设计见[Gate断线重连与最终下线](design/gate-reconnect.md)。

## 2026-07-29 - 地图迁移事务与Developer Tools 0.14.0

同进程迁移改为“准备候选、目录提交、源对象清理”：目标Unit先完成全部Component恢复和Deserialize，`PlayerDirectory.Replace`成功后才销毁源Unit。目标恢复或目录竞争失败会销毁候选并保留旧玩家，避免玩家从两个地图同时消失。

跨进程目标端增加内网`MapTransfer.Prepare/Commit/Abort`协议、可序列化`PlayerTransferSnapshot`、有界幂等暂存和超时回收；协议只进入服务端生成物。当前没有全局Location/Directory，源端协调尚未开放。新增`test:entity-transfer`覆盖回滚、重复请求、载荷冲突和TTL回收。

TiangZ Developer Tools `v0.14.0`已经发布并成为主工程固定依赖，包含生命周期/迁移契约诊断和生成输入索引修复。

## 2026-07-28 - Map1/Map2进程内传送

Phase 4地图链路开始推进。MapHost现在把Map1和Map2按需创建为独立MapScene；玩家在同一Gate Session中再次调用`EnterMap`即可切图。迁移保持UnitId，旧Scene销毁旧Actor并广播离开，目标Scene使用配置出生点创建新Actor InstanceId。

初版把Numeric和Item直接写入玩家迁移DTO，无法让开发者选择组件，随后在本轮内废弃。正式机制由Core Entity统一提供：Component默认不迁移，稳定Model类型显式`@transferable()`并实现同步`ITransfer`后才参加。Numeric、Item各自导出值快照；Position只保留速度、朝向和存活，不带坐标；Gate、Persistence、Native handle和临时组件由目标Factory重建。进程内快照以稳定Model构造器为键，只服务一次Scene切换，不替代持久化记录、跨进程DTO或全局Location。

补充`IDeserialize`二阶段生命周期：`RestoreTransfer`只写回状态，Entity在全部可传送Component恢复后调用一次业务`Deserialize`，用于Buff Timer、派生索引和非序列化缓存等二次加工。Core只负责同步调用顺序和重复调用保护，具体恢复规则留在Hotfix System；未来持久化加载器通过`CompleteDeserialize`复用同一钩子。

补齐生命周期声明契约：Model使用`@lifecycle`按需声明`Awake/OnDestroy/Deserialize`，`@transferable`继续作为迁移能力唯一标记。`codegen:scenes`会检查对应System是否提供同步实现，热更候选提交前再次检查自己的prototype，缺方法或异步实现会拒绝整包并保留旧generation；未声明能力仍不要求空方法。新增生成负例与Hotfix回滚自测。

Cocos Web/Native和Pixi/H5均增加`T`键切换Map1/Map2，客户端等待RPC与`MapReady`后重建地图及消息Dispatcher。Runtime smoke增加传送断言，覆盖UnitId、目标出生点、背包版本和Numeric不回退。跨MapHost/跨进程事务与动态副本Directory保留后续实现。

## 2026-07-28 - 后续容量规划调整

自动容量推荐与部署参数生成延后到Phase 5。当前业务负载尚未覆盖Rust AOI、怪物、战斗、Buff、任务和持久化，现阶段根据Probe或全地图可见Move测试推导正式在线人数会产生错误承诺。

保留`perf:gate`作为框架热路径回归门，保留`perf:map-capacity`作为特定拓扑与负载的版本化证据；二者暂不自动生成Map准入人数、Gate数量或Process数量。后续容量规划必须在代表性业务链路具备后，按不同负载模型分别校准，并把CPU、吞吐、p95/p99、队列趋势、错误和安全余量共同纳入结论。

## 2026-07-28 - v0.3.10

`0.3.10-rc.1`冻结提交为`d31437c`，运行时代码、Stable API、协议指纹和Native Schema在正式版本中保持不变。Windows完整`npm run verify`耗时350.2秒，制品构建与目录内smoke耗时63.1秒；Windows制品包含28个文件、27条SHA-256，约49.1MiB。

Linux使用Git Bundle从同一提交创建干净克隆，`npm ci`耗时29秒且0个漏洞，npm/Cargo联合审计为0个漏洞、0个例外；完整`verify`耗时约295.3秒，制品构建与目录内smoke耗时147.7秒。Linux制品同样包含28个文件、27条SHA-256，约70.6MiB，哈希逐项校验通过。

最终矩阵覆盖codegen幂等、Stable API、Model/Hotfix边界、协议锁、TypeScript与Rust测试、Clippy、真实拆进程、ordered/unordered mailbox、背压、Watcher优雅停机、Hotfix Reload和慢RPC切换屏障。Windows仍会报告已知MSVC `LNK4098 libcmt.lib`警告，但没有链接失败或测试失败；该警告继续作为构建工具链事项跟踪，不阻塞本次发布。

`v0.3.10`是Phase 0至Phase 3.10的稳定框架基线，不等于完整商业MMORPG产品。后续容量规划、AOI、动态副本与业务系统使用新版本演进，不回写本Tag。

## 2026-07-28 - v0.3.10-alpha.9

### 本次目标

把Item、Buff、动态Quest和Achievement等“Component拥有的多个实例”收敛为框架级子Entity语义，同时验证新增生命周期索引不会成为性能瓶颈。

### 完成内容

- Stable Core新增`ChildEntity`以及`AddChild/GetChild/TryGetChild/GetChildren/RemoveChild`，统一Parent、DomainScene、InstanceId、EntityRoot、Timer与级联销毁。
- ChildEntity明确没有mailbox、Actor路由和网络地址；挂在Unit下的Timer仍经过所属Unit mailbox串行。
- Item从ItemComponent私有Map和伪InstanceId迁移为真实ChildEntity；每个Item拥有自己的NativeItemRef，局部规则与集合规则分别位于ItemSystem和ItemComponentSystem。
- 创建失败、异步Awake拒绝、重复Id、Timer取消、Root清理、Component/Actor级联销毁和Hotfix System候选均加入自动测试。
- 新增`npm run perf:child-entity`，独立测量框架对象语义，不把AOI、Native、protobuf和网络混入结果。
- 新增`docs/patterns`领域设计知识库，使用稳定规则编号描述所有权、Entity形态、Audience、同步、生命周期、Timer与数据位置。
- TiangZ Developer Tools `v0.13.0`增加确定性`design-core`、业务系统设计向导、`@tiangz`解释入口、CLI与只读MCP服务；AI不改变规则结论，也不自动修改业务代码。
- Developer Tools `v0.13.0`已发布Tag并成为主工程固定依赖；新增`verify:design-rules`交叉检查24条稳定规则及其领域文档归属。

### 性能验证

Windows Node 24、单进程、100,000个纯TS ChildEntity、1,000,000次随机查询：创建约47.24ms（2.12M/s），查询约92.93ms（10.76M/s），稳定数组遍历约4.15ms，销毁约22.80ms（4.39M/s），保留V8 Heap约506字节/实例。该结果只说明容器和生命周期开销可控，不能推导地图或AOI容量。

### Windows Release候选预演

2026-07-28在Windows x64完成`0.3.10-alpha.9` Release候选预演。依赖审计耗时26.3秒，完整`npm run verify`成功轮耗时231.0秒，`release:package`耗时43.8秒；稳定完整流程合计301.1秒，约5分01秒。

首轮`verify`在228.4秒发现Hotfix反转移动夹具漏装配新增的`ItemSystem`，候选预检正确拒绝不完整generation。补齐夹具后，针对性Reload测试用22.8秒验证5个Process两次切换到generation 3并拒绝损坏候选，随后完整`verify`重新通过。

最终制品`TiangZ-0.3.10-alpha.9-win32-x64`包含28个文件、27条SHA-256，约49.1MiB；在制品目录完成登录、GateSession重建、Numeric Timer、Item Event、权威移动与多人Entity生命周期smoke。Windows验收通过，Linux同版本Release候选仍待执行。

### Linux Release候选预演

2026-07-28在Ubuntu x64虚拟机完成同版本预演。使用Git Bundle克隆精确对象，避免Windows工作树`core.autocrlf`污染跨平台候选；`npm ci`耗时约25秒且0个已知漏洞，修复后完整`npm run verify`耗时142.7秒，`release:package`耗时165.8秒。稳定完整流程约333.5秒，即5分34秒。

首轮Linux运行时smoke暴露了Windows时序下未稳定复现的断线/重进竞态：新`EnterMap`缓存旧Unit后，旧连接恰好完成Actor销毁。MapHost现在只在权威账号目录确认旧实例已经消失时重新解析并重试；其他Handler异常仍原样抛出。同期修复RPC系统错误响应构造，错误包先从生成Codec创建完整默认对象，再写入`rpcId/error/message`，避免带repeated字段的响应在错误路径二次编码失败。

完整验收还发现背压脚本早于五秒指标采样周期读取`/metrics`。测试现等待首个真实队列快照，最长7秒，不修改生产采样周期。Linux背压实测队列容量64、最大深度64、背压等待8962、慢连接误断开0。最终制品`TiangZ-0.3.10-alpha.9-linux-x64`包含28个文件、27条SHA-256，约70.6MiB；哈希与制品目录smoke均通过。

### 设计决定

- Unit是带mailbox的地图Actor；Item/Buff/动态Quest是Component拥有的本地ChildEntity。是否需要被AOI看到不决定它是否是Actor。
- Buff采用生命周期事件而不是通用dirty Delta：创建广播Add、删除广播Remove，进入AOI时随Unit整体Snapshot发送；Tick只执行Action，产生的Numeric、Move等变化由对应领域同步。
- QuestComponent只为进行中任务持有Quest子Entity；完成时记录稳定配置ID并删除实例。任务进度默认只同步本人，组队共享通过显式Party受众发送摘要，不进入地图AOI。
- 少量子Entity可直接持有Timer；大量Buff由BuffComponent按`nextTickAt/expireAt`合并调度，避免每个Buff常驻重复Timer。
- `GetChildren`返回数组快照，只用于低频管理、保存和全量同步；高频帧尾路径必须维护dirty集合或紧凑索引。

## 2026-07-28 - v0.3.10-alpha.8

### 本次目标

验证 Rust 权威实体数据从通用 Handle Arena 迁移到类型分池、冷热分离后的收益，并减少帧尾状态编码与广播路径中的临时分配。同时补齐可观测指标和可重复执行的性能基准。

### 完成内容

- `.native` 增加实体存储和字段温度描述，由 codegen 生成 `NativeEntityPools`、类型 Pool、Unit 热/冷数据结构以及 TypeScript NativeRef 操作。
- Unit 与 Item 进入独立紧凑 Pool；Unit 的高频字段与低频字段分离存放。Rust 仍是权威数据源，TypeScript 只持有带 generation 校验的句柄。
- 帧尾移动快照直接编码到最终输出缓冲，复用 handles、records 和编码 scratch，避免逐玩家临时 `Vec` 与 Rust -> TypeScript -> Rust 往返。
- health/Prometheus 增加活跃 Entity、Unit、Item，Pool/Scratch 容量与增长次数、TypeScript NativeRef 数量、Native 编码吞吐等指标。
- 新增 `npm run perf:native-storage`，独立比较 Handle Arena、类型分池和 Unit 冷热分离。
- Map 容量工具在普通测试中也为每个 Process 启用临时 health 端口，直接采集 CPU、RSS、V8、Transport、NativeData 和广播指标；累计计数按正式窗口差值换算速率。
- TiangZ Developer Tools 升级到 `v0.12.0`，Native Language 升级到 `v0.14.0`，补齐 Model 稳定字段和 `.native` 存储语义支持。

### 性能验证

Native 数据布局微基准：50,000 Unit、每 Unit 10 Item、Release 构建，5 轮取中位数。

| 布局 | 更新吞吐 | 估算存储 | 相对前档 |
|---|---:|---:|---:|
| Handle Arena | 78.27M Unit/s | 323.5MiB | - |
| UnitPool + ItemPool | 175.81M Unit/s | 42.0MiB | +124.6% |
| UnitHotPool + UnitColdPool | 617.02M Unit/s | 42.2MiB | +251.0% |

完整游戏链路三轮基线：Windows IOCP、1 MapHost、16 Gate、3000 玩家、每玩家 5Hz Move + 1Hz MapProbe。

| 指标 | 三轮中位数 |
|---|---:|
| Map CPU | 47.5% |
| 最忙 Gate CPU | 56.6% |
| Move | 14,998/s，达标率 100% |
| Push | 59,913/s |
| Probe p95 / p99 | 175.76 / 229.85ms |
| 业务错误 / 内部超时 / 慢连接断开 | 0 / 0 / 0 |

边界探索中，3500 玩家时 Map CPU 为 60.1%，最忙 Gate 平均/峰值为 74.2%/83.3%，Probe p95/p99 上升到 473/633ms。4000 玩家在入图阶段因全地图可见快照形成瞬时下行洪峰，触发 Gate 慢连接保护，未进入正式测量窗口。

3000 玩家稳态复核中，帧尾 scratch 容量约 0.2MiB，正式窗口 `scratch grows/s` 为 0；进程启动后的累计扩容发生在容量爬升阶段。

详细结果见：

- [Native 数据布局最新报告](../perf/results/native_storage_latest.md)
- [Map 容量最新报告](../perf/results/map_capacity_latest.md)
- [Map 容量测试说明](../perf/map_capacity/README.md)

### 设计决定

- 保留 `.native` 作为存储意图的唯一描述源，业务开发者不手写 Rust Pool 和 FastOp 胶水。
- 当前不引入 Bump allocator。帧尾 scratch 在稳态没有继续扩容，新增分配器的生命周期约束和维护成本高于可证明收益。
- 3000 玩家作为当前全地图互相可见模型的可重复基线；3500 是压力边界，不作为舒适容量承诺。
- 4000 人首先暴露的是入图全量状态与下行扇出问题，而非 Map CPU 上限。该问题应由后续 Rust AOI、分批入图快照和明确的客户端延迟 SLO 处理，不能通过放宽慢连接保护掩盖。

### 遗留问题

- 在 Rust AOI 落地后重新测量入图快照、增量广播和单 Map 容量。
- 为容量候选增加明确的 Probe p95/p99 SLO，避免只按 CPU 和错误数判断。
- Linux 环境补充 epoll/io_uring 同口径验证；本次数据只代表 Windows IOCP。
# 2026-07-28 - Phase 4.1持久化方案排期

- 持久化基础延后到Phase 4.1，在正式账号、角色和经济业务之前实施，当前不改Runtime代码。
- 计划使用可分片Rust `PersistenceProxy`；业务继续依赖Repository和领域Component，不直接连接Redis或永久数据库。
- `.native`未来按Entity/Component声明`transient/snapshot/transactional`。普通快照自动标脏、合并写Redis并异步落库；经济事务以永久DB为唯一权威，Redis只缓存带版本的事务结果。
- 同一字段禁止同时拥有Redis和DB两条权威写路径，版本按存储域隔离；第一版只实现一种永久数据库Adapter。

# 2026-07-28 - Luban游戏配置基础

## 目标

在进入完整MMORPG业务前建立统一静态配置链路，先覆盖道具、地图和玩家初始模板，并避免把策划数值、部署JSON和运行时持久化数据混在一起。

## 完成内容

- 固定引入Luban 4.10.2官方CLI及MIT许可证，生成过程不依赖在线下载。
- 新增`game_config` Excel源目录和`ItemConfig`、`MapConfig`、`PlayerConfig`三张表；玩家模板只含创建时基础值，不承载升级后状态。
- 按`c/s`生成服务端和客户端不同字段集合，使用`#ref`验证初始地图与初始道具引用。
- 生成只读`GameConfigs`入口及配置指纹，并随公共Client SDK自动分发到Cocos和Pixi。
- Demo的地图尺寸/出生点、玩家HP/速度、初始道具和道具回血改为读取配置；Rust地图移动边界由Map配置注册。
- 增加`test:game-config`，覆盖查询、缺失ID、外键、分端裁剪、只读对象和双端指纹一致性。

## 设计决定

- `configs`只负责部署，`game_config`只负责游戏静态数值。
- 配置结构属于不可热更Model；纯数据从Model Bundle拆出为带schema/data指纹的完整快照，可由Watcher在线切换。
- 业务只依赖`GameConfigs.Get/TryGet/GetAll`，不直接读取Excel、Luban JSON或Generated内部类。

## 数据热更补充

- `build:game-config`发布内容寻址的完整候选，Rust先校验文件哈希和Model schema，TS再构造、冻结并验证全部表，最后一次性替换当前快照。
- 失败候选不会污染当前快照；Prometheus暴露成功/失败次数、提交耗时、总耗时和当前数据指纹。
- Watcher新增`reload-config`，`npm run dev`同时监听Hotfix与游戏配置源文件；Release制品携带初始`dist/game-config`。
- 已增加5 Process真实Reload验收：有效数据全部生效，悬空引用候选全部拒绝且旧指纹保持。
- 当前只在线切换服务端配置；客户端配置仍通过Client SDK发布。跨机器Process可能短暂处于不同数据版本，后续有严格全局一致需求时再增加prepare/commit协调。
# 2026-07-31 - AOI业务Audience与字段Projection

## 完成内容

- 新增只包含有序去重UnitId的`ClientAudience`，提供`Self/ForUnits/Union/Intersect/Except`；业务不再接触Gate route、连接和物理`BroadcastAudience`。
- `MapAoiComponent`增加方向明确的`ObserversOf(subject)`与`VisibleSubjectsOf(observer)`；Rust暴露反向Observer查询，不在TS维护AOI关系镜像。
- `ClientBroadcast`统一完成本地图Gate直取、跨地图Location批量解析、短期有界缓存以及BroadcastHub投递。
- 用Buff验证字段Projection：公开Add/Remove是不可覆盖Event，吸收量详情只发自己/队伍并以`(unitId,buffInstanceId)`做latest覆盖；普通AOI玩家不能收到详情字段。
- TypeScript Client SDK新增引擎无关`BuffStateStore`，Cocos 2D和Pixi分别使用独立Handler接入；revision墓碑阻止移除后的迟到详情复活Buff。

## 验证

- 项目依赖检查、协议、广播、Client SDK、Cocos 2D、Pixi、Rust AOI和NativeData测试全部通过。
- Audience微基准以两组各3000个UnitId做20000次Union：约21238次/s，约7.85ns/输入ID；该操作用于低频Event或小型关系受众，不替代Movement Rust热路径。
- 3000玩家、16 Gate、15x15 AOI Grid、每玩家5Hz Move、60秒正式窗口复测：15000 Move/s、511810 Push/s，Map CPU平均/p90/峰值48.3%/57.1%/69.6%，零背压、零过载、零超时。首次受环境干扰的运行出现619次frame等待，已按规则判无效并由无背压复测替代。

# 2026-07-31 - AOI密集迟滞分组优化

## 问题与改造

- 定位到密集人群离开Enter范围但仍处于Detach迟滞带时，旧Movement编码会为每个Subject重新扫描全部Observer，形成永久`O(subject × observer)`重复工作。
- Rust AOI新增增量Audience签名，按`Subject Grid + Audience签名 + force`共享一次最终受众计算，再按最终Audience合并编码；业务协议、Enter/Detach与方向性过滤语义不变。
- 跨Grid更新改为一次收集旧Detach与新Enter候选，并在同一遍历中处理两个可见方向；候选HashSet与每Tick坐标变更Vec复用容量。
- Prometheus和容量报告新增`aoi_lingering_relations`与`aoi_rejected_relations`Gauge，用于区分普通同屏、迟滞膨胀和业务过滤压力。

## 验证结论

- 3000人密集迟滞Rust微基准中，受众分组由约640.5ms/次降到1.05ms/次；临时计时代码未进入仓库，正式测试覆盖受众等价与业务过滤拆组。
- 最终Release复测使用3000玩家、16 Gate、`single-grid`、2Hz Move、0.2Hz Probe：Move 5981.8/s（99.70%），Map CPU平均/p90 39.25%/44.17%，Probe p95/p99 243.15/425.09ms；玩家始终位于1个AOI Grid，迟滞关系和跨Grid均为0，正式窗口零背压、零内部过载、零超时和零慢连接断开。
- `same-point`以普通玩家10 Cell/s制造高频跨Grid，2000人可达到约1034次跨Grid/s并形成百万级迟滞关系，仍会触达Map输入队列上限。该场景测的是`跨Grid次数 × 可见人数`，不能替代稳定同屏容量基线。
- 一次3000人复测在正式窗口前因初始AOI快照洪峰触发Gate慢连接保护，随后相同历史参数复跑通过；失败样本保留为setup期下行洪峰证据，不计入正式容量。
# 2026-08-01：Phase 4.2.2 NavMesh3D运行时与Cocos灰盒

- Map 100按Cold `MapConfig.navigationAsset/version/hash`真实启动；Rust只读`dtNavMesh`按Hash共享，`dtNavMeshQuery`按MapInstance隔离，资产路径被限制在项目`navigation/`目录。
- 增加`SpatialCreateNavMesh3D/SpatialProjectPosition/SpatialFindPath`粗粒度FastOP，TS `MapComponent`开放`ProjectPosition/FindPath`，NavMesh出生点先投影再创建玩家。
- 新增`C2M_FindPath` Actor RPC和普通`NavigationPathPoint`协议结构；Handler只调用`PlayerUnit.FindPath()`，不持有空间数据，也不修改权威坐标。
- Cocos Creator 3.8.8工程增加可运行灰盒：公共SDK登录Map 100，核对空间模式与资源指纹，点击地面请求Rust路径并沿拐点做本地预览。
- 单进程与拆分进程Runtime smoke均完成Map 100真实传送；灰盒出生点移至中央障碍外的`(-12, 1, -12)`，运行时会投影到NavMesh表面。完整3D权威移动、多人同步、射线、高度和动态障碍仍是后续工作。
- Phase 4.2.3新增`C2M_NavigateTo/G2C_EntityNavigate`：Rust从权威坐标寻路、保存路径进度并以20Hz推进连续位置，TS每次目标只跨一次Native边界。3D状态复用AOI分档和Gate批量路由；Cocos 3D完成本地预测/纠偏、远端插值和独立消息Handler。真实双客户端冒烟确认移动者与观察者收到相同权威状态；射线、高度和动态障碍继续保留后续。
- 增加`C2M_NavigateInput`和魔兽式灰盒操作：W/S前后、A/D转向、右键+A/D横移、右键拖动朝向及平滑尾随相机。Rust把方向换算为短NavMesh路径，500ms续期，零输入强制停止；底层回归覆盖推进、保留朝向和停止状态。
- Phase 4.2.4把方向移动改为Rust每Tick调用Detour `moveAlongSurface`，按Unit缓存polygon引用，不再每500ms完整寻路；新增NavMesh `Raycast/SampleHeight`粗粒度API。回归覆盖撞墙、沿墙移动、射线和高度采样，Cocos改为连续本地输入预测并继续接受权威纠偏。
# 2026-08-03：UE 5.4.4 C++ Client SDK与灰盒Demo

- 增加引擎无关C++20 Client SDK，Proto生成结构、轻量Codec、msgcode和类型化RPC/Push描述符，不依赖Google protobuf runtime；codegen把完整头文件副本分发到UE Runtime插件。
- UE 5.4.4插件实现WebSocket Transport和游戏线程Update；Demo贯通LoginMgr、Login、Gate、Map 100、AOI、Numeric、权威Navigate与5秒Gate Ping，并完成米制Y-Up到厘米制Z-Up的边界转换。
- UE Automation覆盖嵌套消息、正负64位整数、RPC ID、未知字段和截断包。真实Runtime冒烟已进入Map 100；开发机固定使用UE 5.4推荐的MSVC 14.38工具链。
- Flat AOI Grid要求地图宽深Cell数能被Grid边长整除，Map 100由48×48调整为60×60；游戏配置生成现在会在写出Generated前拒绝未对齐地图，不再拖到Runtime启动才失败。

# 2026-08-03：Phase 4.2.5动态导航障碍

- 导航资源由只含`dtNavMesh` Tile的v1升级为v2压缩高度层模板；`DetourTileCache`正式进入构建。共享缓存按Hash复用模板，每个MapInstance独占`dtNavMesh + dtTileCache + Query`，相同地图模板的副本障碍互不污染。
- Rust增加稳定地图内`ObstacleId`、同ID目标状态合并和盒形障碍增删；Map固定Tick每次最多应用16条命令、重建4个Tile。地图销毁会连同等待命令、障碍、TileCache和查询上下文整体释放。
- 障碍更新完成后递增Rust空间版本，正在执行的点击路径从权威位置到原终点自动重算；方向输入继续通过最新NavMesh表面推进，不会沿旧走廊穿过新关闭的门。
- TS只开放`MapComponent.UpsertNavigationBoxObstacle/RemoveNavigationObstacle`，不暴露Detour引用。Map自定义指标增加障碍数量、等待命令、更新次数、重建Tile、耗时和失败。
- Cocos 3D灰盒增加`E`键动态门和演示RPC。all-in-one与split-process真实Runtime均验证开门2个拐点、关门4个拐点、再次开门恢复2个拐点；Rust单测另覆盖幂等、实例隔离、主动路径重算和地图释放。
- UE 5.4.4灰盒复用同一个`Map.ToggleDemoDoor`协议：`FTiangZLoginFlow`提供类型化调用，GameMode以`E`键切换与Cocos同坐标的红门，并只在服务端响应后更新Actor表现；UE本地碰撞不参与权威导航。
- 动态盒障碍改为由Rust按烘焙`agentRadius`统一扩大X/Z导航占用，业务仍提交真实物理尺寸；Cocos方向预测对已确认关闭的演示门增加非权威视觉约束，UE继续只插值服务端权威位置，避免两端重复实现碰撞规则。

# 2026-08-03：Godot 4.7.1 3D客户端演示

- 在用户创建的`client_demo/godot-3d-4.7.1`空工程中加入GDScript WebSocket适配层、Proto读取器和Map 100灰盒场景。
- Godot Demo贯通LoginMgr、Login、Gate、Map 100、`G2C_EntityNavigate`、基础AOI、5秒Gate Ping、点击寻路、W/S方向移动、A/D转身和`Map.ToggleDemoDoor`。
- Godot与TiangZ米制Y-Up坐标直接对齐；表现层只平滑服务端权威位置，不复制Rust NavMesh、TileCache、Agent半径或动态碰撞。
- Godot协议层已接入`codegen:godot-client-sdk`：从Proto锁文件生成`client_demo/godot-3d-4.7.1/scripts/generated/tiangz_proto.gd`，客户端只手写连接流程、RPC编排和表现适配；TCP/KCP Adapter仍留作后续工作。

# 2026-08-03：Phase 4.4最小怪物业务闭环

- 新增Luban冷配置`MonsterConfig`和`MonsterAreaConfig`。前者描述模板、模型标识、基础数值和主动/被动模式，后者一行对应一个固定刷怪槽位，包含出生点、尸体保留时间、重生时间和初始生成开关。
- `MapHostComponent`在静态地图和动态副本中统一挂载`MonsterComponent`；怪物使用统一`UnitComponent`里的`MonsterUnit`，不创建独立Actor、Gate连接或额外V8。AOI只登记怪物为Subject，玩家进入视野收到`entityType=2/configId`快照。
- Map固定Tick统一处理主动怪追击、攻击间隔、玩家攻击、Numeric扣血、死亡、尸体Detach/Remove和原刷点重生；被动训练木桩只作为目标，不主动追击。没有为每个怪物创建长期Timer。
- 新增`C2M_AttackMonster/M2C_AttackMonster`，调用链固定为`Handler -> PlayerUnit.AttackMonster -> MonsterComponent.Attack`。Handler不遍历地图、不直接操作Native句柄；掉落、技能、仇恨、持久化和角色/怪物动态避障不属于本阶段。
- 真实Runtime smoke覆盖地图2训练木桩：初始快照、12次攻击至死亡、尸体AOI Leave、原槽位重生和重生HP恢复。详细开发入口见`docs/tutorials/16-monster-module.md`。

# 2026-08-04：Unity 2022.3 C# Client SDK与3D灰盒

- 增加引擎无关C# Client SDK源码目录`client_sdk/csharp`，包含二进制帧、protobuf轻量Codec、WebSocket RPC、Push注册、主线程`Update`队列、超时、断线和入站背压处理。
- 新增`codegen:csharp-client-sdk`，从协议/schema/opcode锁生成C#消息、Codec、RPC/Push描述符和类型化`LoginMgrClient/LoginClient/GateClient/MapClient`，并复制到Unity `Assets/TiangZClient/Runtime`；Generated文件禁止手改。
- Unity 2022.3空工程加入`TiangZUnityDemo`，使用默认场景完成LoginMgr -> Login -> Gate -> Map 100、AOI初始快照、权威点击寻路、WASD移动、远端插值和5秒Ping；SDK本身不引用UnityEngine。
- `dotnet build client_sdk/csharp/TiangZ.Client.csproj`已通过，0警告、0错误；Unity批处理复核受当前编辑器已占用同一工程影响，未强行关闭用户进程，需关闭编辑器后再做独占批处理验收。
## 2026-08-04：怪物基础行为树与两米普通攻击

- 怪物AI在`app/hotfix/demo/monster/MonsterBehaviorTree.ts`增加局部行为树，仅包含待机、追击、攻击和攻击冷却停留；它不提供通用AI编辑器，不创建MonsterActor、长期Timer或独立V8。
- `MonsterComponentSystem`继续负责目标查询、导航意图、攻击间隔、Numeric扣血和死亡；行为树只选择动作。该历史版本的玩家与怪物普通攻击距离统一限制为最大2米，后续已改为分别读取`PlayerConfig.attack_range`和`MonsterConfig.attack_range`。
- 没有新增技能、Buff、仇恨表、巡逻路点、战斗事件协议或Rust业务模块；新增纯逻辑自测`npm run test:monster-behavior`。

# 2026-08-05：CombatComponent统一伤害入口

- 将玩家和怪物的受伤入口统一到`CombatComponent.ApplyDamage`，治疗统一到`ApplyHealing`；`MonsterComponentSystem`和`C2M_UseItemHandler`不再直接修改`NumericType.CurrentHp`。
- 增加数据型伤害吸收处理器注册、更新、查询和注销API。护盾、装备或技能可以注册处理器，Combat只按优先级和稳定ID消费，不知道效果来源，也不查询`BuffComponent`。
- 怪物创建时挂载CombatComponent；普通攻击返回实际扣血结果，怪物仇恨只记录最终伤害，死亡标记和移动停止由Combat统一完成，地图业务继续负责Detach/Remove/重生。
- 新增`docs/design/combat-damage-pipeline.md`，并同步开发手册、项目上下文、路线图和怪物教程，明确攻击者侧规则、目标侧结算、Buff生命周期和广播边界。
- 新增`tools/combat_self_test.ts`，覆盖多护盾优先级、剩余量更新/注销、实际扣血、治疗上限、非法输入以及“没有BuffComponent也能结算”的解耦验证。

# 2026-08-06：道具驱动的Action与Buff最小闭环

- 新增`ActionType`和`ActionExecutor`，统一支持`None`、`ChangeNumeric`、`AddBuff`、`RemoveBuff`；道具不再直接写HP，HP变化经过`CombatComponent.ApplyHealing/ApplyDamage`。
- 新增`BuffComponent`与`Buff` ChildEntity。单个Buff拥有Add/Tick/Remove生命周期和可追踪Timer，Component负责实例ID、集合所有权、AOI事件和跨地图纯值快照。
- 新增Luban `BuffConfig.xlsx`，扩展`ItemConfig.use_effect/use_params`；小型生命药水立即恢复50点，大型生命药水添加30秒、每3秒恢复50点的Buff。删除旧的直接`restore_hp`业务路径。
- PlayerTransferSnapshot升级为schema 3，Buff传送只保存配置、层数、版本和墙钟时间，不保存TimerId、Promise或Hotfix闭包；目标恢复时不重复执行AddAction。
- 固定解耦边界：Combat不查询Buff，Buff通过生命周期注册/注销Combat修改器；Buff Tick只执行Action，广播由Map/Audience负责。Cast技能系统、复杂目标选择和Buff持久化留到后续阶段。
- 新增`docs/design/action-buff.md`、`docs/tutorials/17-action-and-buff.md`和`tools/buff_action_self_test.ts`，覆盖立即Action、Buff Tick、幂等移除和Timer生命周期。
