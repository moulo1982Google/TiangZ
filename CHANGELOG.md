# 版本记录

## 0.6.1 — 2026-09-23（发布，标签 `v0.6.1`）

非破坏性小版本；已有配置、模块和业务代码无需修改。需求来自苟道三国登录改造（按环境区分认证、不可猜测的一次性凭证、开发期修改模块协议字段）。

### 新增

- 进程配置 `process.environment`：`development | test | staging | production`，缺省 `development`，未知值拒绝启动；Stable API `ProcessRuntimeInfo` 供业务任意位置读取，健康端口 `/runtime-identity` 返回该值，启动日志打印。
- Stable API `SecureRandom`：由宿主 `getrandom` 提供操作系统安全随机数，提供 `Fill`、`Bytes`、`Hex`；源不可用时抛错，不退化为弱随机。
- 模块协议工具开发期参数 `--dev-regen-schema-lock`（`protocol-update --dev-regen-schema-lock`）：按当前 proto 重写 schema 锁，允许修改已有字段的类型、名称或编号；已删除字段与消息的编号保留为墓碑；发布成功后逐条列出破坏性变化；opcode 锁仍只追加；发布门禁下拒绝。

### 验证

- Rust：配置解析、健康端口运行身份、安全随机数（含真实 V8 冻结桥）单元测试；TS：`ProcessRuntimeInfo`、`SecureRandom` 单元测试；模块协议工具自测覆盖默认拒绝改类型、发布门禁拒绝、重写成功与差异输出、删除字段保留墓碑并拒绝异类型复用，且在 `TIANGZ_LOCK_VERSIONS=1` 下同样通过；`verify_core_api.mjs --strict-lock` 通过；`test:module-host` 以 `environment: staging` 真实启动并核对 `/runtime-identity`。完整矩阵以 GitHub CI 为准。

## 0.6.0 — 2026-09-20（发布，标签 `v0.6.0`）

在 `0.6.0-alpha.0` 开发预发布基础上完成本轮持久化能力并打标签；版本号去掉 alpha 后缀，模块声明的 `minVersion: 0.6.0-alpha.0` 仍然满足。配套 DBProxy 为 `v0.6.0`。

### 新增

