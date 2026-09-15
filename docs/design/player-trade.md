# 玩家交易设计

## 外置模块接入（2026-09-11）

`PlayerTradeEvents.Notification` 在通用邀请、状态变化、关闭广播前同步发出，携带单个接收玩家、交易 ID 和结果；监听失败不否决交易。模块应立即复制快照，再通过 Scene 任务和 Self Audience 发送自有 Event 协议。Gate 仍只转发帧，不转换业务协议。邀请发送失败会关闭会话并补发关闭通知，避免模块客户端残留邀请。通知不能替代持久化结果查询；断线漏收后查不到临时会话，不代表交易失败。

`GetSnapshot(player)` 供模块自己的状态 RPC 获取防御性会话快照，不返回其他角色的会话。快照显示角色 DisplayName。

`PlayerTradeEvents.BeforeCommit` 提供双方玩家、交易前后金币和物品计划。事件在双方 ordered mailbox 内、首次编码提交载荷前同步执行；监听器只读，返回非零码拒绝。已冻结的载荷重试不再次执行业务准入。首次计划或准入失败会关闭会话并释放交易占用；已冻结载荷保留既有持久化恢复路径。

荒原模块持有 12 格背包、穿戴物保护和 pending 库存规则；TiangZ 持有双方邮箱、事务、审计和 outbox。荒原金币还属于独立进度记录，当前禁止金币报价，不能把模块物品交易接入当作经济系统全部完成。

## 世界观

玩家交易不是两个背包各自保存一次，而是一个临时会话协调两份玩家权威数据，最终由一次跨记录事务完成交换：

```text
玩家A有序Mailbox ----\
                     -> MapScene.PlayerTradeComponent -> PlayerRepository
玩家B有序Mailbox ----/                              -> DBProxy多记录事务
                                                       -> PostgreSQL原子提交
```

- `PlayerTradeComponent`只属于当前`MapScene`，保存邀请、报价、确认和过期时间，不拥有金币或Item。
- `CurrencyComponent`、`ItemComponent`和`PlayerPersistenceComponent`仍由各自`PlayerUnit`拥有。
- DBProxy不认识“玩家交易”，只原子比较全部记录的`expectedRevision`并保存不透明Payload与回执。
- 交易会话是临时运行态，不落库、不跨地图迁移；成功结果已经进入两个玩家的持久记录。

## 当前流程

```text
C2M_RequestPlayerTrade(targetUnitId)
  -> 校验同Map、在线、存活、5米内且双方空闲
  -> 向目标发送G2C_PlayerTradeInvite

C2M_RespondPlayerTrade(accept)
  -> 接受后打开双方交易窗口

C2M_UpdatePlayerTradeOffer(gold, items)
  -> 校验报价仍属于当前权威背包
  -> 清除双方确认状态
  -> 广播G2C_PlayerTradeChanged

C2M_ConfirmPlayerTrade
  -> 双方都确认后冻结会话
  -> 当前确认者继续占用自身Mailbox，并进入另一玩家的真实Mailbox
  -> 纯数据Planner生成双方inventory + wallet记录和交易回执
  -> PlayerRepository.ApplyMultiTransaction
  -> 成功后无await替换双方金币与Item Entity
  -> 分别发送带私有金币和完整背包的G2C_PlayerTradeClosed
```

任意一方修改报价都会取消双方确认。进入提交阶段后不能取消；玩家传送前必须先结束交易，普通下线会关闭未提交会话。

最终提交必须同时占用两个`PlayerUnit ordered mailbox`直到DBProxy返回并完成双方内存应用。只冻结交易会话不够：如果第二位玩家在`await`期间还能使用道具、购买商品或修改金币，数据库事务可能成功，但本地背包会因为基线变化而无法应用。`MapComponent.RunPlayerMailbox`只用于已经解析出的同MapHost玩家，不替代Location，也不能用于跨地图交易。

## 原子性与恢复

交易使用创建会话时生成的稳定`operationId`。DBProxy必须满足：

1. 两个玩家Revision全部匹配才提交，任何一个冲突都不修改记录。
2. 同一个`operationId`重复请求返回第一次的原始回执，不重复转移金币或物品。
3. 数据库已提交但响应丢失时，TiangZ使用`LoadMultiTransaction`恢复回执，再补做尚未应用的内存状态。
4. 禁止把交易拆成两个`ApplyTransaction`；“先扣A、再加B、失败后补偿”不是本系统的事务语义。

完整堆叠转移可以保留原`ItemId`；拆分堆叠必须在提交前分配新的永久`ItemId`。任务道具等不可交易物品由领域规则拒绝，客户端过滤只负责体验，服务端始终重新校验。

## 业务调用示例

Cocos3D当前演示入口：选中其他玩家，在目标HUD点击“发起交易”，双方分别填写铜币和物品数量，更新报价后各自确认。客户端只保存输入草稿，不预扣金币或背包：

```ts
await mapClient.requestPlayerTrade({ targetUnitId });
await mapClient.updatePlayerTradeOffer({
  tradeId,
  gold: 25n,
  items: [{ itemId, itemConfigId: 1001, count: 2 }],
});
await mapClient.confirmPlayerTrade({ tradeId });
```

Handler只负责把请求送入`PlayerUnit`的有序Mailbox，再调用地图上的`PlayerTradeComponent`。业务不得在Handler中拼DBProxy写入、遍历地图查玩家或直接修改对方背包。

## 当前边界

- 只支持同一`MapScene`、在线、存活且距离不超过5米的两个玩家。
- 一个角色同时只能参加一场交易；会话60秒无操作自动过期。
- 当前可交易红药、蓝药和普通杂物；任务物品不可交易。
- 不支持跨地图、离线交易、邮件、拍卖行、队伍分配或多方交易。
- 已有确定性自测覆盖成功、重复operationId、反向参与者查询和Revision冲突全不修改；提交实现同时占用两名玩家的有序Mailbox，真实双客户端与DBProxy故障切换仍需单独验收。
# 持久化验收

`npm run test:player-trade:persistent`覆盖正式WebSocket、NPC商店单记录事务、玩家交易双记录事务、TiangZ重启恢复，以及最终确认前首选DBProxy故障后的备用Endpoint提交。Debug验收还会在一次多记录提交成功后丢弃Host响应，确认服务端用同一`operationId`读取原始回执；随后让两个Endpoint同时不可用，确认UseItem失败不修改在线Entity，恢复后重试同一ID只成功一次。测试只创建带时间戳的账号，不直接写PostgreSQL或Redis，也不通过测试后门修改金币。

持久化Process在ready前预连接DBProxy池，因此只保留备用Endpoint重启时，第一个登录RPC不承担连接池冷启动时间。若所有Endpoint都不可用，Process启动失败而不是先ready再让首个业务请求超时。

### 2026-09-11 历史成交补查

PlayerTradeComponent.QueryResult(player, tradeId, otherCharacterId) 返回 pending / committed / unknown。持久化组件 ReadHistoricalMultiTransaction 强制包含调用者角色，只读取双方 inventory/wallet 的原事务回执，不推进当前 revision、不清除未决集合、不应用旧资产。交易领域解码后校验交易 ID 和双方角色 ID；存储错误向上传递，缺失回执不能解释为失败。查询不要求对方在线，不依赖当前地图会话。调用端保留 tradeId 与对方角色 ID；回执过期或未成交均可能 unknown。此能力不持久化取消结果，不替代客户端重连处理。
