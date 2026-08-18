# 游戏配置源文件

这里存放策划直接维护的Luban Excel。`configs/`只负责机器、Process、Scene和端口部署，两者不得混用。

第一批配置：

- `ItemConfig.xlsx`：道具静态定义。
- `MapConfig.xlsx`：空间模式、米制地图尺寸、三维出生点、AOI引用、入图节流和导航资源身份。
- `PlayerConfig.xlsx`：玩家初始基础值，包括HP/MP；不描述升级后的等级成长。
- `MonsterConfig.xlsx`：怪物模板、最大生命值、基础攻击力、米/秒移动速度、独立普通攻击距离、攻击间隔毫秒、攻击模式和死亡复活秒数。
- `MonsterAreaConfig.xlsx`：固定刷怪槽、地图坐标和地图创建时是否生成；不保存尸体时间或复活时间。
- `BuffConfig.xlsx`：Buff模板、持续时间、Tick间隔、冲突/刷新策略、仅服务端使用的详细策划说明，以及添加/Tick/移除时执行的Action。
- `SkillConfig.xlsx`：技能目标关系、读条、CD/GCD、距离、弹道、移动和平A策略；客户端与服务端共享。
- `SkillEffectConfig.xlsx`：技能命中后按顺序执行的Action；仅服务端生成，客户端不能读取伤害和Buff结算规则。
- `QuestConfig.xlsx`：任务名称、说明、目标列表、奖励Action和Demo自动接取开关。
- `QuestObjectiveConfig.xlsx`：任务目标类型、目标配置ID和要求数量；目标与任务分表，避免把变长结构塞进一个单元格。
- `DropTableConfig.xlsx`：怪物尸体掉落行；普通掉落和任务资格掉落共用一张表。

修改Excel后运行：

```bash
npm run build:game-config:startup
npm run test:game-config
```

`build:game-config:startup`会重新生成并覆盖服务端重启使用的`dist/game-config`；服务器重启后才会读取新的配置。若要在线热更，改用`npm run build:game-config`，它只生成`dist/game-config-candidates/<指纹>`，再在Watcher中执行`reload-config <候选目录>`。`test:game-config`只验证生成结果，不会更新`dist/game-config`。

生成文件全部位于`app/generated/model/config`、`client_sdk/typescript/Generated/Config`和`game_config/generated`，禁止手工修改。字段分组使用Luban约定：`c`仅客户端、`s`仅服务端、`c,s`两端共享。

- 表、字段、类型、分组和引用关系属于Model，修改后必须执行完整`npm run build`并重启Process。
- 只改行数据或字段值时，在线热更使用`build:game-config`并在Watcher终端执行`reload-config <候选目录>`；准备重启服务器则使用`build:game-config:startup`更新`dist/game-config`。
- `npm run dev -- configs/local/cluster/StartMachine.json`会监听Excel并自动生成、校验和切换。
- Cocos/Pixi配置仍随Client SDK构建和发布，服务端切换不会修改已运行客户端中的数据。

`MapConfig.spatial_mode`当前支持`Grid2D`与`NavMesh3D`。Grid2D必须填写`width_cells/depth_cells/cell_size_meters`；NavMesh3D必须填写`navigation_asset/navigation_version/navigation_hash`，其中哈希为小写SHA-256。`entry_players_per_tick`限制单个MapInstance每逻辑Tick完成AOI Attach的人数，`entry_queue_capacity`限制仍在Loading中的等待人数；它们属于Cold地图容量配置。坐标采用米制X/Y/Z，X/Z为地面、Y为高度；完整契约见[地图空间与3D坐标契约](../docs/design/spatial-world.md)。

## Item、Action、Buff、Skill与Quest

`ItemConfig.use_effect`决定道具是否可用以及使用后执行哪种最小效果：

| `use_effect` | 含义 | `use_params`格式 |
|---:|---|---|
| `0` | 不可使用 | 空数组 |
| `1` | 给使用者添加Buff | 一个`BuffConfig.id` |
| `2` | 执行一个Action | `[ActionType参数...]`；例如`Heal(50)`写作`6,50` |

当前演示道具：小型生命药水使用`Heal(150)`，大型生命药水使用`AddBuff(2001)`，小型法力药水使用`ChangeNumeric(CurrentMp, +150)`。三者的`cooldown_ms`均为30000，`global_cooldown_ms`均为1000；药品自身CD按`ItemConfigId`独立，公共CD与技能共享并由服务端原子提交。冷却截止时间随玩家跨地图传送，不能通过换图刷新。`ItemConfig.buy_price/sell_price`使用铜币整数：破旧布料售价10、小红售价20、大红售价50；买入价格仍由Npc商店目录读取，Map 100的9002杂货商当前出售小红和小型法力药水。`ItemConfig.icon`是客户端字段，填写相对`assets/resources`的Cocos资源键，不含扩展名；Cocos3D快捷栏通过这个字段加载图标，资源缺失时回退到名称文字。道具Handler只消费道具并调用统一`ActionExecutor`，不能自行分支写HP、MP、创建Timer或直接广播Buff。

