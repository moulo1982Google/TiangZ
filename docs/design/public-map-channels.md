# 公共地图分线

2026-09-10：公共地图属于 TiangZ MMORPG 地图领域。游戏提供规则，MapManager 分配实例，MapHost 拥有地图、AOI 和准入，Gate 维护客户端路由及传送屏障；不在 Core 内加入营地或猎场业务。

## 身份与生命周期

`MapConfigId` 是模板，`MapInstanceId` 是全局运行实例身份，`channelId` 是该模板内展示给玩家的线号。不同模板的 1 线没有隐含关联。原 `staticMapIds` 固定实例及 `StaticMapInstanceId` 保留兼容。公共分线通过统一动态创建链创建独立 MapScene，内部 `dynamic=true` 表示运行时实例及短租约，**不等于个人副本**；assignment 中的 `channelId/maxPlayers` 区分公共分线。私人副本仍使用 `DynamicMapProxy.Create`。

公共分线不参与 DynamicMapLifecycle 的五分钟副本兜底回收。Manager 按游戏配置维持至少一条线，额外分线连续空闲后回收；在线玩家、Prepare 中的候选玩家和有效预留都阻止回收。销毁开始后拒绝进入和预留。第一版不迁移有人的分线、不强制合线。

## 游戏如何配置

在模块 Hotfix 的同步 `entityExtensionHandler` 中为 `MapManagerScene`、`MapHostScene` 装配启动规则。这两个 Scene 的构造边界现在执行 `applyEntityExtensions`。规则只在启动时装配；修改规则要完整构建并重启，不会随 Hotfix 替换修改已有分线。

```typescript
// MapManagerScene 的 Attach 中：模板必须是现有可创建地图配置。
scene.GetComponent(MapManagerComponent).ConfigurePublicMaps([
  { mapConfigId: 1, maxPlayers: 50, minChannels: 1, idleTimeoutMs: 300_000 },
]);

// MapHostScene 的 Attach 中：数值由部署和压测决定，以下只是示例。
scene.GetComponent(MapHostComponent).ConfigureCapacity({
  maxMaps: 4, maxPlayers: 200, mapConfigIds: [1],
});
```

容量统计包括固定地图与运行时地图。`maxMaps/maxPlayers` 为零表示未设置上限；`mapConfigIds=[]` 不限制模板。公共分线优先填充已有宿主，达到已配置预算后选另一宿主；私人副本仍采用分散放置。宿主自己再次检查实例预算和玩家预算，低频心跳不能作为最终准入依据。建议每个地图进程部署一个 MapHostScene；同进程部署多个 MapHostScene 时，这些上限分别生效，不能把它们当作进程合计预算。

## 进入与换线

客户端使用生成 SDK 的 `Gate.EnterPublicMap({ mapConfigId, preferredInstanceId })`。身份从 GateSession 取得，不能由客户端提交角色 ID 或宿主地址。Gate 在角色事务锁内调用公共目录并预留，再复用 EnterMapCore/TransferToMap，包括本地与跨进程迁移、Location 提交、旧 Actor 清理、Gate 路由更新及协议规定的转图屏障。响应返回原有进图快照和线号。

`Gate.ListPublicMaps` 返回实例号、线号、在线/预留数和上限，不返回内部地址。内部 `PublicMapProxy.Acquire/List` 供服务编排使用，不应从玩家组件绕过 Gate 直接迁移在线客户端。现有单独 `MapComponent.TransferToMap` 不会替调用者建立 Gate 事务；此次真实测试验证了这个边界，公共入口明确使用 Gate 事务。

自动选择首先尝试显式偏好实例；未指定时 Gate 优先保持当前同模板实例。偏好已失效或满员时选择其他可用线。队伍业务可传队友的实例号；此入口不承诺整队原子预留，整队预约需要后续独立契约。

Manager 对同模板选择/创建串行，防止同时满线时出现创建风暴。MapHost 同步预留角色席位，有效期 30 秒；重复预留保留原截止时间。实际同步玩家工厂消费预留，包含首次进入、同宿主及跨宿主 Prepare。Prepare 已占据实体席位，后续回滚、离线和销毁通过原有 Unit 生命周期释放。宿主总人数按唯一 CharacterId 统计，同宿主迁移的源和目标不会重复占用宿主预算。

已配置公共地图默认可经框架演示入口进入；具体游戏的等级、任务、入口距离等业务权限仍须在接入时设计并验证，不能把容量准入等同于玩法授权。

## 恢复与扩容边界

Manager 启动后保留 15 秒目录恢复期，期间公共准入明确拒绝并允许稍后重试，最低线数维护也等待恢复期结束。存活 MapHost 重报 assignment，恢复原实例号、线号、容量；预留仍由原宿主保存。过期宿主不再参与分配，偏好丢失实例时选择新线。创建响应不确定时保留原 requestId/实例号重试，只有明确的创建前容量拒绝才允许改选宿主。

