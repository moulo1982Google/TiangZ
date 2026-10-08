# 版本记录

## 未发布（0.7，RC1 之后）

非破坏性新增；已有配置、模块和业务代码无需修改。需求来自苟道三国登录改造（F4：生产环境用 HTTP 接口返回 Login 地址，以后工具类接口也会用到）。

### 新增

- Scene 配置 `http`：为 Scene 开一个独立 HTTP 端口，请求进入该 Scene 的 mailbox。Rust 负责请求体上限（默认 64 KiB）、读体与回复共享期限（默认 10 秒，分别返回 408/504）、并发上限（默认 256，返回 503）、可选 Bearer 令牌（令牌不进入 V8）和跨域预检。
- Stable API `httpHandler(SceneCtor, method, path)`、`HttpError`、`jsonResponse` 及类型 `HttpMethod`、`HttpRequest`、`HttpResponse`、`SceneHttpHandler`、`SceneHttpConfig`；Handler 可热更，路由精确匹配，缺失路径 404、方法不符 405。
- 新增直接依赖 `hyper`（http1/server）、`hyper-util`、`http-body-util`；均已在依赖树中，未引入新的第三方包。
- 连接准入与请求号隔离（评审修正）：新增 `http.maxConnections`（默认 max(1024, maxInFlight)，上限 16384），在创建连接任务前准入，名额覆盖连接整个生命周期，满额新连接立即关闭；回复写出连续 10 秒无进展断开，每连接读缓冲软上限 64 KiB。HTTP 请求号改由 HTTP 入口独立分配并在 u32 内回绕、跳过在途号，不再消耗游戏连接号（此前持续 HTTP 流量会耗尽连接号并使游戏端口停止接入）。
- 状态码与可观测性（评审修正）：503 只表示请求未执行、可安全重试；入队后结果未知（超时、停机）改为 504，排队节点被丢弃时如实返回 503，Handler 执行后无回复返回 500；停机时已入队请求继续等待真实结果直到排空期限前。新增 `tiangz_http_requests_in_flight`、`tiangz_http_requests_detached`、`tiangz_http_oldest_detached_seconds` 指标，busy 且名额被已离开调用方占用时限频告警；非回环地址未配置令牌时启动告警；单个连接任务 panic 只关闭该连接，不再停止进程。内部 op `op_host_http_discard` 增加 `executed` 参数（Stable API 不变）。

### 验证

- Rust：配置校验（端口冲突、上限、跨域来源、未知字段）、回复校验（状态码、宿主管理的头、大小）、真实 HTTP 转发与回复、401/413/预检/跨域来源拒绝、令牌头不转发、超时 504 与迟到回复丢弃、令牌变量缺失拒绝启动；TS：请求解码、路由注册校验、同步与异步 Handler 经 ordered mailbox 顺序执行、404/405/400/403/500 映射；`test:module-host --runtime` 在真实进程中验证 200、401、404、405 与令牌不可见。

- 0.7 集成复测：Windows 默认功能集 full 9/9、quick 35/35、TS 234 项、Rust 全目标 284 项通过；新增读体超时、执行许可保留、入站预算、监听监督和停机回收覆盖。初次夹具编译失败及复测证据见 `RELEASE-v0.7.0-rc1.md`。

## 0.6.5 — 模块异步 Native worker（2026-09-30，标签 `v0.6.5`）

- 模块可声明专用 FIFO 计算线程与输入、输出、在途容量；生成 Promise、stats、drain 接口，原同步 Native op 不变。
- 计算不访问 V8；调用方超时不取消已接收任务。Hotfix 与停机屏障覆盖计算和 Promise 交付，预检不创建计算线程。
- 普通宿主与不同模块组合按 graphHash 隔离构建输出，避免同名 TiangZ 二进制污染缓存。
- 本地严格发布矩阵 8/8、Rust 123/123；提交 528203f 的 Windows/Linux verify 与发布打包、starter、security 均通过。实际游戏单进程 8 份冻结报告、并发 RPC 与业务排空通过，真实进程活跃 worker 的热更/停机验收通过。发布元数据提交仅更新文档，不改已验收的运行时代码。详细契约见 docs/design/native-workers.md。

## 0.6.4 — WebSocket 关闭握手修正（2026-09-29，标签 `v0.6.4`）

- v0.6.3 已修正 TS 出站帧与关闭请求的交付顺序，但 WebSocket 传输在排空后直接丢弃连接，未执行 Close 握手；客户端仍有迟到输入时，Windows 可返回 TCP reset，甚至使已排队的通知在客户端读取前丢失。
- Tokio WebSocket 后端改为排空应用帧后发送 Close；关闭期间继续读取并丢弃迟到应用输入，等对端 Close 后释放。握手与剩余写入共用 3 秒预算，超时回收写任务。TCP、KCP、TS API 和协议不变；需重建宿主并重启，不能 Hotfix。
- 新增 6 项真实 socket 回归测试：带迟到输入的通知顺序、多批排空、对端主动关闭（含 32 个独立连接的积压输出）、对端不确认关闭、非法文本帧清理。首项在修正前读取通知即报 Windows 10054，修正后通过。读写任务已推进到终止状态时正确回收，不把 `AlreadyClosed` 误报为排空失败；其余错误保留。正常关闭顺序不保证故障或超时下客户端必达。
- 修复提交 `52cef92` 的 Windows/Linux verify、security、starter 全过，本地完整矩阵 8/8、Rust 119/119，游戏重建宿主后 80/80 与完整冒烟通过。版本元数据更新后另跑严格发布门禁，发布标签只在验证通过后创建。早期失败和复测证据保留在 AI 业务手册。

## 0.6.3 — 2026-09-28（发布，标签 `v0.6.3`）

非破坏性修正版本；已有配置、模块和业务代码无需修改。需求来自苟道三国登录顶号：通知偶发丢失。

### 修正

- `disconnectClient` 的关闭请求不再立即交给宿主，而是随本 Scene 下一次出站排空、排在此前 `sendClient` 入队的帧之后交出。原来在 Scene 更新之后（如 RPC 续体）"先推送通知再断开"时，通知帧要等下一次更新才交给宿主，而关闭在本轮末尾就执行，通知会被丢（苟道三国顶号 smoke 偶发）。Rust 传输层（epoll、io_uring、KCP）关闭前排空已交付帧的保证不变，本次补齐 JS 层的顺序。
- `SceneUpdateResult` / `ProcessUpdateResult` 新增 `closes`；进程停机释放 Scene 时，尚未交出的关闭请求直接交给宿主。

### 验证

- 新增 `tests/unit/disconnect_after_outbound.test.ts`：Scene 排空后才请求的关闭仍随其前的帧交出并去重；多个 Scene 的关闭合并；停机时未交出的关闭直接交给宿主；宿主桥接先交付出站帧再关闭。其中 3 项在修正前的代码上失败。完整矩阵以 GitHub CI 为准。

## 0.6.2 — 2026-09-23（发布，标签 `v0.6.2`）

非破坏性小版本；已有配置、模块和业务代码无需修改。版本号在 `0.6.0` 之后直接取 `0.6.2`（与配套 DBProxy `v0.6.2` 对齐），未发布 `0.6.1`。需求来自苟道三国登录改造（按环境区分认证、不可猜测的一次性凭证、开发期修改模块协议字段）。

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
