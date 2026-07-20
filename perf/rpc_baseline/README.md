# 跨平台 RPC 基线测试

该目录提供不依赖 PowerShell 的 RPC 基线测试入口，可在 Windows 和 Linux 使用同一条命令。

## 环境要求

- Node.js 20 或更高版本。
- Rust stable，支持 Rust 2024 edition。
- Linux C/C++ 编译工具链。Ubuntu/Debian 可安装 `build-essential`、`pkg-config`。
- 首次构建需要访问 Cargo 和 npm 依赖源。

将整个 `TiangZ` 目录复制到 Linux 后执行：

```bash
cd TiangZ
npm ci
npm run perf:rpc-baseline
```

不要使用 `sudo npm`。nvm 把 Node/npm 安装在当前用户目录，sudo 默认找不到该命令；Cargo 缓存和测试报告也应归当前用户所有。压测入口发现 `node_modules` 缺失、来自 Windows 或失去 Linux 执行权限时，会自动执行一次 `npm ci`。

如果单独运行 `npm run build` 时遇到 `tsc: Permission denied`，执行：

```bash
rm -rf node_modules
npm ci
```

复制前执行：

```bash
npm run clean:copy:dry-run
npm run clean:copy
```

第一条命令预览待清理内容，第二条删除 `target`、`node_modules`、`dist`、Cocos 缓存和旧性能报告。不要把 Windows 的 `target/release/*.exe` 当作 Linux 测试程序使用。`tools` 是源码的一部分，必须复制；协议生成器和跨平台压测入口都在这里。

该命令自动完成：

1. 生成并构建 TypeScript Runtime bundle。
2. 使用 Cargo 构建 Release Runtime 和 Rust 压测客户端。
3. 启动 `configs/local/bench.json`。
4. 等待 `127.0.0.1:7400` 可以连接。
5. 依次测试 64B、256B、1KB、4KB、16KB Payload。
6. 停止 Runtime 并生成 Markdown、JSON 和 Runtime 日志。

## 自定义参数

```bash
npm run perf:rpc-baseline -- \
  --duration 60 \
  --warmup 10 \
  --connections 8 \
  --concurrency 512 \
  --payloads 64,256,1024,4096,16384
```

查看全部参数：

```bash
npm run perf:rpc-baseline -- --help
```

已经构建过代码时，可以跳过构建：

```bash
npm run perf:rpc-baseline -- --skip-build
```

## 输出

- `perf/results/rpc_baseline_<时间>.md`
- `perf/results/rpc_baseline_<时间>.json`
- `perf/results/rpc_baseline_<时间>_runtime_stdout.log`
- `perf/results/rpc_baseline_<时间>_runtime_stderr.log`
- `perf/results/rpc_baseline_latest.md`
- `perf/results/rpc_baseline_latest.json`

测试链路：

```text
Rust TCP 压测客户端
  -> Tokio 连接读取
  -> Rust 有界 Process 事件队列
  -> V8 / TypeScript
  -> msgcode + protobuf decode
  -> BenchScene Handler
  -> protobuf encode
  -> Rust 有界写队列
  -> TCP Response
```

为了比较不同机器，建议统一使用 Release、相同并发参数，至少运行三轮，并记录 CPU 型号、逻辑核数和操作系统。报告会自动记录这些环境信息。
