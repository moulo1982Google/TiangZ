# v0.7.1

TiangZ 套件 0.7.1 正式版（GitHub Release），修补 0.7.0 发布时记录的问题。协议、配置字段与 Stable API 不变；需重建宿主并重启。之前的标签与附件保持不变。

## 套件内各仓库标签

| 仓库 | 标签 | 版本 | 相对 0.7.0 |
|---|---|---|---|
| TiangZ | `v0.7.1` | 0.7.1 | 下列修正 |
| tiangz-developer-tools | `v0.16.2` | Core 0.16.2、VSIX 0.16.4 | 开发与打包依赖审计清零 |
| tiangz-native-language | `v0.17.2` | Core 0.17.2、VSIX 0.16.4 | 开发与打包依赖审计清零 |
| TiangZ-AI-Plugins | `v0.7.1` | 插件 0.3.1 | MCP 用 Core 0.16.2 重新分发 |
| TiangZ-DBProxy | `v0.7.0` | 0.7.0 | 无改动 |
| TiangZ-Examples | `v0.7.0` | 0.7.0 | 无改动，模块引擎范围 `[0.7.0, 0.8.0)` 覆盖 0.7.1 |

## 修正

- **大批回包不再断开健康连接。** 0.7.0 的宿主在一轮 Update 为同一连接产生的帧超过单连接写队列（4096 帧 / 4 MiB）时，会立即把该连接当作慢连接关闭。0.7.0 发布 CI 在热更故障矩阵中复现：65,536 个挂起 Inner RPC 同时完成，host 日志 `closing slow connection ... frame queue is full`，读取正常的对端被断开。现在剩余帧按原顺序暂存并计入进程出站预算，每轮先补交；只有暂存在 `network.writeTimeoutMs`（默认 10 秒）内没有任何进展、单连接暂存超过 16 MiB 或进程出站预算耗尽时才关闭。TS 请求关闭时若仍有暂存，等交付完再关闭。新增指标 `tiangz_process_outbound_spills_total`、`tiangz_process_outbound_spilled_bytes`。
- **业务子类可以使用与引擎内部同名的字段。** `EntryScene`、`Component`/`Entity`/`OwnedEntity`、`Unit`、`SessionComponent`、`EntityRoot` 的内部状态改为 ES `#` 私有字段。0.7.0 中业务 Scene 声明 `connections`、`metrics`、`lifecycleState` 等字段会编译失败，绕过类型检查还会覆盖引擎状态。
- **恢复异步结果唤醒。** 0.7.0 撤回的改动重新合入：DBProxy、模块 Native worker、event_stream 的结果到达后立即叫醒主循环，空闲进程不再多等一个 idle tick。撤回原因正是上面的断连问题。
- 依赖：Developer/Native 打包工具链 `npm audit` 由 10 high + 2 moderate 降为 0（`npm audit fix`、`@vscode/vsce` ^4.0.0）。

## 验证

- 根因定位：热更故障矩阵失败时把宿主日志写入 `temp/test-logs`，CI 失败制品给出了上面的断连日志。
- 修复后（同一套改动）：两个只跑 CI 的分支上，Windows/Linux 完整 `verify` 共 4 次全部通过；Windows/Linux 各连续 5 次热更故障矩阵（每次 3 轮）全部通过。修复前同类 CI 中该场景多数失败。
- 本地 Windows：full 9/9、quick 35/35、check 8/8；Rust 269 项；新增单元测试覆盖暂存的顺序交付、延后关闭、无进展关闭与单连接上限，以及子类同名字段（在 0.7.0 上失败：“scene cannot start from business lifecycle”）。
- v0.7.0 标签的干净消费者安装（全新克隆、禁用本地映射、`npm ci`、`cargo --locked`、Git 依赖解析到清单提交）通过。
- PR 合入前 Windows/Linux `framework` CI 全部通过；发布附件来自合入提交的 CI 打包产物。
- 未在本次执行：真实 PG/Redis 长稳、性能对比、编辑器内验收（见附件 POST-RELEASE-TEST-PLAN.md）。
