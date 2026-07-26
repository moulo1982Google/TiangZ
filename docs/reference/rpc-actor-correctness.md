# RPC与Actor正确性

本文记录Phase 3.10.2冻结的调用、错误和生命周期语义。业务开发者通常只需要使用生成descriptor、`SceneMessageHelper`和Actor Handler；不得手工管理`rpcId`或绕过mailbox。

## RPC不变量

| 场景 | 保证 |
| --- | --- |
| 本地Scene调用 | 与远程调用使用同一protobuf帧和Response校验，仍进入目标mailbox |
| 远程Scene调用 | 一条持久TCP连接按payload中的`rpcId`多路复用，不发生队头阻塞 |
| `rpcId`分配 | `1..uint32::MAX`循环分配，尚未完成的id不会被复用 |
| 显式timeout | 远程调用由Rust transport计时；本地调用传入`timeoutMs`时由Host timer计时 |
| 迟到或重复Response | 已无等待者的Response被忽略并计入`late_responses`，不能完成另一个调用 |
| 连接断开 | 该连接上的全部pending RPC立即失败，`pending_calls`归零 |
| Process停机 | TS bridge拒绝全部pending Host操作并清空尚未提交队列；后续completion按迟到事件忽略 |
| Response校验 | response msgcode、payload `rpcId`和`error`依次校验，任一不匹配都不能作为成功返回 |

默认本地调用不额外创建timer，避免为每次进程内调用增加Host op。只有业务显式传入`{ timeoutMs }`时才启用本地deadline。远程调用继续使用默认5000ms timeout。

`send`不是简化版RPC。它不创建Response等待者：本地成功表示消息已被目标mailbox接受，远程成功表示已进入传输发送路径；后续Handler异常只写结构化日志和指标。

## Actor不变量

- `ordered` Actor在Handler跨越`await`期间保持mailbox所有权，后续消息排队，不允许同mailbox同步`call`自己。
- `unordered` Actor允许并行处理和自调用；一个Handler失败只拒绝对应调用，不阻塞其他消息。
- Actor路由同时校验`sceneId`、业务`actorId`和`instanceId`。相同业务id重建后，旧引用永久失效。
- Actor销毁会取消其定时器、拒绝队列中的call，并使正在`await`的旧实例不能再向调用者返回成功。
- JavaScript Promise本身无法强制终止。Actor销毁后，已进入Handler的异步函数可能继续运行到下一个检查点，因此业务异步代码不得在`await`后无条件操作外部资源；需要时检查`IsDisposed`或重新验证权威句柄。

## 错误语义

- RPC找不到Handler、解码失败或框架异常：记录系统错误，并用原`rpcId`返回对应Response，系统错误码小于10000。
- RPC业务拒绝：返回业务错误码，业务错误码从10000开始。
- 单向Message失败：记录日志和指标，返回值始终为空，不生成通用`ErrorResponse`。
- ActorLocation RPC路由失败：Gate使用请求descriptor生成错误Response；ActorLocation Message路由失败只记录错误。

## 验证

```powershell
npm run test:actor
npm run test:protocol
npm run test:rpc-actor-correctness
cargo test --bin TiangZ transport::tests
```

`npm run verify:quick`已包含RPC/Actor专项测试和全部Rust transport单元测试。完整`npm run verify`继续覆盖真实Runtime、拆分进程mailbox一致性、背压和Watcher停机。
