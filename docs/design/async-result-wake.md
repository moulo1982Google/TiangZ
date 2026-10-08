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
- `pump_js_event_loop_once` 不再设计时器：最多轮询 `HOST_EVENT_LOOP_PUMP_ROUNDS`（4）轮，每轮之间自唤醒让 tokio 运行已就绪任务（含 deno 的 op 推进任务），未完成的 op 留给后续轮次。tokio 在自唤醒后的驻留会立即返回并处理到期计时器，V8 内计时器仍会推进。
- `flush_runtime_batch` 在 Update 报告 `pendingAsync` 时执行一次微任务检查点并再调用一次 Update 取回包。不等待任何 I/O；游戏固定帧与 Timer 按时间门控，等价于立即多跑一轮空循环。不能改为让 Update await Handler：宿主以 `call_with_args_and_await` 调用 Update，等待未完成 op 会把 V8 卡到 op 完成。

## 不变的语义

- 叫醒只让 V8 线程提前结束等待，不在其他线程执行 JS，也不打断正在执行的 JS；JS 仍只在 V8 线程按原顺序运行。
- ordered/unordered mailbox、Hotfix 屏障（含 Native 交付计数）、停机排空、`Game.Update` 固定帧与 Timer 时间门控不变。
- 有持续流量的进程原本就被网络帧频繁叫醒，行为基本不变；收益主要在空闲/低负载进程（登录、低在线服、夜间）。

## 使用约束（与 Native worker 相关）

- worker 计算函数、宿主任务都不能读写 V8 线程的实体存储。实体存储是 V8 线程的线程局部变量，在其他线程访问不会报错，而是看到一份空数据。输入应在 V8 线程用同步 op 序列化，结果 await 回来后再在 V8 线程写回。
- 写回时数据可能已变化（其他 Handler、固定帧、实体销毁）：检查句柄代次或版本，或只用于输入一次、结果一次的自包含计算。

## 验证

见文末验证记录（随实现提交更新）。
