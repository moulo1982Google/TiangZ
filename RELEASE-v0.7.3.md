# v0.7.3

TiangZ 套件 0.7.3 正式版（GitHub Release）：开发锁残留时自动清除。只改开发工具（`tools/`）与文档；Runtime、协议、配置字段与 Stable API 不变，Rust 源码未改。之前的标签与附件保持不变。

宿主 `--version` 取自 `Cargo.toml` 版本，现为 0.7.3；`tools/game_project.mjs`、`dev_runtime.mjs` 等启动器会核对宿主版本与 `package.json`，因此使用这些入口的工程升级后需要重新编译一次宿主（`npm run host-build` 或组合宿主构建）。功能上与 0.7.2 宿主相同，无需改游戏模块或 Native crate。

## 套件内各仓库标签

| 仓库 | 标签 | 版本 | 相对 0.7.2 |
|---|---|---|---|
| TiangZ | `v0.7.3` | 0.7.3 | 下列改动 |
| TiangZ-Examples | `v0.7.2` | 0.7.2 | 无改动 |
| TiangZ-DBProxy | `v0.7.1` | 0.7.1 | 无改动（宿主客户端仍用 `v0.7.0` 协议，与 0.7.1 服务端兼容） |
| tiangz-developer-tools | `v0.16.2` | Core 0.16.2 | 无改动 |
| tiangz-native-language | `v0.17.2` | Core 0.17.2 | 无改动 |
| TiangZ-AI-Plugins | `v0.7.1` | 插件 0.3.1 | 无改动 |

## 修正

- **开发锁残留时自动清除。** `.tiangz-dev.lock` 原来发现锁就拒绝，命令被直接终止（例如 Windows 上关闭控制台窗口）后每次都要人工删锁。现在只有确认记录的进程已退出（PID 不存在，或该 PID 现属于锁写入之后才启动的进程）才清除并继续，同时打印一行原锁的 PID、action 与 startedAt；锁内容无法识别、来自其他主机或读不到进程信息时照旧拒绝。清除经 `.tiangz-dev.lock.takeover` 独占文件串行化并逐字节复核，并发命令只有一个接管。锁新增 `hostname`、`token`（Linux 另有 `processIdentity`）字段，旧格式锁仍可识别。只判断记录的 Node 进程，不检查或停止其 Watcher/宿主子进程。设计、平台做法与残余风险见 `docs/design/dev-lock-stale-cleanup.md`。
- `project:create` 生成的 `.gitignore` 增加 `.tiangz-dev.lock.takeover`；已有工程可自行补上。

## 验证

- 本地 Windows：`node --test tools/game_project_lock.test.mjs` 15/15（连续 3 次）；`module_component_scaffold_self_test`、`game_project_self_test`（不含 `--runtime`）、`verify:comments`、`verify:no-local-traces`、`verify:design-rule-sync`、`check:project`、`test:dev-runtime`、`test:matrix-runner` 通过。
- Linux 容器 `node:22-bookworm-slim`（无 `ps`）：锁测试 15/15（连续 3 次）。
- 修复前的实现在同一测试上 3 通过、9 失败（复现方法见设计文档）。
- 发布锁定模式（`TIANGZ_LOCK_VERSIONS=1`）下不含 cargo 的检查：`verify:version`（0.7.3）、`verify:codegen`、`verify:dependency-policy`、`verify:no-local-traces`、`verify:comments`、`verify:design-rule-sync`、`verify:runtime-contracts`、`verify:hotfix-boundary`、`verify:domain-boundaries`、`check:project`、`test:protocol-locks` 通过。
- `verify:core-api` 失败：Stable Core API 签名与 `app/core/public-api.lock.json` 不一致（`EntryScene`、`Session`、`Unit`、`entities`、`root` 的 `.d.ts`）。本次没有改动 `app/`、`src/`、该锁文件或校验脚本，检查输入与 v0.7.2 相同，因此 v0.7.2 上同样存在（可能与 0.7.1 改为 ES `#` 私有字段有关，未逐版本核实）；锁未更新，需另行审查兼容性后执行 `npm run core-api:update-lock`。`verify:locks:warn` 对此报 WARN。
- 未在本次执行：含 cargo 的 `verify:quick`/`verify:release` 步骤、带 `--runtime` 的 `test:game-project`、`test:game-project-dev`、macOS 实测。推送后未等待 CI 结果。
