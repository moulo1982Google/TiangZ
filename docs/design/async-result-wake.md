# 异步结果唤醒与回包补取

2026-10-08：修正空闲或低负载 Process 中异步结果的交付延迟。宿主内部改动，不改协议、配置、Stable API 与 TS 业务写法；需重建宿主并重启，不能 Hotfix。

## 问题

主循环空闲时停在事件队列等待，最长 `idle_tick_ms`（adaptive 默认 50ms，Windows 计时精度下实测约 58–60ms）。改动前有三个独立原因让异步结果多等：

1. **异步 op 完成不叫醒主循环。** deno_core 0.411 在一个 tokio 本地任务里推进在途异步 op，结果完成只唤醒该任务；该任务只在 V8 线程进入 `block_on` 时运行。DBProxy（宿主运行时任务）、模块 Native worker（专用线程）、event_stream 交出结果后都不通知主循环，结果要等下一个 idle tick。主循环原有唤醒只用于“已放入事件”的情况：被叫醒后若队列为空会继续睡。
2. **有未完成 op 时每次推进 JS 都要等。** 旧 `pump_js_event_loop_once` 用 `timeout(1ms, run_event_loop)`，只要有 op 未完成就等满预算；Windows 计时精度约 15.6ms，实测每次约 16ms，期间同进程其他请求排队。
3. **async Handler 回包晚一轮。** Handler 在 TS Update 内派发，回包在 Update 末尾统一取走；async Handler（即使没有 await）的回包在 Update 返回后的微任务里才产生，只能等下一轮 Update。

## 机制

- `src/host_wake.rs` 提供 Process 级“异步结果待交付”信号：先置标志，再向主循环既有的容量为 1 的唤醒通道发信号（与网络帧、跨进程 RPC 完成共用，多次通知自然合并）。`ProcessEventReceiver::recv_timeout` 在队列为空且标志被置时立即返回超时，主循环推进一轮 JS；不带标志的唤醒保持原语义。
- 结果交出点在结果可取之后通知：Native worker 在 `reply.send` 之后；DBProxy（`dbproxy_request::execute`）与 event_stream 的宿主任务改为先把结果放入 `oneshot` 再通知，V8 侧等待 `oneshot`。通知守卫先于发送端声明，任务 panic 时发送端先析构、V8 侧先看到终止，随后才叫醒。超时、调用方取消即中止宿主任务等语义不变。
- `pump_js_event_loop_once` 不再设计时器：最多轮询 `HOST_EVENT_LOOP_PUMP_ROUNDS`（2）轮，每轮之间自唤醒让 tokio 运行已就绪任务（含 deno 的 op 推进任务），未完成的 op 留给后续轮次。tokio 在自唤醒后的驻留会立即返回并处理到期计时器，V8 内计时器仍会推进。
- `flush_runtime_batch` 在 Update 报告 `pendingAsync` 时执行一次微任务检查点并再调用一次 Update 取回包。不等待任何 I/O；游戏固定帧与 Timer 按时间门控，等价于立即多跑一轮空循环。不能改为让 Update await Handler：宿主以 `call_with_args_and_await` 调用 Update，等待未完成 op 会把 V8 卡到 op 完成。

## 不变的语义

- 叫醒只让 V8 线程提前结束等待，不在其他线程执行 JS，也不打断正在执行的 JS；JS 仍只在 V8 线程按原顺序运行。
- ordered/unordered mailbox、Hotfix 屏障（含 Native 交付计数）、停机排空、`Game.Update` 固定帧与 Timer 时间门控不变。
- 有持续流量的进程原本就被网络帧频繁叫醒，行为基本不变；收益主要在空闲/低负载进程（登录、低在线服、夜间）。

## 使用约束（与 Native worker 相关）

- worker 计算函数、宿主任务都不能读写 V8 线程的实体存储。实体存储是 V8 线程的线程局部变量，在其他线程访问不会报错，而是看到一份空数据。输入应在 V8 线程用同步 op 序列化，结果 await 回来后再在 V8 线程写回。
- 写回时数据可能已变化（其他 Handler、固定帧、实体销毁）：检查句柄代次或版本，或只用于输入一次、结果一次的自包含计算。

## 验证记录（2026-10-08，Windows 10 / 7950X，debug 构建）

