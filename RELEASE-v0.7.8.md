# v0.7.8

TiangZ 套件 0.7.8 正式版：依赖与套件版本对齐。TiangZ 固定的 Developer Tools Core 升到 `v0.16.6`；套件内 Developer Tools、Native Language、Examples 各发一个补丁版，修复 0.7.7 发布审计中各自标签锁文件上新出现的依赖公告。服务端运行时行为、协议、Stable API 导出、TypeScript 类型与客户端 SDK 都和 0.7.7 相同。

宿主 `--version` 取自 `Cargo.toml`，现为 0.7.8。`tools/game_project.mjs`、`dev_runtime.mjs` 等启动器会核对宿主版本与 `package.json`，因此用这些入口的工程升级后需要重建宿主。

## 套件内各仓库标签

| 仓库 | 标签 | 版本 | 相对 0.7.7 套件 |
|---|---|---|---|
| TiangZ | `v0.7.8` | 0.7.8 | Developer Tools Core 固定版本 `v0.16.3` → `v0.16.6`；coverage 工作流改用 Examples `v0.7.3` |
| TiangZ-DBProxy | `v0.7.6` | 0.7.6 | 无改动；宿主仍固定依赖 `v0.7.3` |
| TiangZ-Examples | `v0.7.3` | 0.7.3 | 客户端 SDK 副本同步到 TiangZ 0.7.7；vitest/vite 安全补丁；MMORPG Rust 锁随 TiangZ 0.7.7 重新解析 |
| tiangz-developer-tools | `v0.16.6` | Core 0.16.6 / VSIX 0.16.6 | MCP SDK 2.4.0、zod 4.6.7、`@azure/identity` 4.14.1；Core 与 VSIX 版本号统一 |
| tiangz-native-language | `v0.17.3` | Core 0.17.3 / VSIX 0.16.5 | `@azure/identity` 4.14.1；随包 `vscode-languageclient` 10.1.2 |

## TiangZ 本身

- `@tiangz/developer-tools-core` 由 `v0.16.3` 改为 `v0.16.6`。新标签只升级依赖，并把 `@modelcontextprotocol/server`、`zod` 的下限提高到修复版本；`packages`、`extension/src`、`tools` 源码与 0.16.3 相同，设计规则（29 条）、依赖规则、Hotfix 类规则与 MCP/CLI 合同不变。本仓库锁文件中这两个包在 0.7.7 已是修复版本（2.4.0、4.6.7），这次只更新 Core 本身解析到的提交。
- coverage 工作流检出 TiangZ-Examples `v0.7.3`（原 `v0.7.2`）。

## 其他仓库要点

- **Examples `v0.7.3`**：客户端 SDK 副本（Cocos 2D/3D、Pixi、Unity 与 `client_sdk/`）带上 0.7.7 的 `RpcSocket` 关闭顺序修正；`vitest`/`@vitest/coverage-v8` 5.0.5、`vite` 8.3.5。MMORPG Native crate 的 `Cargo.lock` 原来停在 TiangZ 0.7.2 时的解析，含 `quinn-proto`、`rustls`、`rustls-webpki`、`webpki-root-certs` 共 9 项 RustSec 漏洞（Examples 以往的审计只查 npm），这次随并列的 TiangZ 0.7.7 重新解析，`cargo audit` 为 0。
- **Developer Tools `v0.16.6`、Native Language `v0.17.3`**：高危公告清零。两者各剩 3 项 `minimatch` 中危（经 `vscode-languageclient` 与 `@vscode/vsce`），上游暂无修复版本，npm 唯一可用的“修复”是把 `vscode-languageclient` 降到 6.x 的破坏性降级，本版照实记录、不加例外。Developer Tools 的 VSIX 内容与 0.16.5 相同（118 个文件，只有版本号），商店无需更新；Native Language 的 VSIX 因随包语言客户端补丁版本变化升到 0.16.5。

## 验证

- 本地（Windows，2026-11-02，发布分支）：`npm run verify:quick` 40/40 通过；`npm run audit:dependencies` 通过（npm 0、cargo 0）；`verify:design-rule-sync`（29 条规则）与 `verify:version`（`TIANGZ_LOCK_VERSIONS=1`）通过。
- 其他仓库：Developer Tools 与 Native Language 的 PR 与标签 CI（Windows/Linux 检查与打包）通过，附件 VSIX 即标签运行的打包产物；Native Language Core 包由标签的干净导出 `npm ci` 后 `npm pack` 生成。Examples 没有 CI，本地 `npm run verify`（游戏测试 61 个文件 193/193）与 `npm run test:native`（`cargo test --locked`）通过。
- GitHub CI 结果以发布 PR 与 Release 页面为准，本文不重复记录。
- 本次未执行：外置游戏工程试同步、长稳与性能测量、VSIX 在编辑器中的安装验证。
