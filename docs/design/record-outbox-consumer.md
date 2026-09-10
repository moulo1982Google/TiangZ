# 记录事务与 Outbox 消费闭环

外置模块可通过 Stable Core/Model 的 `HostDbProxyRecords` 提交 DBProxy `CommitRecords`，通过 `CreateOutboxEvent` 构造 v1 信封。模块定义自己的 schema、event type、业务幂等键、inbox 和状态迁移；Core 不解释杀怪、任务或奖励。

`HostDbProxyTransport.supportsOutboxRelay` 只有新版 Host 声明时为 true；Rust SDK 会在真实握手中校验协议指纹与 `supports_outbox_relay`，旧端不能静默丢弃 outbox 效果。

## 部署和消费

Process 可配置一个消费目标，由一个领域消费者负责轮询：

```json
"persistence": {
  "eventStream": {
    "redisUrlEnv": "TIANGZ_EVENTS_REDIS_URL",
    "stream": "game.events",
    "group": "quest-progress-v1",
    "consumer": "world-0",
    "claimIdleMs": 5000
  }
}
```

该配置是 Rust 私有部署信息，不投影给 TS；环境变量保存 Redis URL，错误不回显凭据。名称限 1–128 个 ASCII 字母、数字或 `_ : . -`；回收窗口限 1–600 秒。依赖 Redis 6.2+ 的消费组与 `XAUTOCLAIM`；使用 DBProxy Redis relay 时还须满足 relay 的 AOF/`WAITAOF` 条件。

`HostStreamConsumer.IsAvailable()` 表示部署是否配置了适配器，**不表示 MQ 健康**。业务定时调用 `Poll()`，每次最多 16 条；Host 至多回收 8 条超时 pending，剩余额度读取新消息，避免故障消息占满读取配额。首次建立消费组从 `0` 开始，支持消费者部署前已有的积压。单次 I/O 有 3 秒超时，同一 Host 的并发操作直接拒绝；调用者应保持一个轮询在途。不要为每个玩家创建消费者。

投递返回 `{ streamId, event }`，`event` 是 MQ 字段 `event` 中的原始信封字符串。业务必须验证版本、来源、类型和身份；消费者按 `producer + event_id` 去重，不能按 Redis `streamId` 去重。

处理步骤：

1. 生产者以同一 `CommitRecords` 原子写入业务事实/回执和 outbox。
2. DBProxy relay 持久发布 MQ 后标记 published；可能重复发送。
3. 消费者以同一 `CommitRecords` 创建 inbox（CAS revision 0）并更新业务状态（CAS 当前 revision）。
4. 提交成功，或核验已有 inbox 与事件内容一致后，显式 `Ack(streamId)`。

`Poll()` 永不自动 ACK。业务异常、DB 超时或 ACK 异常保留 pending，之后由回收重试。未知事务结果不能假装失败并补发奖励：保留原请求重试，或通过持久 inbox/CAS 判定效果；不能只使用进程内 Set 去重。

## 边界与运维

该接口保证的是可恢复的至少一次交付基础设施，业务通过原子 inbox 达到效果只生效一次；不承诺 MQ 恰好一次。不同消费者可能并发处理同一分区，业务仍须 CAS；需要严格领域事件顺序时应另行实现序号栅栏。累计击杀不依赖到达顺序。

当前不会自动裁剪 Stream、清理 inbox 或跳过坏消息。检查 `XINFO GROUPS`、`XPENDING` 以及 DBProxy relay 指标区分“未发布”和“未消费”。pending 被外部裁剪时 Host 记录错误，需从保留的生产事实进行人工恢复；不能凭空恢复已被所有存储删除的内容。设置保留窗口前必须覆盖最大停机与重放窗口。

实体验收位于独立 ModuleGame 的 `npm run outbox:check`：真实 DBProxy/PostgreSQL/Redis，消费者关闭积压、离线推进、接任务前击杀排除、Redis ACL 拒绝 ACK、进程重启回收、同一事件以新 Stream ID 重投及领奖重启幂等。没有在 Runtime 加入游戏或测试专用分支。

## 2026-09-10 验收记录

- 新增三项 Host 单元测试通过：旧 Host 拒绝 relay 效果、事务效果/回执完整、消费与 ACK 分离。Rust 配置边界与 ACK ID 校验测试通过。
- `npm run verify` 完整执行：quick 25 项中首轮 24 项通过，唯一失败为新代码的 Clippy `collapsible_if`；修复后 `cargo clippy --all-targets -- -D warnings` 单独复检退出码 0。后续九项运行时、mailbox、背压、Watcher、热更、配置重载和模块 Native/发布验收全部通过。原矩阵报告保留首次失败，不改写为成功。
- 外置 ModuleGame 的 Model/Hotfix、方法/定时器契约检查通过；模块协议生成自测新增“生成 ABI 允许、手写越界拒绝”两个断言并通过。
- 本次没有变更网络 Proto/opcode/schema 锁；完整矩阵执行了既有 codegen 与产物检查，Stable Core API 锁显式更新为 196 个导出。
- 本地编译仍有已有的 Windows `LNK4098` 链接提示；没有执行长期性能压测。