- `.native` 持久化写法标记 `@queued`/`@transactional`（需 tiangz-native-language 0.17.0）：写法由数据语义决定，生成受限仓库；未加标记的实体生成文本逐字节不变。详见[持久化写法标记](docs/ai/business-development-manual.md#持久化写法标记2026-09-19)。
- `persistence.dbProxy.queuedClientPoolSize`（0..64，默认 0 与其他请求共用）：排队写使用专用连接，不与读取、直接写入争用。
- `persistence.dbProxy.maxInFlightPerConnection`（1..4096，默认 64）：每条 DBProxy 连接同时在途的请求上限；同一记录、操作或交易仍按发送顺序执行。
- 持久化写法长稳用例 `npm run soak:write-modes`：三种写法并行负载、七类故障注入与恢复、排空积压后直接查 PostgreSQL 对账；支持 `--players`（最多 500）、`--step-ms`、`--dbproxy-shards`、`--enqueue-ack`。

### 变更

- 排队写仓库只发送一次、不在内部重试：下一次排队写会取代它，重试只会在过载时放大负载。

### 验收

- 500 玩家过夜长稳（每人每种写法 60 秒一次）连续通过 7 轮七类故障，0 违例；收尾运行再完整通过 2 轮，普通写 28,522、排队写 32,755、事务 31,944 次确认，最终读取与 PostgreSQL 对账 0 问题。证据 `write-modes-run-2026-09-19T21-59-07-118Z`。
- `verify:quick` 32 项通过；写法长稳单测与 smoke 通过。

## 0.6.0-alpha.0 — 2026-09-15（开发预发布）

从 0.4.x 直接转入 0.6 模块化开发线；不补造 0.5 发布记录。本条记录开发基线，不代表已打标签、发布制品或完成正式发布验收。

### 当前能力

- 框架自有模块入门工程、统一开发命令、只读结构导航与组件配套创建，减少每个游戏重复脚本；Developer Tools 可复用宿主导航、诊断、向导和开发任务。模板是回环计数器教学工程，不是生产游戏。
- 模块源码开发模式复用共享 Watcher，已有行为保存后构建候选；Model/协议/声明变化提示重启，失败候选保留旧行为。构建结果带结构化不可变路径，支持含空格目录；类型检查输出边界错误行列和 JSON 诊断。

- 显式 `--host-profile modules` 提供不装配 MMORPG TS 示例/表数据的宿主，默认 demo 保持原行为。两者共享 Core ProcessBootstrap；脚手架、编辑器配置、类型检查和构建统一识别模式，模式切换要求重建重启。TS 模块可复用通用 Watcher；Rust 内置 Native ops 仍保留，不代表二进制裁剪。

- 外置游戏模块拥有自己的 Protobuf、协议锁、TypeScript/Godot SDK、公开 API、配置、持久化迁移和 Native 组合构建。
- 模块化主线已整合；历史整合范围与验收见[整合记录](docs/design/mainline-integration-20260915.md)，不能用历史验收代替当前工作区的发布检查。
- 开发工具支持模块编辑器路径准备、Model 桥接检查，以及协议输出保护、只读检查和失败回滚。游戏源码与生成输出留在独立游戏目录。
- 新建模块的宿主最低版本保留当前完整版本（含 alpha 等预发布标识），避免生成的模块拒绝创建它的宿主；脚手架自测覆盖该约束。
- 框架定位为通用游戏服务端，MMORPG 保持为领域示例；独立 SLG + Cocos Creator 3.8.8 正用于检验开发体验。

### 升级要求与边界

- 版本源是 Cargo.toml；npm 清单、依赖锁和 README 同步为 0.6.0-alpha.0。DBProxy 和游戏模块继续独立编号。
- 原有模块的 `<0.5.0` 宿主上限会拒绝本版本。必须逐个验证消费工程，再更新 tiangz.module.json；不能批量放宽未经验证的模块。
- 已确认 ModuleGame（expedition/wasteland）和 WoW335 仍声明旧宿主范围，本次保留不动；重新使用本主线构建前需要单独迁移。不切换它们现有运行服务。
- SLG 接入本开发基线，宿主范围设为 `[0.6.0-alpha.0, 0.7.0)`；这不是对未来全部 0.6 版本的兼容验收承诺。
- 重新生成并构建游戏制品、重新构建宿主并重启进程；不能依赖 Hotfix 切换宿主版本，也不能跳过协议和 Model 指纹。
- 本次编号不修改业务协议、Stable API 或 Native schema，也不自动更新这些契约的锁。正式发布仍需单独完成发布门禁。
- SLG 当前只读地图快照可用；登录、行军、采集与玩家持久化闭环尚未完成。

### 本次开发验证（2026-09-15）

- `node tools/verify_project_version.mjs --strict`、脚手架/模块目录自测、两个内置模块样例的目录校验及 `git diff --check` 通过。
- `npm.cmd run verify:quick` 执行了 codegen；内层 check 15/15，TypeScript 单测 217 项通过，Rust native-data 测试、模块回归、fmt 和 clippy 通过。最终 quick 报告为 25 通过、1 失败：最后的 `cargo test --all-targets` 等待 VS Code rust-analyzer 持有的构建锁，本次主动停止了自己的等待进程，未完成该项；没有终止编辑器进程。不能宣称快速回归全绿。
- SLG `npm.cmd run build`、`npm.cmd run smoke` 通过，新宿主实际报告 `0.6.0-alpha.0`，认证连接独立 DBProxy 并完成真实 WebSocket 地图快照 RPC。
- 未运行完整 `verify`、正式发布门禁、长稳或容量验收；模块 Godot 新工程运行检查因未设置 GODOT_BIN 跳过。未打标签、推送或发布。

## 历史基线

### 模块宿主分离验收 — 2026-09-16

- 本轮目标是完善 TiangZ 与通用开发流程，未修改 SLG 玩法或其他游戏部署。
- `npm.cmd run verify` 完整通过：quick 26/26、check 15/15、full 12/12，总耗时 1329613 ms；其中 Native 组合冷构建及验收约 542411 ms。
- 框架自有 `test:module-host` 验证独立模块真实启停、不装配 MMORPG 代码/内置表、内置 Scene 拒绝、示例类型误用拒绝、同模式 Hotfix 构建通过及跨模式拒绝；补充单独复验了配置篡改拒绝。
- 新增空宿主配置单测单独通过；原矩阵的 TypeScript 测试为 217 项。类型检查、领域边界、代码生成清单、版本一致性和 diff 检查通过。
- 执行了 codegen，未修改业务协议及其锁；未发布、推送或切换现有服务。Godot 新工程实际运行检查因未设置 GODOT_BIN 跳过；未另跑容量或长稳测试。MSVC 仍有既存 LNK4098 警告。

## 更早基线

- `0.4.0`：空间坐标与协议契约里程碑，后续 0.4.x 开发能力见现有设计和验收记录。
- `0.3.10`：框架能力的首个稳定基线。
