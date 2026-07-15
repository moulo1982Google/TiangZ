# Phase 1.10 验收说明

> 历史记录：本文的 Service 指当时旧版 mailbox owner。当前对应概念为 EntryScene，一个 Process/V8 可承载多个 EntryScene。

Phase 1.10 优化完整的本机 RPC 热路径，同时避免把业务 API 拆成同步、异步两套装饰器。

## Handler Model
## Handler 模型

同一个 `@rpc` 装饰器支持两种写法：

```ts
@rpc(BenchProtocol.RuntimePing)
ping(request: PingRequest): PingResponse {
  return createResponse(request);
}

@rpc(LoginProtocol.Login)
async login(request: LoginRequest): Promise<LoginResponse> {
  return await loadAndLogin(request);
}
```

`ProtocolRegistry`、Service mailbox 和 Scene/Actor mailbox 现在都传递 `T | Promise<T>`。同步 Handler 会始终走直接调用栈；只有 Handler 真正返回 Promise 后，运行时才创建 Promise continuation。

有序 mailbox 仍会等待异步 Handler 完成后再调度下一条消息；无序 mailbox 可以让多个异步 Handler 重叠执行。CPU 密集型同步代码仍会阻塞当前 Service 的 V8 实例。

## 热路径优化

- 零延迟基准 RPC 使用同步 Handler 路径。
- Rust 为外部接入连接启用 `TCP_NODELAY`。
- Raw TCP 响应会把已经就绪的帧组成有界批次，一次写入。
- 持久化跨进程服务连接启用 `TCP_NODELAY`，每个请求帧只执行一次写入。
- Rust 使用定长二进制记录向 V8 传递入站事件元数据，不再为每批消息生成 JSON 和动态 JavaScript 源码。
- 正常 RPC 只解码一次 protobuf；只有解码失败时才兜底扫描 `rpcId`。
- Service 入站队列改用 head-index，不再逐帧调用 `Array.shift()`。
- `BinaryWriter` 的初始容量足以容纳 256B 基准响应，避免必然发生的扩容与复制。
- Rust 和 TS 每次 Update 最多处理 512 个入站帧，同时继续保留 4096 事件的有界队列。
- 增加 Rust 原生压测客户端，把服务器容量与 Node 客户端事件循环上限区分开。

## 本机测试结果

以下数据于 2026-07-10 使用 release 构建和 256B protobuf payload 测得。它们是当前 Windows 开发机的回归基线，不代表生产容量承诺。

| 客户端 | 连接数 | 并发数 | 持续时间 | 请求/秒 | p50 | p95 | p99 | 错误数 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Rust，峰值轮次 | 8 | 1024 | 10 秒 | 307,351 | 3.315 ms | 4.809 ms | 5.648 ms | 0 |
| Rust，重复轮次 | 8 | 1024 | 10 秒 | 278,513 | 3.613 ms | 5.072 ms | 5.766 ms | 0 |
| Node | 4 | 128 | 10 秒 | 65,540 | 1.914 ms | 2.322 ms | 3.134 ms | 0 |

当前 Windows 开发机在饱和压测下存在明显的系统调度波动。Phase 1.10 已经突破 30 万目标，多次运行观察到的范围约为 27.9 万至 30.7 万请求/秒。后续性能回归应看这个区间，而不是只看某一次峰值。

Rust 测试覆盖以下完整链路：

```text
TCP 长度前缀 -> Rust 有界入站队列 -> Rust/V8 二进制桥接
-> msgcode 查找 -> protobuf 解码 -> Handler -> protobuf 编码
-> 有界连接写队列 -> TCP 响应
```

Node 结果仍可作为 TypeScript 客户端工具链的回归基线，但不能用作服务器性能上限。

## 测试命令

运行 Rust 容量测试预设：

```powershell
npm run perf:runtime:rust
```

该 npm 命令默认使用 8 个连接和 1024 并发。也可以直接通过 PowerShell 自定义参数：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/runtime_load_test.ps1 `
  -Release -Client rust -Duration 10 -Warmup 2 `
  -Connections 8 -Concurrency 1024 -Payload 256
```

运行 Node 客户端基线：

```powershell
npm run perf:runtime
```

运行可靠性和背压验收：

```powershell
npm run test:phase1.9
```
