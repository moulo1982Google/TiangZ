# v0.7.9

TiangZ 套件 0.7.9 正式版：TiangZ 对套件内其他仓库的依赖对齐到各自最新标签。DBProxy 客户端与 SDK 从 `v0.7.3` 改为 `v0.7.6`，Native Language Core 从 `v0.17.2` 改为 `v0.17.3`。服务端运行时行为、协议、Stable API 导出、TypeScript 类型与客户端 SDK 都和 0.7.8 相同。

宿主 `--version` 取自 `Cargo.toml`，现为 0.7.9。`tools/game_project.mjs`、`dev_runtime.mjs` 等启动器会核对宿主版本与 `package.json`，因此用这些入口的工程升级后需要重建宿主。

## 套件内各仓库标签

| 仓库 | 标签 | 版本 | 相对 0.7.8 套件 |
|---|---|---|---|
| TiangZ | `v0.7.9` | 0.7.9 | 下列依赖对齐 |
| TiangZ-DBProxy | `v0.7.6` | 0.7.6 | 无改动；宿主固定依赖由 `v0.7.3` 改为 `v0.7.6` |
| TiangZ-Examples | `v0.7.3` | 0.7.3 | 无改动 |
| tiangz-developer-tools | `v0.16.6` | Core 0.16.6 / VSIX 0.16.6 | 无改动 |
| tiangz-native-language | `v0.17.3` | Core 0.17.3 / VSIX 0.16.5 | 无改动；宿主固定依赖由 `v0.17.2` 改为 `v0.17.3` |

## 依赖

| 依赖 | 原来 | 现在 | 说明 |
|---|---|---|---|
| DBProxy Rust 客户端（`tiangz-dbproxy-client/core/protocol`） | `v0.7.3` | `v0.7.6` | DBProxy 0.7.4–0.7.6 只改服务端（崩溃诊断、缓存修复死锁、回执排序、退休标记 7 天后删除、ctutils 安全补丁），三个客户端包与 0.7.3 只差版本号 |
| `@tiangz/dbproxy-sdk` | `v0.7.3` | `v0.7.6` | SDK 代码与 0.7.3 相同 |
| `@tiangz/native-language-core` | `v0.17.2` | `v0.17.3` | 依赖安全补丁 |
| `@tiangz/developer-tools-core` | `v0.16.6` | 不变 | 已是最新 |

- `Cargo.lock` 只改三个 DBProxy 包的版本与来源（`cargo update -p` 会顺带重新解析 `windows-sys`、`getrandom`，未采用，手工只改这三项）；`package-lock.json` 只改两个包的版本与提交。
- DBProxy 服务端可以继续用 0.7.x 任意版本：0.7.6 服务端接受 0.7.0 起的客户端，宿主客户端的协议指纹与 0.7.3 相同。

## 验证

- 依赖对齐 PR #13：GitHub CI 全部通过（Windows/Linux framework 完整 verify、acceptance、dependency-audit、coverage 与 rust 覆盖率、codecov）。
- 本地（Windows，发布分支）：`TIANGZ_LOCK_VERSIONS=1` 下 verify:version、codegen、dependency-policy、no-local-traces、comments、design-rules、core-api 通过；typecheck 与 vitest 通过；`cargo clippy --all-targets -D warnings` 通过。
- GitHub CI 结果以发布 PR 与 Release 页面为准，本文不重复记录。
- 本次未执行：外置游戏工程试同步、长稳与性能测量。