Cocos3D演示新角色出生时获得小红1001和蓝药1003各3个，不预置大红；桌面快捷栏固定使用`1`切换平A、`2/3/Q`使用小红、大红、蓝药，移动端点击相同ConfigId快捷槽。任务5001仍奖励`1001×10`，5005奖励`1002×10`。快捷栏引用ItemConfigId而不是ItemId，道具卖空后保留0数量槽，再次拾取或购买时自动恢复数量；传送、重连和持久化恢复只使用权威`ItemSnapshot`。

`QuestConfig`引用`QuestObjectiveConfig`组成活动任务，奖励复用Action。`required_quest_ids`声明必须已经领取奖励的前置任务，`minimum_level`读取`NumericType.Level`；生成阶段会拒绝缺失、重复、自引用和循环前置关系。当前演示包含击杀怪物、使用道具和进入地图三种目标；Starter任务链是5001击败5只怪A，回NPC交付后解锁5005击败5只怪B；5004继续验证“完成5001且达到2级”后手工接取。两张Quest表标记为Hot，但已经接取的Quest会冻结目标与要求数量；Reload只影响之后新接取的任务，不能隐式改写玩家正在进行的任务。任务达到`ReadyToTurnIn`后必须携带NPC实例ID在交互范围内完成，不能从任务追踪面板直接领奖。完整语义和调用示例见[任务系统设计](../docs/design/quest-system.md)。

### 怪物掉落与任务道具

`MonsterConfig.drop_table_id`指向`DropTableConfig.drop_table_id`。每一行是一个掉落行：道具行填写`item_config_id + min_count/max_count`且`gold=0`；铜币行填写`gold>0`且道具和数量字段为0。`chance_permille`是该行自己的千分比概率，`quest_objective_id=0`表示普通掉落，非零表示只服务于指定`CollectItem`目标的任务掉落。普通掉落行逐行独立投掷，因此同一具尸体可以同时掉出布料、小红和大红，也可能一件都没有；当前Starter的表1、表2仍为破旧布料1201 800/1000、小红1001 150/1000、大红1002 50/1000。表3是Boss固定掉落：1001/1002/1003各5个和150铜币，四行概率均为1000/1000。任务掉落行仍按玩家任务资格独立判断。

MapConfig 200是Starter动态Boss副本模板，使用与Map 100相同的NavMesh资源，但运行时必须由Gate经MapManager创建新的MapInstance，不能把200当作静态实例号直接传送。MonsterConfig 3“试炼守卫”由MonsterArea 20001在Map 200创建，拥有900生命、18攻击和4米/秒移动速度，引用掉落表3。击杀后的120经验属于Dungeon领域奖励，不写入DropTable；掉落物与150铜币走正式尸体拾取事务。个人10分钟进入CD保存在`progression`记录并随玩家跨图迁移，客户端只显示服务端返回的截止时间。

死亡时，地图只在尸体容器中保存配置ID和数量，尸体有掉落时保留5分钟、没有掉落时保留10秒；全部普通掉落领取后可以立即清理尸体。`respawn_seconds`从死亡时刻开始计时，只表示新怪物的最短重生时刻；实际生成取尸体窗口结束与该时刻两者较晚值，不再单独决定尸体显示时间。当前静态任务徽记不会提前创建永久`ItemId`。玩家必须先从NPC接取5006，靠近尸体后发送`C2M_LootMonster`，服务端在拾取时检查任务是否存在且还需要数量。未接任务、任务已经达到要求数量，或该账号已经领取过同一行时，都不会生成背包Item；这条任务掉落仍留在尸体上，不会因为其他玩家或本玩家无资格而全局消失。任务掉落按账号资格领取；普通掉落在Starter中归第一次有效攻击者账号所有，其他账号不能抢走。

拾取不是“先改内存再保存”：`MonsterComponent.LootMonster`先规划Inventory、Quest和Currency快照，使用稳定`operationId`提交DBProxy事务；包含铜币时一次原子提交`inventory + quest + wallet`，确认后才提交Item/Quest Entity与金币并推送结果。重复请求返回第一次回执，不会重复加道具、金币或任务进度。动态词条、耐久等真正的ItemInstance掉落不能直接套用“尸体只存配置ID”的静态快捷方式，应在后续ItemInstance方案中保存实例数据。

