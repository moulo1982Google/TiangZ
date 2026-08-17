# 金币与 NPC 商店

这份文档描述 Starter MMORPG 的最小经济链路：怪物掉落杂物，玩家把杂物卖给杂货商获得铜币，再用铜币购买红药和蓝药。它用于验证 `CurrencyComponent`、Inventory、DBProxy 事务和客户端商店界面之间的边界，不代表最终商城或交易系统。

## 1. 状态归属

```text
MonsterComponent
  -> LootContainer
  -> ItemComponent（拾取后创建/合并 Item）

PlayerUnit
  -> CurrencyComponent（铜币余额）
  -> ItemComponent（背包 Item）
  -> PlayerPersistenceComponent

NpcShopComponent
  -> 校验 NPC、距离和商品目录
  -> 组织购买/出售事务
  -> DBProxy
```

`CurrencyComponent`只保存非负 `bigint` 余额，不知道 NPC、价格或商店。`ItemComponent`只负责 Item 的创建、合并、消耗和快照，不知道金币。商店规则集中在 `NpcShopComponentSystem`，这样以后增加拍卖行、玩家交易或奖励发放时，不会把“买药”的分支塞进基础货币组件。

## 2. Starter 配置

怪物普通掉落在同一个掉落表中按行独立判定：

| 道具 | 配置 ID | 概率 | 售价 |
|---|---:|---:|---:|
| 破旧布料 | 1201 | 80% | 10 铜币 |
| 小型生命药水 | 1001 | 15% | 20 铜币 |
| 大型生命药水 | 1002 | 5% | 50 铜币 |

每一行的 `chance_permille` 都是独立概率，不要求同一掉落表的概率总和为 1000；因此三行可以同时命中，也可以全部未命中。任务掉落不是普通掉落判定的一部分，而是根据玩家当前任务资格独立判断。掉落表只描述配置 ID；真正拾取时才通过 Inventory 创建或合并玩家的 Item Entity。

Starter 地图 100 的 `9002 杂货商`提供小红 `1001` 和小型法力药水 `1003`；大型生命药水仍然只作为怪物掉落，避免把商店目录和掉落表绑死。购买价格继续读取 `ItemConfig.buy_price`，客户端不能上传价格；出售价格读取服务端 `ItemConfig.sell_price`，客户端只显示服务端商店快照中的价格。

## 3. 购买流程

```text
C2M_OpenNpcShop
  -> NpcShopComponent.Open
  -> 校验 NPC、同地图、AOI挂载、5米距离
  -> 返回商品目录和当前金币

C2M_BuyNpcShopItem
  -> PlayerUnit ordered mailbox
  -> 校验商品、数量、金币
  -> Inventory.PlanGrantItems
  -> Currency计算新余额
  -> PlayerPersistence.ApplyTransaction(operationId, snapshot, receipt)
  -> 提交成功后 Commit Inventory/Currency
  -> 发布 ItemChanged
```

客户端不能在点击购买时预扣金币或直接增加道具。数据库提交成功前，内存中的 Item 和金币仍保持旧状态；网络超时重试必须复用同一个 `operationId`，由 DBProxy 返回第一次事务回执。

## 4. 出售流程

```text
C2M_SellItem(itemId, count)
  -> PlayerUnit ordered mailbox
  -> 校验 Item 仍属于玩家、数量足够、sell_price > 0
  -> Inventory.PlanConsumeItem
  -> Currency计算新余额
  -> DBProxy事务提交
  -> 提交成功后消耗 Item、增加金币
  -> 发布 ItemChanged
```

出售请求使用具体 `ItemId`，因为它操作的是玩家背包中的一个实体；快捷栏仍只按 `ItemConfigId`寻找可用堆叠，不能保存某个已经卖掉的 `ItemId`。数量归零的 ItemSnapshot 会让客户端删除背包实体，但快捷栏保留该配置槽并显示 `0`。

## 5. 客户端交互

Cocos3D 中，靠近杂货商后显示统一 NPC 交互按钮，进入对话框后点击“打开商店”。商店面板分为购买和出售两组：

- 购买组只展示服务端返回的红药、蓝药目录。
- 出售组展示当前背包中 `sell_price > 0` 的 Item，并按 ItemId出售一个。
- `M2C_OpenNpcShop` 同时返回当前玩家私有的 `InventorySnapshot`；客户端打开商店时用它校正本地背包投影，避免拾取后的 `ItemChanged` 延迟或丢失造成“背包为空”的假象。
- “背包中没有道具”和“有道具但没有可出售物品”必须分开提示；任务物品可以存在于背包，但 `sell_price = 0` 时不能出售。
- 每次按钮请求期间禁用同一面板按钮，避免演示端重复提交；服务端仍必须依靠 ordered mailbox、`operationId`和事务回执兜底。
- 商店关闭只关闭界面，不撤销已经提交的交易。

## 6. 后续边界

这条商店链路暂时不包含邮件、拍卖行、库存上限和价格热更。同地图玩家交易已经使用 DBProxy 多记录事务一次提交双方完整记录，不能把两个单玩家出售/购买请求拼在客户端完成；其临时会话、确认和回执恢复见[玩家交易设计](player-trade.md)。价格、货币上限和审计日志进入正式版本前，需要补充领域配置和更严格的经济事务测试。

## 7. 战斗资源

技能费用当前由 `SkillManaCost.ts` 维护演示值：寒冰箭10、火焰冲击12、惩击7、真言术·盾15、真言术·韧10、恢复7、精神鞭笞15。服务端在创建施法前检查 `CurrentMp`，通过后立即扣蓝；法力不足不会创建施法，读条中断也不返还已经扣除的法力。

`CombatStateComponent`保存仍然对玩家有有效仇恨的怪物 UnitId 集合。集合非空就是战斗状态，战斗状态下 HP 和 MP 都不自动恢复；怪物死亡、回归或清除仇恨后移除来源，集合为空才进入脱战恢复。脱战后按“当前值在180秒内恢复到对应最大值”计算，服务端10Hz更新桶以整数余数累计，避免浮点误差。该状态属于地图运行态，不进入玩家持久化快照，传送后重新判定。

## 8. 本地验收

不启动服务器即可验证商品目录、价格、购买、出售，以及同一个 `operationId` 重试不重复扣款或增发：

```powershell
npm run test:npc-shop
```

完整开发门禁会自动包含这条自测：

```powershell
npm run check
```

外网或拆分进程环境还应执行真实 WebSocket 回归。该命令会创建临时账号，依次完成进图、击杀、拾取、返回杂货商，并断言商店回包中的权威背包包含拾取结果：

```powershell
npm run test:npc-shop-websocket
```

可通过 `TIANGZ_LOGIN_HOST`、`TIANGZ_LOGIN_PORT` 和 `TIANGZ_MAP_ID` 指向其他测试环境。它依赖真实服务器，不加入普通本地 `verify`。
