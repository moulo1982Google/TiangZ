# v0.7.0

TiangZ 六仓库套件 0.7.0 正式版（GitHub Release）。候选标签 `v0.7.0-rc1`（bf25dddf）与其附件保持不变；rc1 的验证结论不自动适用于本次制品。以后的缺陷按 0.7.x 小版本修补。

## 套件内各仓库标签

| 仓库 | 标签 | 版本 |
|---|---|---|
| TiangZ | `v0.7.0` | 0.7.0 |
| TiangZ-DBProxy | `v0.7.0` | 服务与 Rust/TS SDK 0.7.0 |
| tiangz-developer-tools | `v0.16.1` | Core 0.16.1、VSIX 0.16.3 |
| tiangz-native-language | `v0.17.1` | Core 0.17.1、VSIX 0.16.3 |
| TiangZ-AI-Plugins | `v0.7.0` | 插件 0.3.0 |
| TiangZ-Examples | `v0.7.0` | 样例集 0.7.0 |

两个工具仓库已有自己 2026-07 的旧 `v0.7.0` 标签（当时的包版本），不移动，因此用各自版本号作标签。

## 本仓库改动（相对 v0.7.0-rc1）

- **Scene HTTP 入口**：Scene 配置可选 `http` 开独立端口，`httpHandler(SceneCtor, method, path)` 精确路由，Handler 可热更。含请求体上限、读体/回复期限、令牌鉴权、跨域来源、`maxInFlight` 与 `maxConnections` 准入、写阻塞期限、停机回收；503 只表示未执行，入队后结果未知返回 504。
- **outerIp 允许域名**：`outerIp` 只发给客户端、进程不监听，现在可填 IP 或不带协议/端口/路径的 DNS 主机名（正式网页由 Nginx 用域名证书终止 https/wss）。
- **异步结果唤醒**：DBProxy、模块 Native worker、event_stream 的异步结果到达后立即叫醒主循环，空闲进程不再多等一个 idle tick。宿主内部修改，需重建宿主并重启。
- 依赖改为上表固定标签。

协议、已有配置字段与 Stable API 不变；新增字段均为可选。详见 [CHANGELOG.md](CHANGELOG.md)。

## 验证

- 本地 Windows：合入异步唤醒后完整矩阵首轮 full 8/9，`test:module-native-runtime` 因测试生成工程缺少 `host_wake` 模块编译失败（测试工具问题，产品代码未改）；修正后 full 9/9。版本定为 0.7.0 后首轮 full 7/9：5 个测试与 1 个夹具模块写死引擎范围 `[0.6.0-alpha.0, 0.7.0)`，预发行 0.7.0-rc* 按 semver 小于 0.7.0 所以以前能过，正式 0.7.0 被正确拒绝；夹具改为 `[0.7.0, 0.8.0)` 后 full 9/9、quick 35/35、check 8/8。期间机器意外断电，受损的生成文件与缓存已恢复/清理后重跑。
- 外部模块注意：引擎范围上限写 `0.7.0` 的模块在 0.7.0 上会被拒绝，需要改为 `[0.7.0, 0.8.0)` 等。
- PR 合入前 Windows/Linux `framework` CI 全部通过；发布附件来自合入提交的 CI 打包产物。
- 未在本次执行：真实 PG/Redis 长稳、性能对比、客户端编辑器内验收。