任务奖励由`ExecuteReward -> ExecuteActionBatch`在PlayerUnit有序mailbox内同步执行；`GrantItem(ItemConfigId, Count)`和批量Grant必须交给Inventory，由Inventory合并已有堆叠并按`max_stack`拆分。当前批次不提供失败回滚或数据库事务，跨域持久化留给独立DBProxy；组队共享任务等待Party系统，不在Quest里提前模拟。

`BuffConfig`的三个Action阶段分别是：

- `add_action_*`：Buff创建时执行一次。
- `tick_action_*`：每个`tick_interval_ms`执行一次；间隔为`0`表示没有Tick。
- `remove_action_*`：Buff主动移除、自然到期或Unit销毁时执行一次。

Buff冲突不能只用一个`Unique`布尔值表达。`stack_group`决定哪些Buff互相冲突，`stack_scope=Target`表示所有来源共享一个冲突键，`Source`表示不同施法者可以各自拥有一个实例；`conflict_policy`决定叠加、刷新、替换、拒绝或高强度覆盖。`HigherWins`比较`conflict_priority`，禁止用ConfigId大小代表等级。刷新时是否更新来源、保留Tick节奏或重置运行状态分别由`refresh_source`、`refresh_tick_policy`和`refresh_runtime_state`决定。`description`只进入服务端包，供策划、日志和工具参考，不进入客户端配置，也不直接展示在游戏UI。

当前预置语义为：冰冷按目标共享并刷新；灼烧按来源独立、同来源刷新；真言术·盾按目标替换且重置吸收状态；虚弱灵魂重复添加拒绝；真言术·韧使用`HigherWins`，高等级替换、同等级刷新、低等级拒绝。刷新不得默认重复执行AddAction。

Action当前支持：

| ID | Action | 参数 | 边界 |
|---:|---|---|---|
| `0` | `None` | 空 | 仅表示没有Action |
| `1` | `ChangeNumeric` | `NumericType, delta` | 修改非派生普通数值；不能表达伤害或治疗 |
| `2` | `AddBuff` | `BuffConfigId` | 交给目标的`BuffComponent`处理冲突和生命周期 |
| `3` | `RemoveBuff` | `BuffInstanceId`；Buff移除阶段可留空表示自身 | 删除一个运行时Buff实例 |
| `4` | `DealDamage` | `amount, DamageSchool` | 统一进入`CombatComponent.ApplyDamage`；当前学校为Physical/Frost/Fire/Holy/Shadow |
| `5` | `RegisterDamageAbsorber` | `amount[, priority]` | Buff添加阶段注册护盾数据 |
| `6` | `Heal` | `amount` | 统一进入`CombatComponent.ApplyHealing` |
| `7` | `GrantItem` | `ItemConfigId, count` | 交给Inventory合并堆叠或拆分新Item |

表结构、Action ID和参数形状属于Model，改列或类型必须完整生成并重启；只改数值行时按Hot配置流程生成候选并Reload。生成器会校验参数数量、Buff外键、伤害类型、派生Numeric写入和重复技能效果顺序，不要依赖运行到战斗时才发现坏数据。更完整的调用边界见[Action与Buff设计](../docs/design/action-buff.md)。

### Skill配置

`SkillConfig`只回答“能否施放以及如何推进时间线”，`SkillEffectConfig`只回答“成功命中后依次执行哪些Action”。一项技能可以有多行效果，按`order`、再按效果行`id`稳定排序；同技能不能填写重复`order`。`queue_window_ms`控制读条结束前是否允许缓存一个下一技能，`channel_tick_ms/channel_ticks`控制引导跳数，二者都属于冷结构字段。当前3006“恢复”为瞬发技能，只执行`AddBuff(2002)`；Buff 2002持续24秒，每3000ms执行一次`Heal(10)`，共8次。3007“精神鞭笞”每1000ms执行一次`DealDamage(20, Shadow)`，共5跳。服务端10Hz桶推进读条、引导和弹道，移动会打断可移动中断的技能；客户端只显示服务端状态。

服务端的`SkillCatalog.ts`按当前游戏配置指纹把两张表组合成只读定义。配置Reload后，新Cast使用新定义；已开始读条和已经发射的弹道继续持有接受请求时冻结的旧定义，避免半次技能混用两代数值。客户端SDK只生成`SkillConfig`，用于名称、距离、读条和CD表现；`SkillEffectConfig`保持服务端专有。完整开发流程见[新增一个配置化技能](../docs/tutorials/18-configured-skill.md)。

当前技能的法力消耗暂时由服务端Hotfix的`SkillManaCost.ts`维护，待技能表结构稳定后再下沉到配置。技能被服务端接受后立即扣除法力，法力不足在创建施法前拒绝，不会在读条中途回滚；当前演示费用已统一减半，整数费用向下取整：寒冰箭10、火焰冲击12、惩击7、真言术·盾15、真言术·韧10、恢复7、精神鞭笞15。

