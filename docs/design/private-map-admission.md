# 私有动态地图准入


## 夜间阶段 4：队伍目录与私有动态地图（2026-09-11）

MapManagerScene 可由模块装配 PartyDirectoryComponent，按 namespace 隔离临时队伍。目录拥有成员/队长、修订、邀请和操作回执；同步转换避免 unordered mailbox 的异步交错。角色身份来自已鉴权 MapUnit，客户端不能自报。短暂断线保留成员；Manager 冷重启不恢复队伍。

DynamicMapProxy.Create(requestId, mapConfigId, characterIds?) 新增可选私有名单。提供时必须为 1–40 个不重复的正 uint64；缺省保持旧动态地图语义，显式空数组拒绝。Manager 和宿主均校验重试名单，注册快照恢复名单；MapHost 创建前原子预留整份名单 30 秒，统一玩家工厂检查身份。预留过期释放容量，但白名单持续到实例销毁；迟到成员仍须满足实际容量。预留期间禁止回收。MapScene 工厂可读 MapRuntimeProfileComponent.AllowedCharacterIds 的冻结副本。名单不允许在实例运行中变更。

边界：框架不拥有任务条件、Boss、奖励或强制整队传送。预留原子性不等于跨玩家迁移事务；游戏模块负责参与确认、单人迁移失败提示和副本生命周期。容量压测暂缓。新增内网协议可选 private_roster 字段已显式更新锁并重新生成。

验证进度：队伍与公开/私有地图定向测试 18/18；模块真实网络队伍测试及冷重启、Godot 三种实际窗口尺寸通过。新一轮完整框架验证进行中。


私有实例恢复补充：DynamicMapProxy.Inspect(requestId) 只读返回 recovering / unknown / creating / active / lost / disposed 及实例 ID。Manager 启动的宿主租约恢复窗口内，未知私有创建请求拒绝立即分配，查询返回 recovering；已恢复的记录可查询。业务不能仅以 Location 暂时查不到路由为依据判定实例丢失。模块在目录 active/creating/recovering 时提示稍后重试，仅在 unknown/lost/disposed 时结束旧清单；不自动重建旧副本。定向测试 19/19，新增内网查询协议已显式更新锁。
