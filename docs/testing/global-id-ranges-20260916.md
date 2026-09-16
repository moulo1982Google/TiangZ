# DBProxy 号段验收记录（2026-09-16）

## 本轮改动

只修改 TiangZ：Core 身份布局/分配器、持久化适配、Process 启动桥接、Rust identity 配置与旧 Model 拒绝检查、测试和开发文档。DBProxy、Examples、插件与现有部署未修改；SLG 仅运行包检查，未增加玩法。

主要文件：

- app/core/persistence/GlobalIdRangeAllocator.ts：复用 SDK Load/Save CAS，持久高水位、单次 applied 领取、未知结果保留原请求、duplicate 跳号、有界预取、耗尽拒绝与销毁。
- app/core/persistence/PrepareGlobalIds.ts、app/core/process/ProcessBootstrap.ts：Scene 构造前等待首个号段；失败不降级，停机期间不接受迟到启动。
- app/core/runtime/GlobalIdLayout.ts、IdSystem.ts、Game.ts、app/core/process/ProcessRuntime.ts/types.ts：保持原 63 位 ID 布局和同步 Next 入口，明确 dbproxy/local-development 模式及生命周期所有权。
- src/config.rs、src/host.rs：配置验证、模式投影和旧 Model 能力拒绝门禁。
- tests/unit/global_id_ranges.test.ts、global_id_bootstrap.test.ts；tools/global_id_runtime_self_test.mjs；package.json 增加 test:global-id-runtime 入口。
- docs/design/global-id-ranges.md、能力归属、区服基础、AI 项目上下文、业务手册与命令说明。

## 验证

- `npm.cmd run verify` 完整矩阵 5/5 通过，包含 quick 29/29、模块宿主、教学工程、持续开发和 Native 组合运行验收。

- `npx.cmd vitest run tests/unit/global_id_ranges.test.ts tests/unit/global_id_bootstrap.test.ts`：13/13 通过。覆盖同秒重启、相同槽位并发、丢失提交响应、时钟回拨、耗尽/恢复、单一在途请求、停机、非法高水位、槽位/模式校验以及 CAS 竞争上限。
- `npm.cmd run typecheck`、`npm.cmd run test:unit:typecheck`、`npm.cmd run verify:comments` 通过。
- 完整构建 `cargo build --bin TiangZ` 通过，实际启动了新构建的临时 TiangZ 进程。
- Rust 配置用例 global_id_ranges_require_explicit_mode_and_dbproxy 通过；Rust 全目标测试包含 dbproxy_global_ids_refuse_legacy_model_bootstrap，并通过。
- `node tools/global_id_runtime_self_test.mjs`：真实 SDK/TCP，固定同一秒，连续启动/停止两个 TiangZ 进程，再并发启动两个相同来源服/worker 进程，合计 36 个 ID 无重复，来源和 worker 位保持兼容。Scene 构造阶段已能同步发号。
- Examples `npm.cmd run check -- --package slg` 通过；未构建/启动现有 SLG。
- 本轮修改的已跟踪文件 `git diff --check` 通过。

隔离测试使用临时自有 MemoryBackend DBProxy，保留它的内存状态跨 TiangZ 重启；没有重启或操作 PostgreSQL/Redis。测试夹具由官方脚手架/构建器生成，不手工改 Bundle、生成协议或指纹，结束后清理自有进程和临时目录。

最初直接 Cargo 命令继承了 GCC 编译环境，出现 LNK1143；随后仅在子进程环境移除 CC/CXX 并重新构建通过，没有修改用户全局环境。正常构建仍有已有 LNK4098 运行库链接警告，未声称零警告。

## 没有做的事

- 未修改任何现有数据库、容器、凭据或游戏进程；没有将现有配置自动切换为 dbproxy 模式。
- 未做真实 PostgreSQL/Redis 断电、重启、故障、压测、长稳或备份恢复验收。内存链路测试不是持久后端恢复证明。
- 未新增 DBProxy 协议/Schema 专用表；复用既有 SDK。运行 TiangZ 标准 codegen，未手改生成物或 API/协议锁，发布锁审核不在本轮。
- 未实现玩家当前区服目录、玩家存档、正式合服执行器、来源编号分配中心或完整迁移写屏障；没有提交或推送。

旧 local-development 模式仍存在且会告警，不能声称所有旧部署已获得跨重启唯一性。号段高水位不可回退，数据库丢失/克隆/旧备份恢复与混跑旧生成器需要另行受控切换，约束见 [设计说明](../design/global-id-ranges.md)。
