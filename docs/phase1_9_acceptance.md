# Phase 1.9 验收说明

> 历史记录：本文指标来自旧的“一 Service 一 V8”实现。当前已改为“一 Process 一 V8、多 EntryScene”；队列能力保留，术语和隔离粒度以当前 README 为准。

Phase 1.9 在保持“一个 Service 对应一个 V8 实例”的前提下，对运行时消息链路进行可靠性加固。

## 验收命令

在 `TiangZ/` 目录执行：

```bash
npm run test:phase1.9
```

该命令会验证：

- TypeScript 代码生成、类型检查和协议往返测试。
- Rust 有界队列、慢连接、Inner/Outer 访问限制及 RPC 多路复用单元测试。
- 单进程和分进程两种 Login/Gate/Map 冒烟流程。
- 本机强制过载场景以及入站队列容量断言。

## 运行时限制

```text
Service 入站队列          4096 个事件
TS 单批 Update 预算        512 帧
单连接出站队列            4096 帧
单连接出站字节数             4 MiB
Inner 传输队列            每级 1024 个调用
Inner 空闲超时               60 秒
最大消息帧                    1 MiB
```

入站队列满后，Socket 读取任务会等待，不再继续读取下一帧，由 TCP 将压力向发送端传播。RPC 消息不会被静默丢弃。

连接的出站队列超过限制后，只关闭对应的慢连接，避免它无限占用服务器内存。Inner 传输队列饱和时，只向受影响的调用返回系统错误 `ServiceOverloaded`（`1011`），不会阻塞其他目标服务。

## 本机基线

以下数据于 2026-07-10 在 `127.0.0.1` 上测得。它们只用于当前机器的性能回归，不代表生产环境容量承诺。

| 场景 | 构建模式 | 连接数 | 并发数 | Payload | Handler 延迟 | 请求/秒 | p50 | p95 | p99 | 错误数 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 稳态运行时 | release | 4 | 128 | 256 B | 0 ms | 38,252 | 2.532 ms | 7.073 ms | 17.147 ms | 0 |
| 高并发 | debug | 4 | 4096 | 256 B | 0 ms | 34,027 | 29.901 ms | 722.935 ms | 888.736 ms | 0 |
| 强制触发背压 | debug | 4 | 4864 | 256 B | 1 ms | 256 | 9729.979 ms | 9730.890 ms | 9730.971 ms | 0 |

当前强制背压场景会令 `rust_max_queue` 精确达到 `4096`，能够观察到背压等待，且 `slow_disconnects=0`。高延迟符合预期，因为有序 Service 会让每个排队请求依次等待 1ms 异步 Handler。Phase 1.10 的容量数据单独记录在 `docs/phase1_10_acceptance.md`。

## 手动负载测试

运行 release 稳态测试：

```powershell
npm run perf:runtime
```

直接传入自定义参数：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/runtime_load_test.ps1 `
  -Release -Duration 10 -Warmup 2 -Concurrency 128 -Connections 4 -Payload 256 -Delay 0
```

报告包含请求/秒、p50/p95/p99/最大延迟、错误数、最大在途请求数、Rust/TS 队列峰值、背压等待次数和慢连接关闭次数。

## 安全边界

持久化服务连接会在发送第一帧前执行 Inner 握手。本地开发使用内置 Token；分布式、共享或生产环境必须为所有协作进程设置相同且非空的 `ETS_INNER_TOKEN`：

```powershell
$env:ETS_INNER_TOKEN = "replace-with-a-deployment-secret"
```

当前原型保留 `20000..29999` 作为 Inner 消息号范围。增加更多协议族之前，应把该范围改成由协议元数据自动生成。
