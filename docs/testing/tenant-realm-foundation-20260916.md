# 租户与合服基础验收（2026-09-16）

## 后续边界整理：模块策略与通用计划分开

以下更新优先于下文第一版规划记录；DBProxy 本次没有改动。

- TiangZ tools 的目录/请求/输出升为格式 v2：realmGeneration 表示区服代次；通用 migrate 阶段不再假定重建地图。新增显式 --policy 纯 JSON 输入，校验 ownerModuleId/policyId/revision/decisions 信封，策略进入计划指纹。
- SLG 的重建设计移到 modules/slg/policies/realm-merge.json；configs/realms 和工具入口同步更新。只有手写设计声明和生成计划，不是新增的 SLG Demo 合服业务。
- 主工程只使用中立测试夹具；其他游戏的领域动作无需修改主工程。策略没有执行 Hook，也未接入运行时模块图和业务迁移器。
- TiangZ `node --test tools/realm_merge_plan.test.mjs`：20/20 通过，加入 verify:quick 矩阵。
- TiangZ `npm.cmd run verify:quick`：29/29 通过；`git diff --check` 对本轮修改的已跟踪文件通过。Rust 测试仍报告已有 LNK4098 链接警告，本轮未改链接配置。
- SLG `npm.cmd run test:realm-plan`：1/1 通过，真实调用只读 CLI 并检查模块策略和未决状态；`npm.cmd run realm:plan`、`npm.cmd run check` 通过。
- 文档同步了能力归属、命令、AI 项目上下文、业务手册以及 SLG 说明。插件没有修改；以后只呈现同一份诊断与计划。
- 未改变协议定义；快速检查运行官方 codegen，SLG check 校验生成物。未执行 SLG 游戏构建/联机 smoke、Cocos 画面、真实存储、迁移、故障或长稳验收；本次只改离线规划工具和声明，未改游戏运行时代码。

这次没有修改 Core、Rust、DBProxy、数据库或现有游戏服务，也没有提交/推送。未来执行器仍须校验真实模块身份、制品、领域策略覆盖与迁移结果，不能把声明完整视为可执行合服。

## 本次改动

- TiangZ-DBProxy：`crates/dbproxy-server` 的凭据绑定路由、多租户启动入口、连接预算、监控与后台任务；`configs/tenants.example.json` 和子配置；部署文档及测试。
- TiangZ：`tools/realm_merge_plan.mjs` 和测试，只读校验区服目录并生成新世界合服计划；相关设计与 AI 上下文文档。没有修改 Core、GlobalId 布局或游戏协议。
- TiangZ-Examples：`packages/slg/configs/realms`、`tools/realm_plan.mjs`、`realm:plan` 脚本与说明。没有增加玩家、行军或联盟业务，也没有接入运行时切服。

## 已通过

- DBProxy `cargo test --workspace`：默认工作区测试通过；依赖真实存储的 ignored 用例没有执行。
- DBProxy `cargo test -p tiangz-dbproxy-server`：补充凭据长度前置校验后再次通过，包含 44 项库测试、4 项新增租户集成测试及现有网络测试。
- DBProxy `cargo clippy --workspace --all-targets -- -D warnings`，`cargo fmt --all`，`git diff --check`。
- DBProxy `npm.cmd run test:typescript`：18 项通过；运行官方 SDK 生成流程，未改变协议定义。
- DBProxy `target/debug/tiangz-dbproxy-server.exe --check-tenants configs/tenants.example.json`：离线结构检查通过，不读取密钥或连接数据库。
- TiangZ `node --test tools/realm_merge_plan.test.mjs`：11 项通过。
- TiangZ `npm.cmd run verify:quick`：28/28 项通过，包含 Rust Clippy 与 all-targets 测试；链接阶段出现 LNK4098 默认运行库冲突警告，本轮未修改链接配置，未将其描述为零警告构建。
- Examples `npm.cmd run check -- --package slg`：模块目录、协议生成物与类型检查通过。
- SLG 包 `npm.cmd run realm:plan`：成功输出 `executable:false` 的计划，所有阶段 pending；资产、联盟、行军结算、入场位置仍明确列为待决业务。

多租户集成测试使用临时自有进程/真实 TCP/独立内存后端，验证凭据路由、同键与同幂等号隔离、回执、追加事实和事件提交、重连及租户连接额度。不是 PostgreSQL/Redis 故障恢复证明。

## 未执行与后续门槛

没有修改、重启现有容器、数据库或游戏进程；没有执行真实数据库迁移、压测、长稳、故障注入、正式合服或发布。没有提交或推送本轮代码。

真实 PostgreSQL/Redis 的后台队列隔离、重启恢复与故障影响需要独立可丢弃环境验收。共享实例仍共享资源与故障域。合服执行器、权威写屏障、目录切换及跨重启 ID 唯一性保障尚未实现；不能把只读计划当作运行时保证。

后续执行器还必须将 operationId 绑定首次批准的 planHash；同一 operationId 的输入变化应拒绝执行，不能依靠变更后的阶段操作键重新迁移。
