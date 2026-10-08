# v0.7.0-rc1

本仓库从远端 feat/v0.7（67a3c631）合入主线并使用统一套件标签 v0.7.0-rc1 发布 GitHub prerelease。旧 v0.7.0-rc.1 / rc.2 属于历史本地候选，不移动、不覆盖。本次 rc1 是用户指定的新发布标识，不表示旧候选测试自动适用于新制品。

Host、DBProxy 与 Examples 根版本为 0.7.0-rc1。Developer Core 0.16.1-rc.2、Native Core 0.17.1-rc.2、两个 VSIX 0.16.2、AI 插件 0.3.0-rc.1 保留各自版本；它们通过统一 Git 标签加入本次发布。GitHub 发布不等于 npm 或 VS Code Marketplace 上架。

## 发布后的验证

1. 从远端 v0.7.0-rc1 全新检出六仓库，核验标签 SHA、发布附件 SHA256、Cargo/npm 锁解析；禁用本地 URL 映射和路径依赖。
2. Host 执行 verify:release（Windows/Linux，实际重建宿主）；DBProxy 执行格式、Clippy、工作区 Rust 与 TS SDK 测试。分别记录 ignored 与真实存储测试。
3. 用这次 Host 和 SDK 构建房间、MMORPG、SLG；核验协议/生成锁、实际 RPC、热更屏障、停机排空。客户端编辑器验收单列，不用静态检查代替。
4. Developer/Native 的预发行 VSIX 在隔离用户目录验证安装、Problems/Hover/Task；AI 插件核对随包 MCP 和规则来源。
5. 真实 PG/Redis、故障、性能与长稳只在重新核对过的隔离环境执行，先小范围验证，再按既定门槛推进。已有失败和容量缺口保留，不因 RC 发布改为通过。

环境前置：220 的测试 PostgreSQL/Redis/cache 在最近检查时已停止；不得沿用旧运行快照或自动启动共享服务。新测量记录限额、挂载、镜像、启动时间和新 RunId，保留原始证据。既有 DBProxy R7 24h 只适用于其记录的精确产品与工具 SHA，不能直接继承为这次六仓库制品的联合资格。


## v0.7.0-rc1 发布准备的环境记录

本次新构建宿主及 `npm run check` 8/8 已通过；协议锁、Core API 锁、版本锁严格检查通过。安全 CI 首轮发现 `source-map-js@1.2.1` 的 GHSA-68fv-2mgg-jv7q，已通过 npm 将唯一受影响的间接依赖更新为 1.2.2，未增加豁免；更新后的 npm audit 为 0 项漏洞，远端检查以最终提交为准。

隔离目录首轮 check 为 7/8，模块宿主项因尚未构建 target/debug/TiangZ.exe 拒绝；不能复用旧二进制宣称通过。随后 Windows 首次构建因 Cargo 注册表位于 C 盘、target 位于 D 盘，V8 构建脚本创建跨卷目录链接时返回 Win32 1314（缺少符号链接权限）。保留两次原日志，使用与 Cargo 注册表同卷的本次专用 CARGO_TARGET_DIR 重建，不修改系统权限或依赖源码。新宿主复制回本次隔离目录后复验模块宿主；最终结果与 SHA256 记录在发布验证附件中，旧失败不改写。独立构建与复验尚未完成时不得标记通过。


## RC1 发布门禁的夹具修正（2026-10-08）

远端旧功能分支的完整 Windows/Linux CI 暴露两个夹具问题。V8 deadline 回归以 65,540 个串行 Promise 轮询挤入 5 秒，与回收语义无关的调度吞吐影响结果；保留全部创建/取消次数、容量、回收断言及原 5 秒期限，改成最多 256 项一批并逐批等待，本地 exact 回归 0.77 秒通过。控制入口满额后只观察共享 reserved/rejections，不能证明 TCP 尾批已进入 TS；现要求最后一个输入 RPC 的真实拒绝响应已返回，且目标 Scene 入队数为 65,536，才开始热更。默认额度和 3 秒热更期限不变。完整三轮 hotfix fault matrix 已通过，满额场景 pause=316.5384ms。修正只在测试/夹具，不改变生产调度或配额；旧失败日志保留，最终跨平台 CI 需重新核对。

## RC1 标签之后的 0.7 集成

Scene 独立 HTTP 端口及 `httpHandler` 工具接口正在发布分支集成，包含请求体限制、鉴权、超时、并发准入和停机清理。该增量不属于已发布的 `v0.7.0-rc1` 标签；保留原标签，随下一次 0.7 发布。Developer Tools 配套提交为 `198afe8f040d1fc1e17d1a3250791cb62e25109b`，用于统一 HTTP Handler 的 Hotfix 检查。2026-10-07 Windows 默认 Cargo 功能集的最终完整 `npm run verify` 为 9/9，quick 为 35/35；包含 234 项 TS 测试、284 项 Rust 全目标测试、真实 HTTP 请求、三轮热更故障演练和两项 Native 运行验收。codegen、Core API 锁、格式和 Clippy 均通过。实际宿主 SHA-256：`41f5fc34115c9b95281295c6f10711951d9d3ebfdc35c5859c815b82249e255a`。复测日志：`target/http-rc1-verify-retest-20261007.log`，报告：`target/http-rc1-final-{full,quick}.json`。首轮为 full 8/9、quick 33/35，原因是端点测试夹具遗漏 `SceneConfig.http`；修正为 `None` 后按原参数完整复测，首轮日志与报告另存保留。未执行 Linux、KCP 专项或长期压力测试，本记录不替代后续跨平台发布门禁。
