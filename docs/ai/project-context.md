# 2026-09-16 模块拆分后的当前事实

当前状态（2026-09-27 11:25）：两处长稳验收工具问题已先修复，控制器的计时余量与事件字段修复也已完成；DBProxy 本地提交 `4ac29b5`、`e9596d1`，服务端/SDK 与原冻结 Release 未改。新 Linux 工具重编通过（两工具八条、所有 bin Release 构建），Windows Rust 207（48 ignored）/格式/Clippy、TS SDK 29、控制器 22 项通过。新完整 30 分钟于 11:18:37 正式起表，现场 `temp/v0.7-joint-soak-r4/joint-bdDSFk/`，当前首类故障通过、第二类进行中，尚未整轮通过。独立 `temp/v0.7-joint-review-r4/` 观察器在本级退出及对账完成后复查原始记录、全部故障/AOF 和计时日志，再凭报告 SHA 放行 60 分钟；失败保留现场，不跳级。最终仍须单次连续 24 小时通过。当前命令、工具/服务端身份与 58 文件修复追溯附件见[联合长稳](../design/v0.7-joint-soak.md)，未 push。

修复附件命名也保留教训：版本化目录不可用 Python `Path.with_suffix('.zip')`，会截掉最后一段版本名；应在完整 basename 后追加扩展名。首次输出先核对目录和 SHA 再原生移动更名，没有覆盖旧包。逐文件摘要、ZIP 载荷及实际私密值排除检查通过，做法与证据见业务手册及联合长稳文档；附件的 soak-pending 状态不能冒充长稳通过。

下列为历史进展，不能再按旧 PID/入口启动负载。11:07：修正超时分类后的 R3 在 SOAK_READY 前并发预置时遇到 PostgreSQL 两秒连接排队超时并退出，零正式时长、零故障；证据 `temp/v0.7-joint-soak-r3/joint-fXDpZh/` 与 `temp/v0.7-joint-review-r3/failure-seed-review.json`。DBProxy 已将初始化单独整理到 `src/bin/fault_soak/seed.rs`，同一 90 秒总期限内对暂时错误重试原 ID/完整请求，永久错误及缺失立即失败，正式负载门槛不变；Rust 207（48 ignored）和格式/Clippy通过，随后构建新 Linux 工具进入 R4。新资源清单为 `temp/v0.7-soak-resources-r4/resources.json`，旧资源已核对身份后停止且保留全部数据，没有通过清空旧 Redis 索引继续。控制器修复已通过 22 项检查，后文的“待修订”只描述当时状态。

2026-09-27 10:54 联合 30 分钟失败，尚无联合阶段通过：AOF 取证暂停两个 DBProxy 后，Rust 验收客户端漏匹配 SDK 新增的 RequestNotSentTimeout，将“确定未发送超时”误判为永久契约错误。已先修 DBProxy 两个长稳验收程序，不改服务端/SDK/预算/数据门槛；两条旧实现反例失败，修后五条工具测试、Rust 204（48 ignored）/Clippy/格式、TS 29 通过。失败原始记录和导出保持；两个 DB 进程与 Host 正常退出，存储恢复，没有进入 60 分钟。清理后 40 条积压 SHA 与强杀前相同只作补证，本轮最终验证/对账未完成。修复后的 Rust 验收客户端尚需重新构建和完整重跑，再处理控制器计时/日志的后续状态见[联合长稳](../design/v0.7-joint-soak.md)。不要把后文 10:31/10:35 的历史运行中状态当作当前。

2026-09-27 最新执行顺序：用户要求本轮联合 30 分钟结束后先复查并修产品问题，再修控制器的计时/事件日志；不可直接越过复查进入长阶段。独立检查点 `temp/v0.7-joint-review-30-r2/checkpoint.mjs` 等待完整报告及对账，必要时经身份校验取消刚初始化的下一次 60 分钟，保持本轮冻结文件和原始失败记录。此处没有登记 30 分钟通过或宣布控制器问题已修复。检查点自身不启动新负载；详见[联合长稳](../design/v0.7-joint-soak.md)。

2026-09-27 10:31 更新：正常长稳 30/60/120/240 分钟已全部通过。240 分钟两端实际连续负载均超过 14400 秒，Host 1,419,581 次 RPC/240 次热更，DB 9,583 次事务/9,583 次交易/115,160 次入队，零错误；正常停止、资源趋势、维护排空和 SQL/Stream 唯一事件对账均通过。自动衔接完成，联合 30 分钟正在 temp/v0.7-joint-soak-r2/joint-uOk7T5/ 运行，尚未整轮通过。原控制器总体 failed 是新启动旧 480 分钟的用户计划变更中止，不是已完成 240 分钟失败；查 handoff.json 的独立分类与新状态，不改写旧报告。详见[联合长稳](../design/v0.7-joint-soak.md)，不要重复启动或编辑运行中的冻结控制器。

10:35，联合首个节点强杀/重启及 60 秒无错误恢复窗口通过，仍仅 1/5，不能替代整轮。驱动日志另有亚毫秒负 delay 被 Node 钳制为 1 毫秒的警告，原因是两次时钟采样跨过期限；fault-passed 的 ISO at 被展开的计划 at 覆盖，单调 start/end 等判定字段未受影响。保留冻结运行及原始日志，后续独立修订需钳制非负等待、分离事件时刻与计划秒数，并复测边界/字段类型；不放宽数据或时长断言。细节与证据见联合长稳文档及业务手册。

2026-09-27 联合长稳追加安排：用户授权在当前 240 分钟正常长稳完整结束后，自动加入周期性故障，并从联合 30 分钟重新逐级运行 30/60/120/240/480/960/1440 分钟。原正常阶段证据保留；联合 30 分钟完整覆盖五类故障，只运行一次，之后先进入 60 分钟。不得修改运行中的计划/控制器，也不得把计划切换时中止的旧 480 分钟尝试或多个短跑算成通过时长。错误窗口只容纳有界可重试可用性错误；旧读、缺失、永久错误、事务/账本/Outbox 不一致始终失败。AOF 必须在新写入前直接比对恢复积压，稳定 DB 节点全程不重启以保留资源趋势证明。15 项控制器反例与只读预检已过，当前独立胶囊为 temp/v0.7-joint-soak-r2，真实联合故障验证仍待执行。入口与进度见[联合长稳计划](../design/v0.7-joint-soak.md)。

同轮换接曾被进程创建时间检查正确拦住：PowerShell 将 JSON UTC 日期转成 DateTime 后，二次隐式文本解析丢失时区，造成八小时假偏差。用 ConvertFrom-Json -DateKind String 保留 ISO 字符串再解析，实测创建时间差仅约 31/38 毫秒；两个相关停止脚本都保持原两秒门槛与 PID/命令行/可执行文件身份校验，不按进程名停止或放宽阈值。失败证据为新胶囊 activation-date-parse-failure.json，修复后实际待机监控换接通过，原 240 分钟运行未受影响；复测与禁止绕过要求同步记于业务手册。

本地套件第三次修订仅补充 ELF 运行库说明与证据，70 个文件校验通过，源码/实际程序载荷与第二套完全一致。最终 Linux Host 使用到 GLIBC_2.39、DBProxy 使用到 GLIBC_2.34，不能把架构名 linux-x64 等同任意发行版兼容；原始 readelf 与二进制 SHA 绑定在 temp/v0.7-release/linux-dynamic-requirements.json。跨套件字节比较另发现 Windows BINARY.json 的 DLL 名单顺序不稳定：忽略大小写排序却用 set 去重，大小写变体产生相同排序键；包内程序和导入集合未变。保留差异 kit-comparison-initial-dll-order.diff，比较仍逐字节检查全部实际载荷，仅对这份名单检查完整元素集合；后续构建加入原字符串作为排序次键。不要把元数据顺序差异当程序差异，也不能据此跳过二进制哈希。

三分钟控制器复测 smoke-QT8Qo0 完整通过：17,504 次 Host RPC、120 次直接事务、120 次交易、1400 次入队，原断言零错误；后台排空后 SQL 版本/回执/零和账本、120 个 Outbox 与 Redis Stream 事件集合均一致。它只是控制器预检，正式 30 分钟阶段随后开始，不算长稳完成。发行装配另一次失败是手工抄录 Windows DBProxy SHA256 多写一个字符，原装配目录与 build-kit.log 保留；核对清洁构建日志、实际 Release 输出和冻结副本一致后改读结构化身份文件，不关闭哈希检查。第二套件通过 64 个文件校验、11 个发行包载荷检查及六仓库 bundle 检出/精确远端来源重写验证；未 push。来源摘要应从实际产物计算并结构化传递，避免人工转抄。

2026-09-27 同机 Release 性能比较已完成：六场景各四轮 AB/BA，共 48 个测量单元全过，吞吐变化为 −3.9% 至 +1.2%，无场景触发固定调查门槛；详见[候选性能记录](../design/v0.7-release-candidate.md)。DBProxy 项使用 memory backend，不能称真实存储吞吐或长稳通过。

递增长稳首次三分钟预检被控制器错误的事务吞吐断言拒绝：冻结 dbproxy_fault_soak::run_player 每十周期执行一次事务，控制器误按每周期计算。原报告 120 次事务、120 次交易、1400 次排队写、零错误且客户端最终校验通过；失败保留在 temp/v0.7-soak/smoke-SqT0fh/ 和原控制器。修正计数下限为实际十周期频率并为交易保留独立下限；不修改产品、负载频率或一致性断言，必须整轮重跑并检查积压排空、SQL 和 Stream。失败时提前正常停服，留下的 27 条尚未发布 Outbox 在只读核对中正确被拒绝，不能据客户端零错误登记该轮通过。

最终 Linux 清洁 RC2 完整 **8/33/9、272 Rust** 通过，141 份 npm 文件及 Host/两份热更报告身份一致；Windows/Linux Release 短验证与 DBProxy 最终 Release 配置下 7 项真实恢复契约也通过，详见[候选冻结](../design/v0.7-release-candidate.md)。这些不是 24 小时长稳证据；性能对比和 30→60→120→240→480→960→1440 分钟长稳另行记录。

新增长稳准备的两个失败属于控制器时序：宿主 /ready 成功早于首个五秒资源快照，不能立刻把缺少指标判为版本不兼容；应在负载前限时等待首份完整快照，后续仍严格拒绝缺失指标。首轮性能 smoke 保留 temp/v0.7-performance/runtime-smoke-Hz5lJn/，修正后新旧 Release smoke 均通过。PostgreSQL 官方容器初始化期间的临时实例也会响应 pg_isready，但目标库可能尚未创建；准备必须同时验证正式 TCP 监听与目标数据库 SELECT 成功。首轮失败 temp/v0.7-soak/setup-initialization-readiness-failed.log、ID/所有者验证后的恢复 setup-resume.log，7 个真实恢复用例原断言未变。

最终 Windows RC2 清洁发行矩阵 **8/33/9、268 Rust** 通过，实际 Host/两份热更报告 SHA 一致，见[候选证据](../design/v0.7-release-candidate.md)。三个示例联机通过、MMORPG 193 TS 与 51 Native 通过（另 2 忽略）；SLG 最后发现生成 tsconfig 仍指向作者工作树，必须用标准并列目录的正式构建刷新、检查完整 Git diff，不能只看 build 返回码。差异保留为 `temp/v0.7-rc2-final-examples-generated-drift.patch`，修复冻结在 Examples `31617b7/v0.7.0-rc.2`，重新 npm ci/build/check/smoke 后受控文件无差异。

性能 Release 首次编译再次遇到 Windows V8 跨盘 symlink 权限 1314。核实锁定 V8 源与尚不存在的 `target/release/gn_root` 后创建本工作区目录联接，再用原源码/锁/Release 参数重试；没有修改第三方 build.rs 或启用不受控系统权限。失败保留 `temp/v0.7-performance/baseline-release-build-failed-v8-junction.log`。候选依赖助手调用 npm 时需要当前已安装 npm CLI 身份：从 npm script 启动，或显式传入已验证的 npm_execpath；直接 node 调用被断言拒绝，`npm exec node` 会下载另一个 Node，不能用它代替本机已选定的 Node 24。此次误调用只产生缓存下载，后续安装使用已验证 npm CLI 与原 Node 24，未改全局工具。

Linux 清洁候选的首轮容器把 Node 控制器直接作为 PID 1，53 个 git/esbuild 等退出子进程被其收养后未回收，矩阵正确以 exit 125 `command left descendant processes` 拒绝。已保存 `/proc` 状态和失败矩阵，并通过原矩阵 SIGINT 正常中止本轮，后续项保留 skipped；不改生产代码或跳过后代检查。重现容器应使用 Docker `--init` 并在开始前核对 PID 1，从另一个空卷重新检出/安装/运行；首轮证据 `temp/v0.7-rc2-linux-clean-evidence/`，新轮 `temp/v0.7-rc2-linux-clean-init-evidence/`。此处属于测试启动环境错误，重跑结果结束后再登记。

Examples 候选升版的首次联机预检拒绝 `registration mismatch`：只更新了模块清单，遗漏 Model `defineGameModule` 的旧注册版本，是发行装配漏项。已同时对齐 MMORPG/Bench 的声明与注册、重新构建，真实隔离登录/进图/退出、角色切换和正常停机通过；保留 `temp/v0.7-clean-mmorpg-smoke.log` 与 `temp/v0.7-clean-mmorpg-registration-smoke.log`。不要关闭注册校验或只检查清单。当前六仓库源码 bundle 已冻结，Engine `11832e7/v0.7.0-rc.2`、Examples `9a5508b/v0.7.0-rc.1`；原五仓库证据仍有效，最终 RC2 的清洁 Windows/Linux 与 Examples Native 验证继续中，不能提前登记为完成。

候选跨平台重建：三个 npm tgz 已从冻结 Git bundle 清洁重建并取得完全相同 SHA256；VSIX 运行载荷一致，ZIP 时间不同，Native sourcemap 另有内嵌源文件 CRLF/LF 差异，不能称原始 VSIX 字节一致。Examples 增加 LF 检出约定，在标准同级布局正式刷新生成物与输入哈希，避免冻结作者 worktree 路径；不手改生成清单或协议锁。复测与原始差异在 `temp/v0.7-clean-artifact-reproduction.json` 及业务手册对应条目。

2026-09-27 清洁候选重建发现 System 声明生成缺陷：普通 `import type` 已转换模块入口，但签名中的 `import("#tiangz/module").T` 被原样搬入 Model，MMORPG 的九处生成声明被正确的依赖规则拒绝。修复生成器按 AST 将这些 import-type 重定位至模块 Model public 相对入口，覆盖参数、返回值、泛型和访问器；普通字符串类型不改。禁止手改 `.d.ts`、放宽 Model 边界或复用旧生成物遮盖。失败日志 `temp/v0.7-clean-mmorpg-build.log`、编译 RED `temp/v0.7-inline-system-types-red-imports.log`；三个生成器测试、含 KCP quick 33/33（check 8/8，231029ms）与 MMORPG 193 项 TS 测试已通过，真实模块重新生成后类型与依赖检查通过，Native/运行时验证继续。首次测试因单双引号触发既有访问器文本比较而未到导入断言，已修正夹具并单独保存日志。宿主候选改用 0.7.0-rc.2，保留原 RC1。

最终 VSIX（两端均 0.16.2）在 VS Code 1.139.1 中连续三次通过六组实际编辑器用例。第一次 RC1 测试把重复 typeId 的诊断强制限定在 Collision 文件而超时；同字节重跑通过，两种索引顺序证明诊断属于后发现的声明。修正测试为本工程的任一冲突文件，仍严格检查跨根隔离和两文件修复，不延长超时、不改语言规则。Native Core 0.17.1-rc.2 的 npm tarball 仅 README/package.json 与 RC1 不同，语言/生成器字节一致。证据在 `temp/v0.7-editor-acceptance/result-rc2-{1,2,3}.json`，原失败保留。

AI 0.3.0-rc.1 已做实际客户端验收：Codex 0.158.0-alpha.2 安装技能并调用两种只读 MCP 场景，Claude Code 2.1.275 新控制会话连接 MCP 0.16.1-rc.2 并发现三种只读工具，Cindy 0.1.93 的真实归档安装/重载后沙箱 running、两文件逐字节匹配。Cindy 首次在登录页启动失败是尚无数据所有者，改用其正式本地模式后通过；没有打开被发行客户端禁用的主进程调试器或改其沙箱。Cindy 四工具/六建议来自归档测试，不冒充客户端模型对话，未发起模型推理。候选分发的 MCP 字节以 Git 属性保留原样，防止换行转换破坏哈希；详见 [候选冻结](../design/v0.7-release-candidate.md)。

2026-09-27 候选依赖冻结与 MCP 身份：尚未 push 的 tag 通过带 SHA256/提交校验的 Git bundle 重现，正式 npm/Cargo 锁仍保存上游地址与真实提交。首轮 npm 的 GitHub fetcher 转用 SSH，只有 HTTPS 重写时挂起；补齐同仓库三种 URL 后，又因 tag-only mirror 没有 HEAD 触发 undefined.sha。正确做法是在独立镜像创建指向已验证提交的默认分支，只对子进程设置重写，不改全局 Git、不伪造锁、不靠提前 push 绕过。最终 npm install 与 Cargo update --workspace 已成功，日志为 `temp/v0.7-rc1-dependency-install-head-retry.log`、`temp/v0.7-rc1-cargo-lock.log`，前两份失败日志保留。继续用清洁目录 npm ci/Cargo --locked 确认，不把开发树安装等同清洁重建。

AI MCP 原来依赖全局 Windows .cmd，且实际服务握手仍报旧 0.13.0，不能仅凭插件清单判断已加载版本。Developer 的实际协议 RED 存于 `dist/v0.7-mcp-version-red.log`；改为构建注入包版本，随包提供实际依赖许可证、bundle/锁哈希，AI 只复制校验后的产物。Developer `npm run check` 为 153 通过、3 项宿主条件跳过；指定 `TIANGZ_TEST_MODULE_HOST` 后单独补跑跨 TS5/TS6 和实际模块 Host 的三项检查通过，日志 `dist/v0.7-rc2-host-contract.log`。Core 改用 0.16.1-rc.2 / VSIX 0.16.2，保留原 RC1 tag。Codex 根 `.mcp.json` 用相对 cwd，Claude 通过清单覆盖同名服务为自己的插件根变量；验证器拒绝 Codex 清单指向任意另名 MCP 文件时应修复包结构，不放宽验证器。实际客户端加载仍须另存证据，不以 vm/直接 stdio 冒充客户端验收。

Host 数据/完成驻留预算完成本轮验收：每 Process 512 MiB 数据/回复预留，Disconnect 独立 65536 backing 项；call 执行前整批预留，缩减后沿最后 V8/Native 所有者归还，已接受完成不再重新竞争容量。真实 V8 保留小视图/Native 引用、满额新调用同步过载和已接受完成交付通过。最终 Windows **8/33/9、268 Rust**，Linux io-uring/kcp **8/33/9、272 Rust**；两边实际 Host 与各自两份热更报告哈希一致。139 个实际 npm 候选文件与工具版本已核对，完整日志和失败/修复证据见[驻留预算](../design/v0.7-host-event-budget.md)。本轮仍用原声明配合已核对的三个本地 npm 候选，不把它冒充下一阶段正式 RC 依赖冻结。

2026-09-27 实际编辑器与环境验收：Native 旧 VSIX 在双 worktree 合并 Entity/typeId，已用安装产物复现并修复为按工作区根隔离全部符号查询；同工程冲突仍拒绝，动态增删根顺序重建一个服务器。Native 545bb2f，Core 22/Server 9、21 份正式生成对照/11 份 TS 通过；真正 VS Code 1.139.1 中两插件六组用例通过，包括 Problems 两轮恢复、所属任务 cwd、跨根 Hover/定义与实时 Model 时间规则。原始失败及 `result-model-contract.json`/包哈希保存在 `temp/v0.7-editor-acceptance/`；详见相邻 Native 仓库 `docs/v0.7-workspace-isolation.md`。初始测试启动使用内存存储未加载信任，改独立普通 Extension Host 与限定目录信任，不关闭信任保护；未定义 sleep 的 TS2304 和 Hotfix 直引 Core 的边界错误不能当作时间规则证据，须先构造类型/依赖合法的 Model 反例。重复测试用 WorkspaceEdit 修改已开文档，避免缓存与直接磁盘写不同步。

Docker 4.90 启动因残留 AF_UNIX socket 重命名失败，daemon 未就绪；CLI 优雅停止超时后只停止本轮启动且路径/时间已核实的 Docker 进程。确认 socket 目录仅含零字节端点、最终绝对路径在指定本地应用目录内，保留目录备份后重新创建运行目录，Docker 29.7.2 恢复；原有三个容器按原配置自动启动，未重置数据或卷。证据 `temp/v0.7-docker-socket-recovery.json` 及前后日志。随后 Linux 验证容器断网 npm 安装重试公共 registry 元数据、尚未进入矩阵，已停止该自有容器，保留失败日志并在允许联网的依赖准备环境重试；Rust 仍使用已核实的专用离线缓存。环境失败不能记作产品测试通过，不清空用户服务绕过故障。

Host 错误文本截断还必须释放原 String 容量：首版 truncate 把 30000 字节文本缩短，但 Native 完成仍保留旧 allocation，缩减预算过早。新增容量断言已得到 RED（`temp/v0.7-host-event-budget-error-capacity-red.log`）；改为先创建最多 4096 字节的新字符串并替换旧所有者，再缩减预留，不截断成功业务 payload。完整 Windows 矩阵因该实际所有权修复重新重建/执行，见[字节验收](../design/v0.7-host-event-budget.md)，不能只拿修复前通过的 225 项替代。

本轮完整矩阵的本机痕迹门禁发现上一批确认契约文档残留本机绝对路径；这是文档可迁移性缺陷。修正命令为相邻 worktree 相对路径，保留原检查，不扩大白名单、不隐藏文件。首轮矩阵仍保留失败，单独复测 `npm run verify:no-local-traces`，后续正式候选再跑完整门禁；记录见[Host 预算验收](../design/v0.7-host-event-budget.md)。

Host 驻留预算首轮定向测试 2/5：新增真实 V8 的满额完成交付通过；三个旧打包单测直接伪造未准入事件，被新增“必须带预留”的入口拒绝。它是旧夹具遗漏新契约，不是应放宽的生产限制。正确做法是在夹具的调用/入队前取得原 Process 守卫，保留原字节/顺序/失败原子性断言；不能在生产打包阶段临时预留、绕过检查或用 cfg(test) 关闭保护。首轮日志 `temp/v0.7-host-event-budget-initial.log`，后续主测试/完整矩阵命令及结果见[预算记录](../design/v0.7-host-event-budget.md)。

Host 事件驻留预算正在按 [0.7 契约](../design/v0.7-host-event-budget.md)收口：数据/回复在执行前预留，完成通知沿原守卫交付，混合 batch 的小切片直到最后 Native/V8 引用释放才归还，GC 未回收也计费；Disconnect 使用独立所有权额度。不可在 Host 打包时拒绝已执行回复、在 Promise finally 提前释放、保留原 Bytes 冒充零复制守卫，或用强制 GC 隐藏压力。512 MiB 是数据/回复的保守驻留成本，不是 RSS；Rust 原帧、单批复制峰值与任意业务堆另计。当前修改尚在验证，精确命令/失败与证据写入该设计稿，不能复用旧 Host 的通过结论。

`@queued` 的耐久性说明已核对 DBProxy 实现：生产 postgresRedis 的 `backlog.enqueueAck` 默认 aof 等本地落盘，memory 仅确认 Redis 内存，两档都不是 PG 提交，响应也不带档位；测试 memory backend 另为易失存储。Native 补全/Hover/生成注释、宿主和技能指引同步修正，不能以清库切换生产写法。实际包检查与 LSP 复测、临时夹具漏 instanceId 导致诊断被过滤为超时的教训见[确认契约](../design/v0.7-queued-ack-contract.md)；不得延长超时或关闭诊断掩盖非法夹具。本地 npm tgz 也须显式 `./` 或绝对/file 路径，二段路径曾被误解为 GitHub 简写而 SSH 失败；不改凭据绕过，纠正参数后重新核对实际安装。

当前 DBProxy Rust SDK 联验须区别正式 `v0.6.2` 与 `f25b296` 候选：Windows 独立源码的 242 项 Rust/Clippy 已通过，主锁与普通 Host 未改。Linux 初次 metadata 缺缓存，指定实际 `--filter-platform` 后通过；完整矩阵 **8/33/8**、Rust 268 项，仅新建脚手架因离线缓存缺发布 tag 引用失败。导入本机已有且 peeled commit 与正式锁一致的真实 tag 后，全新脚手架独立复测通过，不改写原 full 8/9。恢复时核对已有 patch/私有锁，不换依赖、不手写锁或伪造 tag。完整/失败/复测及实际二进制身份见[SDK 联验](../design/v0.7-dbproxy-sdk-candidate-integration.md)。

Native 0.17.0 候选联合验收已通过：三个 npm 候选 139 文件与实际 ESM 入口匹配，Windows/Linux 完整矩阵均 **8/33/9**、Rust 分别 264/268 项，正式生成无跟踪变化，实际 Native 模块与 Rust 脚手架 RPC/停机通过。保留 Core 0.17/VSIX 0.16 与上一阶段实际 Native 0.16 的区别，默认发布锁不变。初版安装校验误用 `createRequire.resolve` 解析只有 import 条件的 ESM 包，得到 `ERR_PACKAGE_PATH_NOT_EXPORTED`，不是入口文件缺失；须在消费项目 cwd 用真正 ESM import 验证两入口，不修改生产 exports 绕过。原日志、包/Host 哈希、完整报告和未覆盖边界见[联合验收](../design/v0.7-native-candidate-integration.md)。

V8 构造上下文修复已完成两平台完整验收：Windows 含 KCP **8/33/9**、617253ms、Rust 264 项；Linux 实际 io-uring/kcp **8/33/9**、561158ms、Rust 268 项，Clippy 均通过。修复后 Linux 原默认并发主测试再连续 **10 × 226** 项通过，保留修复前第 4 次 SIGABRT/core 和确定性 RED。实际 Host/报告身份、日志、GC/业务边界见[修复验收](../design/v0.7-v8-runtime-context.md)及[完整 Linux 验收](../design/v0.7-linux-game-validation.md)。临时容器已退出，原三个用户容器保持；AI 约束已同步。两边此轮实际 Native Core 仍为 0.16.0，0.17.0 候选联合验证另行执行，不改写版本身份。

Linux SIGABRT 后续已取得精确原因：原 ELF 默认并发复跑第 4 轮再次退出，core 栈位于 deno_core 0.411.0 的 `spawn_delayed_task`，isolate 构造时没有 Tokio handle，V8 GC 延迟任务触发主动 abort。生产启动/热更预检已有 enter，遗漏位于部分同步/独立线程测试、backing store 探针及双 Native 的临时 Rust 验收入口。修法是各入口使用原有或明确持有的启用 timer 的 Tokio runtime，并让 Host 构造入口缺少上下文时立即返回错误；不禁用 GC、不强制全局串行或静默丢延迟任务。原复现、core 与回归命令见[上下文契约](../design/v0.7-v8-runtime-context.md)；此前无栈的 Windows 异常仍不认定同源。

Linux 第三轮恢复缓存双路径后，原 Inspector 专项 1/1 通过；完整 quick 仍为 **32/33**，此次是 main Rust 测试二进制原生 **SIGABRT**，并非上一轮的 ENOENT。原日志 `temp/v0.7-linux-game-run-final.log` 对应 volume 内 `temp/v0.7-linux-game-verify-final.log`；矩阵已回收报告中的两个残留后代。事后 cgroup pids.events/max、memory.events/oom/oom_kill 均为 0，只能排除这些计数所覆盖的限制，不能据此确认根因或认定与此前 Windows 原生退出同源。保持原并发和断言，先用未捕获输出/调试器取得堆栈；禁止以重跑通过、改成全局串行或忽略 cargo test 代替修复。完整结果与调查见[Linux 游戏验收](../design/v0.7-linux-game-validation.md)。

Linux 第二轮已通过 check 8/8、真实热更/故障，但 quick **32/33** 的 Inspector 集成测试在 spawn 时 ENOENT；测试尚未启动宿主。复用的二进制包含 `env!(CARGO_BIN_EXE_TiangZ)` 旧绝对路径 `/target/debug/TiangZ`，缓存改挂 `/work/target` 后旧路径不存在，实际新路径存在，两个字符串已直接核对。保持缓存原绝对位置，同时将同一缓存真实目录挂到工具发现路径，或完整重建被搬移的缓存；不能改测试去跳过调试器或忽略 spawn 失败。第二轮完整日志在专用 volume，结束后独立导出；复测仍使用完整 `npm run verify`，见[Linux 环境证据](../design/v0.7-linux-game-validation.md)。

Linux 首轮完整矩阵 **check 6/8、quick 25/33、full 2/9**、200840ms，原报告已导出 `temp/v0.7-linux-game-initial/`。两项环境准备错误分别处理：`npm ci --ignore-scripts` 跳过 Git 依赖 Native Language 0.16.0 的 prepare，发行包缺 dist，后续生成/运行失败及 generated/model 缺失均为前置失败级联；`/work/target` 人工软链接不匹配 `target/` 目录忽略规则，被源码痕迹门禁读作目录而 EISDIR。正确复测在新专用 volume 正常执行依赖的正式安装脚本，并把缓存直接挂为 `/work/target` 目录；不能手写 dist、建立空生成目录、跳过源码检查或扩大忽略范围。沿用同一 `0210279` archive/锁/候选包/负载，重跑完整 `TIANGZ_VERIFY_CARGO_FEATURES=io-uring,kcp npm run verify`，见[证据](../design/v0.7-linux-game-validation.md)。

Linux 完整 TS 游戏矩阵已开始：从干净 `0210279` 归档到专用 Linux volume，使用实际 Node 24.20/npm 11.19/Rust 1.97.1/.NET 8.0.31 镜像，候选 Core/SDK 96 个安装文件哈希与 Windows 包一致。正式 `npm run verify` 含 io-uring/kcp、离线、专用容器允许 io-uring，用户容器/数据库未改；详细输入与命令边界见[Linux 游戏验收](../design/v0.7-linux-game-validation.md)。当前仍在执行，不用已有原生 267 项、镜像构建成功或部分 quick 结果替代完整矩阵。

Host 原缓冲区观测按[backing store 契约](../design/v0.7-host-backing-store.md)完成：4 字节闭包视图仍持有整块 65536 字节，真实 Process 的两个一字节视图使 80×1 MiB 跨批存储全部保留，isolate 退出归零。固定指标计整块逻辑字节至最后 Native/V8 所有者释放，未取 TLS 与空 take 不计。最终含 KCP **8/33/9**、543205ms、Rust 263 项，`temp/v0.7-host-backing-verify.log`；Host/两报告 SHA256 `ba921afd32e5f0fa3d3b9f85824756e8fc6c283cf79dceac3a094b241ea58e90`。Linux 实际原生 **267 项**与 Clippy、AI 实际归档通过，三个宿主正常退出；真实控制满额后排空仍观测到 129414 字节，不把请求完成等同于自然 GC 释放。该观测不是泄漏判定、业务堆或新硬额度；Linux 完整 TS 游戏矩阵和字节满额策略继续独立验证。

Host backing store 探针首次仅编译失败：`temp/v0.7-host-backing-probe-initial.log` E0432，`Uint8Array` 位于当前依赖的 `deno_core::convert`，没有从根模块重导出。按现有 Host 的实际 import 修正，不更换依赖或绕过真实 V8；尚未执行寿命/GC 断言，不归因为框架内存问题。复测 `node tools/run_cargo.mjs test --test host_backing_store_ownership --features kcp --locked -- --nocapture`，范围见[backing store 审查](../design/v0.7-host-backing-store.md)。

控制入站共享 65536 项未开始额度已贯穿 Native 队列、V8 批次和 TS 实际开始/丢弃；Disconnect 等待仍属于原清理任务，完成与 Shutdown 不竞争额度。最终含 KCP **8/33/9**、471440ms、Rust 262 项，`temp/v0.7-control-ingress-verify-final.log`；Host/两报告 SHA256 `305b6dc50b08c6bf0347a5a0cf010b84fbef8bb69a2a035550c0685324adae05`。真实 77825 输入中 69631 完成、8194 明确过载，共享峰值 65536 后归零，完成旁路、380.65ms 热更暂停和原连接恢复通过，三宿主正常退出。Linux 实际 V8/io-uring/kcp **266 项**与 Clippy、AI 0.2.0 实际归档通过。原实现/夹具失败与最终结果见[控制入站验收](../design/v0.7-control-ingress.md)，内部桥需重建重启；此数量额度不等于 TS 存活 backing buffer 或业务堆上限。

Linux 原生验收现已从条件编译推进到实际运行：发现并修复 io-uring 握手/写失败后遗留 Socket、收割连接时遗弃 pending accept 两项问题，四项专项 **4/4**。最终 Linux V8/全目标 **260 项**与 Clippy `-D warnings` 通过，`temp/v0.7-linux-native-final.log`；Linux Host SHA256 `2338a1ba0b463851372c65eb5255587dc15d1de3137238aedf9d6cc149e0f8c4`。Windows 含 KCP 完整 **8/33/9**、524857ms、Rust 256 项，`temp/v0.7-linux-native-verify.log`，Host/两报告 SHA256 `4370b245a006fd8f3d642962446f49e5cd08674da4f92082291687c0fad6b500`，三个宿主正常退出。真实反例、编译错误、容器策略与平台验收边界均见[Linux 完整验收](../design/v0.7-linux-native-validation.md)。

保留 accept 的首版产生 E0505，`temp/v0.7-linux-uring-handshake-final.log`：被 Future 借用的 listener 不能一起移入同一 async 关闭块。修法是 shutdown 先停止接入，在原总预算中消费 Future/排空连接，然后外层释放 listener；不能 unsafe 绕过借用或丢掉等待。与握手 Socket 泄漏、接入恢复两个运行时反例分开记录，见[Linux 验收](../design/v0.7-linux-native-validation.md)。

io-uring 首次守卫修复后原测试仍 **1 failed**、6.06 秒：旧 Socket 已关闭，新连接恢复失败，日志 `temp/v0.7-linux-uring-handshake-green.log`。原因是收割任务的 select 分支丢弃 pending accept，内核可把新 Socket 交给无人消费的结果。循环必须保留原 accept；停止时显式 shutdown listener 并在原总预算内消费其结果，不能改用 epoll 或容忍下一条连接丢失。使用已锁定 socket2 0.6.5 的安全 Socket API，Cargo 只更新直接关系；见[Linux 反例与修复](../design/v0.7-linux-native-validation.md)。

实际 io-uring 握手超时反例 **1 failed**、6.05 秒：名额归零、writer 为空后 Socket 仍未 EOF，listener 尚未停止；`temp/v0.7-linux-uring-handshake-red.log`。tokio-uring 0.5.0 的被丢弃读操作会保留 FD，不能用计数归零代替物理关闭。按[Linux 关闭所有权](../design/v0.7-linux-native-validation.md)由握手持有 Socket 关闭守卫，成功后转交 writer，错误/取消 shutdown、正常写入先排空；禁止扩大超时、关 listener 或删除统计冒充修复。复测 `node tools/run_cargo.mjs test --bin TiangZ --features io-uring,kcp --locked io_uring_handshake_timeout_closes_socket_while_listener_remains_alive -- --nocapture`，须在允许 io-uring 的 Linux 环境运行。

Linux 实际验收已开始，见[Linux 原生验证](../design/v0.7-linux-native-validation.md)。首次离线 rustc 检查被项目 toolchain 组件同步触发下载而失败，尚未运行 syscall；显式选用镜像中已安装的同版 `1.97.1-x86_64-unknown-linux-gnu` 后离线版本检查通过。Docker 默认策略的 io_uring_setup 实测 EPERM，同内核在专用容器调整 syscall 策略后创建/关闭成功。日志 `temp/v0.7-linux-native-capability-{default,default-final,uring}.log` 分别保留；禁止将环境失败算作框架失败，或把 ring 创建成功冒充实际 V8/后端验收。宿主 sysctl/用户容器未改。

连接编号分配已统一到 Process 共享 uint32 边界，最后合法号正常使用、耗尽在发布前失败且不复用。真实 TCP/Auto/WebSocket/KCP 相关 **5/5**、分配模块 **3/3**，含 KCP 完整 **8/33/9**、Rust 256 项、Linux 条件编译与 AI 实际归档通过；`temp/v0.7-connection-id-admission-verify.log`，477578ms，Host/两报告 SHA256 `3363972a027fc4d31e052c799caf27b2500420b18045e88ee2821a10daadf68c`。三个宿主正常退出，原失败与验证层次见[连接编号验收](../design/v0.7-connection-id-admission.md)。本项不增加编号容量，也不将 Windows 结果当作 Linux 实际运行。

连接编号边界的真实 TCP RED 已取得，`temp/v0.7-connection-id-admission-red.log` **1 failed**，0.01 秒：从最后合法编号起步，下一条实际业务帧被发布为 `connection_id=4294967296`，超过 Host uint32 事件头。真实原因为三个 backend 直接对 u64 计数 fetch_add，直到下游才检查宽度。按[连接编号契约](../design/v0.7-connection-id-admission.md)在共享分配入口原子拒绝，走既有 endpoint 监督；禁止截断、回绕复用或放宽 Host 检查。复测 `node tools/run_cargo.mjs test --bin TiangZ --features kcp connection_id_exhaustion_fails_before_publishing_an_invalid_host_event -- --nocapture`，此为有限边界注入，不是 2^32 次连接压测。

Native Scene 批次元数据最终验收：Host 专项 **28/28**、最终调度 **8/8**、指标 **1/1**，含 KCP 完整 **check 8/8、quick 33/33、full 9/9**，484101ms，`temp/v0.7-native-scene-batches-verify.log`。Rust 252 项、Linux 条件编译、AI 实际归档通过；Host/报告 SHA256 `f03b30153f2b6fb75f35fd12dfefbd11f476efe2dbae0a17242cae5534cfb91b`。真实网络 65536 条单向与 64 MiB 批次仍完整送达，Native 保留槽峰值 65536 后归零；258 项批次部分完成后仍保留 258，真正结束才归零，三宿主正常退出。见[完整证据](../design/v0.7-native-scene-batches.md)，下方原反例与夹具/Clippy 失败保留；保留槽不等于活跃 RPC、全部传输或 RSS。

Native 批次指标专项首次失败，`temp/v0.7-native-scene-batches-metrics.log` **1 failed**：扩展的旧 game-only 夹具未设置 `sample_timestamp_ms`，格式化器按既有规则不输出尚未采样的 Native Process 指标，得到空行集合。给夹具提供有效采样时间后复测，不能去掉生产采样门槛或接受缺失指标。命令 `node tools/run_cargo.mjs test --bin TiangZ --features kcp health::tests::host_scene_operation_metrics_separate_queued_cost_from_reply_waiters -- --nocapture`；这是夹具错误，不是确认后的指标丢失。

批头校验提取后 Clippy 首次失败 `temp/v0.7-native-scene-batches-clippy.log`：参数从 Bytes 改为 `&[u8]`，旧 `&packet` 成为多余借用，`-D warnings` 阻断。按真实参数类型去掉一层借用，不能添加 allow 或降低检查级别。复测 `node tools/run_cargo.mjs clippy --all-targets --features kcp -- -D warnings`；调度专项 8/8 已另外通过，不混淆两类结果。

Native 批次总量反例已取得：`temp/v0.7-native-scene-batches-red.log` **1 failed**，子进程 0.04 秒、父进程 0.10 秒。真实 V8 第一批 65536 个 sleep 的完成 sink 仍背压时，第二批合法一项继续被接受；每批执行槽与共享字节上限没有约束跨批次槽/期限堆。测试直接覆盖 Native 桥，不是普通 TS 绕过自己的 pending 限制，也不发网络。按[批次元数据契约](../design/v0.7-native-scene-batches.md)整批预留至容器实际释放；禁止只减活跃计数、降低首批规模或丢掉旧完成。复测 `node tools/run_cargo.mjs test --bin TiangZ --features kcp host::scene_operations_tests -- --nocapture`。

期限句柄最终验收：原生 **9/9**、相关 TS **43/43**，含 KCP 完整 **check 8/8、quick 33/33、full 9/9**，468894ms，`temp/v0.7-deadline-handles-verify.log`。Rust 248 项、Linux 条件编译、AI 实际 0.2.0 归档通过；Host/报告 SHA256 `db89ee6f56a1b92f7e8ff82df834b7986344d49579f09a88a6af2676149f1bc6`。真实 V8 保留原 131079 次期限创建/释放后通用编号不再前进，实际大句柄与 Runtime 清理通过；真实 Process 2000 次快速本地调用 150.06ms，超时后的业务仍由原 mailbox 排空，三宿主正常退出。见[证据与边界](../design/v0.7-deadline-handles.md)，下方 RED/编译失败保留，不把有限编号测试冒充生产溢出或长稳。

期限句柄夹具首次编译失败记录在 `temp/v0.7-deadline-handles-compile-failure.log`：`#[op2]` 将原函数入口生成为 `OpDecl`，不能按普通 Rust 函数直接调用（E0061/E0599）；实现 Drop 的表也不能用结构更新语法移动其非 Copy 字段（E0509）。这是测试写法错误；改为经真实 V8 桥创建待销毁资源，并显式初始化测试表。保留原边界/回收断言，不修改 deno_core 宏或去掉 Drop 来绕过；复测 `node tools/run_cargo.mjs test --bin TiangZ --features kcp host::deadlines::tests -- --nocapture`。

期限句柄审查取得新的真实 V8 RED：`temp/v0.7-deadline-handles-red.log` **1 failed**，2.48 秒。存活资源已归零后，下一个通用 Deno 编号为 131080 而非 1；deno_core 0.411.0 的 `ResourceTable` 用 u32 单调编号，关闭不回收编号。这是创建次数消耗，未实际复现 2^32 次溢出或内存泄漏。按[期限句柄契约](../design/v0.7-deadline-handles.md)改为 isolate 专属安全整数表，保留最后引用、独立停机预留与耗尽失败；禁止重置通用表、改依赖私有字段或放宽旧断言。复测 `node tools/run_cargo.mjs test --bin TiangZ --features kcp host::deadlines::tests -- --nocapture`。

远程排队期限最终通过：TS 相关 **43/43**、原生专项 **4/4**，含 KCP **check 8/8、quick 33/33、full 9/9**，462086ms，`temp/v0.7-remote-operation-deadlines-verify.log`；Rust 共 245 项、Linux 条件编译、AI 实际归档通过。Host/报告 SHA256 `be70e7d8b72465ab72370721866ed46701cdaffeacd1dc5ab3f5b048f0b741f1`。真实跨 Process 保持 256 个长 RPC 时，80ms 短调用在 168.99ms 被观察到超时；Rust `host_queue` 的 call/send 各增加一次，过期单向送达 0，释放后全部恢复，三个宿主正常退出。见[完整证据](../design/v0.7-remote-operation-deadlines.md)，原 RED 保留。新的内部桥接必须重建重启；控制通知仍有背压，超时不代表撤回已发帧或取消业务。

原生队列 RED 也已取得：`temp/v0.7-remote-operation-deadlines-native-red.log` 中真实 V8 提交 256 个 1000ms 普通 sleep 后的短 RPC，在 400ms 内仍未完成，子进程明确失败；它未初始化网络管理器，本应立即失败或按短期限过期，而不是等普通 sleep 腾槽。正确修法需在有界调度器中独立处理 sleep/未开始项期限；不能只延長测试超时、降低并发或把此项当作真实对端网络测试。复测 `node tools/run_cargo.mjs test --bin TiangZ --features kcp host::scene_operations_tests -- --nocapture`。

远程期限确定性 RED 为 **8 failed**，255ms，`temp/v0.7-remote-operation-deadlines-red.log`，覆盖排队不扣时、过期项继续提交、sleep 重新等待、墙钟隔离、路由耗时和旧参数转换。按[排队期限契约](../design/v0.7-remote-operation-deadlines.md)保持原二进制容量，使用 Host 共享单调绝对期限及原生未开始项到期调度。禁止出队后重新计时、丢弃其他接受项或将停止等待解释为取消对端。复测 `npx vitest run tests/unit/remote_operation_deadline.test.ts tests/unit/host_operation_admission.test.ts tests/unit/process_shutdown_deadline.test.ts tests/unit/scene_call_deadline.test.ts tests/legacy/rpc_actor_correctness_self_test.test.ts`；Native 和真实跨 Process 路径另验。

停机专用期限最终验收：相关 **35/35**、Rust 专项 6/6，含 KCP **check 8/8、quick 33/33、full 9/9**，461927ms，`temp/v0.7-shutdown-deadline-verify.log`；Rust 总计 241 项、Linux 条件编译和 AI 实际归档通过。真实 Native/V8 在普通期限满 65536 且 256 项正等待时仍可创建/到期/归还独立停机资源；完整 Process 故障矩阵的停机场景 187.94ms，三个宿主均 exit 0、无强制退出。共同 Host/报告 SHA256 `b69e8de9e89542e1ace6b881bd0f20001c6b7ec41343530c4957fa9acc4b7260`，见[最终证据](../design/v0.7-shutdown-deadline.md)。下方 RED 保留为修复前记录，满 TS 队列的确定性 Bootstrap 测试与真实宿主证据分层。

普通远程期限另有反例：`node temp/v0.7-remote-deadline-probe.mjs` 用隔离 Node 记录实际 TS 打包，20ms 的 call/send/sleep 等待 **77.32ms** 后仍提交完整 20ms，`temp/v0.7-remote-deadline-audit.json`。它未发网络，不能宣称对端执行；正确方向是单调绝对期限覆盖 TS 与原生排队，且未轮询的过期工作也要能完成通知。不能只在出队时重新启动相对计时、以普通 Promise.race 冒充取消或减少并发夹具绕过。后续需 Rust 调度及真实 V8/网络反例，见[盘点](../design/v0.7-ts-mailbox-audit.md)。

停机期限已保留修复前反例：`temp/v0.7-shutdown-deadline-red.log` **8 failed**，286ms。满 65536 项远程队列时，旧 watchdog 的 sleepHost 准入拒绝使 stop 在实际钩子未结束前提前终结；并发调用也没有共用 Bootstrap 结果，其余反例检验尚不存在的专用资源契约。按[停机设计](../design/v0.7-shutdown-deadline.md)独立预留一项，并在创建异常时仍执行/观察清理；不能直接套满额后跳过 factory 的普通本地期限包装器、吞错或关闭真实停机钩子。复测 `npx vitest run tests/unit/process_shutdown_deadline.test.ts tests/unit/scene_call_deadline.test.ts tests/unit/global_id_bootstrap.test.ts`；原生资源与实际宿主证据另验。

远程共享准入最终通过：相关 **27/27**，含 KCP **check 8/8、quick 33/33、full 9/9**，457372ms，`temp/v0.7-host-operation-admission-verify.log`；Rust 240 项、Linux 条件编译、AI 实际归档通过。真实 V8 新场景 9888.79ms，65536 条单向消息、64 MiB 整包完整送达，4 次公开 1011 及排空恢复通过。宿主/两份报告共同 SHA256 `73d8d2ee0bd1e1404fe75dd08400bcad73330d6bde5492ddba6230c9c83c27d0`；范围、隔离夹具的独立 256 MiB Rust 出站预算与证据见[最终验收](../design/v0.7-host-operation-admission.md)。下方探针/RED 是修复前记录；排队期限、停机资源和 TS 全部二进制保留仍另行处理。

远程 Host 共享准入按[独立契约](../design/v0.7-host-operation-admission.md)实施：旧反例 `temp/v0.7-host-operation-admission-red.log` 为 **10 failed/2 passed**，包括混合 call/send/sleep 整批超限、超大/过短帧污染旧项、公开错误类型和借用帧失效。先验证输入及共享条数/含头成本，再建立路由和等待记录；失效帧只影响本项，计数与待回复按不同释放时机观测，不能清空此前已接受队列或把 queued bytes 叫作堆上限。初步相关 26/26 通过；旧 RPC mock 的一字节输入本就不满足 Rust 最小帧长，迁移为二字节后保留原完成/ID断言。真实宿主、指标及最终矩阵仍待验证。

本地期限资源最终验收通过：相关 **31/31**，含 KCP **check 8/8、quick 33/33、full 9/9**，434358ms，`temp/v0.7-host-deadlines-verify-final.log`；Rust 239 项、Linux 条件编译和 AI 实际 0.2.0 归档通过。实际 V8 期限场景 9972ms，其中 2000 次快速调用合计 148.95ms，超时后 callee 继续占额并阻止热更，真实完成才恢复；普通 Host 与两份报告共同 SHA256 `670e83f915b0067d8fe8a979bae688ff77d3855f520f1c3e0740cee3164bf224`。完整证据、初版 waiter 成本、legacy 夹具缺桥及首轮 ENOBUFS 保留在[期限验收](../design/v0.7-host-deadlines.md)；没有改系统参数，后续通过不证明 ENOBUFS 根因已修复。远程整批准入和停机期限仍有独立边界。

后续远程 Host 队列审查发现混合准入问题：独立 Node 边界探针先接受 65536 个 send，再接受一个 call，打包总数 **65537**，超出 Rust 整批解码上限。`temp/v0.7-host-operation-admission-audit.json` 只证明当前 TS 打包结果，未运行网络；应按[队列盘点](../design/v0.7-ts-mailbox-audit.md)在接受新项之前统一共享容量、帧和打包成本检查。不能只看各入口自己的 pending/queued 上限，也不能丢弃此前已接受项来让整批通过；该远程路径尚未修改。

期限快速路径的确定性反例为 `temp/v0.7-host-deadlines-fast-path-red.log`（1 failed/10 skipped）：100 次立即完成的本地调用仍创建了 100 个原生 waiter。改为创建时预留绝对期限、宿主刷新时再启动剩余 waiter，已有等待仍实际排空；统一停机取消覆盖两种状态，延后注册失败保留已开始目标的真实所有权。旧 RPC 自测迁移新桥后，相关四文件 **31/31**，`temp/v0.7-host-deadlines-lazy-focused.log`。这是减少不必要异步资源，不是放宽容量或重置期限，最终真实宿主与完整矩阵仍须复测。

期限首轮完整矩阵暴露旧 RPC 自测仍手工完成 kind=3 操作、没有安装新增原生期限桥（`temp/v0.7-host-deadlines-verify.log`，`hostCreateDeadline is not a function`，unit 184 passed/1 failed）。需迁移其宿主替身并保留原 rpcId/超时断言，不添加生产回退桥或删除测试。该轮真实故障矩阵另遇 Windows admin HTTP `ENOBUFS`，`temp/hotfix-load-XxB2CZ/fault-report.json`；与历史现象相同但缺少失败瞬间诊断，不能归因于期限实现或宣布已修复。保留现场，不调系统网络参数、不减 500 连接，原命令复测。真实期限用例首轮还显示快速路径持续等待 pump 的额外成本，需要延后 waiter 启动但仍从资源创建时计时；不能用假的提前归还换性能。

本地调用期限存在独立的资源泄漏反例：旧 Promise.race 在调用提前完成后仍提交 sleepHost，`temp/v0.7-host-deadlines-red.log` 为 **5 failed/1 passed**。采用当前 isolate 所有、可取消的原生期限，返回前等待取消实际退出；只删 TS 记录、把期限挪到同一受阻批次或因超时释放 callee 名额均不成立，见[独立契约](../design/v0.7-host-deadlines.md)。新桥接还必须保留旧 packed uint32 转换：`temp/v0.7-host-deadlines-coercion-red.log` **2 failed/9 passed** 定位小数/NaN 直接传严格 u32 接口的兼容缺口，应保持原转换及错误文本，而非静默改变公开参数语义。无期限路径保持；停机控制的准入失败处理独立定义。

本地 Scene 两级准入最终完成：4096/EntryScene、16384/原 ProcessHost，定向 **49/49**，含 KCP **check 8/8、quick 33/33、full 9/9**，430647ms，`temp/v0.7-local-scene-capacity-verify.log`。实际生成协议保留 8192 RPC+8192 单向工作，验证两级 1011、来源关闭、独立 Worker，以及热更暂停期间真实 Worker RPC 完成排空；普通 Host 与两份报告共同 SHA256 `604c5e0d2b887b00a836298c5f50cf499745c818fa7931144064df452b86da40`。Rust 234 项、Linux 条件编译、AI 0.2.0 实际归档通过，完整证据和以下阶段失败见[本地 Scene 验收](../design/v0.7-local-scene-capacity.md)。网络控制积压、二进制保留和期限资源仍独立审查，阶段记录不代替最终结果。

本地 Scene 真实夹具首轮已通过满额/拒绝，但独立 Worker 探针错误地用 scene.scenes.call 调用自己，被既有 self-call 防护拒绝（`temp/v0.7-local-scene-capacity-v8.log`、`temp/hotfix-load-r9hBNs/fault-report.json`，1006）。这是夹具调用设计错误；改为 Worker 中第二个真实 EntryScene 作为本地目标，不关闭防护、不改 mailbox 顺序或吞掉错误，整轮 V8 故障场景重验。

本地容量 Vitest 49/49 后，独立类型检查仍发现夹具自定义 encode 的参数被泛型注册推断为 unknown（TS2345，`temp/v0.7-local-scene-capacity-types.log`）。给夹具函数显式 Response 类型，重新检查，不能用 as any 或将转译运行通过当作类型证明；此项是夹具标注错误，不是运行时容量失效。

本地 Scene 容量按[独立契约](../design/v0.7-local-scene-capacity.md)实施，4096/Scene、16384/原 ProcessHost，只覆盖本地 call/send 的排队和真实在途。首个反例直接 await 旧 ordered 队列中不会立即拒绝的调用，导致 30 秒测试超时（`temp/v0.7-local-scene-capacity-first.log`）；应先断言拒绝没有入队，再等待其错误，清理仍释放夹具 gate。修正夹具后 `temp/v0.7-local-scene-capacity-red.log` 8/8 失败，明确旧实现无新额度/指标，不靠加长 timeout 绕过。

接入本地节点释放后 7/8 通过，但公开 Scene.call 将本地 1011 重映射为 1006，`temp/v0.7-local-scene-capacity-propagation-red.log`。须像 send 一样保留已知 RpcError(1011)，其余现有错误映射保持；不能只看内部 dispatch 或把本地错误改成伪 Rust 字符串。节点销毁只释放未执行调用，实际等待仍绑定旧 Host；网络/控制与二进制预算另行处理。

Actor 两级准入与公开 send/网络拒绝传播已完成：定向 **42/42**、含 KCP 完整 **check 8/8、quick 33/33、full 9/9**，412040ms。实际 V8 16384 项、5 次 RPC 1011（含公开 send）、2 次来源关闭及销毁后保留/释放/热更恢复均通过，普通 Host 与报告共同 SHA256 `25e9130a1c4d0a9c9378c8348da865fb57d22f6ca2295c788f74d17302289281`，最终日志 `temp/v0.7-actor-capacity-verify-final.log`。Rust 233 项、Linux 条件编译和 AI 实际 0.2.0 归档通过，详情及此前各层失败保留在[Actor 验收](../design/v0.7-actor-mailbox-capacity.md)。本地 Scene 总量、TS 控制积压与二进制保留仍另行推进，不把本项当作全部 TS 内存上限。

容量验收必须覆盖业务公开入口：内部 ProcessRuntime.sendLocalScene 已返回 1011 后，SceneCallContext.sendFrame 仍仅识别 Rust 的 `[scene-overloaded]` 文本，并将本地 RpcError(1011) 重映射为 1006。`temp/v0.7-actor-capacity-public-send-first.log` 的公开 scene.scenes.send 断言失败，不能只用低层 router 通过证明对业务可用。需保留本地已知过载类型，同时保留远程 Host 字符串映射，再从生成协议验证公开路径并重跑最终矩阵；不改错误文本来匹配旧判断。

新增过载传播初版还需服从断线来源身份：异步单向调用在旧来源断开、30 秒墓碑过期并有同号新等待后失败，曾关闭新连接，`temp/v0.7-actor-capacity-late-source-first.log` 为 1 failed/13 passed。错误回调必须携带原 AsyncIngressSource，Scene 已关闭或原来源已失效时只保留失败结果、不再次关闭同号连接。当前相关 41/41 与类型检查通过；不要延长墓碑、提前结束业务或取消其他来源来绕过，最终矩阵另验。

Actor 容量真实夹具首轮在模块类型检查被 TS2305 拒绝：新增生成的 StarterMessages 未进入模块 Model 导出与 modelExports 桥，日志 `temp/v0.7-actor-capacity-v8.log`、现场 `temp/hotfix-load-RnNoA6`。修正临时模块 Model 的生成描述符导出并从头正规 protocol-update/build，不手改生成物、不在 Hotfix 深层导入；此轮未到宿主运行，不能记作容量运行失败或通过。

Actor mailbox 容量已按[两级准入契约](../design/v0.7-actor-mailbox-capacity.md)实现：每 Actor 4096、原 ProcessHost 16384 项排队加真实运行任务，销毁不提前释放实际等待。初始 5/6 边界用例失败证明旧实现无上限；加额度后，单向传播另有 7 项反例：Registry 吞掉 1011，本地 send 同步失败不返回、网络来源不关闭。须保留过载类型/失败指标，网络关闭实际 item.connectionId，不能用路由改写的 context，也不能把它当作业务取消或自动重试依据。

继续验证发现 Trace/Actor/批次外壳把同步过载误报成 MalformedFrame，3 项反例均失败；批次后续项同步拒绝还会遗失此前 Promise 的拒绝观察者（4 failed/9 passed、1 unhandled rejection，`temp/v0.7-actor-capacity-partial-batch-first.log`）。正确做法是外壳保留 1011，先前已接受项继续由原 Actor 记账并观察真实结果，不能将它们删除或将整体批次宣称为原子事务；现有 RPC/void/来源/外壳相关 40/40 通过，完整宿主和指标验证仍待完成。

EntryScene 连接记账已按独立职责搬到 `app/core/process/EntrySceneConnections.ts`，不加入 Socket/Session/业务取消能力；118 项 AST/声明比对、定向 21/21 和含 KCP check 8/8、quick 33/33、full 9/9 通过，完整构建与真实宿主身份见[纯拆分记录](../design/v0.7-connection-state-split.md)。提取脚本初版把清理语句误当作直接位于 __dispose，AST 数量断言在写源码前拒绝执行；真实所有者是 discardQueuedWork。移动前须先定位实际语句块，不能删除数量检查来让脚本继续。

连接记账拆分的声明检查随后发现原 processIngress 仍直接删除旧缓存字段；应在原 Disconnect 消费点调用新所有者，不能把删除提前到入站通知时机来消除编译错误。除了迁移执行体，也要展开所有权调用后比对 EntryScene 剩余方法，防止搬移漏接或时序变化。

迟到响应修复最终 20/20、含 KCP check 8/8、quick 33/33、full 9/9 通过；真实 V8/WebSocket 断开后仍等待实际任务、抑制迟到响应、缓存保持基线、热更恢复，实际宿主和 AI 归档身份见[迟到响应验收](../design/v0.7-late-responses.md)。编码临时副本和业务 DTO 仍不在此项预算范围。

连接迟到响应反例：Scene 析构保护不覆盖单个来源断线，旧异步 RPC 在 Disconnect 后仍向出站队列追加响应，unordered 路径还会重新填入已清理的连接 ID 缓存。新增 6 个用例全部先失败，含超过 30 秒墓碑、同号新等待和其他来源；独立软断言进一步复现缓存残留。按[迟到响应契约](../design/v0.7-late-responses.md)保存等待所属状态，断线使其失效，旧 finally 不能删除同号新状态；业务任务仍按真实完成排空，不能延长墓碑为永久或清空所有队列来绕过。

Process Spawn 总额度已完成：每 Scope 256、每原 Host 4096；定向 17/17、最终含 KCP check 8/8、quick 33/33、full 9/9 和 Linux 条件编译通过。实际 V8 验证拒绝、注销后占用、完成恢复与固定 Process 指标，AI 归档同步核对，详见[容量验收](../design/v0.7-scene-task-capacity.md)。mailbox/二进制总量及 Linux 实际 I/O 仍是独立缺口。

Spawn 的每 Scope 256 上限不能形成 Process 总量限制：首轮跨 17 个 Scope 的用例仍接受第 4097 项，且原局部上限只抛普通 Error。当前按[进程 Spawn 准入](../design/v0.7-scene-task-capacity.md)补齐 4096 总额度和明确过载码；首次 2/2 失败日志 `temp/v0.7-scene-task-capacity-first.log` 保留。额度须绑定原 Host，注销/取消不能提前归还，不能拿此项代替 mailbox 或堆内存总预算。

任务准入修复最终定向 12/12、含 KCP 完整 check 8/8、quick 33/33、full 9/9 通过，含真实 V8 拒绝后热更恢复；实际 Host/报告身份及 AI 0.2.0 归档已核对，见[准入验收](../design/v0.7-scene-task-admission.md)。既有 Godot、Linux 实际 I/O 和发布冻结缺口仍保留。

Spawn 准入失败原子性反例：缺少 TimerSystem 或 watchdog 注册抛错后，旧 Scope 已插入 record 却未创建任务微任务，InFlightCount 永久为 1。首轮 3 个反例均失败；现只撤回本次 record，成功注册后一起保存 Timer owner/句柄并更新成功高水位。原异常保持，body 不运行，同 Scope 重试可恢复，其他 Scene 已接受任务保持；禁止吞错、停掉 watchdog 或清空其他工作。定向与真实 V8 验证见[任务准入](../design/v0.7-scene-task-admission.md)，不等于新增 Process 总额度。

Host 批次首轮完整矩阵为 quick 32/33、full 8/9，唯一失败是 Rust 测试模块放在 impl 前触发 Clippy `items_after_test_module`；不是运行用例失败。移动测试块并保留检查，不加 allow 或把单测通过当整轮通过。两条跨批次队首仍计入深度与高水位，不能沿用 mpsc capacity 截掉实际暂存量；复测和最终宿主身份见[批次验收](../design/v0.7-host-event-batches.md)。

0.7 Host 入站批次在复制前按含头部的 64 MiB 上限拆分，普通运行与停机 completion 共用。满批保留原事件，先 Update，再续同通道 FIFO；控制/数据各最多暂存一条，守卫和队列深度不提前归还，退回恢复公平计数。单个合法网络/Inner 响应帧仍限 1 MiB；异常内部事件放不入空批则复制前明确失败，不截断成功结果或伪造业务过载。首次真实 V8 两路径均出现 83887124 字节单批，证明 ingress 准入不能覆盖打包副本。禁止通过调大阈值、减小反例或只测编码器掩盖问题；重建宿主与复测证据见[Host 批次](../design/v0.7-host-event-batches.md)。这不是 V8/TS 存活缓冲、completion 总量或 RSS 的上限。

安装工具返回 session_id 仅表示仍在运行，不能据此启动依赖它的测试。本轮候选重装曾与 quick/LSP 重叠，相关结果不作最终证据；须 wait 到退出码 0 后重验，并比较实际 npm/VSIX 字节。具体日志见[依赖方向](../design/v0.7-dependency-rules.md)。

Program 已检查不能替代“每个文件已检查”：首轮新增排除文件反例证明，全局关闭语法回退会漏掉 tsconfig 排除但索引器仍发现的 Model 文件。现记录实际检查文件集合，仅该集合禁用重复语法诊断，其他文件保留确定性检查；见[依赖方向](../design/v0.7-dependency-rules.md)。

依赖规则首轮真实 CLI/LSP 暴露 Windows 路径比较缺陷：TS SourceFile 的 `/` 与 path.join 的反斜杠被当作不同 Stable 文件。比较须按平台路径段/大小写规则归一，不能移除目标身份检查或放宽 LSP 期望。纯内存 AST 不足以证明实际安装行为；失败和重打包复测见[依赖方向](../design/v0.7-dependency-rules.md)。

依赖 worker 夹具首轮 TS5097 是测试带 `.ts` 相对导入先被正式 tsconfig 拒绝；应改为受支持的无扩展路径再验边界，不能放宽编译选项。原失败及重跑记录见[依赖方向](../design/v0.7-dependency-rules.md)。

0.7 依赖方向检查统一至 Developer Tools dependency ruleset 1：主工程/模块 CLI 与实际 LSP、宿主两处边界命令共享 AST 规则和当前 Program 的解析目标。Model 深入 Core、Core 反向别名、type-only/import-equals 曾漏检，首轮 5 项中 4 项失败。使用 Stable public、精确启动/生成 ABI 例外，禁止目录级放行或把动态未证明当成功；规则、夹具修正和复测见[依赖方向](../design/v0.7-dependency-rules.md)。

动态 Scene 注销路由不等于 Spawn 结束：已运行任务须在 ProcessHost 独立持有 Scope，直到真实完成才主动移除引用；协作取消不能清零在途数。watchdog 句柄必须绑定原 TimerSystem，禁止迟到 finally 重新读取当前单例。首轮两个真实 Runtime 反例分别证明销毁后漏计热更和旧任务访问新 Runtime Timer；修复契约、禁止绕过与复测见[Scene 任务销毁](../design/v0.7-scene-task-disposal.md)。

真实热更夹具需使用当前错误契约：首次新增本地 mailbox 用例已返回 `drain deadline exceeded` 与 `pendingAsync=true`，因测试猜测 timeout 文字而失败。复测应核对拒绝状态、实际错误字段、在途标志及 generation 保持，不改宿主期限或把拒绝记成成功。原报告与命令见[mailbox 生命周期](../design/v0.7-mailbox-lifetime.md)。

0.7 mailbox 生命周期：出队立即清空旧数组槽，Scene/Actor 空闲节点池各最多 64 个；这是复用缓存上限，未执行任务/TS 堆总预算仍未完成。EntryScene 实体销毁先关闭准入、拒绝未执行 RPC、断开帧和闭包引用；在途业务仍等真实完成，迟到结果不能重填出站或节点池。本地 direct Actor 与 unordered Scene 曾漏计热更在途，不能只用网络任务、Timer 或 Spawn 数量证明排空；ProcessActor 计数在路由销毁后仍保留，直到真实完成。首次引用/销毁 5 项失败与新增屏障 4 项失败、修法和复测见[mailbox 生命周期](../design/v0.7-mailbox-lifetime.md)。

矩阵的 Cargo 步骤统一走 run_cargo.mjs：直接启动 Cargo 的冷链接曾留下本步骤的 MSVC vctip 后代，缓存命中重试则不复现。只设置 VSCMD_SKIP_SENDTELEMETRY 在此路径无效；已有 Node 启动器负责工具后代，外层 Job 仍严格检查残留。必须强制重新链接验证，禁止按进程名忽略失败、清理用户工具或把此前 quick 31/33 改写通过。诊断、修正及原报告见[矩阵生命周期](../design/v0.7-matrix-lifecycle.md)。

夜间验证每步现有墙钟期限与进程所有权：Windows 使用暂停创建后分配的 Job，Linux 独立组由轻量 Node/IPC EOF 回收嵌套步骤。不能只 kill 根 PID 或仅靠父矩阵的信号监听；父级可能先退出或同步阻塞。PowerShell 5 的 JSON 参数数组要直接转换，外包 @() 曾把多参数拼成一个；测试须覆盖空串/Unicode/引号与 shell 元字符。Windows 残留夹具须让子进程脱离 Node 自身约束，才能证明外层 Job 的回收。原失败、正确做法及 Windows/Linux 复测入口见[矩阵生命周期](../design/v0.7-matrix-lifecycle.md)，不得把超时/中止/未回收改记通过。

0.7 Hotfix 成员禁令已迁到 Developer Tools 共享 ruleset 2。必须用当前 Core 的装饰器声明身份，不能从同名字符串或旧宿主推断；缺 Program 的显式稳定入口候选只报 `tiangz.hotfix.unverifiable` warning，真实违反保持 `tiangz.hotfix.instance-state` error。TypeScript 5 的 ClassElement 不能直接读取 modifiers，跨版本共享实现使用调用者 API 的 canHaveModifiers/getModifiers；首轮编译错误修正后保留字段/构造/static/无关装饰器负例，不能降低确定错误级别来迁就测试。成员规则、独立模块范围和 CLI/LSP 证据见[Hotfix 契约](../design/v0.7-hotfix-contracts.md)。

0.7 G2 将地图部署迁到 MMORPG 的 `org.tiangz.mmorpg.map-deployment` 数据包；Core 只保留信封和旧字段兼容投影。缺失旧字段不得补成显式 `[]/false`，双写冲突或声明包缺当前实例必须拒绝。文件名严格为 `runtime.pack.json`，独立目录表达用途。模块使用 Stable `RuntimeDataPackRegistry.Instance`，不向 public 添加内部 SingletonRegistry。见[地图部署契约](../design/v0.7-map-deployment.md)。

无目录服务的最小房间已作为 Examples `tools/fixtures/room` 的真实消费者：一个 Room Scene、Model Component 状态、Hotfix 行为、生成 SDK，直接地址连接和 roomId 查找，创建/加入/离开/新 Socket 重连快照及容量拒绝均通过。它证明简单游戏无需部署 Location/MapHost，不证明跨进程迁移、生产鉴权或持久恢复。复跑与证据见[房间消费方](../design/v0.7-room-consumer.md)。

跨 worktree 验证必须统一 TS Core、DBProxy SDK 和 Native TiangZ 库身份。Examples 的历史相对导入与 SDK 由所选宿主解析；立即完成的内存 Transport 夹具显式声明预算能力，真实 I/O 不得只加标记。Native 构建前核对 Cargo 实际依赖源，不能以相同版本掩盖旧宿主；模块 Cargo 路径由开发者显式对齐，禁止通过全树 Cargo paths override 扫描依赖缓存。本轮具体失败、反例与重建证据见地图部署记录。

Timer 默认参数 `Tick(now = Date.now())` 的声明内类型是 number，但调用时 undefined 合法；共享检查器必须验证默认值调用语义，不能改正确游戏代码规避误报。插件 TS 5 正反例、宿主 TS 6 夹具和 MMORPG 实际 check 均覆盖这一教训。

0.7 DBProxy 已提供独立 `dbproxy_capacity`：固定 18 表、分区叶子字节与 catalog 估算，默认不扫描业务时间；`--include-server-age` 仅针对已存在的服务器时间列，250ms/表，总预算默认 10 秒，独立只读事务且无迁移/worker。业务 `updated_at_unix_ms` 不能当保留年龄；未知估算/缺表/RLS/超时必须明确，不做 TTL 或回执删除。临时 PG18.4/Redis8.8.1 上真实容量与 7 项恢复用例通过，含 COMMIT 回包丢失、部分成功和 Outbox 双消费组去重；这不等于长稳、断电或备份恢复。范围、提交和日志入口见[进度](../design/v0.7-progress.md)，测试容器已核对身份并回收。

0.7 增加 ConnectionWriter 共享 `maxOutboundBufferedBytes`（64 MiB 默认、1..1 GiB）：资源守卫从批次入队持续到写出/最后转发引用释放，满队列、关闭、取消/panic 均回收。广播按接收者保守累计；总预算拒绝与每连接慢消费分开统计。该额度同时覆盖主动 Inner Host 整包：V8 复制前预留，切片持有至队列/在途写出结束；整包超限同步拒绝。writer 入队取操作/写出最早期限，成功后立即清空批次，会话退出取消读写任务。不含响应、入站/V8/系统缓冲及 KCP 内部重传，不能宣称整个 Process 内存有界。Rust/TS/Schema/固定 kind 指标同步，详见[传输说明](../reference/transport-backend.md)。

主动 Inner 的慢写单测不能假定 Windows 回环的小 Socket 缓冲必然造成阻塞：首次两帧 2 MiB 已被系统接收。保留真实 TCP 写出/空闲释放/EOF；用固定容量异步流确定性验证部分写、过期队列与取消，同一写者实现和原断线/公平性断言均保留。范围、原失败和复测见[预算契约](../design/v0.7-batch2-contracts.md)。

Linux 编译容器不要把只有 registry/git 的 Cargo 缓存挂到镜像工具链的安装目录；这会遮住 cargo/bin，出现 cargo: command not found，并非代码编译失败。缓存单独挂到 /cargo-cache 并指定 CARGO_HOME，保留镜像 PATH，用非 login shell。首次日志 temp/v0.7-inner-budget-linux.log；原条件编译命令的复测记录为 temp/v0.7-inner-budget-linux-ready.log，不以跳过 Linux 或改全局 PATH 绕过。

0.7 生命周期/Timer 类型规则由 Developer Tools 唯一维护；Host/外置模块传自己的 TypeScript API 和当前 Program，不能跨 TS 版本复用 SyntaxKind 或按同名类猜 Core 身份。主工程 CLI/LSP 已共用类型规则，实际 receiver、当前取消上下文与生成 System 声明参与判断；明确违例 error，动态未证明 warning。普通 tsc 不自动加载规则。受信任工作区的模块实时 LSP 已通过只读 Host worker 接入同一检查入口，已保存声明选择宿主、既有 TS 未保存内容只作内存覆盖；配置未保存或环境失败须明确不可用，详见[Program 记录](../design/v0.7-program-contracts.md)。LSP 必须随 VSIX 携带匹配标准库并释放工程缓存；测试通信使用生产的对象参数协议，不以超时或“0 条错误”冒充成功。

模块实时检查须以宿主返回的源码/声明范围筛选 overlay，不能仅按工程根过滤联接模块；跨盘 path.relative 可返回绝对路径，Problems 定位使用 path.resolve 并断言实际 URI。首次测试选错进程、side-effect 导入和已有脚手架目录的夹具错误已修正且保留日志；不改生产规则来迁就夹具。操作与复测见[模块实时检查](../design/v0.7-module-live-checks.md)。


Program 接线完整矩阵曾有一次热更故障夹具 ENOBUFS（500 业务连接后的 admin HTTP connect），full 为 7/8；同命令三轮复测通过，不等于已查明资源失败。保留原报告与候选身份，不能通过缩减并发、修改系统 TCP 参数或把单项复测写成原整轮全绿。详见[实施进度](../design/v0.7-progress.md)。

N3 V8 夹具已按每故障场景一个测试子进程隔离；端口重绑/名额归零仍在该子进程退出前断言，父测试确认实际执行一条用例，超时只回收自身子进程。不使用全局单线程测试绕过问题。隔离后全目标 KCP 189 条和 Clippy 通过；原 0xc0000409 缺原生栈、未再复现，仍是待定位现象，不能写成已证明的 V8 修复。

Process 采样/快照转换现归 process/observability.rs，8 个内部 DTO/枚举、完整采样函数和两个原解析测试机械搬移；类型字段仍私有，V8 GC 回调及其 Box 指针生命周期留在 Process。规范化声明/执行体相同，证据见[纯拆分记录](../design/v0.7-observability-split.md)。联跑出现过一次 0xc0000409，无原生栈；后续并发多轮及本机 CDB 均 161 条通过，但原因尚未确定，不能宣称已修复。新增 N3 的多 Process/V8 测试应按宿主真实 OS 边界隔离，不能靠全套测试串行或降低断言掩盖异常。

0.7 可观测性按职责拆分：health/metrics.rs 集中 Prometheus 格式化，健康状态、HTTP 管理和所有权留在 health.rs；子模块可见性不扩散私有字段。13 个函数机械比对执行体/声明相同，15 个原测试通过，见[纯拆分记录](../design/v0.7-observability-split.md)。不得借纯搬移修改标签、顺序或失败行为，Rust 仍须重建/重启。

Process 生命周期验证补充：后端工厂在原初始化位置注入，默认路径仍使用 create_io_backend，没有线上故障配置。隔离测试保持测试 OS 进程/Tokio 存活，验证第二端口绑定失败后第一端口/健康端口可重绑；真实 V8、listener 和 HTTP 探针配合可控端点完成，验证错误/panic/意外正常结束撤销 ready，停止期间 live 保持。测试入口是专用裸 V8 夹具，不能把它称为完整业务模块验收；普通模块运行仍由完整矩阵覆盖。

生命周期夹具失败教训：先前错误使用 manifest.json 导致 GameConfigBundle 在监听前拒绝，随后 Update 全返 JSON 导致非采样帧的 compact state 解析失败。必须核对真实 game-config.manifest.json 文件名和采样/非采样双返回契约，并在等待 HTTP 状态时同时监视 Process 退出错误，不能只等探针超时或放宽生产解析。原证据 temp/v0.7-process-lifecycle-{first,fixed,diagnostic}.log；修正后两个场景通过，见 temp/v0.7-process-lifecycle-green.log。

0.7 Process 入站准入新增 maxAcceptedConnections（默认 65536）和 maxPendingHandshakes（默认 1024），均为 1..1000000 的整数。全部业务 listener 共享即时准入，TCP/WS 在 spawn 前取连接和握手名额；KCP 验证 cookie 后才取连接名额，重复 CONNECT 复用 Session。握手完成只退握手名额，失败、任务取消/panic、断开及停机由所有者归还；不排队等待额度。固定 kind 标签的占用/上限/拒绝指标与 Rust、TS、插件 Schema 同步。此边界不包含出站 Inner 链接、health HTTP、帧字节或 KCP 未确认缓存，不能宣称整个进程内存有界。详见[传输说明](../reference/transport-backend.md)。

准入指标首轮反例属于夹具错误：未设 sample_timestamp_ms，已有指标逻辑按“尚未采样”不导出；必须给夹具有效采样时间，不能删除生产采样门槛。原日志 temp/v0.7-admission-first.log 保留，修正后含 KCP 的宿主 159 条及 Clippy 通过（temp/v0.7-admission-green.log、v0.7-admission-clippy.log）；重建宿主与完整矩阵另行验收。

0.7 AI 源与分发已同步候选：操作预算、Timer 在途、可选逻辑目录及各插件独立版本规则进入 tools/ai-assistants，Cindy 明示版本未探测，规则 36 条。显式分发脚本只写指定仓库生成物，核对清单版本/哈希；实际归档内四个工具、六类建议通过，未安装或调用 Forge。见[交付记录](assistant-packages.md)。技能校验缺 PyYAML 且 MSYS2 venv 使用 bin 路径，独立 venv 纯 Python 安装后通过；不要误认没有 Python或改系统工具链。

0.7 DBProxy 外层预算已接通候选 SDK：每次 Repository 操作新建独立 WithRequestBudget 范围，读取/迁移/编码/同 ID 重试/退避共享期限；缓冲区在首次发送前复制，避免 Codec 复用后改变重试字节。Host 在转换前固定 Rust Instant 绝对期限，过期不启动新 I/O，未知提交结果仍按未知处理，不以 Promise.race 冒充取消。SDK 29 条、Repository 23 条和裸 V8/TCP 回收通过，见[第二批记录](../design/v0.7-batch2-contracts.md)。当前 npm 候选是显式本地安装，默认发布 tag/锁尚未冻结，npm ci 会恢复旧 SDK，不能把候选通过写成默认检出通过。

Host op 新参数教训：Cargo check 通过不等于 Deno 包装器可以启动。单记录事务 op 增至 10 参数后真实 V8 报 `Too many arguments for async op codegen`（`temp/v0.7-ts-host-budget-tests.log`）；记录身份改为结构化参数后 16 条 Host 定向测试通过（`-fixed.log`）。必须重建并运行真实 V8 与新参数路径，不修改第三方运行时/跳过启动测试；TS 测试夹具也必须覆盖真实 SDK 验证与防御性复制，而非伪装客户端对象。

预算联合回归保留普通调用形状：完整矩阵的旧 CommitRecords 断言发现额外 undefined 参数（`temp/v0.7-ts-budget-verify.log`），未开启预算也能被宿主观察到参数个数变化。SDK 与 Host Transport 改为无预算时省略参数、开启时才传期限；保留原断言并增加 SDK 回归，不能通过放宽旧断言隐藏兼容差异。DBProxy Rust 候选已在隔离源码副本显式链接，16 条 Host 测试通过（`temp/v0.7-dbproxy-joint.log`），主 Cargo.lock 哈希保持，副本自身路径锁不提交。

夜间最新检查点见[0.7 实施进度](../design/v0.7-progress.md)：已分开本地提交纯搬移、Timer/RPC、网络、Host/SDK/Repository 和插件修复；宿主 TS 预算轮完整矩阵全绿，两 VSIX 在专用目录安装并验证版本/哈希，AI 分发产物已核对。未推送或发布，默认依赖冻结、总量上限、Program 规则、G/S/O 等继续推进，历史“未提交/未安装”描述仅属于其当时批次。

0.7 RPC 预留修复：SceneCallContext 在 reserveRpcId 后立即进入 finally 保护，覆盖请求赋值、编码、Actor 信封封装、发送和响应解析；同步编码失败也必须释放 ID。9 条回归覆盖冻结请求、编码/封装与响应错误，原 6 条失败已转绿；不能仅捕获网络异常。

0.7 Timer 修复：异步到期/取消回调在真实完成前计入 InFlightCount，Process 的热更提交与 pendingAsync 读取该计数；每轮先冻结到期集合，回调中新建 Timer 下轮运行，重复期限须严格晚于当前帧。所有者销毁不提前释放在途计数；新增 Stable getter 需要完整构建重启。原失败反例与完整回归均已验证。

0.7 EntryScene 的纯拆分将配置/路由契约留在 process/types.ts，实现及私有队列归 process/EntryScene.ts；Stable 导出不变，33 个非 import 声明机械比对一致。执行体不变但声明图/构建指纹变化，需完整构建重启，见[拆分记录](../design/v0.7-entry-scene-split.md)。缺陷修复另行提交。

编译检查候选发现真实误报：Developer Tools 以全文件字符串表传播时间函数别名，参数、块/catch 和同级函数的同名合法调用被错误阻断。三个反例先红后绿，改为词法作用域绑定，61 项 Core 测试通过；不可删除别名检查来消除误报，须同时保留真实时间等待反例。CLI/LS 与宿主安装版本的证据分开，见[插件兼容记录](../design/v0.7-plugin-compatibility.md)。

慢写实测更新：真实 TCP 不读对端已证明已开始写入后按期限退出，Windows 全目标含 KCP 179 条及 Clippy 通过；Linux 条件分支检查通过。证据 `temp/v0.7-write-budget-green.log`、`v0.7-write-budget-clippy.log`、`v0.7-linux-write-check.log`；后续完整 verify 独立报告，不等价于生产长稳或 KCP ACK 恢复。

夜间构建入口修正：`build:runtime:debug` 原先直接执行 Cargo，绕过测试矩阵里的 CC/CXX 过滤，导致本机继承 GNU 编译器后 LNK1143 再现（`temp/v0.7-write-budget-host-build.log`）。该脚本现经 `tools/run_cargo.mjs`，确定 MSVC 目标后仅对子进程移除 GNU CC/CXX，保留显式其他目标和系统设置；不要只靠人工清变量或清 Cargo 缓存。复测应从同一 npm 入口重新构建，再完整 verify。

0.7 慢写候选增加 `process.network.writeTimeoutMs`（1..300000，默认 10000ms），从批次准入覆盖排队和写出；正常关闭的所有批次另共享既有 stopTimeoutMs。TCP/WebSocket/io_uring 超时结束字节流，KCP 仅约束交给可靠传输前的排队；不能将本机写入当成业务确认。writer 完成/失败/panic 通过 RAII 通知读侧清理，队列停止新准入再按原顺序排空。Rust/TS 配置、插件 Schema 和[传输说明](../reference/transport-backend.md)同步，旧 0.6.x 配置保持默认行为来源但超时规则在 0.7 收紧，旧宿主不接受新增字段。

网络测试夹具修正：Windows 首轮慢写测试 148 通过、2 个 KCP bind 失败（`temp/v0.7-write-budget-first.log`）。夹具先申请 TCP 空闲端口再绑定 UDP，TCP 可用不能证明 UDP 不在系统保留范围；按真实协议以端口 0 申请，再运行 `cargo test --bin TiangZ --features kcp --locked`，不改系统端口保留设置、不将失败跳过。确定性 duplex 已证明生产 vectored writer 实际写出 64 字节半帧后超时和预算回收；实际 Socket 慢写还需独立证据。

0.7 插件候选：Native Core 0.17.0 / VSIX 0.16.0 保持自身版本序列，打包文件名改为读取扩展清单，包内记录两个版本及 bundle 哈希。29 个插件用例、真实 VSIX 内容核对、四类夹具 21 份输出对照与 11 份生成 TS 的宿主 TypeScript 6.0.3 检查通过；宿主仍固定 Core 0.16.0，未安装候选插件。具体证据与边界见[插件兼容记录](../design/v0.7-plugin-compatibility.md)。import-only 包不能用 CJS resolve 判断缺失；跨仓库生成夹具使用 CompilerHost 虚拟挂载，不能放宽宿主规则或写入其他工作树 Generated。

出站预算由批次守卫持有，排队、写出、KCP 转发结束或取消时恰好释放一次；取出队列并不释放，实际丢弃批次才释放。`small_outbound_sets_keep_direct_connection_order` 的旧夹具在丢弃批次后仍期待计数为 3/6，与新契约冲突；保持原顺序断言，改为验证丢弃前 3/6、后 0/0。独立队列销毁反例已先在旧代码失败，不能靠后端测试手工减计数伪造释放。KCP 内部重传缓冲及 Process 总量尚不由此证明有界。

0.7 端点所有权补充：Process 监督实际 EndpointTask，端点用 JoinSet 持有连接，连接持有 writer 和 RAII 登记；异常结束走 Process 停机并返回失败，不能只记日志。停止准入取消未完成握手，正常连接仍排空已入队通知，网络排空使用既有 `stopTimeoutMs`，超过期限取消异步任务。健康 listener/HTTP 任务同样绑定所有者。KCP 的非法 Session 数据曾终止共享 listener；真实双客户端反例先红后绿，现仅关闭该 Session。当前 Windows `--features kcp` 二进制 141 条通过，源码与阶段边界见[第二批记录](../design/v0.7-batch2-contracts.md)。

0.7 网络补充：TCP/Auto 已把 `inner/outer/mixed` 贯穿真实连接准入，WebSocket 在 HTTP Upgrade 前检查 audience；内部连接仍需凭据。WebSocket 解码器同步应用既有 1 MiB 单帧/重组消息上限，不能仅在收到完整消息后检查。准入矩阵先红后绿，Windows 二进制 130 条通过；收包反例与后续结果见[第二批记录](../design/v0.7-batch2-contracts.md)。Linux/io_uring、连接总量及退出所有权尚未由这些结果覆盖。

2026-09-26 夜间继续：用户要求持续推进并由本任务处理常规选择。第二批具体契约见[夜间实施记录](../design/v0.7-batch2-contracts.md)。DBProxy Rust SDK 的 5 个总预算反例已先失败后修复，客户端 28 条、工作区 200 条和 Clippy 通过。Host 已让任务排队/池等待/I/O 共享预算并绑定调用方取消，删除整池重放层，4 个定向测试通过；Repository 的外层预算仍需接续。部分写使用确定性 64 字节 duplex 验证；本机 TCP 的小缓冲夹具实际已经完成写入，不能把响应等待当部分写。阶段、原因和原失败证据同步见开发手册，首批报告保留为历史验收，不代表第二批也已完成。

2026-09-25 用户确认开始实施 [0.7 设计稿](../design/v0.7-design.md)；2026-09-26 首批 R1–R4 与 DBProxy D1 的本地验收完成：TiangZ check 8/8、quick 32/32、full 8/8；DBProxy Rust 190 条、TS SDK 21 条通过，47 条真实存储/显式故障用例未运行，详见[首批实现与验收记录](../design/v0.7-batch1-acceptance.md)。Stable Core API 锁有已记录的声明图漂移，源码尚未提交；其余预算、模块迁移及插件兼容仍依设计分批推进，不能把首批通过当作 0.7 发布通过。六仓库各自使用 `feat/v0.7` worktree；插件保留自身发行序列，工作树后缀不表示插件降版。AI 规则源仍在 TiangZ `tools/ai-assistants/`，分发使用 AI Plugins 工作树。EntryScene 机械拆分已独立验证声明和执行体，业务只通过 Stable 入口访问 Core。

首批运行时约束：TimerSystem 跟踪已触发的异步到期/取消回调直到真实完成，包括 Actor mailbox 中的排队回调；所有者销毁不能提前释放热更排空计数。每次 Update 先冻结到期集合，回调新建的 Timer 最早下一轮执行，取消仍立即生效；浮点帧时间不能使重复 Timer 的下次期限停留在当前周期。RPC 编码、请求赋值、Actor 信封封装及发送均属于预留 ID 的 finally 释放范围。失败复现与 Windows 工具链教训同步见[开发手册](business-development-manual.md#07-首批运行时修复与构建环境2026-09-25)。

流识别/握手集中在 `src/transport_backend/handshake.rs`，原生 TCP 半流和已升级 WebSocket 再交还 epoll 连接所有者。Auto 消费的三字节前缀必须重放。第二批把既有 5000ms 总握手期限扩展到显式 TCP/WebSocket 和 io_uring TCP；初始帧长度、HTTP 升级或内部认证都不能因分片刷新预算。连接读写/总量仍需单独验收，参见[传输说明](../reference/transport-backend.md)，不能推导为全部慢连接已受限。

本次真实构建补充了工具链证据：MSVC 构建子进程清除继承的 GNU CC/CXX，跨盘 V8 源码使用工作树内目录联接；完整 verify 前先构建 debug 宿主，不能以 cargo test 的测试二进制代替。原因和原始失败记录见上述首批文档及开发手册，不更改整机安全设置。

隔离热更测试必须保留自身依赖的 INFO 事件：外部 `RUST_LOG=warn` 曾让开发流程与故障驱动错过完成/暂停日志，导致测试超时及驱动未释放请求。两个夹具的子进程固定 `warn,tiangz::hotfix=info` 后复测，不能改宿主日志默认值、放宽热更窗口或绕过真实排空来处理此环境问题。原失败和当前结果见首批记录。

新 worktree 依赖准备教训：Git 依赖的 prepare 产物不能通过 `npm ci --ignore-scripts` 获得；正常 `npm ci` 后再 codegen/验证。前置 quick 因依赖缺产物失败，重装后的运行被主动停止，不能记为整轮通过。现象、修法和复测入口见 [AI 业务开发手册](business-development-manual.md#07-worktree-依赖准备与中止结果2026-09-25)。

2026-09-18短时采样回归已通过：`sampling10-rd6WDP/report.json`为`sampling10-passed`，北京时间10:36:32开始测量，实测601201ms，10:46:54完成清理；21个有效资源样本通过原20个门槛、同PID及增长检查，26笔业务及26次原命令重放、29次对账、233次快照，最终冷重启恢复通过，游戏/代理/探针/存储全部停止。正式构建与24项工具测试通过；历史样本回放确定复现原18/20失败。本轮仅验证采样修复，未执行热更和五种故障，未启动新八小时测试，原八小时失败报告保持不变。 / The ten-minute sampling regression passed with 21 valid samples against the unchanged 20-sample threshold, same-process growth checks, 26 operations and replays, 29 reconciliations, 233 snapshots, final cold recovery and complete cleanup. The official build and all 24 tool tests passed, including replay of the original 18/20 failure. This verifies sampling only; no new eight-hour soak was started.

2026-09-18八小时SLG长稳soak8h-Bkzmwd最终failed：恢复期23次点采样中，3次outbound=1、2次pending=1被静默过滤，仅18个空闲样本，结束时才触发至少20个门槛；随后资源增长检查及最终冷恢复未执行，原失败报告必须保留。修复采样器为60秒内等待两个不同指标发布周期均空闲，保存全部忙/旧快照，指标不刷新或持续忙碌则失败；固定采样时隙、运行中检查剩余容量、恢复期结束即执行数量和同PID增长门槛。禁止把最低数量改为18或复用同一快照补数。历史23个样本已冻结为回归夹具；复测为SLG正式build、node --test tools/acceptance/*.test.mjs，再node tools/soak_acceptance.mjs --profile sampling10 --confirm isolated-slg-authoritative-test。短测前8分钟每20秒采集、保持20个门槛，后2分钟收敛并冷恢复；它不替代八小时和五类故障验收。 / The completed soak failed because silent filtering left 18 of 23 samples. Preserve that failure; require two fresh idle publications within a bounded wait, check coverage early, and validate with recorded evidence plus a ten-minute real-storage regression.

2026-09-18 H/J前置验证已完成：25个子项分批实测通过，H3在run-gOw29M连续三轮通过（准备阶段客户端回包3/4/3），H8在run-xSvyRq通过10次正式候选和992个连续样本；所有清理成功。五分钟长稳自检smoke5-GUPRFU通过。八小时控制器PID 27472已后台启动，报告在Examples/packages/slg/temp/authoritative-acceptance/soak8h-Bkzmwd/report.json，每5分钟采样；必须看状态、最近采样时间及进程存活，不能把启动当通过。停止用同目录STOP文件，勿强杀Node留下假running。完整三轮A/B/C/D/H/J矩阵仍未通过；本次未修改宿主或DBProxy运行时代码。 / All 25 H/J cases passed in separate runs, including three consecutive H3 rounds and H8 resource gates. The eight-hour isolated soak is launched but not yet passed; use the report heartbeat and cooperative STOP file.

2026-09-18 H3二次复核（run-0YDqnf）出现not-effective：单条串行只读流量的一次往返跨过约85ms准备窗口，服务端已生成旧版响应，但客户端收包比暂停日志到达晚约0.2ms。保留原报告，不把服务器时间替换成客户端完成证据；夹具改为最多4条并行只读请求链，并保留发送/收到/服务器时间，仍严格要求暂停前有客户端回包。禁止拓宽暂停前窗口或改为任意早期回包。复测：正式build后run --cases H3 --rounds 3 --confirm isolated-slg-authoritative-test，再单独H8；不能用旧H3通过记录替代此次稳定性复核。 / A single read round trip straddled the short preparation window. Keep the client-before-pause gate, use four bounded read chains, preserve all timing evidence, and rerun three rounds without changing runtime behavior.

2026-09-18 H9b首次实测被服务器正确拒绝，但夹具只匹配protocol文字而误判。正式协议生成物参与Model包字节，src/hotfix.rs先校验modelFingerprint，因此正确路径可能先报Model哈希不兼容。修复要求候选真实protocolFingerprint不同，并精确核对首个不兼容字段及双方哈希；禁止仅接受任意422、手改manifest或跳过指纹。失败证据为SLG run-JP9R5Z/H9b-1及report.json；同份报告的H3-F2/F3、H6、H7a/b、H9a已通过。复测SLG正式build后run --cases H9b --rounds 1 --confirm isolated-slg-authoritative-test；新增反例单测拒绝无协议变化及无关错误。 / H9b exposed a fixture assumption about rejection order: generated protocol code changes the Model hash, which is checked first. Verify the real protocol change and exact rejected hashes, never arbitrary rejection or edited manifests.

2026-09-17 H3-F2 首轮记录为 not-effective：队列日志已证明 frame=3072、backpressure=1，但基线抓取早于首个周期指标发布，缺少 frame 分阶段计数。夹具现在有界等待完整基线，并保存饱和前后原始指标；禁止将缺指标当零、降低队列容量或删除背压断言。失败证据：SLG temp/authoritative-acceptance/run-8KTtrc/report.json 与 H3-F2-1/game-1.log。复测：SLG 执行 test:acceptance build 后，以 run --cases H3-F2 --rounds 1 --confirm isolated-slg-authoritative-test 定向验证。 / The first H3-F2 run lacked its initial periodic metric snapshot despite actual saturation. Await a complete baseline and preserve raw metrics; never substitute zero, reduce capacity, or remove the backpressure assertion.


D1修复后定向复测：run-wTYhCH/report.json为subset-passed，官方authoritative_reads真实PG/Redis测试1通过（11.42秒），SLG原子批量探针通过，游戏/代理/探针/存储全部停止。工具单测17通过；正式build/check通过。此证据仅覆盖D1，不代表H/J或整轮90分钟通过。

2026-09-17 A4启动失败的根因是验收夹具长期保留每个隔离项目的Docker默认网络，最终耗尽预定义地址池；清理范围仅限确认无运行容器的 `slg-acceptance-*` 网络，夹具现以 `docker compose down --remove-orphans` 清理容器和网络并保留命名卷。 / The A4 startup failure was caused by the acceptance fixture retaining one Docker default network per isolated project until the predefined address pools were exhausted. Cleanup is limited to verified `slg-acceptance-*` networks with no running containers; the fixture now uses `docker compose down --remove-orphans` to remove containers and networks while retaining named volumes.

H3验收夹具已固定正式DBProxy的 `writes[].record` 匹配，并在热更场景对子进程显式设置 `RUST_LOG=info`，保证真实暂停/恢复日志可观测；此前的超时分别是字段和日志过滤造成的夹具误报，不代表Runtime或DBProxy业务失败。 / The H3 acceptance fixture now matches the official DBProxy `writes[].record` shape and explicitly sets `RUST_LOG=info` for hotfix scenarios so real pause/resume logs remain observable; the earlier timeouts were fixture false positives caused by field shape and log filtering, not Runtime or DBProxy business failures.

2026-09-17 SLG D1夹具隔离失败：run-cHJ8WY在D1提前退出；补齐子进程stdout/stderr日志后，run-TC9Bun确认StorageBackend初始化报publisher endpoint changed，尚未执行读取断言。原因是独立存储测试与SLG共用PG数据库，却以宿主机缓存Redis地址注册已被容器队列Redis占用的legacy Publisher。正确做法是在本轮隔离PG容器内创建authority_probe专用数据库；SLG原子批量探针仍检查SLG数据库，存储级断言单独标明范围。禁止清空Publisher注册表、放宽端点校验或手改构建哈希。复测：在Examples/packages/slg执行node tools/authoritative_acceptance.mjs build，再run --cases D1 --rounds 1 --confirm isolated-slg-authoritative-test；失败证据为temp/authoritative-acceptance/run-TC9Bun/D1-1/sql-snapshot-probe.log。修复后的结果以新报告为准。

2026-09-17 七日测试复测入口：[分析基线及对应提交核验](external-7d-analysis-baseline-20260917.md)，[三组复测清单](../../../TiangZ-Examples/tools/chaos/retest-7d-findings.md)。新增缓存写超时回归已编译未实跑；DBProxy缺口尚未修复。不得将最终状态恢复当作运行期无旧读，也不得遗漏Relay最终核验失败。

## AI续接必读：失败教训

2026-09-17 90分钟验收首次启动run-MeA1nL失败：夹具把主endpoint重复放入endpoints（failoverEndpoints旧别名），宿主在连接前正确拒绝；尚未进入业务或计时。修复为endpoint=A、failoverEndpoints=[B]，不放宽运行时校验。原报告和卷保留，隔离容器已停止。配置/源码改变后经正式build/check再开新报告，不能覆盖旧失败或手改构建哈希。


2026-09-17 SLG热更夹具：Examples/packages/slg的test:acceptance新增build-hotfix及smoke30计划。隔离副本使用正式Luban/proto/Bundle生成四种代码配置配对和对应启动包；H/J的25子项已接入，新增acceptance90全42项目单轮预算及B组各3分钟恢复观察；真实数据库故障轮次尚未运行，不能宣称完整三轮通过。H8复用已有outbound_lanes自定义指标，H5d通过冻结Model的不可替换方法槽测试现有提交回滚；不修改Core或Rust。18项纯工具测试、正式候选构建、SLG检查及框架回滚自测通过。配置校验使用现有gameConfig.validator，不改Core；Luban int/long可能生成相同TS schema，负向测试必须验证实际指纹变化。见[实施与覆盖边界](../../../TiangZ-Examples/packages/slg/docs/authoritative-read-acceptance.md)。


2026-09-17 本轮主工程verify:quick完整运行：30项通过、1项verify:no-local-traces失败，命中既有tools/ai-assistants/check.mjs:38的本地盘符检测正则；本轮没有修改/豁免该工具。cargo fmt/clippy/test通过，不能据此称完整门禁已通过。

2026-09-17 SLG驻留与前台恢复已实现：默认最后请求后5分钟保留已确认玩家内存，命中不Load；回收不删除离线任务，启动扫描恢复截止Timer；独立receipt不被战报覆盖；玩家独立互斥，地图变化才原子写玩家+世界。仍是32玩家、单世界无鉴权Demo，不是正式PlayerHost。配置在模块model/residency.json，属于Model构建期输入，改后重建重启。29条针对性测试、2条恢复工具计划测试和无DB真实WebSocket断开11秒重连通过；旧数据库强杀报告不能充当本轮验收。详见[实现/配置/测试边界](../../../TiangZ-Examples/packages/slg/docs/player-residency-and-foreground.md)。Model配置不得逃出modelRoots；不要覆盖基类私有timers字段。假基类测试不能代替真实模块check/build。

2026-09-17 新增DBProxy按精确namespace选择权威PG读取，默认缓存语义未改；game复测配置启用player，SLG配置源码启用玩家/世界namespace，尚未部署运行镜像。真实TCP旧/负缓存与PG阻塞回归三轮通过，保活及最终保存顺序22项相关测试通过。完整登录耗时、SLG新镜像恢复仍待验收；不能称全局缓存旧读已修复。升级/命令/证据见[权威恢复读取](../../../TiangZ-DBProxy/docs/authoritative-recovery-reads.md)。

2026-09-17 PG性能先结合资源/参数做并发阶梯，寻找工作区间；不把max_connections当最佳并发，不用过载档位代表正常延迟。多区服共享PG须汇总活动连接预算。见[登录容量方法与待完成端到端步骤](../../../TiangZ-DBProxy/docs/login-capacity-method.md)。保活存储边界新增3项控制流回归；完整登录时延仍未测量。

2026-09-17 登录性能必须区分保活Actor复用与存储冷加载。保活复用不应重读角色快照；不要把鉴权/账号查询混为角色恢复。已完成24场景存储阶段对比，见[登录存储首轮基线](../../../TiangZ-DBProxy/docs/login-storage-comparison-20260917.md)，不代表完整登录性能。

2026-09-17 缓存旧读已在隔离PG/Redis连续16轮复现，用户要求提前结束30分钟计划；服务代码尚未修复。见[本机复现与代码分析](../../../TiangZ-DBProxy/docs/old-cache-reproduction-20260917.md)。不要继续宣称仅有静态推测，也不要称已完成30分钟或TCP端到端验收。

SLG新增小规模真实存储强杀脚本，入口 Examples `reliability -- plan --suite slg`，保留原MMORPG game且不随all加入；隔离环境不复用开发数据库，详见[恢复测试](../../../TiangZ-Examples/packages/slg/docs/recovery-test.md)。PG初始化socket就绪不等于TCP就绪，容器健康检查需匹配消费者使用的TCP；本轮第一次隔离启动因该夹具问题失败，不能算游戏恢复失败或通过。最终结果读取实际report。

2026-09-17 SLG恢复验收：修复夹具后两轮各7项通过、共16次强杀，最终报告 Examples/packages/slg/temp/recovery/run-iaAz8o/report.json；真实SQL对账和清理通过，演练卷保留且容器停止。最终控制器哈希已核对。只证明单场景3玩家关键崩溃边界，不证明独立PlayerHost、数据库自身故障或500玩家长稳。后者等待用户另行安排。

AI 技能可复用规则入口：[技能开发约束](skill-development-contract.md)。涵盖模块归属、Timer/Update、同步语义、C/S 协议、数据库结果未知、原子热更与验收证据。源码已收进 tools/ai-assistants，Codex/Claude 便携技能已生成、工作区已同步，Cindy 0.2.0 已原位更新并真实调用验证32条规则；独立 Codex/Claude 客户端尚未运行验收。生成、换机和历史副本边界见 [三端交付说明](assistant-packages.md)。

2026-09-17 SLG 基础玩法已在 Examples/packages/slg 接入（建筑、生产、武将、行军）；仍为单场景 Demo，玩家/世界分记录原子提交，不是独立 PlayerHost。15 条单测及内存模式真实 RPC smoke 通过；真实 DB 崩溃恢复、新 UI 画面、联合演练未验收。见[玩法与复测](../../../TiangZ-Examples/packages/slg/docs/gameplay-demo.md)。**IsHostDbProxyAvailable 仅表示宿主桥存在，不表示进程配置了数据库或数据库可用**；持久模式依据进程配置，配置后故障必须失败，不可退回内存。首次 smoke 因误判失败，修复并重建后通过。

2026-09-17 三类测试代码整理：Examples `npm run reliability` 默认仅计划，支持hotfix/dbproxy/game分组及独立build/check/run，详情见[入口说明](../../../TiangZ-Examples/tools/chaos/README.md)。已修正旧联合控制器的组合宿主/探针SDK路径和审计证据根，要求所有计划故障都覆盖，新增独立Gate/整组游戏进程强杀。此轮仅静态检查和纯工具单测；用户要求整理后等待指令，**未执行整理后的联合演练**。run会清理专用演练库/Redis，不能默认运行，更不能把上轮热更或历史DB报告算作当前三组通过。

后续遇到可复用的失败必须落到开发文档，不依赖聊天记忆；按现象、根因、正确做法、禁止绕过、复测和证据记录。详细操作见[失败教训与复测流程](business-development-manual.md#失败教训与复测流程)，2026-09-17已记录：

- **客户端C协议不能用于进程间Inner RPC**：即使请求字段一致，也要声明模块S协议并重新生成内部descriptor；使用`scene.scenes.call`不代表外部descriptor变成内部协议。访问校验正确拒绝不是框架Bug，不能放宽校验。
- DB断一次可能被SDK有界重试恢复；分别验证短断连恢复、持续不可达失败和丢ACK后幂等，不能假定一次断连必然业务失败。
- `/ready`成功不代表首份连接指标已经发布；有界等待基线，不删除断言或用固定睡眠掩盖时序。
- 网络错误提前返回跳过writer清理是真实框架缺陷；保留失败现场，重建后验证关闭、连接数和正常请求。
- 历史通过结果只对应报告中的二进制和覆盖范围；完整回归重新构建后，最终负载/故障测试须对齐最终制品。24小时尚未执行。

2026-09-17 故障补测：`test:hotfix-faults`纳入完整回归，覆盖双进程、500请求排队、内部暂存满及断线/停机；可选真实DB通过独立回环代理注入迟回包/断连，不停现有容器。测试记录保留在唯一namespace，命令与证据见[故障验收](../design/hotfix-fault-acceptance-20260917.md)。用户明确24小时暂不执行，另行安排；基础设施可靠性优先于玩法。

2026-09-17 网络错误收尾修复：Tokio网络后端TCP/WebSocket读取或校验失败也必须移除writer、通知断线并回收发送任务；坏连接不等待发送排空，正常关闭保留排空语义。故障矩阵检查非法帧连接关闭与连接数回落。Rust修改需重建并重启，旧二进制长稳结果不能代替修复后验证。

2026-09-17 主动暂停热更的测试证据、超时口径和换机复测命令见[本轮验收记录](../design/hotfix-pause-acceptance-20260917.md)。以记录中的已完成结果为准，不把24小时计划当作已通过。

热更主动短窗口：候选独立线程预检后暂停新业务入口，已有任务/宿主完成通知继续推进，Timer和固定帧暂缓；默认3000ms，留最多100ms提交余量，超时或128条内部请求暂存满则恢复旧版本。Hotfix/config整体提交/回滚；不改RPC超时，不保证客户端超时能取消服务器执行，不引入多generation。需重建Rust/Model并重启；持续负载复测用 `tools/hotfix_load_soak.mjs`，报告保留在本轮temp目录，详见热更设计。不要将脚本支持24小时说成已经验收。

2026-09-17 延迟开发范式已补充：开始/到期/取消/恢复分开，Model 保存任务状态，Hotfix 登记所有者 Timer 并立即返回。插件错误处 `Ctrl+.` 可打开离线指南或生成未保存骨架；不改原代码、不自动迁移扣费/持久化，TODO 结算必须人工完成。维护时同步插件 `extension/guides/`，详见[延迟业务开发范式](../patterns/timer-update-and-action.md#延迟业务开发范式)。

2026-09-17 硬约束：游戏业务严禁 await 时间，包括 sleep/delay、TimerSystem.WaitAsync、原生计时器和定时器 Promise 包装；任何时长的延迟、到期、周期触发必须通过所有者 Timer 与方法名回调。数据库/RPC/锁等结果等待仍允许，不能据此声称在途异步已消失。Developer Tools 与模块构建共同报告 `tiangz.timer.time-wait-forbidden` 错误，规则、例外与换机要求见[时间调度模式](../patterns/timer-update-and-action.md)。

> 2026-09-17：Hotfix 与 Luban 配置改为完整配对发布、帧间原子提交。`build:hotfix` / `build:game-config` 均输出联合候选；`reload` 和本机 `hotfix plan/apply/status/rollback` 操作整套，`reload-config` 仅作联合加载别名。Hotfix manifest 包含 gameConfigHash/releaseId，配置单改也改变 bundleVersion。现有 pendingAsync/pendingIngress 安全条件保留；等待期间仍推进主循环。Model/schema/冷数据变化仍重启，客户端和持久业务状态不随发布回滚。旧的两条独立在线切换说明已被取代；首次使用须重建宿主与 Model 并重启。详细流程以 docs/design/typescript-hot-reload.md 的联合发布章节为准。

Examples/packages/slg 提供平台无关 delivery check/local/container 与 --plan/--ci：复用正式检查、构建和战斗验收，容器状态单独放在本轮 temp 子目录，不接管手动练习。制品记录本地 image ID，失败保留现场，生产发布未开放；跨机器/自建 Git 接续见该包 docs/delivery-handoff.md。不要将本地制品记录当成远端 registry digest、签名或完整可复现发布。

SLG 发布目标为公共登录、独立区服与独立战斗服务，区服不绑定战斗池。Examples 战斗案例新增 realmId + battleId 任务身份、逻辑/配置双版本准入与调度、执行端二次检查；能力随 Model 制品冻结，不由环境变量冒充。无兼容节点的新请求 unavailable，不入账；已受理任务不降级。范围仅有界可信实验，非鉴权/持久结算或完整发布平台。协议须重新生成、重建重启；旧 K8s 镜像报告不能代表新版通过。设计及验收范围见 Examples/packages/slg/docs/battle-release-routing.md。

Kubernetes 学习适配位于 Examples/packages/slg/validation/battle/k8s：独立 kind、Linux Native 组合镜像、单管理器、编号执行 Pod、受控排空后缩容与 preStop。只属于部署案例，不进入 Core；注册追加内网 IPv4，协议/SDK 由正式生成器维护。无 HPA、故障恢复或持久结算；实际验证结果以 Examples 的练习报告为准，不能把容器/集群启动等同于业务验收。

本地副本数控制验证：tools/local_replica_controller.mjs 只拥有期望数量、有界串行启动、退避、排空确认和停止回调，不内置战斗或地图语义。SLG 的独立案例在 Examples/packages/slg/validation/battle，真实 Manager + 多个 Host，TS Handler 委托 Rust 固定工作线程，队列驱动 2→3，排空/空闲缩到 2。它是有界内存验证，不是生产控制平面、持久结算或 Kubernetes 实现。SLG 未来可有副本机制，不能把动态副本抽象写死为 MMORPG 专属。

模块/工程脚手架支持 --with-rust，生成无状态 Rust 加法壳及 TS NativeExample 桥；模板和确定性流程属于宿主，Developer Tools 只提供选项。入门工程 setup/check/host-build/build/start/smoke 支持 Native 组合；doctor/start/smoke 核验组合身份，不回退普通宿主。dev 自动监听仍拒绝 Native；Rust/Native/Model 变化须完整构建重启。参见[模块入门](../tutorials/module-starter.md)。

持久 ID 增加显式 identity.allocation=dbproxy：启动先领取持久 CAS 号段，再创建 Scene；Next 仍同步，本地耗尽时失败不降级。旧省略配置保留 local-development 并告警，不能当作生产唯一性保障。来源编号不作为当前区服路由。切换/高水位不可回退等约束见[ID 号段](../design/global-id-ranges.md)；本轮没有改变现有部署或实现玩家归属业务。

租户/合服边界见 [边界与准入](../design/tenant-realm-foundation.md)：DBProxy --tenants 认证绑定独立后端；区服计划只读。计划格式 v2 以 realmGeneration 表示逻辑服代次，模块策略通过显式 --policy 纯 JSON 声明；宿主不解释领域动作，不默认重建地图。SLG 的地块重新争夺仅是模块侧设计声明，不是已实现的 Demo 合服业务。正式写屏障、迁移和结算尚未实现。

SLG 已从独立目录迁入 TiangZ-Examples/packages/slg。Examples 按包操作：npm run build/check/start/smoke -- --package slg|mmorpg；输出在 packages/<name>/dist，不隐式装配其他示例。MMORPG 可复用模块与客户端仍在 Examples 根 modules/clients。模块目录联接通过真实源码根计算生成路径与编辑器 paths，安装深度不改变模块内容；installedRoot 仅保留安装位置识别。

本节优先于下文历史示例的旧路径：TiangZ 不再内置 MMORPG/Bench，默认宿主为 modules，显式 demo 模式报错。MMORPG 的 Model、Hotfix、协议锁、Luban、Native 游戏存储/规则和公开 API 在同级 TiangZ-Examples/modules/mmorpg；Bench 在 modules/bench，六个客户端在 clients。

宿主 app/model/public.ts 不导出游戏类型。ModuleGame 与 WoW335 通过直接模块依赖和 #tiangz/modules/org.tiangz.mmorpg 消费；SLG 不依赖 MMORPG。模块 System 声明和 bootstrap 生成在模块内，通用 domains 中未装配的契约不要求空宿主有游戏 System。

进程初始化与具名指标采样由 processServices 提供，Native 资源根由 configureProjectRoot 显式接入；宿主不认识游戏表、地图或 op。配置 validator 在提交前检查候选/上一版冻结表，冷表策略归模块。Native 编译缓存共享，组合二进制分开发布并校验哈希。Model/Native/协议变化仍须重建重启。

Demo 部署配置、示例运维资产和游戏测试在 Examples；旧固定拓扑脚本在 legacy，仅用于历史回溯。框架 quick 与 Examples 的 test/verify:server-assets 分开，联合覆盖率保留原门槛。入口见 [拆分说明](../design/example-extraction.md) 与 [当前命令](../reference/commands.md)。

---

# TiangZ AI 项目上下文

控制入站默认额度的首次真实 Process 故障场景因夹具解析失败：既有 29998/6 字节过载信封中 rpcId 是 **LE**，新驱动误用 BE，将实际 69632 读成 1048832，报 unknown response。`temp/hotfix-load-yYtUnM/fault-report.json` 保留失败、两宿主 exit 0/无强制停止；来源日志明确拒绝 69632。应按 `build_target_ingress_overload/parse_target_ingress_overload` 修夹具，不改线上格式或去掉关联验证；原 full 不计通过，重新执行完整含 KCP verify。

控制确认 TS 第二轮 **2 failed / 40 passed**（724ms，`temp/v0.7-control-ingress-ts-second.log`）剩余为新夹具错误：混合 control/data 忽略既有公平顺序，直接调用 Scene 内部 dispose 又绕过 Host 的 Root 注销。应按原顺序断言并使用 `ProcessHost.despawnScene`；不能修改生产公平调度或忽略实体泄漏检查来迁就夹具。四文件复测与完整矩阵仍必需。

控制确认第一轮 TS 回归 **12 failed / 30 passed**（818ms，`temp/v0.7-control-ingress-ts-initial.log`）：实现误从 SceneCallContext 的不存在 `processHost` 字段释放，连带中断销毁。EntryScene 已保存原 `private readonly processHost`，应使用该所有者；不是旧框架容量反例，也不能用可选调用吞掉失败。相关四文件原样复测，确认关闭/销毁/迟到回调与原 mailbox 生命周期恢复。

控制桥初次 Native 编译失败于 `#[op2]` 参数使用 `deno_core::OpState` 完整路径，宏明确要求导入后写 `OpState`（`temp/v0.7-control-ingress-native-initial.log`）。这是桥接宏形状错误，尚未执行测试；应遵循当前锁定宏的诊断修正，不删除状态参数或跳过实际 V8 检验。复测 `node tools/run_cargo.mjs test --bin TiangZ --features kcp control_ingress -- --nocapture`。

控制入站总量反例：隔离 Node 使用真实 ProcessRuntime/EntryScene，阻塞 ordered 断线钩子后每轮注入 128 条，520 轮保留 **66560** 条；放行后 130 轮排空、执行 66561 次钩子。`temp/v0.7-control-ingress-audit.json` 与 `node temp/v0.7-control-ingress-probe.mjs` 只证明 TS 队列没有累计上限，未创建网络连接或 Session。按[控制入站契约](../design/v0.7-control-ingress.md)将 Rust 准入所有权保留至 TS 实际开始/丢弃未执行节点；不能丢 Disconnect、关闭完成通道或把单轮 128 条当作共享总量，也不能把这一数量限制称为 TS 堆内存预算。

验证时不能用预构建哈希替代实际运行身份：原矩阵 quick 的无 features Cargo 步骤会覆盖预构建的 KCP 宿主，之后 full 测到的是默认 feature。显式 Rust/KCP/UDP 通过与默认 full 通过分别报告，原热更 JSON 已记录真实 SHA。现用 `TIANGZ_VERIFY_CARGO_FEATURES=kcp` 贯穿嵌套矩阵，full 先构建，并在 quick 之后记录实际 Host 哈希；不靠额外手动构建或修改旧报告伪装原轮包含 KCP。原证据、哈希更正与复测见[进度](../design/v0.7-progress.md)。

0.7 KCP 使用独立 `maxKcpBufferedBytes`（默认 64 MiB、1..1 GiB），全部 KCP listener 共享，各 Session 另限 4 MiB。预留 C 控制块/工作区、段上界、保留 ACK 容量及输出 Bytes，扩容前保守准入，纯 ACK 在满额度时仍可归还，最后输出引用释放才退额度。额度不足/输出 callback 失败只终结该 Session，不能只记日志或依赖 C 忽略的 callback 返回值。一个 datagram 可让 ACK 数组连续扩容，须计最后中间数组与新数组同时存活的峰值，不只是调用前容量。接收/UDP 封包副本、Rust 容器、系统和 V8 另有边界；配置、Rust 包装器接口变化与验收见[KCP 预算](../design/v0.7-kcp-buffers.md)。

0.7 已解码 Rust 入站帧独立使用 `maxIngressBufferedBytes`（默认 64 MiB、1..1 GiB）。所有业务 listener 的控制 RPC 与数据帧共享，首次入队前接管 Bytes、不复制 payload，排队重试/取消/热更延后均保持同一预留，最后引用释放才归还；超限 Inner RPC 返回既有入口过载，外部/单向来源关闭，控制通知不占本项帧额度。固定 kind=ingress 指标不混作慢客户端。解码器、Host 打包副本、V8/TS mailbox、RPC completion 与 KCP 可靠缓存另算，不称为全进程内存上限。契约与证据见[入站预算](../design/v0.7-ingress-buffers.md)。

入站实测首轮的两个夹具问题已保留：误用不存在的 EndpointTask.stop/wait 导致编译失败；随后给真实 Inner Socket 发了外部 msgcode，访问校验正确拒绝，预算尚未入队。应先读真实生命周期 API（request_stop + await），传输专用夹具使用 Inner 保留范围并单独检查 RPC 标识；禁止新增空转接口、关闭协议检查或仅延长等待。原记录 temp/v0.7-ingress-first.log、v0.7-ingress-focused.log；修正后定向和全目标验证见入站预算文档。

2026-09-16 示例拆分已扩展为服务端、客户端与消费者的模块边界迁移；当前目录和命令见文首说明。

2026-09-16 桥接提前检查收窄到唯一、直接的顶层 Core defineGameModule 登记；不遍历未调用函数猜执行结果。宽泛字典、联合导出形状及动态/多处登记保留运行时校验，不能把静态预检通过当作完整装配已验证。

2026-09-16 持续诊断契约：dev_runtime 在初始构建与 Hotfix 类型/Bundle 检查前后输出 [tiangz-dev-check] begin/end，finally 保证失败也结束轮次；仅配置更新不清除未重检的 TS 诊断。插件持续匹配器复用原错误模式，检查结束不是 Runtime 就绪或自动调试附加信号。

2026-09-16 插件工程类型边界：根目录 tiangz.project.json 存在时，旧 app/ 索引不检查独立模块；工程树明确转向宿主模块导航和 check，避免配置误报及错误启动入口。旧检查 CLI、生成任务和 Component 脚手架拒绝该工程类型。0.7 配套候选另通过 Host worker 接入模块实时 Program 检查；联接真实路径、跨盘诊断、过期回复与进程回收见[实时检查](../design/v0.7-module-live-checks.md)。不能以旧任务 Problems 定位代替该验收。

2026-09-16 诊断身份补充：Hotfix 类边界与模块桥接检查使用当前宿主 Core 声明来源，不仅按 systemFor/rpcHandler/defineGameModule 等名字判断；同名业务函数不能触发框架诊断。别名与命名空间导入仍通过 TypeScript 符号解析识别，反例已加入回归。

2026-09-16 取消与持续开发：SDK BrowserWebSocketTransport 在握手期间即持有 socket，关闭立即拒绝待决 connect，旧 socket 回调不能影响重试。修改仅在 SDK 源码，通过正式 codegen 分发。模块 watcher 按稳定源码内容而非 mtime 决定重启，发布候选前等待待决检查，文件声明监听父目录以适配编辑器原子保存。教学 request 使用生成 SDK 请求已有本机服务，会修改 count，但不构建、不写 dist、不启动或停止服务器。

2026-09-16 模块开发工具补充：create_module_component 提供 Model/Hotfix 配套创建、四文件预览和 planHash；只改明确字面量装配，拒绝覆盖/生成目录/链接，沿用工程锁。组件所有者和 AddComponent 留给业务，不自动写 publicApi。常规失败回滚不等于崩溃原子事务。modules:typecheck --json 输出版本化文件/行列/错误码，复用 Hotfix 边界规则，并提前报告桥接漏导出；插件只呈现诊断和执行宿主预览，不复制 AST 改写。

2026-09-16 模块源码循环：dev_runtime --project 与默认 demo 共用监听、候选构建与 Watcher 发布状态机。模块模式复用 game_project_build 的准备/构建、使用已有宿主二进制与明确 runtime-root，不做 Cargo；原 Native 组合仍明确拒绝。构建结果增加 formatVersion 1 JSON 标记，候选路径必须位于当前 dist 的不可变候选目录，支持空格。Model/协议/模块声明/启动配置变化要求重启；退出关闭监听与 stdin 并释放锁。test:game-project-dev 已实际验证状态保留、错误候选拒绝与停机。

2026-09-16 TS 模块新手工程：project:create 生成不含 SLG 的计数器模块、模块自有协议/SDK、启动配置和分步指南；game_project.mjs 统一 doctor/setup/check/build/host-build/start/smoke/inspect/protocol-update。tiangz.project.json 只记录开发路径，Runtime 配置未变。日常 build 不做 Cargo，互斥锁防止并行覆盖；协议锁只在创建新协议或显式 protocol-update 时生成/更新。test:game-project 覆盖真实两次 RPC 与正常停机。此 TS 开发入口已复用通用 Watcher，但 Native 组合仍未集成，不得误称完整生产工程。

2026-09-16 开发工具分工：Runtime 只拥有运行语义，TiangZ tools 提供可从 CLI/CI 独立调用的模板、构建、检查和结构解析，Developer Tools 插件负责向导、导航和错误呈现。`modules:inspect -- --modules-dir <目录> --json` 复用模块目录校验，输出 formatVersion 1 的只读导航与从 1 开始的位置。静态可达提示不等于完整调用图、类型检查或热更许可；不得让插件另写一套兼容判断，也不执行模块源码进行导航。

2026-09-15 当前目标校正：完善 TiangZ 与通用模块开发流程，SLG 仅作接入样例，不继续扩展玩法。本轮新增显式 `--host-profile modules`：共享 Core ProcessBootstrap，省去默认 MMORPG TS 装配与表数据；demo 默认保持兼容。脚手架/prepare/typecheck/build 对齐 Core-only Model 导出，构建检测实际输入并拒绝示例依赖；模式写入 Model/Hotfix 清单与指纹，切换必须重建重启。配置沿用 Rust 校验信封与 ModuleConfigRegistry。Rust 内置 Native ops/指纹仍保留，不等于物理二进制裁剪。详见外置模块文档；test:module-host 使用框架自有中立夹具验收。

2026-09-15 SLG 精简：模块 protocol.generateGodot 可显式设 false，仅生成服务端与 TypeScript SDK；省略时保留原双 SDK 行为，关闭不删除既有输出。SLG dev 只做服务端检查、Bundle/配置构建与启动，不调用 Cargo 或全量客户端检查；setup/build 生成后不重复运行协议生成检查。首次、Rust/Native 改动或宿主升级仍需完整 build。宿主版本检查不替代同版本源码重建；MMORPG 默认装配仍未拆除。

2026-09-15 SLG 开发环境补充：前端选择已安装的 Creator 3.8.8，启动器从 Dashboard 配置定位版本，完整客户端类型检查使用编辑器生成声明。SLG 的独立 Compose 包含 DBProxy/PostgreSQL/Redis，数据卷与凭据不复用其他游戏；游戏进程只获得认证令牌，通过本机 18700 访问 DBProxy。数据库环境接通不代表玩家/行军持久化业务已实现，部署入口见 TiangZ-SLG/infra/dbproxy/README.md。

2026-09-15 SLG 独立接入：同级 `TiangZ-SLG` 使用外置 `org.tiangz.slg` 模块与 Cocos Creator TypeScript 前端，构建到游戏自己的 dist，以显式 runtime-root 启动，不改 Core 或复用其他游戏数据。当前仅只读世界快照联调，尚无玩家、行军或持久化；游戏开发入口和验收边界见该工作区 README。开发体验优先，不能把底座检查通过表述为完整玩法或 Cocos 画面已验收。

模块 Hotfix 命名值导入还会通过 `modules:typecheck` 与入口 `modelExports` 对照，提前定位漏登记；间接注册和动态访问仍依赖运行时校验。

2026-09-15 模块开发工具修复：模块协议 source/opcodeLock/schemaLock 按 manifest 传递；生成先暂存并全局检查 opcode，再发布输出和锁，异常回滚；`--check` 只比较、不修复产物。生成目录不能覆盖源码根、模块入口和手写协议目录文件。`modules:prepare` 同步编辑器 paths 与宿主声明，使普通 TypeScript 识别直接依赖 API；模块 Luban 工程目录已加入 dev 监听并过滤配置输出。回滚不等同于跨进程崩溃事务，生成命令仍需串行执行。详细使用见外置模块文档。

2026-09-15 主线整合：模块化协议、SDK、Native 和后续地图/领域能力统一维护于 TiangZ。模块类型检查的 Stable API 与生成方法声明必须来自同一个当前宿主；`typecheck_game_modules.mjs` 使用当前宿主的 systems 声明，排除 tsconfig 指向旧宿主的同类声明，并保留模块自己的类型声明。切换 worktree 不应要求游戏改写业务类型来掩盖宿主身份混用。合并范围和实际验收见 `docs/design/mainline-integration-20260915.md`。

2026-09-14 连接出站队列以 `ConnectionQueueError` 区分字节上限、帧上限、批队列满与接收端关闭。失败撤销本批计数；`flush_outbound` 清理两类失败连接，但只有容量拒绝计入 `slow_client_disconnects` 并发出慢连接警告。接收端关闭仅为 debug 清理记录，不能据普通客户端退出推断容量不足。队列容量、关闭信号、事件/状态投递语义不变。

2026-09-13 Native 组合构建在编译前检查 Cargo 已解析依赖图：模块及其正常依赖使用的 deno_core 必须与宿主是同一 crate 身份；相同版本但不同来源也不能混用。失败报告模块 ID 与双方版本，不自动改写模块 Cargo.toml 或锁。测试模板从宿主 Cargo metadata 获取依赖要求，避免依赖升级后仍固定旧 Deno 版本。

2026-09-13 启动可用 `--runtime-root=<目录>` 明确选择包含 `dist/` 和 `configs/` 的资源目录；路径无效立即拒绝，不回退其他工程。未指定时保留工作目录、可执行文件祖先、开发目录的既有推断顺序。启动日志记录实际资源根目录，Watcher 子进程继承确定目录。独立游戏和候选包验收应明确指定目录并核对 Bundle 版本；此选项不跳过模块、Native、协议或 Hotfix 兼容检查。

2026-09-11 玩家交易模块接入：`PlayerTradeComponent.GetSnapshot` 返回调用者的临时会话快照；`PlayerTradeEvents.BeforeCommit` 在双方玩家邮箱内、首次持久化载荷冻结前同步只读校验最终计划。模块可检查背包容量、穿戴状态和资源来源，不得在监听器中写库或修改实体。已冻结载荷的回执恢复不重复准入。计划失败且尚未冻结载荷时必须清理会话，避免永久停在 Committing。荒原目前只接物品交易；其进度记录金币尚未统一为通用钱包，禁止金币报价。详见玩家交易设计和 ModuleGame 的 `docs/player-trade.md`。

2026-09-10 迁移源端存档保护：MapHost 在 Location 提交成功、安排延迟销毁时立即调用 PlayerPersistenceComponent.RetireTransferredSource。源 Actor 的排队定时存档/离线保存不再写库，业务事务拒绝；标记不进入 Transfer，目标仍可保存。不能仅依赖下一帧销毁来避免旧源快照与新宿主的 revision 冲突。

2026-09-10 任务目标纯计算入口 `AdvanceQuestState` 位于 `app/model/domains/quest`，通过 Model Stable 入口导出；在线 `Quest.Advance` 和外置模块离线 outbox 消费可共用。它仅对已接任务计算新快照，保留输入不变、目标上限和多目标完成条件，不执行数据库、NPC 判定或奖励。调用者先原子提交 inbox 与新快照，再发布在线投影；任务接取实例身份和旧事件兼容规则由模块拥有，不把运行时 Entity.InstanceId 当作持久任务身份。

2026-09-10 公共分线改造的完整 `npm run verify` 已通过：full 11/11、quick 25/25、check 15/15，TypeScript 单元测试 146 项通过。新增 `test:public-maps` 纳入 full，以三个真实进程和五个客户端覆盖分线、跨宿主迁移、满线回退、绕过准入拒绝及重连原线。首次验证的 MSYS GCC/MSVC 环境冲突仅在验证子进程中清理 CC/CXX 后重跑解决；未变更系统环境。游戏接入与生产容量仍按下述边界单独验收。

2026-09-10 公共地图分线位于 MMORPG 地图领域，详见[公共分线契约](../design/public-map-channels.md)。MapManager 配置模板人数/最低线数/回收时间，MapHost 配置实例和角色预算；两个 EntryScene 的构造边界支持模块 `entityExtensionHandler`。运行时分线复用 MapScene/Location 动态实例链，以 assignment 的 channelId 区分公共分线和私人副本。预留及最终准入归目标宿主，Prepare 玩家也占位；管理器恢复期 15 秒，预留 30 秒。客户端统一使用 Gate.EnterPublicMap/ListPublicMaps，保留 Gate 角色事务、迁移屏障和路由更新，不从玩家组件直接转图替代该链。自动启动进程、容量压测、整队原子预约和 ModuleGame 的真实 MapScene 迁移尚需后续推进；当前隔离模块验收不能代替游戏接入。

2026-09-10 独立 Godot 接入验收发现并修复 SDK 对示例全局 `TzProtoReader` 的隐式依赖。读取器唯一源码现在位于 `client_sdk/godot/proto_reader.gd`，生成器将其嵌入宿主及各模块协议类的局部 `ProtoReader`，单个生成 `.gd` 可在无示例文件、无编辑器 class 缓存的工程直接加载。旧示例 `TzProtoReader` 仅作继承兼容。设置 `GODOT_BIN` 后，模块协议自测会实际运行干净 Godot 工程，覆盖双 SDK 共存、Unicode、RPC 和读取游标隔离；未配置 Godot 时明确报告实跑跳过。

模块版本部署：`release:package` 根据已安装模块选择普通或组合 Native 二进制，校验 Model/Hotfix/配置的模块图与指纹，生成带内容身份的独立制品目录，冒烟成功后才发布目录；已有同身份制品拒绝覆盖。Native 发布包含组合 Cargo.lock 和二进制校验记录。`--debug` 仅用于开发制品验收。源码编译失败不会覆盖旧 Model；版本切换仍由部署方执行优雅重启，旧数据版本的写入由 Repository 读前检查与 CAS 拒绝。

模块扩展推进：`publicApi` 声明模块 Model 公开入口，消费者通过 `#tiangz/modules/<id>` 引入直接依赖；Hotfix 绑定封闭的公共 Model 引用。`gameConfig.client` 使用独立 Luban target 导出客户端内容，模块 schema 进入 Model 指纹。模块配置随现有配置候选携带，Rust 校验 `moduleConfigsJson/moduleConfigsHash`，Model 中的 Luban schema 预检全部模块后统一发布 `ModuleConfigRegistry` 快照。未知所有者、schema 变化及模块增删必须重建重启。`VersionedEntityCodec.migrations` 声明相邻版本迁移，Repository 在读取时按 revision CAS 保存升级结果，冲突重新读取，未知版本拒绝。`native` 声明独立源码、crate 和生成目录，独立 Cargo 组合构建使用模块命名空间及 Native/Model 身份检查。工作范围和验收状态见[模块化推进](../design/module-completion-plan.md)。游戏仅作消费方验证，当前暂停游戏功能开发。

2026-09-09 模块自有协议链路已接入：外置模块可在 `tiangz.module.json.protocol` 声明 Proto 源目录、opcode/schema 锁、服务端 Model 输出、TypeScript SDK 输出和 Godot 输出。`codegen:module-protocol` 使用宿主固定生成器逐模块生成，锁文件参与模块图与 Model 指纹；更新锁必须显式使用 `--update-locks`，默认构建和 `--check` 均不改锁。模块 opcode 会与宿主及其他模块做全局冲突校验。服务端生成描述符留在模块 Model 根，由虚拟 Model 组合入口注册到 Core 路由；宿主不会把模块字段写入 `app/core` 或宿主协议生成目录。模块删除、Proto/锁/Model 变化仍需完整构建并重启，生成的 SDK 和协议文件不得手工维护。

2026-09-09 登录摘要在鉴权通过后通过既有PlayerRepository读取各目录角色的持久成长等级，不写回账号目录；无成长记录保留创建等级，身份不匹配、非法等级或存储失败拒绝返回过期成功。LoginComponent新增可选仓库依赖，LoginScene通过同一仓库工厂提供；Model变更必须生成、构建并重启。中立回归见 `tests/unit/login_summary_level.test.ts`。

2026-09-08 DamagePrevented 是已确定否决后的同步事实，可追加领域副作用；DamageResolved 仍只表示实际扣血/吸收。ShortenAutoAttackSwing 仅缩短当前活动挥击，不激活闲置攻击或改变目标。否决监听器继续保持只读，游戏招架/格挡规则留模块。

2026-09-08 Combat 可登记同一目标拥有的 DamageCalculator 组件。否决通过后读取其当前方法计算金额与 critical，再执行目标乘数、吸收器和单次扣血；非法金额或失效拥有者在扣血前拒绝。模块计算方法不得产生结算副作用。周期伤害由 Buff 来源显式标记，G2C_CombatResult 新增可选 critical；公式与数据不进入宿主。Model/协议变更需生成、完整构建与重启。

2026-09-08 公开玩家 displayName 来自 Login 选中的角色目录项，经 Demo 令牌、Gate 长期路由、内部入图及迁移快照传递到 PlayerUnit。公开 AOI 快照不得用账号覆盖角色名。旧令牌及缺失可选字段的内部快照回退到账号；Demo 令牌仍不是生产认证方案。内部协议新增可选字段，必须显式更新锁、生成、完整构建和重启。

2026-09-08 MMORPG 的 `Map.InvokeUnitAction` 为外置玩法提供有界命名空间信封，经既有玩家 ActorLocation / ordered mailbox 路由，转图期间拒绝。`UnitActionComponent` 只登记同一玩家拥有的存活组件，按调用时的组件方法执行，禁止重复命名空间及跨拥有者登记；请求与响应分别上限64KiB。业务 schema、授权、幂等和持久化仍属于模块，信封不保证 exactly-once。不新增 Core 运行时分发器或绕开原有 Actor 路由。协议已显式更新生成锁，部署必须完整构建、重启。

2026-09-08 归属单位资源同步：Map 的共享 AOI 快照缓存保持公开；玩家进入时单独替换自己及自己召唤单位的私有快照。AOI Enter 先拆分拥有者与其他观察者受众，再构造快照，避免共享缓存泄漏。Summon 使用现有思考桶检测当前资源与上限，变化时通过 `PublishOwnedUnitResources` 的逻辑 Self 受众及既有 EntityNumeric/latest 描述符发送，未成功发布会重试。非玩家所有者和不在拥有者视野内的单位不产生私有玩家通知。公开 Numeric 白名单、协议和 Native schema 均未扩大；Model 修改须生成、完整构建并重启进程。

2026-09-08 成长事务修复：等级档位数值仅在 `result.level > currentLevel` 时应用。同级经验增加保留在线生命/资源；已提交回执重放不能再次套用等级初始值，覆盖提交后的消耗。规划持久快照与提交后协调必须使用同一条件。中立测试见 `tests/unit/progression_resource_preservation.test.ts`；协议、Model和Native schema不变。

2026-09-08 移动停止同步：`NativeData.ResetMovement` 在停止活动移动时保留一次待输出状态，Grid2D 使用既有 dirty 标记，NavMesh 使用既有批量移动记录。下一固定 Tick 输出最终位置与 stopped 状态；同 Tick 重复 reset 保留待发通知，之后空闲 reset 不重复发布。移动仍归 Rust 持有，没有新增 schema、op 或协议；Rust 修改必须重建并重启。

同日真实多角色验收发现旧奖励操作号按账号隔离，导致同账号第二角色的同任务事务冲突。新奖励使用 `quest-reward:v2:<CharacterId>:<QuestId>`；只有本地已完成任务的旧角色才能回退查询原账号键回执，活动任务不得复用账号键。跨角色隔离必须用同账号双角色验证。

2026-09-08：任务奖励可通过 `QuestEvents.BeforeReward` 同步登记有界、不透明的模块投递消息，与奖励一起写入 quest 领域；`PendingRewardDeliveries` / `AcknowledgeRewardDelivery` 在玩家 ordered mailbox 中消费和确认。模块必须在目标端用消息 ID 做持久化幂等；离线队列在重登/迁移后继续，未提供离线后台投递保证。旧快照和原 protobuf 奖励回执可读，新增 Model 状态必须构建并重启。中立验证样本为 `org.example.reward-counter`，不把外部游戏规则放入 Core。Rust `/runtime-identity` 返回启动时加载的数据包 ID、owner 和文件 SHA-256，不暴露文件路径或内容；数据包变更仍需重启。

**当前验收状态（2026-09-07）：r6 已通过。** 在独立 NVMe PG 路径下，DBProxy `0114af0` / TiangZ `d7af251` 完成 100 游戏玩家 + 100 持久化玩家、30 分钟、五次故障恢复及 SQL/事件/交易最终对账，独立审计通过。206,742 次读取无旧读、缺失或不变量错误；3 次恢复登录重试及暂时存储错误保留。PG fsync、Redis WAITAOF、连接数和业务预算不变。机械盘 r4 失败仍有效，Windows 10055 的具体 OS 根因未确定，不能作无限性能保证。当前测试 PG 保持 NVMe，旧卷留存，完整结果见[交接入口](../testing/handoff-2026-09-07.md)。以下同日“未通过/待验证”为历史进展，以本段及最终报告为准。

最新 NVMe r5 在约第 19 分钟因负载进程 Windows 10055 建连错误中断，正常阶段检查未失败，但仍无完整验收。控制器现按轮次/地图启用探针既有 loopback 源地址隔离，记录 `game_probe_source`；仅测试工具变化，不改变业务传输或失败断言。旧 r4/r5 均保留为失败。

最新验收：r4 正常阶段仍在约第 21 分钟超时，完整验收未通过。已有缓存清理及批次提交修复不等于硬盘任意延迟下的 RPC 保证；当前以不改变产品、持久化和业务参数的独立 NVMe PG 路径对照继续定位，保留旧卷及失败证据，见[交接入口](../testing/handoff-2026-09-07.md)。

同日后续：DBProxy `SaveMulti` 的连接分片都指向同一 PG，现将批次按首记录路由到一条连接、一次提交，批内按记录排序、回执恢复原顺序；逐条 CAS/幂等与 CommitRecords 边界不变。清理修复首轮第 18 分钟健康检查失败；批次修复后的 r3 健康阶段通过，但约第 23 分钟 AOF 重启被控制器固定等待 10 秒误判为 BusyLoading，仍不能记作完整通过。AOF 控制器现复用 90 秒健康等待，仅等待正在恢复的 Redis（此时 PG 刻意停机）。上一轮及专项新一轮各 64 条已确认记录均恢复通过，完整验收仍须新轮次重跑。

2026-09-07 后续修复：相邻 DBProxy 服务端将提交后成功缓存的修复清理移到现有维护 worker；共享提示最多 1,024 个 key/revision、每批 128 个，复用维护连接。PG 事务与持久修复目标不变，提示丢失或满载由原修复恢复。业务接口、幂等键及超时不变；完整启动/故障验收待验证。指标边界变化见[尾延迟归因](../testing/latency-attribution.md)。

2026-09-07 换机续接：PG 故障排队 2 秒预算与重连失败冷却 500 ms 已实现；先读[交接入口](../testing/handoff-2026-09-07.md)，同步相邻 DBProxy 仓库。用户已授权本次修复后的 30 分钟验收，七天长稳需另行授权。

本文把长期对话中形成的架构世界观、关键决策、当前状态和暂缓事项固化到仓库中，帮助新的开发者或AI在缺少聊天记录时继续工作。它不是代码的替代品；如果本文与当前代码或测试冲突，以代码和测试为准，并在同一改动中修正文档。

维护契约：任何架构、目录边界、数据所有权、协议语义或业务开发流程的设计变更，都必须同时更新本文和[AI业务开发手册](business-development-manual.md)。设计改动未同步这两份文档，视为尚未完成。

仓库中的代码、文档和性能报告必须可跨机器使用：命令使用仓库相对路径或显式环境变量，性能报告写入前把仓库内绝对路径转换为相对路径。`npm run verify:no-local-traces`扫描Git候选文件并拒绝本机盘符、个人Home目录和私网IP；第三方Unity模板及Windows路径解析夹具只能使用精确文件级白名单，禁止扩大为目录级忽略。

更新时间：2026-09-05。

2026-09-07 缓存故障降级：DBProxy 新增 `storage.cacheOperationTimeoutMs`，默认 200 ms，分离于原 PG 回源 2,000 ms 预算。缓存失败仍保留事务内持久化修复，AOF/MQ 与业务超时不变；普通缓存的 TTL/SWR 不升级为强一致。本轮不修改 TiangZ/WoW335 业务或协议，实测结论必须使用新候选证据。

DBProxy 尾延迟诊断现区分 SDK 的 `connection_queue` 与 `connection_exchange`，保留原总耗时指标；exchange 包含网络与服务端处理，不能解释成 SQL 耗时。计时不改变超时、重试或持久化语义；下一轮需重建候选，不把旧演练当作新指标验收。范围与验证见[尾延迟归因](../testing/latency-attribution.md)。

存储侧进一步导出固定的 `dbproxy_storage_stage_seconds`：缓存读写、回源配额/同键/分布式租约、PG 连接等待/操作、提交后同步及修复 ACK。父子阶段不可相加；取消样本只表示截至取消的等待，不代表 SQL 停止或事务结果。沿用低频指标采集，不增加业务请求日志。

2026-09-07 换机续接：相邻 DBProxy 的请求分片新增独立 PG 连接排队预算与共享重连失败冷却，默认分别为 2,000 ms 和 500 ms。排队失败仍为 StorageUnavailable，TiangZ 必须保留原请求/operation ID 恢复；不能从某次 Store 操作未发送 SQL 推断整个业务请求未提交。缓存预算仍为 200 ms，PG 回源仍为 2 秒；协议、Host/Model/Hotfix 接线不变。精确与真实数据库回归已覆盖，游戏全链路演练仍待验证，见[尾延迟归因](../testing/latency-attribution.md)。

提交后验收更新：双仓库 release 和正常包已重建，30 分钟计划在 100 玩家启动健康检查失败，未进入故障注入/最终对账。短时冒烟有 PG 排队超时，正式启动现场则有 SDK 连接排队超过 5 秒与 Actor RPC 超时；本机机械盘同步成本较高，尚不能据此排除其他等待来源。不得把精确测试通过写成全链路验收通过，详见[续接状态](../testing/handoff-2026-09-07.md)。

## 2026-09 Location 恢复竞态与本机验证

重复 MapHost 故障下，Gate 的断线超时清理与主动退出必须区分：主动退出仍要求 Actor 保存成功或匹配离线回执；已断开的超时会话，只有原宿主明确返回 `ActorLocationNotFound`、离线回执查询正常但未完成且 UnitId 匹配、Location 按 CharacterId 确认无主，才回收孤立 Gate 路由，供后续登录从持久化状态恢复。这不代表崩溃前未确认的最终保存成功。任何网络/存储错误、Location 不可用、仍有权威实例或活连接均不能走此分支。Core 的缺失 Actor mailbox 统一使用已有错误码 1012，不通过解析错误文本判断。

Location 的 `RecoverOwner` 仅在首次认识 MapHost 代次（包括 Location 重启）或合法所有者换代时重建缺失路由。同代周期重报只能确认已有记录，不能将成功下线删除的 Actor 路由重新注册；新增玩家继续显式 `Register`。该规则在权威端判断，覆盖已经发送但迟到的恢复快照，不依赖 Timer 恰好先后执行，也不增加永久玩家墓碑。冲突批次必须先完整校验，重复 Unit/角色拒绝整批。

Rust 压测客户端在等待 Gate 登录回执前启动统一 Push 分发，RPC 截止时间不因推送续期。故障判定拆分基础设施恢复和原账号业务恢复；替换卡住账号不能算恢复。精确回归与低内存本机演练见[本机故障验证](../testing/local-fault-validation.md)。模型/运行时修复需重启部署；不热更 Model，不修改正在运行的远程七天版本。

## 通用提交本地集成

本地集成分支新增 DBProxy CommitRecords：快照 CAS、只追加事实、Outbox 和幂等回执一次提交。交易计划及金币平衡检查在 MMORPG Hotfix，通用 Host 不理解交易 payload。PlayerRepository 多记录请求可选带 effects，旧单记录与 WoW335 VersionedEntityRepository 保持原契约。当前只为在线玩家交易追加审计与事件，未新增持久托管状态机；DBProxy 旧 Trade API 暂留兼容。相邻 DBProxy 的本地 npm/Cargo 依赖需在发布前替换为正式固定提交；远程七天演练仍使用原版本。部署先升级全部服务/worker，再启用新写入，详见[通用持久化集成](../design/generic-persistence-integration.md)。

## 账号注册与角色目录

退出请求遇到 Gate 未绑定地图时，必须查询 Location；存在权威角色时要求先恢复地图会话，不能把 Gate 重启后的空缓存当作角色已离线。查询失败保持原所有权，不确认释放。

登录领域的 `C2S_Register.skip_initial_character` 可显式建立仅含凭据的空角色目录；缺省/false 保留同名初始角色行为。`S2C_Register.character` 因此可缺省。空目录正确密码登录返回空列表、`selected_character_id=0` 与空令牌，不访问角色 Location、不授权进入 Gate；显式选择不存在角色仍失败。账号名与角色名的游戏特定校验属于外置模块，不进入 Core。原有目录不被自动清理或改名，持久化仍使用同一版本化目录与 CAS。

`Gate.LogoutCharacter` 验证当前连接与 CharacterId，在连接锁/账号锁内暂停 Actor 转发，等待 Map 的最终保存及 Location 移除确认，再释放路由并失效 Session。普通断线仍保留重连宽限期。失败保留 removing 所有权，当前连接可以重试；失败的最终保存 Promise 不永久缓存。

MapHost 的 `PlayerDirectoryComponent` 在保存和 Location 移除成功后保留最多 10000 条、10 分钟有效的离线回执。`MapHostLifecycle.QueryPlayerOffline` 只读匹配 account、characterId、Unit、Actor、地图实例和 Gate epoch；Actor 响应丢失时 Gate 可恢复正向确认，不以 Location 缺失推断成功。removing 路由在断线后保持移除状态，由既有 Gate 扫描器按 1/2/4/8/16/30 秒墙钟退避重试；在线客户端可自行重试，超过入站活动超时则关闭连接进入恢复。普通超时下线同样必须等待确认，不再在 finally 中无条件释放。回执为宿主内存中的有界证据，不是持久化事务日志；MapHost 重启、回执过期/驱逐或 Location.Remove 自身的确认丢失仍可能阻止自动收敛，不能报告为已经安全保存。

## 普通Entity持久化生成

`VersionedEntityRepository<TSnapshot, TEntity>` 是 Core 提供给内置业务和外置模块的中立单记录快照边界。`DbProxyEntityRepository` 与 `InMemoryVersionedEntityRepository` 都执行相同的 schema 校验和 revision CAS；`CreateVersionedEntityRepository(codec, ownerId)` 在 Rust Host 已安装 DBProxy bridge 时选择持久实现，否则选择仅限当前进程的内存实现。模块若要求跨重启恢复，部署验收必须证明 DBProxy 已启用，不能把内存回退当作持久化完成。

这个仓库只理解 namespace、schema、payload 和 revision，不理解玩家、世界事件、地图或任何来源游戏名词。具体状态机、记录 key、冲突后的领域重算、任务贡献和内容重建全部属于外置模块；Core 只提供 `IsVersionedEntityRevisionConflict` 让调用方识别 CAS 冲突并基于最新快照重试。

- `.native`中的具体Entity可用`@persistent(version)`声明稳定存储结构；字段默认进入快照，`@transient`排除`instanceId`等运行时字段。
- codegen生成`NativeXxxPersistenceSnapshot`、严格Codec、schema/version和`CreateNativeXxxRepository(processName)`；通用Repository负责Revision CAS和同`requestId`重试。
- DBProxy继续只维护固定通用表并把Payload视为不透明字节，不得认识TiangZ Entity。普通Entity无需手工设计数据库表；复杂查询、二级索引和跨玩家事务仍需领域Repository与专门存储设计。
- 当前`Item.native`是最小示范。Player是跨Numeric、Item、Buff、Skill、Quest的聚合快照，仍保留手写`PlayerRepository`，不能机械替换成单Entity Repository。

## Starter MMORPG 纵向切片

TiangZ的业务参考目标是一个小而完整的Starter MMORPG，而不是内容庞大的商业游戏。唯一验收主线为：登录/选角、主城、野外战斗、掉落、背包、任务、动态副本/Boss、断线重连和重启恢复。完整矩阵见[Starter验收矩阵](../starter/acceptance-matrix.md)，开发教程见[Starter MMORPG教程](../tutorials/20-starter-mmorpg.md)。

MMORPG层另提供中立`SpawnSelectionComponent`：外置模块可登记共享容量的Monster、Interactable和子选择组。候选冷却期间继续占用自己的槽，到期只重抽该槽；子组叶子到期会重抽直接父组中的子组槽，切换时完整停用旧子树。内容封存阶段拒绝缺失引用、多父级与循环。来源游戏的表名、概率解释、活动日历和持久化规则仍归外置模块，不能进入Core或中立MMORPG契约。

- 框架能力案例负责解释单项能力；Starter负责证明这些能力能组合成真实业务，不能维护两套重复的网络、Actor、持久化或战斗入口。
- Starter固定一个职业、一个主城、一个野外地图、一个动态副本、三种普通怪、一个Boss和少量技能。社交、商城、运营活动和大量美术资源留在后续示例。
- 新功能只有同时具备Stable API调用、正式配置/协议来源、状态所有者、失败语义和可重复验收，才算进入Starter。
- 账号注册、登录和角色目录已经完成运行时闭环：`C2S_Register`通过`CharacterRepository`写入账号密码盐值/摘要并创建同名初始角色；可选`playerConfigId`允许协议适配器从已经冻结的`PlayerContentProfileComponent`选择模块拥有的中立玩家模板，省略或传0仍兼容默认模板1，非法模板在写目录前拒绝。`C2S_Login`必须携带密码且不会再自动创建游客账号；`C2S_Login.characterId`明确选择角色，`characterId`贯穿Gate、Location、Map和Player持久化。配置DBProxy时账号目录与角色记录写入版本化快照，未配置时仅用于当前进程调试。`LoginMgr`对带账号请求使用稳定哈希保持同一账号落到同一Login。`npm run starter:character-smoke`已覆盖all-in-one和split-process。
- Starter第一版已接入固定任务NPC：Map 100由`NpcComponent`创建`NpcUnit`（`npcConfigId=9001`、`unitId=0x40000001`），NPC作为普通Unit的Subject进入AOI，Cocos3D以紫色方块展示。玩家出生点为`(-3, 1, -18)`，NPC位于出生点东侧约3米；Demo专用`AoiConfig=2`把Enter/Detach扩大为7×7/9×9 Grid，确保出生点能观察到远端刷怪区。10004、10005、10008是三只被动黄色怪，10006、10007是两只主动红色怪，仍分布在远端刷怪区；`MapEntitySnapshot.displayName`由服务端统一提供玩家、NPC和怪物的公开名称，Cocos3D在实体头顶显示名称，怪物额外显示HP。当前所有Starter `QuestConfig`都关闭自动接取；客户端靠近NPC 5米内显示统一“交互”按钮，点击后打开NPC对话框，再点击对话框中的接取/交付按钮才调用`Map.AcceptQuest({ questConfigId, npcUnitId })`或`Map.CompleteQuest({ questConfigId, npcUnitId })`。任务5001由NPC提供，目标是击败5只怪A；在NPC交付5001后，配置前置解锁任务5005，目标是击败5只怪B。服务端在PlayerUnit有序mailbox内校验NPC存在、任务提供关系和5米交互距离，再由`QuestComponent`创建或完成Quest ChildEntity。`npm run starter:smoke`已覆盖NPC快照和接取。
- `npm run starter:acceptance`另有完整任务链夹具：在all-in-one与split-process中均通过正式NPC、导航、普通攻击、查看/单项拾取和跨图协议完成5001、5005、5006，验证前置拒绝、5A/5B进度、未接任务时不显示徽记、累计5个徽记、三次事务奖励和跨图快照恢复。测试不会直接修改Quest、Inventory或Monster状态。
- Starter动态副本固定使用MapConfig 200。客户端只向Gate提交稳定`operationId`；Gate先调用当前PlayerUnit有序邮箱中的`ClaimStarterDungeonEntry`，把10分钟个人CD提交到`progression`记录，再通过`DynamicMapProxy`以`starter-dungeon:<characterId>:<operationId>`幂等请求MapManager分配实例并复用普通`EnterMapCore`进入。同一operationId可恢复已接受请求，新的operationId在CD内返回`DungeonCooldown`；CD随跨图快照迁移并在重启读档时恢复，不属于Gate或副本集体状态。副本内MonsterConfig 3“试炼守卫”拥有900生命；死亡事件给击杀玩家增加120累计经验，尸体掉落表3固定包含小红、大红、蓝药各5个和150铜币。拾取通过同一operationId原子提交`inventory + quest + wallet`，经验和CD分别提交`progression`。空副本继续使用现有5分钟无人回收兜底，不恢复崩溃前的Boss现场。
- 当前恢复缺口优先级已转为动态副本现场恢复与跨机器仲裁；无DBProxy时角色目录只保证进程生命周期内一致，重启恢复必须使用DBProxy。DBProxy多Endpoint、双实例和TiangZ端到端故障切换已验收。Player周期保存会对五个领域生成规范化Payload，只提交相对最近成功普通保存或关键事务真正变化的领域；`reason`只是诊断信息，不参与dirty判定。首次加载/迁移后没有本地基线时仍保存全部领域，部分批量失败只重试失败或后来再次变化的领域，不能用dirty优化跳过未知权威状态。Gate故障接管也已完成同拓扑闭环：Login优先Location当前健康Gate，故障时选择另一Gate；PlayerUnit邮箱通过Location CAS递增gateEpoch，ActorLocation在邮箱入口拒绝旧Gate帧，Watcher有界重启后不自动回切。Manager与动态MapHost双失时玩家可以回到安全静态地图，但不会恢复原Socket、Gate排队帧、Boss现场或战斗计时器，也不是跨机器租约仲裁。
- Starter入口固定为`npm run starter:verify`、`npm run starter:dev`、`npm run starter:smoke`和`npm run starter:character-smoke`；完整纵向验收使用`npm run starter:acceptance`。三个Starter验收命令都会先重建`target/debug/TiangZ`，避免使用旧Rust运行时；`starter:acceptance:persistent`负责DBProxy快照写入、TiangZ重启和恢复读取，`starter:acceptance:faults`通过`test:tiangz-fault-matrix`顺序验证交易故障切换、提交后响应丢失、双Endpoint不可用、MapHost接管和独立DBProxy存储故障。持久化/故障命令需要本地数据库环境，不能对生产数据执行。所有Starter命令只负责静态检查、开发启动和短时运行时验收，不代替容量压测。

### Starter身份约束

- `account`是登录与LoginMgr路由粘性的账号身份，不是角色存储主键。
- `characterId`是角色长期身份，角色目录、Player快照、Location和跨地图传送都以它为稳定键。
- `unitId`是当前Map中的运行时Unit路由ID，可以随着重建或迁移变化，禁止作为持久化角色ID。
- `mapInstanceId`只表示当前地图实例；静态地图和动态副本统一使用同一`TransferToMap`语义。
- 无DBProxy时，跨MapHost传送会用快照接管目标进程的内存目录；这不是重启持久化，重启恢复验收必须启动DBProxy。

### Starter玩家交易

- 玩家交易是`MapScene -> PlayerTradeComponent`拥有的临时会话，不是新的Actor、Scene或持久Entity。当前只允许同MapScene、在线、存活、5米内的两个玩家，并拒绝交易中传送。
- 金币和Item仍归两个PlayerUnit。双方确认后，纯数据Planner只生成双方`wallet + inventory`领域记录；`PlayerPersistenceComponent.ApplyMultiTransaction`使用同一稳定operationId调用DBProxy跨记录CAS事务，双方四条记录的Revision全部匹配才提交，progression/quest/runtime Revision不随交易推进。
- DBProxy提交前不得修改Currency/Item Entity；提交后无await应用双方状态。最终确认者保留自身PlayerUnit ordered mailbox，并通过`MapComponent.RunPlayerMailbox`占用另一参与者的真实Mailbox直到持久化和内存应用完成，禁止第二个玩家在事务`await`期间插入背包或金币写入。ACK丢失用`LoadMultiTransaction`恢复首次回执，禁止拆成两个单玩家事务或用补偿冒充原子性。
- Cocos3D选中其他玩家后显示交易入口；窗口只保存输入草稿，成功关闭Push携带每个玩家自己的金币和完整背包。跨地图、离线、邮件、拍卖行和多方交易暂不支持。设计见[玩家交易](../design/player-trade.md)。

### Starter NPC与任务接取

- NPC不是特殊的网络入口，也不是`QuestComponent`的替代品。它是`MapScene.UnitComponent`拥有的普通`Unit`，由`NpcComponent`维护地图内索引并以Subject身份挂入AOI；NPC不创建mailbox、不持有玩家状态。
- 客户端只能从AOI快照得到可见NPC的`unitId/configId`。当前Starter的所有QuestConfig都关闭`auto_accept`，玩家出生时没有默认任务；靠近NPC 5米内才显示交互按钮，按钮打开对话框，接取或交付按钮才发起请求。任务达到`ReadyToTurnIn`后不能从任务追踪面板直接领奖，完成请求必须携带NPC实例ID。点击或选中NPC本身不能改变任务状态，不能把“看见NPC”当作任务已接取。桌面端的`F`只是交互按钮快捷键，移动端和桌面端走同一套对话框流程；服务端仍以PlayerUnit有序mailbox内的`NpcComponent.ValidateQuestInteraction`为最终校验。
- NPC的静态位置、提供哪些任务和显示名属于业务配置/创建流程；Starter固定值只用于第一版演示，未来扩展NPC配置时保持同一Unit和协议语义。任务状态仍由`QuestComponent`拥有，NPC销毁或离开AOI不能删除玩家任务。

## 一句话定位

TiangZ是一套正在验证中的MMORPG服务端框架：Rust/Tokio提供网络和宿主能力，一个操作系统进程创建一个V8，TypeScript在单业务线程中承载多个Scene、Actor和Component；高频跨帧Entity数据可以下沉到Rust，TS通过生成句柄操作。

TypeScript仍是默认业务语言；开发者明确选择Rust实现的稳定、高负载领域统一放在`src/game/<domain>`，例如Buff执行引擎、战斗计算或移动算法。`src/native_data.rs`属于框架权威Store，不继续混入新的游戏业务。Rust业务随Process编译、不能Hotfix；Actor Handler即使调用Rust算法，也必须先经过TS的Location、Unit/Session定位、传送屏障和mailbox，不能在网络入口旁路Actor语义。

### 中立怪物脱战表现

`MonsterContentSpawn.idleSequences`的动作现在可以是`Emote`或`Say`。两者共用中立的初次/重复延迟、概率、稳定刷点目标和战斗打断语义；`Say`从内容包提供的非空文本候选中按执行轮次确定性选择一项，并通过既有`UnitPresentationType.Say`广播。Core不读取SmartAI事件/动作编号、不解析来源文本表，也不负责客户端聊天封包；来源适配器必须在构建期完成时序、本地化文本和动作类型的投影。

### 通用内核与首个领域

TiangZ的内核不是“MMORPG内核”，而是先用MMORPG验证的通用运行时。`app/core`负责Process、Scene、Actor、Component、mailbox、生命周期、协议路由、热更屏障和宿主边界；它不拥有AOI、地图、NavMesh、怪物、任务、技能或战斗规则。当前这些能力位于`app/model/mmorpg`、`app/hotfix/mmorpg`和`src/game`，是第一个领域的可读实现。

外置游戏模块是构建/发布边界，不是新的领域层。Core只提供模块ID/版本/依赖图校验、独立类型检查、不可变Model导出桥、强类型Entity装配和Hotfix组合能力；具体模块的Scene、Component、Handler、协议和配置仍在模块自己的仓库。`modules/`默认忽略第三方目录，构建期读取`tiangz.module.json`并生成确定性模块图；`TIANGZ_MODULES_DIR`让构建与开发宿主使用同一外部集合。目标Factory在Entity发布前调用`applyEntityExtensions`，装配器只能同步`AddComponent`并沿用现有回滚/生命周期。当前MMORPG工厂覆盖`MapScene`、`PlayerUnit`、`MonsterUnit`、`NpcUnit`、`InteractableUnit`和`SummonedUnit`：地图工厂先放入中立的`MapRuntimeProfileComponent`、`SkillDefinitionProfileComponent`与`BuffDefinitionProfileComponent`再执行扩展，AOI、地图、玩家移动/复活、NPC、怪物、技能和Buff状态机随后只读取已经冻结的资料；模块技能与Buff只能登记模块私有只读定义，不能覆盖Luban冷配置或另一个模块。Grid2D也可通过同一个朝向相对输入入口量化为八方向移动。怪物工厂先放入`MonsterSpawnProfileComponent`再执行扩展，出生、追击距离和Evade回巢共用同一坐标；NPC与可交互物先完成基础身份、位置、静态资料和可逆内容增量，再执行扩展，成功后才进入领域索引与AOI。扩展失败必须沿原Factory移除整个Unit，不允许发布半装配实体。模块若给NPC组合`NumericComponent`，NPC快照会自动走既有数值复制白名单；普通服务型NPC没有该组件时仍输出空数值集。所有资料入口都拒绝不明确的多所有者覆盖，避免模块顺序造成静默的最后写入者；伤害仍统一进入怪物领域边界，直接伤害与Buff Tick都不能绕过死亡、尸体和刷怪槽释放。模块集合或Model变化必须重启，已有行为变化继续复用Process级Hotfix事务。完整契约见[外置游戏模块](../design/external-game-modules.md)。

运行时数据包与代码模块是两个独立发布面。Rust宿主从`process.dataPacks.sources`按配置文件相对路径递归发现固定名`runtime.pack.json`，在创建V8前校验来源、大小、JSON信封、SHA-256格式、重复ID和符号链接；随后把资料作为宿主投影交给`ProcessRuntime`。Core在任何Scene创建前建立进程级只读`RuntimeDataPackRegistry`，再次验证纯JSON树并深冻结，同时要求`ownerModuleId`已经存在于封闭模块图且数据包ID位于所有者命名空间。模块只能通过Stable API按所有者或ID读取不透明payload，payload schema、跨表引用、字段迁移和领域装配均由所有者模块负责；Core不认识地图、职业、任务、来源数据库或业务表。增加或替换数据包需要重启Process，但不再要求生成一个新的代码模块或改变模块图；代码行为、协议和稳定状态仍由代码模块拥有。当前实现是进程启动期全量载入，后续海量世界资料应扩展为经DBProxy/内容服务读取的分区快照，不能让Scene直接连接数据库。

进程部署环境与安全随机数（0.6.2）：`process.environment`（`development | test | staging | production`，缺省 `development`）由 Rust 在解析配置时校验，投影给 Core 的进程级只读单例 `ProcessRuntimeInfo`，并出现在 `/runtime-identity`；Core 不解释环境，业务自行决定差异。宿主通过 `getrandom` 提供操作系统随机源，启动脚本在业务 V8 中挂一个冻结的 `__hostSecureRandom.fill`，Stable 包装为 `SecureRandom`；业务 V8 没有 Web Crypto，`Math.random`、GlobalId 与时间戳都可预测，身份凭证必须用 `SecureRandom`。模块协议工具提供开发期 `--dev-regen-schema-lock`，发布门禁下拒绝，见业务开发手册“开发阶段与Release锁定”。

模块静态内容复用TiangZ现有Luban能力，不再建立一套面向来源数据库的配置系统。`tiangz.module.json.gameConfig`可声明模块根内的Luban工程、target及生成代码/数据目录；`tools/codegen_module_game_config.mjs`使用Core固定的Luban版本、严格validation、确定性聚合和SHA-256指纹生成模块自己的`Tables`。Core只验证声明路径与输出边界，不认识任何表或字段。来源游戏数据库、Excel或其他工具先转换成模块Luban源数据，运行时包再承载编译结果；所有者模块必须用生成类型解码并投影到中立Profile，禁止把导入JSON直接强转成运行时对象。schema与数据目前均按冷发布处理，改变后要重新生成、构建并重启Process；它不继承Core内置`GameConfig`的热表Reload。通用自测使用不含MMORPG概念的卡牌表证明该生成器不依赖首个游戏。

外部协议适配器在完成自己的协议校验后，可以通过中立的`TriggerNpcInteraction`入口发布“NPC内容交互已发生”事实。Core只校验玩家、Unit、AOI和距离，并把`NpcContentInteractionTrigger`分发给内容规则；触发值和表现动作是稳定内容契约，不包含外部协议opcode、SmartAI枚举、地图号或具体游戏领域状态。这样协议差异留在适配器，内容包与TiangZ运行时仍可复用同一套NPC表现能力。

NPC内容动作还支持不透明的`ExecuteAbility`请求。`NpcComponent`在交互规则到期后只发布`NpcEvents.InteractionActionRequested`，携带NPC、可选目标玩家、动作和时间；Core不解释能力编号，也不生成法术或游戏协议数据包。外置游戏模块负责把自己的能力编号映射为表现或权威效果，未知请求必须安全忽略。这样ACDB/SmartAI的CAST链可以配置驱动导入，同时不会把来源事件、动作、法术号或客户端封包语义带入TiangZ Core。

NPC脱战定时序列同样支持不透明的`ExecuteAbility`动作。`NpcComponent`只推进初次/重复延迟、概率和稳定刷点目标，然后发布`NpcEvents.IdleActionRequested`；Core不解释施法目标、Spell ID或客户端封包，外置适配器自行把能力 ID 映射为实际表现或权威效果。导入器可以直接把SmartAI的UPDATE_OOC定时表CAST行投影为该动作，未知目标或法术仍保留为可审计缺口。

大规模地图内容不再要求外置模块先向Luban逐条添加`MonsterAreaConfig`。`MapHost`在同步装配`MapScene`前创建地图级`MonsterContentProfileComponent`；模块可按稳定ID原子登记中立怪物模板与固定刷点，也可由一个明确所有者声明该地图完全替换演示冷内容，装配结束后目录立即冻结。`MonsterComponent`把冷配置和目录资料规范化为同一种刷怪槽，继续拥有Unit、AOI、战斗、尸体和重生；刷新秒数属于刷点而不是共享模板。创建`MonsterUnit`时会把中立模板中的名称和模型ID冻结到实体，AOI快照只组合实体的冻结展示资料与实时Position/Numeric状态，不得按外部模板ID回查Luban冷表。组件、错误、测试夹具和日志不包含任何具体游戏表名或编号，中立Training Dummy夹具覆盖冻结、所有权冲突、跨所有者引用和原子失败。该边界解决“已生成内容如何进入现有MMORPG运行时”，不代表模块manifest已经拥有通用Data Pack schema、迁移或客户端导出。

`MonsterContentDefinition`可以声明成对的`minimumLevel/maximumLevel`正整数闭区间；省略两项时保持Level 1兼容行为，单独提供、倒置或非正整数都会在内容目录冻结前失败。`MonsterComponent`按稳定刷点ID和该刷点成功创建的代数确定性选择区间内等级，在进入AOI前写入`NumericType.Level`；同一进程内死亡重生会递增代数并重新选择，固定等级区间不会漂移。这个契约只负责中立等级选择，不根据等级暗中缩放生命、资源或伤害；来源游戏若需要等级相关属性、精英修正或随机公式，必须在模块构建/投影侧生成明确配置，不能加入Core分支。

等级相关战斗数值使用可选的`combatStatsByLevel`中立曲线。空数组等价于未配置；一旦提供非空曲线，就必须逐级完整覆盖`minimumLevel..maximumLevel`，每行显式声明`maxHp/maxMp/attackDamage`，目录冻结时拒绝缺级、重复、越界或非法数值。Monster与战斗NPC先用同一刷点代数选出Level，再精确读取该级行；没有曲线时才兼容使用定义顶层静态值。Core不会插值、缩放或读取任何来源成长表，具体游戏的生命、法力、武器/AP及精英公式必须在模块构建期物化为曲线。

`NpcContentDefinition`复用同一对可选等级边界和同一个稳定刷点/成功创建代数选择器。带战斗资料的NPC把Level合并进既有`NumericComponent`；纯服务NPC只有在内容显式提供等级时才装配包含Level和既有正移动占位值的Numeric，不会因此获得生命、攻击、Combat或Skill组件。NPC死亡重生、活动停用后重新激活都在成功创建后推进代数；没有等级配置的既有NPC保持原组件形状。

怪物模板可携带按玩家等级预计算的中立击败经验曲线`rewardExperienceByPlayerLevel`。来源游戏负责在构建期计算公式、等级差、精英和免经验规则；Core只在`MonsterEvents.Killed`提交后选择当前等级对应值，通过玩家mailbox和`ProgressionComponent.GrantExperience`持久化，再发布既有`G2C_ProgressionChanged`。幂等键包含地图实例、稳定刷点、具体怪物生命周期和角色，既能重放同一次奖励，又不会压掉同一刷点复活后的新击杀。Core不得加入具体游戏的经验公式、怪物类别或客户端升级封包。

怪物内容目录还可声明中立的进入战斗表现规则、路径点动作和刷点级脱战空闲序列。运行时规则只使用`Engage`、`Say`、`Emote`等MMORPG语义，不保存SmartAI等来源引擎枚举；路径点动作可按到达后的相对延迟设置持续动作、替换模型、在点附近临时游走或重启本刷点已有路线。`idleSequences`使用初次/重复延迟区间和有序动作，只在脱战时推进；动作执行者可以是自身或同一内容所有者的稳定刷点，跨所有者或不存在的引用会在目录登记时失败。进入战斗会取消当前空闲序列进度，回归后重新初始化。`MonsterComponent`拥有动作调度、战斗打断、确定性概率和移动控制，外置导入器拥有来源命令到这些中立动作的映射。每个权威怪物行为Tick在改变移动或攻击前还会检查同步只读的`MonsterEvents.BeforeBehavior` Veto链；非零模块私有原因只表示“停止当前移动并跳过本Tick”，Core不解释眩晕、恐惧、凿击等具体规则，监听器也不得直接修改移动、仇恨、Buff或战斗状态。一次性或持续表现统一经`MapComponent.PublishUnitPresentation`按AOI广播；运行时模型和持续表现状态同时写入`MonsterUnit`，并通过`MapEntitySnapshot.presentationModelId/presentationStateId`进入迟到观察者快照。具体客户端字段、聊天包、模型编号和动画编号仍由协议适配器投影，不能反向写入Core或通用内容契约。

临时召唤物由地图级`SummonComponent`统一维护，所有者可以是`PlayerUnit`或`MonsterUnit`：模块只提交冻结的中立定义、所有权槽位和创建能力编号，运行时创建普通`SummonedUnit`，负责同槽替换、AOI生命周期、固定5Hz跟随、远距离回收、死亡清理和所有者离场清理。协战、击杀/任务归属和跨地图迁移目前只对玩家所有者启用；怪物所有者使用运行时`UnitId`，不伪造玩家持久ID，也不会因为引用了召唤模板而产生世界刷点。玩家临时召唤物的同进程和跨Process地图迁移只通过`OwnedSummonTransferState`与`PlayerTransferSnapshot.owned_summons`恢复所有权槽、创建能力和冻结定义，目标、位置、Native句柄和战斗中间态不跨地图复制；目标槽位为空且恢复失败会回滚候选。需要重登录恢复的模块私有状态应通过`PlayerPersistenceComponent.RegisterPersistenceExtension`提交版本化不透明字节，未知模块状态会被Core保留而不会静默丢弃；临时召唤物本身仍不是持久化Entity。Core不认识宠物、恶魔、图腾、法术号、动作条或客户端宠物协议，模块不能绕过Unit/AOI生命周期自行保存。

外置Buff资料使用地图级`BuffDefinitionProfileComponent`登记与现有`BuffConfig`同形的中立生命周期定义；`BuffDefinitionResolver`只在外置目录没有命中时读取冷配置，并显式拒绝同ID碰撞，不提供覆盖冷表的旁路。定义可携带模块拥有的不透明正整数`effectTags`，`BuffComponent.RemoveBuffsByEffectTags`先冻结命中实例再按“任一标签”批量移除并完整执行各自RemoveAction；Action层提供同名原子动作，但不解释控制、驱散、免疫或任何具体标签含义。运行时仍只有一套`BuffComponent/BuffSystem`负责冲突、刷新、Tick、伤害吸收、传送和AOI事件，技能、道具与怪物行为都通过已有`AddBuff`入口引用定义。怪物规则支持`HealthRange`触发和`ApplyBuff`动作：血量区间使用千分比；省略重复延迟时，一次遭遇只判定一次；同时提供`repeatDelayMinMs/MaxMs`时，由地图固定更新帧在战斗中持续轮询并按每条规则的确定性截止时间重复执行。重复规则不得创建独立Timer。任一行为动作可用`requiredAbsentBuffDefinitionId`声明“动作目标缺少该不透明Buff时才执行”，Core只做同步存在性检查，不解释该Buff为何阻止动作。来源数据库中的SmartAI事件、动作、施法flag、法术号和DBC光环枚举只能在外置导入器中转换为这些中立定义。Core不得出现SmartAI、Spell.dbc、具体职业、法术或地图编号。

玩家主动接取任务现在使用`QuestComponent.AcceptQuestDurable`把Quest与接取时物品合并为`inventory + quest`原子事务；DBProxy确认后才创建本地Quest和Item，ACK不确定时按稳定operationId读取原回执，重复请求不会再次发放物品或覆盖后来产生的任务进度。`M2C_AcceptQuest`返回受影响物品快照，协议适配器可立即投影客户端背包。首次本地应用提交结果后发布中立的`QuestEvents.Accepted`同步事实，事件包含玩家、Quest状态、交互来源UnitId与物品变化；模块只能追加对白、动作或世界表现，不能否决或改写已经提交的事务。具体任务号、NPC号、对白和延迟全部留在外置模块。

外置职业规则优先组合既有中立扩展点，不在Core增加职业分支。短生命周期状态放模块自己的PlayerUnit Component；施法前置使用`SkillEvents.BeforeCast`只读Veto，击杀、连击、圣印等后续联动订阅`CombatEvents.DamageResolved`。基础技能效果提交后，`SkillEvents.EffectsResolved`会按瞬发命中、弹道命中或每个引导Tick分别发布同步事实，模块可追加非基础效果，但不能改写已经提交的伤害、冷却或施法结果；监听器必须同步且不得抛错。后续效果仍通过`BuffComponent`、`MonsterComponent.ApplyUnitDamage`、`ItemComponent`事务计划或`ActionType.GrantItem`进入既有结算边界。技能发放物品时，`SkillMapComponent`会把受影响Item通过现有私有`ItemChanged`通道发布；外置协议网关只做物品与法术编号投影。通用事件与事务能力属于TiangZ，职业名、法术号、公式和临时状态属于游戏模块。

目标侧通用减伤通过Numeric的`IncomingDamageMultiplier`和`PhysicalDamageMultiplier`三源派生字段组合完成，倍率统一使用1000为基准；伤害在护盾处理前依次应用全局与物理专用倍率，非物理伤害只应用全局倍率。为兼容尚未配置这组字段的旧Entity，三项来源全为0时按1000解释；正式玩家或怪物Profile应显式写入Base=1000。Core只识别通用伤害学校和倍率，不识别护甲、职业、光环或具体法术；具体游戏由外置模块通过Buff的`ChangeNumeric`或`ChangeNumericBatch`动作提供公式和生命周期。批量动作的参数是一个或多个`[numericType, delta]`对，执行前完整校验非派生类型并拒绝重复项和`CurrentHp`，因此一个Buff可以同步维护多项中立数值而不会在坏配置上发生部分写入；它仍不是数据库事务。

这不是现在就抽象第二套游戏的理由。只有第二个领域真正接入后，才根据重复的稳定需求调整边界。当前代码只做四项约束：Core不能依赖Demo/Hotfix，Model不能反向依赖Hotfix或Core内部文件，Rust `src/game`不能绕过`native_data`访问宿主Transport/Process，外置模块不能让Model/Hotfix相对导入越过自己的声明根。`npm run verify:domain-boundaries`、`npm run verify:hotfix-boundary`和模块构建门禁共同检查这些规则。

`SceneConfig`中的`staticMapIds`和`acceptDynamicMaps`是当前MapHost的可选部署能力描述，不是Core执行地图规则；0.4.x保留它们以避免把配置迁移误当成通用性工作。第二个领域需要复用同一Runtime时，再根据实际冲突把它们迁移到领域配置扩展，不提前引入无类型的万能`extensions`。

### 三层能力归属与领域契约

当前代码把能力分成三层，完整表格见[能力归属与领域拆分](../design/capability-ownership.md)：

1. `app/core`和`src`是框架运行时，只负责Process、Scene、Actor、Component、mailbox、Transport、Hotfix屏障和Native Store。
2. `app/model/domains`是可复用领域契约层，当前承载Numeric、ActionDefinition、RewardPlan、Item、Quest和Buff的稳定状态形状。Combat和Skill目前仍包含MMORPG的平A、伤害学校、施法和引导语义，完整实现保留在`app/model/mmorpg`，不维护未使用的类型影子。
3. `app/model/mmorpg`、`app/hotfix/mmorpg`和`src/game`是第一个具体领域，承载AOI、MapHost、NavMesh、移动、怪物、NPC、目标选择、Combat/Skill执行、技能地图调度和协议/配置适配。

本轮已完成`demo -> mmorpg`的服务端业务目录重命名；`native_data/demo`也已改为`native_data/mmorpg`并重新生成Native代码。`.native`中的`namespace demo/native`保留为持久化schema和Native ABI标识，不能随目录整理静默修改。生成协议仍保留`server/demo`和客户端SDK的`Model/demo`路径，因为它们是已发布线协议命名空间，重命名会构成协议兼容性变更。`ActionDefinition + RewardPlan`是第一组跨游戏试点：MMORPG继续在`app/hotfix/mmorpg`执行Action和奖励，`RewardDefinition`只作为旧代码兼容别名，不把当前执行器误宣称为通用框架能力。

Numeric的`MoveSpeed`已从通用Numeric表拆到`app/model/mmorpg/numeric/MovementNumeric.ts`；米/秒到Rust毫米/秒以及写入后同步位置，属于MMORPG移动适配。`DirectionalMovementProfileComponent`同样位于MMORPG层：它保存服务端配置的前进/后退/横移倍率，`PlayerUnitSystem.NavigateInput`按离散方向选择有效速度，默认`1/1/1`；外置模块可以配置倍率，但客户端协议不携带可信速度，Core也不认识具体游戏档位。Item、Quest、Buff已先拆出稳定Model容器和数据契约；Combat、Skill仍完整位于MMORPG适配层，因为当前实现包含平A、伤害学校、读条、引导和技能配置。第二个真实游戏领域出现后，才根据重复实现继续抽取执行代码。

五项常见主属性`Strength/Agility/Stamina/Intellect/Spirit`同样只在MMORPG组合层的`AttributeNumeric.ts`中声明，并统一复用Numeric的Base/Add/Pct派生约定。Core不根据主属性推导生命、法力、护甲、攻击或任何职业公式；外置游戏模块可以逐级写入Base、由Buff修改Add/Pct，并由自己的协议适配器决定哪些结果对客户端可见。不使用传统五属性的游戏可以完全不配置这些编号。

当既有客户端已经持有一套无法由TiangZ复刻的场景碰撞时，外置模块可在`MapRuntimeSpatialProfile.externalMovementSnapshots`中为单张Grid2D地图显式声明最大快照位移。此模式仍经PlayerUnit mailbox、地图边界、单调序号和最大位移校验，随后通过一个Rust粗粒度操作原子写入；未声明的地图拒绝位置字段，NavMesh3D继续只接受服务端导航意图。`C2M_NavigateInput`中的位置字段只是这一受控网关模式的兼容载体，不携带速度，也不是所有客户端默认可信。Grid2D移动增量保留Y高度和连续Yaw，避免2.5D投影在后续帧退回零高度或四方向。

技能、传送门或脚本需要在同一地图内立即改变Unit位置时，统一调用`MapComponent.RelocateUnit`，不能直接改`Position`或由模块手写AOI广播。该中立能力只负责有限值、地图归属与空间有效性校验：Grid2D按Cell吸附，NavMesh3D投影到可行走面；成功后清除旧移动、更新Rust权威位置并通过既有Movement/AOI链发布一条服务端来源的不可确认状态。目标选择、距离公式、冲锋/击退/闪现等游戏语义及客户端协议投影仍由外置模块拥有。服务端位移使用未携带客户端确认序号的记录，网关必须把它视为权威纠偏，不能伪装成对某次客户端预测的ACK。

异步业务在外部`await`返回后必须调用Entity的`AssertAlive()`，再读取或修改Entity/Component。JavaScript不能抢占已经开始执行的Promise continuation；框架会在Actor mailbox结算时拒绝已销毁Actor的调用，但不能撤销await之后已经执行的业务代码。需要新的串行边界时，应重新投递Actor mailbox消息或Entity Timer，不要把长Promise当作锁。

开发期可见机器人位于`tools/walk_robots.ts`，只使用正式TypeScript SDK完成登录、进图、Ping和Move。机器人是外部测试客户端，不得为它在Core、Demo Handler或Map业务中增加专用分支。

公共`LoginFlow.latestGatePing`保存最近一次Gate Ping的RTT、服务端Unix毫秒时间、估算时钟偏差和本地接收时间。客户端显示网络延迟必须使用RTT，不能直接用`Date.now() - serverTime`，否则客户端与服务器的时钟差会被误算成网络延迟。

当前版本是`0.6.2`（2026-09-23 发布；`0.6.0` 于 2026-09-20 发布，此前为 `0.6.0-alpha.0` 开发预发布）。框架支持独立游戏模块，MMORPG 是领域示例，SLG 正在验证开发体验。模块 `<0.5.0` 宿主上限会拒绝本版本，须逐个验证后迁移并重新生成、构建和重启；不得自动放宽其他游戏声明。`v0.3.10`是框架能力的首个稳定基线。Phase 0到Phase 3.10.5的实现、专项验收以及Windows/Linux最终发布矩阵已经完成；Phase 4.0空间契约、Phase 4.1 Rust AOI和Phase 4.2.5 NavMesh3D动态障碍链已经完成。工程已有登录、选服、进入地图、2D/3D多人移动、状态广播、WebSocket/Cocos Web、KCP/Cocos Native、Pixi/H5和Godot 4.7.1验收链路，并完成Windows 3000玩家AOI正式容量回归；角色与怪物之间的动态阻挡和动态避让明确不做，尚未完成Linux/分布式空间负载、完整商业MMORPG业务和生产运维方案。

NavMesh3D的同一目标意图由Rust保留现有路径与游标，只更新较新的确认序号；目标变化、显式重置或障碍版本变化才触发重算。这个幂等性是通用导航运行时契约，业务模块仍只决定目标和行为节奏，不把具体游戏巡逻规则写入Core。

## 为什么形成这套模型

项目最初从“用Rust、deno_core和TypeScript仿照Skynet”开始，随后逐步融合了ET更适合MMORPG业务组织的Scene、Actor、Entity和Component思想。

关键认识如下：

1. Skynet Service擅长消息隔离，但如果把每个业务能力都拆成独立V8，会增加跨Isolate通信、部署和业务组合成本。
2. ET用Process承载多个Scene，用Scene和Component组成业务边界，更符合地图、副本、玩家Unit和社交域的开发习惯。
3. TiangZ最终不把“Service”同时用作部署边界和业务边界，而是明确区分Process、EntryScene、动态Scene、Actor与Component。
4. 一个Process只有一个V8和一个TS业务线程，可以启动多个EntryScene；网络与宿主可以多线程，TS业务保持单线程。
5. 同进程与跨进程只应是部署差异，业务Handler不应因为拆分配置而改调用代码。

因此当前统一模型是：

```text
Machine
  -> Process（OS进程、一个V8、一个TS业务线程、Inspector和故障边界）
      -> EntityRoot（InstanceId到Entity的生命周期索引）
      -> 配置 Scene / EntryScene（Login、Gate、MapHost、Social等业务入口）
          -> Session（网络连接）
          -> 动态 Scene（map:1、副本实例等业务容器）
              -> UnitComponent（地图Unit统一集合与创建入口）
                  -> Unit（普通地图实体，无mailbox，例如怪物、NPC）
                  -> ActorUnit（可寻址Unit，有mailbox，例如玩家）
                      -> Component（Numeric、Item、Buff等状态与能力）
                          -> ChildEntity（Item、Buff、动态Quest等本地子实例）
```

## 核心名词

### Process

Process是操作系统进程、V8、TS线程、Inspector和故障隔离边界。一个配置文件描述一个Process，一个Process可以创建多个EntryScene。它不等于业务功能，也不等于旧Skynet语义中的一个Service。

### EntryScene

EntryScene是可配置、可寻址的顶层业务边界，例如`LoginMgr`、`MapManager`、`Login`、`Gate`和`MapHost`。未来的`Social`可以作为一个EntryScene，再挂载`GuildComponent`和`FriendComponent`。

### 云部署网络地址

Scene配置把三个地址语义分开：`bindIp`是本机监听地址，`innerIp`是Process之间的内网路由地址，`outerIp/outerPort`是客户端连接地址。旧配置中的`ip`仍兼容读取为`innerIp`，但新配置不得把含义混用。

云服务器的公网EIP/NAT可能不会出现在虚机`ip addr`中，因此公网地址由部署配置显式填写。`0.0.0.0`只能作为`bindIp`，不能写入`knownScenes`，不能放进Location/MapHost Endpoint，也不能返回给客户端。服务间RPC和Actor路由使用`innerIp`；外网演示由前端写死LoginMgr公网地址，LoginMgr返回Login的`outerIp/outerPort`，Login返回Gate的`outerIp/outerPort`。同一入口在`scenes`与共享`knownScenes`重复出现时，外网字段可以只填写一处；两处都填写时必须一致。

外网测试机的安全边界是“公网HTTPS/WSS端口属于Nginx，TiangZ只属于回环地址”。`external-multiprocess`中的LoginMgr、MapManager、两个Login、两个Gate、两个静态MapHost、一个动态副本MapHost和Location各自运行在独立Process/V8中；LoginMgr、Login和Gate使用`bindIp=127.0.0.1`，实际监听`27000/27001/27002/27201/27202`，Nginx在`443/17000/17001/17002/17201/17202`终止TLS后转发到回环端口。MapManager、MapHost、Location和DBProxy不经过Nginx。静态MapHost使用`acceptDynamicMaps=false`，`dungeon_1`使用`acceptDynamicMaps=true`承载Map 200。证书只存在于服务器`/etc/letsencrypt`，不得进入仓库或业务配置。

### Scene

普通Scene是Process内动态创建的业务容器。一个MapHost可以创建多个MapScene，让低负载地图共享同一线程；扩容时再增加MapHost Process或EntryScene实例。静态地图与动态副本共享同一个MapHost实现和`CreateMap`入口，不拆两套服务；`staticMapIds + acceptDynamicMaps`组合出静态专用、动态专用和混合Host。动态地图由单例`MapManagerScene`调度：启用动态承载的MapHost主动注册并每5秒续租，Manager按负载分配宿主并用业务`requestId`固定唯一MapInstanceId。Manager与Location共享MapHost generation和15秒租约；双失后旧动态路由到期，玩家重连回到安全静态地图，副本临时运行态不恢复。

部署配置允许`knownSceneFiles`引用共享稳定目录。Rust启动器把本地Scene、共享目录和本地追加项做冲突校验后合并，再把普通`knownScenes`传给TS。该文件组合是不可热更的启动能力，不是服务发现；本地示例集中在`configs/local/cluster/known-scenes.json`。新增空载副本Host只创建自身Scene并引用共享目录，不修改其他进程配置。本地人工入口只有`cluster/StartMachine.json`和`all-in-one.json`；`cluster/`是一套可整体复制的多进程部署包，包含Watcher入口、各Process和共享`known-scenes.json`，Inspector变体单独归入`debug/`。`all-in-one.json`在同一Process/V8中保留两个Gate、静态MapHost和空载动态副本Host，用于验证单进程快路不改变业务语义。

Rust配置加载器对根对象、Process及所有嵌套配置执行未知字段拒绝；字段拼写错误必须在启动期失败。TS中的`ProcessConfig`只是Rust宿主传给业务V8的只读投影，监听、健康检查、Hotfix超时和宿主队列等Rust专有字段有意不暴露，不能用两侧字段数量不同判断配置遗漏。

MapHost停机和动态地图`Dispose`都必须先经过`MapComponent`的业务清理入口：先完成玩家保存/下线，再让所有剩余Unit（包括Monster和仍在进图队列中的Unit）脱离AOI，最后通过`UnitComponent.Remove`按真实所有权销毁普通Unit或ActorUnit，Scene组件随后才释放AOI世界。通用`ProcessHost`不理解AOI，不能直接销毁仍附着的Native Unit；业务也不得在`OnDestroy`里补救已经错误的销毁顺序。`MapComponent.Shutdown`还会停止地图Tick，避免停机等待期间继续创建或移动实体。静态和动态地图共用这套本地销毁流程；只有动态地图在Scene销毁成功后通过`MapHostControl.DynamicMapDisposed`通知MapManager，通知失败会由MapHostRegistration保留并重试。

### Actor、Scene、Session、Unit、ActorUnit与Mailbox

Actor是“拥有mailbox并能按InstanceId路由”的运行时能力，不是所有Entity或Unit的默认属性。Scene和Session天然是Actor消息目标；地图实体只有显式继承`ActorUnit`并声明`@actor`时才获得该能力。普通`Unit`只表示玩家、怪物、NPC等地图身份与生命周期，不创建mailbox，也不进入Actor路由。业务不创建`LoginActor`之类只为获得mailbox而存在的包装类。

- `Id/UnitId`是业务身份。
- `InstanceId`是本次生命周期地址，Entity重建后旧值失效。
- Session和ActorUnit消息根据InstanceId在EntityRoot中O(1)定位；普通Unit虽然也有生命周期InstanceId，但不能把它当Actor地址。
- `ordered`保证同一mailbox的消息跨越`await`仍然串行。
- `unordered`允许异步调用重叠，但所有CPU代码仍在同一TS线程执行。

怪物的`AreaId`和`UnitId`不是同一个概念：`AreaId`是长期存在的固定刷怪槽位，`UnitId`是一次MonsterUnit实体生命周期的身份。`MonsterUnit extends Unit`，由地图固定更新桶驱动，不声明`@actor`，没有每怪物mailbox。怪物死亡后以`alive=false`保留原Unit和AOI身份，供倒地、命中、Buff清理和未来掉落表现引用；当前最小Demo在`respawn_seconds`到期时先从AOI Detach、发布Leave并从UnitComponent Remove，再只复用AreaId创建新的MonsterUnit、UnitId和Native句柄。任何战斗、任务或客户端引用都不能把旧UnitId当成复活后的实体。

这解决了Skynet协程在`call`让出时可能处理后续消息而造成逻辑重入的问题，但不能把所有对象都设为ordered。Session默认使用unordered，允许同一连接的无关RPC跨`await`重叠；`PlayerUnit extends ActorUnit`并显式使用ordered，保持单玩家权威业务串行。MonsterUnit等批量实体保持普通Unit，由所属Component的固定桶推进。Login/Gate入口Scene同样使用unordered。Gate的登录、进图、重连、传送、快照确认和最终下线按连接或账号使用`Scene.Locks`，Ping不加锁。账号级并发只有真实业务需要时才使用账号Location或领域锁，不能用永久`LoginActor`伪装账号状态。

Gate连接状态分成两层：`GateSession`只代表一次物理连接，断开即销毁；`GatePlayerRoute`按账号保存`UnitId -> MapHost/Map/ActorInstanceId`和当前`connectionId`，在30秒重连宽限期内继续存在。客户端每5秒调用`C2G_Ping -> G2C_Ping`，响应携带Gate生成响应时的Unix毫秒`serverTime`；Gate收到任意客户端帧都会先刷新`lastReceiveTime`，出站排队只更新`lastSendTime`，绝不能延长存活期限。Ping是无锁的普通TS RPC Handler；Session为unordered，所以它不会排在长时间EnterMap之后。会修改Route的操作按账号进入协程锁，断线和超时下线取得锁后必须重新校验连接所有权或超时条件。Gate使用一个1秒合并扫描器检查全部Route，不为每名玩家创建Timer。

同账号新连接会在Gate内原子替换旧`connectionId`。旧Session会先失去账号、角色、Token和Route所有权，再收到`G2C_SessionReplaced`（错误码`10040`），最后请求关闭旧Socket；旧socket迟到的disconnect和在途Handler只会失败，不能清理新连接或Map Unit。服务端传输层在关闭前会排空已入队的下行帧，客户端`RpcSocket`也会保留关闭前已经收到但尚未由`update()`分发的单向消息，因此Cocos/Web/Pixi可以可靠显示“账号已在其他设备登录”。客户端SDK通过`LoginFlow.onSessionReplaced`暴露通知，业务回调负责清理本地场景并回到登录界面。同Gate顶号由连接代次保证；跨Gate故障接管由Location gateEpoch和Actor fencing保证，两者不能混成一个全局Session对象。

重连后Gate以现有Actor路由调用`SecondEnterMap`，Map只清除旧移动意图并返回权威全量快照，不创建Unit、不重新广播AOI进入、不改绑Gate。宽限期结束后Gate才调用`PlayerOffline`；Map完成保存和Location移除后先响应Unit RPC，再由下一轮Map Timer完成AOI离开和Actor销毁，不能在PlayerUnit自己的mailbox中同步`DespawnActor`自己，否则运行时会把正常下线误判为Actor在mailbox执行期间消失。Map不拥有断线Timer，也不保存`gateSessionId`。

Login使用带最终avalanche混合的Rendezvous Hash排列Gate候选。所有Login实例对同一Gate拓扑必须给出相同顺序；有Location在线记录时先探测并保留当前Gate，只有它不可达才选择下一健康候选。A恢复后只接收新玩家或本就归A的玩家，不主动把B上的现存玩家拉回。公共前缀账号的批量分配必须通过分布自测，不能用原始弱哈希分数造成少数Gate热点。

### Component

Component用于组合状态和领域能力。创建Entity时由Factory决定挂载哪些Component，运行时通过`AddComponent/GetComponent/RemoveComponent`管理。Handler不必依赖单一Component，可以协调玩家身上的多个Component。

生命周期采用“默认可选，声明后强约束”。稳定Model通过`@lifecycle({ awake, destroy, deserialize })`声明对应Hotfix System必须实现的业务钩子；未声明项不要求空方法。迁移继续以`@transferable()`作为唯一能力标记，并要求同步`CaptureTransfer/RestoreTransfer`。`codegen:scenes`在构建期检查声明与System实现；`verify:runtime-contracts`还会拒绝所有保留生命周期名上的`async`或Promise返回类型。Hotfix提交会在修改活动prototype和Handler槽之前预检候选自己的`Awake/OnDestroy/Deserialize/CaptureTransfer/RestoreTransfer`，缺失或异步实现会拒绝整个候选并保留旧generation；运行时返回值检查只作为最后兜底，并会观察意外Promise的拒绝，避免未处理拒绝丢失诊断。Core继承到的空`Awake/OnDestroy`不能冒充业务实现。

推荐业务链路是：

```text
C2M_UseItemHandler
  -> PlayerUnit或ItemComponent领域方法
      -> ItemComponent修改库存
      -> Position/Skill等其他Component响应业务结果
      -> MapComponent选择同步方式
```

不要为了扁平调用增加只转发一次的Sink或Delegate层。

### Component拥有的子对象

Component既是能力组合点，也是某类子对象集合的唯一所有者。Core提供`AddChild/GetChild/TryGetChild/GetChildren/RemoveChild`，统一维护Component所有权索引、EntityRoot、Timer和级联销毁；业务Component不再重复手写一套生命周期Map。

子对象是否继承Entity取决于它是否真的具有独立身份和生命周期，而不是为了统一外观：

- 道具实例拥有稳定`ItemId`，并可能有强化、耐久、绑定、随机词条、交易锁等独立状态，适合成为`Item extends ChildEntity`。Buff和进行中的Quest在具有独立生命周期时使用同一语义。
- `QuestComponent`只为当前进行中的任务创建Quest子Entity；初始可以为空。任务完成时删除Quest，并把稳定的Quest配置ID写入已完成集合。已完成记录不是运行时Entity，可按规模使用Set、位图或持久化索引。
- 金币、材料数量等没有实例差异的数据使用整数、Map或Numeric，不为每个值创建Entity。

运行时对象、协议快照和持久化记录必须分开命名：`Item`/`NativeItemRef`表示运行时权威对象或句柄，`ItemSnapshot`表示跨边界副本，`ItemRecord`表示数据库记录。不要用`ItemDB`同时承担三种语义。

ChildEntity拥有稳定`Id/InstanceId`并进入EntityRoot，但没有mailbox、网络地址和跨Process路由能力。它带有独立名义类型标记，`AddChild`在TypeScript编译期和Runtime创建边界都会拒绝普通Unit伪装成ChildEntity。它的Parent是所属Component，DomainScene仍是玩家所在地图。其Awake必须同步；Component删除或玩家下线时，Core按所有权链自动取消Timer、销毁子Entity并移除Root。

领域边界采用“可以读取对象，集合变化经过拥有它的Component”：单个Item/Buff的局部规则写在自身Hotfix System，新增、删除、转移、堆叠合并和对外同步由所属Component协调。Native可变句柄只在对应System内部使用，不得跨`await`或所有者生命周期长期保存。

Buff需要被AOI玩家看到，不代表Buff需要mailbox，也不需要通用dirty Delta。Buff创建/删除分别使用不可覆盖的`BuffAdded/BuffRemoved`事件；进入AOI时公开Buff随Unit整体Snapshot发送，离开只移除Unit。公开`BuffPublicView`与受限`BuffDetailView`是两套Projection：前者发给AOI观察者与队伍，后者只发给自己与队伍，不能用字段值`0`表达无权限。详情以`(unitId,buffInstanceId)`为latest key，同帧可覆盖。业务只组合逻辑`ClientAudience`，`ClientBroadcast`负责UnitId到Gate及跨地图Location解析。Buff Tick只执行Action，不同步Buff本身：Numeric、Move及其他效果走各自领域协议。少量Buff可使用ChildEntity Timer；大量Buff应由BuffComponent使用到期时间堆和一个最近到期Timer合并调度。

战斗伤害入口已经统一到Unit上的`CombatComponent`：Monster、Skill和Action只提交`DamageRequest`，CombatComponent依次执行显式允许的`CombatEvents.BeforeDamage`同步只读规避链、目标侧倍率、已注册护盾，最后修改`NumericType.CurrentHp`并返回`DamageResult`；治疗使用`ApplyHealing`并由CombatComponent限制`MaxHp`。普通伤害默认不可规避，只有攻击来源设置`canBePrevented: true`才会分配Unit本地`attemptSequence`并进入扩展链；非零返回值作为不透明`preventedReason`透传，Core不解释闪避、格挡、招架或任何具体命中表。规避不消耗护盾、不扣HP，也不发布已提交伤害事实，但地图仍向参与者发布`G2C_CombatResult`以表现未命中结果。`ChangeNumeric(CurrentHp, ...)`不再保留兼容语义，配置codegen、`ActionFromConfig`和运行时执行都会拒绝；HP增加只能使用`Heal`，HP减少只能使用`DealDamage`。伤害入口严禁查询或调用`BuffComponent`，Buff只能在添加/移除生命周期中注册或注销`DamageAbsorber`，保存`modifierId`而不是让Buff和Combat各维护一份护盾剩余量。MonsterComponent负责找目标、距离、AI、仇恨和重生，不能直接写目标HP；Combat不负责AOI、Gate、目标选择或Unit销毁。完整规则见[战斗伤害与效果管线](../design/combat-damage-pipeline.md)。

Quest默认是玩家私有状态。`QuestComponent`拥有进行中的`Quest ChildEntity`和已完成配置ID集合；活动任务显式区分`InProgress/ReadyToTurnIn`，接取时冻结目标ID与要求数量，配置Reload只影响后续新任务。怪物击杀、道具成功使用和AOI Attach完成后只同步发布`QuestEvents.Progress`领域事实，稳定Hotfix事件Handler再调用`QuestComponent.ApplyProgress`；组件按`(ObjectiveType,TargetConfigId)`运行时索引定位目标，索引不传送、不持久化并从Quest快照重建。接取统一经过`QuestEvents.BeforeAccept`同步Veto，配置内置前置任务与最低等级最终校验。进度使用以QuestConfigId为key的owner-only latest消息；登录、重连和跨地图传送携带活动Quest与已完成ID全量快照。领取必须在PlayerUnit有序mailbox内等待DBProxy关键事务：Inventory先用`PlanGrantItems`在纯快照上规划，`PlayerPersistenceComponent`原子提交奖励后的inventory+quest记录和业务结果，确认后才`CommitGrantPlan`、写完成记录和RemoveChild，最后广播。失败时Entity保持原状；ACK丢失时按稳定operationId读取首次回执并补齐内存，不重复发奖。当前事务Planner只接受`GrantItem`，新增Heal/Buff等事务奖励必须先提供对应纯数据Planner，组队共享任务等待Party系统。完整设计见[任务系统设计](../design/quest-system.md)。

### 领域设计规则与开发助手

业务系统设计先查[`docs/patterns`](../patterns/README.md)。其中用稳定规则编号描述所有权、Entity形态、Audience、状态复制、生命周期、Timer和数据位置；这些文档是人类可读的设计依据，不是自动生成的业务代码。

TiangZ Developer Tools `v0.15.0`把可机械判断的部分固化到不依赖VS Code的共享核心，并向上提供设计向导、`@tiangz`聊天解释、`tiangz-design` CLI、只读`tiangz-design-mcp`和Runtime Foundation诊断。相同结构化输入必须得到相同确定性结论；AI模型只在用户主动聊天时解释报告，不能改变规则结论、虚构API，或把普通业务引向Core、Rust Runtime和Generated。主工程固定依赖该Tag，`verify:design-rule-sync`只要求design-core与`docs/patterns`规则ID集合、归属文档和文件路径完全一致；源码规则执行由`check:project`、`verify:hotfix-boundary`和专项自测负责。

这套助手用于降低开始设计时的心智负担，不取代工程事实。权威顺序仍是：当前代码与测试、项目检查和生成锁，高于设计报告；发现规则与真实实现冲突时，应修正规则库和对应测试，而不是让AI临时圆回来。

### Rust Entity Store（历史上也称Rust Arena）

它表示Rust侧集中保存Entity数据的仓库。TS持有带generation的handle，通过生成的Native Ref和Fast Op访问；对象删除后旧handle被拒绝。`Arena`只是可选实现术语，不是Rust语言关键字，也不是业务开发必须直接使用的API。

当前长期方向是：Rust拥有高频、跨帧Entity/Component权威状态；TS保留Handler、Actor mailbox、Component组合和热更业务语义。

## 线程、Update与定时器

- Tokio负责网络和宿主异步任务。
- 每个Process的TS业务代码只在一个V8线程执行。
- Runtime Pump处理宿主事件和mailbox。
- Game.Update默认固定`50ms`，即`20Hz`。
- Grid2D客户端移动输入的持续心跳默认每`500ms`一次，即`2Hz`；按下、转向和松开必须立即发送，静止时不发送周期Move。容量基线的`C2M_MapProbe`默认每5秒一次，即`0.2Hz`；客户端SDK的`C2G_Ping`同样每5秒一次。三者用途不同，均不能改变20Hz服务端权威推进、AOI同步档位或客户端渲染频率。
- 每个固定帧严格执行`Update -> LateUpdate -> FrameFlush`。
- `Update/LateUpdate/FrameFlush`必须同步，不得返回Promise。
- 需要异步顺序的工作应通过消息或Actor定时器重新进入mailbox。
- Component和ChildEntity定时器在所有者销毁时自动取消；挂在Actor下时回调遵循该Actor mailbox。
- 所有者Timer返回唯一`TimerId`，支持原样业务参数和主动取消方法；取消至多通知一次，Owner销毁时静默清理。
- `FrameTime`是不可持久化单调时间；活动时间和跨重启截止时间使用`ServerNow`及deadline helper。业务需要协议时间戳时调用`TimerSystem.ServerTime()`取得当前Unix毫秒；框架不再提供容易被误解为Entity Component的`TimerComponent`别名。
- `Scene.Locks`提供`Scene InstanceId + domain + key`的本Process FIFO协程锁，不是分布式锁；跨Process先路由到唯一所有者。无竞争锁必须同步进入回调，保证第一个`await`前建立的传送屏障等状态不会被后续unordered消息抢跑。
- Developer Tools会检查StartMachine实际部署集合中的`process.identity`、Timer方法名与取消回调、同步/Veto Scene Event契约，以及`InstanceId/TimerId`误入持久化结构；仓库级`verify:runtime-contracts`进一步用TypeScript类型信息检查拥有者Timer的方法名字面量、目标存在性、参数和`onCancelled`签名。这些规则与Runtime Foundation自测共同守住业务侧用法。
- 纯TypeScript进程内自测统一由Vitest的fork池执行，保持每文件模块隔离并允许文件并行；依赖生成游戏配置的用例在worker启动前由带跨进程锁的`globalSetup`完成codegen。覆盖率范围是完整`app/core/**/*.ts`，不是只统计本轮改动文件；端口、子进程、Cargo、Runtime与故障注入仍由统一矩阵中的隔离步骤验收。
- `Scene.Events`只处理当前Scene的同步通知和同步否决链；框架不提供异步Event。`SyncEvent`用于事后通知，失败只记录；`VetoEvent`用于操作前只读检查，按`order/id`稳定排序并返回第一个非零错误码。监听器按`scene.constructor === registeredConstructor`精确匹配，给基类登记不会作用于子类；若未来需要继承语义，必须显式设计去重、顺序和Veto行为。监听器是Hotfix稳定绑定，不为每个Entity动态注册闭包。跨Scene必须使用Message/RPC。
- `Scene.Tasks.Spawn`只承载调用方明确不等待的有界短任务：每个Scene最多256个在途任务，超过10秒仍未结束会记录一次告警；错误统一记录，ProcessHost聚合入口Scene和动态MapScene的在途任务并阻止Hotfix提交，Scene销毁更新TiangZ轻量`signal.aborted/reason`。它不依赖浏览器`AbortController`，也不能替代Veto、Timer、事务、ordered mailbox或需要结果的RPC；永久任务会持续占用容量并永久阻塞Hotfix。

`verify:runtime-contracts`同时检查`tools/*_self_test.ts`都有同名Vitest包装。测试配置生成缓存位于`temp`，在生成锁内比较配置源、生成器、Luban工具链和完整输出的内容指纹；只有全部未变才跳过Luban，显式codegen仍完整生成。

`await`只释放当前异步调用，不会让JavaScript获得多线程并行。是否允许同一业务目标重入，由目标mailbox决定。

所有Entity均具有业务`Id`和本次生命周期`InstanceId`。永久Item等实体使用`GlobalId bigint`；数据库保存`Id`并丢弃`InstanceId`。`GlobalId`编码永久`originServerId`，同服并发Process由`workerId`隔离；Watcher在整套StartMachine启动前拒绝重复组合。完整语义见[运行时基础能力](../design/runtime-foundations.md)。

## Scene发现和跨进程调用

配置中的`scenes`表示当前Process实际启动的EntryScene，`knownScenes`表示当前Process可以路由到的完整目录。目标可以位于本进程或其他进程。

业务调用规则：

- 唯一实例：`scenes.callOne("Rank", descriptor, request)`。
- 多实例：`scenes.many("Gate")`后由业务选择，再`call(target, ...)`。
- 已绑定实例：按保存的Scene name执行`byName`和`call/send`。
- 单向通知使用`send`，不要伪造无意义的Response。

同Process调用直接进入目标mailbox；跨Process调用使用持久Inner TCP和`rpcId`多路复用。某个RPC等待Response时不会阻塞同连接上的其他RPC。

Location Scene已经负责`UnitId/account -> Gate/gateEpoch/MapHost/MapInstance/ActorInstance`的跨进程权威定位，并以revision、operationId和`active/moving/removing`状态保护迁移、Gate接管与下线。普通客户端Actor消息仍走Gate本地连接路由缓存，不逐消息查询Location；帧携带gateEpoch，在真实PlayerUnit邮箱入口执行fencing。Location内存进程可由MapHost周期重报恢复；Watcher确认同机静态MapHost已退出后，新进程可用更高所有权代次删除旧Actor路由。当前仍无跨机器租约仲裁、在途事务日志或动态副本现场恢复。详见[Location与玩家Actor路由](../design/location-routing.md)。

## 协议模型

外层网络帧固定为：

```text
[length: u32 big-endian][msgcode: u16 big-endian][protobuf payload]
```

Rust负责length-prefix分帧，并把不含length的二进制帧批量交给TS。TS根据msgcode取得descriptor，完成protobuf decode、Handler分发和response encode。

`rpcId`不是帧头字段，而是`IRequest/IResponse`的payload字段，由生成代码和RPC框架处理。单向`IMessage`不需要rpcId。

消息层级参考ET但不硬套：

- `IMessage`：单向消息。
- `IRequest/IResponse`：普通RPC，通常以连接或EntryScene为目标。
- `IActorMessage/IActorRequest/IActorResponse`：明确Actor目标。
- `IActorLocation*`：由玩家位置路由到具体Unit。

消息编号按proto文件起始编号和定义顺序生成，并由`opcode.lock.json`与`schema.lock.json`锁定。已有消息始终沿用lock编号，删除消息的编号永久保留，新消息自动跳过保留号。生成器负责请求响应关联、descriptor、codec、客户端Client和Handler导入，不让开发者手工维护msgcode表。

## 状态复制模型

TiangZ明确区分三种语义：

| 类型 | 用途 | 行为 |
|---|---|---|
| Snapshot | 进入视野、重连、主动全量同步 | 发送完整当前状态，不修改Dirty |
| Delta | 位置、Numeric、速度等可覆盖状态 | 字典或字段级置脏，帧尾Peek/Send/Ack |
| Event | 技能、道具、掉落、伤害事实 | 立即可靠排队，不允许latest覆盖 |

Numeric使用`NumericType -> i64`动态字典与dirty表，TS边界是`bigint`；创建Numeric时第二个参数也是按`NumericType`索引的初始化字典，`NumericInitialValues`只是它的类型别名，不维护逐字段接口。`NumericComponentSystem.Awake`只遍历创建者传入的字典并挂载Rust存储，不猜测玩家、怪物或NPC默认值；未传入的普通Numeric保持Rust默认值`0`。`MaxHp`、`Attack`、`AttackSpeed`、`MoveSpeed`等1000..9999派生结果由`result*10+1/+2/+3`的Base/Add/Pct来源自动重算，不能直接赋值；初始化只能写普通属性或Base/Add/Pct来源。`AttackSpeed`表示毫秒/次，`MoveSpeed`在Numeric中表示毫米/秒，配置表仍使用米/秒。Numeric复制按类型拆成三个独立latest源：未列入AOI白名单的MP、经验、攻击和派生来源只发Owner；`CurrentHp`保留服务端10Hz资源计算精度，旁观者的AOI公开状态每20个20Hz地图Tick最多发布一次，即1Hz；受击者和有效攻击者不等待这个窗口，而是通过只含参与者的私有`G2C_CombatResult`事件立即收到精确`CurrentHp`、实际伤害/治疗和`serverTick`。`Level/MaxHp`只在真实变化时立即发布。HP跨越0的死亡和复活是紧急变化，必须绕过1Hz窗口立即发送。三个源使用带筛选策略的独立ACK令牌，任一源成功都不能清除其他类型的dirty。地图帧尾会让Native一次遍历Numeric脏字典并生成三份策略结果；TS只把结果分别交给三个latest通道，某一源已有未ACK结果时不会覆盖它。初始AOI快照使用相同公开投影，Owner自己的登录与重连快照仍保留全量Numeric；客户端按`serverTick`拒绝晚到的旧AOI快照，避免旁观者latest包回退参与者刚收到的私有血量。Unit固定字段使用`.native @replicated + @memberId`生成`u64` dirty mask；技能、Buff、道具和伤害事实仍是不可覆盖Event，不参与Numeric节流。

帧尾复制采用`Peek -> Send -> Ack`：只有涉及的全部Gate路由发送成功才确认revision，发送失败保留Dirty，发送期间的新修改不会被旧Ack清除。Audience只决定收件人，数据Projection决定字段权限，Broadcast descriptor只决定event/latest语义。业务使用只含UnitId的`ClientAudience`；物理`BroadcastAudience`和Gate route是Core内部类型。

AOI已由Rust扁平X/Z Grid接管。Cell是移动和空间数据的基础单位，AOI关系只在跨Grid边界时重算；默认一个Grid为15×15 Cell。`UnitId -> EntityIndex`哈希只在API入口使用，实体元数据与Audience签名按EntityIndex连续存放。Grid成员默认使用紧凑EntityIndex数组；128人以上的热点Grid额外建立成员位图，降到96人以下释放。空间候选和最终可见关系使用双向连续位图；Rust同时保存本帧净变化和用于共享编码的增量Audience签名，TS不得建立镜像关系表。密集迟滞Audience按`Grid + 最终受众签名 + 强制发送状态`共享一次受众计算，再按实际受众合并编码；业务不得依赖签名或管理该缓存。业务只从`MapComponent.Audience`取得`ObserversOf/VisibleSubjectsOf`；显式Invalidate返回的变化必须交给`MapComponent.PublishVisibilityChanges`统一发布。Prometheus提供当前迟滞与拒绝关系Gauge。`single-grid`是稳定全可见广播基线，`same-point`是高频跨Grid迟滞压力测试，两者不能混为容量曲线。完整分层、代码范例和Demo位置见[AOI完整设计](../design/aoi-architecture.md)。

AOI Enter/Leave发布在同一批次内按`ObserverId + SubjectId`保留最终可见状态，并保持首次关系出现顺序；同一关系在拥塞期间发生的中间抖动不会生成无效的Enter/Leave帧。这个合并只作用于尚未可靠发布的空间关系，不得套用到背包、伤害、掉落等不可覆盖业务Event。

Rust按最终Audience编码Movement、Numeric和UnitState。`BroadcastHub`以`descriptor + audience + Gate route`建立独立频道；一个慢Gate只能阻塞自己的single-flight，不能再让同一逻辑受众中的快Gate等待。同一次逻辑发布投向多个Gate时共享一份不可变编码帧，不能把编码成本乘以Gate数量；只有某个Gate积压的latest与后续状态合并、最终项集合发生分歧时，才为该Gate重新编码。`event`进入每Gate有界可靠FIFO，队满显式失败；`latest`每Gate只保留最终状态，待发送版本被更新版本接管时旧发布Promise立即完成，当前最终版本仍在真实发送成功后完成。latest频道同时限制待发item数、编码字节数和最大等待年龄，越界显式拒绝并保留可重试Dirty，不允许静默丢失关键事件。

`SceneBroadcastTransport`在同一同步Game Tick内按`Gate + delivery class`重组：`1=reliable event`、`2=replaceable latest state`，两类不能合进同一内网批次。Gate不解码业务payload，只完成Unit到connection的路由与下行扇出，并按`RPC/control response -> reliable event -> latest state`顺序排空三个出站队列；最终客户端TCP连接仍共享，Host继续在同一Update结果中批量写出并保持客户端frame边界。Movement和Numeric热路径由Rust利用Attach时登记的紧凑delivery route直接生成每个Gate的完整`S2G_ClientBroadcastBatch`帧，route header同时携带该Gate的itemCount，TS每Tick只映射至多Gate数量的routeId并原样投递。`SendRouteFrames`在同一微任务边界合并同Gate latest外壳；非成功投递不会触发共享revision ACK。Numeric领域层传入AOI白名单、类型筛选策略和发布窗口；Rust不拥有回血或战斗规则。业务层不得管理routeId、调用底层route-frame Native op、调用`sendFrame`，也不得直接构造内网广播协议。

Inner Transport把跨进程调用流与单向广播流分成独立的管理器、连接和socket writer队列；调用流保留固定容量，连续处理调用达到公平阈值后必须让广播流获得调度。任一有界阶段满载时立即返回`SceneOverloaded`语义的明确错误，不创建或残留RPC pending waiter；单向广播不进入RPC pending表。overload与timeout同时按msgcode、source、target、traffic和queue stage投影到健康指标，诊断维度有固定上限，不能用无限增长的标签记录故障。

目标Process入口同样不是单队列：`eventQueueCapacity`总量按1:3划分为控制流保留队列和数据流队列，内部RPC、断线、Host completion与shutdown进入控制流，内部单向帧进入数据流；连续处理32个控制事件后必须给数据流一次机会。控制流队满时，网络宿主直接按原`rpcId`返回`[scene-overloaded]`，不把请求留在来源进程等待deadline；`queueStages`同时保留原`frame/completion/disconnect/shutdown`统计，并增加`control_ingress/data_ingress`物理队列统计。Disconnect允许越过旧数据帧，因此EntryScene在收到断连时建立30秒有界墓碑，丢弃同连接随后浮出的残留帧并记录`connection_ingress.dropped_frames_after_disconnect_total`，不能把这些已无法响应的帧重新解释为ActorLocation业务错误。这个调度类别只管理Rust宿主入口容量，不改变仍存活连接的Scene、Actor或mailbox业务顺序。

可覆盖的高频ActorLocation单向输入可以在协议注解中声明`forwarding=latest`。Gate按`connectionId + msgcode`保留20ms窗口内的最终帧，再按目标Scene编码为Core内部ActorLocation批量帧；目标Scene解包后，每个条目仍通过原Actor Registry进入对应Unit mailbox，因此不绕过Actor顺序边界。该策略只允许用于Move这类“旧意图已无意义”的单向消息，RPC、道具、交易、技能释放和其他不可丢业务事实禁止声明；`actor_latest_forward`指标记录queued、coalesced、forwarded、batches、failed和dropped。

## 地图空间契约

`0.4.0`冻结服务端地图局部坐标为米制`X/Y/Z + Yaw`：X/Z是地面平面，Y是高度，Yaw是绕Y轴弧度，Yaw=0朝+Z，前向量固定为`(sin(Yaw),0,cos(Yaw))`。坐标必须和`MapInstanceId`一起解释，不建立跨大陆的巨大浮点世界坐标。protobuf与Native schema使用普通`float/f32`，客户端适配层再转换为具体引擎坐标。UE边界使用`(X,Z,Y)×100`和`90°-TiangZYaw`转换；协议状态不能保存或回传UE原生`FVector/FRotator`。

玩家跨MapHost使用稳定protobuf `PlayerTransferSnapshot`。生成端和目标校验端统一引用`PLAYER_TRANSFER_SCHEMA_VERSION`；新增Buff、Skill等可传送Component或修改传送字段时必须显式升级该常量，并通过真实跨图Runtime smoke，不能在两处手写不同版本号。

`MapConfig.SpatialMode`区分`Grid2D`与`NavMesh3D`。Grid2D运行在X/Z Cell上；NavMesh3D固定官方Recast/Detour `v1.6.0`，具备确定性灰盒、v2压缩高度层资源、SHA-256元数据、Map启动装载、Rust投影/寻路/射线/高度和动态障碍。相同资源的MapInstance共享不可变高度层模板，各自独占`dtNavMesh + dtTileCache + Query`、路径、AOI和Unit空间状态；Scene销毁通过`SpatialRelease`幂等释放。动态障碍只表示门、路障等业务物体，不包含角色或怪物之间的动态阻挡与动态避让。业务用稳定地图内`ObstacleId`调用`MapComponent.UpsertNavigationBoxObstacle/RemoveNavigationObstacle`并提交真实物理盒体，Rust按烘焙`agentRadius`扩张X/Z导航占用、合并目标状态并按Tick限制命令和Tile重建；业务不得重复增加半径。提交完成后未结束的点击路径自动重算。`C2M_FindPath`只查询，`C2M_NavigateTo`提交路径目标，`C2M_NavigateInput`提交相对朝向的离散方向；PlayerUnit先用服务端`DirectionalMovementProfileComponent`把最终`MoveSpeed`换算为当前方向的有效速度，再由Rust保存输入、先连续转向并在每个20Hz Tick通过`moveAlongSurface`贴地推进，同时缓存Unit当前polygon引用。客户端采用相同的路径转向预测，并每500ms续期1.5秒方向输入租约；断续期后Rust自动停止。Cocos 3D与UE 5.4.4均以`E`键调用同一个动态门RPC，并且只在服务端响应后更新红门表现；Cocos为本地预测增加表现约束，UE只插值权威位置，客户端门Actor均不参与权威导航计算。权威位置以`G2C_EntityNavigate`按AOI批量广播。完整约束见[地图空间与3D坐标契约](../design/spatial-world.md)。

Grid2D同时区分两种意图：玩家方向输入保持连续按键语义；服务端AI通过`UnitSetGridMovementTarget`提交最终Cell。Rust Unit保存最终目标，在每个Cell完成的同一固定Tick计算下一步，并在最终Cell清除移动，不依赖5Hz AI恰好采样到到达瞬间。怪物、NPC和召唤物共享该MMORPG能力；外置游戏模块仍只配置坐标、速度、路线与行为，不向Core或Native层注入具体地图规则。上层AI必须缓存未变化的导航目标，避免重复提交导致NavMesh路径重算或路线重启。

动态障碍的可见状态不能只放在请求者的RPC响应里。地图状态变化时，业务必须向当前地图所有在线客户端广播状态事件；客户端完成`MapSnapshotReady`时还必须从响应读取当前状态，避免“后来进入的玩家看不到门，但服务端仍然阻挡”的分叉。`G2C_DemoDoorState`是灰盒演示的具体例子，正式门系统应沿用“进图全量状态 + 变化事件”的模式。

## 客户端与Transport

`client_sdk/typescript`是TypeScript Client SDK唯一源码，codegen将正式协议副本分发给Cocos和Pixi；`client_sdk/cpp`是C++ SDK唯一源码，Proto生成无Google protobuf runtime依赖的C++20结构、Codec和类型化描述符，再由`codegen:cpp-client-sdk`分发到UE 5.4.4插件；`../TiangZ-Examples/clients/godot-3d-4.7.1/scripts/generated/tiangz_proto.gd`由`codegen:godot-client-sdk`从Proto生成，`scripts/tiangz_client.gd`和`main.gd`只维护Godot连接流程与表现适配。所有客户端SDK Core都不能依赖其他引擎；平台只实现Transport、Update驱动、坐标和表现适配。UE和Godot当前只支持WebSocket，TCP/KCP未实现时必须立即报错。

当前验收范围：

- Cocos Web：WebSocket。
- PixiJS/H5：WebSocket。
- Cocos Native Windows：TCP/KCP。
- Godot 4.7.1：WebSocket。

服务端将I/O Backend和Endpoint协议分成两个维度：epoll/io_uring负责操作系统I/O，TCP/WebSocket/KCP负责传输协议。不支持的平台选择KCP等Transport时应立即报错，不能静默降级。

客户端RPC使用生成的`LoginMgrClient/LoginClient/GateClient/MapClient`。服务端Push使用独立`@clientMessageHandler`，避免把所有监听堆在一个构造函数中。网络回调只入队，客户端游戏循环调用SDK的`update()`进行分发。

## 目录所有权

```text
app/core/                    TypeScript框架
app/core/public.ts           业务唯一Stable Core API入口
app/model/                   不可热更的状态、稳定类型与启动结构
app/model/mmorpg/              当前MMORPG演示的稳定类型和状态
app/model/bench/             仅由build:bench装配的稳定基准结构
app/model/public.ts          Hotfix唯一允许导入的Model入口
app/hotfix/                  可热更的Handler和领域方法实现
app/hotfix/mmorpg/             当前MMORPG演示的可热更行为
app/hotfix/bench/            仅由build:bench装配的压测Handler
app/generated/               服务端与Native自动生成代码
app/generated/bootstrap/     自动生成的Model Scene启动入口
app/generated/hotfix/        自动生成的Hotfix Handler和补丁入口
src/                         Rust Runtime、Transport和宿主
src/generated/               Rust自动生成代码
proto/                       protobuf唯一源文件
game_config/                 Luban Excel游戏配置唯一源文件
native_data/core/            框架内置Entity op原型，业务不得修改
native_data/<game>/          游戏Entity和粗粒度Native op原型
client_sdk/typescript/       引擎无关TS SDK唯一源码
../TiangZ-Examples/clients/cocos_client2D_3.8.6/.../Demo/     Cocos业务和表现
../TiangZ-Examples/clients/cocos_client2D_3.8.6/.../Generated 自动分发SDK和Handler入口
../TiangZ-Examples/clients/cocos_client3D_3.8.8/              Cocos Creator 3D灰盒客户端；Generated/SDK自动分发，Demo脚本只做登录、查询与显示
../TiangZ-Examples/clients/ue_client3D_5.4.4/                 UE 5.4.4 C++插件与灰盒客户端；ThirdParty SDK由codegen覆盖
../TiangZ-Examples/clients/godot-3d-4.7.1/              Godot 4.7.1 GDScript WebSocket灰盒客户端；协议层由codegen生成
../TiangZ-Examples/clients/pixi_client_8.19.0/src/             Pixi业务及SDK验收
configs/<environment>/       环境、Process与Scene正式部署配置；一个子目录对应一套可复制部署包
configs/bench|tests|experiments/ 压测、自动测试与传输实验配置
tests/fixtures/              不进入生产运行时的确定性回归数据
perf/                        性能与长稳工具、历史报告
tools/                       codegen和工程工具
tools/support/               冒烟测试和压测共享的低层协议辅助，不属于业务API
docs/                        教程、参考、设计和阶段记录
docs/patterns/               MMORPG领域设计原则与稳定规则编号
```

Generated目录禁止手工编辑。新建平级游戏目录时，codegen通过`codegen.config.json`的搜索根发现Scene和Handler，不维护手工类型表。

游戏静态配置与部署配置严格分离：`configs/<environment>`只描述Machine、Process、Scene、端口和Runtime参数；`game_config`保存策划维护的Luban Excel。仓库固定Luban `4.10.2` CLI，按`c/s`分组生成服务端Model类型、客户端SDK类型和独立JSON数据包。表、字段、类型、分组、索引和引用关系属于绝对不可热更的Model；数据重载策略由`ConfigTablePolicy`按整表声明，不能在一张表内混合Hot/Cold。当前ItemConfig、PlayerConfig为Hot，MapConfig、AoiConfig、AoiSyncTierConfig和策略表为Cold。生成包同时携带完整/Hot/Cold数据及指纹；Rust验证三者分区一致，TS拒绝Cold指纹变化。只有 Hot 数据可随完整 Hotfix + 配置候选，由 Runtime 在帧间原子提交，Cold任何值变化都必须完整构建并重启Process。业务统一通过只读`GameConfigs.Xxx.Get/TryGet/GetAll`读取，不直接解析Excel/JSON，不长期缓存整行对象。Reload不重跑Awake、不回写既有Entity状态，旧引用仍指向旧快照。客户端配置仍随SDK发布，服务端Reload不会远程替换Cocos/Pixi数据。

AOI可见密度与内容刷点密度是两份独立数据：外置内容包拥有模板和刷点，Core的`MapConfig -> AoiConfig/AoiSyncTierConfig`只拥有观察范围、迟滞边界和同步频率。奇数范围边长`N`以观察者Grid为中心，每侧半径为`(N - 1) / 2`个Grid；地图应按物理Cell尺寸和目标可见距离选择Cold AOI配置。发现“附近实体太少”时不得复制刷点、扩大导入区域或增加地图分支来掩盖过小的AOI。通用`Large World AOI`是可复用配置数据，不包含任何游戏、种族或区域规则。

游戏配置命令区分启动包与在线联合候选：`npm run build:game-config:startup` 等价于完整 `npm run build`，配套生成 Model、Hotfix 和 `dist/game-config`；`npm run build:game-config` 等价于 `build:hotfix`，生成携带完整配置的 `dist/hotfix-candidates/<releaseId前16位>`，由 `reload` 提交。低层配置打包器产生的 `game-config-candidates` 仅为构建暂存，不可单独在线提交。

`.native`是codegen输入而不是生成物。框架通用ABI只放`native_data/core`；游戏新增Rust批处理能力时在`native_data/<game>/XxxOps.native`声明，生成器聚合产生Rust Extension、Host bootstrap和TS `NativeOps`。状态机黄金数据属于`tests/fixtures`，禁止混入原型目录。

正常`npm run build`装配Demo的Model与Hotfix双Bundle；压测入口必须使用`npm run build:bench`显式加入`app/model/bench`和`app/hotfix/bench`。服务端`app/generated`不再生成客户端协议副本，工具和性能测试统一从`client_sdk/typescript/Generated`导入。Developer Tools 的 `tiangz.hotfix.instance-state` 诊断会在编辑器中拦截Hotfix行为类字段、构造函数和静态执行状态；日常改动先用`npm run verify:fast`反馈。

Bench Hotfix可以通过`#tiangz/model`调用稳定业务API来测量生产路径，普通Demo不得反向依赖Bench。`app/model/main*.ts`与`app/hotfix/main*.ts`分别是两层组合入口；根`app/main*.ts`只保留源码兼容入口。Developer Tools与`tiangz-check-project`共同强制依赖方向。

Actor Runtime只负责Scene、Session、ActorUnit的InstanceId路由与mailbox；普通Unit由`UnitComponent`本地拥有。旧式`@handler("字符串")`、动态组件Handler hooks和`ProcessHost.call/send`已移除；`@unitRpcHandler/@unitMessageHandler`只能绑定`ActorUnit + @actor`，批量MonsterUnit的业务入口由Map Handler转入其所属Component。

测试和压测专用的裸帧构造、响应解码、Fake与Fixture必须放在`tools/support`、`perf`或对应测试文件中，禁止放入`app/core`或`app/<game>`。正式客户端能力只能进入`client_sdk`及其Generated分发目录。

Model业务代码只能从`app/core/public.ts`导入Core能力；`app/model/main.ts`是宿主启动桥接例外，只负责Runtime启动、更新、停止和Host事件转发，不是业务代码模板；Bench代码仍必须使用Stable入口。Hotfix只能从`#tiangz/model`取得Model与Stable Core API，不得深层导入。`public-api.lock.json`以schema 3记录Stable导出、顶层签名和完整可达`.d.ts`声明图；开发阶段`verify:core-api`仍检查边界和自测，但不强制快照锁，准备发布时由`npm run verify:release`开启完整比较。Hotfix第一代冻结Handler key集合，后续只能替换既有实现，新增、删除或重命名Handler必须重启。Native Store诊断是Rust Core正式配置`process.observability.nativeData`，由Rust负责默认值和校验；Native数据原型本身、io_uring和部分KCP能力仍按专项文档视为Experimental或平台限定。公共API变化必须提供迁移记录，并同步更新本文和AI业务开发手册。

ordered Scene mailbox的同步排空使用循环而不是递归，长串同步消息不会耗尽V8调用栈；这不改变单Mailbox串行语义。缓存和索引必须归属于Scene/Component等明确所有者，不能放在Hotfix模块级可变变量或全局单例中；配置Reload时按指纹在所有者内懒重建。

## 已完成阶段

- Phase 0：Rust/deno_core/TS构建、目录、配置、proto codegen和错误码。
- Phase 1：二进制协议、RPC、同步/异步Handler、Inner TCP多路复用、背压、Inspector和基础性能验证。
- Phase 1.11：统一为一Process一V8、多EntryScene，本地/远程调用语义一致。
- Phase 2：登录到地图纵向链路、GateSession、Unit、多人移动和客户端可见。
- Phase 2.12：固定Game.Update、TimeSystem和游戏定时器。
- Phase 2.13：Rust权威实体数据、generation handle、Native op codegen和Rust直接protobuf广播。
- Phase 3：可复用TypeScript Client SDK及Cocos/Pixi/Cocos Native验收。
- Phase 3.5：Numeric字典、固定字段dirty mask、Item Event和通用状态复制基础。
- Phase 3.9：协议锁、64位无损bigint、Watcher优雅停机、质量门、双语注释和长稳工具。
- Phase 3.10.1：项目版本身份、Stable Core入口、API锁、依赖方向检查和独立业务夹具。
- Phase 3.10.2：RPC在途id避让、本地/远程timeout、迟到/重复响应与断线/停机清理，以及Actor销毁、旧InstanceId、ordered/unordered正确性矩阵。
- Phase 3.10.3：Process退出、Inner断线、慢客户端、过载、Handler异常、非法帧、重连风暴和保存失败的一键故障注入矩阵。
- Phase 3.10.4：每个 Process 通过健康端口开放 `/metrics`；Prometheus按`StartMachine.json`发现实际Process，Alloy把JSON文件日志送入Loki，OpenTelemetry把采样Span送入Tempo，Grafana统一查询Metrics、Logs与Traces。Core内部Trace Envelope跨Scene/ActorLocation传播上下文，不改变业务Protobuf。`/ready`依赖V8 Runtime心跳，Scene自定义指标显式区分Counter/Gauge，并允许用受限 `labels` 区分同一 Scene 内有限实例；Host 保留标签不可覆盖，无界业务身份禁止进入标签。`verify:observability`验证静态接线，`test:observability:faults`真实验证Gate强杀、动态副本安全回退、故障日志和跨进程Trace。禁止新增业务Observer Scene汇总指标。
- Developer Tools 的运行时查看目前只读取 Process 健康端口的 `/metrics`，用于观察队列、mailbox、pending RPC、Timer 和 Native 摘要；它不执行 RPC、不读取任意 V8 对象，也不改变业务状态。按 UnitId/Actor 查询的只读 Inspector 仍处于协议草案阶段，必须完成 Runtime 端点和权限边界后才能宣称可用。

## 已验证的稳定性事实

2026-07-25的正式长稳样本使用拆分进程、200玩家、每玩家5Hz Move，预热60秒后持续10小时：

- 发送35,999,865次Move，精确序号确认35,999,836次，其余29次被更高序号权威状态覆盖。
- 零错误、零stalled、服务端固定Game.Update零跳帧。
- p50/p95/p99为33.90/61.79/70.04ms。
- Gate和Map后四分之一RSS趋势约为`+0.3MB/h`与`+0.2MB/h`，V8 Heap没有持续增长证据。

详细口径见`perf/results/soak_latest.md`。这是特定机器和全地图可见Demo负载的稳定性证据，不是生产容量承诺。

## 当前未完成和明确暂缓

2026-07完成了[Phase 4前框架成熟度审计](../design/framework-readiness-audit.md)中的R1至R4实现与专项验收。`0.3.10-alpha.5`建立Model/Hotfix双Bundle和在线事务，`alpha.6`加入`@systemFor`和高负载验收，`alpha.7`把Hotfix改为固定脚本名IIFE、统一业务Timer方法名语义，并补齐8秒慢RPC屏障与100代资源长稳。3000玩家A/B已验证1Hz Reload吞吐无可见下降，但Probe p95/p99约增加32%/31%；100代测试中损坏候选被拒绝，Timer、Native实体和pending均无漂移，预热后的V8 Heap/RSS增长通过4MB/16MB硬门槛。Developer Tools `v0.15.0`已作为主工程固定依赖，VS Code、CLI和MCP共享确定性领域规则，并补充运行时基础能力诊断。

性能回归职责必须分层：`verify:perf` 比较三轮中位数吞吐、p99与错误；`test:backpressure` 验证有界队列和生产者等待；长稳测试判断RSS/V8 Heap趋势。不要把短时RSS噪声或故意过载指标混入普通性能基线。

Cocos Demo完整类型检查依赖编辑器生成的`../TiangZ-Examples/clients/cocos_client2D_3.8.6/temp/tsconfig.cocos.json`和`cc`类型，不得把该缓存提交或复制到CI。`typecheck:cocos-demo`在编辑器环境执行完整tsc，在干净Linux/CI环境执行入口bundle检查；引擎无关Client SDK始终由`typecheck:cocos-net`完整检查。Cocos Web构建统一使用`npm run build:cocos3d:web`、`npm run build:cocos3d:mobile`以及对应的2D命令，默认明确传入Release模式；需要调试包时只能使用带`:debug`后缀的命令。脚本匹配Creator版本、清除`ELECTRON_RUN_AS_NODE`、清理并校验标准输出目录，`check:cocos-build`可在不启动编辑器时预检参数。Creator 3.8.x本机已知的`code=36`只有在完整Web产物存在时才接受，其他非零码必须失败。不要手工拼接`CocosCreator.exe --build`，也不要把`library/temp`当作发布产物。Cocos Native必须先生成原生工程，再单独执行CMake/Visual Studio编译。

热更粒度固定为整个Process的TS行为世界，而不是单个Scene，也不为每个EntryScene增加V8。TS分为绝对不可热更的Model和可热更Hotfix：Model拥有字段、构造、继承和稳定类型，Process运行中不存在Model reload API；Hotfix只提交方法与Handler。候选先在隔离V8预检，再在当前V8暂存；第一版暂停入站并等待在途任务归零后原子提交，不做字段migration或双generation长期并存。候选必须包含当前generation已有的完整Handler绑定集合，删除或重命名Handler属于Model/协议路由变化，必须重启；所有Scene/Session/Unit/Event Handler类都禁止字段、构造和可变静态成员，避免实例复用时泄漏共享状态。任何Model/Core/协议/Native schema变化都必须重启Process。详见[热更设计](../design/typescript-hot-reload.md)。

业务行为采用ET风格System表达：`@systemFor(ModelType)`类写`Awake/OnDestroy`和公开领域方法，但不创建实例、不保存字段。codegen把公开方法生成到`app/generated/bootstrap/systems/*.d.ts`并合并回Model类型，所以调用方保持`unit.Move()`的面向对象写法，Model无需手写抛错空壳。运行时仍直接安装prototype描述符，没有逐次Registry查找。System首次安装后为必需项，候选遗漏会整体拒绝；Reload不重跑现有对象Awake，新对象使用新Awake，已有对象后续方法和销毁使用当前generation。

本地开发可使用`npm run dev -- configs/<环境>/<部署包>/StartMachine.json`（当前为`configs/local/cluster/StartMachine.json`）：开发宿主初次完整构建并启动Watcher，随后监听`app/hotfix`和`game_config`源文件，串行构建不可变 Hotfix + 配置联合候选并执行 `reload`。`npm run dev:debug`使用`configs/local/debug/StartMachine.json`和all-in-one Inspector，让初始Bundle与后续Hotfix候选都带内联sourcemap；V8和Inspector连接不重建，VS Code依据新`scriptParsed`重新绑定TS源码断点。暂停在断点时必须先Resume，当前调用栈不做Edit-and-Continue。源码模式不改变生产模型，不监听Model源码，也不允许V8直接执行TS。Model以ESM加载一次，Hotfix以固定脚本名IIFE重复求值，避免ESM ModuleMap和每代脚本URL持续增长。Developer Tools对Model长期状态中的`any`、可选字段、基本类型与`undefined`联合、跨基本类型联合、`delete`和`as any`写入按错误处理；DTO、对象`T | null`、判别联合与显式Map/Record不受影响。

正式Hotfix操作使用`npm run hotfix -- plan/apply/status/rollback`，不再依赖人工向Watcher终端输入命令。Process只有显式配置`lifecycle.hotfixOperations`并从指定环境变量取得非空令牌时才开放管理路由；路由复用健康端口但只接受回环来源和Bearer令牌，禁止经Nginx或公网暴露。CLI校验候选哈希与冻结Model契约，支持`--target`灰度、active/previous状态、operationId审计和单机多Process部分失败补偿回滚。回滚是重新提交previous候选并生成新generation，不是倒退计数。当前不提供跨机器Prepare/Commit；多机需先分发同一内容寻址候选，再登录各机器执行本地目标协调。

Prometheus、Loki、Tempo、Alloy和Grafana已完成本地多Process观测闭环；Linux外网测试部署进一步接入Alertmanager、Node/PostgreSQL/Redis Exporter、Grafana HTTPS认证入口、14天保留期和容器内存上限。最终第三方通知仍需部署者提供Webhook密钥，跨机器Agent与长期对象存储仍属后续；单机观测栈不能被称为生产HA。

Phase 4计划：

- Phase 4.0已完成：Native Unit、protobuf、MapConfig、Cocos 2D和Pixi统一采用米制`X/Y/Z + Yaw`契约；Grid2D使用X/Z Cell，MapScene按实例创建和释放Rust空间状态。此次为显式破坏性协议升级，旧`0.3.10`客户端不能混连。
- Luban游戏配置基础已先行落地：首批`ItemConfig`、`MapConfig`和不含等级成长数据的`PlayerConfig`已接入服务端、Cocos与Pixi；结构固定在Model，服务端纯数据可原子Reload，字段分端裁剪、外键、只读查询、配置指纹和失败回滚已有自测。后续业务表沿用同一入口，不新增私有加载器。
- Phase 4.5已完成玩家持久化第二轮收口。独立仓库[TiangZ-DBProxy](https://github.com/moulo1982Google/TiangZ-DBProxy)的`v0.5.0`继续独立拥有快照、Revision/CAS、幂等、单记录与多记录原子事务、可查询事务回执、PostgreSQL权威存储、Redis已提交缓存与AOF backlog，以及多Endpoint和两个共享存储的无状态对等实例；当前开发分支新增`LoadMultiSnapshot/SaveMultiSnapshot/EnqueueMultiSnapshot`，主工程用一次RPC恢复或保存`inventory/progression/quest/runtime/wallet`五条记录和五个独立Revision。普通批量保存不是事务，关键经济变更继续使用`ApplyMultiTransaction`。Map默认30秒周期快照，下线与停机使用幂等最终Flush。`npm run test:player-domain-recovery`验证静态MapHost有界重启和DBProxy恢复；`npm run test:gate-failover`验证双Gate强杀、同Unit接管、旧节点重启不回切和绕过Login重入拒绝；`npm run test:player-trade:persistent`验证DBProxy Endpoint切换与幂等回执，统一入口为`npm run test:tiangz-fault-matrix`。普通运行态最多允许回退一个快照周期，关键事务必须先可靠提交。TLS、单机生产测试部署和动态副本安全回退已经完成；动态副本现场恢复与跨机器租约仍未完成。完整步骤见[DBProxy玩家快照持久化](../tutorials/19-dbproxy-player-persistence.md)。
- 技能系统第一阶段已经实现：Unit上的`SkillComponent`只保存技能/GCD deadline和唯一ActiveCast，地图唯一`SkillMapComponent.Update10Hz`推进活跃读条与弹道；不创建每Unit Update、每Cast Timer、Actor或Entity。瞬发在ordered PlayerUnit调用内完成，移动策略和平A策略均由配置显式决定。施法期间平A意图仍保留，但平A读条被冻结，不能继续累计；玩家受到一次**没有被护盾吸收**的有效攻击且读条仍有效时，Demo战斗规则对普通读条只把`finishAtMs`向后延长800ms，对引导只把结束时间提前800ms，不重置起点、不清除引导、不改变CD，并立即广播新的`G2C_SkillCastState`，客户端依据新的权威结束时间更新进度条。真言术·盾吸收本次攻击时，不后移普通读条，也不缩短引导；后续未被吸收的攻击仍按同一规则处理。冷却随玩家跨地图传输，活动读条在传送时终止。`SkillConfig.xlsx`描述目标关系与施法时间线并生成给前后端，服务端专有的`SkillEffectConfig.xlsx`描述有序Action；`SkillCatalog.ts`只按配置指纹组合只读定义，不再保存技能数值。ActiveCast和Projectile冻结接受请求时的定义，Reload只影响新Cast。技能只选择目标并执行Action，伤害/治疗进入Combat，Buff生命周期进入BuffComponent。Buff冲突使用`stack_group + stack_scope`和Stack/Refresh/Replace/Reject/HigherWins；运行时Action覆盖和护盾剩余量可跨地图恢复。完整方案见[技能与施法系统设计](../design/skill-system.md)和[配置化技能教程](../tutorials/18-configured-skill.md)。
- 账号与角色选择、正式持久化业务接入。
- 地图传送已经统一为`player.TransferToMap(mapInstanceId)`：业务不提供MapHost、IP、端口或本地/远程分支。Gate在第一个`await`前打开有界屏障，源PlayerUnit mailbox通过MapInstance目录解析目标后协调Location锁、目标候选、位置提交和源Actor清理；Proto `duringTransfer`决定Actor消息排队、拒绝、丢弃或latest覆盖。Map1/Map2拆为两个MapHost的Runtime smoke已经覆盖跨进程传送，并验证并发UseItem只在目标Unit执行一次。Component仍默认不迁移，Numeric、Item显式参与，Position只迁移速度/朝向/存活。目标提交后Location结果不确定时进入可诊断`moving`态，不向旧Actor重放；生产级事务日志和自动恢复仍属后续高可用工作。详见[Entity地图迁移](../design/entity-transfer.md)与[Location路由](../design/location-routing.md)。
- Phase 4.1 Rust AOI功能链和Windows正式容量回归已完成：每个MapInstance按有限地图边界创建扁平连续X/Z AOI Grid，Grid成员使用紧凑`EntityIndex`连续数组和`slotInGrid`做O(1)迁移；`UnitId -> EntityIndex`哈希只在API入口定位，实体元数据与Audience签名连续存放，候选循环不再逐实体查Hash。单Grid达到128人会额外建立成员位图，降至96人以下释放；微基准显示128人起优于数组去重。空间候选与业务过滤后的最终可见关系使用四张双向稠密位图，迟滞关系另用一张单向位图维持O(1)指标。位图使用单块连续`u64`矩阵并按512实体分段扩容，有意用内存换关系差分、正反向查询和缓存局部性；3000实体预留到3072时五张矩阵约5.6 MiB。当前每MapInstance硬限制16384个AOI实体，对应五张矩阵约160 MiB；更大Scene必须使用分块位图或空间分片。`Cell`是可配置米制空间单位；默认15×15 Cell组成一个Grid，3×3同时作为Enter和20Hz高频区，已可见关系进入5×5外圈后降为5Hz，5×5也是Detach边界，越界立即Leave；不再配置7×7和1Hz档位。TS不镜像关系。FastOP X/Z写入自动标脏，只有跨AOI Grid才更新索引；当前不做每Tick CSR重建。Movement按同步档位节流，开始/停止/转向强制立即发送；Numeric、UnitState和不可覆盖事件保留各自同步语义。进入/离开同帧相同受众合并为`G2C_AoiDelta`。阵营/隐身/位面由同步`IAoiVisibilityFilter`查询并显式Invalidate。3000人正式基线固定80% Grid内移动、20%每2秒跨Grid，理论跨Grid约300次/s。新旧同口径10×10、15×15、20×20 A/B中，Map CPU平均由`74.1%/56.7%/57.3%`降为`55.0%/50.7%/42.9%`，分别下降约`25.8%/10.6%/25.1%`；新30秒Probe p95/p99为`62.18/100.18ms`、`41.34/53.39ms`、`35.59/42.26ms`。三档正式窗口均零错误、过载、超时、背压和慢连接，跨Grid达到理论值的99.8%/101.2%/100.5%。第一次20×20尾延迟异常已通过同参数复测确认是不可重复的环境抖动；10×10另以60秒窗口复测得到CPU 56.2%、p95/p99 50.60/75.17ms，说明CPU收益稳定，但密集场景短窗口p99仍存在调度波动，不能宣称所有延迟分位同比下降。Phase 4.2接入NavMesh3D；Phase 4.3完成Cocos 3D Demo；Phase 4.4进入怪物与战斗；Phase 4.5最后完成持久化基础。Cocos3D手机Web第一版使用`web-mobile`构建，`/m/`部署路径只改变页面模板与输入表现，不改变服务端空间协议。
- Phase 4.2.5已完成导航主链：`tools/navigation`生成固定灰盒，`navmesh_bake`通过官方Recast离线烘焙v2压缩高度层并立即回读，输出稳定小端资源与SHA-256元数据；Rust提供投影、寻路、连续贴地移动、射线、高度、实例TileCache和动态障碍。开发者不手工烘焙，也不接触Detour句柄；真实地图仍需补展示模型与导航碰撞源的制作期一致性检查。
- Phase 4.4已接入首版完整怪物业务闭环：`MonsterConfig`描述模板、血量、攻击力、独立攻击距离和复活秒数，`MonsterAreaConfig`只描述固定刷怪槽位、坐标和初始是否生成，二者都是冷配置；`MapHost`创建每个MapScene时自动挂载`MonsterComponent`。怪物是`UnitComponent`中的普通`MonsterUnit`，AOI只把它作为Subject，不拥有Gate连接，也不作为Observer。Map固定桶统一处理主动索敌、仇恨追击、攻击间隔、玩家自动平A、死亡尸体和新Unit重生：20Hz保留既有地图移动，10Hz处理玩家平A读条，5Hz处理怪物AI/仇恨目标，1Hz独立处理尸体清理与刷怪槽重生。玩家和怪物的攻击力都使用链式Numeric：玩家默认写入`AttackBase=5n`，怪物写入配置攻击力到`AttackBase`，Rust推导只读`Attack`；攻击直接读取最终Attack扣除CurrentHp，当前不增加Armor。玩家实际伤害按1:1调用`MonsterComponent.AddThreat`写入仇恨表，攻击距离分别读取`PlayerConfig.attack_range`和`MonsterConfig.attack_range`，不混入Numeric。怪物死亡后以`alive=false`保留原Unit和AOI身份；有掉落的尸体保留5分钟、无掉落的尸体保留10秒，全部普通掉落领取完成后可以提前清理。死亡时刷怪槽立即释放并从该时刻按`respawn_seconds`计时创建新的MonsterUnit；旧尸体保留在独立集合中承载拾取和AOI Leave，因此同一`AreaId`可以同时存在新活怪和旧尸体，二者使用不同UnitId、InstanceId和Native句柄。拾取重试使用同一`operationId`读取DBProxy回执，不因尸体已离开而重复创建Item。NumericComponent不再内置100ms回血Timer；周期规则由具体业务Component显式拥有。玩家的`CombatComponent`只保存平A意图和武器计时，不创建每玩家Timer；激活且目标存活后计时持续推进，到点时才检查前方120°和玩家配置攻击距离，暂时无效则保持就绪并按10Hz重试，只有成功命中或显式中断才开始或清除一轮计时。业务Handler只调用`PlayerUnit.AttackMonster/ToggleAutoAttack`，不遍历地图或直接操作Native句柄。技能、掉落、Buff、任务和复杂仇恨扩展仍由业务层继续追加，完整开发示例见[怪物模块教程](../tutorials/16-monster-module.md)和[固定更新桶与自动平A设计](../design/auto-attack-and-fixed-update.md)。演示客户端读取`MonsterConfig.attack_mode`做表现提示：自己蓝色、其他玩家绿色、被动怪黄色、主动怪红色；这个字段只用于客户端识别，不承担服务端权威判断。
- Gate物理连接关闭后，Cocos3D必须立即清除旧地图状态和`UnitId`并回到登录界面，不能继续使用已经被Map移除的Actor发送技能或移动。死亡恢复现拆为两个中立的有序PlayerUnit动作：`ReleaseDeadPlayer(optionalRecoveryPosition)`清理移动、战斗来源、平A和施法状态，校验同图有限坐标及Grid/NavMesh边界后把仍为死亡、HP为0的玩家释放到调用方选择的位置；未提供位置才回退当前Map出生点。`RevivePlayer()`只在当前位置恢复50% HP/MP并保持幂等，不再次改变位置。墓地选择、尸体、幽灵、回收距离、复活延迟、Buff去留、耐久损耗与复活虚弱仍由外置游戏包拥有，不能扩散进Combat或Core。DBProxy恢复旧`alive=false`快照时保留进图边界的满血兜底，只用于兼容旧记录。
- 持久化死亡玩家的进图处理由外置 `PlayerContentDefinition.deadAdmissionPolicy` 选择 `revive-at-spawn` 或 `preserve`；Core 只负责策略边界和中立状态恢复，不解释尸体、幽灵、墓地或协议字段。现有 WoW335 内容包暂时使用 `revive-at-spawn`，直到适配器完成尸体元数据与死亡状态的完整跨重连持久化。
- 怪物基础AI进一步收敛为Hotfix内部的`MonsterBehaviorTree`：只包含待机、追击、攻击和攻击冷却停留，不建立通用AI框架，不创建MonsterActor或每怪物Timer。普通攻击距离由各自配置控制，行为树只选择动作，伤害、仇恨、死亡和Numeric修改仍由`MonsterComponentSystem`执行。
- 战斗时间轴语义已冻结：玩家或怪物按下普通攻击后只激活`AutoAttack`状态；靠近目标且满足距离、存活、同MapInstance和朝向条件时才推进平A读条。距离过远或朝向失效会清零当前读条，但不取消AutoAttack状态，重新满足条件后从0秒重新开始。移动不停止AutoAttack，右键加A/D的侧移用于保持朝向绕目标移动。施法期间由`SkillComponent.IsCasting()`冻结平A累计，施法完成或中断后才允许重新开始平A读条；受击惩罚只由地图技能调度器在Combat确认本次没有护盾吸收且实际命中后调用，真言术·盾吸收的攻击不会后移读条或缩短引导，不能由客户端或通用Combat反向查询Buff。`G2C_AutoAttackState`是每个玩家本人频道上的`latest`可覆盖状态，只表达当前读条，不承载命中事实；命中、道具消耗等不可逆事实必须使用事件广播。技能配置把伤害类型、瞬发/施法方式和是否重置平A分成独立维度；例如压制是Physical + Instant + Keep，不应按“物理技能”或“瞬发技能”分支猜测平A行为。
- 主动怪没有仇恨时只在12米主动索敌范围内寻找最近玩家；被动怪没有仇恨时保持待机。平A和技能都必须经`MonsterComponent.ApplyPlayerDamage`按“1点最终实际伤害=1点仇恨”累计，产生仇恨后两类怪都选择本地图存活玩家中的最高仇恨目标，已有仇恨不能再被12米主动索敌距离过滤，因此30米远程命中也会触发追击。固定刷点怪物在距Home超过30米、旧目标死亡/离线或全部仇恨目标失效时进入独立Evade回归态：先清仇恨和玩家战斗来源，回归途中不接受新伤害/仇恨，到达刷点后停止移动并恢复满HP；不能在失目标同帧重新主动索敌。30米当前是Starter Hotfix规则，正式项目应迁入独立冷配置，绝不能复用12米主动索敌距离。玩家创建时由`PlayerConfig.initial_hp/max_hp`和`initial_mp/max_mp`初始化四个Numeric；当前演示模板的初始MP与最大MP均为200。Cocos3D、UE、Unity、Godot的玩家HUD只消费进入快照和`G2C_EntityNumeric`增量，显示当前/最大HP与MP。客户端不能根据怪物攻击自行扣血，也不能把HUD数值当作战斗权威。

- 标准Demo的战斗结算已收口到`CombatComponent.ApplyDamage/ApplyHealing`。玩家和怪物都挂载Combat；MonsterComponent只选择目标并提交请求，Item Handler通过ActionExecutor提交治疗或Buff。显式`canBePrevented`的伤害先经过`CombatEvents.BeforeDamage`同步只读Veto链，非零不透明原因直接形成`preventedReason`；放行后Combat才按优先级消耗注册的伤害吸收器并修改CurrentHp。Buff通过`RegisterDamageAbsorber/RemoveDamageAbsorber`在生命周期边界挂载能力，伤害流程不能反向查询BuffComponent；护盾处理器的数据是唯一运行时剩余量。HP仍由Numeric作为权威状态，但旁观者只接收1Hz的AOI latest；受击者与有效攻击者通过私有`G2C_CombatResult`事件立即收到精确伤害或规避结果，客户端以`serverTick`丢弃晚到旧状态。Buff添加/删除、命中/死亡/消耗等事实使用event。详见[战斗伤害与效果管线](../design/combat-damage-pipeline.md)和[Action与Buff设计](../design/action-buff.md)。
- 2026-08-03连续EntityIndex元数据与热点Grid位图完成后，3000人10×10同口径全链路回归的Map CPU平均为51.0%，较前一版55.0%再降约7.3%；Probe p95/p99为47.94/71.78ms，Move 6000/s、跨Grid 309.6/s且全部丢工作指标为0，正式证据在`perf/results/map_capacity_latest.md`。1000人单Grid热点验收得到精确999000条candidate/visible关系，说明混合成员结构不改变可见语义；该热点样本只作专项诊断，不替代正式均匀基线。
- AOI范围与频率全部由Cold配置驱动：`AoiConfig`定义Enter/Detach，`AoiSyncTierConfig`可定义任意数量的奇数范围与同步Hz，Map通过`aoiConfigId`选择配置。当前默认不启用7×7，但停服增加`7×7/1Hz`不需要修改框架代码。最外层同步范围必须等于Detach，TS生成期与Rust运行时都会拒绝未覆盖迟滞圈的配置；外层频率不能高于内层，且Hz必须整除Process逻辑Tick。
- Cell与Grid尺寸也是Cold配置：`MapConfig.cellSizeMeters`定义Cell米制边长，`AoiConfig.gridSizeCells`定义每个Grid每边Cell数。地图物理边界由制作流程决定并记录为`widthCells/depthCells × cellSizeMeters`；Grid数量只由宽深Cell数除以`gridSizeCells`推导，不增加独立`gridCount`。Grid2D必须整除，NavMesh3D在Phase 4.2由资源导出器按相同契约对齐或补边。
- 2026-08-01首轮10×10新行为基线实测跨Grid`310.3/s`、Move`6004/s`、Movement Push约`211.6万/s`，Map CPU平均`82.1%`，Probe p95/p99为`128.49/156.05ms`，零错误、零过载、零背压。该点略高于80% CPU目标，是接近边界的回归基线，不是保守容量点；原始证据固定在`perf/results/map_capacity_20260801_015926.md`，三档空间密度结论以`perf/results/map_capacity_grid_matrix_latest.md`为准。
- 2026-08-19首次Starter真实业务压测固定了“业务拒绝不等于传输失败”的判定：Node全链路A/B覆盖50/100/200玩家的all/split，Rust容量客户端在16 Gate、10x10 Grid下覆盖1000/2000/3000玩家的2Hz Move、0.2Hz Probe和0.1Hz交替UseItem/CastSkill；1000玩家业务三轮中位数Move 2000/s、业务100/s、业务传输错误/Probe错误/背压/内部超载/内部超时均为0，当前保守有效点为1000。无业务2000仍可完成但尾延迟很高，叠加业务后2000和3000出现Probe错误及Map frame/completion背压。这个结果是当前单MapHost/Windows IOCP的Starter证据，不是生产人数承诺；DBProxy事务业务另行压测。完整记录见`docs/starter/op05-real-business-load.md`。
- 容量验收同时检查Runtime固定帧和真正推进Movement/AOI的Map业务Update。Map Update是同步回调；Runtime Pump先处理Scene mailbox和V8 microtask，再推进到期固定帧，因此高入站负载可能让Runtime固定帧与Map Update一起显著低于20Hz，同时进程CPU仍未达到目标。正式容量候选要求Map Update达到配置固定Tick的95%以上，且正式窗口`tiangz_game_skipped_fixed_updates_total`增量为0；跨Grid理论速率只有在Map Update健康时才可用于证明负载成立。
- 2026-08-21的A/B确认墙钟式Scene入站预算会与`pendingIngress`形成反馈锁死：40ms预算下3000人Probe降为0、业务传输错误11956。最终方案保留`maxEventsPerUpdate`、EntryScene公平轮转和data暂停，但把积压期每轮control再注入限制为128条，为TS保留旧队列排空空间；Map容量配置使用`maxCatchUpSteps=3`覆盖150ms内偶发尖峰。3000人、8 Gate、40人/秒进图的正式业务复测达到Map 20Hz且零跳帧，Move 5996/s、Probe 599.6/s、业务299.8/s，Probe/业务传输错误、overload、timeout和backpressure均为0，Probe p95/p99为190/234ms。4000人仍不是已确认容量点。
- 每个MapInstance有独立的隐藏式入图队列：连接和登录完成后，客户端停留在Loading，地图按`MapConfig.entryPlayersPerTick`逐Tick执行AOI Attach，队列上限由`entryQueueCapacity`控制。首次登录和地图传送进入队列；断线重连复用现有Unit，不重复Attach。它只削平单地图Attach与初始Snapshot洪峰，不是区服容量排队，也不替代地图人数上限或负载调度。配置属于Cold，默认Starter地图为每Tick 2人、最多等待10000人。首次进图、Gate到源Unit的传送调用以及跨MapHost目标Commit统一使用10分钟Admission事务上限，不得继承普通Scene RPC的5秒超时；该上限只是故障兜底，不能当成可接受的Loading时延。
- Admission在一个逻辑Tick内先完成本批次Attach，再准备新Observer的初始实体列表。生产路径不再把这份列表塞入`EnterMap`响应：`EnterMap`返回小型路由、坐标、物品和空间元数据；客户端注册`G2C_AoiDelta` Handler后调用`C2G_MapSnapshotReady`，Gate校验Unit路由，MapHost再通过既有`ClientBroadcast`发送初始`AoiDelta`。`MapComponent`拥有暂存快照，玩家移除和地图销毁时清理，发送失败可重试。`player_entry_snapshot_items_total`仍表示逻辑初始实体条数，`player_entry_snapshot_materialized_items_total`表示实际对象构造数；复用指标用于诊断构造成本。`entryPlayersPerTick`仍是Cold配置，批量参数必须同时观察初始AoiDelta下行队列后再决定生产值。
- 2026-08-01的3000人、16 Gate、单Grid完整进图A/B验证`entryPlayersPerTick=1/4/8/16`均可零错误完成，Map Enter吞吐为`19.97/78.88/131.09/164.39人/s`；广播pending峰值为`7/56/136/272`，Location确认平均耗时为`7.17/29.62/127.75/284.46ms`。这说明初始视野解耦修复了原大RPC溢出，也说明批量越大并非无代价。当前Starter正式Cold值调整为`2`，其他地图仍按各自MapConfig配置；短窗口CPU样本不足，不得据此形成容量结论。
- 进图链路以低基数指标拆分MapHost全链路、ID分配、Player创建、Location注册/确认、MapReady、Admission等待、AOI Attach、新玩家Snapshot和老玩家AOI Delta；对象条数与真实Transport字节分开统计，禁止为了观测在TS重复编码protobuf。`perf:map-entry-stages`通过Bench专用`entrySyncMode`运行Attach Only、新玩家快照、老玩家Enter和Full四组A/B；普通`C2G_EnterMap`永远使用Full，前三种残缺模式不得进入生产配置或业务代码。
- Rust AOI前的权威Entity Store迁移已完成：generation handle目录只做定位与世代校验，`.native`生成Unit/Item类型池及Unit冷热布局；TS只持有生成NativeRef。Rust池容量、活跃实体、TS NativeRef和帧尾scratch扩容已进入Prometheus。迁移保留既有Native op语义；类型分池、冷热布局的微基准与地图容量报告仍须分开解释，不能把任一结果直接换算为生产服务器容量。
- Numeric权威值统一为Rust`i64`、protobuf`int64`和TS`bigint`。普通属性编号为1..999；1000..9999为只读派生结果；`result*10+1/+2/+3`为Base/Add/Pct来源。Rust按编号约定原子重算，不维护MaxHp等TS业务常量；复杂跨属性公式必须使用显式领域op。
- `npm run perf:numeric`是Numeric派生计算的纯Rust微基准，分开报告普通写、单来源重算、三次独立来源写和一次批量重算上限；结果不包含V8、protobuf、AOI或Socket，不能直接换算整服容量。
- Map级同步策略共存：普通大世界使用状态同步，竞技场等独立Map可使用帧同步，高精度场景可使用高频状态同步。同步模式由Map创建配置和对应Component决定，不是Process或Runtime的全局选项；逻辑Tick、网络同步频率和客户端渲染频率必须解耦。该项排在普通状态同步与Rust AOI之后。
- 怪物Actor、巡逻、仇恨和战斗。
- Online/Presence等面向在线状态的业务索引；Location Actor路由基础已完成。
- Guild、Friend、Chat等EntryScene与Component业务域。

Phase 5计划：

- [x] Linux单机生产测试观测：Alertmanager、Node/PostgreSQL/Redis Exporter、Grafana HTTPS认证入口、资源上限与14天保留；第三方通知密钥由部署环境提供。
- 跨机器观测Agent、长期对象存储与观测平面HA；跨进程追踪本身已经完成。
- 生产级服务发现、Inner身份认证、崩溃恢复和滚动更新。
- KCP弱网/长稳与io_uring进一步优化。
- 在Rust AOI和首版真实怪物、战斗、Buff、任务及持久化负载完成后建设容量规划。容量工具按负载模型自动爬升和复测，以CPU、实际吞吐、p95/p99、队列趋势、错误与安全余量共同给出Map推荐容量、准入上限、Gate及Process部署建议；在此之前不得把`perf:gate`或`perf:map-capacity`结果转换为生产在线人数。

当前语言策略：

- TypeScript是唯一主业务脚本语言。
- Rust负责Runtime、权威数据和经过指标证明的性能热点。
- Wasm以后可用于确定性、粗粒度重计算模块，例如Rust编写的战斗核心；当前不接入。
- Rhai以后可以作为脚本后端候选，但要等异步、调试、类型工具和大型工程能力满足要求；当前不接入，也不提前增加兼容抽象。
- 不同时维护TS、Rhai和Wasm三套主业务模型。

## 对后续AI的工作要求

1. 接业务需求先阅读[AI业务开发手册](business-development-manual.md)、最接近的`app/model/mmorpg`状态定义和`app/hotfix/mmorpg`行为实现。
2. 不把阶段历史文档中的旧Service/V8模型恢复到当前设计。
3. 不因为性能猜测下沉Rust，先建立业务路径和指标；用户明确要求实验时再做最小A/B。
4. 不在收到Unit消息后通过账号、地图遍历或全局Manager再次定位Unit。
5. 不把不可覆盖Event塞进latest状态通道。
6. 不把AOI收件人选择写进BroadcastHub；AOI拥有Audience。通用路径由Core排队、编码和投递，Movement专用Rust热路径可在AOI内部把Audience直接投影为Gate route frame，但业务层不能看到或管理routeId。
7. 不为未来Wasm/Rhai设计当前用不到的多语言抽象。
8. 修改架构事实、目录所有权、协议语义或Phase状态时，同步更新本文、`README.md`和`docs/roadmap.md`。
9. Actor只表示Scene、Session、ActorUnit拥有的mailbox与路由能力；普通Unit没有mailbox。不要为普通业务身份新增泛化`XxxActor`，也不要给每只怪物机械增加`@actor`。
10. 新业务状态写Model，生命周期和行为写`@systemFor`；不要恢复Model方法空壳，也不要在每次方法调用前查System Registry。
11. Component拥有的子对象只能由所属Component维护集合和业务修改；不要从Handler直接操作Native Ref，也不要把每条Quest或Achievement机械地做成Entity。
12. TiangZ主工程及配套VS Code插件仓库的提交标题默认使用中文；代码标识、命令、版本号和专有名词可保留原文。
13. 外网演示使用`configs/deploy/external-multiprocess/StartMachine.json`和Cocos3D资源配置；10个TiangZ Process共享`known-scenes.json`。Cocos3D编辑器预览通过`PREVIEW`自动读取`assets/resources/Config/tiangz-local.json`连接本机`127.0.0.1:7000`；非预览发布包读取`tiangz-external.json`连接公网LoginMgr，不能把两种环境地址手工混用。外网Cocos3D发布使用`npm run build:cocos3d:external`：`build/external/desktop`只部署到根路径`/`，`build/external/m`只部署到`/m/`，后者是唯一横屏移动入口；构建脚本会在页面顶部注入`版本、UTC构建时间和Git短提交号`，Nginx对Demo资源发送`no-cache, must-revalidate`，排查时先核对页面Build标识。两个DBProxy对等实例分别监听`7800/7801`并共享Redis/PostgreSQL，TiangZ所有Process按首选/故障切换顺序连接。当用户说“部署到外网测试机”时，必须重新构建前端和后端并确认上传的是本次最新产物；远端直接停止旧服务、覆盖固定发布目录、重新启动并做冒烟。该主机只是Demo测试机，不使用`.next`、蓝绿目录、目录交换或自动回滚。凭据只存在运行环境，不能写入仓库。
14. 外网发布只上传Linux Release发布包，不上传`src`、Cargo工程、`node_modules`或`target`。Runtime优先从当前发布目录或可执行文件邻级目录寻找`dist`与`configs`，不能依赖编译机的`CARGO_MANIFEST_DIR`。
15. Linux正式发布统一使用`npm run release:linux`和固定镜像`tiangz-linux-builder:ubuntu-24.04`。镜像是工具/依赖底座，不含业务源码；普通TS、Rust、Excel变化只复制源码并完整运行Luban、codegen与Release编译。只有依赖锁、Rust工具链、Luban或Builder定义变化才重建镜像，Linux Cargo中间产物由`tiangz-linux-builder-target`命名卷复用。

16. 当前主工程、`tiangz-developer-tools`、`tiangz-native-language`和独立`TiangZ-DBProxy`都处于开发阶段：日常允许版本副本、Cargo/npm依赖和协议原型迭代，不要求强制使用`npm ci`、Cargo `--locked`或同步更新发布锁文件。开发CI可运行`npm run verify:locks:warn`报告漂移但不阻塞；准备正式Release时，主工程统一执行`npm run verify:release`；插件和DBProxy由各自仓库执行发布前的锁文件、版本、协议指纹和完整测试审查。不要把开发门禁误写成发布承诺。

## 外置内容的条件激活边界

地图内容目录可以登记 `initialSpawn=false` 的 Monster、NPC、Interactable 候选；对应运行时组件提供幂等的
`ActivateSpawn/DeactivateSpawn`，停用必须同步清理 AOI、Unit、移动、尸体/重生或 NPC 交互游标等本地图状态。
`SpawnSelectionGroup.initialActive=false` 用于休眠根组，外置模块可通过 `ActivateGroup/DeactivateGroup` 启停整个
候选树；子组仍只能由父组拥有。TiangZ 不解释节日、事件编号、正负关系或来源数据库表，这些规则必须留在游戏模块。

外置模块在地图静态 profile 扩展阶段早于 Monster/NPC 等运行时组件装配。需要延迟启动的模块组件可用
`TimerSystem.TryGetInstance()` 探测进程定时服务，并排入下一轮运行时；无完整 Runtime 的模块校验工具不得被迫
伪造进程单例。模块还应提供可注入时间/控制器的纯运行入口，以便无客户端验证边界和失败回滚。

## 新AI建议阅读顺序

1. 根目录`AGENTS.md`。
2. 本文。
3. [AI业务开发手册](business-development-manual.md)。
4. [架构与快速启动](../tutorials/01-architecture-and-quickstart.md)。
5. 与任务相关的教程、reference和现有Demo代码。
6. 只有维护Runtime时才阅读[运行时维护者指南](../design/maintainer-guide.md)和`src`。

## 最新效果系统校准

Phase 4.4现在已经包含Action/Buff、Luban SkillConfig/SkillEffectConfig、七技能Cast和3006/3007持续效果闭环；后文“Buff、Cast或技能表尚未开始”的历史描述均以本节、[Action与Buff设计](../design/action-buff.md)和[技能系统设计](../design/skill-system.md)为准。开发人员应先组合现有Action、Buff策略和SkillEffect，不要为每个技能新写Handler，也不要把Buff效果反向塞进Combat入口。3006恢复是瞬发AddBuff，8次治疗由Buff Tick负责；3007精神鞭笞由服务端10Hz推进，移动取消；只有Combat确认没有护盾吸收的受击才将结束时间提前800毫秒，真言术·盾吸收的攻击不缩短引导；Cocos3D连线只是本地表现。

## C# Client SDK与Unity边界

Unity客户端沿用和Cocos、Pixi相同的协议语义，但不把Unity类型带进公共SDK。C# SDK的唯一源码目录是`client_sdk/csharp/`，协议生成命令是`npm run codegen:csharp-client-sdk`；生成器从协议锁读取消息和opcode，生成C#消息、Codec、RPC/Push描述符和类型化Client，再复制到`../TiangZ-Examples/clients/Unity2022.3.62f3c1_demo/Assets/TiangZClient/Runtime`。Unity目录中的`Runtime/Generated`和其他生成C#文件不能手工编辑，业务只改`Assets/TiangZClient/Demo`或自己的表现层目录。

`RpcSocket`的网络线程只接收完整帧并放入有界队列，Unity主线程在`Update()`调用`RpcSocket.Update()`后才执行Push Handler和完成RPC；超时、断线、未知消息和队列溢出都有明确结果。业务不得在接收线程直接修改Unity对象，也不得绕过Client手写msgcode、rpcId或Codec。当前C# Adapter只支持桌面WebSocket，选择TCP/KCP必须立即报不支持，不能静默切换到WebSocket。

Unity表现层使用`Vector3`、Transform和Camera，协议及服务端仍使用米制`x/y/z/yaw`：X/Z是地面平面，Y是高度，Yaw是绕Y轴弧度。坐标转换只允许出现在表现边界；不要把`Vector3`写入协议、Model或Native数据。Unity Demo的标准调用顺序是：`LoginFlow.EnterGameAsync`登录进图，注册Push，再调用`GateClient.MapSnapshotReadyAsync`请求初始AOI；运行期间每帧调用`LoginFlow.Update`，输入只调用生成的`MapClient.NavigateInputAsync/NavigateToAsync`。

## 道具出生数据与Cocos3D快捷栏

当前出生物品：新角色首次创建时获得`1001×3`小红和`1003×3`小蓝；读档、重连和跨地图不重复发放。快捷栏药品槽按配置ID引用`1001/1003`。

新角色出生时由`MapComponent`显式发放`1001×3`小红和`1003×3`小蓝；只有没有持久化快照且不是迁移目标的真正新角色可以走这条发放路径。读档、断线重连和跨地图传送都只以`ItemSnapshot`恢复，不会重复发放；`ItemComponentSystem.Awake`只负责生命周期。Starter任务奖励仍由任务事务单独追加。1001和1003各有30秒配置CD，并与技能共享1秒玩家GCD；服务端原子提交deadline，跨地图快照保留，客户端只绘制返回时间。道具使用RPC成功时，`M2C_UseItem.buff`会回显本次新增的公开Buff给使用者；AOI仍通过`G2C_BuffAdded`给其他观察者广播，客户端两条路径按实例ID幂等合并。

`ItemConfig.icon`是客户端字段，值是相对Cocos `assets/resources`且不含扩展名的资源键，例如`UI/Icons/Items/1001`。Cocos3D Web快捷栏固定为`1=平A`、`2=1001`、`3=1003`，初始数量来自`G2C_EnterMap.items`，使用和拾取后的数量来自不可覆盖的`G2C_ItemChanged`；拾取RPC只返回受影响的`items`，客户端按`ItemSnapshot.version`合并RPC与Push，不能把整包背包放进每次拾取回包。打开NPC商店时，`M2C_OpenNpcShop.inventory`会返回一次只对当前玩家可见的权威背包快照，用来校正拾取推送延迟或丢失造成的本地投影；商店本身仍由服务端重新校验出售资格。客户端不得在按键时先行扣数量。快捷栏槽位只绑定`ItemConfigId`，数量归零时服务端删除背包中的`Item`子实体，客户端移除该`ItemId`快照但保留快捷栏槽并显示`×0`；之后拾取或奖励同配置道具时，即使生成了新的`ItemId`，槽位也会按配置ID重新汇总并恢复可用。以后增加快捷栏时继续按`configId -> ItemConfig -> icon`解析，不能把道具图片路径硬编码到表现脚本。

Cocos3D还提供完整背包面板：桌面端点击“背包”或按`B`，移动端点击“包”按钮；面板按`ItemSnapshot.itemId`展示所有有库存的道具，名称、说明和图标来自客户端冷配置，使用按钮统一调用现有`MapClient.useItem`。面板只刷新服务端快照，不维护第二份库存；数量为0时等待`ItemSnapshot`后移除，触摸事件由HUD消费，不能穿透成地面寻路。Cocos Creator 3.8.8 Web不得对`Map/Set`的`values/keys/entries`结果使用展开语法，必须用`Array.from(...)`物化，并由`typecheck:cocos3d-demo`门禁；验收时还要检查编译后的JS。其他客户端可以采用自己的背包UI，但必须保留同样的服务端权威和`operationId`边界。

运行期间如果客户端带着过期ItemId或数量请求使用、购买或出售道具，服务端可以在业务错误响应里附带可选`inventory_recovery`。客户端先用其中的`InventorySnapshot.items`整体替换本地背包，再显示原错误；包装存在但items为空也必须清空本地旧数据。正常成功响应仍只返回受影响Item增量，不能把错误修复机制变成每次操作的全量广播。

Cocos3D玩家Unit保持“中心点实体根节点 + 可替换Visual子树”的边界。当前`BlueChibi.glb`由Blender脚本生成，导入后是包含`Idle/Walk`的骨骼Prefab；`PlayerCharacterVisual3D`只消费是否移动的表现状态，并将脚底原点相对实体中心下移0.9米。动画、模型和方块加载占位都不得修改Unit坐标、碰撞、AOI或权威Yaw。生成命令是`npm run asset:cocos3d:blue-chibi`，攻击动画仍属后续表现工作。

Cocos3D桌面输入区分角色朝向与本地观察：右键拖动继续同时修改`playerYaw/cameraYaw`并上报朝向，左键拖动只修改`cameraYawOffset`，不得写协议或权威状态。左键按下到抬起超过5像素视为环绕手势并吞掉寻路；未超过阈值仍按短点击处理怪物选择或地面寻路。

Cocos3D的本地Buff栏从`MapEntitySnapshot.buffs`、`M2C_UseItem.buff`和`G2C_BuffAdded`建立图标，资源键固定为`UI/Icons/Buff/<BuffId>`，例如Buff 2001使用`UI/Icons/Buff/2001`；界面文字读取客户端`BuffConfig.name`显示中文名，不展示BuffId。剩余时间使用最近一次Gate Ping得到的服务器时钟偏差计算，显示为`分钟:秒`，两小时显示`120:00`；无限时长显示`永久`。本地倒计时到`00:00`只冻结文字和保留图标，必须等`G2C_BuffRemoved`才删除，不能用客户端本地计时器提前清理Buff。

## 外网持久化部署校准

当前`external-multiprocess`的10份Process配置都显式使用同机DBProxy首选地址`127.0.0.1:7800`和故障切换地址`127.0.0.1:7801`。客户端按RecordKey稳定选择地址，只有连接不可用才切换，并保留原`requestId/operationId`；Revision冲突、业务拒绝、鉴权失败和协议错误直接返回。两个DBProxy实例共享同一套云Redis/PostgreSQL，不做实例间Leader、复制或内部RPC。DBProxy下的Redis和PostgreSQL只绑定回环地址，外网安全组不开放`5432`和`6379`。Ubuntu部署机用Docker Compose启动两个存储容器，DBProxy作为独立systemd服务运行，认证令牌只由systemd环境文件注入。TiangZ的systemd单元对两个DBProxy使用`Wants=`而非`Requires=`，确保任一候选停止时Runtime仍可通过另一Endpoint服务。只启动Redis/PostgreSQL而不启动两个DBProxy，或者只启动DBProxy而不在所有Process配置中声明`persistence.dbProxy`，都不算完成持久化接入。

## Unity、UE、Godot客户端收口

Cocos3D是业务表现参考，但不是唯一客户端实现。Unity C#、UE C++、Godot GDScript已经接入同一组生成协议：技能请求和读条/CD、Buff增删与详情、任务进度/接取/交付、怪物Numeric/Alive/死亡表现。三套客户端可以使用不同的HUD、节点和弹道样式，但都必须遵守“服务端结算，客户端表现”的边界。Unity使用`LoginFlow`，UE使用`FTiangZLoginFlow::SetFeatureCallbacks`，Godot使用`TiangZClient`信号；生成协议、msgcode和Codec禁止在客户端手工复制。

## 任务掉落与尸体拾取

Starter的掉落链是`MonsterConfig.drop_table_id -> DropTableConfig -> LootContainer -> C2M_LootMonster`。`quest_objective_id=0`表示归属于首个造成有效伤害账号的普通一次性掉落，非零表示按账号筛选的任务掉落；玩家必须先接取匹配的`CollectItem`任务，剩余数量为0时任务行继续留在尸体上，不会再生成Item。拾取在PlayerUnit有序mailbox中完成距离、归属、资格、数量和operationId检查，Inventory/Quest先生成纯数据计划，DBProxy确认后才提交Entity和私有结果。当前1101是静态任务道具，动态ItemInstance必须保存实例数据，不能套用“尸体只保存配置ID、拾取时生成ItemId”的快捷路径。完整规则见`docs/design/loot-and-task-items.md`。

地图可交互物也可以通过可选的`InteractableContentDefinition.lootTableId`引用同一个中立`LootContentProfileComponent`。普通行按概率独立判定，带`groupId`的行每组最多选一项；同组可以共享`groupGatePermille`，先用独立确定性抽样通过组门槛，再选择显式概率成员，全部未命中时用第三个独立通道等权选择零概率兜底成员，`0`或省略的组门槛表示无门槛。行还可以用`nestedDropTableId`在命中后执行一次子表；包装行不直接发奖励或携带任务资格，登记阶段拒绝缺表、任务子表、超过16层和循环图。数量在`minCount/maxCount`间确定性选择；随机种子来自稳定交互operationId，因此重复请求只恢复原事务结果。普通掉落不要求任务，任务标记行与固定`rewards`仍按玩家当前`CollectItem`剩余量裁剪。物品与任务变化继续通过一次`inventory + quest`事务提交，成功后可交互物才离开AOI并进入配置的重生时间。具体游戏的宝箱、采集点、来源表编号和客户端封包不进入Core或通用MMORPG定义；外置模块只登记中立表ID、行和刷点。

地图中只需要被看见、暂时不能由服务器安全执行玩法的物体，必须显式登记为`InteractableContentDefinition.interactionEnabled=false`。它仍复用Unit、位置、AOI和表现模型进入快照，但`Use`会在读取持久化回执前以`InteractableUnavailable`拒绝，不能生成奖励、任务、掉落或重生副作用。`interactionEnabled=false`的定义不得同时声明任何玩法交互；旧定义省略该字段时仍必须包含实际玩法声明，避免无意创建可点击空物体。外置导入器可以据此先完整投影地图陈设，同时把尚未支持的来源类型、脚本和掉落原因留在覆盖报告中；Core不认识任何来源GameObject类型。

`SkillComponent`现已持久化中立熟练度轨道`proficiencyId/rank/maximumRank`。训练师报价可声明熟练度前置与单调上限授予，并用可选`grantedSkillConfigIds`把稳定报价ID与一次原子授予的实际技能集合分离；省略时仍授予报价技能本身。事务回执记录实际授予集合，重放不会多扣款或漏授技能。可交互物可声明最低rank和成功成长量。涉及成长时，交互使用`inventory + quest + runtime`同一事务，回执携带提交后的熟练度，重复请求和ACK不确定恢复不会重复加点。登录、断线重连和跨地图快照都会传递熟练度。Core与通用MMORPG层不认识WoW SkillLine、Lock、草药或矿脉；这些映射必须由外置模块和协议网关从自己的数据源投影。

## 框架热路径分配边界

TiangZ不承诺“关闭V8 GC”或绝对0 GC；可执行的目标是稳态下框架热路径的重复堆分配趋近于零，并用指标确认优化是否有效。Promise、protobuf解码对象、跨分片帧副本和业务临时对象仍可能存在，不能把“少分配”误写成“不会回收”。

- 有返回值的RPC仍保留Promise，因为调用方必须等待结果；ordered mailbox忙时的RPC队列节点会从回收池复用。
- 单向Message使用`runActorMailboxVoid`和Scene的单向mailbox路径。ordered mailbox忙时只排队回调节点，不创建完成Promise；Handler如果自身返回Promise，框架仍等待它来保持顺序并记录异常。
- `SceneMessageHelper.send/sendActor/sendFrame`返回`MaybePromise<void>`：本地同步mailbox和远程入队的常见路径返回`void`，只有底层实现确实异步时才返回Promise。`await send()`仍然合法，但只代表消息已被接受或入队，不代表目标Handler执行完成；需要结果必须使用RPC。
- 长度前缀协议流提供`LengthPrefixedFrameDecoder.pushEach`。完整帧在一个输入分片内时直接返回视图，跨分片时才复制；回调必须同步消费帧，不能把视图当成可长期持有的快照。
- `BroadcastHub.PublishEncodedLatestSnapshot`保留单批次专用路径，不为单批次创建包装数组；多批次只有在确实存在空受众时才创建过滤数组。latest仍然覆盖同频道旧状态，event仍然保留逐条语义。
- Scene和Actor都会暴露mailbox快路径、排队、异步、单向消息、当前深度和峰值指标；Scene指标保留`scene`标签，Actor指标是整个Process内所有Actor的唯一汇总，不能按Scene重复相加。Rust Host把两类指标分别导出到日志与Prometheus。观察到队列增长后再定位业务Handler、网络或广播，不凭GC猜原因。
- 这不是对业务代码一刀切禁止`map/filter/spread`。只有经过基准或火焰图确认的热路径，才按现有容器、批处理、复用节点和配置索引做局部优化；普通业务优先保持可读性。
- 低分配改动在压测前先执行`npm run perf:hotpath:prepare`。该命令构建Bench、完整链路客户端和Release Runtime，执行codegen、注释与Hotfix边界门禁，检查产物哈希和测试端口，但不会启动服务器或创建玩家。
- A/B结果使用`perf/full_chain/run_full_chain_perf.mjs`的同一负载参数，并用`npm run perf:hotpath:compare -- --before <before.json> --after <after.json>`按玩家数和业务场景对齐比较。比较器要求参数、案例集合和轮数完全一致，资源与Mailbox字段缺失时直接判无效；`stalled`、Probe错误、业务传输错误、背压、Inner超载和Inner超时必须为零。结论必须同时看吞吐、p50/p95/p99、CPU、RSS、V8 GC、Rust/Transport队列和Mailbox排队；单看GC或单个进程CPU不能判定收益。

## 尸体掉落交互

尸体掉落采用“查看”和“领取”两步语义。客户端先调用`C2M_InspectLootMonster`，服务端按当前账号的普通掉落归属和任务资格返回可领取的`LootDropSnapshot`，查看不会预留掉落、创建ItemId或写数据库。真正领取调用`C2M_LootMonster`：普通点击携带`drop_id`且`loot_all=false`，Shift、右键、F键或移动端“全部拾取”按钮携带`loot_all=true`。

Cocos3D的尸体窗口必须持续显示掉落行和领取结果，领取后使用回执的`remaining_drops`刷新列表，直到玩家主动关闭；不能只用一条短暂状态消息表示拾取结果。服务端仍以`operationId`、距离、任务资格和DBProxy事务为准，客户端不得本地扣除尸体或背包。

尸体生命周期与重生生命周期分开：有掉落的尸体保留5分钟，无掉落的尸体保留10秒；归属账号领取完普通掉落后可以立即发送AOI Leave。`MonsterConfig.respawn_seconds`从死亡时刻计时，达到时由已经释放的刷怪槽创建新Unit，不等待旧尸体窗口；旧尸体继续以旧UnitId留在独立尸体集合。任务掉落按账号保留，不能因为一个玩家领取完成就提前删除尸体。AOI Leave到达客户端后必须关闭对应旧UnitId的掉落窗口，不能误删同槽新怪。

## Starter金币、掉落与NPC商店

当前Starter的普通掉落表1按每行独立概率判定：破旧布料1201为80%、小型生命药水1001为15%、大型生命药水1002为5%；三行可以同时掉落，也可以全部未命中。任务掉落行仍按每个账号的任务资格独立判断。ItemConfig的出售价格为布料10、小红20、大红50铜币。Map 100的9002杂货商只出售小红和小型法力药水，商品和价格由服务端返回，客户端不能上传价格或自行改金币。

`CurrencyComponent`只拥有非负`bigint`铜币余额，`NpcShopComponent`负责NPC、距离、商品和交易编排，`ItemComponent`负责背包Item；购买和出售都在PlayerUnit ordered mailbox中生成Inventory/Currency计划，再通过DBProxy事务提交，成功后才应用内存状态。网络重试必须复用`operationId`，不能把购买或出售拆成两个客户端请求。快捷栏仍引用ItemConfigId，背包Item数量归零不删除快捷栏槽位，只显示0。

## 战斗状态与法力恢复

技能费用当前由Hotfix的`SkillManaCost.ts`维护，技能请求通过法力校验后立即扣除；法力不足不会创建ActiveCast。`CombatStateComponent`按“有效非玩家仇恨来源集合”维护战斗状态：Monster或配置为战斗型的NPC死亡、回归出生点或清除仇恨时移除来源，来源为空才脱战。`AddHostile/RemoveHostile`是新入口，`AddMonster/RemoveMonster`只保留为兼容别名。战斗状态不恢复MP；脱战后按180秒从当前MP恢复到MaxMp，固定更新桶用整数余数累计避免漂移。该组件是临时地图运行态，传送时清空，不进入持久化快照。设计细节见[`docs/design/currency-and-npc-shop.md`](../design/currency-and-npc-shop.md)。

## DBProxy就绪边界

配置了`process.persistence.dbProxy`的Process必须在进入ready前预连接完整DBProxy池；首选Endpoint不可用但备用可用时允许启动，全部Endpoint不可用时启动失败并交给监督器重试。禁止把惰性首连延迟暴露给第一个玩家RPC，也不能仅靠扩大客户端超时掩盖错误ready。

`DbProxyEntityRepository.SaveSnapshot`只对`StorageUnavailable`执行有限重试，始终复用第一次生成的`requestId`，重试间使用25ms起步、200ms封顶的墙钟指数退避和full jitter。Revision冲突及其他业务错误不重试；SDK、Transport和Repository不得再叠加无界重试。游戏Timer或可暂停的帧时钟不能承担存储退避，否则停帧会制造同步重试风暴。

## 随机游走节奏

`MonsterContentSpawn.wanderSchedule`是来源中立的随机游走调度契约：内容包可声明首次移动错峰、到达后停顿区间、首段停顿概率和连续路段的概率增量。`MonsterComponent`持有连续路段计数并执行确定性判定；具体来源游戏的枚举、默认概率和时间范围必须由外置导入器转换，通用运行时不得按地图、怪物编号或来源引擎分支。

## 运行时内容增量

`NpcComponent`与`InteractableComponent`支持由稳定`ownerId`拥有的可逆内容 patch。NPC patch 只能声明中立任务入口/交付、商店物品、对话/商店/训练/修理/恢复服务、表现模型/装束标识和命名空间扩展能力；交互物 patch 当前只声明任务入口。定义级 patch 同时作用于现有和后续刷出的 Unit，刷点级 patch 只作用于对应实例；同一 owner 重复应用必须幂等，移除后按基础资料与其余 owner 重新合成，不能保存“撤销前快照”覆盖其他增量。战斗资格不允许通过低频运行时patch开启，必须来自发布前已冻结的`NpcCombatProfile`。

最终合成状态归 Unit 所有，并通过`MapEntitySnapshot.runtime_profile_revision`及完整数组/服务字段进入 AOI 快照。revision 非零表示这些字段权威；协议适配器不得再用自己的静态目录覆盖。在线变化由外置模块发布命名空间`UnitPresentationType.Extension`，载荷语义由对应适配器拥有，Core只负责受众和有序广播。互斥模型/装束冲突在合成时失败，扩展能力必须带命名空间；来源游戏的NPC flag、模型号、装备表和客户端更新字段不得进入TiangZ通用类型。

## 通用任务内容信号

`QuestObjectiveType.ContentSignal` 是 MMORPG 层的通用任务目标类型：外置内容适配器在自身规则已经确认后，通过既有 `QuestEvents.Progress` 发布正向事实。Core 只按 `objectiveType + targetConfigId` 匹配、封顶计数、持久化和广播，不解释信号来自技能、对话、区域脚本或其他游戏机制。来源协议、数据库编号、半径和目标选择必须留在模块配置与模块 Handler 中；没有活动匹配目标时继续安全无操作。

## 战斗周期行为

`MonsterContentBehaviorTrigger.CombatInterval` 是来源中立的战斗计时契约。内容包声明首次触发和后续重复的最小/最大延迟、概率及中立动作；`MonsterComponent` 只在存在战斗目标时推进计时，并在脱战回归、闪避重置、死亡或重新生成时清理本次遭遇状态。来源引擎的事件编号、施法标志和技能编号仍由外置模块转换，Core 不得按具体游戏或怪物分支。

`MonsterContentBehaviorTrigger.Spawned` 是来源中立的实例创建边界。每次怪物运行实例完成组件初始化并接入 AOI 后执行一次，首次生成与死亡后的新实例语义一致；内容可以在该边界复用现有中立行为动作。Core 不区分来源数据库的加载、刷新或重生事件编号，具体游戏的出生脚本只能由外置模块投影为该契约。

`SummonComponent` 的地图内临时所有者可以是 `PlayerUnit`、`MonsterUnit` 或 `NpcUnit`。三者共享槽位替换、Unit/AOI 生命周期和跟随；只有玩家所有者能够使用现有协战与跨图快照，怪物和 NPC 所有者的召唤物保持被动跟随，并在所有者移除时一起离开。没有 `NumericComponent` 的服务型 NPC 按 1 级创建召唤物，不要求为了召唤而伪造战斗数值；非玩家所有者也没有持久角色ID，地图内关系只由 `ownerUnitId` 表达。具体游戏的召唤法术、模板、阵营继承、遭遇状态机、宠物栏和客户端字段仍完全属于外置模块/协议适配器。

`MonsterContentBehaviorTrigger.ExternalSignal` 是来源中立的外部内容入口。协议适配器通过 `C2M_TriggerMonsterSignal` 只提交当前玩家、AOI 内存活怪物与正整数信号编号；`MonsterComponent` 在玩家有序 mailbox 内完成身份、同地图和可见性校验，再按规则的 `requiredSignalId` 与重复延迟分发。Core 不解释客户端 opcode、表情、交互或脚本事件含义，信号编号、文本和动作都必须由外置模块及其配置拥有；概率失败也会消耗本次冷却窗口，避免客户端高频重试改变配置概率。

NPC 与怪物类名只表达基础身份，不是互斥的玩法能力标签。外置模块在`NpcContentDefinition.combatProfile`声明中立数值、玩家模板资格、主动索敌与追击范围；Core 的NPC工厂据此选择性组合`NumericComponent`、`CombatComponent`、`SkillComponent`，未配置战斗资料的服务NPC保持无数值快照且不可攻击。`NpcComponent`独立拥有NPC仇恨、追击、攻击、回巢、死亡、10秒尸体与刷点`respawnSeconds`重生，玩家平A、技能和延迟伤害都必须进入同一生命周期边界；它不侵入`MonsterComponent`私有运行集合。外置模块仍负责从阵营、队伍或其他游戏规则投影`attackablePlayerConfigIds/aggressivePlayerConfigIds`，Core不认识来源阵营或NPC flag。

`NpcCombatProfile.behaviorRules` 是服务 NPC 的来源中立战斗行为契约。规则可以在重置、进入战斗、战斗周期、生命区间、资源区间和目标距离区间触发，并按序请求不透明能力、启停战斗移动、设置/增减中立状态或逃跑；刷点规则可覆盖定义级规则。运行时按固定 Map Update 推进确定性计时与概率，在死亡、回巢和重生时重置遭遇状态。`NpcEvents.CombatActionRequested` 只把能力 ID 和运行时目标交还内容所有者，Core 不解释来源脚本或技能。可选资源恢复字段必须成组配置，在观察到资源消耗后等待延迟，再按固定间隔恢复并封顶；具体恢复公式由外置数据投影。

`MonsterContentDefinition` 与战斗型 NPC 使用同一组可选主资源恢复语义：`resourceRegenAmount`、`resourceRegenIntervalMs`、`resourceRegenDelayAfterSpendMs` 必须成组声明且要求正的资源上限。Monster 运行时观察公共技能系统已提交的资源消耗，重新开始恢复延迟，随后按固定间隔恢复并在回巢时补满。Core 不解释法力、怒气或来源游戏公式；外置模块只把已计算的中立数值写入内容模板。

伤害学校属于 MMORPG 战斗通用词汇，当前包含 Physical、Frost、Fire、Holy、Shadow、Arcane 和 Nature。外置模块可以把来源数据转换为这些中立值；来源法术表、位掩码和技能效果组合不得进入 Core。

玩家受伤后的公共 MMORPG 生命周期由 `MapComponent.ApplyDamageToPlayer` 收口：来源可以是当前地图中的任意 Unit，入口负责真实来源身份、Combat 结算、私有结果、施法受击、死亡清战斗和配置化耐久损耗。Monster/NPC 只在调用前维护各自仇恨；外置模块的环境机关不需要伪造生物身份。具体游戏的触发与伤害配置不得进入 TiangZ。

`NumericComponent` 在任一生命/资源上限来源字段变化后维护上界：若 `CurrentHp > MaxHp` 或 `CurrentMp > MaxMp`，当前值同步夹紧到非负上限；上限增加时当前值不变。这个规则只保证通用数值合法性，不替外置模块决定属性如何推导上限，也不提供治疗/回蓝语义。

## 外置模块驱动遭遇的最小战斗入口

`MonsterComponent.AddThreat(monster, player, amount)` 是公开的来源中立入口。外置模块可先用 `ActivateSpawn` 激活已注册的休眠刷点，再增加正数权威仇恨，使配置指定的对手进入现有索敌、追击、战斗状态、死亡和清仇恨链路。Core 仍不认识关卡阶段、任务编号、来源 SmartAI、对话或冠军顺序；这些状态机和 Luban 表必须留在模块内。模块不得绕过 `MonsterComponent` 直接修改怪物运行时表，也不得用零伤害伪造一次 `DamageResolved` 来启动战斗。

### Unit 数值脉冲恢复（2026-09-04）

`NumericRegenerationComponent` 是 MMORPG 层的来源中立 Unit 能力：定义只包含当前值/上限的 Numeric 编号、结算间隔、检测到数值下降后的延迟，以及二选一的固定 `amount` 或动态 `amountNumericType`。动态数值来自同一 Unit 的 Numeric，适合等级成长在重算 Numeric 后立即改变后续脉冲，无须重建组件。组件只保存每个 Unit 的观察值与下一结算时刻，不创建 Timer，也不理解 mana、战斗状态、职业、宠物或协议。Monster、战斗 NPC、SummonedUnit 与 PlayerUnit 由各自已有的固定更新桶调用同一个 `Tick`；回巢等领域动作直接重置数值后调用 `ResetSchedule`。具体游戏的恢复公式必须在外置模块构建期投影成配置，不能回填到该组件。

### 玩家普通快照的结果未知恢复（2026-09-06）

本机 PG 停机复现了 SaveMulti 已提交但 ACK 超时、下次定时保存换 requestId 导致 revision 永久冲突。`PlayerPersistenceComponent` 现保存最多五条未确认领域请求（原始数据、时间、期望版本和幂等标识），先确认原请求，再捕获新状态；部分成功仅保留未确认条目。新业务事务先确认挂起快照，跨图 CaptureTransfer 在仍有未确认快照时拒绝。`PlayerDomainSaveWrite.snapshotRequest` 是可选重试元数据，不改存档/协议格式；DbProxyPlayerRepository 在进程与仓库实例命名空间内复用它。不能把未知结果当失败后重新生成请求，也不能把旧 ACK 当成最新数据已持久化。WoW335 的领域扩展存档格式不变；数据库故障期间的跨图拒绝是刻意的安全行为。

### 可交互物的不透明动作

`InteractableContentDefinition.interactionActionId` 用于没有背包/任务持久化事务、但需要在地图中执行一次动作的交互物。Core 只校验实体存在、可用、同地图、使用距离和通用熟练度，然后同步发布 `InteractableEvents.ActionRequested`；动作编号、目标位置算法、动画和协议封包全部由外置模块拥有。动作型定义不能同时声明奖励、掉落表、任务入口/目标或熟练度写入，成功后不会自动隐藏、持久化或进入重生计时。模块需要移动 Unit 时必须调用 `MapComponent.RelocateUnit`，不得直接写 Position 或自行广播移动。

## 精确取消活动技能（2026-09-08）

MMORPG 的 MapProtocol.CancelSkill 经 PlayerUnit 有序 mailbox 和转移拒绝策略进入地图技能调度器。请求必须同时匹配当前技能ID及64位施法ID；无活动技能、旧ID、错误技能或重复请求返回 cancelled=false。成功取消仅移除当前调度项并发布现有 SkillCastState，不退款、不清除公共/独立冷却、不取消已发射弹道。客户端不能借取消消息选择其他玩家；所有权继续由既有 Actor Location 路由检查。

新增协议是领域契约变更，需显式更新opcode/schema锁并通过完整codegen和进程重启部署；它不属于兼容Hotfix更新。来源游戏的取消计数、线协议和映射规则仍留在外置适配层。

## 格点返回终点一致性（2026-09-09）

MMORPG 怪物的返回完成判定必须使用导航能够抵达的终点：Grid2D 按 cellSizeMeters 对目标 X/Z 取整，NavMesh 保留连续坐标。返回期间和静止刷点的到达判断共用该语义，追击最大距离仍按原始遭遇点计算。不能仅扩大固定到达半径或由外置模块强行修改返回状态。中立仓库守卫的对角小数终点回归覆盖完成、远点拒绝及 NavMesh 不取整；本次不新增 Stable API 或协议。

## 持久击败奖励作用域（2026-09-09）

MonsterComponent 每次 Awake 分配一个 GlobalIdSystem 全局作用域，击败经验事务键由该作用域、目标 InstanceId 和角色持久 ID 组成。InstanceId 仍只保证进程内唯一，禁止单独用于跨重启的持久回执身份。同一组件生命周期内重试保持原键，重建地图组件后的新目标必须获得新键；按组件分配避免大批刷怪耗尽每秒全局 ID 序列。新增 Model 状态要求生成、构建及进程重启，不可只替换 Hotfix。

## 2026-09-08 故障恢复验收契约

地图故障后的成功条件是原账号、原角色在允许的地图恢复可玩，并保持已确认的持久化数据正确。原实例存活时重连复用原实例；动态副本状态丢失时允许由 Gate 回退到配置的安全静态地图，不要求重建原动态实例。静态地图可恢复到目标地图或安全静态地图。地图白名单、实例和空间模式必须一起核对，不能把任意地图响应当作恢复。副本进度、入场费用、奖励补偿属于玩法规则，本次不新增自动退款或重复发奖逻辑。

外网长稳不再换账号代替恢复。Rust/TypeScript 负载记录真实登录角色 ID 和每名玩家实际地图；同一账号槽位跨轮次的角色 ID 必须一致。允许目标地图和安全地图混合分布，各玩家按实际空间模式验证移动、Probe 和业务响应，原角色身份变化会导致整轮失败。动态副本探针核对同一角色、金币/背包/任务/已学技能状态，并在安全地图执行 MapProbe。

业务恢复需要两个在基础设施恢复后开始的新轮次。等待预算计入当前轮次、两轮登录/预热/测量/排空及轮次间隔；截止时读取最后一份证据。故障编排预留完整故障动作和恢复预算，窗口不足时停止新增故障。Relay 正常完成不停止故障验证，异常退出通过 OnFailure 停止注入。最终必须同时通过主验收与 Relay 对账；旧运行目录不得套用新语义重新标记通过。


### 首次进图的初始存档必须原子提交

2026-09-08 定向故障复测发现：新角色的出生背包尚未定时保存时，副本入场已经单独提交 progression。副本进程丢失后，读档能找到 progression，却找不到 inventory，导致出生道具变成空背包。问题位于 TiangZ 首次进图的持久化边界。

MapHost 对没有任何存档的新角色，在 PlayerUnit 的 ordered mailbox 内，通过现有多领域事务一次提交 inventory、progression、quest、runtime、wallet；确认成功后才注册 Location、发布 AOI 和返回进图结果。初始化或 Location 注册失败时，必须在释放 mailbox 前清理候选角色，避免排队重连观察未确认状态。已有存档只按存档恢复，不重复发放出生道具，不自动填补历史缺失领域。没有修改 DBProxy 格式、协议或数据库结构。此修改属于 Model，部署必须重建并重启游戏进程。

## 外置模块记录事务与事件消费（2026-09-10）

### 模块地图目录、迁移和停机补充

外置地图无需写入主工程 MapConfig：MapHost 启动时先装配 MapContentProfileComponent，执行同步 Entity 扩展、封闭目录，最后创建固定地图。模块登记地图空间、准入队列及 AOI 网格和频率层；重复 ID（含内置 ID）、非法出生点或不能整除的网格在发布前拒绝。未登记的旧地图仍读取原冷配置。Gate 的自定义入口也必须装配相同目录，才能返回正确空间元数据。

MapScene 是独立 Scene，没有可供模块回溯的 Entity Parent。模块可通过 MapScene.ProcessName 获取部署身份。PlayerPersistenceComponent 的迁移快照同时携带版本化模块状态信封；跨进程 PlayerTransferSnapshot 使用 schemaVersion 11，必须同批重建并重启两端。TiangZ 不解释模块血量、任务或外观字节。

继承 GateScene 的模块网关复用受保护的角色事务和路由校验；装饰器绑定不继承，必须显式绑定 Probe、MapReady、ClientBroadcast/Batch、KickPlayers。外部账号校验与游戏出口规则由模块负责，不能开放演示令牌入口绕过它们。

停机也可能调用 Location RPC。Rust 必须保留 TS 停机 Promise 并继续投递既有宿主操作完成事件，直至成功、拒绝或超时；TS 停机期间仅排空传输队列，不再推进游戏 Timer。不能停止事件队列后同步等待停机 Promise，也不能在停机开始时清空 ProcessRuntime，导致回包无人接收。

集成验收同时修正 `verify_hotfix_boundary` 对模块生成协议的误报：仅声明的 `protocol.serverOutput` 可导入宿主协议 `binary/message/rpc` 三项内部 ABI，手写模块仍被拒绝。模块协议自测包含生成物通过、手写导入失败两个断言，不将生成器所需内部接口扩成业务 API。

Stable Core 新增 `HostDbProxyRecords`、`CreateOutboxEvent`、事务/信封类型及 `HostStreamConsumer`。模块可原子提交自己的快照与 outbox，消费组收到后将 inbox 与业务状态同事务提交，再显式 ACK。Host 只处理固定部署目标的 Redis I/O；事件类型、去重记录、任务计数和补偿仍归模块。`process.persistence.eventStream` 为 Rust 私有配置，`IsAvailable` 只表示配置存在。详见[记录与事件闭环](../design/record-outbox-consumer.md)。不能将单记录 Repository、进程内事件派发或 MQ published 等同于消费者业务完成。

## 外置模块接入真实物品领域（2026-09-10）

ModuleGame 阶段 2 复用 ItemContentProfileComponent 的模块物品目录、ItemComponent/Item 实例、库存规划和 PlayerPersistenceComponent；具体职业、容量、装备位置与消耗规则属于模块。不要用模块 JSON 数组替代已存在的 inventory 领域，冒险记录只保存尚未领取的掉落。

药剂等跨库存和模块状态的操作应一次提交 inventory + runtime，将扣物、生命、冷却和单调操作序号同事务保存。先保存原计划，未知结果先查回执；确认后应用内存计划，旧序号回执不得重复治疗。模块可在其持久化扩展 Capture 中拒绝导出存在待确认资源操作的状态，从而阻止周期保存/迁移覆盖事务结果。恢复必须回到玩家 mailbox 并使用与正常业务相同的锁。不能将框架所有 uncertainOperations 不加区分地视为同一种待确认业务。

掉落可随击杀业务与 outbox 同事务产生，再以稳定掉落 ID 事务发放真实物品，最后 CAS 确认领取；两步之间失败则保留待领取条目并读取旧回执重试。验收应包含满包、并发、归属/版本拒绝、提交成功后丢回包、旧回执重放、冷重启及数据库对账。该接入复用已有稳定 API，没有增加游戏专用 Core 接口。


### ModuleGame 阶段 3：战斗内容的框架接入

- 模块通过 MapScene Factory 的 MonsterContentProfile、SkillDefinitionProfile、BuffDefinitionProfile 注册内容；怪物 Unit、仇恨、追击回归、施法冷却和 Buff 生命周期由 MMORPG 领域拥有。模块保留业务伤害公式、首击归属及 DBProxy/outbox 奖励编排。
- MonsterContentDefinition.leashRangeMeters 可选且必须为有限正数；省略保留 30 米。距离由框架怪物行为结算，不在业务 Tick 中另写怪物 AI。
- CombatStateComponent.ConfigureResourceFlows(ownerId, []) 显式关闭默认资源恢复；未调用仍使用旧 HP/MP 恢复。所有者冲突仍拒绝，失败替换不得破坏旧定义。需要关闭默认回血的模块在 PlayerUnit Factory 中声明，重建玩家时重新装配。
- 角色生命统一使用 NumericComponent.CurrentHp；模块升级、换装和持久化恢复必须同步真实数值。模块入门技能目录可授予固有能力，完整学习体系仍走已有技能学习/持久事务接口。


### 夜间阶段 4：队伍目录设计

队伍关系归 MMORPG 的 MapManagerScene，模块显式装配并注册 namespace 策略。角色身份来自认证 Session，成员使用 characterId；同步版本化变更不得跨 await。目录暂态、短断线保留，副本所有权与奖励不能依赖目录永久在线。设计见 [队伍目录](../design/party-directory.md)，已通过夜间队伍与副本功能验收，容量测试仍未执行。


## 夜间阶段 4：队伍目录与私有动态地图（2026-09-11）

MapManagerScene 可由模块装配 PartyDirectoryComponent，按 namespace 隔离临时队伍。目录拥有成员/队长、修订、邀请和操作回执；同步转换避免 unordered mailbox 的异步交错。角色身份来自已鉴权 MapUnit，客户端不能自报。短暂断线保留成员；Manager 冷重启不恢复队伍。

DynamicMapProxy.Create(requestId, mapConfigId, characterIds?) 新增可选私有名单。提供时必须为 1–40 个不重复的正 uint64；缺省保持旧动态地图语义，显式空数组拒绝。Manager 和宿主均校验重试名单，注册快照恢复名单；MapHost 创建前原子预留整份名单 30 秒，统一玩家工厂检查身份。预留过期释放容量，但白名单持续到实例销毁；迟到成员仍须满足实际容量。预留期间禁止回收。MapScene 工厂可读 MapRuntimeProfileComponent.AllowedCharacterIds 的冻结副本。名单不允许在实例运行中变更。

边界：框架不拥有任务条件、Boss、奖励或强制整队传送。预留原子性不等于跨玩家迁移事务；游戏模块负责参与确认、单人迁移失败提示和副本生命周期。容量压测暂缓。新增内网协议可选 private_roster 字段已显式更新锁并重新生成。

验证进度：队伍与公开/私有地图定向测试 18/18；模块真实网络队伍测试及冷重启、Godot 三种实际窗口尺寸通过。新一轮完整框架验证进行中。


私有实例恢复补充：DynamicMapProxy.Inspect(requestId) 只读返回 recovering / unknown / creating / active / lost / disposed 及实例 ID。Manager 启动的宿主租约恢复窗口内，未知私有创建请求拒绝立即分配，查询返回 recovering；已恢复的记录可查询。业务不能仅以 Location 暂时查不到路由为依据判定实例丢失。模块在目录 active/creating/recovering 时提示稍后重试，仅在 unknown/lost/disposed 时结束旧清单；不自动重建旧副本。定向测试 19/19，新增内网查询协议已显式更新锁。


### MapHost 异步上报的退出边界（2026-09-11 夜间验收）

MapHost 的 Manager 注册/续租/销毁通知以及 Location 归属重报属于 MMORPG 宿主生命周期。组件定时器取消不能撤回已发出的 RPC；每个异步返回点必须检查组件与所属 Scene 是否仍存活。已销毁的宿主停止后续重报和日志访问，进图等待中的归属发布则明确失败，不得把晚到的响应当作可继续创建 Player 的授权。通用 Core、协议与 DBProxy 无需为此增加特例。

回归覆盖成功/失败响应晚于组件销毁、注册后续动作阻断、销毁通知批次中断，以及进图归属等待失败。客户端短断线恢复仍由模块处理，并通过新输入租约和权威全量快照恢复；服务端不得重放客户端攻击指令。


### 外置游戏的失联恢复目的地

GateScene.ResolveRecoveryMapInstance(session) 是 MMORPG 进图恢复的受保护策略点，仅在 Location 确认旧角色路由已失效后调用。默认保留演示地图；外置游戏覆写时可通过 PublicMapProxy 执行自身安全地图分线准入，不能直接构造 Player 或跳过 Location/fencing。等待分线后再次验证当前 Session 路由。EnterPublicMap 已获得准入时复用该目标，不重复申请另一张地图。此改动不增加 Core 特例、不改变协议。

实际游戏进程故障验收发现并修复了旧路径硬编码回到演示地图 1 的问题。营地正常退出和副本宿主强杀后重启均完成真实网络恢复：旧输入拒绝、已提交奖励保留、失效副本回营地并要求新操作显式开新轮。临时网络故障而权威 Location 尚未确认失效时仍等待，不擅自复制角色。新增目的地/fencing 回归 7 项与退出竞态 9 项通过；完整矩阵重新执行以覆盖最终改动。


### 多模块客户端 SDK 共用连接

TypeScript 生成客户端只要求 `Pick<RpcSocket, "call" | "send">`，不要求具体 SDK 拷贝中的类身份。两个独立分发的 SDK 可以复用同一底层连接、RPC 序列与认证 Session，避免私有 transport 字段导致名义类型不兼容。生成器自测先复现了旧构造类型的 TS2345，再验证两份 SDK 的同连接调用可以通过严格编译；Godot 新工程双 codec 运行验证也通过。消息码、帧和 wire schema 不变，所有生成客户端由生成器重新输出。

### 2026-09-11 协议声明换行无关性

`codegen_proto.mjs` 支持一个 message 内同一行声明多个字段；解析字段前跳过行注释与块注释，保留带引号的字段选项值。换行排版不应改变锁文件和 SDK 的字段集合。`module_protocol_codegen_self_test.mjs` 覆盖紧凑商店消息的完整 schema 字段列表、注释中的伪字段排除，以及生成 Godot codec 往返；设置 `GODOT_BIN` 执行实际 Godot 验证。

### 2026-09-11 独立客户端弹道投影

`SkillMapComponent.Projectiles()` 返回当前飞行中的 `SkillProjectileSnapshot` 冻结数组和分离元素，包含 Cast/技能/来源/目标 ID 及服务器发射、命中时刻，不包含效果定义或可变容器。独立模块可按自身协议和 Audience 投影表现；技能状态机仍独占发射、取消、命中和伤害结算。读取快照不能延长弹道或修改规则，短于广播间隔的弹道可能不出现在采样快照中。


### 外置模块资源与任务事务示例

外置游戏可将 Numeric 中的即时资源值捕获到自己的 runtime 持久扩展，版本化标记首次初始化，避免旧存档、转图和重登时反复补满。物品事务结果未知时，由同一内容所有者暂停 ConfigureResourceFlows；确认后恢复，不能补算冻结时长或重放旧资源值。技能消耗仍通过原生 SkillResourceCost 完成。

模块任务目录、前置关系、追踪选择与业务事件的任务实例集合属于模块。多个匹配目标使用已有 AdvanceQuestState，并与 inbox 在一次 DBProxy CommitRecords 中原子提交；消费者用击杀时冻结的实例集合匹配，不能按消费时才接取的任务回补。旧事件兼容和模块存档 migration 均由模块维护，Core 不认识具体任务 ID。


### 动态实例回收与未决结算（2026-09-11）

MapHost 在删除 Location 路由前，对目标 MapScene 发布 `MapLifecycleEvents.BeforeDispose` 同步只读否决事件。默认通过；模块存在未确认奖励、准备事务等时返回非零私有错误码，监听器不得执行异步保存或修改状态。显式 Dispose 和空置五分钟兜底都走同一边界，仍保留玩家/进入预留检查。模块应在自身定时任务完成结算后自然解除否决，不能靠延迟几秒假定数据库成功。

DynamicMapLifecycleComponent 合并同实例并发 Dispose；宿主销毁后，删除路由的迟到响应不再访问已分离父节点或继续销毁。MapManager 对在线且支持目标模板、但名额耗尽的候选返回 MapHostCapacity；无在线/无合适模板宿主返回 MapHostUnavailable。业务可分别提示容量与连接问题，不能把容量拒绝当成新实例创建成功。

副本放弃是模块语义：携带当前 runId，验证拥有者/队长和参与名单，先回收空实例再写终态；同 runId 重试不得影响下一轮。实例消失且中央目录仍在恢复时不提前写终态。Wasteland 使用独立 schema v2，原 v1 清单无损升级，已放弃不发通关奖励。


### 单玩家领域事务与 outbox（2026-09-11）

`PlayerPersistenceComponent.ApplyTransaction(operationId, domains, data, result, effects?)` 可附带 outbox / append；effects 会在首次 await 前复制，且要求至少两个不同的领域记录。底层沿用 Repository 的 DBProxy 原子提交，不新增独立发布步骤。单玩家多领域用此入口，多玩家仍用 ApplyMultiTransaction。提交结果未知时用相同 operationId、相同领域集合 LoadTransaction 恢复原始回执，不能重新生成事件 ID。Model 方法形状改变须完整构建并重启。


### 2026-09-11 装备上限与有界奖励窗口

Wasteland 0.4.0 将装备品质、槽位、护甲熟练度与属性公式留在外置模块。装备变更从基础/等级/装备重算，库存和裁剪后的当前 HP/MP 通过现有 PlayerPersistence inventory/runtime 事务提交，结果未知先恢复原回执。提高上限不能默认补满。TiangZ Numeric/Combat/Item 继续持有通用运行机制，无需认识装备材质或副本奖励 ID。

模块可用独立、固定大小的奖励溢出记录和角色 head/tail 游标维持有界领取窗口。全员进度、溢出记录、统一 inbox 仍在一次 DBProxy CommitRecords；补入使用 CAS，最终入包沿用原生库存幂等事务。旧 schema 迁移和保留策略属于模块；不能用扩大角色快照数组或提前 ACK 代替持久闭环。

模块内部 JSON 与外部 Protobuf 并存时，uint64 需要明确转换契约：十进制文本运输，编码前恢复 bigint。本次只修改 ModuleGame 业务代码与框架说明，未新增 Core/Rust/DBProxy API。客户端未启动；禁止把历史 Godot 验收结果当作本轮 UI 通过。


### 2026-09-11 队伍持久化与冷恢复

PartyDirectoryComponent 属于 MMORPG 通用队伍领域。Register(namespace, {persistent:true, maxMembers, invitationMs, offlineRetentionMs}) 启用持久模式；默认仍为临时模式。认证后的服务端适配器通过异步 Execute 请求，PartyActionHandler 已切换到此入口。同步 Act 只允许临时模式，防止绕过持久化。游戏模块负责启用、职业/副本条件与自己的固定参与名单，Core/Rust/DBProxy 不增加游戏语义。

每个业务 namespace 由一个 MapManager 持有。Execute 经场景命名锁隔离计划，使用现有 HostDbProxyRecords 将 tiangz.party.directory 的名单快照与 tiangz.party.receipt 的操作指纹同事务 CAS 提交，确认成功才发布内存。冲突最多重读四轮；结果未知不假定失败，下一次携带相同操作 ID 和原请求查询持久回执。旧命令重放返回当前视图，不重新建队、不把旧队长操作作用到新队伍。名单保存成员、队长、版本与绝对邀请期限；重建时校验唯一成员归属和合法队长，拒绝损坏数据。

持久模式离线不自动退队或换队长，必须显式退出/踢出/移交。重启先恢复为离线且地图位置为零，认证心跳重新确认在线位置；在线状态和地图路由不落库，未变化心跳不写快照。收到邀请后自行建队会清除收到的邀请。临时模式保留离线超时退出语义。

本版是每 namespace 最多 1 MiB 的有界整体快照，超限拒绝提交；不是分片目录或多 Manager 在线状态共享实现，尚未容量压测。操作回执持久保留，尚无归档/清理策略；不能按邀请过期时间删除幂等回执。后续大规模目录应独立评估分片和索引，不放宽快照上限掩盖问题。

这是 Model/接口变更，必须完整构建并重启对应部署，不能仅热更新。旧版本纯内存队伍不存在可恢复的数据库源；新能力仅保证启用后成功提交的数据。本轮独立后台验收，不切换当前开发集群、不启动 Godot。副本创建时冻结的 participantIds/leaderId 仍由模块维护，恢复队伍不得重写这些字段。


### 2026-09-11 组队技能命中与辅助仇恨

SkillEvents.BeforeEffects 在每次实际效果提交前提供同步只读否决；覆盖瞬发、读条结束、弹道和引导 Tick。拒绝不会返还已经接受时扣除的资源/冷却。EffectsResolved 可附 healingByTarget，记录每个实际受治疗目标和有效恢复量，排除过量治疗；不能用配置的名义治疗量替代。

MonsterComponent.AddAssistThreat(source, beneficiary, amount) 将给定辅助仇恨按 UnitId 确定性地均分给仍对受助者保持仇恨的存活怪物，整数余数依序分配；不激活空闲怪、不影响回归怪、不改首击掉落归属。具体治疗系数由游戏模块计算。Taunt 匹配当前最高仇恨并在 1–30000 ms 的有限时间强制选中存活施法者，死亡/离图失效，回归和死亡清理强制状态；结束后使用正常最高仇恨选择。以上属于 MMORPG 领域，不新增 Core 或 Rust 游戏接口。

Wasteland 0.4.1 的 Cast 协议仅追加可选 target_character_id。空值保持自疗，非空时认证 Lobby 校验同队资格；地图以真实 CampPlayer、AOI、距离、生命和事务状态验证目标。队伍资格在接受请求时确定，读条中退队不会追溯撤销已接受法术；命中仍检查目标有效、可见、可治疗及框架配置的距离。治疗实际量的一半向既有交战怪物分配仇恨。战士嘲讽使用模块配置与 EffectsResolved 扩展，ActionType.None 明确表示无基础伤害效果。

Model/事件形状与模块协议发生变化，必须完整构建与协调重启后生效；模块 Factory 拒绝缺少命中否决、辅助仇恨或嘲讽能力的旧框架。原开发部署未切换。功能验收使用独立进程与 wasteland.smoke.events 路由，客户端可以通过 WASTELAND_TEST_PORT 指向隔离服务，不能把测试事件消费组改成开发服组。

牧师护佑复用既有 BuffComponent 的目标级 Refresh 冲突策略，满血友方也可施加；相同减伤不叠加。CampPlayerState.guard_remaining_ms 只随 AOI 可见玩家快照下发，队伍目录不广播远处玩家战斗状态。运行时模块注册版本必须与 manifest 同步到 0.4.1，清单与注册不一致会在启动时拒绝装配。

联机 UI 收尾暴露退出账号与 MapHost 停服并发的最终保存竞争。MapComponent 按 PlayerUnit 对象共享最终保存/Location 移除 Promise；成功保留到该 Unit 回收，失败移除缓存允许重试。清理前后复核 Unit 索引，避免重复销毁或处理替代 Actor。这是 MMORPG 地图生命周期修复，仍需完整构建与重启。


### 2026-09-11 协作战斗与任务提交边界（模块 0.4.2）

MMORPG SkillDefinition.targetLife 默认 alive，复活类配置 dead；接受及实际命中均校验生命状态。模块在 BeforeEffects 继续检查事务、AOI、战斗状态，EffectsResolved 执行复活比例和业务清理。BuffEvents.BeforeTick 可同步否决本次周期效果，跳过的 Tick 不补发；TickResolved 提供有效治疗量用于辅助仇恨。效果回调可能移除 Buff，周期处理必须在回调后检查生命周期，禁止继续访问已销毁父节点。

LoadPartyCommitView 封装框架队伍目录存储，返回成员与同内容、期望版本写入 guard。模块把 guard 与击杀记录/outbox 放入同一 DBProxy commit；冲突重读并重新规划。共享任务的队伍成员资格以击杀持久提交为线性化点，空间、存活、近期参战及任务实例候选在怪物死亡时冻结。目录 guard 会推进目录 DB revision，具有跨队伍争用成本；未做容量验证，不能据此宣称大规模吞吐已验证。

monster.killed schema 3 保存冻结的共享任务接收者；一个任务 inbox 和所有成员进度写入同一事务，重放不能重复计数，也不能推进后来重新接取的任务实例。共享只覆盖任务计数；掉落、金币和远征击杀仍遵循各自归属。队伍变更后的事件重投不得重新计算接收者。

怒气、能量、符文与符文能量、毒/缓速/持续治疗的具体数值归属游戏模块。符文六槽保存绝对就绪时间并随角色 vitals v5 持久化和转图，不能转图刷新冷却；v1–v4 数据仍可读取。状态图标随 AOI 快照发送，远处成员不泄露战斗信息。Model/协议变化必须完整构建与协调重启；不得用 Hotfix 替代部署。验收使用隔离服务，现有开发服未切换。

Godot 模块 SDK 同步属于游戏工程的生成边界：`sync_godot_sdk.mjs` 为每个模块复制协议类和客户端配置，并写入 `.module-sdk-manifest.json`，记录模块 ID、版本和输出目录。每次同步都清理生成根目录中不属于当前模块集合的旧目录，并拒绝清洗后的目录冲突；不能留下旧模块 SDK 让客户端静默加载。生成目录不得手工编辑，模块业务仍不能反向进入 Core。

### 2026-09-11 交易模块通知

PlayerTradeEvents.Notification 将邀请、状态变化、关闭结果传给模块监听器，携带单个目标玩家；模块复制快照后，通过 Scene.Tasks 和 Self Audience 发送自有 Event 消息。监听失败不能回滚资产，不在 Gate 转码或修改 Core。主动查询仍只返回临时会话，关闭结果的持久化补查尚待实现；查不到会话不能推断成功或失败。Model/注册变更需要完整构建重启。

### 2026-09-11 历史成交补查

PlayerTradeComponent.QueryResult(player, tradeId, otherCharacterId) 返回 pending / committed / unknown。持久化组件 ReadHistoricalMultiTransaction 强制包含调用者角色，只读取双方 inventory/wallet 的原事务回执，不推进当前 revision、不清除未决集合、不应用旧资产。交易领域解码后校验交易 ID 和双方角色 ID；存储错误向上传递，缺失回执不能解释为失败。查询不要求对方在线，不依赖当前地图会话。调用端保留 tradeId 与对方角色 ID；回执过期或未成交均可能 unknown。此能力不持久化取消结果，不替代客户端重连处理。


## DBProxy默认权威读取契约（2026-09-17）

默认Load/LoadMulti改为PG主库已提交状态，失败报错、不退缓存；整批一个SQL快照，不包括Server未保存内存、Enqueue未落库及快照之后的提交。缓存读取必须显式选择，min_revision只适用于已知版本调用方，不能作为登录恢复前提。保活重连复用原权威Actor；冷登录/进程恢复才访问存储，跨服接管仍先完成所有权交接和必要保存。

已确认PG提交后缓存失败仍返回成功并后台修复；PG提交结果未知保留原操作号重试。禁止用缩短缓存TTL、后台重试或进程本地dirty标记代替跨节点正确性。故障表现为成功写入后读到旧缓存；默认权威读取消除这一依赖。原按namespace启用权威读取方案已被默认全量权威替代，保留配置只额外禁止指定namespace显式读缓存。

本次核对Repository/玩家恢复链路使用直接Save/事务，没有将Enqueue ACK当PG提交；新接入不得假定Enqueue后Load立即可见。必须部署所有DBProxy候选节点后再宣称新契约生效；已有游戏SDK默认Load无需传版本。新显式缓存SDK入口需要宿主另行适配，旧宿主明确拒绝该入口。复测：DBProxy根目录`node tools/test_authoritative_reads.mjs`（仅隔离PG/Redis）、`cargo test --workspace`与`npm run test:typescript`。真实存储结果与未覆盖容量见DBProxy的`docs/default-read-contract.md`，不能继承旧二进制的长稳结果。

SLG默认权威读取联合验收入口在`../TiangZ-Examples/packages/slg/tools/authoritative_acceptance.mjs`：默认只计划，build固定源码/制品哈希并单独构建短TTL，run为每项每轮建立隔离环境。正式Rust探针解码DBProxy协议，按连接/rpcId锁定提交成功回包；提交前强杀必须丢弃扣住的请求，不能在清理时释放。产粮对账使用持久分钟检查点，回执独立于战报；负缓存必须在冷恢复前确认有效。夹具单测不能代替实库验收，D5握手模拟不能冒充历史服务端，资源快照不能冒充容量时序。详见SLG的`docs/authoritative-read-acceptance.md`。

2026-09-17提交前检查：AI技能便携性自检曾在正则中写死两个本机盘符，被本机路径门禁检出。改为通用Windows盘符/分隔符模式，覆盖全部盘符并保留门禁；`node tools/verify_no_local_traces.mjs`和`node tools/ai-assistants/check.mjs`复核通过。不要为自检脚本关闭路径检查。 / The portability self-check now rejects all Windows drive paths instead of embedding machine-specific drives; both trace and assistant checks pass without weakening the gate.

## 持久化写法标记（2026-09-19）

`.native`的`@persistent`实体可以再加`@queued`或`@transactional`（tiangz-native-language 0.17.0，尚未打标签发布）。写法由数据语义决定；何时写、哪些记录组成一次事务仍由业务代码在调用点决定。DBProxy代码不变。

| 描述 | 生成的仓库 | 可用写法 |
| --- | --- | --- |
| 不加 | `DbProxyEntityRepository` | `Save`/`SaveSnapshot`，以及新增的`TransactionWrite`（只生成事务写入记录，不访问存储） |
| `@queued` | `DbProxyQueuedEntityRepository` | `Enqueue`/`EnqueueSnapshot` |
| `@transactional` | `DbProxyTransactionalEntityRepository` | `TransactionWrite`/`TransactionWriteSnapshot`，交给`HostDbProxyRecords.CommitRecords` |

- 一条记录只允许一种写法。排队写不带revision校验、按记录合并，落库是无条件覆盖；同一记录若还被CAS保存或事务写入，迟到的排队值会覆盖已确认的新数据。校验器拒绝两个标记同用，生成仓库在类型和运行时上都没有被禁止的方法；业务绕过生成仓库、直接拼namespace写入时不受保护。
- Enqueue按DBProxy部署的`backlog.enqueueAck`确认：默认`aof`等Redis本地AOF落盘，`memory`仅确认Redis内存，崩溃可能丢失尚未落盘的已确认入队；两档都不表示PG已提交。成功响应不携带档位，业务必须核对部署契约；测试`memory`后端另为进程内易失存储。崩溃或换服后可能回退到最近落库状态，不能用于经济或需要立即恢复的数据。仓库只发送一次、不在内部重试：下一次排队写会取代它，重试只会在过载时放大负载。
- 受限仓库读到旧schema只在内存迁移、不回写：排队记录回写会与待落库值竞争，事务记录由下一次事务以读到的revision写入新版本。普通仓库保持原有CAS回写。
- 未加标记的实体，生成文本与0.16.0逐字节一致（已用Examples已提交的`NativeItemPersistence.ts`实测）。
- 开发期更换写法直接清库；从`@queued`改为其他写法前，至少停写并等DBProxy排队积压清零。运营中更换写法造成的数据问题不由DBProxy兜底。
- 发布顺序：先给tiangz-native-language打`v0.17.0`，再升级TiangZ依赖；在此之前主工程codegen仍使用0.16.0，新标记不生效。公共API锁的处理见[API稳定性迁移记录](../reference/api-stability.md#开发中)。

长稳入口：`npm run soak:write-modes -- plan|check|smoke|run`（控制器`tools/persistence_write_modes_soak.mjs`），Examples可用`npm run reliability -- plan --suite write-modes`编排。探针在真实TiangZ进程里经Host op同时运行三种写法，账本先记意图再执行写入，进程在任意时刻被杀都能判定可能已提交的最大值。

- `smoke`：内存DBProxy + 一次探针强杀重启，不接触数据库容器。
- `run`：使用专用`tiangz-dbproxy-local`容器中的独立库`dbproxy_write_modes_soak`和Redis库号5，注入PG、可靠Redis、缓存、AOF、首选DBProxy节点、全部DBProxy节点、探针进程七类故障；每次故障后要求每个玩家每种写法再确认两次；最后排空排队积压，按账本核对，并直接查PG核对写法互斥与事务恰好一次。
- `run`会清理上述专用数据并停启容器，必须由用户明确授权；与其他演练共用`reliability.lock`，不能并行。2026-09-19单测和smoke通过。前两次`run`在可靠Redis故障后失败（排队写过载，见失败教训表，账本均0违例）；按最坏重试放大降低排队写负载后，第三次`run`（10玩家，排队写每90秒一次）通过完整一轮七类故障：普通写15,518次、排队写232次、事务20,640次确认，0违例，重启恢复读取与最终读取无差异、排队写无回退，PG直接核对写法互斥成立、每个事务序号恰好提交一次，证据`write-modes-run-2026-09-19T07-50-07-965Z`。这证明的是正确性，不是容量；AOF场景中PG停机期间只确认了2次排队写，该样本偏少。随后DBProxy入队改为组提交（排队上限4096、2秒排队期限），TiangZ排队写仓库不再重试；第四次`run`在与首次失败相同的负载（20玩家，排队写每250毫秒一次）下通过完整一轮：普通890、排队1,807、事务1,750次确认，0违例；PG停机期间有80次排队写只在AOF中得到确认，证据`write-modes-run-2026-09-19T09-16-36-248Z`。**更正**：当时的AOF核对只比较最终值与强杀前快照，而后续写入总会覆盖同一记录，因此不能单独证明这80次确认在强杀后存活；此后已改为Redis一应答就直接读取恢复出的积压逐个核对（见下）。此时入队平均约1.8秒（要等当前批和本批两次落盘），而探针客户端只有4条连接、每条同时只有一个请求，吞吐受客户端并发限制。

连接与确认档位（2026-09-19，已实现，尚未跑整轮`run`）：

- 同连接多请求在途：DBProxy服务端`server.maxInFlightPerConnection`、客户端`max_in_flight`（宿主`persistence.dbProxy.maxInFlightPerConnection`），默认均为64。同一连接上涉及同一记录、operation ID或trade ID的请求按到达顺序执行，其余并发；连接池按记录稳定路由，所以同一记录的写入仍按调用顺序落库。单个请求超时只有在发出后整条连接一帧未收到时才换连接；后端panic只让该请求收到`INTERNAL`。协议格式不变，新旧两端兼容。
- 排队写专用连接：宿主`persistence.dbProxy.queuedClientPoolSize`（0..64，默认0=与`clientPoolSize`共用）。大于0时`EnqueueSnapshot`/`EnqueueMultiSnapshot`只走这些连接，总连接数为两者之和。排队写与直接写之间不保证跨连接顺序，这依赖“一条记录只允许一种写法”。
- 入队确认档位：DBProxy部署配置`backlog.enqueueAck`，`aof`（默认，等本地AOF落盘）或`memory`（写入Redis内存即确认；Redis进程或机器崩溃可能丢约1秒已确认入队，正常重启不丢）。整个DBProxy部署统一，协议与业务代码不变；只把允许丢几秒的数据放到`memory`部署，充值、抽卡、建筑升级必须直接写PG。
- 长稳控制器：探针用4条共享+2条排队写专用连接，每条64在途；新增`--enqueue-ack aof|memory`（默认aof）。AOF故障在Redis一应答就用一次只读EVAL读出每个玩家的积压条目：只核对PG停机期间才确认的玩家，值大于强杀时已尝试值的条目是重启后新写入、记为masked；任何缺失或低于要求即失败，一个都核对不到也失败。`memory`档位只要求强杀3秒前的确认存活。2026-09-19单测、`check`、`smoke`、`verify:quick`通过。整轮`run`（20玩家，经用户授权）：
  - memory档位首跑在AOF核对处失败：账本靠解析日志滞后于探针，强杀时的已尝试值偏旧，20个玩家全被误判为masked；改为Redis重启前取已尝试值。
  - memory档位第二跑在最终读取失败：20个玩家PG值都比最后确认少1–2。根因是DBProxy积压的既有缺陷——记录落库中又被入队会回到pending，另一节点的worker可并发领取，慢的旧值无条件写入后到覆盖新值。DBProxy `4bdde13`改为不领取仍有有效租约的记录（其ACK会把新值重新排队），并加真实Redis回归测试。
  - 修复后两档都通过完整一轮七类故障，0违例：memory档位普通4,161、排队47,607、事务6,932次确认，PG停机期间3,460次排队写，重启后直接核对20/20，证据`write-modes-run-2026-09-19T13-50-45-339Z`；aof档位普通4,111、排队7,277、事务6,891，PG停机期间500次，核对20/20，证据`write-modes-run-2026-09-19T14-05-45-956Z`。修复前那次aof通过（`13-07-25-573Z`）不作为结论。
  - 原“仍存的窄风险”（落库任务租约过期后才写PG，旧值覆盖新值）已解决：见下方防护序号。

落库防护序号与500玩家过夜长稳（2026-09-20）：

- 根因不是PG/Redis的缺陷，是DBProxy的设计：落库只靠租约互斥，PG侧无条件覆盖。租约挡不住"旧写入晚到"——任务卡顿、两节点时钟偏差、Redis崩溃回滚领取状态，都能让失效任务把旧值写在后面。
- DBProxy `3ea22de`：入队脚本按 `max(Redis时钟微秒, 上一序号+1)` 分配防护序号写进条目（旧格式条目按0处理）；迁移12给快照表加 `queued_sequence`；落库改条件UPSERT，序号不更大就不写、返回 `Duplicate` 与当前版本并照常确认。加固：租约时间改用Redis `TIME`、落库事务 `statement_timeout` 10秒。测试：条目格式单测、真实PG防护语义、真实PG+Redis复现"租约过期后旧值才到"。
- 过夜长稳（500玩家，每人每种写法60秒一次，每节点8条PG连接，aof档位）：主体运行连续通过7轮七类故障、0违例（01:03–05:57）；第8轮在dbproxy-all后因业务恢复超时失败，当时直接查PG，500个普通写与500对钱包全部与账本一致、总额守恒。随后用加抖动的探针再跑2轮完整收尾并通过：普通28,522、排队32,755、事务31,944次确认，13个故障动作，0违例，排空积压后最终读取0问题、无排队回退，PG直接对账0问题（2,000行快照、每玩家事务恰好一次），证据`write-modes-run-2026-09-19T21-59-07-118Z`。
- 长稳控制器同期修的都是核对/夹具问题，不是产品问题：500人恢复读取改并发（串行约2分钟接近就绪上限）；AOF核对的键改在Redis脚本内生成（500个键超Windows命令行上限）；AOF核对补查PG（PG优雅关闭前几秒仍可落库，条目因此不在积压里）；探针出错退避加50%–150%抖动（固定退避让数百玩家在节点恢复后同步重试）。新增 `--step-ms`、`--dbproxy-shards`，放开到500玩家/12小时。
- 容量观察（不是产品结论）：本机Windows Docker上单次PG操作约117→133毫秒（随表增长变慢），每节点8条连接约每秒80次操作。500玩家每5秒一次会把它压满并触发2秒连接排队快速失败；60秒一次约为容量三分之一，稳定。
