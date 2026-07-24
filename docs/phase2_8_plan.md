# Phase 2.8 工程化收口计划

> 历史记录：Phase 2.8.1 的本地 Rust 虚拟连接方案已被 Process/Scene 改造替换。当前本地 Scene RPC 在 TS `ProcessRuntime` 中进入目标 mailbox，跨进程才进入 Rust transport。

Phase 2.8 位于多人地图纵向链路与正式角色业务之间。目标不是增加新玩法，而是保证后续业务在同进程、跨进程、故障和升级场景下具有一致、可诊断、可维护的运行语义。

## 原则

- 部署方式只能改变传输成本，不能改变 mailbox、错误和 Handler 时序语义。
- 框架日志不得影响普通业务成功与失败；审计日志必须由业务显式声明。
- 已发布协议必须保持消息号和字段兼容。
- Core 提供机制，Generated 提供类型绑定，Demo 只保留演示业务。
- 每一阶段同时补充单元测试、同进程测试和拆分进程测试。

## Phase 2.8.1：同进程与跨进程语义一致性

状态：已完成。

- 移除绕过 Service ingress mailbox 的本地 `DirectCall`。
- 同进程 RPC 使用内存队列和虚拟连接响应出口，但进入与网络请求相同的 Service mailbox。
- 同进程 Message 继续使用相同 ingress mailbox。
- Inner msgcode 校验在本地和网络传输上保持一致。
- 增加 unordered Service 并发 Handler 的同进程/拆分进程一致性测试。
- 保持业务侧 `messages.call()` 和配置格式不变。
- 当前 unordered 并发粒度仍是单次 Runtime 拉取的 batch；异步 Handler 等待期间持续接收新 batch 的能力留到生命周期与调度改进中处理。

验收标准：

1. 同进程调用不经过 TCP。
2. 同进程与拆分进程的 ordered/unordered 行为一致。
3. RPC 错误码、超时和响应 msgcode 校验保持一致。
4. `npm run test:runtime` 和 Rust transport 测试通过。

验收结果：

- 删除 `DirectCall`、`__etsHandleLocalFrameBinary` 和 `Service.handleLocalFrame()` 旁路 API。
- 同进程 RPC 使用高位虚拟 connectionId、目标 Service 事件队列和正常 outbound 响应出口，全程不经过 TCP。
- 本地 Call/Send 与跨进程连接执行相同的 Inner msgcode 范围校验。
- mailbox parity 测试并发调用 8 次 unordered BenchService：同进程最大并发 7，拆分进程最大并发 8，均通过。
- 原有登录、地图快照、Enter/Move/Leave 的单进程与拆分进程测试：通过。
- 背压回归峰值队列 4096、等待 799 次、请求错误 0、慢连接误断开 0：通过。
- `npm run test:phase2.8.1` 可执行本阶段完整验收。

## Phase 2.8.2：协议稳定性

状态：核心发布契约完成。

- 已提交 `proto/opcode.lock.json`。普通 `npm run codegen:proto` 只校验；评审新消息编号后显式执行 `npm run codegen:proto:update-lock`。
- 锁文件保留已删除消息的编号占位，旧消息改名、插队导致后续消息重编号、复用历史编号都会失败。
- `uint64/int64` 在服务端 TS、公共 Client SDK、Cocos 与 Pixi 统一表示为 `bigint`，覆盖无符号最大值、有符号最小值、负数二补码和越过 JS 安全整数范围的测试。
- 修复 repeated 标量默认值被错误省略的问题，数组中的 `0/0n/false/空字符串` 不再改变元素数量。
- Client SDK 已生成协议指纹；客户端版本拒绝策略属于生产发布兼容策略，进入 Phase 5 前与热更、灰度和回滚一起确定，不在 Demo 登录链路中硬编码。
- enum、显式 optional 与 packed scalar 的跨语言兼容矩阵仍属于协议工具链增强，不阻塞当前已有协议和 Phase 4 业务开发。

## Phase 2.8.3：日志、错误模型与链路耗时

状态：主体完成。

