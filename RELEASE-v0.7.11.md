# v0.7.11

TiangZ 套件 0.7.11 正式版：模块游戏配置生成器的客户端目标也改用去注释块模板；补上 0.7.10 留下的 Rust 依赖安全补丁。Rust 运行时行为、协议、Stable API 导出、TypeScript 类型与客户端 SDK 都和 0.7.10 相同。

宿主 `--version` 取自 `Cargo.toml`，现为 0.7.11。`tools/game_project.mjs`、`dev_runtime.mjs` 等启动器会核对宿主版本与 `package.json`，因此用这些入口的工程升级后需要重建宿主。

## 套件内各仓库标签

| 仓库 | 标签 | 版本 | 相对 0.7.10 套件 |
|---|---|---|---|
| TiangZ | `v0.7.11` | 0.7.11 | 客户端配置模板、Rust 依赖安全补丁 |
| TiangZ-DBProxy | `v0.7.6` | 0.7.6 | 无改动；宿主仍固定依赖 `v0.7.6` |
| TiangZ-Examples | `v0.7.3` | 0.7.3 | 无改动 |
| tiangz-developer-tools | `v0.16.6` | Core 0.16.6 / VSIX 0.16.6 | 无改动 |
| tiangz-native-language | `v0.17.3` | Core 0.17.3 / VSIX 0.16.5 | 无改动 |

## 模块游戏配置：客户端 `schema.ts` 也用去注释块模板

0.7.10 只给服务端目标换了去注释块的 `typescript-json` 模板，客户端目标仍用 Luban 官方带注释模板。注释块约占客户端 `schema.ts` 的两成多，客户端会比服务端先撞上 Luban 4.10.2 单模板 1,048,576 字符的输出上限。

- `codegen_module_game_config` 对客户端目标同样传 `--customTemplateDir tools/third_party/luban/server-templates`（目录名为兼容下游脚本保留不改），两端生成物都不带注释块。一个约 1,600 个顶层声明的下游模块实测：客户端渲染结果从 948,815 字符降到 725,089 字符，顶层导出、类成员与去掉注释后的打印结果逐一相同；服务端产物逐字节不变。
- `module_game_config_limit_self_test` 夹具增加客户端目标：140 张带注释的表在两端都超过官方模板的上限，生成后两端都无注释块、完整且严格类型检查通过；只让客户端多出 30 张表时整次生成必须失败（报客户端截断），服务端与客户端已发布产物都不变。原自测“客户端保留注释”断言改为“客户端无注释块且仍导出表类型”。
- 代价：客户端编辑器里不再有表、字段与枚举的注释悬停说明，字段含义以表格定义为准。

## Rust 依赖安全补丁

`cargo update -p quinn-proto -p quinn-udp -p url`，`Cargo.lock` 只改 4 个包且都在原次版本内：

| 包 | 旧 | 新 | 公告 |
|---|---|---|---|
| `quinn-proto` | 0.11.18 | 0.11.19 | RUSTSEC-2026-0523、RUSTSEC-2026-0524 |
| `quinn-udp` | 0.5.15 | 0.5.16 | RUSTSEC-2026-0538 |
| `url` | 2.5.8 | 2.5.9 | RUSTSEC-2026-0592 |
| `form_urlencoded` | 1.2.2 | 1.2.3 | 随 `url` 升级 |

## 升级影响

- 已有模块的客户端 `schema.ts` 只少了注释块（导出符号、类型与解码代码不变），但字节与客户端清单里的 `schemaFingerprint` 会变。升级后须重新运行配置生成并提交，重新构建客户端。服务端 `schema.ts`、`fingerprint.ts`、`server.json` 与清单不变，不因此重启 Process。
- 直接调用 Luban 自行生成或比对客户端 `schema.ts` 的下游脚本，须同样给客户端目标加 `--customTemplateDir tools/third_party/luban/server-templates`，否则会把注释差异误报为结构变化。
- 宿主版本号与依赖锁变化，使用启动器版本核对的工程需重建宿主。

## 验证

- 本地（Windows，发布分支）：`npm run audit:dependencies` 通过（npm=0、cargo=0、例外 0）；`verify:codegen` 通过。其余本地检查与 GitHub CI 结果以发布 PR 与 Release 页面为准，本文不重复记录。
- 客户端模板改动在合入前已经独立代码评审。
- 本次未执行：长稳与性能测量。
