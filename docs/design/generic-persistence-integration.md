# 通用持久化集成与领域边界

日期：2026-09-05。本分支为本地跨仓库集成；远程七天演练仍运行原版本。

## 通用缺口与代码归属

原 ApplyMultiTransaction 能原子更新记录，但不能附加审计事实和 Outbox。新增 CommitRecords 在同一个数据库事务中保存版本化记录、不可变追加记录、事件、缓存修复目标与回执。中立验收是两条文档更新加一条事实和事件，不包含具体游戏 schema 或规则。

TiangZ 的 Rust Host 和 HostDbProxyTransport 只转换字节与版本。PlayerRepository 的多记录请求可选携带 effects；旧调用不变。玩家交易在 `app/hotfix/mmorpg/trade/PlayerTradeTransaction.ts` 从同一计划生成 `player.trade.audit` 事实和 `player.trade.settled` 事件，并检查双方金币增减总和。物品可交易性、数量、金币与交易阶段仍由现有领域代码校验；DBProxy 不解析这些字节。

这次接入保存完整交易计划作为审计事实，不建立通用余额账本、托管服务或持久订单状态机。当前玩家交易仍是同地图在线会话。DBProxy 旧 Trade API 暂留兼容，不能声称其状态机已经删除或迁移完毕。后续完整托管恢复应在领域模块独立验收。

## 提交与恢复

- 规划阶段不修改玩家资产，持有双方 mailbox 后一次提交四条 wallet/inventory 记录及效果；收到回执后应用内存状态。
- 操作 ID、事实键、事件 ID、payload 和事件时间重试保持一致。事件时间随计划保存在回执中；旧回执没有该字段时按 0 表示未知历史时间，禁止恢复时生成新的时间。
- 有效果的操作不能降级为普通多记录调用。旧 Host 会明确拒绝。原 LoadMultiTransaction 可恢复新提交的版本与业务结果。
- 当前 PlayerRepository 只允许多记录事务带效果，单记录调用及单记录回执查询不改变。
- Outbox 至少一次投递，消费者按 event_id 去重。当前没有新增消费者或宣称通知恰好一次；原客户端通知路径继续工作。

## WoW335 影响

- Rust 领域库固定使用旧 SDK 的快照接口，新服务保留准确旧指纹并回显握手；快照协议、schema、revision 不变。
- 外置模块继续使用 VersionedEntityRepository，未修改模块源码、公开玩法协议或内容配置。
- 若复用 TiangZ 玩家交易，会得到同次提交的审计/事件；这要求新版服务器先部署，但不要求 WoW 专属快照迁移。
- 没有改动 WoW 客户端线协议，不以模块静态检查替代真实客户端验收。

## 本地依赖与发布

本分支 `.cargo/config.toml` 将三个 Rust SDK crate 指向相邻 `TiangZ-DBProxy`，npm 使用 `file:../TiangZ-DBProxy`。保持两个仓库并列检出，先在 DBProxy 执行 `npm run build:typescript`，再在 TiangZ 执行 `npm install`。普通 cargo 命令使用本地补丁。

本地 Cargo 构建并发设为 1，避免笔记本同时链接多个 Deno/V8 测试目标耗尽内存。这只限制构建并发，不改变服务线程数、玩家并发或测试隔离。

这些是待发布前的集成依赖，不是已经发布的远端 SDK。七天演练结束后，应先发布并固定 DBProxy 提交，再把 npm/Cargo 依赖及锁文件切换到该提交，移除本地 Cargo 补丁，并重跑无补丁发布门禁。不能只上传 TiangZ 源码，仍让服务器下载旧 main。

所有 DBProxy 节点和 Outbox worker 升级后，才启用新客户端。通用事件的 trade_id 为空；旧 worker 不支持，不能在通用事件已经写入后直接回退旧二进制。回退需先停用新写入，核对未投递事件与效果回执，制定数据兼容方案。迁移不删除旧交易表，不重建快照分区。

真实 PostgreSQL/Redis 迁移、重启恢复和新故障演练必须在独立环境验收，本轮未启动本机 Docker，也未触碰远程演练。

## 后续领域迁移验收

完整持久交易单/托管状态机尚未实施。后续代码仍放在 TiangZ 的领域 Model/Hotfix（或游戏自己的外置模块），不能回塞 DBProxy。必须覆盖结果未知时保留操作 ID、重启后查询/重试、取消与提交竞争、重复事件消费；尤其不能把一次查不到回执当作确定未提交。旧 Trade API 只在这些语义与所有消费者迁移通过后退役。

本轮 WoW335 原有测试、外置模块接入测试以及固定旧 SDK 对新版内存服务的快照网络测试通过，WoW335 工作树没有改动。没有宣称真实数据库重启恢复或 WoW 游戏客户端已验收。

本地 `npm run verify:release` 已通过：quick 23/23、check 15/15、full 9/9，严格协议/版本/Core API 锁开启，含 Rust 全目标测试和运行时/热更新回归。TypeScript 全量覆盖率测试为 50 个文件、78 个用例通过。首次并行链接的内存不足已通过单任务构建解决；以上仍不能替代固定远端依赖后的发布复验和真实 PostgreSQL/Redis 验收。
