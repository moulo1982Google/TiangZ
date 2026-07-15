# 调试、测试与部署

## 调试一个 Process

```powershell
npm run build:debug
cargo run --bin ets_runtime -- configs/local/login1.debug.json
```

`debug` 位于 `process` 下。一个 OS Process 只有一个 V8 和一个 Inspector，进程中的全部 EntryScene 都可在同一调试会话中断点。`breakOnStart` 会在业务 bundle 执行前等待调试器。

VS Code 连接 `127.0.0.1:9231` 后，可直接在 `app/**/*.ts` 设置断点。详细配置见 `docs/typescript_debugging.md`。

## 测试矩阵

```powershell
npm run check
cargo test --all-targets
npm run test:runtime
npm run test:mailbox-parity
npm run test:backpressure
```

## 从单进程拆到多进程

拆分时为每个进程创建独立 JSON，只把属于该进程的 Scene 放入 `scenes`；所有调用方的 `knownScenes` 仍保留目标地址。Handler、`this.scenes.call/send`、protobuf 和 rpcId 处理都不修改。

必须保证 Scene name 唯一、地址一致、Inner Token 一致、目标端口可达。

## 可观测性

Rust 定期输出每个 EntryScene 的处理数、失败数、队列和 Handler 耗时；Process 共享队列的背压与慢连接指标；Inner transport 的连接、pending RPC、timeout 和 late response。

排查顺序：目标是否存在于 `knownScenes`，端口是否监听，队列是否过载，Handler 是否过慢，响应 msgcode/rpcId 是否匹配。不要用无限增大 timeout 掩盖错误。