玩家的战斗状态由`CombatStateComponent`维护，而不是由客户端或单独的“是否正在平A”推断：只要仍有怪物对玩家保留有效仇恨，玩家就处于战斗状态；怪物死亡、清除仇恨或回到出生点时移除对应来源，所有来源都消失后退出战斗。战斗状态下HP和MP都不自动恢复；脱战后分别按“最大HP/MP在180秒内从当前值恢复到满值”计算，服务端以固定更新桶统一推进，并使用整数余数累积避免浮点漂移。传送时CombatState作为临时运行态清空，目标地图重新开始判定。

怪物死亡后，当前MonsterUnit会以`alive=false`的尸体状态继续保留在AOI中；有掉落尸体保留5分钟、无掉落尸体保留10秒，全部普通掉落领取后可提前清理。`respawn_seconds`从死亡时刻计时，尸体窗口结束且达到最短重生时刻后，再发布旧尸体Leave并销毁，复用同一个`AreaId`刷怪槽创建新的MonsterUnit和UnitId。`MonsterComponent`把`MonsterConfig.max_hp`写入Numeric的`MaxHpBase`，由Rust推导出只读`MaxHp`，把攻击力写入`AttackBase`并由Rust推导只读`Attack`，把`attack_interval_ms`写入`AttackSpeedAdd`并读取只读`AttackSpeed`；`move_speed`按米/秒转换为Numeric的毫米/秒`MoveSpeedBase`。

`PlayerConfig.initial_hp/max_hp`和`initial_mp/max_mp`分别初始化玩家的当前/最大HP与MP；当前演示模板的`initial_mp`与`max_mp`均为`200`，新玩家进入地图时显示`200/200`。`attack_range`是独立的普通攻击距离，不属于Numeric链式属性。它们会在创建Unit时写入Numeric，客户端HUD只显示服务端快照和增量。`PlayerConfig.move_speed`同样填写米/秒。Grid2D的移动实现会把一个Cell的米制边长纳入单步耗时，因此不能再把它理解成“每秒几个Cell”；底层协议里的历史字段名`speedCellsPerSecond`暂时保留兼容，但它承载的是米/秒值。

## AOI冷配置

`AoiConfig.xlsx`和`AoiSyncTierConfig.xlsx`都是Cold配置，只能停服修改、重新生成并重启Process，禁止通过`reload-config`热更。`MapConfig.aoi_config_id`决定地图使用哪套AOI配置。

- `AoiConfig.enter_range_grids`：建立新可见关系的范围，必须是正奇数。
- `AoiConfig.detach_range_grids`：已可见关系的迟滞边界，必须是正奇数且不小于Enter。
- `MapConfig.cell_size_meters`：一个Cell的米制边长。
- `AoiConfig.grid_size_cells`：一个AOI Grid每条边包含的Cell数量。
- `AoiSyncTierConfig.range_grids`：本档同步范围，必须是正奇数、唯一并逐档扩大。
- `AoiSyncTierConfig.sync_hz`：本档可覆盖状态的最高同步频率，外层不得高于内层，并且必须整除服务端20Hz逻辑Tick。

Demo Map 100 当前选择`MapConfig.aoi_config_id=2`作为宽视野演示：7×7 Grid建立可见关系、9×9 Grid作为Detach迟滞边界。它只用于让出生点观察远端怪物，不是全局默认值；新地图应按实际空间和玩家密度选择自己的Cold配置。

Grid数量不单独配置，而是由`MapConfig.width_cells/depth_cells ÷ AoiConfig.grid_size_cells`推导；地图米制尺寸等于`width_cells/depth_cells × cell_size_meters`。地图制作流程决定物理边界并把结果写入MapConfig，运行时只接受能完整切成AOI Grid的尺寸，避免边缘出现半个Grid或多份尺寸配置互相冲突。

同步档位数量不写死。默认配置是`3×3 → 20Hz`、`5×5 → 5Hz`；如果业务需要恢复远距离低频观察，可以只修改Excel：

1. 将`detach_range_grids`改为`7`，Enter仍保持`3`。
2. 保留`3×3 → 20Hz`和`5×5 → 5Hz`两行。
3. 新增同一`aoi_config_id`的`7×7 → 1Hz`行。
4. 运行`npm run build`和`npm run test:game-config`，然后重启相关Process。

最外层同步范围必须等于Detach范围。这样所有已可见关系都有同步档位；例如配置了`Detach=7`却只填写到`5×5`会在生成期直接报错。处于5×5或7×7迟滞圈的单位不会凭空Enter，只有已经在Enter圈建立过的关系才会继续以外层频率同步。
