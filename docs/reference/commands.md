# 常用命令参考

| 命令 | 用途 |
| --- | --- |
| `npm install` | 安装 TS 构建依赖 |
| `npm run codegen` | 运行全部生成器并更新 `codegen.manifest.json` |
| `npm run clean` | 删除 Rust/TS/Cocos 编译产物和引擎缓存 |
| `npm run clean:copy` | 在 clean 基础上删除依赖和旧报告，得到适合跨机器复制的源码目录 |
| `npm run clean:copy:dry-run` | 预览 clean:copy 将删除的路径和体积 |
| `npm run codegen` | 生成协议、Native 数据、服务端 Scene/Handler 和客户端 Handler 导入入口 |
| `npm run codegen:proto:update-lock` | 评审协议变化后显式更新 opcode 与 schema 两份发布锁 |
| `npm run test:protocol-locks` | 自测协议锁对字段增删、改号、改型、继承和 RPC 关联变化的拦截 |
| `npm run codegen:client-sdk` | 计算协议指纹并向 Cocos/Pixi 分发完整 TypeScript SDK |
| `npm run codegen:client-handlers` | 只生成客户端 Handler 自动导入入口 |
| `npm run typecheck` | 服务端 TS 类型检查 |
| `npm run build` | 生产 TS bundle、协议和 smoke client |
| `npm run build:debug` | 带内联 sourcemap 的调试 bundle |
| `cargo run --bin TiangZ -- configs/local/all.json` | 单进程、单 V8 启动全部 Demo Scene |
| `npm run smoke:client` | Node 客户端跑登录地图链路 |
| `npm run check` | TS、协议、Actor、Cocos 静态检查 |
| `npm run check:project` | 检查配置、Handler、依赖方向和 Generated 完整性；适用于本地与 CI |
| `npm run verify:comments` | 检查 Core、Demo 与 Rust 手写文档注释是否中英文齐全 |
| `npm run verify:quick` | 生成物、注释、协议锁、TS 与 Rust 的快速质量门 |
| `npm run verify` | 在快速质量门上追加 Runtime、拆分进程、mailbox、背压与 Watcher 验收 |
| `cargo test --all-targets` | Rust 全目标测试 |
| `npm run test:runtime` | 单进程与拆分进程 smoke |
| `npm run test:rpc-actor-correctness` | RPC回绕/timeout/停机取消与Actor生命周期专项测试 |
| `npm run test:fault-injection` | Process退出、Inner断线、慢客户端、过载、异常、非法帧、重连和保存失败矩阵 |
| `npm run test:fault-injection:core` | 只执行Handler、非法帧、重连和保存失败等快速确定性夹具 |
| `npm run test:fault-injection:runtime` | 执行真实TCP、Runtime背压和Watcher子进程故障注入 |
| `npm run test:backpressure` | 背压验收 |
| `npm run test:inspector` | TS Inspector 验收 |
| `npm run test:phase1.9` | Phase 1.9 完整验收 |
| `npm run perf:bridge` | Rust/V8 bridge 基准 |
| `npm run perf:protocol` | Codec/Handler 协议基准 |
| `npm run perf:runtime:rust` | Rust 客户端 Runtime 基准 |
| `npm run perf:rpc-baseline` | Windows/Linux 通用的独立 RPC Payload 基线与报告 |
| `npm run perf:kcp-loginmgr -- 127.0.0.1:7000 256 5 20` | KCP LoginMgr RPC 基准：地址、连接数、预热秒数、测试秒数 |
| `npm run perf:full-chain` | 单进程/拆分进程的完整登录、进图、移动与 AOI Push 性能矩阵 |
| `npm run perf:soak -- --minutes 10 --mode split --players 200 --move-rate 5` | 运行 10 分钟完整链路长稳预检并输出内存增长趋势；正式 10 小时使用 `--minutes 600` |
| `npm run test:native-data` | 生成句柄、Arena、移动状态机和 Entity 生命周期回归 |
| `npm run test:client-message` | 引擎无关的客户端 Handler、异步错误与作用域释放测试 |
| `npm run test:client-sdk` | Client SDK RPC、Update 队列、超时、断线、未知消息和背压测试 |
| `npm run test:client-sdk-distribution` | 验证 Cocos/Pixi SDK 副本与公共源码逐文件一致 |
| `npm run build:pixi` | 生成 SDK 并构建 PixiJS/H5 验收客户端 |
| `npm run serve:pixi` | 在 `http://127.0.0.1:7460` 启动 Pixi 静态服务器 |
| `npm run smoke:pixi` | Windows Edge 自动完成 Pixi 登录、进图和 canvas 验收 |
| `npm run perf:map-capacity -- --gates 8 --players 200 --rounds 3` | 单 MapHost 全员可见广播、批量下行 Bridge 和 Probe 延迟容量测试 |
| `npm run observability:up` | 按 `StartMachine.json` 的实际 Process 清单生成 Target，并启动 Prometheus + Grafana |
| `npm run observability:up:single` | 按 `all.json` 单进程配置启动本地监控栈 |
| `npm run observability:update-targets` | 仅重新生成 Watcher 拆分部署的 Prometheus Target |
| `npm run observability:dashboard` | 重新生成 TiangZ Runtime Grafana Dashboard JSON |
| `npm run verify:observability` | 验收 Target、Dashboard、告警接线、Runtime 心跳、Histogram 与 Native Counter |
| `npm run observability:down` | 停止 Prometheus + Grafana 容器 |
| `npm run observability:down:clean` | 停止并清理监控容器数据卷 |
| `npm run observability:reset` | 停止容器并清理后再移除服务端点（用于重新拉起到干净状态） |

修改 proto 后至少运行 `npm run codegen && npm run test:protocol`；修改 Core 后运行 `npm run check`、`cargo test --all-targets` 和相关 Runtime smoke。

`verify:quick` 会执行无需 Docker 的观测资产检查；改动 Prometheus 配置后，还应使用固定镜像运行 `promtool check config`。
