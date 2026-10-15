# v0.7.5

TiangZ 套件 0.7.5 正式版：依赖的 DBProxy 升到 `v0.7.3`。Runtime 行为、协议、配置字段与 Stable API 导出不变；Rust 源码未改，只换了 DBProxy 客户端依赖。

宿主 `--version` 取自 `Cargo.toml`，现为 0.7.5。`tools/game_project.mjs`、`dev_runtime.mjs` 等启动器会核对宿主版本与 `package.json`，因此用这些入口的工程升级后需要重建宿主。

## 套件内各仓库标签

| 仓库 | 标签 | 版本 | 相对 0.7.4 套件 |
|---|---|---|---|
| TiangZ | `v0.7.5` | 0.7.5 | 下列改动 |
| TiangZ-DBProxy | `v0.7.3` | 0.7.3 | 多记录事务回执退休、错误码 `OPERATION_EXPIRED`、迁移 016、覆盖率统计修正，见 DBProxy 的 `RELEASE-v0.7.3.md` |
| TiangZ-Examples | `v0.7.2` | 0.7.2 | 无改动 |
| tiangz-developer-tools | `v0.16.3` | Core 0.16.3 | 无改动 |
| tiangz-native-language | `v0.17.2` | Core 0.17.2 | 无改动 |

## 依赖

- **DBProxy `v0.7.3`**：Rust 客户端（`tiangz-dbproxy-client/core/protocol`）与 TypeScript SDK `@tiangz/dbproxy-sdk` 都从 `v0.7.0` 改为固定 `v0.7.3`。
  - 新增 `DbProxyErrorCode.OperationExpired`（2007）。含义：多记录事务回执超过服务端保留期（`storage.operationReceiptRetentionDays`，默认 30 天）被回收后，再查询或用原操作号提交，就得到这个码。它表示**结果未知，不能当成没执行过**。
  - 宿主把错误码原值传给 TypeScript，因此升级后业务能直接认出它；旧宿主收到的是 `Internal`，同样算结果未知。
  - 协议、读写语义与其他 SDK 接口不变。
- **兼容**：DBProxy 服务端 0.7.3 仍接受 0.7.0 客户端，服务端和宿主可以分别升级。服务端的升级规则（同库所有实例一起升级、回收执行后不能回滚）见 DBProxy 的 `RELEASE-v0.7.3.md`。

## 发布工具、社区文件与 CI（0.7.4 之后已在 main 上、本版首次随标签发布）

- **套件发布附件生成器** `npm run release:suite-docs`：
  - 按配置文件生成发布清单、依赖审计、发布后测试执行单与 SHA256SUMS；
  - 哈希、提交、CI 运行等信息都从实际来源读取，缺附件或读不到 CI 时报错，不写出半成品；
  - 发布类型默认值不再写死分发渠道；
  - Windows 上用 shell 调用 `npm audit`，消除弃用警告。
- **开源社区文件**：`SECURITY.md`、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、Issue 与 PR 模板。
- **Codecov**：`coverage` 工作流把框架测试加 Examples 外置场景的 `app/core` TypeScript 覆盖率上传 Codecov。Rust 运行时还没有统计。

## 验证

- 本地：
  - `verify:version`（发布锁定模式）、`verify:codegen` 通过；
  - `Cargo.lock` 只变更 DBProxy 三个包与本包版本号；`package-lock.json` 只变更 SDK 来源与本包版本号。
- GitHub CI 结果见发布 PR 与 Release 页面。
- 本次未执行：外置游戏工程试同步、长稳与性能测量（Runtime 未改）。
