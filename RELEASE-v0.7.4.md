# v0.7.4

TiangZ 套件 0.7.4 正式版：开发检查前移与 AI 开发规则。Runtime 行为、协议、配置字段与 Stable API 导出不变；Rust 源码未改，依赖 quinn-proto 升到 0.11.18（安全补丁）。设计与完整交付证据见 [开发防护设计](docs/design/development-guardrails/README.md) 与 [交付记录](docs/design/development-guardrails/delivery-report.md)。

宿主 `--version` 取自 `Cargo.toml` 版本，现为 0.7.4；`tools/game_project.mjs`、`dev_runtime.mjs` 等启动器会核对宿主版本与 `package.json`，因此使用这些入口的工程升级后需重建宿主。

## 套件内各仓库标签

| 仓库 | 标签 | 版本 | 相对 0.7.3 |
|---|---|---|---|
| TiangZ | `v0.7.4` | 0.7.4 | 下列改动 |
| TiangZ-Examples | `v0.7.2` | 0.7.2 | 无改动 |
| TiangZ-DBProxy | `v0.7.1` | 0.7.1 | 无改动（宿主客户端仍用 `v0.7.0` 协议，与 0.7.1 服务端兼容） |
| tiangz-developer-tools | `v0.16.3` | Core 0.16.3 | 设计 Core、CLI 与 MCP 同步开发检查规则 |
| tiangz-native-language | `v0.17.2` | Core 0.17.2 | 无改动 |
| TiangZ-AI-Plugins | 未打标签 | 插件 0.3.3 候选、MCP 0.16.3 | 开发防护规则已合入 main；未正式安装，也未发布到插件市场 |

## 新增

- **真实 Model 导出预检。** 游戏工程检查（`checkGameProject`，即工程的 `npm run check`）在类型检查之后，用真实 Core 的 `defineGameModule` 加载并校验模块 Model；冻结的 `Set`、类实例等非法导出在启动前失败，诊断为 `tiangz.model.invalid-export`。检查环境缺失时报 `tiangz.model.check-unavailable`，不当作通过。合法与非法的判定与 0.7.3 相同，`GameModuleSystem` 只增加模块与导出路径等诊断上下文。
- **合并后协议撞号检查。** 两个分支各自新增消息、Git 无冲突地合并出重复消息号时，协议生成检查会失败并给出冲突双方。
- **检查阶段结果与身份。** 工程检查逐阶段记录命令、起止时间、退出码、实际用例数与诊断，状态区分 passed、failed、unavailable、timed-out、aborted、skipped；unavailable 与 skipped 不算通过。
- **AI 开发规则。** 技能与 Cindy 补充 Model 导出、合并后协议检查、持久化无变化操作的身份、领域接线、目标端实际执行等规则。

## 依赖

- quinn-proto 0.11.17 → 0.11.18（安全补丁）。
- `@tiangz/developer-tools-core` 锁定 `v0.16.3`（提交 `16c05c9`）。
- Stable API 声明锁的内部声明图随诊断改动更新；Stable 导出不变。

## 验证

- GitHub CI：合并前的分支头 `4b532762` 的 8 项检查全部成功（Windows/Linux framework、依赖审计、starter acceptance）；`tiangz-developer-tools` 提交 `16c05c9` 的 6 项检查与打包全部成功。
- 发布提交在本地以发布锁定模式（`TIANGZ_LOCK_VERSIONS=1`）执行的检查及结果，见本发布提交说明。
- 外置游戏工程（苟道三国）以本版内容试同步副本：组合宿主构建、`npm run check`（含真实 Model 导出预检）、`build` 通过；全量工具测试 1557 项中 1549 通过，其余 8 项需要实际宿主构建证据（与框架版本无关，在开发防护的远端验收中已实际通过）；多进程 smoke 133 PASS。
- 未在本次执行：macOS 实测、长稳与性能测量。
