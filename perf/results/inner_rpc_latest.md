# 内部 Scene RPC 基线报告

- 时间：2026-07-20T10:19:32.476Z
- CPU：13th Gen Intel(R) Core(TM) i7-13700F，逻辑核 24
- 参数：8 连接，1024 并发，预热 2s，采样 8s，callCount=1，delay=0ms

| 部署 | req/s | p50 ms | p95 ms | p99 ms | max ms | max server concurrency | errors |
|---|---:|---:|---:|---:|---:|---:|---:|
| remote | 42037 | 21.646 | 51.869 | 82.323 | 222.754 | 950 | 0 |

链路：Rust TCP 客户端 -> MailboxParityScene -> SceneCallContext -> BenchScene.BenchInner.RuntimePing -> MailboxParityScene -> TCP Response。
`local` 表示两个 Scene 在同一进程同一 V8；`remote` 表示两个 Scene 拆成两个进程，经内部 TCP transport。
