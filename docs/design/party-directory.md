# MMORPG 队伍目录

夜间阶段 4 设计，2026-09-10。所有者为 MapManagerScene 中显式装配的 PartyDirectoryComponent；与地图里的 PlayerUnit 生命周期解耦，成员以稳定 characterId 表示，跨宿主/分线仍属于同一队伍。

Core 不拥有队伍语义。模块在 Factory 注册独立 namespace 与最大人数、邀请有效期、离线保留期。配置只读；每个 namespace 有独立队伍、成员索引、邀请与操作回执。请求只经受信任服务端内部 RPC，外部模块协议必须从认证 Session 派生角色身份，不能透传客户端 actor/profile。

MapManager mailbox 为 unordered；队伍状态转换为同步函数，不跨 await，保证成员唯一性、上限和队长转移的原子性。异步玩家资料/Location 查询在进入队伍变更之前完成。请求带 partyId/revision，避免旧界面操作新队伍；operationId 有界幂等，重复操作不再变更，读取最新视图。邀请答复只允许被邀请者，过期拒绝。公开名单不暴露内部宿主/IP。

在线状态由认证客户端请求续期；短断线保留成员关系，过期后清理，队长离开自动移交最早加入者。目录是暂态社交会话，当前不承诺 MapManager 重启恢复队伍；副本准入应保存本次参与者清单与独立回执，不能依赖永远在线的目录。后续若扩展持久队伍应单独声明恢复语义。

本阶段先实现创建、邀请/答复、离队、踢人、转让队长、查看队友位置。整队副本以目录 revision 固定参与者清单，动态地图准入与传送仍走 MapManager/MapHost/Gate。
