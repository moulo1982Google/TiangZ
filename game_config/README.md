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

当前演示道具：小型生命药水使用`Heal(150)`，大型生命药水使用`AddBuff(2001)`。两者的`cooldown_ms`均为30000，`global_cooldown_ms`均为1000；药品自身CD按`ItemConfigId`独立，公共CD与技能共享并由服务端原子提交。冷却截止时间随玩家跨地图传送，不能通过换图刷新。`ItemConfig.icon`是客户端字段，填写相对`assets/resources`的Cocos资源键，不含扩展名；Cocos3D快捷栏通过这个字段加载图标，资源缺失时回退到名称文字。道具Handler只消费道具并调用统一`ActionExecutor`，不能自行分支写HP、创建Timer或直接广播Buff。

Cocos3D演示玩家出生时背包为空，快捷栏仍固定使用`1`切换平A、`2`使用1001、`3`使用1002；新玩家先从NPC领取任务，完成Starter任务5001奖励`1001×10`，完成后续任务5005奖励`1002×10`。快捷栏没有对应道具时只显示空槽，不应由`ItemComponentSystem.Awake`偷偷发放测试物品；传送、重连和持久化恢复仍只使用`ItemSnapshot`。

`QuestConfig`引用`QuestObjectiveConfig`组成活动任务，奖励复用Action。`required_quest_ids`声明必须已经领取奖励的前置任务，`minimum_level`读取`NumericType.Level`；生成阶段会拒绝缺失、重复、自引用和循环前置关系。当前演示包含击杀怪物、使用道具和进入地图三种目标；Starter任务链是5001击败5只怪A，回NPC交付后解锁5005击败5只怪B；5004继续验证“完成5001且达到2级”后手工接取。两张Quest表标记为Hot，但已经接取的Quest会冻结目标与要求数量；Reload只影响之后新接取的任务，不能隐式改写玩家正在进行的任务。任务达到`ReadyToTurnIn`后必须携带NPC实例ID在交互范围内完成，不能从任务追踪面板直接领奖。完整语义和调用示例见[任务系统设计](../docs/design/quest-system.md)。

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

`SkillConfig`只回答“能否施放以及如何推进时间线”，`SkillEffectConfig`只回答“成功命中后依次执行哪些Action”。一项技能可以有多行效果，按`order`、再按效果行`id`稳定排序；同技能不能填写重复`order`。`queue_window_ms`控制读条结束前是否允许缓存一个下一技能，`channel_tick_ms/channel_ticks`控制引导跳数，二者都属于冷结构字段。当前3006“引导治疗”每1000ms执行一次`Heal(30)`，共3跳；3007“精神鞭笞”每1000ms执行一次`DealDamage(20, Shadow)`，共5跳。服务端10Hz桶推进，移动会打断；3007受击时结束时间提前1000ms；客户端只显示服务端状态。

服务端的`SkillCatalog.ts`按当前游戏配置指纹把两张表组合成只读定义。配置Reload后，新Cast使用新定义；已开始读条和已经发射的弹道继续持有接受请求时冻结的旧定义，避免半次技能混用两代数值。客户端SDK只生成`SkillConfig`，用于名称、距离、读条和CD表现；`SkillEffectConfig`保持服务端专有。完整开发流程见[新增一个配置化技能](../docs/tutorials/18-configured-skill.md)。

怪物死亡后，当前MonsterUnit会以`alive=false`的尸体状态继续保留在AOI中；当前最小Demo复用`respawn_seconds`作为尸体存在时间，到期后先发布旧尸体Leave并销毁，再复用同一个`AreaId`刷怪槽创建新的MonsterUnit和UnitId。`MonsterComponent`把`MonsterConfig.max_hp`写入Numeric的`MaxHpBase`，由Rust推导出只读`MaxHp`，把攻击力写入`AttackBase`并由Rust推导只读`Attack`，把`attack_interval_ms`写入`AttackSpeedAdd`并读取只读`AttackSpeed`；`move_speed`按米/秒转换为Numeric的毫米/秒`MoveSpeedBase`。只有掉落设计确实要求尸体消失与复活分离时，才在MonsterConfig新增独立尸体时间；不要放入MonsterAreaConfig。

`PlayerConfig.initial_hp/max_hp`和`initial_mp/max_mp`分别初始化玩家的当前/最大HP与MP；`attack_range`是独立的普通攻击距离，不属于Numeric链式属性。它们会在创建Unit时写入Numeric，客户端HUD只显示服务端快照和增量。`PlayerConfig.move_speed`同样填写米/秒。Grid2D的移动实现会把一个Cell的米制边长纳入单步耗时，因此不能再把它理解成“每秒几个Cell”；底层协议里的历史字段名`speedCellsPerSecond`暂时保留兼容，但它承载的是米/秒值。

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