- Core 提供结构化 Logger，统一 Rust 与 V8 的日志字段；Cocos SDK 的日志接口仍待单独设计。
- 已完成 Rust `tracing`、TS Core Logger、级别过滤、开发文本/生产 JSON、非阻塞控制台与滚动文件输出；Cocos 客户端日志仍保持独立。
- ProtocolContext 已自动携带 `connectionId/rpcId/msgcode/requestId/logger`；跨进程 `traceId/source/target` 传播尚未设计，不能用本地 requestId 冒充。
- 服务端保存完整错误堆栈，客户端只接收稳定错误码和脱敏消息。
- 区分框架日志、普通业务日志和会影响业务结果的审计日志。
- 框架和普通业务日志已区分类别；可靠审计投递尚未实现，业务不得把普通 Logger 当作审计存储。
- 已修复 Handler 异常被转换为响应后 `failedFrames` 仍为零的问题；业务错误单列，不污染框架失败率。
- 已完成第一版链路耗时聚合：`ingress.queue`、`frame.total`、`protocol.decode`、`protocol.handler`、`protocol.encode`、`scene.call/send.local/remote`。
- 链路耗时以 `[latency:<process>]` 日志输出，字段包含 `scene/type/name/msgcode/count/avg/p50/p95/p99/max`；详细口径见 `docs/reference/observability.md`。

## Phase 2.8.4：指标与健康检查

状态：健康检查完成，Prometheus 导出待 Phase 5。

- 已按 Scene 统计协议成功、业务错误、系统错误、解码错误、无 Handler 和单向消息 Handler 异常。
- 增加 Handler 延迟分布、慢 Handler、Actor mailbox 深度和丢弃消息指标。
- 已增加独立 HTTP `/live` 与 `/ready`：就绪要求业务端口和 TS Scene 启动屏障均完成，停机开始立即撤销。
- Prometheus `/metrics` 尚未实现；现有指标继续通过结构化日志输出，Phase 5 再接入 Prometheus/Grafana。
- 指标采用窗口值和速率，避免累计最大值长期失真。

## Phase 2.8.5：生命周期与开发体验

状态：Phase 4 准入项完成。

- 已增加可等待的 `onStart/onReady/onStop`；直接启动单个 Process 配置时，Windows `CTRL_C/CTRL_BREAK` 与 Linux `SIGINT/SIGTERM` 会进入 TS stop、关闭连接并等待保存。
- Watcher 使用跨平台父子控制管道同时通知所有子进程，再按各自 `stopTimeoutMs` 等待；仅超时才强杀。Watcher 消失造成管道 EOF 时，子进程也会主动收尾，避免遗留孤儿进程。
- 任一子进程提前退出都会触发其余进程优雅停机并让 Watcher 返回失败；优雅停机超时才强杀。自动重启、退避与滚动更新仍属于 Phase 5 生产监管能力。
- MapHost 停止时会按 Gate 批量踢出玩家；玩家数据保存封装在幂等 `PlayerUnit.Offline()` 中，踢人逻辑不直接调用 Repository。
- `process.lifecycle.stopTimeoutMs` 默认 10000ms，保存失败或超时会让停机失败并留下错误日志。
- 校验重复 Service 名称、地址、依赖和生产环境 Inner Token。
- 生成类型安全的 ServiceType、Actor Handler Descriptor 和 Proxy。
- 增加 Timer、IUpdate 和可替换 FakeClock。
- 增加 `npm run verify:codegen` 的只读哈希/文件集校验、`verify:quick` 日常质量门和完整 `verify` 运行时门；Rust fmt/clippy 已纳入命令，CI 托管仍待远程流水线环境。
- 手写 Core、Demo 和 Rust 宿主公共边界已按 TSDoc/Rustdoc 补充作用、副作用、误用约束和设计原因；规范见 `docs/reference/coding-conventions.md`。

## 暂不纳入

- 数据库、角色、背包和公会等正式业务。
- 正式 AOI、跨地图迁移和战斗系统。
- 完整 TypeScript 热更新与 OpenTelemetry 接入。

这些内容应建立在 Phase 2.8 的运行契约之上，而不是与基础设施修复同时推进。
