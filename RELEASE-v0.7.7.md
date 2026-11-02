# v0.7.7

TiangZ 套件 0.7.7 正式版：客户端 SDK 远端关闭顺序修正与依赖安全补丁。服务端运行时行为、协议、Stable API 导出与 TypeScript 类型不变；客户端 SDK 的公开接口不变，只改关闭时等待中 RPC 的处理顺序。

宿主 `--version` 取自 `Cargo.toml`，现为 0.7.7。`tools/game_project.mjs`、`dev_runtime.mjs` 等启动器会核对宿主版本与 `package.json`，因此用这些入口的工程升级后需要重建宿主。客户端工程需重新同步 SDK 副本（TiangZ-Examples 的 `npm run sdk:sync`，或各游戏工程自己的同步方式）。

## 套件内各仓库标签

| 仓库 | 标签 | 版本 | 相对 0.7.6 套件 |
|---|---|---|---|
| TiangZ | `v0.7.7` | 0.7.7 | 客户端 SDK 关闭顺序修正、依赖安全补丁 |
| TiangZ-DBProxy | `v0.7.6` | 0.7.6 | 本版不涉及；宿主仍固定依赖 `v0.7.3` |
| TiangZ-Examples | `v0.7.2` | 0.7.2 | 无改动 |
| tiangz-developer-tools | `v0.16.5` | Core 0.16.5 | 本版不涉及；宿主仍固定依赖 `v0.16.3` |
| tiangz-native-language | `v0.17.2` | Core 0.17.2 | 无改动 |

## 客户端 SDK：远端关闭不再丢掉已收到的回复

传输层总是先投递收到的帧、再通知连接关闭。RPC 回复帧到达后只入队，要等游戏循环调用 `update()` 才分发；如果远端紧接着断开，回复已在队列里，但旧版 SDK 在关闭通知时就拒绝了全部等待中的 RPC。

实际后果之一（苟道三国）：重连请求的回复里服务端已换发新的重连凭证、旧凭证作废，回复帧入队后连接随即断开；客户端只看到“连接关闭”，约 1 秒后用旧凭证重试，服务端返回 45207，玩家回到登录页。不会重复提交、不会伪造成功、不丢存档。

### TypeScript（`client_sdk/typescript/Core/Net/RpcSocket.ts`）

- 远端关闭时扫描入站队列：回复帧已在队列里的 RPC 保留，由 `update()` 按到达顺序交付，与前后的推送保持原有顺序；其余 RPC 照旧立即以关闭错误失败。
- 队列泵空后仍在等待的 RPC 用同一个关闭原因失败，不会悬挂；保留的 RPC 原有超时不变。
- 入站队列溢出关闭与本地 `close()` 不变：立即拒绝全部 RPC（`close()` 同时清空队列）。
- **调用方需要注意**：`call()` 现在可能在 `state` 已是 `closed` 之后成功返回。拿到结果后要按连接已断处理后续流程，例如先保存重连回复中的新凭证，再重连。

### C#（`client_sdk/csharp/Core/RpcSocket.cs`）

旧版在接收线程收到关闭后直接 `Close()`：拒绝全部 RPC、**清空入站队列**（顶号通知等单向消息也会丢），并在网络线程上触发 `Closed` 事件。

- 接收线程只记下关闭原因；`Update()` 分发完关闭前已收到的全部帧后才执行 `Close()`，`Closed` 事件在调用 `Update()` 的线程（Unity 主线程）触发。与 C++ SDK 一致。
- 没有回复的 RPC 改为在下一次 `Update()` 时失败（原来立即失败）；长时间不调用 `Update()` 时由原有超时兜底。
- 连接在没有关闭帧的情况下中断，现在也按远端关闭处理（原来接收循环静默退出，等待中的 RPC 只能等超时）。
- 本地 `Close()`/`Dispose()` 不变。

C++ SDK 原本就把关闭作为排在帧之后的事件处理，本版不改。

## 依赖安全补丁

2026-10-26 起定时 `security` 工作流的 `dependency-audit` 失败。全部在原版本范围内升级，没有新增例外：

- `rustls-webpki` 0.103.15 → 0.103.16（RUSTSEC-2026-0382）、`webpki-root-certs` 1.0.9 → 1.0.11（RUSTSEC-2026-0383）：emSign 中间证书私钥已公开，旧版本在信任根允许时可能接受经过它们的证书链。
- `@modelcontextprotocol/server`/`core` 2.0.0 → 2.4.0（经 Developer Tools Core 引入）、`zod` 4.4.3 → 4.6.7、`vite` 8.2.2 → 8.3.5。
- `vitest` 与 `@vitest/coverage-v8` 5.0.0 → 5.0.5（`@vitest/mocker` 两条中危）；两者互相精确固定，`package.json` 范围改为 `^5.0.5`。只影响开发与测试工具。

## 验证

- 本地（Windows，debug 构建，2026-11-01）：
  - 新增 `tests/unit/client_rpc_socket_close.test.ts` 7 项通过：回复与关闭同批、回复早一帧、推送与回复混合并分批泵送、保留的 RPC 超时兜底、`onStateChange` 中同步 `update()`、入站溢出、本地 `close()`；修复前其中 4 项失败。全部 vitest 58 个文件 268 项通过。
  - C#：`dotnet build client_sdk/csharp/TiangZ.Client.csproj` 0 警告 0 错误（.NET SDK 8.0.427）。仓库没有 C# 测试工程；用仓库外的临时程序以本地 WebSocket 服务端驱动真实 `RpcSocket`，“回复与推送后关闭”和“无回复关闭”两例：新代码 11 项检查全部通过，旧代码 8 项失败（回复丢失、推送丢失、`Closed` 在网络线程触发）。
  - `npm run audit:dependencies` 通过（npm 0 条，cargo 0 条，cargo-audit 0.22.2）。
  - `npm run verify:quick` 37/40 通过。失败的 3 步都是本机环境：soak control 的 Windows 读锁用例需要 `pwsh`（本机未安装）；`cargo clippy` 编译进程以 `0xc0000374` 崩溃，单独重跑 `clippy --all-targets -- -D warnings` 通过；`check` 中 `test:module-host` 在宿主重建前用了旧二进制，重建后单独重跑通过。V8 构建的 `gn_root` 符号链接权限问题按业务手册在私有 target 建 junction 解决。
  - 发布提交上：`verify:version`（含 `TIANGZ_LOCK_VERSIONS=1`）、`verify:codegen`、`verify:comments`、`verify:no-local-traces`、`cargo metadata --locked`；开启 `TIANGZ_LOCK_VERSIONS=1` 的 `verify:core-api`（212 个 Stable 导出与锁一致）与 `codegen:proto`（opcode/schema 锁）通过。完整 `verify:release` 未在本地运行，以 CI 为准。
- GitHub CI 结果以发布 PR 与 Release 页面为准，本文不重复记录。
- 未验证：Unity 真机与编辑器中的 C# 行为；苟道三国重连用例 T-R2b 在同步新 SDK 后的翻转（由游戏仓库跟进）；Linux 本地构建。
- 本次未执行：外置游戏工程试同步、长稳与性能测量。