新 MapHost 进程由部署工具、Watcher 或容器编排启动，注册就绪后可被选中。本次提供容量配置、宿主登记、分配和准入，**没有实现基于 CPU/Tick 延迟的自动进程扩缩容，也没有给出生产承载人数**。实例内正在进行的战斗属于宿主内存状态；进程丢失不等于无损恢复，角色持久化和任务/outbox 的恢复仍按原有契约处理。

## 验证与接入状态

- `tests/unit/public_map_channels.test.ts`：101 个并发申请得到 50/50/1；进程人数预算、过期与绕过拒绝、Prepare 占用、同宿主迁移、恢复、失去租约、创建响应丢失和额外空线回收。
- `npm run test:public-maps`：使用隔离外置模块和三个真实 Runtime 进程，五个客户端按 2/2/1 分线；验证同宿主及跨宿主传送、下一次 Actor 请求、绕过预留拒绝、偏好满员回退和重连原线。测试使用系统分配端口及 `temp/public-map-runtime` 独立产物，不改现有开发服；依赖已经构建的 `target/debug/TiangZ`，已接入完整 verify 矩阵。
- 原模块类型检查、协议/SDK 生成和完整 `npm run verify` 另行记录实际结果，不以容量测试代替完整检查。

ModuleGame 现有 WastelandLobby 仍需迁移到 Gate/MapScene 运行链，并迁移其角色、战斗与 DBProxy outbox 接口。不能仅把旧 CampPlayer 加上线号就宣称完成框架接入；本次框架验收使用独立模块验证真实地图能力。

### 2026-09-10 实测记录

分线单元测试 8 项通过，包含 101 个并发预约按 50/50/1 分配。真实运行测试使用三个进程（公共服务、MapHost A、MapHost B）和五个 WebSocket 客户端，初始分配为 A 的 1/2 线各两人、B 的 3 线一人。随后一名玩家从 A 跨进程进入 B，目录人数为 1/2/2；无预约直接进入被拒绝，已满的偏好线回退到可用线，断线重连保持原实例，换线及重连后的 Actor 请求均成功。

真实测试输出标记为 `PUBLIC_MAP_RUNTIME_PASSED`，包含 `sameHostTransfer`、`crossHostTransfer`、`directBypassRejected`、`fullPreferredFallback`、`reconnectSameChannel` 五项成功结果。此测试没有验证游戏怪物、DBProxy 任务消费或生产容量。

本机首次完整验证受全局 `CC/CXX` 指向 MSYS GCC 影响，Windows MSVC 链接失败。重跑时仅在验证子进程环境删除这两个 GCC 覆盖值，未修改系统环境或工程编译配置；重跑日志为忽略目录 `temp/public-map-verify-msvc.log`。

重跑的 `npm run verify` 完整矩阵 **11/11 通过、0 失败**（约 17 分 18 秒），内含 quick 矩阵 25/25、check 矩阵 15/15、146 项 TypeScript 单元测试，以及 Native、SDK、真实地图传送、公共分线、Mailbox、背压、优雅退出、热更、配置更新和模块 Native 运行验收。机器可读结果位于忽略目录 `dist/test-results/full.json`。新增公共分线测试已纳入 full 矩阵，后续修改无需另行记忆测试入口。

本次 PowerShell 重定向包装器因 esbuild 的标准错误进度输出生成 `NativeCommandError`，包装器返回 1；矩阵内部所有子命令退出码均为 0，上述通过结论来自完整矩阵报告，不能将包装器退出码记为 0。后续自动化应分别捕获标准错误日志和原生命令退出码。

## 外置游戏地图接入（2026-09-10）

MapHostScene 在启动期装配 MapContentProfileComponent，模块同步登记完整地图定义后封闭，再创建 staticMapIds。CreateAssigned 与远端迁移校验均从目录解析模板；旧 MapConfig 保留为回退，因此外置地图无需修改主工程 Luban 数据。MapRuntimeProfile 保存每张地图的完整定义，MapComponent 与 MapAoiComponent 从中取得准入及 AOI 配置。

MapScene.ProcessName 来自 SceneContext 的进程身份；动态 Scene 的 Entity Parent 为空。模块不得假设可以沿 Parent 找到 MapHost，也不得从 Core 内部对象读取配置。

PlayerPersistenceComponent 的模块信封现在同时参与本地 CaptureTransfer/RestoreTransfer 与跨进程 PlayerTransferSnapshot.moduleStates。迁移 schemaVersion 为 11；升级要求所有宿主共同部署和重启。

MapHost 优雅停机可能依赖远程 Location 查询/删除。停机期间保留 Runtime，Rust 继续排空既有 HostSceneCompletion，TS 仅提交宿主传输队列，不执行游戏 Tick。完成、失败和超时均须检查，不能把功能断言通过但停机报错的运行记为完整通过。