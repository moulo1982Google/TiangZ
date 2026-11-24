# v0.7.10

TiangZ 套件 0.7.10 正式版：修正模块游戏配置生成器在服务端 `schema.ts` 超过 Luban 单模板输出上限时被静默截断的问题。Rust 运行时、协议、Stable API 导出、TypeScript 类型、客户端 SDK 与依赖都和 0.7.9 相同；只改配置生成工具、新增一份服务端 Luban 模板与自测、同步文档。

宿主 `--version` 取自 `Cargo.toml`，现为 0.7.10。`tools/game_project.mjs`、`dev_runtime.mjs` 等启动器会核对宿主版本与 `package.json`，因此用这些入口的工程升级后需要重建宿主。

## 套件内各仓库标签

| 仓库 | 标签 | 版本 | 相对 0.7.9 套件 |
|---|---|---|---|
| TiangZ | `v0.7.10` | 0.7.10 | 模块游戏配置生成修正 |
| TiangZ-DBProxy | `v0.7.6` | 0.7.6 | 无改动；宿主仍固定依赖 `v0.7.6` |
| TiangZ-Examples | `v0.7.3` | 0.7.3 | 无改动 |
| tiangz-developer-tools | `v0.16.6` | Core 0.16.6 / VSIX 0.16.6 | 无改动 |
| tiangz-native-language | `v0.17.3` | Core 0.17.3 / VSIX 0.16.5 | 无改动 |

## 模块游戏配置：服务端 `schema.ts` 不再被静默截断

Luban 4.10.2 自带的 Scriban 7 把单个模板的渲染结果限制在 `TemplateContext.LimitToString`（默认 1,048,576 字符，Luban 没有覆盖）。`typescript-json` 目标把全部枚举、结构和表写进一个 `schema.ts`，超过上限时被截成前 1,048,576 字符再接 `...`，Luban 与 `codegen_module_game_config` 仍以 0 退出，只有之后的 `tsc` 报 `TS1005`。

- 服务端目标改用 `tools/third_party/luban/server-templates/typescript-json/schema.sbn`：由 4.10.2 官方模板删除 7 处 `comment` 注释块得到，其余逐字相同。同样的表集合约少两成字符。客户端目标仍用官方模板，客户端生成物不变、保留注释。
- 生成器在发布产物前检查服务端与客户端的每个 `schema.ts`：以 `...` 结尾或 TypeScript 语法诊断不为零即失败，不覆盖已有产物；长度达到上限 90% 时在标准错误输出告警并给出剩余字符数，此时应规划拆分导出到该目标的表。
- 新增 `tools/module_game_config_limit_self_test.mjs`（接入 `test:game-modules`）：140 张带注释的表（官方模板会截断）生成完整、严格类型检查通过、`--check` 一致；扩到 170 张表时必须失败且原产物不变。原自测补“服务端无注释、客户端保留注释”断言。

## 升级影响

- 已有模块的服务端 `schema.ts` 只少了注释块，导出符号、类型与解码代码不变，但字节与 `schemaFingerprint` 会变。升级后须重新运行配置生成并提交生成物；这属于 Model 变化，部署需重启 Process。
- 直接调用 Luban 自行生成或比对服务端 `schema.ts` 的下游脚本，须同样给服务端目标加 `--customTemplateDir tools/third_party/luban/server-templates`，否则会把注释差异误报为不一致。
- 宿主版本号变化，使用启动器版本核对的工程需重建宿主。

## 验证

- 本地（Windows，发布分支）：`TIANGZ_LOCK_VERSIONS=1` 下 verify:version、verify:codegen 通过；修正提交在 0.7.8 基线上已跑过 `verify:quick` 的非 cargo 部分（`module Model export preflight` 首跑一项截止时间用例超时，单项与整步重跑均通过），本版重新执行 `test:game-modules`。
- 本版不改 Rust 代码，本地未重跑 `cargo clippy` / `cargo test`；以 GitHub CI 的完整 verify 为准。
- GitHub CI 结果以发布 PR 与 Release 页面为准，本文不重复记录。
- 本次未执行：长稳与性能测量。