证据在本 worktree 的 `target/loop-wake-evidence/`（gitignore）：单元测试、Clippy、`verify:quick` 日志与端到端报告。端到端用实验分支 `test/async-op-latency-main` 的驱动派生脚本，夹具为 starter 模块 + 官方 `native.workers` + 自带 memory 模式 DBProxy（v0.7.0-rc1），不连任何已有数据库；基线为同一 rc1 源码、未启用任何修复的组合宿主。

- Rust：`cargo test --bin TiangZ` 235/235（新增 4 项：信号合并与等待语义、推进不等待、DBProxy 与 worker“先可取后叫醒”），`cargo clippy --bin TiangZ --tests -- -D warnings` 与 `cargo fmt --check` 通过。
- `npm run verify:quick`：34/35。唯一失败为 `soak control memory and bounded reports` 中依赖 PowerShell 7 的用例（`spawn pwsh ENOENT`）；本机只有 Windows PowerShell 5.1，未改动的 rc1 源码同样失败，与本改动无关，同步骤其余 19 项通过。未运行完整 `verify`。

空闲 adaptive，RTT 中位数（rc1 基线 → 本实现）：

| 场景 | rc1 | 本实现 |
|---|---|---|
| 同步 Handler | 0.37ms | 0.37ms |
| async Handler（不 await） | 59.3ms | 0.4–0.7ms |
| NativeWorkers 0ms / 5ms | 59.7 / 59.6ms | 0.45–0.57 / 5.45ms |
| DbProxyEntityRepository Load / SaveSnapshot | 58.4 / 60.2ms | 0.63–0.82 / 0.67–0.85ms |
| 30ms worker 计算期间另一连接 p99 | 16.0ms | 0.33ms |

low-latency 模式由约 18ms 降至 0.3–1.0ms。空闲 10 秒进程 CPU 与持续同步请求的每请求 CPU 无明显变化（Windows CPU 计数粒度约 15.6ms）。

20 条连接背靠背 DBProxy 读（各 3 轮）：rc1 10.5k–11.0k 次/秒、p99 14.6–15.5ms、每请求 204–246µs；本实现 16.3k–18.5k 次/秒、p99 1.8–2.1ms、每请求 239–261µs。每请求 CPU 约高 10–15%，来源不是“补取回包”（实验分支单独开关对比：补取前后均约 230µs），而是结果到达即推进，高负载下每轮批次变小。推进轮数从 4 降为 2 后吞吐由 15.5k–16.4k 回升（4 轮时每轮都跑满轮询）。

真实后端（专用 Docker 容器 PostgreSQL 18.6 + Redis 8.8.1，仅绑定回环；基线与本实现各用新数据库与独立 Redis 逻辑库；event_stream 用独立逻辑库与各自消费组），空闲 adaptive RTT 中位数 / p99：

| 场景 | rc1 | 本实现 |
|---|---|---|
| Repository.Load（postgresRedis） | 59.3 / 67.0ms | 2.4 / 6.4ms |
| Repository.SaveSnapshot（postgresRedis） | 59.5 / 67.0ms | 6.8 / 13.5ms |
| HostStreamConsumer.Poll（Redis 消费组） | 59.1 / 66.0ms | 1.4 / 6.3ms |

rc1 的 59ms 中已包含真实存储耗时（约 2–7ms），被 idle tick 掩盖；本实现后剩下的就是存储本身的耗时。low-latency 下 rc1 约 17–19ms。全部请求成功，DBProxy 日志无错误，两个消费组均已在 Redis 中创建。

未覆盖：Linux 与 release 构建；完整 `npm run verify`；高负载下按忙闲合并叫醒以降低每请求 CPU 的优化。

合入 `release/v0.7.0-rc1`（合并提交 d30d8498，含 HTTP 集成）后复测：Rust `cargo test --bin TiangZ` 258/258，`cargo clippy --all-targets -- -D warnings` 与 `cargo fmt --check` 通过；`npm run verify:quick` check 8/8、quick 34/35，唯一失败仍为依赖 PowerShell 7 的 `spawn pwsh ENOENT` 用例。宿主 SHA-256 f9396f93…（debug）。`v0.7.0-rc1` 标签仍指向 bf25dddf，本修正随下一个 0.7 版本发布。
