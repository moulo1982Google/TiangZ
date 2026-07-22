# 常用命令参考

| 命令 | 用途 |
| --- | --- |
| `npm install` | 安装 TS 构建依赖 |
| `npm run clean` | 删除 Rust/TS/Cocos 编译产物和引擎缓存 |
| `npm run clean:copy` | 在 clean 基础上删除依赖和旧报告，得到适合跨机器复制的源码目录 |
| `npm run clean:copy:dry-run` | 预览 clean:copy 将删除的路径和体积 |
| `npm run codegen` | 生成协议和 EntryScene 导入入口 |
| `npm run typecheck` | 服务端 TS 类型检查 |
| `npm run build` | 生产 TS bundle、协议和 smoke client |
| `npm run build:debug` | 带内联 sourcemap 的调试 bundle |
| `cargo run --bin TiangZ -- configs/local/all.json` | 单进程、单 V8 启动全部 Demo Scene |
| `npm run smoke:client` | Node 客户端跑登录地图链路 |
| `npm run check` | TS、协议、Actor、Cocos 静态检查 |
| `cargo test --all-targets` | Rust 全目标测试 |
| `npm run test:runtime` | 单进程与拆分进程 smoke |
| `npm run test:backpressure` | 背压验收 |
| `npm run test:inspector` | TS Inspector 验收 |
| `npm run test:phase1.9` | Phase 1.9 完整验收 |
| `npm run perf:bridge` | Rust/V8 bridge 基准 |
| `npm run perf:protocol` | Codec/Handler 协议基准 |
| `npm run perf:runtime:rust` | Rust 客户端 Runtime 基准 |
| `npm run perf:rpc-baseline` | Windows/Linux 通用的独立 RPC Payload 基线与报告 |
| `npm run perf:kcp-loginmgr -- 127.0.0.1:7000 256 5 20` | KCP LoginMgr RPC 基准：地址、连接数、预热秒数、测试秒数 |
| `npm run perf:full-chain` | 单进程/拆分进程的完整登录、进图、移动与 AOI Push 性能矩阵 |
| `npm run perf:map-capacity -- --native-data-backend rust` | 使用 Rust Unit 数据后端运行地图容量测试 |
| `npm run perf:map-capacity -- --gates 8 --players 200 --rounds 3` | 单 MapHost 全员可见广播、批量下行 Bridge 和 Probe 延迟容量测试 |

修改 proto 后至少运行 `npm run codegen && npm run test:protocol`；修改 Core 后运行 `npm run check`、`cargo test --all-targets` 和相关 Runtime smoke。
