# 2026-09-16：先选业务工程，再写模块

## 2026-10-09：FFI 回调持有裸指针，不等于可以修改共享引用

稳定的 Box 只保证地址和生命期。只要还有普通共享引用在用（例如调用 V8 期间触发 GC 回调），回调就不能从裸指针构造 `&mut` 去改非 `UnsafeCell` 字段，同线程也不行。用 `Cell`/`RefCell` 做内部可变；不要用 unsafe 强转、删除指标或换锁来掩盖。真实 V8 回归只验证集成，不等于 Miri 证明。诊断探针在 Windows 回环上快速建连会遇到客户端 `set_nodelay` 返回 10022，先核对服务端计数，不要把它当作引擎故障。见 [TCP 诊断](../testing/tcp-task-diagnostics.md)。 / A stable Box guarantees address and lifetime only; reentrant FFI writes need interior mutability while a shared reference is live.

## 2026-10-08：异步结果在空闲进程里多等一个 tick

现象：空闲 Process（adaptive）中，async Handler（即使不 await）回包约 59–61ms，DBProxy 读写与模块 NativeWorkers 结果约 60ms，low-latency 约 18ms；同步 Handler 约 0.5ms。worker 计算期间，同进程其他请求 p99 约 16ms。现有 Scene 指标即可看到：`handler_ms=60 max_handler_ms=66` 而 Handler 本身几乎不耗时。有持续流量时被网络帧叫醒掩盖，压测不易发现。

真实原因：见[异步结果唤醒](../design/async-result-wake.md)——异步 op 完成不叫醒主循环；有未完成 op 时推进 JS 等满 1ms 计时器（Windows 约 16ms）；async Handler 回包产生于 Update 之后的微任务。

正确做法：宿主任务在结果可取后（先 `oneshot` 发送、通知守卫先于发送端声明）调用 `host_wake`；推进 JS 不设计时器；Update 后有在途 async 任务时补跑微任务再取回包。新增宿主异步 op 若在其他线程/运行时完成，也必须在结果可取后通知。

禁止的绕过：不能缩短 idle_tick 或改 low-latency 掩盖；不能让 Update await Handler（宿主 block_on 会把 V8 卡到 op 完成，单元测试实测 30ms op 卡 33–42ms）；不能在 worker/宿主线程读写实体存储（线程局部，读到空数据不报错）。

实验中走过的弯路（保留供复测者避免）：给 `poll_event_loop` 传自定义 waker 无效——op 完成只唤醒 deno 的 tokio 本地任务；只发唤醒信号无效——`recv_timeout` 在队列为空时继续睡；推进时用 0ms 超时无效——tokio 计时器仍按 1ms 粒度驻留，Windows 上照样约 16ms；实验驱动用同步方式读进程 CPU 会卡客户端约 150ms，使各场景最大值失真，须异步读取。

复测：`cargo test --bin TiangZ -- host_wake dbproxy native_worker host::tests process::tests`；端到端对比需在真实 Process 中用 starter 模块夹具测修复前后的空闲 RTT（同步/async Handler、NativeWorkers、Repository、HostStreamConsumer），并在并发负载下分别测游戏进程与 DBProxy 进程的每请求 CPU。驱动脚本是一次性实验工具，未入库；数值见设计文档验证记录。

源码落地：双亲合并`c06b244`已快进原`feat/v0.7`，原工作区完整Rust/KCP和启动包重建、真实模块宿主启动/停止通过，Host SHA3d390885...；生成/依赖锁无漂移。原目录证据`temp/v07-065-integration-main/`与隔离矩阵分开，不把旧二进制当新Rust结果。MSVC既有链接警告保留、未push，见[源码对齐](../design/v0.7-merge-0.6.5.md)。

2026-10-07源码对齐终验：0.6.5关闭/Native worker整合保留0.7拆分、预算和RAII，另补成功/业务错误均按UTF-8字节限长，固定panic诊断保持分类。最终实现树044287f8，Windows发布级check8/quick35/full9、Rust279通过；Linux原整合full9/Rust282，最终Rust修复另跑全目标Clippy/Rust283和两模块V8/worker真实热更停机通过，不把旧full或专项互相冒充。API锁/codegen/204导出冻结检查通过、依赖与协议锁不变；首轮夹具、可移植路径和真实超长错误反例均保留，见[源码对齐](../design/v0.7-merge-0.6.5.md)及[失败教训](#整合旧分支时须适配当前架构和宿主abi)。后续核对未完功能、SDK/插件与发行输入，未push；以下为历史快照。

2026-10-07源码对齐：正式`v0.6.5`正在独立整合到0.7，通知后关闭、WebSocket关闭握手与模块Native worker须适配0.7现有拆分、RAII和预算，不能整文件回退。worker为Process级资源，多个Scene共用容量/不可逆drain；业务须明确唯一所有者，丢弃Promise不取消计算，Hotfix等待计算与V8交付。其他五仓库没有新增上游提交，用户Examples改动保留；插件、SDK与用户指出的未完成内容分别核对。API锁/codegen、类型/关闭单测和普通Rust编译已通过，完整矩阵仍在执行，新Host不继承旧制品或DBProxy长稳资格。详细来源、首轮失败与复测见[源码对齐](../design/v0.7-merge-0.6.5.md)及[夹具适配教训](#整合旧分支时须适配当前架构和宿主abi)，未push。

2026-10-07 11:12 R7真实24h终验通过并按约定停下：不能只看load结束或state.passed，已重新核实际报告SHA、preflight=false、86400.392s/120故障/300.979s空载/退出、独审结果及52冻结文件，14954正常区间零错误、281179唯一事件与所有payload/元数据一致，容量与内存通过。实际512MiB下驱动RSS峰274.91MiB/审查196.15MiB、OOM/swap零，max1724回收证据保留；旧规模夹具漏progress的教训仍有效，不因最后通过删除它。PID/owner/image核实际本轮已停止、保护业务及probe停用确认；只授DP该合成负载资格，不自动授旧套件、实际SLG、Host热更或7日部署。完整证据在R7 qualified-1440m与[收尾专题](../design/v0.7-soak-control-memory.md)，无产品/生成/版本或push变化。

2026-10-06 14:37 规模夹具不能只扩两个显眼数组：旧24h报告只扩大samples/intervals，漏了真实审查使用的progress（仍11518）及faults/schedule/generations，旧包络证明不完整。应从真实序列化schema核全部增长数组、先用实际冻结流式发布，再让Python重新解析持有与Node审查并发，避免共享引用构造低估；加实际512MiB干净文件缓存压限而非仅新空组。新完整40.89MiB夹具64s通过、reserve采样峰241.57MiB<448、OOM/swap零，max1125/暂态峰512.19MiB必须保留。SQL/Redis形状双编号来自同一已核SQLite，仅内存证明；不冒充独立投递/实际24h，也不以synthetic撤销或补发旧资格。禁止漏数组取绿、改预算/强制GC/drop caches/裁剪日志。复测新root的 `temp/v0.7-control-cache-preflight-20261006-r1/start-preflight.py`，11份源字节SHA/发布及解析结果留档，R7现场/源报告/冻结helper未变，详见[收尾专题](../design/v0.7-soak-control-memory.md)，本次无产品/生成/push变化。

2026-10-06 13:02 控制缓存触限与OOM须分开报告：R7新960m真实完整通过80故障/300s空载/全量收尾后，1440m已从11:03:23.820启动；前缀1423原始区间/1227正常零错误、10/120恢复。新阶段512MiB控制父组max持续增至143，总501.5MiB/file396.2MiB/anon96.2MiB，1414资源行reserve峰109.36MiB低于448MiB、OOM/swap零。max是回收压力，不可说max零或压力已停，也不可当OOM；前缀正常错误零不证明未来回收无耗时影响。应保留完整max/anon/file/dirty/实际PID与正常区间证据，禁止清原证据/drop caches/加预算或改冻结运行代码取绿。只读复测 `probe-cloud.py`、`inspect-online-prefix-1440.py`，原960m检查器保留；证据R7 `qualified-960m/downloaded-manifest.json`、`latest-completed-stage-review.raw.json`、`latest-control-cache-pressure.raw.json`，详见[收尾专题](../design/v0.7-soak-control-memory.md)。本次仅记录与独立检查器，无产品/生成/期限或push变化。

2026-10-06 08:50 正常PG慢占用必须独立留证：R7约14h前缀8642正常区间零错误，但07:13:09正常时段六连接同时slow_hold_released，持有608–659ms、最老等待至811ms；PG真实日志四COMMIT约630ms/维护确认DELETE约606ms。不能把正常WARN硬塞故障窗口、与queue_timeout混算、看到WARN就停测，或因客户端没失败就丢掉延迟证据。先匹配实际角色/分片/PID/代次与PG语句，再对齐SQL与资源；约30s采样不能证明0.6s瞬时wait_event，CPU配额未throttle只能排除本组已记录的配额限流，不能直接归因磁盘。此次提交路径慢已证、底层原因未证，原2s/5s未调整，日志/原始前后样本留在R7 `normal-slow-holds-decoded.json`、`normal-slow-hold-samples.raw.json`、`normal-slow-hold-analysis.json`；复测只读 `inspect-online-prefix.py`。960m70/80恢复、node2连续PSS低位增85KiB且OOM/swap/max零，前缀不授最终资格，详见[收尾专题](../design/v0.7-soak-control-memory.md)，无产品/生成/现场变化或push。

2026-10-05 19:28 现场核验基准的新教训：封存后本机同名辅助副本可能因read_text/写出变更LF/CRLF，不能直接拿它的当前字节当远端冻结源码。此次只读prefix首轮误报hash，逐项证明云端10个helper全匹配冻结计划，本机保护辅助副本1930字节/封存1976字节仅换行差异、AST相同；应先核计划固定SHA，再按payloadSha256严格核云端字节，辅助复制不得覆盖封存payload。不得改原manifest、忽略远端SHA或以AST等价代替原字节验证；首轮stderr/字节证明保留，修独立检查器基准后完整复算382原始区间/326正常零错误及期限/内存/保护。复测 `python -B -X utf8 temp/v0.7-cloud-audit-r7-20261005/inspect-online-prefix.py`，证据 `prefix-helper-source-inspection.raw.json`、`prefix-helper-line-ending-proof.json`、`latest-online-prefix.json`。新30m完整5故障/空载/收尾已过，新960m18:56:13.457开始、3/80故障恢复，前缀不授完整资格，详见[收尾专题](../design/v0.7-soak-control-memory.md)。只改记录/本机只读检查器，现场/产品/codegen/push均不变。

2026-10-05 18:25 新故障长稳已从18:21:01.992完整30m开始，R7现场/计划/真实ELF/限额/业务保护核验通过，1/5故障已恢复、错误暂零，后续独审过关才接960/1440m。新教训：只读部署身份检查也会撞计划强杀，首次MainPID零必须留原错误并核真实注入/重启时间与代次，不能笼统记部署失败、放宽存活断言或重放一次性安装。本次检查18:23:02.825确在18:23:02.098强杀至18:23:17.435新代次之间；恢复后同一轮实际进程/52文件/资源/保护重新通过，辅助脚本补失败unit/属性。复测与原证据入口 `temp/v0.7-cloud-audit-r7-20261005/verify-deployment.py`、`planned-fault-verification-boundary.json`、`post-install-verification.r1.err`、`post-install-verification.json`、`actual-load-image.json`；不要覆盖原尝试。engine修复31a8a5b，DBProxy记录3fbc982，新30分钟任务首轮0/云端guard正常，旧failed资格零、当前前缀不提供整轮资格；详见[收尾专题](../design/v0.7-soak-control-memory.md)，无生成/产品重编或push。

2026-10-05 18:17 扩大规模收尾预检已完成：实际24h对应SQL/准备Redis全280959唯一事件、86一致重复及元数据/payload逐条匹配；Python持有重新解析后的扩大报告（避免数组共享引用低估真实驻留）与Node共同在512MiB预算下完成155.94s，NodeRSS175.28MiB、其控制组观测峰值249.47MiB，OOM/swap/max零。准备事件和synthetic报告只证明收尾规模/内存，不是实际24h资格；不得以模拟数组或较小报告替代这一层。复测入口为engine `temp/v0.7-audit-bounded-r7-20261005/start-scale-memory.py` 及其云端结果；一次性启动不可重放，应另建预检目录。原字节21份SHA已核、诊断停止/业务保护通过，旧failed不翻通过，下一步封存新完整阶段，详见[收尾专题](../design/v0.7-soak-control-memory.md)。

2026-10-05 18:13 新收尾规则与教训：完整分项必须用一个REPEATABLE READ READ ONLY会话，记录所有结果帧的同一快照/隔离/只读身份；缺项/重复/乱序/快照改变/超时/未完成提交一律拒绝。v2明确每项5s、计数会话60s、独立Node审查600s，不偷换旧整条5s，不改产品2/5s或服务资源。真实PG9反例及两个连接的并发提交证明一致性；并发夹具首轮硬编码语句数量误判，在写入前停止，保留stderr，修为按玩家结果帧定位后完整复测。禁止删校验、仅在没有并发时比较快照号或覆盖首轮失败。复测：`node --test tools/lib/soak_reconciliation.test.mjs` 9通过、`npm.cmd run verify:quick` 35通过；实际24h对应规模冷计数5.292/4.988s、每项至多1.247s、真实16h全SQL/Redis内容收尾113.60s通过。原失败资格零、扩大报告和24h规模全内容内存门禁正在执行，新长稳未启动，证据及脚本在[收尾专题](../design/v0.7-soak-control-memory.md)，无生成/产品改动或push。

2026-10-05 15:53 追加首次条件教训：24h对应规模首冷5.135s取消，后续同量过线不能当修复；事务work_mem对照后另建R3，首冷5.523s仍取消，未把该参数改动留入正式工具，源码恢复d6b281f6...。真实16h完整收尾/9反例通过和目标24h规模拒绝分别记录；内存规模夹具未运行，新长稳未启动。下一步全量审计若分项/分块必须保持同一一致快照、完整覆盖和明确总期限，“每项5s”不能偷换“整条5s”；禁止预热/等待状态变化后覆盖首次错误或调参数取绿。诊断已按完整owner身份停止、保护业务正常，证据/复测入口见[收尾专题](../design/v0.7-soak-control-memory.md)，未提交/push。

2026-10-05 收尾正式最小改法已接入且quick35/35、真实16h数据完整冷SQL/Redis收尾和9种PG反例通过，但24h对应1.5倍SQL夹具首冷5.135s仍被五秒取消；不能用较小数据通过替代目标规模预检。新教训：nsenter隔离Redis时，业务localhost检查必须经已验证的宿主namespace执行，不能删除检查；扩大实际schema数据先检查全部FK及操作注册表，依父子顺序填充，缺注册被拒/回滚是夹具错误，不关闭约束。首次错误、正确修法、禁止绕过和复测证据已写[收尾专题](../design/v0.7-soak-control-memory.md)。新长稳未启动，旧failed资格零，无产品/SDK变更或push。

2026-10-05 13:43 新收尾教训：真实R5C数据首次SQL5.157s超时，热查询1.240s；文件冷缓存计划显示全量账本索引回表导致主要耗时。重启PG不证明OS文件缓存为冷，上一轮预检漏了该条件。仅审计SQL的账本物化输入原型保持整条5s、同一快照/完整分组和原断言，冷运行3.461/3.429s、全部计数一致；不改全局PG参数或预热后取绿。分成多条SQL必须同一可重复读快照，且“每条5s”不等价于当前“整条5s”，不能偷换预算。正式工具修改、冷热/目标24h规模及完整SQL/Stream收尾预检仍待执行；旧960m资格零、24h未启动。诊断已停止，保护业务正常；详见[收尾专题](../design/v0.7-soak-control-memory.md)中的现象/实证根因/正确修法/禁止绕过/复测证据，无codegen、重编或push。

2026-10-05 09:27 R5C 完整960m、80故障及300.74s空载已经结束，独立全量计数SQL仍被五秒statement_timeout取消，协调器failed并停止本轮资源；1440m未启动，960m资格零，新30m资格保留。原PG日志确认jit=off与部署的合并扫描源码SHA，上一轮修法已经执行；本次具体计划/扫描/I/O/并行/checkpoint耗时待证，禁止沿用旧根因或把客户端通过当完整SQL/Stream通过。只读复算正常9969区间错误零、容量和Rust内存门禁通过；控制组峰值512MiB、max事件54、OOM/swap零，必须保留缓存压力记录。先用本轮实际数据隔离复现首次查询和完整收尾，保持各期限、资源与全量内容断言，不修改原数据或跳过失败来取绿。现象、已证原因、待证边界、禁止绕过及复测入口已写入[收尾专题](../design/v0.7-soak-control-memory.md)；本次仅取证和文档留档，无产品/codegen/重编/push，下文为历史记录。

2026-10-04 16:50 收尾修复的当前长稳现场为 `temp/v0.7-cloud-audit-r5c-20261004/` / `tzfault20261004auditr5c`，16:47:19新完整30m开始；全部五故障/300s空载/SQL和Stream逐条核对通过后自动接完整960/1440m，当前未获得新完整资格。修复代码73083c8、产品原ELF和2C4G/100人/512MiB/2s/5s保持。新52文件/实际节点/units/限额和保护业务已核，Linux控制60项、Python19项通过，本机30分钟任务首次0且只绑定新owner/root/计划SHA，真实旧目录反例拒绝；旧任务/过期timer停用、诊断容器停止。详见[收尾专题](../design/v0.7-soak-control-memory.md)，不改旧失败、继承时长、重放一次性安装或把诊断预检算作24h，未push。

2026-10-04 原证据SHA不能对本机重写的JSON计算：r5b部署前发现24505字节LF被 `write_text` 变成25419字节CRLF，语义一样但SHA不同，正确拒绝且没有目标资源/负载。保存原始字节再核云端SHA，另封存r5c候选；禁止放宽哈希、只比较解析对象或改原证据。跨现场迁移还要核ROOT、owner、target/control slice，不能只替换容器名。来源原字节、等价/CRLF差异证明与失败bootstrap留在[收尾专题](../design/v0.7-soak-control-memory.md)，不把失败启动算成长稳运行。

2026-10-04 16:37 收尾修复已完成真实隔离验证：PG分区汇总生成5208个JIT函数造成明显编译开销，原SQL首次5s超时；只在对账事务内关闭JIT、合并扫描，原5s不变，重启PG后1.192s，九种真实SQL语义反例保持原结果。Outbox的首尾六点均值易受30周期批量交易采样相位影响；先核完整时序及真实事件发布耗时，再冻结900s/至少12样本的时间窗规则，保留峰值100/斜率0.05/均值增长32/空载门禁，补最老健康待发布60s和持续/中段增长反例。真实512MiB下完整报告+SQL/Redis逐条内容收尾107.30s通过，35步quick通过；原失败不翻为passed、诊断资格零。禁止加期限/资源、删尾样本或仅用fake Docker宣称真实收尾已预检。证据、命令和后续新候选边界见[控制收尾专题](../design/v0.7-soak-control-memory.md)。

2026-10-04 新收尾教训：memory-r4负载960m/80故障/300s空载完成后，独立全量SQL超过验收工具自己的5s查询期限，15:46终态failed、1440m未启动；没有OOM，不误记为DP请求2s或SDK5s预算缺陷。预检只用fake Docker验证内存/输出，漏了真实查询耗时。应在重跑前审计所有尚未执行门禁；本次对原1650正常SQL样本复算发现尾6份Outbox均值36.5超过32，空载已清零但误判/持续积压仍未定，不能删样本、加期限或改门槛取绿。原负载/内存可分别留作证据，失败时长不继承、最终SQL/Stream未完成就不报整轮通过。原始错误、SHA清单、只读复算命令和隔离真实数据量定位方案见[控制收尾专题](../design/v0.7-soak-control-memory.md)。以下01:27等是历史快照，不能据其重新启动旧实例。

2026-10-04 01:27 当前外网960m约106分钟、10次故障恢复；原始客户端1272个区间逐行复算并对照保存证据，1077个正常区间错误零。四条PG慢占用/一次AOF超时在故障窗口，数据不变量/OOM/swap零，保护业务重新核对正常。控制组内存增长按anon/file分拆及10分钟窗口检查，近期主要是文件缓存；不能仅凭总量上涨判定泄漏，也不能凭堆约9MiB低位认定长期增长已修复。新30m已通过，当前前缀不提供完整960m/24h资格，详见[控制内存专题](../design/v0.7-soak-control-memory.md)。

2026-10-04 新增[2000 人单服连续 30 天前置条件](../design/v0.7-30-day-soak-prerequisites.md)，将预判写成负载、容量、生命周期、长期时间/编号、维护、测试工具与最终数据门禁。先审计完整部署到收尾链路并预检，不等故障后才发现 70h/4 天寿命或全量事件驻留限制；固定量级分配夹具不代替 30 天证据。TimerSystem 取消节点的静态引用保留尚未复现/修复，不能误记成 DP 当前故障；DBProxy 回执删除仍是设计，安全退休语义未冻结前禁止任意 TTL。未来业务压测另行安排，不追加当前 DP 验收、不启动新长稳或修改运行现场。

2026-10-04 当前 memory-r4 新完整 30m 已于 2026-10-03 23:41:15 北京时间独立通过五次故障、300s 空载、真实退出、SQL/Stream 全内容及原始 SHA 复核；完整 960m 在 23:41:17 就绪，继续原门禁，尚无新960m/24h资格。主动补查末尾对账的并发完整报告驻留和全量事件编号输出，在独立原 512MiB 限额下以 40.40MiB 报告、30万条40字节模拟编号完成预检，组峰值 226.72MiB、OOM/swap零；模拟输入/假Docker不算真实SQL/Redis或长稳。证据为同一现场 `qualified-30m-and-review-boundaries.json`、`preflight-review-memory/result.json`，冻结运行计划和制品保持。具体反例与复测边界见下文控制组OOM教训和[专题](../design/v0.7-soak-control-memory.md)。

2026-10-03 23:14 当前长稳入口为 `temp/v0.7-cloud-control-memory-r4-20261003/` / `tzfault20261003memr4`。控制内存修复已在 23:06:05 北京时间开始新完整 30m，五类故障、300s 空载和独立对账通过后自动进入完整 960/1440m；首个主节点强杀恢复通过，错误和 OOM 暂零，新阶段资格仍待实际完成。旧已通过 480m 保留、旧失败 960m 时长不继承。新本机探测曾串读旧目录，已保留原始错误、修正并绑定 owner/root/plan SHA；23:14 任务结果 0，保护业务和云端 guard 正常。详细教训、复测入口和边界见下文[控制组 OOM](#负载完成不等于长稳通过控制组-oom-须独立定位2026-10-03)与[控制内存契约](../design/v0.7-soak-control-memory.md)。以下旧现场状态保留为历史快照，禁止据旧目录重放安装。

2026-10-03 用户确认当前 DP（DBProxy）验收止于产品本身的完整性、故障恢复、长稳和通用性能。真实 SLG 压力测试待业务接近完成后由用户另行安排；2 万在线、300 万注册、50 区服与云 PG 档次的讨论不构成本轮容量目标。报告区分 MemoryBackend 与真实 PG/Redis，固定源码/运行制品、机器、负载、并发、时长及原失败门禁，分别记录吞吐、延迟、失败、资源、积压/排空；逻辑操作/RPC/记录条数/字节不混算，历史结果不自动转记给新候选。慢占用 WARN 保留为观察线索，正常窗口失败与数据不变量仍严格判定，不以未做生产业务压测为理由忽略。相邻 DBProxy `PERFORMANCE.md` 与云上报告已同步范围，当前长稳按原冻结计划继续。

diagr3 的日志候选完整 480m 于 **2026-10-03 05:22:24 北京时间**独立通过，资格保留；后续 960m 在 **21:22:37** 的报告发布阶段发生客户端控制组 OOM，终态 failed、1440m 未启动。客户端实际负载 57600.40s、80/80 故障恢复和最终可见状态通过，9962 个正常区间错误零，但 300s 空载及完整 SQL/Stream 独立复核未完成，整轮资格零。内核杀死的是 Node 驱动 PID 3601457，所在客户端父组限额 512MiB；目标 2C4G 组 OOM/swap 零，保护业务身份/配置/健康正常。入口仍为 `temp/v0.7-cloud-fault-soak-diag-r3-20261002/`，67 原文件保留并生成 SHA 清单，30 分钟探测已于 21:48 自停。具体内存分配来源尚未受限复现；本次仅留档，不重放部署、恢复失败实例、拼接时长、增加预算或宣称已修复，未 push。

2026-10-02 21:18 长稳当前入口为 diagr3：上一日志轮因证书续期 timer 的精确状态比较在 18:12:36 停止，最后观察 346.50 分钟、30 次故障通过，3576 个正常区间和数据不变量均零；不能计为完成 480m。保护业务及续期任务本身正常，旧断言未留失败瞬间属性差异，时间关联和独立真实 timer 已复现该检查误判。新增 `tools/lib/soak_protected_units.py` 只允许活跃 timer 正常 waiting/running 转换，保留服务/启动代次/配置 SHA 与所有数据/超时门禁，并明确记录失败差异。92 文件旧证据逐项 SHA 验证，包 `46b60c34...`；新 `tzfault20261002diagr3` 在 21:16:22 正式开始完整 480m，旧部分时长零继承。原 `cceb223` ELF、2C4G/100 人/2s/5s 不变，实际部署后核对通过，新 guard/30 分钟探测正常；预计次日 05:16:22 结束负载，再空载和复核。21:20 新轮首次主节点强杀已恢复（1/40），数据不变量/客户端错误暂为零，幂等重复回执 1 次不清零；本机探测首轮 0、下次 21:48:19。验证及禁止绕过见下文新教训；没有产品重编/codegen/push，完整新版 480m/24h 未通过。

2026-10-02 12:32 diagr2 的首个主节点强杀已在线恢复通过（1/40），负载约 6 分钟、客户端及数据不变量错误暂为零，OOM/swap 零、保护业务正常；日志 PID 映射在真实启动和重启后均已产生。当前最新只读入口为 diagr2 的 `probe-cloud.py` / `latest-probe.json`，新 30 分钟任务首次结果 0，旧任务禁用。该在线故障进展不等于完整 480m / 24h 资格，后续原门禁不变，未 push。

2026-10-02 12:28 接续入口已改为新所有者 `tzfault20261002diagr2` / `temp/v0.7-cloud-fault-soak-diag-r2-20261002/`，日志制品于 12:25:58 真实就绪新的完整 480m，后续独立 960/1440m，旧时长资格零继承。旧 240m 在 09:52:49 完整通过：20 次故障、46800 唯一事件、92 次内容一致重复、SQL/Stream/300s 空载/当前代次退出零；所有报告及原始 SHA 已重核，64 文件下载归档 `935b4efb...`。09:53 首次自动部署在创建新资源之前端口普通 bind 失败，没有新版负载时长；保留失败和已完成资格，不覆盖失败状态，也不能称中间两小时在跑。当前新两个服务和负载进程 ELF、计划、42 个 payload、unit 与 guard SHA、2C4G 实际父组约束、12 容器/157 配置/4 units/HTTP 健康均独立核对，云端安全 timer 与新本机 30 分钟任务正常、旧失败任务禁用。原 2/5s 产品预算和 ELF 保持；本轮只改 Python 部署支持和文档，无 Rust/TS 重编、codegen 或 push。详见下面“停机后端口释放”和“启动状态文件就绪”教训，以及相邻 DBProxy 云上报告。

2026-10-02 09:10 PG 日志候选的接续事实：DBProxy 产品源 `cceb223` 的 Windows Rust 229、TS 29、Linux Release Rust 231、两平台格式/严格 Clippy 与另行 13 项真实 PG/Redis 契约检查通过；Linux 第三轮实际可执行程序标记已确认，第二轮共用 target 的无效容量对比不能重新记为通过。保持单分片 16 写者 / 2000ms 的独立旧、新复测均超时，保留 SQL dump 与原日志，新版记录了 15 等待者、2000ms 最老等待及仅 81ms 的当前持有者；最近完成占用 36–325ms，说明本次复现存在累计排队，不能由当前 holder 年龄替代整个队列等待，也不能认定云上问题已经解决。受控真实案例同时核对 queue_timeout 与 602ms 的完整释放、PG PID 729→731 / 代次 1→2。

接续服务已在云端真实安装并只读核对为 `waiting-for-qualified-boundary`，不是“新版已经部署”。旧 240m 的全部 14400 秒、至少 300 秒空载、实际退出、独立结果/报告/原始 SHA、旧控制器 PID 与代次、所有者匹配且全部资源停止必须逐项验证；旧控制器若在边界短暂开始旧 480m，其部分时长为计划性中断、资格零。新版重新完整运行 480/960/1440m，保持原 2C4G / 100 人 / 2s PG 和 AOF / 5s SDK / 四分片 / worker1 门禁；一次性部署失败留下原始日志并只停精确本轮资源，不自动重放。64MiB 观察器只做有界报告读取，128MiB 等待器将 Node 前置串行测试放在临时 256MiB 单元中，不扩大 512MiB 客户端总额。新本机每 30 分钟任务首次结果 0；12 容器、157 配置、4 业务 units 和三项 HTTP/健康检查通过。入口 `temp/v0.7-cloud-diag-handoff-20261002/{launcher-installed,staged-audit}.json` 与新候选 `payload-identity.json`，未 push。

准备清单的追加教训：从旧计划继承控制配置时，不能只更新 `db.workload.buildReportSha256` 而保留顶层旧 `linuxBuildReportSha256` / `localBuildFinalStateSha256`。本轮上传前的只读核对发现两层不一致，旧准备件移入 `pre-provenance-correction/` 保留，修改准备生成器后重新生成并逐项校验 42 个 payload、源码、构建报告和最终本机构建状态 SHA；同一报告的两层摘要必须相等。Node 控制 44 通过 / 1 平台跳过、Python 7、边界资格反例 7、有界 reader 3 均复测通过。禁止仅改描述或跳过摘要检查，再拿旧清单作为新程序证据。复测使用新候选 `prepare.py`（一次性，已完成，不重放）、`node --test --test-concurrency=1 '*.test.mjs'`、`python -m unittest -v review_test` 和接续目录 `test-boundary.py` / `test-report-subset.py`；安装后读 `staged-audit.json`，不要再执行 installer。

2026-10-02 真实存储与跨版本构建追加教训：测试驱动必须按用例显式传 `DBPROXY_CACHE_REDIS_URL`；不能依赖未配置机器的默认缓存地址，首轮遗漏导致 NotPresent，补齐独立测试地址后修复 ACK/丢失 COMMIT/取消三例通过。单分片 16 写者的既有默认预算案例保留原并发和 2000ms；其失败是失败，不能把减负、拉长预算或只有最终排空称为健康通过。旧/新对比曾共用 Cargo target：旧版编译覆盖同名集成测试 ELF，回到候选目录 Cargo 只报 0.06s Finished，实际 panic 行号仍为旧源码且最终 `PG_DIAGNOSTICS_TRACE` 字符串不存在，源码 HEAD/锁 SHA/命令退出码不能证明运行了新程序。这一轮对比资格撤销并保留 `revalidation-needed.json`、原始日志/SQL dump，第三轮旧版使用独立可回收 target 卷、候选源输入重新触发编译，运行标记和最终 server/driver 功能标记均须核对；不是绕过 Clippy/测试，也不手改依赖锁。队列采样新增同连接修复 ACK 后，64 次写 + 64 次 ACK 有 128 次锁获取，修正断言而非删除额外观测。外部 64MiB 边界观察器不能随长稳时间把完整报告数组装进内存；只选择已冻结驱动两空格 pretty JSON 的六个字段，逐行/单字段上限，非规范或缺项显式失败，并继续流式校验完整文件 SHA。真实 pinned 30m 报告与完整解析结果一致；33,800,146 字节忽略数组的跟踪内存峰值 166,110 字节，3 条 reader 与 7 条不足时长、原始篡改、未知退出、旧资源仍运行等反例通过。不增加控制器/观察器额度或弱化资格门槛。现场分别为 `temp/v0.7-pg-diagnostics-build-{r2,r3}-20261002/`、`v0.7-cloud-diag-handoff-20261002/`，旧 240m 未改、未 push。

2026-10-02 PG 排队日志补齐的失败教训与复测：原通用 latency.measure 只记录范围时间，不识别 StorageError，因此真实锁等待超时没有增加 `postgres_connection_wait` 的 timeouts；必须在实际期限耗尽的入口显式计数，涵盖共享连接的修复 ACK，取消与 SQL/重连错误不能混入。只按外部 PG 活跃数或排队峰值不能识别占用者，新诊断按实际连接共享，固定最多 128 个等待者元数据和 8 条释放历史，并区分积压批次、修复读取与普通请求；队列告警不能耗掉随后完整持有时长的释放告警配额，两个类别独立限流。负载首 16 错误样本会在早期故障耗尽，改最近 64 条轮换并周期写出，淘汰仅影响样本，不减少永久错误总计。实现首试 root 工具无 serde 直接依赖导致编译失败，使用已有 serde_json 的有界 Value，不为日志无谓增加依赖或手改锁；持有者测试首试检查历史第 0 项命中启动配置的 unclassified，改验证真实释放的最后项，保留历史及原预算断言。复测执行 `cargo test --workspace --all-targets --locked`、Clippy `-D warnings`、TS SDK 29；Linux release 与真实 PG PID/SQL 持有者/重连/取消及耐久回归必须独立报告。本机已有 battle-lab 正常运行，因此新构建保护所有原容器实际 PID/启动时间/挂载身份，不能沿用旧脚本“原容器全部停止”的假设，也不能停该业务来让构建通过。云上切换只能在旧 240m 的完整资格通过后进行，旧制品通过不等于新制品通过；检查实际正常退出、原始 SHA 与资源全部回收后再启新阶段，不改当前冻结控制代码、不继承旧 480m 的部分计时，保护教练/绯红资源，失败原始证据保留，未 push。

2026-10-02 02:07 当前故障第三轮 `tzfault20261002r3` 已于 02:01:28 就绪，首个主节点故障在线通过，完整阶段尚未结束。第二轮发现原始资源日志的整文件 SHA / 整体 JSONL 复核会占用 512MiB 控制组，在四类故障通过后计划性停机，未发生 OOM 或产品错误，74 文件与正常停机/存储停止证据冻结、资格零、旧探测禁用。第三轮用流式记录/有界恢复边界/分块 SHA，全部原始证据、错误门禁、产品源与预算保持；601MiB 合成文件 SHA 正确、Python 跟踪峰值约 2.13MiB，Node 各平台 44 通过 / 1 跳过、Python 7 通过。新现场 `temp/v0.7-cloud-fault-soak-r3-20261002/`，云端独立安全监测和本机 30 分钟只读任务已运行，保护业务保持。相邻 DBProxy 云上报告和下面新教训为接续入口；旧两轮不恢复/拼时长，旧 PG 2 秒问题仍未修复，无产品/codegen/重编/push，24 小时仍未合格。

2026-10-02 01:45 云上 DBProxy 故障长稳进行中：复用 `08aa916` / ELF `07c1f021...` 和原冻结 100 人客户端、2C4G 与全部产品期限，从完整 30 分钟逐级至 24 小时，逐阶段独立复核并加 300 秒空载观察。首轮控制脚本多行 SQL JSON / 停机元数据与清理报告失败，61 文件冻结、专用资源停止、资格零；新 `tzfault20261002r2` 于 01:37:59 就绪，首次主节点故障在线通过，尚无完整阶段终态。控制测试本机与云端各 41 通过 / 1 平台跳过，JSON framing / SQL 门禁 7 项通过；独立云端安全监测和本机每 30 分钟只读探测已启动，保护业务未动。新现场 `temp/v0.7-cloud-fault-soak-r2-20261002/`，旧失败现场保留，详见相邻 DBProxy `docs/cloud-fault-soak-2026-10-02.md` 和下文教训；不重放部署，不恢复 R11，没有产品/codegen/重编/push，旧正常窗口 PG 排队问题仍未解决，轻量 DTO / DBProxy 云端试验不替代 Host 或完整游戏/24 小时资格。

2026-10-02 R2 完整结束且资源已回收：原 100 玩家冻结负载 300+900 秒、300 秒停载观察、独立 SQL 门禁和 SQL/Stream 核对均通过；3870 个事件全发布，无重复/死信/客户端错误，7740 条账本记录总额零。主测 133.48 RPC/s、0.385 核，峰值 333.32 MiB；内存增长约 95% 记在 PG 子组，停载 319.67 → 318.85 MiB，两 Rust 节点 PSS/私有页无增长。原预算/worker/PG 四分片/持久化保持，Linux 228/格式/Clippy/Release 和另行实际执行的 9 项 PG/Redis 检查通过。该轻量 DTO 最大 34 字节、无故障/仅短时，不能替代真实存档、故障或 24 小时验收，更不能宣称 R11 正常窗口 PG 排队已修复。本轮三个容器、两个专用卷、网络、五个 unit 文件回收，12 个保护容器/157 配置/4 unit/HTTP-健康复核通过；本机 23 个停止容器/46 个卷保留。WinError 206 的原后置工具失败与标准输入修法已留档并写入下文，不重跑负载。证据 `temp/v0.7-remote-2c4g-100-r2-20261001/`，完整结果见相邻 DBProxy 容量报告；后续读取归档，不重放已退役脚本，不恢复 R11，未 push。

2026-10-02 00:33 改进版已进入云上独立复测，尚无完整容量通过：Linux Rust 228/格式/Clippy/Release 与另行实际执行的 9 项 PG/Redis 检查通过，服务 ELF `07c1f021...`，客户端仍为原冻结字节。成功验证及两次仅准备阶段失败的临时资源均已回收，原失败日志保留。新 `tzcap20261002r2` 先经 12 容器/157 配置/业务 HTTP 保护预检，按原 300+900 秒负载和 2C4G 额度运行，随后 300 秒停载观察；原预算/worker/协议保持，SQL 积压门禁和各服务 RSS/PSS 采样独立记录。旧失败队列加合成归零尾段的控制反例仍失败，不能用排空冒充持续容量。当前预检接近五分钟、已产生的 900 个事件全部发布，完整结论待结束；新现场为 `temp/v0.7-remote-2c4g-100-r2-20261001/`，不重跑部署、不恢复旧长稳，未 push。

2026-10-02 工作区清理已完成，下一步才恢复新候选的 Linux/真实存储检查与外网复跑：删除 68 个可重建缓存目录，文件长度 169.09 GiB，删除阶段 D 盘可用空间增加 152.38 GiB（62.08 → 214.46 GiB）。100 个保留制品、22 仓库状态及 R11 的 39 个冻结文件核对通过；未提交源码、正式 0.7 worktree、R11 数据、最终二进制/manifest 和 R2 bundle 均保留。清单与复核见 `temp/v0.7-workspace-cleanup-20261001/`，不把清理或准备算作新负载通过，未 push。

2026-10-01 本机旧容器收尾：用户指出只删镜像遗漏了容器，已暂停 Linux 重建及云上复跑，核对 79 个容器中 60 个 v7（57 已退出、3 个旧存储运行）。归档 56 个不再使用的构建/控制/历史长稳容器日志与 diff 后按完整 ID 移除，不使用 force/-v；3 个 R11 专用存储执行停止，保留失败负载容器及 PG 卷/Redis AOF/本机冻结证据。容器 79 → 23，可写层约 1.067 GB → 4.399 MB；剩余 4 个 v7 都已停止，46 个卷未删除。19 个非 v7 容器相对执行前的最新身份保持；battle-lab/SLG 停止事件在本次第一个移除动作之前，不能说整轮状态完全没变，也不擅自启动它们。当前本机 Docker 无运行容器；早先只删两个镜像的约 50 MB 结果属于上一阶段。证据 `temp/v0.7-local-images-cleanup-20261001/`，其中 action/manifest/最终状态分开留档。Outbox 改动已本地提交（5152b40、08aa916），Windows Rust 226/Clippy/TS 29 已通过，新 Linux 源 bundle 已准备，但 Linux/真实 PG-Redis 回归和改进版云上试验均尚未开始；不把准备算运行/通过，不恢复旧失败长稳，未 push。

2026-10-01 云上 2C4G/100 人基线已完成：300+900 秒客户端一致性/RPC 零错误，但 Outbox 输入约 3.24 条/s、发布 1.99 条/s，终态 1530 条未发布，不能判整链路容量通过。总 CPU 平均 0.382 核、内存峰值 347.62 MiB；20 分钟总内存增加约 153 MiB，文件/共享内存约占八成，匿名后半程约 70–72 MiB，仅父组统计不证明每进程无泄漏。12 个保护容器、157 配置摘要和业务 HTTP 复核通过，首轮资源已停止。用户要求先修后同负载复跑：当前 Outbox 每批最多 16 个独立组头，保持同组串行/死信/token，同一连接 XADD 后一次 AOF 确认再逐项 PG ACK；预算/worker/协议不变。新增批量 fixture 的 Windows sleep(0) 调度延迟已修为零延迟直接执行，保留原失败；改进版尚在重建检查，不继承旧制品资格，下一轮分子 cgroup/RSS/PSS 采样并保留 300 秒无负载观察。镜像按用户指令只删除两个无引用的 v7 Native 镜像；79 个容器/46 卷未动，不把镜像标签共享字节相加或宣称释放 CPU。详情与证据见相邻 DBProxy `docs/remote-capacity-2c4g-100-2026-10-01.md`、`docs/outbox-batch-publication.md`；本机 `temp/v0.7-remote-2c4g-100-20261001/`。不动本机 R11 失败数据，不全局 prune/drop caches，不拼时长、不放宽 AOF/超时、未 push。

2026-10-01 22:49 远端资源退役：用户授权清理火山云旧长稳，并明确保护教练直聘与绯红之境。已按容器完整 ID、Compose 所有者、全部挂载引用和网络成员核验后，停止/禁用旧测试服务与定时器，移除三个容器、两个专用测试卷、一个网络及旧部署/备份/日志。保护的 12 个容器、5 个数据卷与服务配置/启动身份保留，页面与健康检查通过；磁盘释放 3.127 GiB，可用内存同期增加约 0.844 GiB。1/3/24 小时原日志/manifest 已本机校验留存；远端清理不涉及本机 R11 失败库、冻结证据或 26 条待发布 Outbox，不启动新长稳。复核首轮在任何删除前因 Docker Mounts 顺序变化误报，须以完整挂载记录排序比较，不能删掉挂载保护；另一误报来自把已删除测试 unit 的反向 RequiredBy 当作 Docker 配置变更，只允许两条明确旧边消失，仍严格检查进程、配置摘要和正向依赖。不能全局 prune、按“已退出”清理 seed/匿名卷或重启共享 Docker。现象、证据与只读复测见[退役记录](../design/v0.7-soak-interruption-recovery.md#远端旧长稳退役与共享业务保留)；未修改产品、codegen、重编、push 或发布。

2026-10-01 分析补充：R11 失败前副节点请求 PG 在途 4、等待 28，正常完整指标区间有 694 次等待落在 (1, 2] 秒。后台批量落盘/repair 权威读取仍共用请求分片；PG 显式排队超时漏计指标，一般错误只留开头 16 个样本，属于代码确认的改进点。具体持锁者及 HDD/checkpoint 因果未证明，保留两秒配置和全部失败现场，后续先补有界证据、隔离后台连接，再按单节点负载与五秒客户端总预算验证。详见下文[分片排队教训](#分片排队必须区分持锁sql-点样本和指标漏计)和[R11 分析](../design/v0.7-soak-interruption-recovery.md#r11-排队结构与观测缺口分析)。本次只分析和更新文档，未实现修法、重启长稳或 push。

2026-10-01 21:56 更新：R11 已于 19:17 失败，新的 24 小时仍未通过。正常窗口 1 次交易错误对应副节点 PG 排队 2000 ms 超时；49 次恢复、9 次 AOF 原内容和 6928 个已接受区间复核通过，不能删除第 6929 个拒绝行。PG 错误采集均在故障窗口内；WAL 等待/检查点相关线索不能证明具体因果。失败后 SQL 内部一致、已发布事件交付一致，但 26 条未发布，缺最终客户端与维护排空，不能伪装通过。定时探测已记录终态并禁用自身，当前指针取消旧预计结束时间；现有索引/库继续保留，不自动重启失败负载。证据及后续诊断边界见[R11 失败](../design/v0.7-soak-interruption-recovery.md#r11-正常窗口再次-pg-排队超时)及下文教训；产品和预算未改，未 push。

2026-10-01 10:12 更新：R11 每 30 分钟外部只读任务已注册并实跑复核；修正后的 10:09 探测退出 0、3 次已完成故障恢复通过、内存压力未见。只在新异常或完成时请求 Windows 通知，正常时安静，同一异常去重；确认终态后禁用自己的探测任务。此任务不是 Codex 聊天自动唤醒，工作负载继续由原协调器负责，24 小时尚未完成。首次探测/通知/身份检查错误及正确修法见下文[教训](#外部定时探测必须验证实际运行和通知路径)与[证据](../design/v0.7-soak-interruption-recovery.md#每-30-分钟只读探测与本机通知)。

2026-10-01 09:42 更新：30 分钟诊断完整通过；关机恢复后原完成阶段 SQL/Stream、R10 失败 SQL 与关机前一致。Desktop 自动升级到 Engine 29.8.1，旧结果保留旧环境；R11 从 09:40 开始新完整 86400 秒，原产品/负载/故障/预算不变，补采 PG 排队/操作指标，四项观察均启动。Windows 37/Linux 36 加 1 跳过、真实只读等待、语法与预检通过；正常窗口两秒超时仍判失败。R10 占用 SQL/磁盘因果未确认，不能由短时通过宣称修复或累计部分时长。详情与 SHA 见[诊断和恢复](../design/v0.7-soak-interruption-recovery.md#30-分钟诊断完成与关机后恢复)、[R11](../design/v0.7-soak-interruption-recovery.md#r11-完整-24-小时与-pg-证据补齐)及下文教训；未生成、重编、push 或发布。

2026-10-01 00:29 更新：R10 完整 24 小时尝试在约 11 小时处因正常窗口两次 PG 连接排队超时失败；不能继续读旧 running 复核或累计部分时长。原始失败、对账和导出来源错误已保存，具体阻塞 SQL/磁盘因果待查。现已从零启动独立 30 分钟 PG 活动采样诊断，保持原产品、故障与所有预算；短时通过不等于修复或完整资格。详见[正常窗口排队失败](../design/v0.7-soak-interruption-recovery.md#r10-正常窗口的-pg-排队失败)及下文教训；没有生成、重编、合入远端 0.6.5、push 或发布。

2026-09-30 21:22 补充：R10 的独立存储采样在第 40 次主动停库期间出现一次 `inspect`/`exec` 竞态；这是一条含四项读取失败的诊断样本，故障恢复与 AOF 数据核对仍通过。保留原错误并检查采集区间和控制时间线，不能用旧 running 字段判断读取时状态，也不能据此放宽业务超时归因。具体原因、禁止绕过方式及复核入口见下文[故障切换与诊断采样](#故障切换与诊断采样必须分开判读)和[取证记录](../design/v0.7-soak-interruption-recovery.md#r10-故障切换期间的采样缺口)；完整 24 小时尚未完成。

2026-09-30 13:02 更新：累计计数的增量时间只落在两次观察之间，不能根据后一次 `activeFault=null` 判定其全部发生于健康期，也不能因为区间重叠故障就全部豁免。R9 两条 Outbox AOF 增量跨故障恢复边界约 2.08 秒；这不是实测等待时长。旧恢复读取未保存，且指标有后台缓存，事件准确时间无法复原。原最终审核拒绝本轮，已封存并在 12:50 停止自有负载；故障恢复、RPC/数据正常与证据不足须分别报告。详见[原始反例与修订](../design/v0.7-soak-interruption-recovery.md#r9-的超时归因缺口与-r10)。

正确修法是保存边界/恢复读数、串行同代抓取、在线执行原完整区间归因，并把存储计数稳定加入原 60 秒健康恢复；保持 180 秒上限，最终用两节点原始观察时刻和累计计数独立复核。缺采样、迟到可见增量、计数回退或窗口跨界不能补零、扩容差、改旧报告或靠重跑丢弃。R10 已于 13:01 重新完整计时，入口 `node temp/v0.7-joint-soak-r10/status.mjs`，完整只读复核 `node temp/v0.7-timeout-boundary-20260930/check-r10.mjs`；复测 `node --test temp/v0.7-joint-soak-r10/*.test.mjs`。Windows 86/Linux 85 加 1 平台跳过、语法/实际预检通过，产品、负载和超时预算未变；无产品改动，不生成或重编。一次 Docker 信息查询超时已保留并按原期限复查成功，不能据其替代实际负载/进程证据。未 push。

2026-09-30 07:40 更新：R8 因 WSL 更新停用服务而使 Docker EOF/CLI 125 失败，协调器按预期收尾，不能把所有环境退出都归为同一种后台托管问题。先保存现场、失败终态/导出和 Windows 时间线，再确认服务恢复、核对数据及全部旧负载已停止。724 个原始区间、五类故障/AOF 及重启后的事务/账本/事件内部一致性通过，不代表缺失的客户端最终验收通过，也不能累计约一小时给新轮。详见[WSL 中断与 R9](../design/v0.7-soak-interruption-recovery.md#r8-的-wsl-更新中断与-r9)。

R9 于 07:39 使用新资源命名/Redis 索引 11 从零执行完整 24 小时，预计 10-01 07:40 左右负载结束后对账；当前入口 `node temp/v0.7-joint-soak-r9/status.mjs`，监控位于同目录 `memory/`。新接续绑定每次失败的状态摘要与复核，强制拒绝尚活着的旧进程/容器和未审故障；负载前后核对 Docker/内核等环境，不把原六级证据冒充新内核重跑。Windows 56/Linux 55（1 项平台跳过）、语法与实际预检通过，产品/负载/超时/验收不变。更新策略保持原样，不为测试关闭系统保护；环境更新完成及两个待重启标记为空不是未来不中断的保证。复测 `node --test temp/v0.7-joint-soak-r9/*.test.mjs`；禁止重跑一次性恢复/注册或改写封存证据，未 codegen/重编/push。

2026-09-30 00:45 更新：联合 30/60/120/240/480/960 分钟完整证据均通过；R7 最后 1440 分钟约 16 小时处发生执行环境中断，不能登记 24 小时通过。先核对 PID/创建时间/脚本，再解释陈旧 running；Windows 的 Codex 更新/沙箱服务更换与集体退出吻合，但无逐进程终止审计，不把推断写成已证明的内部机制。原失败先归档，80 次恢复、16 次 AOF 核对与 11506 个区间通过只证明中断前的观测，不代替 SOAK_FINAL、最终对账或退出。详见[中断取证与完整复跑](../design/v0.7-soak-interruption-recovery.md)。

R8 在新的容器/数据库/索引从零执行完整 86400 秒，六级旧资格逐份重验并绑定原始摘要，不覆盖旧报告、累计中断时长或清库获取空间。启动器改由当前用户普通权限的 Task Scheduler 按需运行，核对实际父进程；不关闭更新、不改安全边界，也不保证能跨注销/系统重启。Windows 44 项、Linux 43 项（1 项平台跳过）、真实资源/前置证据/语法检查通过，00:45 已启动，预计 10-01 00:46 左右负载结束后对账；状态入口 `node temp/v0.7-joint-soak-r8/status.mjs`，内存与关联证据在该目录 `memory/`。产品和冻结负载不变，不重跑旧维护脚本。

本轮复核助手曾把 `recoverySeconds=180` 的恢复截止上限误用为健康尾段下限；原错误脚本/失败说明保留，修复为复用原 `validateWindows` 与 `healthyRecoverySeconds=60`。禁止因此扩大故障窗口、放宽健康要求或修改原失败结果。复测命令 `node --test temp/v0.7-joint-soak-r8/*.test.mjs`，所有接续、恢复、原始取证及边界见上述设计记录。无产品代码生成/重编或 push。

2026-09-28 07:18 更新：R7 完整联合 240 分钟于 00:59 通过，20/20 故障、Host 1,414,919 次 RPC 零错误、DB 正常窗口零错误，最终 SQL/Stream 对账通过。随后自动 Desktop 重启因残留 AF_UNIX 端点失败，协调器整夜保留复核点，未运行 480 分钟。07:05 已保留 socket 目录后恢复 Docker，原六个运行容器及数据核对通过；07:18 放行完整 480 分钟（预计 15:19 左右结束并对账），单次 24 小时仍未通过。维护前后 Windows 可用内存 12.43→15.44 GiB、vmmemWSL Private Bytes 14.94→5.08 GiB，两种口径不能相加。原失败保留，最新恢复入口为 `temp/v0.7-desktop-recovery-20260928/maintenance-complete.json`；新内存/关联观察位于 `temp/v0.7-memory-after-desktop-240/`，新存储观察位于 `temp/v0.7-storage-after-desktop-240/`。详情与边界见[维护结果](../design/v0.7-machine-memory-observation.md#240-分钟通过与-desktop-恢复结果)。

本轮控制教训：Docker 的 Dns:null/[] 和 Mounts 数组顺序变化曾触发完整摘要误报，只有可重建原完整摘要的表示差异才接受，源路径、权限、卷、内存额度等仍严格核对。Windows 后台子进程可继承管道，使启动器 exit=0 后 close 仍等待子进程；必须独立核对真实 worker 身份和新样本，不能因此重复启动或扩大超时掩盖。690 次存储采样错误全部发生在已完成 240 分钟后的维护等待点，不能填零或计入负载。具体失败、五项反例检查与复测命令见上述记录；活动冻结驱动和产品字节没有修改。

2026-09-27 22:12 已按用户授权安排完整 240 分钟之后重启 Docker Desktop：外部任务 `temp/v0.7-desktop-maintenance-240/maintenance.json` 正等待原协调器的 240 分钟复核点，当前尝试零次，受测负载继续。先归档/复核，再尝试一次重启、恢复原运行容器、核对 SQL/Stream 和内存；全部通过才放行新的完整 480 分钟，失败保留等待点。维护与新旧内存观察分代记录，维护时长不累计、缺口不伪装无压力；下一代观察目录为 `temp/v0.7-memory-after-desktop-240/`，尚未启动。八项规则检查、语法和真实 120 分钟/容器只读预检通过；尚未执行重启或完成 240 分钟。接续前先查维护状态及[具体恢复契约](../design/v0.7-machine-memory-observation.md#已安排完整-240-分钟之后重启-docker-desktop)，不得另起重启任务或越过等待点。

整机观察的身份检查教训：本机 PowerShell `ConvertFrom-Json` 默认把 ISO 时间变成 DateTime，再隐式转字符串送入 Parse 会丢时区/小数秒，导致只读身份检查误报。以 `-DateKind String` 保留时间文本后重新核对，创建时间差为零，未停止或替换进程；不得放宽身份容差。原错误/正确结果及复测口径见[内存观察记录](../design/v0.7-machine-memory-observation.md)，这不是产品或冻结协调器故障。

2026-09-27 21:40 内存与测试关联：独立 `temp/v0.7-memory-diagnostic-20260927/impact-status.json` 每分钟关联整机压力、Host 吞吐/错误和 DBProxy 正常窗口阶段耗时；分类变化与原始证据保留。21:28–21:40 的 13 次有效样本可用内存 12.15–12.98 GiB、swap 未增长、WSL 内存阻塞累计未增长，近期 Host 约 99 RPC/s、数据库正常窗口无错误，未见影响。调查阈值不修改原长稳门禁，观察缺失不能记作正常；后续验收须核对累计 `reviewRequiredEver` 和异常/未知时段，不能仅凭协调器 passed 宣称无环境干扰，也不能以环境理由豁免产品失败。Host 逐分钟延迟未采集，完整阶段报告再查延迟分布。只读观察器不自动暂停或清缓存；口径与复查证据见[整机内存观察](../design/v0.7-machine-memory-observation.md#内存是否影响测试同期关联)。

2026-09-27 21:29 整机内存诊断：三分钟七次 Windows/WSL 同步样本显示大额占用集中在约 11.3 GiB Linux 文件缓存，匿名页约 1.1 GiB；Windows 仍有约 12.2 GiB 可用，vmmemWSL 提交口径约 14.68 GiB 基本稳定。Docker 父层级有约 9.735 GiB 文件页未记入当前可见子组，并有 76 个消亡中的内存 cgroup，与历史读写缓存残留相符，不能确认具体构建或据此排除所有泄漏。Host 已完成 30/60/120 分钟末次 RSS 都约 75 MiB，连续 DBProxy 约 12 MiB；R7 240 分钟仍运行。独立每分钟整机观察入口为 `temp/v0.7-memory-diagnostic-20260927/monitor-r2.json`，不改变受测代码、故障门槛或环境。详情见[整机内存观察](../design/v0.7-machine-memory-observation.md)。

取证约束：Windows 提交、工作集、压缩页、WSL Cached/AnonPages/MemAvailable 和 Docker stats 不能互相替代或重复相加；cgroup v2 stats 会减 inactive_file，父子计数也有包含关系。当前 WSL 文档默认自动回收为 dropCache，没有 `.wslconfig` 不等于关闭回收。根 cgroup 缺 memory.current 不能当零；多层 shell 参数失败的空结果不能当零，已改 stdin 传脚本获取真实值并保留失败。观察器睡眠先算一次 remaining 再决定等待，首版仅做预防性替换，未发生产品故障。短样本不能重建先前增长或证明长稳通过，不靠清缓存/重启共享 WSL 让内存数字好看；原日志、命令与复查范围见上述记录。

2026-09-27 16:58 更新：DBProxy 已在 `42f2762` 完成可靠 Redis 等待预算修订，本地 `v0.7.0-rc.2` 指向该提交。入队与 Outbox 分别可配置 AOF/I/O 等待；排队、重连、写入、确认共用本地单调总期限，失败/取消丢弃原写入连接，新增七个阶段的耗时、活跃数及显式超时观测。默认 AOF 暂保留 2000 ms，I/O 3000 ms，入队总预算 4500 ms、排队上限 2000 ms，Outbox 5000 ms；SDK 默认 5000 ms 仍是独立端到端预算，不假设服务端知道远端剩余时间。

Windows Rust 222、Linux Release Rust 224（多两项 Unix 信号停机测试）、TS 29 通过；两端格式/Clippy/Release 构建通过，各有 49 项外部条件测试默认跳过，另行实际执行七项 PostgreSQL/Redis 恢复契约通过。独立 Redis 的 2/3/5 秒对照每组 1200 条入队/30 个事件全部成功，另四项 backlog 回归通过；三个并发完成 p95 约 1006/1006/1012 ms，不能当作独立 AOF p95，也不足以选出统一新默认值。原始 R4 超时失败及所有旧数据保留。

R6 旧版完整 30 分钟已于 16:26 经独立复查通过；当前 60 分钟在运行，预计 17:26 左右结束并对账。外部自动检查点 `temp/v0.7-dbproxy-rc2-build/handoff/cutover.json` 正在等待完整 60 分钟，复查通过才请求原协调器正常停止；确认导出及原协调器/观察器退出后，再做实时预检并启动 R7。R7 计划 SHA256 `0efbba6aa0a594fd2e1a2ed4a43d3b1f436a7a77080d00f3d43c83770bd2bcf4`，从完整联合 30 分钟重新递增，旧时长不累计。Host、旧版 SDK/验收客户端、负载与故障门槛保持，便于验证新服务端兼容；新服务端身份单独冻结。32 项 Windows 控制器检查、Linux 31 项及 1 项平台专用跳过通过。单次 24 小时仍未完成，未 push 或发布。

失败预防：不能用新连接确认旧连接写入，不能重置总期限或把剩余不足 1 ms 转成 WAITAOF 的零（无限等待），不能把超时理解为回滚；按原幂等 ID/内容重试，不降级 memory 或扩大故障窗口。超时指标只计显式观察到的超时，错误/取消耗时不代表成功提交。参数与契约见同级 DBProxy 的 `docs/redis-durability-budget.md`，短对照不证明磁盘根因或长稳通过。

隔离环境的本轮教训：第一次七项恢复契约启动遗漏实际 Cargo 缓存挂载和 CARGO_HOME，在内部网络尝试访问 crates.io，测试尚未执行；第二次在旧驱动收尾完成前启动，被网络空闲检查拒绝。保留两次日志/数据，等待清理结束，按原 Rust 1.97.1 工具链挂载已有缓存、CARGO_NET_OFFLINE=true，用独立数据库与 Redis 索引重新运行，第三次七项通过且存储已停止。不能开放业务网络、跳过真实契约、清空旧数据或取消空闲检查来取绿。复测入口为 `temp/v0.7-dbproxy-rc2-build/run-contracts-r3.mjs` 与其 `contracts-r3` 报告；它是一次性已执行取证脚本，重复测试应重新分配独立名称和数据空间，不能直接复用运行标识。

新增的 RESP 替身还曾将主动丢弃超时连接后的 Windows ConnectionAborted 误判为 panic；只把 reset/aborted 视为预期关闭，其余错误继续失败，再运行完整 Rust 矩阵通过。复测命令见 DBProxy 预算文档，原失败日志保留，不归类为服务端数据故障。

2026-09-27 15:56 更新：R5 首个 30 分钟在第 5 项故障中因控制响应文件 rename 的 Windows EPERM 中断，未处理的后台拒绝使状态陈旧地停留 running；四项故障完成，288 个区间未见健康窗口错误或数据违例，但无完整 AOF/最终对账资格。原始状态和未发布响应已封存，核实进程退出后外部标记 failed，受测报告不改写。R6 修复原子发布的有界共享冲突重试、后台异常接管及进程身份核对，使用原产品/负载字节、NVMe 路径和 2 秒/5 秒预算，从新的完整 30 分钟开始；入口 `temp/v0.7-joint-soak-r6/joint-impTua/state.json`，通过独立复查才继续递增。Windows 31、Linux 30（另 1 项平台专用跳过）及快速矩阵 32 项通过，另 1 项夹具路径检查修正后单独复测通过；正式 codegen 无受控生成物变化。完整 24 小时尚未通过，未 push；失败、修复及附件身份见[联合长稳](../design/v0.7-joint-soak.md)。

失败预防：跨 Windows/Docker 的控制文件必须保持原子可读，并对短暂共享冲突有界重试；持续失败不得删旧文件或重放已完成故障动作。后台 Promise 必须把错误交回拥有清理责任的协调器；不能仅凭 JSON 中 running 判断进程存活。重跑命令为 `node --test tools/lib/soak_control_io.test.mjs tools/lib/soak_control_health.test.mjs`，完整冻结控制器检查在本轮 tests.log/tests-linux.log，原始失败不累计为有效时长。

2026-09-27 15:07：R5 新可靠 Redis NVMe 路径已开始完整 30 分钟复跑，现场 `temp/v0.7-joint-soak-r5/joint-dIm8zA/`；约 15:06 正式起表，当前约 95 秒无错误，尚未合格。22 项控制器检查、资源/源码预检与实际只读存储观察通过；首级完成后独立复查再递增。十份执行/观察文件冻结，新的诊断附件与 SHA 见[联合长稳](../design/v0.7-joint-soak.md)，不可将它标记为 24 小时通过。产品字节未改，本轮未重编或生成协议，也未重复 Rust/TS 全矩阵。

2026-09-27 14:51 更新：R4 的联合 120 分钟在约 57 分 10 秒失败，触发正常窗口 Redis AOF 两秒确认超时；先前联合 30/60 仍保留通过，后续未启动。事后事务/钱包/账本相符，但 16 条 Outbox 未发布，不能登记最终对账通过。原失败、短存储路径对照与准备的新 R5 入口见[联合长稳](../design/v0.7-joint-soak.md)及下文失败教训；下列较早运行中描述均为历史。

2026-09-27 12:17：`temp/v0.7-joint-soak-r4/` 完整 30 分钟复跑及独立复查均于 11:49 通过，五类故障/AOF、最终对账、正常退出、健康窗口与数据一致性门槛全部通过，计时/事件日志两项回归未再出现。60 分钟已自动启动，当前约 28 分钟、3/5 类故障通过；尚未通过完整 60 分钟或单次 24 小时。新工具 Linux Release 构建及八条工具测试、Windows Rust 207（48 ignored）/格式/Clippy、TS SDK 29 与控制器 22 项通过；服务端保持原冻结字节，工具另记源提交和 SHA。失败原因、禁止绕过与复测证据见下文[失败教训与复测流程](#失败教训与复测流程)，现场及独立复查结果见[联合长稳](../design/v0.7-joint-soak.md)。原阶段、旧资源卷和原始失败全部保留，未 push。

本地套件第三次修订仅补充 ELF 运行库说明与证据，70 个文件校验通过，源码/实际程序载荷与第二套完全一致。最终 Linux Host 使用到 GLIBC_2.39、DBProxy 使用到 GLIBC_2.34，不能把架构名 linux-x64 等同任意发行版兼容；原始 readelf 与二进制 SHA 绑定在 temp/v0.7-release/linux-dynamic-requirements.json。跨套件字节比较另发现 Windows BINARY.json 的 DLL 名单顺序不稳定：忽略大小写排序却用 set 去重，大小写变体产生相同排序键；包内程序和导入集合未变。保留差异 kit-comparison-initial-dll-order.diff，比较仍逐字节检查全部实际载荷，仅对这份名单检查完整元素集合；后续构建加入原字符串作为排序次键。不要把元数据顺序差异当程序差异，也不能据此跳过二进制哈希。

三分钟控制器复测 smoke-QT8Qo0 完整通过：17,504 次 Host RPC、120 次直接事务、120 次交易、1400 次入队，原断言零错误；后台排空后 SQL 版本/回执/零和账本、120 个 Outbox 与 Redis Stream 事件集合均一致。它只是控制器预检，正式 30 分钟阶段随后开始，不算长稳完成。发行装配另一次失败是手工抄录 Windows DBProxy SHA256 多写一个字符，原装配目录与 build-kit.log 保留；核对清洁构建日志、实际 Release 输出和冻结副本一致后改读结构化身份文件，不关闭哈希检查。第二套件通过 64 个文件校验、11 个发行包载荷检查及六仓库 bundle 检出/精确远端来源重写验证；未 push。来源摘要应从实际产物计算并结构化传递，避免人工转抄。

2026-09-27 同机 Release 性能比较已完成：六场景各四轮 AB/BA，共 48 个测量单元全过，吞吐变化为 −3.9% 至 +1.2%，无场景触发固定调查门槛；详见[候选性能记录](../design/v0.7-release-candidate.md)。DBProxy 项使用 memory backend，不能称真实存储吞吐或长稳通过。

递增长稳首次三分钟预检被控制器错误的事务吞吐断言拒绝：冻结 dbproxy_fault_soak::run_player 每十周期执行一次事务，控制器误按每周期计算。原报告 120 次事务、120 次交易、1400 次排队写、零错误且客户端最终校验通过；失败保留在 temp/v0.7-soak/smoke-SqT0fh/ 和原控制器。修正计数下限为实际十周期频率并为交易保留独立下限；不修改产品、负载频率或一致性断言，必须整轮重跑并检查积压排空、SQL 和 Stream。失败时提前正常停服，留下的 27 条尚未发布 Outbox 在只读核对中正确被拒绝，不能据客户端零错误登记该轮通过。

最终 Linux 清洁 RC2 完整 **8/33/9、272 Rust** 通过，141 份 npm 文件及 Host/两份热更报告身份一致；Windows/Linux Release 短验证与 DBProxy 最终 Release 配置下 7 项真实恢复契约也通过，详见[候选冻结](../design/v0.7-release-candidate.md)。这些不是 24 小时长稳证据；性能对比和 30→60→120→240→480→960→1440 分钟长稳另行记录。

新增长稳准备的两个失败属于控制器时序：宿主 /ready 成功早于首个五秒资源快照，不能立刻把缺少指标判为版本不兼容；应在负载前限时等待首份完整快照，后续仍严格拒绝缺失指标。首轮性能 smoke 保留 temp/v0.7-performance/runtime-smoke-Hz5lJn/，修正后新旧 Release smoke 均通过。PostgreSQL 官方容器初始化期间的临时实例也会响应 pg_isready，但目标库可能尚未创建；准备必须同时验证正式 TCP 监听与目标数据库 SELECT 成功。首轮失败 temp/v0.7-soak/setup-initialization-readiness-failed.log、ID/所有者验证后的恢复 setup-resume.log，7 个真实恢复用例原断言未变。

最终 Windows RC2 清洁发行矩阵 **8/33/9、268 Rust** 通过，实际 Host/两份热更报告 SHA 一致，见[候选证据](../design/v0.7-release-candidate.md)。三个示例联机通过、MMORPG 193 TS 与 51 Native 通过（另 2 忽略）；SLG 最后发现生成 tsconfig 仍指向作者工作树，必须用标准并列目录的正式构建刷新、检查完整 Git diff，不能只看 build 返回码。差异保留为 `temp/v0.7-rc2-final-examples-generated-drift.patch`，修复冻结在 Examples `31617b7/v0.7.0-rc.2`，重新 npm ci/build/check/smoke 后受控文件无差异。

性能 Release 首次编译再次遇到 Windows V8 跨盘 symlink 权限 1314。核实锁定 V8 源与尚不存在的 `target/release/gn_root` 后创建本工作区目录联接，再用原源码/锁/Release 参数重试；没有修改第三方 build.rs 或启用不受控系统权限。失败保留 `temp/v0.7-performance/baseline-release-build-failed-v8-junction.log`。候选依赖助手调用 npm 时需要当前已安装 npm CLI 身份：从 npm script 启动，或显式传入已验证的 npm_execpath；直接 node 调用被断言拒绝，`npm exec node` 会下载另一个 Node，不能用它代替本机已选定的 Node 24。此次误调用只产生缓存下载，后续安装使用已验证 npm CLI 与原 Node 24，未改全局工具。

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

`@queued` 生成器不决定持久性，须核对 DBProxy 部署的 `backlog.enqueueAck`：默认 aof 等 Redis 本地落盘，memory 只确认 Redis 内存，两者都不是 PG 提交；测试 memory backend 不提供持久性。不要从成功响应推断配置，也不以清库替代生产写法迁移。本轮实际 VSIX 的初版 LSP 夹具漏 Entity.instanceId，又只等待零诊断通知，将真实语义错误藏成超时；应接收该 URI 的诊断并明确断言，补合法根字段后原诊断和 Hover 均通过，不关闭校验或加大超时。本地 `temp/包.tgz` 还曾被 npm 当作 GitHub 简写并 SSH 失败；应使用 `./temp/包.tgz`，不改 SSH 配置或发布锁，随后核对实际安装，不能假定失败等于未安装。输入、失败日志、打包与安装复测见[确认契约](../design/v0.7-queued-ack-contract.md)。

离线 Cargo 身份查询要明确实际目标：未过滤的 Linux `metadata --offline` 因缺 `bumpalo 3.20.3` 缓存在测试前失败，指定 `--filter-platform x86_64-unknown-linux-gnu` 后通过。SDK 候选完整矩阵随后 check 8/8、quick 33/33、full 8/9；全新脚手架还暴露缺发布 tag 引用，单有旧锁 commit 缓存不足。核对本机已有 annotated tag 的 peeled commit 与正式锁相同后才导入专用缓存，全新脚手架独立复测通过。保留原始失败，只接受三个候选 crate 来源变化，不手写锁、换依赖、伪造 tag 或禁用 V8。Windows 242 项/Clippy、Linux 268 项及独立复测分别见[SDK 联验](../design/v0.7-dbproxy-sdk-candidate-integration.md)，不把多次结果拼成一轮完整通过。

包身份校验必须使用消费者实际的模块条件：Native 0.17.0 仅导出 types/import，校验夹具用 `createRequire.resolve` 会选择 require 条件并报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。应在实际项目 cwd 启动 ESM import 分别验证 Core/codegen，不能新增 require/default 导出迁就错误夹具。此次三个本地候选一起安装、正式 package/lock 保持不变；0.17 候选在 Windows/Linux 新矩阵均 **8/33/9**、Rust 264/268 项，独立保留实际包/Host 身份，不能与此前 0.16 阶段混称。原始失败、139 文件检查、正式生成/Native 运行和命令见[Native 候选联验](../design/v0.7-native-candidate-integration.md)。

上述 V8 上下文修复最终验证：Windows 含 KCP **check 8/8、quick 33/33、full 9/9**、Rust 264 项；Linux 实际 io-uring/kcp 同为 **8/33/9**、Rust 268 项，原默认并发主测试连续 10 轮各 226 项通过。没有放宽并发、GC 或原断言，生产路径本就使用正确 enter；原 RED、Linux 三轮失败及 core 单独保留。实际命令、宿主 SHA256 和验收范围见[构造上下文](../design/v0.7-v8-runtime-context.md)与[Linux 完整矩阵](../design/v0.7-linux-game-validation.md)。本轮 Native Core 0.16.0 与已打包的 0.17.0 候选不能混称，默认发布依赖尚未冻结。

V8 构造必须先进入由调用者持有、启用 timer 的 Tokio runtime。Linux 第三轮 SIGABRT 通过原 ELF 第 4 次默认并发复现及 core 定位到 deno_core 0.411.0 `spawn_delayed_task`：未登记 handle 时，偶发 GC 延迟任务会主动 abort，普通捕获输出可能看不到诊断。生产入口已有 enter，部分测试/双 Native 临时验收入口遗漏；修复当前入口并在 Host 构造前明确拒绝缺上下文，不靠关 GC、串行化或重试掩盖。runtime 应活过 V8 销毁并由原拥有者驱动；检查当前 handle 不证明 timer 能力或未来寿命。原日志、回归与复测见[上下文契约](../design/v0.7-v8-runtime-context.md)，不把本栈外推为历史无栈 Windows 异常的原因。

Linux 第三轮须与缓存路径故障区分：双路径挂载下原 Inspector 专项 1/1 通过，但完整 quick **32/33** 的失败变为 main Rust 测试进程 **SIGABRT**，尚无原生栈；后代回收仍执行。事后 cgroup pids.events/max、memory.events/oom/oom_kill 为 0，不足以确认根因。保留原二进制、并发和失败日志，在隔离容器取得未捕获输出/调试器堆栈，再决定修法；不能重跑至绿、全局强制串行、删用例或把此前 Windows 异常直接认定为同一问题。证据与复测命令见[Linux 游戏验收](../design/v0.7-linux-game-validation.md)。

复用原生构建缓存要保持绝对位置：Linux 第二轮 quick **32/33**，Inspector 在启动宿主前因旧 `/target/debug/TiangZ` 不存在而 ENOENT；当前真实宿主位于 `/work/target`，旧路径已编译进 `env!(CARGO_BIN_EXE_TiangZ)` 的测试产物。不能把此项当作断点/源码映射运行时失败，或修改断言吞掉启动错误。修正方式是保留缓存原挂载并将同一实际目录提供给宿主发现工具，或重新构建被搬移的缓存；完整复测保持原断言与限额，证据见[Linux 游戏验收](../design/v0.7-linux-game-validation.md)。

Linux 安装不能假设所有 Git 依赖都已含构建物：Native Language 0.16.0 用 prepare 生成 dist，首轮禁用 scripts 后缺入口，生成失败又导致 Hotfix 门禁找不到 generated/model。另一个独立错误来自夹具把 target 目录做成人工软链接，Git 候选扫描仍包含它，读取报 EISDIR。首轮 **6/25/2**、full 7 failed、200840ms，证据 `temp/v0.7-linux-game-initial/`。在全新专用 volume 使用正式 npm 安装脚本，实际目录挂载对齐 Cargo/Host 路径；不伪造 dist/空目录、不关闭门禁或放宽 ignore/期限。保留同一源码和候选依赖，完整复测命令和范围见[Linux 游戏验收](../design/v0.7-linux-game-validation.md)；不要把前置失败当成多项运行时缺陷。

完整 Linux 游戏验收采用干净 `0210279` 源码归档和专用 Linux volume，保留大小写语义；Core/SDK 候选逐项核对 96 个已安装文件，Rust SDK 仍按原发布锁，不混称候选联调。工具镜像补齐 Luban 的 .NET 8.0.31，正式 io-uring/kcp 矩阵离线运行，不更改主机/用户服务。范围、V8 正规离线缓存与证据见[Linux 游戏验收](../design/v0.7-linux-game-validation.md)；执行中不能凭镜像或原生专项通过宣布完整游戏验证成功。

Host 原缓冲区必须按整块 backing store 的最后所有者观测，不能按小子视图长度或请求完成时刻释放。真实 V8/Process 已分别验证子视图持有、最后 Native 引用、正常/停机批次与退出回收；Windows 含 KCP 完整 **8/33/9**、543205ms、Rust 263 项，`temp/v0.7-host-backing-verify.log`。Host/两报告 SHA256 `ba921afd32e5f0fa3d3b9f85824756e8fc6c283cf79dceac3a094b241ea58e90`，Linux 实际原生 **267 项**、Clippy 和 AI 实际归档通过，三宿主正常退出。真实控制请求排空后仍记录 129414 字节，此非零不能直接归因为泄漏，也未强制 GC；见[完整证据](../design/v0.7-host-backing-store.md)。观测排除显式业务复制/其他 op/总堆，未来硬额度须独立保证完成通路。

原生 API 探针要先沿用当前 Host 的真实导入路径：首轮 backing store 集成测试 E0432，`Uint8Array` 实际位于 `deno_core::convert`，`temp/v0.7-host-backing-probe-initial.log`。此时未运行任何 GC/寿命断言，是夹具编译错误；不能改依赖、跳过 V8 或把失败当成框架泄漏。修正路径后复测 `node tools/run_cargo.mjs test --test host_backing_store_ownership --features kcp --locked -- --nocapture`，见[探针边界](../design/v0.7-host-backing-store.md)。

控制入站现按 Process 共享 65536 个未开始项，确认必须等 TS 真正开始或丢弃未执行节点；转入忙碌 Scene mailbox 不得提前释放。实际完成通知和 Shutdown 保留独立通路。最终 Windows 含 KCP **8/33/9**、471440ms、Rust 262 项，`temp/v0.7-control-ingress-verify-final.log`；Host/报告 SHA256 `305b6dc50b08c6bf0347a5a0cf010b84fbef8bb69a2a035550c0685324adae05`。真实峰值 65536 后归零，77825 输入全部获得成功或明确过载，热更/原连接恢复及三宿主正常停机通过；Linux 实际原生 **266 项**、Clippy 和 AI 实际归档通过。完整失败、LE 过载信封夹具修正与边界见[验收](../design/v0.7-control-ingress.md)。必须使用配套新 Model 并重启；聚合确认只适合同质数量槽，不能拿它计不同大小或仍被 Actor DTO 持有的 backing buffer。

io-uring 的 Socket 与 accept 所有权修复已通过真实专项 **4/4**，同一 listener 保持存活时验证关闭、恢复、阻塞控制通知及末条写入排空。最终 Linux **260 项**与全目标 Clippy 通过，`temp/v0.7-linux-native-final.log`；Windows 含 KCP 完整 **8/33/9**、524857ms，`temp/v0.7-linux-native-verify.log`，Host/两报告 SHA256 `4370b245a006fd8f3d642962446f49e5cd08674da4f92082291687c0fad6b500`。Linux 普通 Host SHA256 `2338a1ba0b463851372c65eb5255587dc15d1de3137238aedf9d6cc149e0f8c4`，AI 实际归档通过，三个 Windows 宿主正常退出。完整命令、原始失败与限制见[Linux 验收](../design/v0.7-linux-native-validation.md)；不将 Linux 原生验证说成完整 Linux 游戏热更矩阵。

Linux listener 关闭块的 E0505 编译失败保留在 `temp/v0.7-linux-uring-handshake-final.log`。先 shutdown，再在原总预算消费借用 listener 的 accept Future、排空连接，外层最后 drop listener；不要把 listener 和它的借用一起移进 async 块，更不能用 unsafe 或删除等待规避。这是编译期所有权修正，不能与真实 Socket/恢复失败混成同一种证据；见[完整记录](../design/v0.7-linux-native-validation.md)。

原真实 io-uring 用例必须同时验证超时关闭与后续恢复：首修仅解决前半，`temp/v0.7-linux-uring-handshake-green.log` **1 failed**、6.06 秒。listener 的 select 在连接结束时丢弃 pending accept，会留下无人消费的新 Socket。正确做法是循环保留原 accept，停止时用同一 stop 总预算 shutdown/消费其结果并排空连接；不能只断言名额归零、改用默认后端或删除恢复断言。新直接依赖采用已有锁内 socket2 0.6.5，正规 Cargo 解析并核对锁差异；详细复测见[Linux 验收](../design/v0.7-linux-native-validation.md)。

io-uring 实际握手期限测试发现框架缺陷：5 秒握手超时已归还连接/握手名额，但原 Socket 在 6 秒测试保护内不关闭，`temp/v0.7-linux-uring-handshake-red.log` **1 failed**、6.05 秒。Future drop 只留下 Ignored 内核操作时，FD 仍被持有。关闭守卫从握手转交 writer，异常/取消触发 shutdown，正常路径排空后关闭；不能把守卫留给可能阻塞于 Disconnect 入队的 reader。见[原因与契约](../design/v0.7-linux-native-validation.md)，复测原 `io_uring_handshake_timeout_closes_socket_while_listener_remains_alive` 用例；禁止加长期限或关闭 listener 让客户端 EOF 来绕过。

Linux 离线探针的首个失败发生在 Rustup 组件同步而非 TiangZ：先核对已安装版本，使用明确的同版 RUSTUP_TOOLCHAIN，不能去掉仓库 toolchain/锁来绕过。默认 Docker syscall 策略实际拒绝 io_uring_setup（EPERM）；仅在专用容器调整策略后创建/关闭 ring 成功，宿主内核设置未改。三份原日志为 `temp/v0.7-linux-native-capability-default.log`、`-default-final.log`、`-uring.log`，复测配置与层次见[Linux 验收](../design/v0.7-linux-native-validation.md)。条件编译、ring 能力、V8 链接、生产 backend 收发必须分别验证，任何一层成功都不代替后续层。

连接编号修复完成：相关 **5/5** 覆盖最后合法编号的真实 TCP/Auto/WebSocket/KCP 与耗尽后的资源回收，分配模块 **3/3** 包括八线程竞争最后两号。`TIANGZ_VERIFY_CARGO_FEATURES=kcp npm run verify` **8/33/9**、477578ms、Rust 256 项，`temp/v0.7-connection-id-admission-verify.log`；Host/两报告 SHA256 `3363972a027fc4d31e052c799caf27b2500420b18045e88ee2821a10daadf68c`。Linux 条件编译和实际 AI 归档通过，三个宿主正常退出。见[完整验收](../design/v0.7-connection-id-admission.md)，协议/Native/Stable 锁未手改，插件保持独立版本。

`temp/v0.7-connection-id-admission-red.log` **1 failed**、0.01 秒证明实际 TCP endpoint 会在 uint32 耗尽后发布编号 **4294967296** 的 Frame；最后合法编号的 Frame 已先通过真实 Host 事件头。backend 的 u64 fetch_add 没有协议宽度约束，不能等到下游桥才失败。正确做法是统一原子分配、耗尽不修改计数、不登记/发布新连接，由原监督路径处理；禁止取低 32 位、复用旧号或放宽断言。见[冻结契约](../design/v0.7-connection-id-admission.md)，复测 `node tools/run_cargo.mjs test --bin TiangZ --features kcp connection_id_exhaustion_fails_before_publishing_an_invalid_host_event -- --nocapture`；不冒充真实海量连接或生产事故复现。

Native 批次共享元数据验收已完成：Host **28/28**、最终调度 **8/8**、固定标签指标 **1/1**，含 KCP `npm run verify` **8/33/9** 全过，484101ms，`temp/v0.7-native-scene-batches-verify.log`；Rust 252 项、Linux 条件编译和 AI 实际归档通过。实际宿主/报告 SHA256 `f03b30153f2b6fb75f35fd12dfefbd11f476efe2dbae0a17242cae5534cfb91b`。真实最大批次峰值 65536 后归零，258 项批次的已完成部分没有提前减计数，旧消息完整送达、原期限和三宿主正常停机保持。具体命令、失败和范围见[验收](../design/v0.7-native-scene-batches.md)，不能把共享槽数当成整个运行时的内存上限。

`temp/v0.7-native-scene-batches-metrics.log` **1 failed** 的空 Native 指标来自夹具没有有效采样时间：旧 game-only 数据不依赖该门槛，新增 Process 字段必须设置 `sample_timestamp_ms`。补齐夹具后原样检查数值、类型和唯一 Process 标签；不能移除生产采样门槛或忽略缺失行。复测 `node tools/run_cargo.mjs test --bin TiangZ --features kcp health::tests::host_scene_operation_metrics_separate_queued_cost_from_reply_waiters -- --nocapture`，与真实运行缺陷分开记录。

`temp/v0.7-native-scene-batches-clippy.log` 保留提取批头校验后的 `needless_borrow` 失败：输入已变为 `&[u8]`，仍按原 Bytes 写 `&packet`。去掉多余一层引用并原样复测 `node tools/run_cargo.mjs clippy --all-targets --features kcp -- -D warnings`；禁止加 allow 或降低警告门禁。Rust 调度专项 8/8 与这次静态检查失败分别记账。

实际 Native 批次反例 `temp/v0.7-native-scene-batches-red.log` **1 failed**，0.10 秒：第一批 65536 项因完成背压仍保留元数据，另一合法批次仍被接收。原因是只有单批界限，没有所有批次容器的共享额度；该 V8 测试不经过 TS 准入辅助函数、不发网络。正确修法需复制/分配前预留整批项数，保留到真实容器销毁，异常也归还；不能只随部分完成提前减数、减少旧批规模或丢完成通知。见[冻结契约](../design/v0.7-native-scene-batches.md)，复测 `node tools/run_cargo.mjs test --bin TiangZ --features kcp host::scene_operations_tests -- --nocapture`。

期限句柄修复复测 **原生 9/9、TS 43/43**，含 KCP `npm run verify` **8/33/9** 全过，468894ms，`temp/v0.7-deadline-handles-verify.log`；Rust 248 项、Linux 条件编译与 AI 实际归档通过。Host/报告 SHA256 `db89ee6f56a1b92f7e8ff82df834b7986344d49579f09a88a6af2676149f1bc6`，真实 V8 证明高频期限不消耗通用编号、大句柄无截断、Runtime 清理后原 waiter 才归还。真实 Process 本地期限、超时后业务保留、远程排队期限和停机均通过，三个宿主 exit 0 且无强制终止。完整命令、最初失败与验证范围见[验收](../design/v0.7-deadline-handles.md)；仍须重建重启，不持久化内部句柄或宣称任意业务取消。

期限句柄测试编译的 E0061/E0599 与 E0509 保留在 `temp/v0.7-deadline-handles-compile-failure.log`。原因分别为把 `#[op2]` 生成的 OpDecl 工厂当普通函数调用，以及用结构更新语法搬出 Drop 类型的非 Copy 字段；不是运行时期限缺陷。正确做法是实际 V8 调桥创建资源、测试边界表显式初始化，不能修改依赖宏或去除资源析构绕过。复测 `node tools/run_cargo.mjs test --bin TiangZ --features kcp host::deadlines::tests -- --nocapture`，保留原 RED、容量和最终释放断言。

原生期限新增反例：资源都释放后，实际 V8 再创建通用资源取得编号 **131080**，预期 **1**；`temp/v0.7-deadline-handles-red.log` **1 failed**，2.48 秒。原因是 deno_core 0.411.0 的 u32 通用资源编号只增不复用；存活额度正确不等于累计编号可长期使用。正确修法需独立期限表、精确安全整数和明确耗尽，不清空其他资源、不绕过容量/取消完成断言、不将此反例称为已复现生产溢出。见[冻结契约](../design/v0.7-deadline-handles.md)，复测 `node tools/run_cargo.mjs test --bin TiangZ --features kcp host::deadlines::tests -- --nocapture`。

远程排队期限已以原绝对时间贯穿 TS/Native/传输：相关 **43/43**、Rust 专项 **4/4**，设置 `TIANGZ_VERIFY_CARGO_FEATURES=kcp` 后 `npm run verify` **8/33/9** 全过，462086ms，`temp/v0.7-remote-operation-deadlines-verify.log`。245 项 Rust、Linux 条件编译、实际 AI 归档通过，Host/报告 SHA256 `be70e7d8b72465ab72370721866ed46701cdaffeacd1dc5ab3f5b048f0b741f1`。真实 256 个长 RPC 占槽时，短 call/send 在原生队列各记一次到期、单向没有迟到执行，释放后恢复，三宿主正常退出；80ms 短调用在 168.99ms 被观察到，不能把控制通知背压忽略成严格实时保证。定向复测与完整身份见[验收记录](../design/v0.7-remote-operation-deadlines.md)，下方原失败记录保留，不用延长反例阈值或减少并发来绕过。

原生调度反例 `temp/v0.7-remote-operation-deadlines-native-red.log`：隔离真实 V8 先提交 256 个 1000ms sleep，再提交短 RPC；400ms 上限内 RPC 仍没有完成，子进程失败。测试未初始化网络管理器，检验的是普通计时占执行槽导致错误/超时也被阻塞，并非真实网络送达。修复需独立处理 sleep 与排队项绝对到期，不能延长上限、减少 256 项或宣称已取消对端。复测 `node tools/run_cargo.mjs test --bin TiangZ --features kcp host::scene_operations_tests -- --nocapture`，与真实网络证据分开。

远程期限的 8 项确定性反例全部失败，255ms，`temp/v0.7-remote-operation-deadlines-red.log`：旧实现未扣除 TS 排队，过期项仍进入 Rust，sleep 重新计时；新桥还须保留参数转换、路由耗时和单调时钟边界。正确修法是在原批次格式中传递剩余时间并附共享采样时刻，原生未开始项按绝对期限处理，不能只等轮到它时重新计时、损坏其他项或声称已取消对端。复测 `npx vitest run tests/unit/remote_operation_deadline.test.ts tests/unit/host_operation_admission.test.ts tests/unit/process_shutdown_deadline.test.ts tests/unit/scene_call_deadline.test.ts tests/legacy/rpc_actor_correctness_self_test.test.ts`，实际 Native/V8/网络证据另验，见[独立契约](../design/v0.7-remote-operation-deadlines.md)。

停机改动最终复测 **35/35**，Rust 专项 6/6，含 KCP `npm run verify` **check 8/8、quick 33/33、full 9/9**，461927ms，`temp/v0.7-shutdown-deadline-verify.log`；Rust 共 241 项、Linux 条件编译、AI 实际归档通过。真实 Native/V8 证明普通期限满额仍有独立停机资源，完整 Process 故障矩阵的停机场景 187.94ms，三个宿主 exit 0 且无强制终止。宿主/报告 SHA256 `b69e8de9e89542e1ace6b881bd0f20001c6b7ec41343530c4957fa9acc4b7260`，证据和范围见[停机验收](../design/v0.7-shutdown-deadline.md)；保留下方 8 项 RED，不把替身失败注入当作真实满载停机演练。

排队时间要实测纳入预算：`node temp/v0.7-remote-deadline-probe.mjs` 将 20ms 的 call/send/sleep 暂留 TS 队列 **77.32ms**，实际打包仍写入完整 20ms，证据 `temp/v0.7-remote-deadline-audit.json`。探针未发网络，不能据此声称对端执行。后续需统一单调绝对期限，未获得原生执行槽的过期操作也须处理，而非等轮到自己后重新计时；不以 Promise.race 冒充业务取消、不删旧项或降低并发来掩盖。真实 Rust/V8 路径另验，本批停机修改不修此项，见[后续盘点](../design/v0.7-ts-mailbox-audit.md)。

停机 watchdog 不能依赖普通工作队列：`temp/v0.7-shutdown-deadline-red.log` **8 failed**，286ms，其中满远程队列反例证明旧 stop 在实际钩子未完成时已失败退出；其余覆盖共享结果与专用资源的新契约。正确修法是独立的一项原生预留、共享同轮 stop，并在期限创建异常时仍执行/观察清理，继续由 Rust 外层 drain 期限限制异常回退。禁止直接用准入失败不执行 factory 的普通包装器、吞掉创建/钩子异常或将超时冒充取消完成。复测 `npx vitest run tests/unit/process_shutdown_deadline.test.ts tests/unit/scene_call_deadline.test.ts tests/unit/global_id_bootstrap.test.ts`，见[停机期限](../design/v0.7-shutdown-deadline.md)；替身与真实 V8 分别报告。

远程共享准入的最终复测为相关 **27/27**，含 KCP `npm run verify` **check 8/8、quick 33/33、full 9/9**，457372ms，`temp/v0.7-host-operation-admission-verify.log`；Rust 240 项、Linux 条件编译与 AI 实际归档通过。真实 V8 完整保留 65536 条单向消息及 64 MiB 整包，4 次公开 1011 只拒绝新增项，排空后恢复，宿主/报告 SHA256 `73d8d2ee0bd1e1404fe75dd08400bcad73330d6bde5492ddba6230c9c83c27d0`。下方失败反例及初步阶段保留；临时容量夹具的 Rust 出站预算与被测单批上限分开，不能改变默认值后声称默认吞吐已验收。详见[准入最终证据](../design/v0.7-host-operation-admission.md)，停机与排队期限仍有独立边界。

共享准入必须覆盖所有入口和旧项保留：`temp/v0.7-host-operation-admission-red.log` **10 failed/2 passed**，旧 call/sleep 能绕过单向队列上限，无效或已 detach 的帧还能使整批失败。修复在接受前检查输入、pending、条数和含头字节，flush 仅拒绝失效的本项，不能丢旧队列、只改 Rust 上限或把排队成本算成在途总内存。复测 `npx vitest run tests/unit/host_operation_admission.test.ts tests/unit/scene_call_deadline.test.ts tests/legacy/rpc_actor_correctness_self_test.test.ts` 初步 26/26；现有 mock 的一字节业务帧修正为原 Rust 已要求的二字节，完成和 rpcId 断言保留。指标、真实生成协议与完整矩阵另验，见[准入契约](../design/v0.7-host-operation-admission.md)。

本地期限最终复测为相关 **31/31**，含 KCP `npm run verify` **check 8/8、quick 33/33、full 9/9**，434358ms，`temp/v0.7-host-deadlines-verify-final.log`。Rust 239 项、Linux 条件编译、AI 实际归档通过；真实 V8 2000 次快速调用合计 148.95ms，期限届满后原 callee/mailbox/热更仍等实际完成，宿主/两份报告共同 SHA256 `670e83f915b0067d8fe8a979bae688ff77d3855f520f1c3e0740cee3164bf224`。见[最终证据](../design/v0.7-host-deadlines.md)。下方旧夹具缺桥、参数转换、waiter 快速路径反例和首轮 ENOBUFS 逐项保留；未改变网络参数，不能用后续通过覆盖首轮失败或宣称全部队列/内存有界。

跨入口的队列需要共同反例：`node temp/v0.7-host-operation-admission-probe.mjs` 仅在隔离 Node 中记录当前 TS Host 打包，65536 个单向消息加一个 RPC 被全部接受，形成 Rust 不允许的 **65537** 项整批。证据 `temp/v0.7-host-operation-admission-audit.json`，未发网络；下一批需在接受新项前验证共享限制，保留先前已接受项，不能把 TS Mock 打包观测称为真实传输验收或清空旧队列绕过。见[后续盘点](../design/v0.7-ts-mailbox-audit.md)。

快速期限需用确定性行为断言防回归：`temp/v0.7-host-deadlines-fast-path-red.log` 证明 100 次立即完成调用仍启动 100 个原生 waiter（1 failed/10 skipped）。修正为先预留原生绝对期限，宿主刷新时仅启动尚未完成的等待；刷新前完成同步关闭，已启动 waiter 等实际退出。统一停机清理两种状态，延后注册失败不撤销已开始目标。`npx vitest run tests/unit/scene_call_deadline.test.ts tests/unit/scene_call_cleanup.test.ts tests/unit/local_scene_capacity.test.ts tests/legacy/rpc_actor_correctness_self_test.test.ts` **31/31**，`temp/v0.7-host-deadlines-lazy-focused.log`；不得删容量检查、重置起算时间或提前归还原生等待的实际名额来提升速度，最终真实宿主/全矩阵另验。

宿主桥更新也要迁移已有自测：期限首轮完整矩阵的 legacy RPC 自测未安装新桥，仍按旧 packed kind=3 完成计时，报 `hostCreateDeadline is not a function`（`temp/v0.7-host-deadlines-verify.log`，184 passed/1 failed）。修正其显式宿主替身与期限完成驱动，保留 rpcId/超时/停机断言，禁止生产代码回退到旧桥或删测。相同矩阵的真实 admin HTTP 出现 `ENOBUFS`（`temp/hotfix-load-XxB2CZ/fault-report.json`），只能报告观察到的环境错误；事后端口采样不能证明失败瞬间原因。保留 500 连接与失败报告、不改网络配置，继续原命令完整复测。快速本地期限测试 20128ms 也提示等待每次原生取消 pump 的成本；须验证未跨 Update 的工作无需启动 waiter，已启动者仍实际排空，不能只看正确性通过。

期限清理须验证 Rust 真实资源，而不只看 Promise.race 返回：旧本地调用快速成功/拒绝后仍提交计时操作，`temp/v0.7-host-deadlines-red.log` **5 failed/1 passed**；本次用当前 isolate 原生期限并在 finally 关闭、等待取消实际退出。复测 `npx vitest run tests/unit/scene_call_deadline.test.ts tests/unit/scene_call_cleanup.test.ts tests/unit/local_scene_capacity.test.ts`，另跑原生资源/真实生成协议；超时仍须保留目标 ordered 队列、真实名额和热更排空。桥改动初版还漏掉原 DataView 的 uint32 转换，小数/NaN 两个用例失败（`temp/v0.7-host-deadlines-coercion-red.log`，2 failed/9 passed）；须保留原公开转换，不以新桥严格参数检查替代兼容语义。禁止仅延长超时、删任务计数、吞掉测试或将内部期限当游戏 Timer；详见[期限资源](../design/v0.7-host-deadlines.md)。

本地 Scene 容量最终复测：`npx vitest run tests/unit/local_scene_capacity.test.ts tests/unit/mailbox_lifetime.test.ts tests/unit/mailbox_overload_delivery.test.ts tests/unit/actor_mailbox_capacity.test.ts` **49/49**；含 KCP `npm run verify` **check 8/8、quick 33/33、full 9/9**，430647ms，`temp/v0.7-local-scene-capacity-verify.log`。真实 V8 16384 项中一半为已返回发送者的单向工作，仍占原名额；热更暂停期间 Worker RPC 返回后排空并恢复提交。Rust 234 项、Linux 条件编译、AI 实际归档通过，普通 Host/报告共同 SHA256 `604c5e0d2b887b00a836298c5f50cf499745c818fa7931144064df452b86da40`，详见[最终证据](../design/v0.7-local-scene-capacity.md)。下方夹具超时、类型标注、self RPC 误用与公开错误映射按阶段保留，不能混称框架容量失效；网络控制与字节上限仍独立处理。

独立 Process 容量探针也要遵守既有调用契约：`temp/v0.7-local-scene-capacity-v8.log`、`temp/hotfix-load-r9hBNs/fault-report.json` 在 Worker self RPC 处收到 1006 `cannot synchronously call itself`。不能为证明独立额度而绕过 self-call 防护或改 ordered 语义；夹具给 Worker 配置独立 EntryScene，公开 call 指向该目标，重跑完整真实 V8 场景。此轮是夹具误用，不是数量限制失效，热更恢复部分当时尚未完成。

转译测试不等于类型检查：本地容量及相关 Vitest 49/49 通过后，`npm run test:unit:typecheck` 仍报 TS2345（`temp/v0.7-local-scene-capacity-types.log`），泛型 register 的自定义 encode 参数缺少显式 Response 标注而被推断为 unknown。修正夹具的函数参数类型并重跑 `temp/v0.7-local-scene-capacity-types-final.log`；不要 as any、改协议类型或删除类型检查绕过。

容量 RED 用例不能先等待无界旧队列拒绝：本地 Scene 首轮 ordered 用例在 gate 后排队却直接 await rejects，触发测试 30 秒期限（`temp/v0.7-local-scene-capacity-first.log`）。正确反例先检查队列长度没有增加，再等错误，finally 仍释放 gate；修正后 `temp/v0.7-local-scene-capacity-red.log` 8 项均明确失败，不能把夹具 timeout 当作框架崩溃或提高超时来掩盖。配额附着实际节点，void 返回不是归还点，见[本地 Scene 准入](../design/v0.7-local-scene-capacity.md)。

公开 RPC 入口也需保留准入类型：本地节点接线后 7/8 通过，SceneCallContext.callFrame 却把本地 1011 按缺少 Rust 前缀重映射成 1006，`temp/v0.7-local-scene-capacity-propagation-red.log`。修复保留 RpcError(1011)，保持其他错误映射和原 rpcId 释放流程，再验证业务公开 call/send 与真实生成协议；不拼假错误文本、不绕过正常 dispatcher。正在运行的旧任务不能因 Scene/Runtime 销毁提前归还新 Host 的额度。

Actor 容量最终复测：四个相关文件 **42/42**，`temp/v0.7-actor-capacity-focused-final.log`；公开 send 修复后重新执行含 KCP **check 8/8、quick 33/33、full 9/9**，412040ms，`temp/v0.7-actor-capacity-verify-final.log`。真实生成协议验证两级额度、5 次带关联号的 1011（含两次公开 send）、2 次单向来源关闭、销毁保留和热更恢复，Rust 233 项及 Linux 条件编译通过；宿主、报告、AI 归档身份见[最终验收](../design/v0.7-actor-mailbox-capacity.md)。下方阶段失败按发生顺序保留，阶段通过不能覆盖后来发现的公开 API 缺口；现行完整证据以上述最终轮为准。

单测内部 router 通过不能替代公开 Scene API：新增 scene.scenes.send 用例收到 1006 而不是 1011（`temp/v0.7-actor-capacity-public-send-first.log`，1 failed/14 skipped）。原因是外层 SceneCallContext.sendFrame 的 mapError 只按 Rust `[scene-overloaded]` 文本识别过载，本地有类型的错误被重映射。应保留本地 RpcError(1011)，其他原有错误映射保持，并继续支持远程 Host 文本；禁止拼接假 Rust 错误文本或只改断言。真实生成协议须再调用公开 send 验证两级拒绝，改动后重跑完整矩阵。

容量修复自身的来源交叉反例：异步过载的关闭操作也必须验证原等待身份。初版只给成功响应传 AsyncIngressSource，错误回调则直接按 connectionId 关闭，导致旧来源已断开、墓碑过期、同号新等待被误关；`temp/v0.7-actor-capacity-late-source-first.log` 为 1 failed/13 passed。正确修法给错误回调携带同一原状态，Scene 关闭/来源失效后不再发关闭命令，业务实际任务仍自行排空；禁止永久墓碑或全量取消绕过。新增用例同时断言新等待仍正确回包，最终四个相关文件 41/41、类型检查通过，完整矩阵待完成。

新增单向协议时须同步 Model 的值导出和 modelExports：Actor 容量 V8 夹具首轮生成五个消息成功，但 Hotfix 导入 StarterMessages 时 TS2305（`temp/v0.7-actor-capacity-v8.log`、`temp/hotfix-load-RnNoA6`）。消息类型的 export type * 不能导出描述符值；正确修法在临时模块 Model 导入生成 messageDescriptors，同时显式导出与加入运行时桥，再重新走 protocol-update/build。禁止手改 generated 文件、用 Hotfix 深层导入绕过模块边界，或将尚未启动的 Host 算作容量验收。

Actor 两级额度不能只加计数器：`temp/v0.7-actor-capacity-first.log` 为 5 failed/1 passed，反映旧 mailbox 无任务上限。按[契约](../design/v0.7-actor-mailbox-capacity.md)同步拒绝 1011 后，`temp/v0.7-actor-capacity-delivery-first.log` 仍 7 failed/2 passed，原因是单向 Registry 吞错、send 同步准入错误只记日志。修复须把真实过载传给入站所有者：网络关闭物理来源、本地同步错误返回，保留 rpcId/失败指标，不冒充完成、自动重放或提前取消运行任务。

外壳也要验证：Trace、ActorLocation、批次三个 try/catch 曾将运行时过载错分为 MalformedFrame，`temp/v0.7-actor-capacity-envelope-first.log` 为 3 failed/9 passed。部分批次已开始异步工作、下一项同步拒绝时，旧代码没有安装 Promise 聚合观察者，进一步出现未处理拒绝，`temp/v0.7-actor-capacity-partial-batch-first.log` 为 4 failed/9 passed 加 1 unhandled rejection。外壳保留 1011，失败返回前给已接受项安装拒绝观察者；Registry 各自记录失败、Actor 持有实际任务，不能清空在途、等无限长任务后才关闭来源或把批次称为原子操作。当前 `npx vitest run tests/unit/actor_mailbox_capacity.test.ts tests/unit/mailbox_overload_delivery.test.ts tests/unit/mailbox_lifetime.test.ts tests/unit/actor_missing_error.test.ts` 40/40；真实宿主/最终矩阵待完成。

纯拆分应比对实际 AST 所有者：连接记账提取脚本首次在 __dispose 顶层查到 0 个 clear，期望 3，因而在生产源码写入前停止。清理实际位于 discardQueuedWork；修正定位并保留数量/不重叠断言，禁止按方法名称猜测、删断言或在提取时顺手改行为。EntrySceneConnections 只拥有缓存/墓碑/异步来源与指标；118 项执行体/声明比对、原测试路径迁移后的 21/21 和含 KCP 完整 check 8/8、quick 33/33、full 9/9 通过，实际二进制/报告身份见[拆分记录](../design/v0.7-connection-state-split.md)。

拆分声明验证的 TS2339 指向 processIngress 遗漏迁移的 connectionIdBytes.delete，日志 `temp/v0.7-connections-split-diagnostics.log`。正确做法是在原 Disconnect 消费位置调用新所有者的缓存删除，不提前到通知接收时机，也不暴露旧影子字段让编译通过。须同时证明所有保留方法在展开已审核所有权调用后保持；这是拆分接线错误，不是此前已验收行为本身失败。

迟到响应最终复测 20/20、含 KCP 完整 check 8/8、quick 33/33、full 9/9，日志 `temp/v0.7-late-responses-verify.log`；实际 WebSocket 关闭与 HTTP 指标验证没有回填连接缓存，原任务仍阻挡热更至真正结束，随后恢复。单测另覆盖 30 秒后、同号重用和同来源多个等待，不能把可控时钟反例描述为真实网络长稳。失败记录、实际宿主哈希与 AI 0.2.0 归档见[迟到响应](../design/v0.7-late-responses.md)。

来源连接断开不等于 Scene 销毁：旧 enqueueResponse 只检查 mailboxClosed，异步业务结束仍排队迟到响应，并在 unordered Disconnect 已处理后重新插入 connectionIdBytes。`temp/v0.7-late-responses-first.log` 为 6 新用例失败/13 原用例通过，`temp/v0.7-late-responses-cache-red.log` 同时保留两处缓存断言失败。修法是等待绑定来源状态、断线立即失效、最后实际结束按对象身份清理；不提前取消业务计数，不靠短期墓碑判断长任务，不删除同号新来源状态或其他连接队列。复测 `npx vitest run tests/unit/mailbox_lifetime.test.ts`，并验证实际 V8/断线及完整矩阵，见[迟到响应](../design/v0.7-late-responses.md)。

Spawn 总量最终复测：相关 17/17、Rust 232 项、含 KCP check 8/8、quick 33/33、full 9/9 通过，`temp/v0.7-scene-task-capacity-verify.log`。实际 HTTP 指标与 V8 验证 4096 项、销毁 16 个 owner 仍占额度、过载 RPC 码/关联号、独立 Worker、释放后只执行一次及热更恢复。Linux 仅条件编译，AI 仍 0.2.0；二进制/归档身份和首轮失败见[容量验收](../design/v0.7-scene-task-capacity.md)，不把这一范围当作全部 TS 工作有界。

Spawn 总量反例：16 个各 256 项的 Scope 满额后，第 17 个 Scope 仍能接受任务；旧局部容量错误也不是 SceneOverloaded。`temp/v0.7-scene-task-capacity-first.log` 2/2 失败。按[总量契约](../design/v0.7-scene-task-capacity.md)在任务微任务前增加 Process 准入，失败只退回当次预留，真实完成归还原 Host；禁止销毁即清零、把旧任务释放到新 Runtime、自动重试或增大上限迁就测试。复测 `npx vitest run tests/unit/scene_task_capacity.test.ts tests/unit/scene_task_admission.test.ts tests/unit/scene_task_disposal.test.ts tests/unit/hotfix_drain.test.ts`，随后验证实际 V8 和完整矩阵。

任务准入最终复测已补充同 Scope 的旧任务不能被误清理这一反例，相关测试从 11/11 增至 12/12；测试类型检查与含 KCP 完整 check 8/8、quick 33/33、full 9/9 均通过。真实 V8 新用例验证拒绝后热更恢复；AI 0.2.0 归档和实际宿主身份核对见[准入验收](../design/v0.7-scene-task-admission.md)，保留首轮失败证据。

`Tasks.Spawn` 返回 ID 才表示接受；watchdog 注册同步抛错必须撤回本次 task record。原实现先插入/增加高水位再注册 Timer，失败时 body 尚未排微任务，留下不能完成的在途计数并阻挡热更。`temp/v0.7-scene-task-admission-first.log` 的三个反例均在 1→0 断言失败。修复保留原异常、禁止 body 执行、Timer owner/句柄创建成功后一起发布，保留其他 Scene 的真实任务；不能吞错误、清空全表或把失败尝试算成功高水位。复测 `npx vitest run tests/unit/scene_task_admission.test.ts tests/unit/scene_task_disposal.test.ts tests/unit/hotfix_drain.test.ts` 为 11/11；真实 V8 与完整矩阵见[任务准入](../design/v0.7-scene-task-admission.md)。

Host 批次首轮完整矩阵的 quick 32/33、full 8/9 不能标为通过：Clippy 正确拒绝放在 impl 前的测试模块。应把测试移至实现之后并重新执行完整矩阵，不关闭 `items_after_test_module`，也不用已通过的运行测试替代静态门禁；原 `temp/v0.7-host-batches-verify.log` 保留。新增接收器暂存队首时，还要同步深度高水位的范围，物理队列 capacity 与包含暂存的观测值不是同一数字。最终复测见[Host 批次](../design/v0.7-host-event-batches.md)。

Host 批次的入站额度反例：旧代码复制一帧就释放原守卫，生产者可补入；真实 Process/V8 的普通运行与停机 completion 都产生了 83887124 字节单批。正确做法是复制前核对完整批次成本，64 MiB 满批先 Update、保留原事件与 FIFO，控制/数据各一条暂存且退回恢复公平计数；不截断完成结果、不伪造业务拒绝、不把 TS backing buffer 当作已受 ingress 保护。非法单事件须在修改批次前明确失败。禁止提高阈值、缩减反例或将旧二进制通过算作修复；失败日志、`node tools/run_cargo.mjs test --bin TiangZ --features kcp host_batch` 与完整矩阵见[Host 批次](../design/v0.7-host-event-batches.md)。原诊断缺口属于框架缺陷；命令误写大小写 bin 名和漏迁移旧私有编码测试属于测试接线问题，均单独留档。

真实 V8 mailbox 排空夹具的首轮失败是错误文字猜测：宿主返回 `drain deadline exceeded`、`pendingAsync=true` 并保留 generation，测试却匹配 timeout/timed out。正确断言当前结构化拒绝状态、实际 error 字段与 generation，不放宽生产窗口来迁就夹具；原 `temp/hotfix-load-dWu5jg/fault-report.json` 保留，详见[生命周期验收](../design/v0.7-mailbox-lifetime.md)。

mailbox 清理不等于异步业务取消：移出 Actor 路由或销毁 Scene 时，只能立即终结未执行节点；已运行调用仍需计入热更屏障，直到实际结果结束。首次用例发现旧入站槽保留帧、空闲池保持历史峰值、Scene 销毁后仍执行排队调用；随后又发现本地 Actor/ unordered Scene 不经过网络任务计数，pendingAsync 错误为 false。正确做法是在接收/真实完成位置记账，出队清槽，空闲池限 64，关闭后拒绝新准入和迟到成功结果；禁止清零在途数或用 Tasks.Spawn 包装测试来掩盖 mailbox 漏计。失败证据和真实 V8 复测见[mailbox 生命周期](../design/v0.7-mailbox-lifetime.md)。

夜间矩阵的冷链接反例：Rust 223 项用例通过后仍有本步骤 vctip 后代，属于构建工具生命周期，不能用缓存命中的重跑冒充修复。仅设 VSCMD_SKIP_SENDTELEMETRY 未解决，现 Cargo 步骤统一使用既有 run_cargo.mjs，由 Node 启动路径与外层 Job 保持所有权；强制重新链接确认退出，不按名称豁免、不改全局配置、不碰用户既有进程。原 full 8/9 和修正证据见[矩阵生命周期](../design/v0.7-matrix-lifecycle.md)。

夜间验证的超时/中止先回收本步骤进程树，再写 JSON/JUnit；超时计失败，整轮中止之后的步骤计 skipped，回收失败则不继续。Windows 的单 PID 清理不足以覆盖先退出的父进程，使用暂停创建并挂入专属 Job；Linux 嵌套步骤使用 IPC 父级消失通知回收独立组，不能只向外层进程组发信号。PowerShell 5 的 @(...ConvertFrom-Json) 曾令 string[] 变成一个空格拼接参数，应直接转换并验证逐参数原值。Windows 普通 Node 子进程可能已由 Node 自己管理，回收夹具须另测 detached 后代与真实端口，不能用未制造出的残留冒充所有权证明。首轮 4/5 与修正、Linux 隔离复测见[矩阵生命周期](../design/v0.7-matrix-lifecycle.md)。

0.7 Hotfix 成员检查使用 Developer Tools 共享 ruleset 2，CLI 和编辑器同源。确定属于当前 Core 的 System/Handler 禁字段、构造和 static 成员；同名业务函数或其他宿主装饰器不能据名称拒绝。没有 Program 的显式稳定入口候选只能给 `tiangz.hotfix.unverifiable` warning，不能宣称验证成功；真正违规保持 `tiangz.hotfix.instance-state` error。共享代码须调用创建节点的 TS API，ClassElement 用 canHaveModifiers/getModifiers 读取修饰符，不能凭 JS 可用属性绕过 TS 5/6 差异。模块范围由 Host 声明选择，见[Hotfix 契约](../design/v0.7-hotfix-contracts.md)。

验证时不能用预构建哈希替代实际运行身份：原矩阵 quick 的无 features Cargo 步骤会覆盖预构建的 KCP 宿主，之后 full 测到的是默认 feature。显式 Rust/KCP/UDP 通过与默认 full 通过分别报告，原热更 JSON 已记录真实 SHA。现用 `TIANGZ_VERIFY_CARGO_FEATURES=kcp` 贯穿嵌套矩阵，full 先构建，并在 quick 之后记录实际 Host 哈希；不靠额外手动构建或修改旧报告伪装原轮包含 KCP。原证据、哈希更正与复测见[进度](../design/v0.7-progress.md)。

0.7 KCP 使用独立 `maxKcpBufferedBytes`（默认 64 MiB、1..1 GiB），全部 KCP listener 共享，各 Session 另限 4 MiB。预留 C 控制块/工作区、段上界、保留 ACK 容量及输出 Bytes，扩容前保守准入，纯 ACK 在满额度时仍可归还，最后输出引用释放才退额度。额度不足/输出 callback 失败只终结该 Session，不能只记日志或依赖 C 忽略的 callback 返回值。一个 datagram 可让 ACK 数组连续扩容，须计最后中间数组与新数组同时存活的峰值，不只是调用前容量。接收/UDP 封包副本、Rust 容器、系统和 V8 另有边界；配置、Rust 包装器接口变化与验收见[KCP 预算](../design/v0.7-kcp-buffers.md)。

0.7 已解码 Rust 入站帧独立使用 `maxIngressBufferedBytes`（默认 64 MiB、1..1 GiB）。所有业务 listener 的控制 RPC 与数据帧共享，首次入队前接管 Bytes、不复制 payload，排队重试/取消/热更延后均保持同一预留，最后引用释放才归还；超限 Inner RPC 返回既有入口过载，外部/单向来源关闭，控制通知不占本项帧额度。固定 kind=ingress 指标不混作慢客户端。解码器、Host 打包副本、V8/TS mailbox、RPC completion 与 KCP 可靠缓存另算，不称为全进程内存上限。契约与证据见[入站预算](../design/v0.7-ingress-buffers.md)。

入站实测首轮的两个夹具问题已保留：误用不存在的 EndpointTask.stop/wait 导致编译失败；随后给真实 Inner Socket 发了外部 msgcode，访问校验正确拒绝，预算尚未入队。应先读真实生命周期 API（request_stop + await），传输专用夹具使用 Inner 保留范围并单独检查 RPC 标识；禁止新增空转接口、关闭协议检查或仅延长等待。原记录 temp/v0.7-ingress-first.log、v0.7-ingress-focused.log；修正后定向和全目标验证见入站预算文档。

0.7 地图部署走 MMORPG 自有 `map-deployment.json` → 官方生成器 → `map-deployment/runtime.pack.json`，复用通用数据信封，地图策略不进入 Core。过渡期旧字段仍接受，显式双写必须一致；声明包漏当前 MapHost 时失败。不可把部署拓扑写成玩法表，也不能用任意 Scene 字典绕过类型边界。操作、重启要求与证据见[迁移记录](../design/v0.7-map-deployment.md)。

房间类业务可先看 Examples `tools/fixtures/room`：使用现有模块脚手架和生成协议，一个 Scene 的 ordered mailbox 加 Component 即可实现有界房间集合与重连快照。`npm run test:room` 在独立工程运行真实 SDK/Socket 并检查正常退出，无需 Location/MapHost。演示密钥不等于账号鉴权/会话 fencing，内存快照不等于数据库恢复，不能把示例限制转写为 Core 特例。

本轮联合验证先暴露四类问题：内部 SingletonRegistry 不在 Stable 导出；Timer 默认参数收到 undefined 被共享规则误报；测试从两个宿主加载 SDK 导致错误类型身份不同；Native 模块 Cargo 仍指向主线库。正确做法分别是使用现有 RuntimeDataPackRegistry.Instance、按默认参数调用语义修规则并保留负例、令测试从所选宿主解析 Core/SDK、显式对齐 Cargo 输入并在构建前验证实际源。禁止扩大 public 入口、削弱错误断言、改正确 Timer 回调或仅凭版本号接受混合来源。Cargo 全树 paths override 会扫描缓存/其他临时 crate 并改变依赖图，本轮 metadata 试验失败后弃用；没有写入全局配置。复测命令和准确日志见迁移记录。

0.7 DBProxy 容量诊断使用独立 `dbproxy_capacity --postgres-url-env <变量名>`，默认只读固定表目录与大小，不跟每次请求/scrape 查询。显式 `--include-server-age` 有逐表期限，仍须检查每表时间状态；客户端提供的时间不是回执保留时钟。无自动清理，不按 TTL 删回执/事实/未确认 Outbox。真实存储恢复验证已覆盖同 ID 同内容恢复、异内容拒绝、批量逐条结果与重复 Outbox 消费；业务重试不能换操作号或重做随机效果，消费 inbox 与投影同事务后再 ACK。最新隔离范围与证据见[进度](../design/v0.7-progress.md)，不能把短测当长稳或生产就绪。

0.7 部署可用 `maxOutboundBufferedBytes` 限制已登记 ConnectionWriter 的总 payload（默认 64 MiB，1..1 GiB）。排队/正在发送/转发引用都持有资源预留，最后释放才归还；满额度的发送会被拒绝并关闭其连接，不给失败批次额外排队。Process 级压力有独立原因和指标，不能直接归咎慢客户端。同一额度也覆盖主动 Inner Host 整包，从复制前预留到最后切片释放；整包超限同步拒绝，不能部分入队后声称整批成功。writer 入队记录操作/写出最早期限，出队不延长，部分写失败关闭流。额度不覆盖 RPC 响应、入站/V8/Socket 及 KCP 内部重传，不能以此推导整机内存或可靠发送已全部有界；见[传输说明](../reference/transport-backend.md)。

主动 Inner 的慢写单测不能假定 Windows 回环的小 Socket 缓冲必然造成阻塞：首次两帧 2 MiB 已被系统接收。保留真实 TCP 写出/空闲释放/EOF；用固定容量异步流确定性验证部分写、过期队列与取消，同一写者实现和原断线/公平性断言均保留。范围、原失败和复测见[预算契约](../design/v0.7-batch2-contracts.md)。

Linux 编译容器不要把只有 registry/git 的 Cargo 缓存挂到镜像工具链的安装目录；这会遮住 cargo/bin，出现 cargo: command not found，并非代码编译失败。缓存单独挂到 /cargo-cache 并指定 CARGO_HOME，保留镜像 PATH，用非 login shell。首次日志 temp/v0.7-inner-budget-linux.log；原条件编译命令的复测记录为 temp/v0.7-inner-budget-linux-ready.log，不以跳过 Linux 或改全局 PATH 绕过。

生命周期/Timer 契约现在复用 Developer Tools 的 Program 规则，业务工程须运行声明宿主的 check/modules:typecheck，普通 tsc 不会自动执行它。只有当前 Core 的实体/组件钩子和方法名 Timer 被识别；Timer 实际接收者、生成 System 方法、参数和当前 TimerCancelledContext 共同检查。可忽略回调参数并使用可选参数，动态字符串/any/未实例化泛型只表示未证明，不等于运行安全。主工程 CLI/实时 LSP 使用同源诊断；受信任工作区的模块实时 worker 与宿主 CLI 共用 Program，支持既有 TS 的未保存文本及联接真实路径；项目/模块声明与 tsconfig 须保存后刷新，环境失败不能写成零错误。实现、边界与夹具教训见[Program 记录](../design/v0.7-program-contracts.md)。

模块实时检查须以宿主返回的源码/声明范围筛选 overlay，不能仅按工程根过滤联接模块；跨盘 path.relative 可返回绝对路径，Problems 定位使用 path.resolve 并断言实际 URI。首次测试选错进程、side-effect 导入和已有脚手架目录的夹具错误已修正且保留日志；不改生产规则来迁就夹具。操作与复测见[模块实时检查](../design/v0.7-module-live-checks.md)。


故障演练出现系统级连接失败时保留整轮失败，不把单项复跑改写成已确认根因。此次热更矩阵在 500 连接后的 admin HTTP connect 出现一次 ENOBUFS，原三轮复测通过；没有降低负载或调整系统 TCP 参数。记录见[实施进度](../design/v0.7-progress.md)，此项不改变业务生命周期契约。

宿主级 V8 生命周期测试按每场景一个 OS 进程运行，保持真实的一 Process 边界；子进程内部必须先断言 Socket/名额清理和端口重绑，父进程还要检查“实际执行 1 条”，防止 --exact 名称错误时 0 测试也返回成功。当前 N3 这样隔离后全目标含 KCP 189 条及 Clippy 通过。初次 0xc0000409 原生退出仍未取得根因栈，不能以多轮通过或隔离方案宣称已修复，更不能降低全套并发去隐藏它。

Process 指标 DTO 与采样/转换放在 process/observability.rs，两个直接检查 DTO 的原测试随类型搬移；GC 回调、裸指针 Box 的寿命、队列和调度仍属于 Process。不为拆分公开字段，8 类型/1 函数/2 测试规范化文本相同。首轮联跑的 0xc0000409 原生日志保留，随后并发多轮及 CDB 下 161 条通过仅说明未复现，不能当作已确认修复；完整证据和 N3/V8 测试拓扑风险见[拆分记录](../design/v0.7-observability-split.md)。遇到此类原生退出要保留退出码/原输出并尝试原生栈，禁止仅设置全局单线程或删除并发/失败回收测试。

0.7 健康指标格式入口集中在 src/health/metrics.rs；健康探针、管理请求及状态所有权仍在 health.rs。修改新指标时沿用同一标签转义/histogram 实现，不为每个指标创建文件或扩大状态字段可见性。此次 13 个函数纯搬移，规范化声明与基线相同，原 15 个健康测试通过；证据见[纯拆分记录](../design/v0.7-observability-split.md)，仍需重建 Rust 宿主。

验证 Process 回滚必须让测试 OS 进程继续存活，检查第一业务端口和健康端口在第二端口绑定失败后可重绑；只等独立子进程退出会让操作系统自动回收掩盖框架泄漏。端点错误/panic/意外正常返回都须让实际 /ready 变为 503，停止期间 /live 仍为 200，最终 Process 返回失败并清理连接/握手名额。生产后端选择不新增故障开关，隔离测试只在同一协调函数的后端工厂注入完成原因。

裸 V8 生命周期夹具须遵守真实制品和返回契约：GameConfigBundle 读取 game-config.manifest.json；Update 的采样帧为 JSON，非采样帧为 compact 数字字符串。首次夹具分别在文件读取和 compact 解析处失败，未触及待验证的 listener 故障。正确做法是入口先调用实际 Bundle 校验，并同时监听 Process 退出与 HTTP 状态，保留根因；禁止改生产契约或仅延长探针超时。原日志 temp/v0.7-process-lifecycle-{first,fixed,diagnostic}.log，修正后的定向证据为 -green.log；它不能替代真实业务模块与 Linux I/O 验收。

0.7 入站准入在 Process 全部业务端点之间共享：maxAcceptedConnections 默认 65536、maxPendingHandshakes 默认 1024，均为 1..1000000 整数。流式 Socket 在创建任务前申请两个名额，超限立即关闭、不排队；握手完成仅归还握手名额。KCP HELLO/cookie 不创建 Session，认证 CONNECT 才申请连接名额，重传不可重复扣减。名额随实际连接任务/Session 生命周期回收，取消和 panic 也不可泄漏。观察 tiangz_transport_admission_in_use/limit/rejections_total 的固定 kind=connection|handshake 标签；配置旧宿主时不要写 0.7 字段。它不限制帧字节、KCP 未确认缓存或主动 Inner/health 连接，详见[传输说明](../reference/transport-backend.md)。

准入指标测试失败教训：首轮没有设置 sample_timestamp_ms，触发既有“未采样不导出”逻辑。修正测试采样时间并保留生产门槛，不能以删除过滤/弱化断言使测试通过。原证据 temp/v0.7-admission-first.log；cargo test --bin TiangZ --features kcp --locked 159 条通过、Clippy 通过（通过现有 run_cargo 工具运行），包括双真实 listener 共享、KCP cookie/重传、任务取消与 panic 回收；完整矩阵和 Linux 证据单列。

AI 插件候选从 tools/ai-assistants 唯一源生成，使用 distribute.py --repository 显式选择分发 worktree，不靠 sibling 默认目录或框架 0.7 给插件改版本。当前实际包内四工具/六建议验证通过，Cindy 版本输出改为未探测与核对入口；不能宣称用户客户端已更新。技能校验要检查解释器真实来源：本机 MSYS2 venv 为 bin/python.exe，缺 PyYAML 时用独立 venv 的纯 Python 安装，保留最初默认扩展构建失败记录。详见[交付记录](assistant-packages.md)，不修改整机 PATH/CC 或第三方源码绕过。

0.7 持久化调用使用共享预算：一个 Repository Load/Save/Enqueue 入口包含编码、版本读取、迁移回写/重读及退避；并发调用各自独立，不给重试续期。相同幂等号必须携带相同字节，Codec 返回复用缓冲区时框架也必须在首发前复制。旧 Transport 未实现物理超时不能声明 supportsRequestTimeout；不使用 Promise.race 假装取消 I/O。Host 将期限固定在参数转换前，并由 Rust Instant 与 OwnedRequest 管理真实任务。候选 SDK/Host 证据和发布依赖限制见[第二批记录](../design/v0.7-batch2-contracts.md)。

新增 async Host op 参数后的最低复测必须包括真实 V8：这轮 Cargo check 成功，实际启动因 10 参数超过 Deno 包装器上限失败；namespace/key 合并为一个结构化 record、保留 payload/result 字节参数后，Host 16 条定向通过并验证隔离 TCP 超时 EOF。原始/修复日志 `temp/v0.7-ts-host-budget-tests.log`、`temp/v0.7-ts-host-budget-tests-fixed.log`。禁止改第三方源码或省略启动测试。旧 Repository 夹具若绕过 SDK、不声明新能力，须更新为真实 SDK + 明确即时内存替身，不给真实旧实现伪造能力。当前开发 worktree 安装本地 npm 候选，默认 npm ci 仍恢复旧 SDK；正式依赖冻结前不能宣称干净检出验收完成。

可选参数也有兼容边界：本轮完整矩阵中 CommitRecords 的既有调用形状断言检出新增 undefined 实参。保留原断言，SDK 和 Host Transport 无预算时维持原参数个数；不能把“可选类型”当成运行时一定不可见。红测在 `temp/v0.7-ts-budget-verify.log`，SDK 29 条复测在其 `target/test-results/v0.7-ts-budget-legacy-args.log`。Rust 候选联调使用独立源码副本和局部 path patch，16 条通过、主 Cargo.lock 哈希未变；不可把该局部路径锁提交到正式宿主。

接续夜间工作以[0.7 实施进度](../design/v0.7-progress.md)为准：最新 full 8/8、quick 32/32、check 8/8；源码已按职责本地提交。两个候选 VSIX 已在独立用户数据/扩展目录安装并校验，日常用户扩展未改。Native/Developer 包身份字段不同，读取时按实际清单映射，不能假设同一 schema 后把脚本失败当成包损坏；实际 CLI/LS、安装内容与可视 UI 证据分别记录。

0.7 RPC ID 修复：请求赋值或编码可以同步抛错，预留请求号之后的全部工作必须位于 try/finally 内；Actor 转发的帧重写也一样。不能只在发送失败时清理。9 条 SceneCallContext 回归含原 6 条失败已通过，失败后原 ID 可重新使用。

0.7 Timer 修复：取消定时器或销毁所有者不代表已触发的异步回调结束，热更必须等待真实 Promise 收敛；不要按定时器活动数判断安全。回调中新建的零延迟 Timer 留到下一轮，取消尚未执行的本轮项仍立即生效；重复 Timer 跳过错过周期并避免浮点误差导致同帧重触发。原反例及完整矩阵已通过，Stable getter 变化需重建重启。

0.7 EntryScene 纯搬移：业务继续使用 Stable 导出的 EntryScene，不导入内部 process/EntryScene.ts。配置契约和实现物理分离，33 个非 import 声明保持；完整声明图与构建身份变化仍需重建/重启，不能只发 Hotfix，见[拆分记录](../design/v0.7-entry-scene-split.md)。

共享时间检查的失败教训：字符串别名表跨函数/块传播会把参数或同级局部数据库回调误判为时间等待。Developer Tools 三个反例原各报 3 项、期望仅 1 项；改为按词法声明解析，同一导入别名在外层仍必须拒绝。Core 61 项通过，证据为插件 `dist/v0.7-time-scope-{red,green}.log`；需继续核对 CLI/实际 LS。禁止用删规则、换诊断级别或认为候选源码已自动更新宿主依赖来绕过。跨文件动态包装仍需审查。

网络阶段复测：Windows 含 KCP 的 179 条全目标测试和 Clippy 通过；真实 TCP 客户端收到帧头后停止读取，服务端写期限生效并清零资源，Linux 条件编译也通过。见[第二批记录](../design/v0.7-batch2-contracts.md)，该证据不能代替 Linux io_uring 运行、KCP ACK 或真实存储恢复。

夜间入口差异：矩阵和 Native 构建已过滤 MSVC 下的 GNU CC/CXX，但 `npm run build:runtime:debug` 以前直连 Cargo，再次出现 LNK1143（`temp/v0.7-write-budget-host-build.log`），完整 verify 尚未启动。修复该 npm 入口使用 `tools/run_cargo.mjs`，依据目标过滤当前子进程变量，保留显式非 MSVC 目标，不修改系统设置或清理第三方缓存。复测同一构建入口及完整 verify，不能把之前单元测试通过当作宿主重建成功。

插件联合验收必须分别记录 Core/VSIX/宿主已安装核心。Native 当前候选为 0.17.0/0.16.0，宿主仍为 0.16.0；修复旧 0.14.0 打包名并增加包内身份，29 个用例及四类生成兼容夹具通过，但不能写成已发布/已安装。使用候选 `check-host-compatibility.mjs --engine <显式宿主>`，CompilerHost 虚拟挂载生成文件，保留 rootDir/严格选项。import-only 依赖的 CJS 解析失败及 TS6059 夹具失败均保留，过程见[插件兼容记录](../design/v0.7-plugin-compatibility.md)；不得通过手工改 Generated 或屏蔽诊断获得通过。

0.7 显式协议握手也受限：TCP/WebSocket/io_uring TCP 沿用 Auto 已有的 5000ms 总期限，覆盖初始前导/内部认证/HTTP Upgrade；空闲预连不可无限等待。真实默认入口的两个反例在旧代码均超过 6 秒保护期限，不能用 Auto 专用辅助函数的测试代替显式路径。该期限不覆盖后续慢写或 Process 总量，详见[传输说明](../reference/transport-backend.md)。

出站预算回归：批次资源守卫负责队列销毁/写入失败/取消时释放计数，KCP 转发帧共享该守卫，最后一帧完成前保守持有整个批次。禁止在各 backend 继续手工减同一计数。原顺序夹具销毁批次后仍断言 3 帧/6 字节，首轮因此失败（`temp/v0.7-network-all-targets.log`）；现保留逐帧顺序并检查释放前 3/6、后 0/0。另有队列销毁反例 `temp/v0.7-outbound-accounting-red.log`，该反例先失败才引入守卫。此修复不包含 KCP 内部重传缓冲和 Process 总量预算。

0.7 生命周期补充：不得丢弃 endpoint/connection/writer 的 JoinHandle 形成后台孤儿；正常停机取消握手、停止准入并排空最后通知，超出既有 `stopTimeoutMs` 取消异步任务，CPU/V8 硬卡死仍需进程监督。健康 listener 和请求也要随所有者收回。KCP 单客户端非法帧不能让共享 listener 失败：先通过 conn/peer 识别，再只移除该 Session；真正 listener 失败仍必须报告 Process。真实 Socket 取消/重绑/排空、KCP 双客户端隔离及错误/取消测试已纳入当前 141 条 Windows KCP 二进制用例，详见[第二批记录](../design/v0.7-batch2-contracts.md)。

0.7 网络补充：TCP/Auto 的 `inner/outer/mixed` 必须在 writer 注册前执行，内部连接仍须凭据认证；WebSocket 在 HTTP Upgrade 前检查外部准入。单帧及分片重组的 1 MiB 限制前移到 WebSocket 解码器；只做业务层长度检查无法约束接收内存。真实 Socket 反例验证未完成的超大帧/分片也会断开，恰好上限可用，阶段证据见[第二批记录](../design/v0.7-batch2-contracts.md)。不可据此宣称 Linux/io_uring、全部资源或退出已经通过。

2026-09-26 夜间继续：第二批按[具体契约](../design/v0.7-batch2-contracts.md)推进。DBProxy Rust SDK 现在由同一逻辑请求拥有许可、写锁、响应、重连及重试的总期限；默认 5 秒，超时仅在整个操作从未写入时报告 `RequestNotSentTimeout`，任何先前可能发送都保持结果未知。客户端 28 条通过，Host/Repository 的外层预算仍待收口，不能以此宣称整个 D2 通过。

2026-09-25 用户确认开始实施[详细设计稿](../design/v0.7-design.md)；2026-09-26 首批 R1–R4 和 DBProxy D1 本地验收完成：TiangZ check 8/8、quick 32/32、full 8/8；DBProxy Rust 190 条、TS SDK 21 条通过，47 条真实存储/显式故障用例未运行。源码尚未提交，Stable Core API 锁漂移留待发布冻结，证据见[首批实现与验收记录](../design/v0.7-batch1-acceptance.md)。六仓库各自使用 `feat/v0.7` worktree，插件继续自身发行版本序列；业务仍通过 Stable 入口，不依赖 EntryScene 拆分后的内部路径。总预算不等于撤销已执行业务，回执清理/记录删除和异步 Native op 仍按独立候选评审；包更新须验证实际生成/安装身份，不能把首批结果、dist 或部分测试当作 0.7 完成交付。

2026-09-18短时采样回归已通过：`sampling10-rd6WDP/report.json`为`sampling10-passed`，北京时间10:36:32开始测量，实测601201ms，10:46:54完成清理；21个有效资源样本通过原20个门槛、同PID及增长检查，26笔业务及26次原命令重放、29次对账、233次快照，最终冷重启恢复通过，游戏/代理/探针/存储全部停止。正式构建与24项工具测试通过；历史样本回放确定复现原18/20失败。本轮仅验证采样修复，未执行热更和五种故障，未启动新八小时测试，原八小时失败报告保持不变。 / The ten-minute sampling regression passed with 21 valid samples against the unchanged 20-sample threshold, same-process growth checks, 26 operations and replays, 29 reconciliations, 233 snapshots, final cold recovery and complete cleanup. The official build and all 24 tool tests passed, including replay of the original 18/20 failure. This verifies sampling only; no new eight-hour soak was started.

2026-09-18八小时SLG长稳soak8h-Bkzmwd最终failed：恢复期23次点采样中，3次outbound=1、2次pending=1被静默过滤，仅18个空闲样本，结束时才触发至少20个门槛；随后资源增长检查及最终冷恢复未执行，原失败报告必须保留。修复采样器为60秒内等待两个不同指标发布周期均空闲，保存全部忙/旧快照，指标不刷新或持续忙碌则失败；固定采样时隙、运行中检查剩余容量、恢复期结束即执行数量和同PID增长门槛。禁止把最低数量改为18或复用同一快照补数。历史23个样本已冻结为回归夹具；复测为SLG正式build、node --test tools/acceptance/*.test.mjs，再node tools/soak_acceptance.mjs --profile sampling10 --confirm isolated-slg-authoritative-test。短测前8分钟每20秒采集、保持20个门槛，后2分钟收敛并冷恢复；它不替代八小时和五类故障验收。 / The completed soak failed because silent filtering left 18 of 23 samples. Preserve that failure; require two fresh idle publications within a bounded wait, check coverage early, and validate with recorded evidence plus a ten-minute real-storage regression.

2026-09-18 H/J前置验证已完成：25个子项分批实测通过，H3在run-gOw29M连续三轮通过（准备阶段客户端回包3/4/3），H8在run-xSvyRq通过10次正式候选和992个连续样本；所有清理成功。五分钟长稳自检smoke5-GUPRFU通过。八小时控制器PID 27472已后台启动，报告在Examples/packages/slg/temp/authoritative-acceptance/soak8h-Bkzmwd/report.json，每5分钟采样；必须看状态、最近采样时间及进程存活，不能把启动当通过。停止用同目录STOP文件，勿强杀Node留下假running。完整三轮A/B/C/D/H/J矩阵仍未通过；本次未修改宿主或DBProxy运行时代码。 / All 25 H/J cases passed in separate runs, including three consecutive H3 rounds and H8 resource gates. The eight-hour isolated soak is launched but not yet passed; use the report heartbeat and cooperative STOP file.

2026-09-18 H3二次复核（run-0YDqnf）出现not-effective：单条串行只读流量的一次往返跨过约85ms准备窗口，服务端已生成旧版响应，但客户端收包比暂停日志到达晚约0.2ms。保留原报告，不把服务器时间替换成客户端完成证据；夹具改为最多4条并行只读请求链，并保留发送/收到/服务器时间，仍严格要求暂停前有客户端回包。禁止拓宽暂停前窗口或改为任意早期回包。复测：正式build后run --cases H3 --rounds 3 --confirm isolated-slg-authoritative-test，再单独H8；不能用旧H3通过记录替代此次稳定性复核。 / A single read round trip straddled the short preparation window. Keep the client-before-pause gate, use four bounded read chains, preserve all timing evidence, and rerun three rounds without changing runtime behavior.

2026-09-18 H9b首次实测被服务器正确拒绝，但夹具只匹配protocol文字而误判。正式协议生成物参与Model包字节，src/hotfix.rs先校验modelFingerprint，因此正确路径可能先报Model哈希不兼容。修复要求候选真实protocolFingerprint不同，并精确核对首个不兼容字段及双方哈希；禁止仅接受任意422、手改manifest或跳过指纹。失败证据为SLG run-JP9R5Z/H9b-1及report.json；同份报告的H3-F2/F3、H6、H7a/b、H9a已通过。复测SLG正式build后run --cases H9b --rounds 1 --confirm isolated-slg-authoritative-test；新增反例单测拒绝无协议变化及无关错误。 / H9b exposed a fixture assumption about rejection order: generated protocol code changes the Model hash, which is checked first. Verify the real protocol change and exact rejected hashes, never arbitrary rejection or edited manifests.

2026-09-17 H3-F2 首轮记录为 not-effective：队列日志已证明 frame=3072、backpressure=1，但基线抓取早于首个周期指标发布，缺少 frame 分阶段计数。夹具现在有界等待完整基线，并保存饱和前后原始指标；禁止将缺指标当零、降低队列容量或删除背压断言。失败证据：SLG temp/authoritative-acceptance/run-8KTtrc/report.json 与 H3-F2-1/game-1.log。复测：SLG 执行 test:acceptance build 后，以 run --cases H3-F2 --rounds 1 --confirm isolated-slg-authoritative-test 定向验证。 / The first H3-F2 run lacked its initial periodic metric snapshot despite actual saturation. Await a complete baseline and preserve raw metrics; never substitute zero, reduce capacity, or remove the backpressure assertion.


D1修复后定向复测：run-wTYhCH/report.json为subset-passed，官方authoritative_reads真实PG/Redis测试1通过（11.42秒），SLG原子批量探针通过，游戏/代理/探针/存储全部停止。工具单测17通过；正式build/check通过。此证据仅覆盖D1，不代表H/J或整轮90分钟通过。

2026-09-17 SLG 90分钟复测在A4因 `docker exited 1` 提前停止；实因每个隔离用例只停止容器却保留默认网络，累计18个 `slg-acceptance-*` 网络后耗尽Docker地址池，业务断言尚未执行。正确做法是确认网络没有运行容器后清理旧测试网络，并让每轮结束时删除容器和网络、保留命名卷。禁止清理开发/线上网络，禁止把Docker启动失败记为业务通过。复测记录：run-GCm8Ll；A4修复后定向复测run-Y5p6QT通过。 / On 2026-09-17 the SLG 90-minute rerun stopped at A4 with `docker exited 1`; the actual cause was that each isolated case stopped containers but retained its default network, exhausting Docker address pools after 18 `slg-acceptance-*` networks. The correct fix is to remove only verified empty test networks and make each run remove its containers and network while retaining named volumes. Never clean development or production networks, and never classify a Docker startup failure as a business pass. Evidence: run-GCm8Ll; targeted A4 rerun run-Y5p6QT passed.

同轮H3第一次复测未扣住提交，是夹具按旧JSON字段 `records` 匹配，而正式DBProxy解码字段为 `writes`；修正字段后又因继承的 `RUST_LOG=warn` 隐藏了 `Hotfix ingress pause started` 的info日志，导致真实暂停已完成却被观测器判为超时。正确做法是按正式 `writes[].record` 校验RecordKey，并为热更验收显式开启info日志；不能放宽2秒观测期限或用admin返回的总耗时替代暂停证据。复测记录：run-TSwgAW（字段误报）、run-w4DoP2（日志可见性误报）。 / In the same run, the first H3 attempt failed to hold the commit because the fixture matched the legacy JSON `records` field while the official DBProxy decoder exposes `writes`; after that fix, inherited `RUST_LOG=warn` hid the info log `Hotfix ingress pause started`, so the real pause completed but the observer timed out. The correct fix is to match `writes[].record` by RecordKey and explicitly enable info logs for hotfix acceptance; do not relax the two-second observation deadline or replace pause evidence with the admin call's total duration. Evidence: run-TSwgAW (field mismatch) and run-w4DoP2 (log visibility mismatch).

2026-09-17 SLG D1夹具隔离失败：run-cHJ8WY在D1提前退出；补齐子进程stdout/stderr日志后，run-TC9Bun确认StorageBackend初始化报publisher endpoint changed，尚未执行读取断言。原因是独立存储测试与SLG共用PG数据库，却以宿主机缓存Redis地址注册已被容器队列Redis占用的legacy Publisher。正确做法是在本轮隔离PG容器内创建authority_probe专用数据库；SLG原子批量探针仍检查SLG数据库，存储级断言单独标明范围。禁止清空Publisher注册表、放宽端点校验或手改构建哈希。复测：在Examples/packages/slg执行node tools/authoritative_acceptance.mjs build，再run --cases D1 --rounds 1 --confirm isolated-slg-authoritative-test；失败证据为temp/authoritative-acceptance/run-TC9Bun/D1-1/sql-snapshot-probe.log。修复后的结果以新报告为准。

## 失败教训与复测流程

### 整合旧分支时须适配当前架构和宿主ABI

源码复核须主动找负路径：原Native worker的`maxOutputBytes`只约束`Ok(String)`，错误直接通过，24字节配置下27字节UTF-8错误的真实反例失败，见`native-error-bound-red.log`。正确修法是同时限制成功和业务错误，超限替换固定诊断，panic诊断保持原分类；测试边界相等、超限后的容量恢复、统计及drain。禁止把成功限长测试当错误路径覆盖、提高上限、删断言或按字符数/截断UTF-8。固定宿主诊断为常量长度，计算函数内部内存不由此限制。修复前Windowsfull9/9不算新Rust资格；新构建、真实Process、完整矩阵和Linux复测分别留档，见[源码对齐](../design/v0.7-merge-0.6.5.md)。

完整矩阵首轮quick33/35：旧端点Drop夹具认为WebSocket只能直接EOF/reset，新握手可能在abort前输出Close。修正为有界读取最多3字节直到真实EOF/reset，只接受空数据或无payload Close及其取消前缀，保留原1秒期限、writer/准入归零及listener重绑；禁止放宽预算、接受任意应用数据或删除资源断言。另有原0.7两处历史文档写死Python安装路径导致本机痕迹门禁失败，改为环境提供的`python`命令，不增加扫描例外，不改封存证据。原始失败`full-verify-r1.log`保留，独立端点复测及下一轮完整矩阵分别登记。

2026-10-07将正式0.6.5整合到0.7：旧关闭测试从`process/types`取得EntryScene导致加载失败，修正为拆分后的`process/EntryScene`；下一轮3/4通过，停止桥接因缺少`__hostCreateShutdownDeadline/__hostCancelDeadline`失败，补齐夹具ABI并检查停止后句柄归零。Rust测试夹具首次编译还漏导入atomic Ordering且误用不存在的`EndpointAudience::External`，应按实际生产枚举使用`Outer`，不增加伪兼容枚举。正确修法是适配旧实现/夹具到当前架构；禁止恢复大文件、删除断言、关闭传输audience校验或放宽生产预算。复测`npx vitest run tests/unit/disconnect_after_outbound.test.ts`、`cargo test --locked --bin TiangZ --features kcp native_worker::tests`及`transport_backend::epoll::tests`，完整矩阵另行登记。原失败及复测在`temp/v07-065-integration/`，移植表和当前状态见[源码对齐](../design/v0.7-merge-0.6.5.md)。

Windows第一次Rust编译报V8 gn_root symlink权限1314，实际Cargo registry在F盘而私有target在D盘；仅在该私有target内创建指向实际锁定V8源码的junction，V8构建脚本验证canonical路径后复测通过。禁止修改registry源码、全局Git/Cargo设置或引用旧二进制作新源码证据。新Native worker是Process级共享资源，drain不可逆，丢弃Promise不取消计算，热更需等待计算与V8交付；Model/清单/Rust/ABI变化重建重启。详细限制见[Native worker](../design/native-workers.md)。旧0.6.5 CI及DBProxy R7长稳不转移为整合后的Host资格；插件/SDK后续对齐和用户指出的未完成部分须单独核对。

### 负载完成不等于长稳通过，控制组 OOM 须独立定位（2026-10-03）

**预判须覆盖完整收尾链路（2026-10-04）**：仅预检报告读取，不证明同时驻留的协调器和 Node，以及后续事件编号输出都能在预算内完成。检查冻结 `review.py` / `independent-review.mjs` / `reconcile.mjs` 后，在独立 512MiB/禁 swap/10%CPU 单元保持 Python 完整 40.40MiB 报告存活，让原 Node 对账函数也冷读同一报告，再处理 30 万条40字节编号；报告输入 SHA 与对账源码 SHA 全核对，Node仍为192MiB old space/4MiB semi space。原 maxBuffer 32MiB、内存预留和全部原始采样不改变。组峰值226.72MiB、Python/Node进程峰值120.66/200.05MiB，OOM/swap零；SQL/Redis模拟输出11.73/12.30MiB。fake Docker独占私有PATH、仅接受fixture资源名；不启动容器、不连接真实存储。该结果只证明固定夹具下的分配/输出边界，不能证明真实Redis Lua内存/耗时、PG查询期限、持续24h分配或任何长稳资格。复测在新独立目录/单元执行 `preflight-review-memory/install-and-start.py`，一次性安装不可重放，结果见 `result.json` / `installation.json` / `started.json`；若预检失败，原证据保留，不加预算或放宽门禁取绿。

**新30m资格**：2026-10-03 23:41:15，北京时间完整新30m独立通过；报告SHA `c864451542b5de78d0b05389c3bfa9534bd0bb6d8de5889d9578671641be0cae`，五份独立证据另逐项重核。负载1800.3839s、空载300.0708s、五类故障，SQL回执/账本/事件/Stream内容/实际退出全部通过；故障期请求错误仍保留。完整960m于23:41:17就绪，不继承旧失败时长；完整960/1440m资格待实际结束。只读入口 `review-current-boundaries.py`、`qualified-30m-and-review-boundaries.json`，不能用初始报告或旧探测状态代替终态复核。

**实际接续**：控制修复 `af0c918` 已部署到独立 memory-r4 现场，2026-10-03 23:06:05 北京时间新完整 30m 就绪；全量五类故障、300s 空载、报告及独立对账通过后自动运行完整 960/1440m，不继承失败时长。48 个 payload、真实服务/负载 ELF、units 与原 2C4G/512MiB 配额均核对。部署前 Linux Node 56 通过 / 1 平台跳过、Python 14 通过，最终 quick 34 步通过、codegen 无差异；23:14 首个主节点强杀恢复通过，数据/请求错误和 OOM 暂零。新阶段资格尚未通过，旧独立 480m 资格保留。

**探测串轮的夹具失败与复测**：23:09 新 Windows 任务的单位名已换，但远端目录仍是旧 diagr3，错误读取旧 failed 后自停；实际新云端测试没有停止。保留错误脚本、快照/事件/自停记录到新现场 `misdirected-probe-20261003/`，修正本机脚本并同时断言 owner、remoteRoot、冻结 plan SHA 和阶段集合，再恢复同一个新任务。`verify-probe-identity.py` 在云端实际旧目录上证明读取 state 前拒绝，正确新目录通过；23:14 任务结果 0、状态 running，下一次 23:39:41。禁止删旧失败、仅修改单位名、取消终态自停或以旧资格代替新运行。复测入口为新现场 `probe-cloud.py` / `probe-identity-recheck.json`，冻结云端代码和计划不修改；后续文档、探测与一次性部署入口必须核对同一身份。

**后续修复与验证**：同一父组内短诊断确认云端默认 V8 堆 2240MiB，未识别祖先 512MiB 限额；只证明预算配置缺口，原退出进程全部保留对象仍无堆证据。显式限制三个 Node 角色的堆、逐条落盘全部历史、分块发布完整报告并观察控制组/各进程，详见[控制内存契约](../design/v0.7-soak-control-memory.md)。完整输入和 1.5 倍采样量在原 512MiB/禁 swap 限额内重放、独立全行核对通过；不是 24h 长稳。新增用例覆盖默认大堆、各类预算/缺失证据、干净缓存与脏页、报告缺行/多行/截断/Unicode/磁盘失败/短写，以及大于堆额度的完整报告；实际进程退出观察未知 RSS 不补零。首次独立核对包装失败来自观察模块所在目录，与产品无关；补齐依赖后重新核对。67 原数据文件加 10 所有权/源码文件，77 份归档已下载逐项核 SHA。新现场先完整 30m 接入验证，再独立 960/1440m，未继承旧失败时长；按实际状态留档，禁止把准备或离线数据量写成真实运行通过。

**追加离线测量及边界**：失败 load/samples/intervals/events/初始 report 五份输入下载后均与原 SHA 匹配；Windows Node v24.20.0 独立进程流式重建 11518 个 progress、11518 个 intervals、1922 个 samples 与 80 次故障，再调用原 saveControlJson。重建后 RSS 90267648 字节，整份报告发布后进程峰值 176570368 字节（约 168MiB），JSON 文件 28283295 字节（约 27MiB）。证据在 temp/v0.7-control-oom-diagnosis-20261003/ 的 raw-hash-verification、replay-result 和重放脚本；重建报告仍为 running，仅含离线 fixture，不可作为真实退出或验收报告。该测试没有 Linux 原控制组约束、16h 网络/轮询历史和旧堆快照，不能据此唯一归因报告大小、确认内存泄漏或宣布修复。下一步仍须把 live heap/external/RSS、共享控制组和发布前后峰值纳入有期限的独立复现。

**现象与证据**：diagr3 的 960m 在 21:22:27 完成客户端负载，原始 SOAK_FINAL 为 57600.40392514s，最终可见状态与观察一致性、validation 均通过；80/80 次故障恢复。21:22:37.351 写入 no-load-observation-started 后，驱动调用 save(reportFile, report)，随后内核触发 CONSTRAINT_MEMCG，512MiB 客户端父组中 Node PID 3601457 被杀，协调器收到取消并在 21:22:39 收尾。report.json 仍是初始 running 报告，progress 的 maintenanceDrained 为真；没有完整空载观察、终态报告及独立 SQL/Stream 复核。不能从初始报告缺 final 判定客户端未完成，也不能用 SOAK_FINAL 替代全阶段验收。

**已确认原因与限度**：内核明确指出 oom_memcg 为客户端控制 slice，被杀者是 Node 驱动，不是两台 DBProxy 或 PG；目标 2C4G 组自身 OOM/swap 为零。Python 协调器、Node broker 和驱动共用 512MiB，不能只检查目标组就宣称所有测试进程无 OOM。失败位于完整报告发布期间，驱动仍累计 progress/samples/intervals 并整体 JSON.stringify；这是需要受限重放的分配路径，尚未测出失败前存活堆、序列化瞬时峰值及各保留对象，不能断言某个唯一分配或 V8/Node 缺陷已经定位或修复。

**正确处理与待修验证**：保留失败状态、停止本轮拥有的运行对象，不改原文件/制品/数据；本机流式复算 11518 个区间，其中 9962 个正常区间错误零，数据不变量零，单次 AOF 超时增量仍位于完整故障窗口。67 原文件共 447916733 字节逐项 SHA 已保存，原数据在云端保留；再次检查保护容器、unit/config SHA 和三项 HTTP 200/health UP。后续先以同一输入在独立限额进程重放，分别记录控制组/各进程峰值及报告发布前后内存，再验证有界驻留和报告生成；24h 数据量与异常发布也要覆盖，完整原始证据和全行门禁仍保留。修复后使用新冻结现场复跑需要的完整阶段，480m 既有独立资格不撤销，失败 960m 不继承。

**禁止绕过**：不扩大控制组预算、增加 swap、裁剪日志/采样、丢弃校验行、放宽 PG/AOF/SDK/恢复门槛、修改 failed 为 passed、补造300s空载或将960m直接记作通过；不重放已执行的 prepare/install/deploy，也不只因 systemd 默认状态零值宣称某个进程实际正常退出。

**复算入口与本轮范围**：既有 inspect-online-diagnostics.py 仅在内存把当前数据库路径切为 960m，保存 failed-960m-prefix-diagnostics-review；另保存 terminal-960m-inspect、oom-boundary-960m 和 failed-960m-evidence-review 时间戳文件。PG 日志仍为 10 条慢占用、queue_timeout 零，9 条在故障窗口、1 条正常窗口 536ms，不因本次控制 OOM 而改写其分类。保护检查只提取冻结 controller 的 run/protect 函数，未执行部署或顶层控制循环。本轮无产品/控制代码修改、codegen 或修复后复测；内存修法与新的长稳启动仍待完成。

### 活跃 timer 的正常触发不能当作业务重启（2026-10-02）

**现象与证据**：日志候选 diagr2 的 480m 在 18:12:36 停止，协调器只报告 `AssertionError: jiaolian-cert-renew.timer`；最后原始客户端周期为 20790.18 秒，30/40 次故障完成，3576 个正常区间无可用性错误，全程数据不变量/缺失或落后快照均零。该证书任务在 18:12:32 开始、18:12:36.795 正常退出，`ExecMainStatus=0`、`Result=success`，证书无需续期。之后保护服务的 PID、启动代次、配置 SHA 和三项 HTTP/健康均未变，timer 返回 waiting。92 文件冻结下载逐项核对，现场 `temp/v0.7-cloud-fault-soak-diag-r2-20261002/failed-480m-evidence/`，归档 SHA `46b60c34a98434932ba1b09a423a0b1e89dcaa4adcddc26ce1c7a37932c9a20e`；`timer-interruption-readonly.json` 保存续期时间、正常退出和当前身份。

**原因与证据限度**：旧保护代码把四种 unit 的所有观察属性都要求等于启动快照，其中活跃 timer 在任务执行期间会从 waiting 变为 running，执行后再返回 waiting。使用专属 `tzfault20261002-timer-policy-test`、32MiB/5%CPU 的真实 systemd timer 复现：配置路径和 ActiveEnterTimestampMonotonic 不变，旧比较仍拒绝正常运行。原始失败没有逐字段快照，不能宣称观测到了历史具体差异；正常触发误判是事件时间及真实复现支持的定位，不归因于 DBProxy、业务故障、内存或 PG 2s 排队。

**正确修法**：`tools/lib/soak_protected_units.py` 被新协调器和接续器共用，只在 baseline/current 都为 active 且 timer 子状态属于 waiting/running 时允许 SubState 转换。其他属性仍精确匹配，属性缺失或多出也拒绝；服务 MainPID/NRestarts/启动时间、timer 启动时间和 FragmentPath 不变，调用者继续核对 unit 原始 SHA、157 个配置 SHA、12 容器身份和业务健康。inactive/failed/elapsed、重启或路径变化均失败；错误现在列出 expected/observed 差异。旧现场不修改，另建 `tzfault20261002diagr3`，仅控制策略改变，原产品 ELF、负载、故障计划、2C4G、PG/AOF 2s、SDK 5s 和资格门禁保持。

**禁止绕过**：不得停用或修改业务续期 timer、忽略全部 unit 状态、更新 baseline 掩盖重启、删旧失败标记重放部署、把 346 分钟拼入新阶段，或将本轮检查误报写成产品排队修复。未完成的 480m 资格为零，原旧制品已通过的 240m 独立证据仍保留。

**复测**：在 `tools/lib` 运行 `python -B -m unittest -v soak_protected_units_test`，Windows/Linux 各 7 项通过；真实独立 timer 完整观察 waiting→running→waiting，新策略接受正常触发且拒绝实际停用，原比较确实失败。diagr3 接续边界 8、Node 控制 44（1 平台跳过）、SQL/容量复核 7 均通过，部署前也执行 Linux 策略 7；新完整 480m 于 21:16:22 就绪，实际 ELF、44 个 payload、unit/guard SHA、资源约束及保护业务再独立核对。证据为新现场 `actual-timer-regression.json`、`post-install-verification.json` 和旧现场 `audit-failed-prefix.mjs` 的原始复算；无 Rust/TS 重编或 codegen，长稳尚待完整结束。

### 停机后端口释放与部署预检（2026-10-02）

旧 240m 独立通过并正常停机后，09:53 首次自动接续的 `new-deploy.py` 普通 `socket.bind` 报 `EADDRINUSE`，发生在创建目录、存储和新负载之前。原代码只报栈、没有记录哪一个端口或 TCP 状态；不能事后认定被保护业务占用、旧进程没退出或确定就是某个 TIME_WAIT。后来只读检查全部七个端口没有监听者；在同一云端用独占的临时 loopback 连接真实复现：监听/进程已关闭、只有 TIME-WAIT，普通 bind 仍为 errno 98。这支持内核连接残留解释，但不补造历史失败的缺失观察。

正确做法为 `tools/lib/soak_port_preflight.py`：原普通绑定方式保持，全部端口共用 180s 等待期限，绑定失败时只读 `ss`，记录端口、监听者与 TIME_WAIT；真实监听立即失败，其他绑定错误或状态采集失败也明确失败，只有无监听的暂时占用才有界重试。禁止强杀占用者、开 SO_REUSEPORT/SO_REUSEADDR 掩盖预检、改业务端口/防火墙、只 sleep 固定秒数假定释放，或删除旧失败标记重放。部署控制单元总期限单独设为 600s 覆盖 180s 端口等待/120s 存储就绪/前置测试；这不是放宽 PG/AOF/SDK 的产品期限。失败现场与旧资格 64 文件冻结、原摘要全部核对；另建 diagr2 所有者和目录，服务/客户端/故障计划/2C4G/2s/5s/SQL 门禁与实际两个产品 ELF 不变。旧控制器边界短暂进入的旧 480m 是计划性中断，旧全局 failed 不撤销完整通过的 240m，其部分时长不折算新版。

复测 `python -B tools/lib/soak_port_preflight_test.py`：Windows 4 通过、2 Linux 专属跳过，实际云端 Linux 6 通过，包括真实监听保留、真实 TIME_WAIT 的有界失败、释放后继续、共享期限和状态采集失败反例；接续不足时长/空载/原始变化/未知或空退出列表/旧资源未停 8 条反例通过，新部署前 Node 44+1 平台跳过、Python 7 均在本机和云端通过。`temp/v0.7-cloud-diag-handoff-20261002/port-preflight-linux-tests.log` 保留真实 errno/状态；新 `post-install-verification.json` 核对实际服务与负载的 /proc/exe、源/计划/payload/unit/guard SHA、父组约束和保护业务。后续只读新 `probe-cloud.py`，不重放已经执行的 install/prepare/deploy。脚本可复用，机器路径和日期仅属于此次证据。

### 启动状态文件就绪不能靠固定短 sleep（2026-10-02）

新恢复服务先流式复核旧报告/原始 SHA，再保存第一份启动状态。安装器固定等 2s 后就读文件，曾抛 FileNotFoundError；后台实际服务继续正常运行，在 12:25:58 就绪 480m。因此读状态失败不等于部署失败，不能盲目重跑安装或重启已开始的负载。保存 `installation.err`，只读服务/状态/日志，独立核对实际 source/ELF/ready 和资源后记录 `post-install-verification.json`，本轮安装没有重放。安装器改为有界 60s 等文件并检查服务仍存活；超时保留未知/失败证据，不补造 running。新部署刚开始的 starting 状态也不是故障，必须等真实 ready，再验证完整目标时长/100 人/连接池/实际进程。恢复准备的首试还因 helper 路径多取一个 parent 在本机失败，未上传，部分候选归档 `preparation-attempt-1/`；修为从实际引擎根解析并在创建任何 payload 前检查 helper 存在，禁止去错误目录创建替代源码。

### 实时进度与终态报告分开读取（2026-10-02）

07:50 接续只读汇总首试从运行中 `database/report.json` 访问 `ready` 抛 `KeyError: 'ready'`；负载期间该文件只是初始报告，ready/增量进度在 `progress.json`，已完成故障事实在 `events.jsonl`，最终报告只在收尾后完整。不是 DBProxy 产品故障，也没有发出停机/重启或变更冻结输入。读取实时状态应结合协调器状态、progress、原始事件和实际进程；判断已完成资格仍须核对终态 report、独立结果及列出的原始 SHA。禁止缺字段补零/写 passed、只凭旧 report 的 running 判断继续、或因只读工具失败重放/重启测试。

修复后的只读入口为 `python -X utf8 temp/v0.7-cloud-fault-soak-r3-20261002/inspect-cloud-progress.py`；它流式核对证据摘要/资源记录，读取实时进度与已完成事件，保存 `latest-status-review.json`，原错误保存 `status-reader-attempt1.err`。实际复读确认 30/60/120 完整阶段与原始证据一致，当前 240 分钟第 11 次故障已恢复，保护业务探针正常。已有资格和产品/期限不变；缺失或过期观察仍不能当正常。详情见相邻 DBProxy `docs/cloud-fault-soak-2026-10-02.md`。

### 原始长时证据必须流式复核（2026-10-02）

第二轮只跑约 18 分钟时，资源采样已经 5,447,411 字节 / 200 行，按原频率的 24 小时文件约 449MiB；控制组上限仅 512MiB，还要运行负载/协调器及持有报告。原 `Path.read_bytes()` 算 SHA 和 Node 整体解析 load/metrics JSONL 是控制器内存风险，不能等数小时后才发现，也不能归因于产品内存随时间泄漏。这里尚无实际 OOM；日志尺寸外推不是服务内存外推。

正确做法是原数据完整留档、记录有界逐行解析、每一行仍执行累计超时/客户端门禁，独立恢复判定只保留必要的每故障/每节点原始边界，SHA 固定小块更新；SQL 活动原文仍保存，只将门禁摘要保留在内存。禁止加大控制组预算、降低采样频率、丢行/裁日志、吞截断 JSON、重置计数或只核对末尾零值来过关。合成证据必须超过控制器额度，并同时验证摘要一致与内存上界；本轮 630,184,560 字节文件 SHA 一致，Python tracemalloc 峰值 2,229,282 字节，不能宣称这是整进程 RSS 或产品验收。

修改控制源时已运行的阶段不得静默继续：本轮显式记录计划性中断、等待协调器收尾、核对实际 PID/制品/容器所有者并保留全部证据，再以新现场从完整 30 分钟重启。第二轮四类故障在线通过但整轮无资格，两个节点实际正常退出，74 文件归档 SHA `0300e2ed28133693adeb508d01839f316d73208f867feaf9f982d05ae68053ec`，没有产品失败或 OOM 的结论。旧本机只读任务已禁用，不恢复旧 PG 数据到新现场。

第三轮工具验证：`check-bounded-memory.py` 生成、核对并只删除自己独占创建的大文件；Node 新增 UTF8 跨块、无换行完整尾记录、截断/超长拒绝、全样本与有界恢复边界同判的反例，本机/云端各 44 通过、1 平台跳过，Python 7 通过。当前跟踪入口 `temp/v0.7-cloud-fault-soak-r3-20261002/` 的 `probe-cloud.py` / `companion-status.py`，仍是只读；一次性部署/准备不重放。计划 `be845f40...`、产品 ELF `07c1f021...`，与下方较早失败/修复记录分别判断，完整阶段和正常终态复核仍待完成。

### SQL JSON framing 与 systemd 退出证据（2026-10-02）

云上故障长稳首轮在 SOAK_READY 后第一次 SQL 采样抛 JSONDecodeError。查询返回多个 JSON 值，其中 PG `json_agg(a)` 数组可跨物理行；`stdout.splitlines()` 再挑第一行截断了数组。正确做法是 `psql -Atq` 抑制命令标签、保留完整 stdout，用 JSONDecoder 游标解析全部值并要求精确行数；JSONB 紧凑输出只是辅助，不能代替 framing。SQL 观察失败要保留原命令结果；只有真实声明 PG 停机窗口内的失败可记为未知，不能记零或忽略。禁止删除 PG 活动观察、只取数组第一项、吞解析异常或放宽正常窗口/产品超时来让测试通过。

同轮 runner 停机又因退出元数据缺失进入错误路径，再向已退出 PID 强杀而中断最终 report；原 runner 文件因此仍为 running。systemd 的默认零属性不能冒充实际进程退出零：本轮 service 保留已完成代次，校验 ExecMainPID / Code / Status 和日志，再明确停止旧代次后启动新进程。所有信号基于完整制品 SHA、实际 PID 与 start ticks，已退出返回 false，不能打到复用 PID。清理失败仍必须保存最终失败报告并核验真实资源状态；禁止把 MainPID=0/接口返回零直接写成正常退出，或覆盖旧 running 文件冒充成功。

首轮协调器明确 failed，三个存储及节点独立核实停止；61 文件归档 SHA `b172e063038de482964f89693af9036dee0d8f06908b6e8401786fe973237962`，原 PG/Redis 数据保留、资格零。修法只改控制脚本，不改产品 ELF / SDK / 2000ms PG 期限。从新数据库/卷/所有者重新跑完整阶段；新现场首次 SIGKILL 已记录正确代次并通过原恢复门禁，但完整阶段的正常退出及独立终态复核仍待结束，不能提前写通过。

准备阶段重犯已知 Mounts 顺序误报，独立 diff 证明只有完整列表顺序变化，PID/网络/内容保持，按完整记录排序修复而非删除保护。失败的前置检查后不得继续依赖准备；本轮不完整包只留在本机、未上传，补齐保护快照后才重新冻结。生成脚本的外层与内层定界符不能相撞，先 ast 解析两层再传 SSH；本轮附加监测安装首试 SyntaxError 在本机解析前置阶段，未建立 SSH，不定性为产品/远端运行失败。

只读/纯工具复测：在新现场执行 `python -m unittest -v review_test`（7 通过，含多行数组/截断和正常积压反例）；用明确的六个 `.test.mjs` 文件执行 Node --test（本机/云端各 41 通过、1 平台专属跳过）。实际只读入口 `probe-cloud.py` 与 `companion-status.py` 保存进度、保护探针、真实代次和冻结源 SHA；不重放 prepare/deploy/初始化。状态未变的本机 30 分钟探测不反复提示，终态且资源已停后只禁用自己的任务；云端独立安全观察器不自动恢复失败测试。证据见上述两处 `temp/v0.7-cloud-fault-soak*20261002/` 以及相邻 DBProxy 云上报告，R11 失败仍保留。

### SSH 脚本传输与负载结果分别判断

R2 后置核对首试在本机 Python `CreateProcess` 抛 WinError 206：含 157 配置摘要的脚本整体编码进 SSH 命令参数后过长，SSH 子进程尚未存在，远端 PG/Redis 核对也未执行；之前的 helper SCP 已完成。原空输出与错误保存为 `attempt1-post-audit.*` 和 `post-audit-attempt1-failure.json`，不能按“已有文件”推断远端执行过，也不能把后置工具失败写成客户端负载失败。实际只读核验三个专用存储均停止后，使用 `ssh -T … python3 -`，源文本从标准输入传输，核对成功并在 finally 再停止自己的 PG/Redis；原负载结果和默认期限保持。

大脚本使用标准输入或专用文件，shell 参数只放固定短命令；不要调产品预算、重放部署/负载、删除首试文件或修改全局 Windows 路径选项来绕过。判断连接失败时是否执行过，须先核对远端状态/所有权；CreateProcess 前的失败和已建连接中断不能混为一谈。复测是源文本解析、真实传输、3870 个 SQL/Stream event_id 与原始 payload 一致、账本总额及保护业务复核，不仅是命令返回零。已完成的现场卷已退役，接续读取 `report.json`、`post-audit.json`、`retirement.json`、`final-verification.json`，不再重跑一次性核对入口。

容量用例同时检查客户端结果、运行中积压/趋势和停载排空，不能只在停载后读零；原失败序列加合成归零尾段的控制反例必须仍失败。积压采样口径要包含正在租赁的未发布事件，两个节点的共享队列 gauge 不相加；桶上界不是精确 P99，第一次读到零的采样时刻不是精确排空耗时。内存保留原父/子组 file/shmem/anon 和进程 PSS/私有页，不双计 shmem 或累计 PG RSS；进程采样退出记录未知，不补零。R2 的短时平台、34 字节以内 payload 和无故障负载，只作为这组试验的证据，不覆盖旧失败、真实游戏容量或 24 小时。

### 初始化探针期限和运行时预算分别判断

2026-10-02 新隔离 PG 首次 initdb 正在 `syncing data to disk`，Windows Docker exec 探针触及工具 10 秒期限，准备驱动提前停止该专用实例；未执行 Linux 产品测试或正式负载，不可定性为 DBProxy 请求超时、OOM 或容量失败。实例退出 137 来自本次有界停止，`OOMKilled=false`，不能只凭退出码认定内存故障。改为 Docker 内的 TCP healthcheck 与 180 秒初始化上限，真正 healthy 后才创建专用数据库和运行验证；产品 2 秒 AOF、PG 排队/SDK 总预算不变，不累计准备时间。第二次准备又发现 volume loop 复用了 attempt 后缀变量，命中错误 env 文件路径并在创建 PG 前失败；独立变量与新的尝试身份修正，原失败状态不改为 passed。三次尝试各用独立卷/网络/容器，最后真实 Linux 228 与另外 9 项 PG/Redis 检查通过。成功与未进入应用请求的失败准备对象均在日志/摘要保存后按所有者和完整 ID 回收，不能留下新一批过期容器。

复查分别读取 `local-build-state.json`、`local-build-state-a2.json`、`local-build-state-a3.json`、`build-report.json`、各阶段 Linux 日志和 `preparation-cleanup.json`；源码 `08aa916` 与服务 ELF `07c1f021...` 分别记身份，不继承旧 `42f2762` 容量或长稳结果。周期故障/性能验证先声明趋势、稳态和停载门禁；只检查 RPC 最终状态或停载排空会漏掉持续积压。新观察门禁对修改前的真实失败序列加合成零积压尾段仍拒绝，属于控制器反例，不能称为重跑基线 SQL 或新容量通过。

### 失败证据与可重建编译缓存分别收尾

旧验证只收尾运行对象，未回收工作区的增量对象、重复 Native 构建中间产物和隔离 Linux 下载缓存，累计 169.09 GiB 文件长度。保留失败报告不意味着保留所有 `target/deps/build/incremental`；同时不能按目录名删除整个旧 worktree，本轮旧部署 worktree 和 rc.1 验证副本仍有未提交修改。先固定需保留的源码、Git 状态、实际二进制/符号/manifest、失败日志/数据和冻结路径，再仅删除已闲置的可重建中间产物。清单预备首次因只汇总浅层目录、补算返回形状错误而中止，均未开始删除；修正后形成完整清单才执行。PowerShell 只读联接检查也曾误用不兼容的 `Split-Path -LiteralPath/-Parent` 参数组，改为 .NET 路径解析并启用遇错即停，不能将空检查结果当作通过。

递归操作必须核对绝对边界与每级 reparse 属性，枚举不跟随目录联接；不能把联接外部目标算作工作区临时数据。6 个 GN 联接的额外 unlink 遭工具策略拒绝后原样保留，不重试绕过，不触碰 F 盘 Cargo/V8 缓存。禁止全局 `git clean/reset`、删除未提交文件、注销实际开发 worktree 或为了清理重跑旧失败负载；最终二进制保留不表示被删缓存仍可直接用于增量构建，之后按原锁和源身份重建。

统计分别保存文件逻辑长度、删除阶段盘可用差值及后续盘采样；压缩、硬链接和其他同机活动会使这些数字不同。新验证从创建时记录所有者、保留物和成功/失败收尾，结束后回收中间产物，避免日后靠磁盘告急再集中清理。只读复查证据为本轮 `verification.json`、`git.after-cleanup.json`、`retained-binaries.before.json`、`r11-inputs.after.json`；100 个制品摘要、22 仓库状态、39 个冻结文件及 16 个证据绑定通过。不要重跑一次性 `cleanup.ps1`；文档检查使用 `git diff --check` 与 `npm run verify:no-local-traces`。

### 测试收尾要回收容器，不能只看镜像引用

2026-10-01 清理只筛选无容器引用的镜像，漏掉 56 个早已结束的 v7 构建/控制/历史长稳容器。引用同一验证镜像并不说明仍有运行用途；输出已在挂载目录，旧容器可写层四次保留依赖安装约 265 MB，各阶段退出后无人回收，累积约 1.06 GB。容器 `virtual size` 和镜像 tag 字节含共享层，不能逐个相加。退出容器不占 CPU；正在运行的旧存储和其他项目进程要分别核对。

正确流程是核对最新容器状态、所有者、完整 ID 与挂载引用，保存必要 inspect/日志/diff 和实际产物证据，再移除一次性容器；对仍需诊断的数据仅停止专用服务并保留卷/AOF/冻结输入，不排空失败 Outbox。清理失败现场不等于将失败改成通过。新验证从创建时就指定所有者、日志/产物位置及成功/失败收尾策略；无保留价值的一次性容器在取证完成后回收，不靠无限堆积历史运行对象保存报告。不套用全局 prune、force 或 `rm -v`，不清其他工程、匿名卷、全部 cache，不重启共享服务来掩盖资源增长。

复核时使用执行前重新读取的身份；其他进程/用户可能在检查与执行之间改变状态。本轮 battle-lab 和 SLG 在移除动作之前已停止，不能用执行前后 guard 通过宣称整个会话它们始终运行，也不能归因于删 v7 容器。读取实际 Docker 事件时间与本次 action 时间，不自动恢复他人状态。日志双通道均需归档：`docker logs` 的 stderr 不是调用失败；校验 gzip 解压/摘要后再删除对象。56 份 manifest 与动作见 `temp/v0.7-local-images-cleanup-20261001/`；只读复核用 `docker ps -a`、`docker system df` 和最终审计，勿重跑一次性清理脚本。


### 分片排队必须区分持锁、SQL 点样本和指标漏计

2026-10-01 R11 离线分析：失败前副节点请求连接阶段在执行 4 项、等待 28 项，近 120 秒完成阶段占 96.82%；此前有 34 项等待仍通过，不能只凭人数定性为泄漏、持续积压或稳定哈希失衡。健康完整指标区间有 694 次等待落在 (1, 2] 秒，平均 36 ms 不证明两秒有充分余量。按节点 generation 做累计指标差，跨故障/恢复的整个采样区间不纳入正常耗时统计；分位桶上界不能写成精确 p99，未完成等待也不在已完成直方图内。

代码确认 PG `request_client` 到期未递增超时指标：副节点 660 条早期排队超时日志均在故障/恢复窗口，但指标仍为 0，最后一次正常到期使日志总数变为 661。超时回归需同时断言错误、无 SQL、等待释放与显式计数；正常取消不能计为超时。长稳一般错误只采前 16 个会耗尽末段证据，应保留有界的滚动/终态首错及请求关联；不要删除前期失败、无限打日志，或用重试隐藏正常窗口错误。

后台的独立 claim/ACK 连接不代表所有后台数据路径隔离：当前整批快照落盘、cache repair 权威读取仍用请求分片。建议以有界的独立后台连接减少前台争用，同时保留 fence、原子事务、锁顺序、结果映射和可靠确认；共同 WAL/磁盘等待仍需观测。失败附近 WAL/检查点相关，但排队约在检查点前已开始，不可据此断定机械盘或 checkpoint 是唯一原因。PG activity 是一秒点观察，最长年龄也可能属于 autovacuum 或故障中的 ClientRead，不能冒充前台 SQL 或 mutex 占用最大耗时。

容量验证应允许健康副节点持续承接全部 40 人，不靠自动回主、增大分片数或把两秒改十秒规避；结合客户端默认五秒总预算校准排队余量。下一轮先针对性回归与新的隔离 30 分钟诊断，再开始新的完整 24 小时；保留原数据/门禁和失败，不累计部分时长。完整离线来源摘要与建议见[R11 分析](../design/v0.7-soak-interruption-recovery.md#r11-排队结构与观测缺口分析)，本次只写分析和文档，未实现上述修法。

### 正常窗口失败、终态观察和失败后积压分别处理

2026-10-01 R11 第 6929 个原始区间出现 1 次交易错误，正常区间不与任何故障/恢复窗口重叠；日志确认副节点 PG 请求连接锁 2000 ms 到期。正确保留最后拒绝行、失败状态、原 39 份冻结摘要和失败导出，再按原预算复核，不能把错误补入已结束的故障窗口、加大期限、生成新幂等号、拼接时长或不停盲重跑。该 Store 操作未发送 SQL 不保证整个业务 RPC 未提交；本轮读到的事务回执比已采集客户端完成数多，并不自动等于重复写入。

新增 PG 采样确实留到失败收尾：33681 成功、960 个显式错误，完整错误区间均包含在实际故障事件 UTC 窗口内。失败附近看到多连接 WALWrite/WalSync 与 11:17:32 UTC checkpoint 启动；最长采到的查询年龄 0.367 秒只是离散快照，不能证明 SQL 最大耗时、持锁者、分片排队深度或 checkpoint/HDD 因果。下一步需补齐连接归属/完整持锁与排队阶段证据并验证修法，不用点样本直接改产品预算或关闭可靠落盘。

PG 观察器已受控退出且原报告/观察 SHA 一致；终态助手仍将空 CIM stdout 直接 JSON.parse，产生独立解析误报。活动运行必须检查 PID/创建时间/程序和新样本，终态则核对原完成报告及输出摘要，并明确当前进程不存在；不能把正常观察退出误报成原业务失败，也不能忽略活动观察器死亡。本轮独立失败审计按终态证据解释，未改旧助手、绑定或冻结现场。定时通知只记录 requested；它固定指向 R11，终态禁用后不会自动监控将来的新阶段。

失败后两个服务退出而没有完成维护排空，26 条 Outbox 未发布仍保留。正确分别核对 SQL 版本/回执/账本、已发布事件的 Stream 集合和待发布数；缺最终客户端与排空时，内部一致只作取证，不作长稳通过。不得启动旧工作负载/Worker 把失败现场排空后宣称原测试正常，也不删除旧库/索引腾新空间。副节点实际有 4 个请求分片；后台批次共用请求分片是代码可查的候选路径，尚无超时持锁证据，不能定性为根因。

独立审计首版误传 `validateWindows` 参数，产生 Missing scheduled faults 误报；保留首版源码和失败。正确调用原 `validateWindows(expected, windows, seconds, recoverySeconds)`，只复核已完成的计划前缀/原窗口，使用原 86400 秒声明和 180 秒恢复界限，明确 49/120 不能冒充完整资格，不删除断言。完整 158 份失败导出、9 组 AOF 原内容、客户端拒绝反例、采样错误归因和只读 SQL/Stream 已复核。可重复查看 `temp/v0.7-r11-failure-review-20261001/failure-summary.json`；inspect/verify/storage-review/finalize 为一次性保存入口，不重跑覆盖。SHA 和证据范围见[失败记录](../design/v0.7-soak-interruption-recovery.md#r11-正常窗口再次-pg-排队超时)。

### 外部定时探测必须验证实际运行和通知路径

2026-10-01 按要求启动 R11 每 30 分钟探测。本会话没有可调用的 Codex 自动任务接口，已向用户说明采用 Windows Task Scheduler；不得伪称已创建聊天自动唤醒。注册成功、NotifyIcon 的无显示探针通过都不等于实际定时执行和完整通知路径通过。必须查看真实退出码、源快照 SHA、下一次时间、触发间隔及实际完整通知调用；本轮修正后任务真实退出 0，完整通知比较约 10.4 秒完成，原 20 秒期限不变。通知记录只表示请求，不冒充用户已收到。

首次定时运行只在 `docker info` 原 10 秒环境查询门禁处超时；负载、3 次故障恢复、正常窗口和内存检查仍通过。保留 `probe-gR2Ypb/report.json` 与原快照，随后独立只读检查及修正后定时检查在原门禁内通过。底层超时原因未记录，不能推断是产品崩溃、内存不足或已修复；不改冻结助手、扩大预算或忽略环境失败。外部探测不得重新启动工作负载或重跑一次性准备/恢复脚本。

通知首版在 Node 隐藏、重定向的 Windows PowerShell 子进程中另传 `-WindowStyle Hidden`，进入脚本前无输出，完整比较亦失败；只去掉重复开关、保留 Node `windowsHide:true` 后完整调用通过。具体底层 Windows 原因未证明，不推广为所有机器的结论。子进程错误应记录本次实际期限与已有 stdout/stderr，不能把 20 秒通知超时误标成 180 秒状态检查。先保留旧配置/源码/首跑报告及 SHA，再修改外部脚本并重绑自己的摘要；不触碰 R11 的 39 份冻结输入。

前置检查还遇到外层 PowerShell 展开内层变量、PS5 拒绝运行 `.ps1`、按名称导入 Security 模块产生重复类型成员。修法为结构化 argv 传入已核对固定代码和 JSON 数据，诊断显式导入 PS5 原生模块 manifest；不要用反斜杠转义 PowerShell 的 `$`，不要改全局执行策略/模块路径或添加 Bypass。保留首个 `validation.json`，独立复核通过；通知代码不执行 JSON 内容。

任务身份审计首版直接比较导出的 `UserId` 字符串和当前 SID，因 Scheduler 将其规范为账户名而误报。正确做法是通过 Windows NTAccount/SecurityIdentifier 解析后精确比较 SID，同时仍要求当前用户、Interactive、Limited、30 分钟、IgnoreNew、5 分钟上限和无自动重试；不能删除身份断言或改成提权任务。首版审计源码和失败记录保留。

复测：`node --test temp/v0.7-periodic-probe-20261001/policy.test.mjs`（7 项）、`node --check temp/v0.7-periodic-probe-20261001/probe.mjs`；查看 `Get-ScheduledTaskInfo -TaskName TiangZ-v07-R11-Probe-30min-20261001`、该目录 `latest.json` 和 SHA 绑定的 `registration-review.json`。一次性 validation/register/rebind/审计与通知比较脚本已有保留结果，不作周期命令重跑。证据 SHA、去重与终态规则见[定时探测](../design/v0.7-soak-interruption-recovery.md#每-30-分钟只读探测与本机通知)。

### 关机恢复、历史证据和采样寿命分别处理

2026-10-01 用户关机后，旧 30 分钟诊断已完整结束；当前 Docker pipe 不可用不能反向否定已封存的历史结果。终态复核需分别报告原文件/冻结摘要与当前资源观察失败；活动运行仍要求真实 PID、创建时间、程序/脚本、容器和新样本，不能仅凭 running 文件继续计时。Desktop 自动升级时保留版本变化，新长稳重新冻结环境，不能改旧版本记录或拼接停机前后时长。

恢复原存储时 PG 仍在自动日志恢复，首次 `pg_isready` 拒绝；这不等于容器没启动。必须先核对 owner/ID/image、原挂载与额度，再使用独立有界就绪检查和真实查询，核对完成阶段 SQL/Stream 与失败现场数据。第一次失败与后续成功分别 SHA 绑定保留，不重复 start、重建容器、清卷或循环重启。命令非零退出可能只写 stdout；保存实际 stdout/stderr、退出码或信号，不能把空 stderr 的 `null` 当真实诊断。本次新助手以真实 stdout-only 拒绝验证，原预算不变。

独立审计首次因阶段内缺日志失败，原因是诊断协调器把日志放在运行根目录。正确修法是在独立审计视图按原日志 SHA 映射路径，并记录第一次失败；新协调器统一阶段路径。禁止补造日志、在原封存现场补文件、跳过日志断言或以重新跑产品代替历史核验。历史报告必须使用原状态/计划/控制器 SHA，不能拿新驱动或报告自报值作期望。R11 的新导出将历史六级与新 1440 分钟分别校验；完整新导出尚未执行，规则检查不冒充发行验收。

诊断由 30 分钟扩到 24 小时时，观察器寿命必须显式覆盖负载和收尾。本次只把 PG 采样寿命由固定 40 分钟改成显式 87600 秒；500 ms SQL/2 秒采集命令、产品 PG 排队两秒、AOF/SDK 与恢复预算均不变。新增 PG 指标也沿用正常窗口/完整区间超时门禁，缺失计数不得补零；缓存指标和 SQL 活动快照不提供精确超时事件时间。真实 `pg_sleep(2)` 只在已完成旧库验证观察能力，不在活动负载中重跑。

证据清单、第一次路径/就绪失败、恢复复核 SHA 和当前检查记录见[诊断完成与恢复](../design/v0.7-soak-interruption-recovery.md#30-分钟诊断完成与关机后恢复)。当前只读复测：`node temp/v0.7-pg-queue-review-20261001/status-r11.mjs`；窗口/来源反例已在新冻结检查中验证。不要重新执行 prepare/freeze/precheck/register 的一次性入口；这不是产品修复，短时通过不能排除原 R10 故障。

### 正常窗口的 PG 排队超时必须保留并调查占用者

2026-10-01 R10 正常区间增加两次事务错误，服务日志确认等待 PG 请求分片连接锁 2000 ms 到期；最近故障结束与下次故障开始均在该区间之外。原测试正确拒绝，不得按可重试错误免除、补入故障窗口、删最后一行或调大期限制造通过。该次 Store 操作未发送 SQL不代表此前业务提交不存在；结果未知仍用原操作号和完整请求恢复。

正确顺序是保留原始区间/日志/冻结身份，再核对数据、进程退出和环境，补齐活动 SQL、等待类型、事务年龄、阻塞 PID及 PG阶段指标，确定具体修法后重新构建和验收。现有零数据违例、正常退出与内部对账只说明已观察部分；没有最终客户端记录便不能宣称完整数据验收。I/O压力、checkpoint或充足内存均不能单独证明或排除根因。PG 排队两秒、Redis AOF 两秒与观测区间越界是不同事实。

本次同时发现失败导出对历史继承阶段误用新驱动摘要：必须验证 SHA 绑定的原状态/计划与控制器来源，再用原阶段驱动校验；不得仅拿报告自报摘要作为期望值或关闭校验。失败现场与直接触发已确认，产品修法及冻结导出器修订未实施。证据 SHA、原失败反例复核命令与当前 30 分钟诊断见上述设计文档。新只读观察器已用真实 `pg_sleep(2)` 等待和受控退出验证；人为等待属于采样用例，不混入产品错误，不能在活动负载中重复执行。

### 故障切换与诊断采样必须分开判读

2026-09-30 R10 第 40 次故障主动停止 PostgreSQL 时，观察器已取得 running，四项后续 `docker exec` 读取却返回容器未运行。`inspect` 与读取分属不同命令，状态可能在其间变化；必须按 1 条缺失样本、4 项采集错误保留，不能当作 4 次意外宕机。用原容器身份、采样开始/耗时、停止请求/完成、恢复后的成功读取和负载数据联合判读，不能单凭 `activeFault` 或一次 running 快照作结论。

本次时间线与计划内停库吻合，恢复和 AOF 前后内容均通过；采集错误没有触发重启或修改冻结脚本。诊断命令竞态的解释不等于累计超时增量获得豁免：跨界计数仍按原规则拒绝。缺失指标不能补零、删除或无限重试掩盖。证据 SHA、原始行和具体时间见[采样缺口](../design/v0.7-soak-interruption-recovery.md#r10-故障切换期间的采样缺口)；只读回放 `node temp/v0.7-timeout-boundary-20260930/check-storage-stop-race.mjs`，完整运行中复核 `node temp/v0.7-timeout-boundary-20260930/check-r10.mjs`。仅验证历史诊断与当前已完成区间，不代替最终数据对账及完整 24 小时。

### Desktop 维护恢复必须区分产品、资源身份与观察器启动

2026-09-28 完整 240 分钟后，自动重启卡在残留 `sailor-ingest.sock` 重命名；这是 Desktop 启动失败，既不撤销已完成阶段，也不允许累计后续未运行时长。保留原失败，在核对路径和进程身份后只备份已证实的运行时 socket 目录，恢复同一批容器和持久数据；不能恢复出厂设置、清卷、全局关闭 WSL 或循环重启碰运气。

恢复脚本另暴露两种表示误报：Docker 将空 DNS 的 null 序列化成 []，同一 Mounts 数组在重复 inspect 中改变顺序。先用原完整 SHA 证明每个字段相同，再仅归一化这两种差异并保留原始 SHA；不忽略整段 HostConfig/Mounts，也不靠重复 inspect 直到碰巧同序。五项反例检查涵盖 DNS 服务、额度、权限、挂载源/目的地、读写标志、卷身份、缺失/重复条目，真实变化仍拒绝。

后台观察器通过 Windows Start-Process 正常启动，但 Node 启动器等待管道 close，误报 15 秒超时。三秒子进程复现中父进程约 409 ms exit=0，约 3770 ms 才 close；退出与所有管道关闭不是一个事件。正确做法是把长期 worker 的 I/O 直接归到文件，分别监督短启动器和 worker，按 PID/创建时间/可执行路径/脚本 SHA 与新样本确认运行。当前恢复直接接管已正常采样的内存 worker，不重启它；仅停止保留失败后仍持有管道的已核实启动器。禁止把通用负载驱动的 close 全改为 exit，避免尚未排空的日志丢失。

维护延误还会消耗旧观察器的固定寿命：本次新建只读存储观察代次，核对成功后停止原观察器，保留 1547 份旧样本；其中 690 份错误全部属于维护等待点，活动阶段为零。新观察器最多 72 小时、原协调器终态即退出，覆盖剩余 48 小时负载，不拼接维护缺口。复测命令、完整证据和内存前后口径见[维护结果](../design/v0.7-machine-memory-observation.md#240-分钟通过与-desktop-恢复结果)。不重复执行已经放行的恢复脚本。

### 正常窗口 AOF 确认失败须保留，不能按故障重试掩盖

R5 启动前的源码核对另发现：新的专项失败诊断使用具体状态 `confirmed-unexpected-availability-failure`，原协调器要求通用 `failed-run-reviewed`。最初预检只查报告 SHA，可能预检通过而启动拒绝。正确做法是保持原诊断，新增绑定其 SHA 和原终态 SHA 的通用复查信封，预检同步验证协调器约定；原尚未启动的准备文件保留 `preparation-r1/`，新准备与只读预检、22 项控制器检查重新执行通过后才启动。不能把具体错误状态改成 passed、删除协调器断言、修改运行中的冻结文件或将未开始的准备记为失败长稳。

2026-09-27 R4 联合 120 分钟的 3425.818–3430.819 秒区间新增 40 条入队失败；服务端记录 Redis AOF 2,000 ms 内未确认。上次故障窗口结束已超过 775 秒，门禁正确拒绝。进度文件在 validateInterval 之后更新，因此显示的 400 是最后合格区间累计；原始 load.log 最后区间为 440。先查原始日志和服务端时间线，不能凭摘要把失败计数遗漏，或静默在客户端重试正常窗口失败。两服务进程正常退出、Host 协作取消；没有 SOAK_FINAL、完整时长或排空/最终对账。事后 16 条 Outbox 仍待投递，只读快照不等于验收成功。

已确认本机 Docker 数据 VHD 在 F 盘 SATA HDD，D 为 NVMe。相同 Redis 镜像/AOF/内存配置的两个独立路径各做 90 批 40 条写入，同一连接执行 WAITAOF 1 0 2000，全部确认成功；HDD 最大等待约 1907 ms，NVMe bind 约 1100 ms。这是短路径对照，同时改变磁盘与文件系统路径，既未复现原超时，也不证明框架修复。原延迟采样关闭，不能根据事后 aof_delayed_fsync=0 宣称过去没有延迟；可靠确认超时的具体 I/O/调度原因仍须新记录确认。

正确后续是保留原失败，在新专用资源组验证可靠 Redis 的 NVMe 持久化路径，附加 Redis 延迟与容器/宿主 I/O 只读观察；确认门槛、AOF fsync、请求预算、负载和故障/一致性断言不变。不得改成 memory ACK、关闭 fsync、延长超时、扩大已结束的故障窗口、清理旧卷、迁移 Docker 全局目录或将旧路径短阶段通过冒充新环境资格。重新完整 30 分钟并复查，之后继续原七级；配置/环境变更和产品变更分开记录。

原失败审查与只读 SQL：`temp/v0.7-joint-review-r4-120m/`；原始导出：`dist/release/v0.7.0-rc.2-joint-bdDSFk/`；短对照：`temp/v0.7-aof-diagnostic/comparison.json`，脚本 `compare.mjs` 仅在独立目录首次执行、拒绝覆盖旧资源。后续 R5 用 `node temp/v0.7-joint-soak-r5/status.mjs` 读取进度，`observe-storage.mjs --once` 在启动前只读核对观察器；真实运行记录仍是最终判据。短探针结束后按完整容器身份停止，仅保留数据，不能把探针结果写成正式长稳通过。

### 长稳初始化失败与正式负载分开计量

2026-09-27 11:07，已修超时分类的新 Rust 客户端在并发预置 40 玩家时收到 StorageUnavailable，服务端日志为 PostgreSQL connection queue timed out after 2000ms; no SQL sent。发生在 SOAK_READY 前，既不是完整 30 分钟失败后的通过，也不是已进入正式负载的可用性错误。旧预置/预热函数直接传播暂时不可用，需在固定初始化期限内恢复；现在独立 `src/bin/fault_soak/seed.rs` 共用 90 秒绝对期限，写请求循环外构造，重试保持原 ID/完整载荷，永久错误或预热快照缺失立即失败，到期取消在途初始化。保留有限重试/恢复日志；不得增加服务端两秒或 SDK 五秒预算、把正式健康窗口的失败藏进预置、清理原数据或用短跑累计时长。

新增三条回归验证暂时/永久分类、过期不启动、在途取消及重试不续期；工具八条通过，Rust 工作区 207 通过/48 ignored，格式及 Clippy 通过，日志在 DBProxy `temp/v0.7-soak-seed-*`。首次测试模块位置被 Clippy 拒绝，移动测试模块至文件末尾后重跑，不用 allow 关闭检查；原 lint 失败另存。原运行 `temp/v0.7-joint-soak-r3/joint-fXDpZh/`、诊断 `temp/v0.7-joint-review-r3/failure-seed-review.json` 保留，Host/DB 都已回收，没有正式时长额度。剩余旧 Redis 索引不足重新跑七级时，创建新的专用资源组与独立分配记录，保留原卷，不能清库挤出空间。

### 重建验收程序与保留冻结服务端身份

首次辅助 Linux 构建成功跑完测试及编译，但附加的“新编译副产物必须与旧 Release 字节相同”断言失败，记录在 `temp/v0.7-soak-client-r2/build-report.json`。未改对应源码并不能直接推出新产物逐字节相同；本轮未定位所有链接字节差异，因此不能宣称可重现构建成立。后续辅助构建只导出修复后的验收客户端，单独记录源提交/源码 bundle/二进制 SHA；新编译的其他副产物明确 usedInSoak=false。实际参与长稳的 Host/DB 服务端继续使用旧冻结文件，严格核对其 SHA，不替换为哈希不同的副产物、不把旧失败改为通过。第二次重新执行构建与身份检查的报告为 `temp/v0.7-soak-client-r3/build-report.json`，候选 tag 和原基线报告均未改写。

加入预置修复后再次以 DBProxy `e9596d1` 的已核验源码 bundle 构建：Linux `cargo test --release --locked --bin dbproxy_fault_soak --bin dbproxy_relay_soak` 八条通过，`cargo build --release --locked --workspace --bins` 通过，报告为 `temp/v0.7-soak-client-r4/build-report.json`。实际负载客户端 SHA 为 `5d1a2b8afc8493e94920f38e18784f9e6eda7eeacbf5d433d9bc8a33025a8962`；冻结服务端与原业务 load 二进制仍逐字节检查，不把新编译副产物混入基线。58 文件追溯附件明确标记 soak-pending；逐项 ZIP 内容/SHA 与真实私密值排除检查通过，不能替代未完成长稳。版本化附件路径不能用 `Path.with_suffix('.zip')`，它会截去名称中最后一段版本；应在完整 basename 后追加 `.zip`，验证摘要后用已核定目录内的原生移动改正初次名称，禁止覆盖旧包。

### SDK 错误分类新增分支必须同步验收消费者

2026-09-27 10:54，联合 30 分钟在第五类 AOF 故障的暂停写入窗口收到“DBProxy request timed out before sending; no request was submitted”，`dbproxy_fault_soak` 将它输出为 SOAK_CONTRACT_ERROR，约 22 分 40 秒结束。真实原因是 0.7 SDK 的 `RequestBudget::timeout_error` 新增 RequestNotSentTimeout 后，验收客户端的暂时错误匹配只保留 RequestTimeout；SDK 遵守确定未发送的契约。`dbproxy_relay_soak` 同样漏分支。修复两个验收消费者并重新构建其 Rust 二进制，不改服务端、延长期限、重置幂等 ID、放行永久错误、删除 SOAK_CONTRACT_ERROR 门禁或改写本次失败。故障窗口外可用性错误与全部数据一致性断言继续成立。

先添加反例，旧实现的两个测试确实失败；修后 `cargo test --locked --bin dbproxy_fault_soak --bin dbproxy_relay_soak` 五条通过，`cargo test --workspace --locked` 204 通过/48 ignored（含 SDK 28），`cargo fmt --all -- --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings` 与 `npm run test:typescript` 29 条通过。DBProxy 日志为 `temp/v0.7-soak-budget-{red,green,workspace,fmt,clippy,typescript}.log` 和 `temp/v0.7-relay-budget-red.log`。原失败 `temp/v0.7-joint-soak-r2/joint-uOk7T5/` 已原样导出，诊断在 `temp/v0.7-joint-review-30-r2/failure-review.json`；Host/DB 服务正常退出，自有存储已恢复，未启动 60 分钟。清理后只读取证的 40 条积压与强杀前 SHA 相同，但故障窗口、最终验证及对账被中断，仍须使用新二进制、独立数据库重新完整跑 30 分钟，短跑不累加。

### 0.7 联合长稳的执行与证据边界

最新用户指令优先于自动递增计划：当前联合 30 分钟完整结束后，先审查真实故障恢复、数据及资源；有产品问题先修，再改控制器的计时与事件日志，复测后继续。检查点在 `temp/v0.7-joint-review-30-r2/`，保持正在运行的冻结胶囊。没有阶段停止 API 时，可以在前一级完整通过后，经容器完整身份和准备状态校验，协作取消刚初始化的下一阶段；要预先记录用户指令与取消意图，核对实际取消原因，保留原始失败证据，不把无关失败统称人为中止。复查、修复和再运行分别留证，不能在本级未结束前宣称产品没有问题。

2026-09-27 10:31 的实际进展：正常 30/60/120/240 分钟全部通过，240 分钟两端均连续超过 14400 秒且零错误，正常停止、资源趋势、维护排空及直接 SQL/Stream 对账完整通过。自动切换到 temp/v0.7-joint-soak-r2/joint-uOk7T5/ 联合 30 分钟，仍在运行；不能据启动或单个故障恢复宣称整轮通过。原总体 failed 对应随后新启动旧 480 分钟的主动取消，必须连同 handoff.json 的用户计划变更分类理解，既不抹掉原失败报告，也不误报已完成正常阶段失败。原四级证据与新联合阶段分别保存，不因更新状态重跑或改动已冻结工作负载。

2026-09-27 用户要求当前 240 分钟阶段完成后直接加入故障长稳，并同意从联合 30 分钟重新逐级递增。必须先确认当前阶段负载、正常停机、排空及直接对账全部通过，再切换独立冻结控制器；不得在运行中改原计划或用哈希不匹配强迫退出。没有阶段停止接口时，只取消随后新启动的旧 480 分钟尝试，保留原始失败报告及用户变更计划的独立分类，不把它记作产品通过或抹掉其他真实故障。联合 30 分钟完整验证五类故障并计为第一级，其后为 60/120/240/480/960/1440 分钟，前一级通过才继续；不重复另跑 30 分钟预检，不从 30 直接跳到 480，短跑不能相加替代最后一轮 24 小时。

故障窗口内也不能容忍已确认数据旧读、缺失、永久契约错误、重复经济效果、账本/Outbox 对账错误。只对明确故障及最多 180 秒恢复窗口中的可重试可用性错误放行；至少观察 60 秒无新增错误且三种写入重新成功，仍须最终排空和 SQL/事件 ID 对账。AOF 取证先固定所有写入者，读取强杀前后全部积压语义状态，再恢复写入，禁止用后来覆盖的最终值冒充崩溃存活证据；整个负载客户端保持运行。稳定 DB 节点全程不重启，其 RSS 趋势独立检查。当前新版 15 项控制器/证据反例、候选 SHA 和只读存储预检通过，不代表真实故障或 24 小时已通过；复测命令、范围与状态入口见[联合长稳计划](../design/v0.7-joint-soak.md)。

### PowerShell 进程身份时间戳保留时区

同轮更换待机监控首次报 PID reused，停止动作尚未执行；实际 PID/可执行文件/命令行相符，原因是 ConvertFrom-Json 将 ISO UTC 日期转成 DateTime，传给 DateTimeOffset.Parse 时隐式字符串失去时区，按本地时区二次解析后偏移八小时。正确做法为 ConvertFrom-Json -DateKind String 保留原 ISO 文本再解析，或直接在明确 UTC 类型上运算，不扩大两秒身份门槛、不去掉创建时间或改成按进程名停止。已同时修复新胶囊 activate.ps1 与 stop-owned-watcher.ps1；失败快照为 temp/v0.7-joint-soak-r2/activation-date-parse-failure.json。用相同实际监控元数据只读复测，时间差约 31/38 毫秒；随后 pwsh -NoProfile -File temp/v0.7-joint-soak-r2/activate.ps1 实际换接通过，旧待机进程停止，新进程 waiting-240m，原正常长稳与原证据观察器保持运行。重复接管会被现有状态拒绝，不为复测重复执行已完成的换接。

### 联合驱动的延时余量与事件字段

2026-09-27 首个节点故障恢复窗口实际通过后，`joint-uOk7T5/30m/db-driver.log` 记录 Node 对约负 0.000418 毫秒 delay 的警告：循环条件和 delay 参数分别取时钟，可能在两次取样之间越过期限，Node 将其钳制为 1 毫秒。`database/events.jsonl` 的 fault-passed 记录又因对象展开顺序把 ISO at 覆盖成计划秒数。两项属于控制器日志问题，业务错误计数为零，单调 start/actionCompleted/end/elapsedSeconds 和恢复断言继续成立；不在进行中的哈希冻结阶段修改文件或放宽门槛。后续控制器修订应对最终余量做非负钳制，事件时刻与计划偏移使用独立字段；以零/负余量和包含同名计划字段的事件做定向复测，再在新冻结版本运行。原始日志保留，当前没有宣称这些后续修订已经完成。

同日先完成 10:54 的真实失败诊断和验收客户端修复，再在新胶囊修订控制器：等待循环每轮只读取一次时钟，余量耗尽直接返回，期限边界仍调用取消检查；不传负值，不取消总时长要求。日志以独立 `scheduledAtSeconds` 保存计划偏移，保护 ISO `at`、事件名和实际 elapsed，不修改调用方对象。新增完成本级退出/对账后等待复查决定的入口，决定必须绑定运行身份及两端报告 SHA；取消或失败决定不记为通过。R4 的 policy/export/controller 共 22 项覆盖零/跨期余量、总时长、取消、字段覆盖、陈旧复查决定与原故障/对账反例，命令见联合文档。实际新 30 分钟仍须核对所有日志没有负/溢出 delay 警告且事件字段类型正确；只有独立复查通过才放行后一级，不能用脚本测试替代真实运行。

### 容器 PID 1 必须回收构建工具子进程

2026-09-27 Linux 清洁候选用 Node 控制器直接作为 PID 1，首次 check/quick 的多项命令正文通过，但外层报 exit 125 `command left descendant processes`。`/proc` 证明 53 个 git/esbuild 等进程为 Z、PPID=1，是控制器不回收被收养子进程造成的环境错误，不是把失败的进程回收门禁改成通过的理由。保存 `temp/v0.7-rc2-linux-clean-evidence/process-reaping.json` 与完整矩阵后，向自有 full runner 发 SIGINT，让在途用例清理、未执行项记 skipped。正确复测以 Docker `--init` 启动新专用空卷，开始前核对 PID 1，重新从相同 bundle 检出、npm ci 和 `verify:release`；保留原卷及失败日志，不按进程名杀用户程序、不禁用后代检查、不用缓存目录冒充清洁检出。新轮证据 `temp/v0.7-rc2-linux-clean-init-evidence/`，结果单独登记。

### 清洁目录的 System 声明必须重新生成

Examples 候选首次联机又发现 `registration mismatch`：模块清单改为 0.7.0-rc.1，而 MMORPG/Bench 的 Model `defineGameModule` 仍为 0.6.0-alpha.0。这是候选升版漏项，宿主拒绝行为正确。必须同步两份源码身份、完整构建并重启，再用 `npm run smoke -- --package mmorpg` 验证；不能关注册检查，也不能仅修改清单后把编译通过算作升级通过。原失败 `temp/v0.7-clean-mmorpg-smoke.log` 保留；修正后 `temp/v0.7-clean-mmorpg-registration-smoke.log` 记录真实登录/进图/退出、即时切换角色与正常停机通过。此轮还是准备目录；最终冻结 RC2 宿主的 Native 与三类消费方结果独立记录。

跨平台重建还要区分原始归档、解包载荷与文本换行：三个 npm 候选从 bundle 清洁重建后整个 tgz 哈希一致；VSIX ZIP 时间字段不同，Native 的 sourcemap 内嵌 `server.ts` 另有 CRLF/LF 差异，规范化该项后相同，运行 bundle 本身逐字节一致。不得把它写成两份 VSIX 原始哈希相同。Examples 的协议/配置清单含输入字节哈希，新增 `.gitattributes` 固定文本 LF，并在标准同级目录用正式生成器刷新声明和清单；不手改锁/哈希或拿原 worktree 名作为发行路径。证据 `temp/v0.7-clean-artifact-reproduction.json`，重新检出后应再生成并检查 Git 差异。

2026-09-27，正式候选依赖的清洁 MMORPG 构建在九处生成声明报 `tiangz.architecture.invalid-dependency`。生成器只转换普通 type import，漏掉签名中的 `import("#tiangz/module").T`；Hotfix 的模块别名被复制到 Model 后不再是合法入口。正确修法是在生成器按 AST 重定位自己的 import-type 至 Model public 相对路径，覆盖参数、返回值、泛型约束及访问器，保留普通字符串和其他依赖给既有检查。不能放宽依赖规则、手改生成物、打开 skipLibCheck 跳过声明检查或复用开发目录旧输出。

复测：`node --test tools/system_declarations.test.mjs`，然后在标准同级候选目录运行 `npm run build -- --package mmorpg`、`check`、`test:native` 和 `smoke`。首轮真实失败为 `temp/v0.7-clean-mmorpg-build.log`，针对性编译 RED 为 `temp/v0.7-inline-system-types-red-imports.log`；修复后三个生成器测试通过，真实模块重新生成后的依赖/类型检查通过，Native 与联机结果另记。初次新增夹具把同一访问器类型写成单双引号两种文本，先触发既有文本比较而未验证本缺陷；统一夹具引用后才取得正确 RED，原日志 `temp/v0.7-inline-system-types-red.log` 保留。生成检查通过不等于连续长稳或清洁冻结源验证完成。

### 0.7 依赖规则入口不一致

候选安装的进程完成也是依赖边界：一次 `npm install` 工具返回 session_id 后，检查过早启动，安装实际上运行了 26 秒。此时调用返回不能证明依赖已稳定；重叠的 final 命名日志也不能当最终证据。必须取得安装退出码 0，再运行依赖它的 quick/LSP，换新日志并对 npm 归档/安装内容逐字节核对。原安装和重叠报告保留，见[依赖方向](../design/v0.7-dependency-rules.md)。

去重也必须按实际检查文件：新增 `dist/v0.7-dependency-excluded-first.log` 反例为 0 错误而应有 1 错误。tsconfig 仅包含 Core 时，索引器仍发现被排除的 Model 深层导入；全局 Program checked 标志错误地禁止全部语法回退。改为返回实际文件集合，仅对这些文件去重，排除文件仍作可确定的 AST 检查。禁止为了修复扩大用户 tsconfig、把全部索引文件宣称已获类型证明，或只在完整夹具测试。

实际 CLI/LSP 首轮比纯规则多报 Stable 身份错误：TS 返回正斜杠 SourceFile 路径，Windows 预期值为反斜杠，直接字符串相等错误地拒绝合法导入。应使用平台路径身份比较，保留大小写/分隔符对照；不能删掉身份核对或仅扩展等待。原插件 `dist/v0.7-dependency-check-first.log` 保留，修复后需要重打候选、重装和实际 LSP 复跑，旧 npm/VSIX 结果不能复用。

新增模块边界反例初次实际返回 TS5097，原因是夹具相对导入携带 `.ts` 扩展，正式模块 tsconfig 在类型阶段先拒绝。应使用当前支持的无扩展导入，使类型合法后验证依赖方向；禁止放宽编译配置或把 TS 错误当作规则覆盖证据。原 `temp/v0.7-dependency-module-worker-first.log` 保留，复跑 `node --test tools/module_live_worker.test.mjs` 与实际安装 LSP。

Developer Tools 首轮依赖反例 5 项中 4 项失败（`dist/v0.7-dependency-rules-first.log`）：Model 仍可深入 Core，Core 通过 `#tiangz/model` 反向依赖，type-only/import-equals 未检查，相似启动文件未按 Stable 约束。宿主另有正则扫描和不同 AST 遍历，不能靠“都检查 imports”推断一致。现统一到 dependency ruleset 1，传入调用方 TS API/Program 与模块清单，仅保留精确启动、生成协议 ABI 和 System 增补例外。禁止宽泛忽略 generated/main、把错误降级或保留旧错误正例；动态目标 warning 不证明安全。旧 LSP 夹具的 Model 别名直接指向 Core，需补实际 Model 聚合文件而不是关闭 Stable 身份核对。复测纯规则、TS 5/6、模块 CLI/Host worker、实际安装 LSP、制品身份及宿主 quick，详见[依赖方向](../design/v0.7-dependency-rules.md)。

### 0.7 动态 Scene 任务的实际结束与 Timer 所有者

首次 `tests/unit/scene_task_disposal.test.ts` 两项均失败（`temp/v0.7-scene-task-disposal-first.log`）：动态 Scene 已注销，Scope 仍在途，但仅遍历路由表的 ProcessHost 错误报告排空；旧 Runtime 的任务 finally 还通过当前单例取消新 Runtime 的 Timer。Host 必须保留未完成 Scope 并在真实完成时主动移除，watchdog 取消绑定创建它的服务实例，销毁停止告警但不强制终止 Promise。禁止清空任务表、把 aborted 当完成、只在读取计数时清理引用，或用 TryGet 当前单例掩盖跨实例句柄错误。复测定向 `vitest run tests/unit/scene_task_disposal.test.ts`、正式生成的真实 V8 夹具及完整 `npm run verify`；范围和结果记入[Scene 任务销毁](../design/v0.7-scene-task-disposal.md)。

### 0.7 请求预算与部分写夹具（2026-09-26）

Host 任务现在从提交前起计时，涵盖任务排队、连接池和 SDK，并由调用方 RAII 持有；调用方取消请求 abort，不能留下脱离所有者的后台 I/O。删除 Host 的整池重试层，让 SDK 的单连接恢复保留原身份，Host 仅执行一次闭包。4 个所有权/期限测试通过，`temp/v0.7-host-budget-msvc.log`。第一次手动复跑再次出现 LNK1143，是只匹配 `CC=gcc` 而遗漏 工具链目录下的 `gcc.exe` 完整路径；过滤必须按 basename 匹配 gcc/g++，或直接使用已有正式矩阵环境过滤，不能只比较完整变量字符串。原失败 `temp/v0.7-host-budget.log` 保留；修正后重建，不调整测试期望。

原 Rust SDK 在拿到许可/写锁后才计时，重连后又得到完整预算；5 个受控 TCP 反例分别覆盖许可、写锁、排队后响应、重连锁和慢候选握手，原实现全部失败。逻辑 API 首次 poll 时创建同一单调期限，排队和全部自动尝试共用；过期且锁 ready 也不能再发包。许可/pending 用 RAII 释放，未发送与结果未知分开，原操作 ID/payload 不重建。DBProxy 证据为 `target/test-results/v0.7-budget-red.log` 和 `v0.7-budget-green-complete.log`（28 条客户端测试通过）。宿主尚未联调，不能把 SDK 单仓通过当作跨仓库通过。

部分写夹具最初用本机 TCP 的小发送/接收缓冲，但观测到帧头到达时写锁已释放，实际已进入等待响应；因此两个“应关闭半帧流”断言失败，不能据此宣称 RAII 有缺陷。修正为 64 字节 Tokio duplex，先读取帧头并确认仍持写锁，再执行取消/超时，严格检查截断、EOF 与写端不可复用。它验证同一通用写路径，真实 Socket 的慢写仍须另验；禁止删除断言、扩大生产 timeout 或把响应超时冒充部分写。原日志为 DBProxy `target/test-results/v0.7-write-budget-fixture.log`、`v0.7-write-budget-controlled.log`，复测 `cargo test --locked -p tiangz-dbproxy-client`。

### 0.7 首批运行时修复与构建环境（2026-09-25）

以下为运行时代码缺陷，不能通过调整测试期望掩盖：

- 异步 Actor/Component Timer 在途时，`CanCommitHotfix` 曾提前为 true。TimerSystem 在实际 Promise 完成前保留计数，并把到期、取消和销毁路径纳入排空；未来尚未触发的 Timer 不阻塞热更。不要因所有者被移除而清零，也不要超时后直接解锁有序 mailbox。
- Update 回调新建的零延迟 Timer 曾在同一轮执行。先快照本轮到期项，再逐项检查是否取消，保留“下一轮执行”和立即取消两个语义。重复周期计算也存在浮点边界：`28.003 + 10` 开始、更新到 `128.003` 时，差值商会得到 `8.999999999999998`；计算后必须保证期限推进，不能仅把测试时钟取整后宣布修好。
- RPC 请求赋值、编码、Actor 信封校验曾在 try/finally 外抛出，导致 ID 泄漏。所有 reserve 之后的操作都进入同一释放范围，失败后还要验证后续请求能复用 ID 并正确关联响应。
- DBProxy 多租户的共享 listener 不能默取首租户的并发限制。不同 `maxInFlightPerConnection` 必须在打开后端前拒绝，正反顺序均覆盖，诊断包含字段和安全租户标识，不包含凭据。
- Auto 首次 peek 收到 `G` 或 `GE` 时曾误判为 TCP。流握手现在由独立所有者消费并重放完整前缀，探测、HTTP 和内部认证共用 5000ms 墙钟期限；收到分片不能重置总预算。显式 TCP/WebSocket 和慢写期限仍属于后续 N 工作包。不要循环等待已可读但未消费的短前缀，也不能丢掉探测字节。

握手夹具初次还出现 `Junk after client request`：测试在收到 HTTP 101 之前发送了 WebSocket 数据帧，违反客户端握手顺序。修正夹具后，完整 GET 与显式 WebSocket 通过，仅 `G/ET` 和 `GE/T` 两项仍失败，才是本次框架缺陷证据。禁止放宽 Tungstenite 协议校验来迁就夹具。

Windows 首次 Rust 构建还暴露两项环境问题：Cargo 缓存与 target 跨盘时，V8 的 build.rs 尝试创建 `target/debug/gn_root` 符号链接，缺少权限导致错误 1314；可在确认该路径尚不存在后，为本工作树建立指向实际锁定 V8 源目录的目录联接，或选用与缓存同盘的独立 target。不要修改第三方 build.rs 或关闭真实链接检查。另一个失败为 `mimalloc` 对象的 LNK1143，原因是 MSVC 构建继承了 `CC=gcc` / `CXX=g++`；只在当前构建子进程清除这两个冲突值，使用已安装 MSVC。正式矩阵已有相同环境过滤，手动 cargo 复测也需遵守。目录联接不是新增 Rust 工具，也不应提交到仓库。

新 worktree 还需先运行 `npm run build:runtime:debug` 再执行含真实宿主步骤的 verify。`cargo test --bin TiangZ` 生成的是测试程序，不能证明 `target/debug/TiangZ.exe` 已存在；不得复制主线旧二进制来填补。首次模块宿主检查因此失败，补建后已单独通过真实启停和错误配置拒绝，完整矩阵结果仍以其最终报告为准。

首轮 full 的开发热更/故障矩阵还有 `RUST_LOG=warn` 环境污染：测试依赖 `tiangz::hotfix` 的 INFO 完成/暂停事件，日志被过滤后，开发测试误报 reload 超时；故障驱动不释放远程请求，宿主在 2900ms 排空期限后正确恢复旧版。隔离测试的子进程现在显式使用 `warn,tiangz::hotfix=info`，不改变调用终端或宿主日志默认值。禁止放宽 3000ms 热更窗口或提前解除在途计数来迁就驱动；保留原 `temp/hotfix-load-Masa3B/fault-report.json` 及 main.log，再复跑 `test:hotfix-faults`、`test:game-project-dev`。

定向复测入口为 `vitest run tests/unit/hotfix_timer_drain.test.ts tests/unit/timer_system.test.ts tests/unit/scene_call_cleanup.test.ts`、Rust 的 `transport_backend::handshake::tests` 和 DBProxy `tenant_config_tests`/`tenancy`。修复后的完整 `npm run verify` 已在 2026-09-26 通过；完整命令、首轮失败和最终报告集中记录在[首批验收记录](../design/v0.7-batch1-acceptance.md)。Windows 链接仍有已有 LNK4098 告警，不能称为零告警构建；环境失败不能算行为测试失败或通过，修正环境后必须真实重跑。

### 0.7 worktree 依赖准备与中止结果（2026-09-25）

现象：新 worktree 执行 `npm ci --ignore-scripts` 后，codegen/检查找不到 `@tiangz/native-language-core`、`@tiangz/developer-tools-core` 和 `@tiangz/dbproxy-sdk` 的声明或 dist 入口；生成中止又导致后续 Generated 目录缺失。真实原因是 Git 依赖的 prepare 构建被跳过，属于依赖准备失败，不是 EntryScene 拆分导致的运行时缺陷。

正确做法：按锁执行正常 `npm ci --no-audit --no-fund`，确认依赖入口可解析，再执行 `npm run codegen` 和对应验证。禁止从另一 worktree 复制旧 dist/Generated、修改类型为 any 或放宽检查来掩盖缺包。重装后依赖入口及部分检查恢复，但完整 quick 随用户要求停止讨论外的实现而中止；不得把部分通过汇总为整轮成功。

复测：实施恢复后，在目标工作树依次执行正常依赖安装、正式 codegen、`npm run verify:quick`；按改动范围补完整集成验收。前置本机证据为 `dist/test-results/check-initial-dependency-failure.json` 与 `temp/verify-quick-refactor.log`（未提交的运行记录），新报告须记录中止/失败/跳过状态，不能用旧报告替代当前制品验证。

2026-09-17 90分钟验收首次启动run-MeA1nL失败：夹具把主endpoint重复放入endpoints（failoverEndpoints旧别名），宿主在连接前正确拒绝；尚未进入业务或计时。修复为endpoint=A、failoverEndpoints=[B]，不放宽运行时校验。原报告和卷保留，隔离容器已停止。配置/源码改变后经正式build/check再开新报告，不能覆盖旧失败或手改构建哈希。


### SLG热更候选必须验证实际变化（2026-09-17）

同轮夹具完善：出站深度已通过EntryScene.metricsSnapshot的outbound_lanes自定义gauge导出，仅搜索固定Prometheus名字会误判缺接口。正确做法是按metric name与name/key标签取值，缺指标明确失败，不能按零处理或直接增设Core观测。隔离Model可通过现有metricsSnapshot扩展只读业务计数。H5d用冻结的不可配置方法槽让最后一个方法安装失败，验证真实prototype回滚路径和后续合法发布，不注入配置交换后的任意副作用。

回滚目标取上一活动配对：连续P21→P12→P22后的回滚是P12，不是P11；固定10次序列和断言已同步。纯SDK回归中50毫秒轮询与50毫秒超时相撞属于测试时序错误，改用独立500毫秒测试预算；验收F3仍为1800毫秒客户端、5秒DB、3秒热更，不能放宽生产超时掩盖失败。18项工具测试、SLG检查、正式候选构建以及vitest run tests/legacy/hotfix_system_self_test.test.ts通过；真实PG/Redis和90分钟演练尚未执行。


隔离夹具构建时出现两类失败：协议增加必填响应字段后，候选业务实现未同时补字段或恢复时遗留字段，会被类型检查拒绝；Luban int改long在当前TS输出中可能仍是同一schema。二者属于夹具问题，不能据此宣称运行时拒绝不兼容包。

正确做法：只修改复制的源文件，用正式生成器更新候选协议和锁，同步业务响应类型；每个配置变体显式执行Luban生成，恢复基线后再生成/检查。使用新增配置字段制造真正schema变化，并比较moduleConfigsJson内模块schemaFingerprint，而非宿主gameConfigSchemaFingerprint。禁止手改生成物、跳过类型检查或仅凭源文件不同就宣称负向注入有效。

业务配置负值通过现有gameConfig.validator由冻结Model验证，不必新增Core接口。客户端未知结果必须扣游戏响应；若扣DB ACK会让服务器仍在途，成功回滚的前提不成立。暂停/超时证据从真实pauseStart开始；错过自然任务/分钟边界记not-effective，不能修改存档或机器时钟凑命中。

复测在Examples/packages/slg执行npm run test:acceptance -- build-hotfix、npm run test:acceptance-tools及npm run check；前者只构建隔离候选，后两者不启动故障服务。smoke30运行仍需隔离故障验收授权。构建/纯工具检查不能替代真实PG/Redis、回滚重启和30分钟结果；完整覆盖缺项见[SLG验收文档](../../../TiangZ-Examples/packages/slg/docs/authoritative-read-acceptance.md)。


### SLG驻留、前台恢复与模块边界（2026-09-17）

驻留命中复用已确认内存，不因客户端重连就重读PG；冷加载、后台任务加载、启动扫描单独计量。不读库不等于不写库。按任务截止时间登记方法名Timer，回收玩家缓存不能连任务一并丢弃。前台全量当前状态恢复与服务端保活是两个独立约定；保留原未确认操作，回执序号及指纹匹配后才能清除，旧连接回调不可覆盖新代次。

提交确认后才发布内存。并行化后只发布受影响记录，玩家单记录提交不能拿旧世界快照覆盖别的玩家刚确认的地图；世界事务未知时保留地图协调权，无关玩家操作可独立执行。独立操作回执和可覆盖状态/战报分开；当前SLG只保存最新回执，不承诺任意历史事件补发。

本轮两次构建失败：Model引入声明根之外的JSON触发边界检查；领域字段timers与Component私有字段冲突。正确做法是将稳定配置放入modelRoots并使用playerTimers等领域字段，禁止放宽引擎检查。fake基类单测可能漏掉这些问题，必须再跑模块check/build。复测命令、29条测试与无数据库WebSocket验证、未验收边界见[SLG驻留说明](../../../TiangZ-Examples/packages/slg/docs/player-residency-and-foreground.md)。以下旧记录中的SLG逐请求Load属于改造前基线。

离线恢复正确性：保活原Actor复用不重读角色快照；MMORPG最终下线必须等待同步SaveMulti确认后才删除Location和角色索引。DBProxy的authoritativeReadNamespaces是部署级精确匹配，混合批次整批单语句读PG，不等于所有Load默认强一致，也不会等待Enqueue队列。PG错误不可转换为None或退回旧缓存。所有failover节点须一致启用；旧二进制拒绝新配置。SLG当前Demo持久模式逐请求Load，不能假定其已有保活内存Actor。实现、失败类型修正及复测见[权威恢复读取](../../../TiangZ-DBProxy/docs/authoritative-recovery-reads.md)。

数据库容量必须绑定配置与负载：先测低并发到饱和点，结合吞吐/尾延迟选工作区间并给后台任务留余量，不以过载尾延迟比较数据库。登录到达量、角色在途数、PG活动连接和连接上限分别记录；多个DBProxy实例的预算必须求和。操作方法、工具编译失败教训及完整登录验收边界见[登录容量测量](../../../TiangZ-DBProxy/docs/login-capacity-method.md)。现有map_probe_load在登录准备后才开始统计，禁止把它的业务RPC耗时写成登录耗时。

登录性能测量：先验证保活角色复用Server内存，按角色快照load计数区分冷加载，不把所有重新登录计入Redis/PG压力。[首轮测量](../../../TiangZ-DBProxy/docs/login-storage-comparison-20260917.md)仅覆盖存储阶段。PG初始化超时是环境准备失败，不能计入查询延迟；小表Seq Scan诊断不能直接外推为生产查询计划。禁止用内存查表微基准冒充完整重连耗时。

最新实证：[缓存写超时旧读复现](../../../TiangZ-DBProxy/docs/old-cache-reproduction-20260917.md)。16/16复现，PG均已保存新版本；根因路径是缓存同步best-effort与无版本校验命中组合。缩短repair周期、延长超时或本机dirty标记不能保证跨节点正确；PG提交后不得把缓存失败解释成确定未提交。复测命令、停止状态和未覆盖项见报告。

七日旧读与复测：见[分析基线](external-7d-analysis-baseline-20260917.md)和[三组复测清单](../../../TiangZ-Examples/tools/chaos/retest-7d-findings.md)。已确认缓存写超时后仍ACK、读命中旧缓存的风险路径；尚未完成受控实跑和服务修复。DBProxy最终客户端状态检查与运行期一致性必须分开报告；工具不得因最终恢复清零旧读。Relay最终读取应分页，并保留脱敏退出诊断；不能用分段成功替代完整核验。复测命令和当前未验证边界以清单为准。

### SLG隔离恢复夹具：PG健康检查过早

修复后真实验收已完成：两轮7项业务恢复矩阵通过，每轮8次强杀；最终经统一slg入口运行，报告run-iaAz8o，控制器哈希与最终源码一致。构建、15条玩法测试和9条入口/控制器测试通过。完整证据边界见SLG恢复测试文档；不能据此标记三组联合演练或长稳已通过。

同轮第二个夹具问题：显式runtime-root只复制dist而遗漏configs，宿主正确拒绝（run-FygS2j）。修正夹具目录布局，不绕过宿主检查；清理代理必须在独立finally路径执行，不能因游戏已退出而跳过监听关闭。

2026-09-17：首次新建环境DBProxy报PG ConnectionRefused，目录 Examples/packages/slg/temp/recovery/run-0zuOOr。原因是pg_isready默认检查Unix socket，误将initdb临时服务视作最终TCP就绪；改为 `pg_isready -h 127.0.0.1`，不能仅加固定睡眠或放宽失败判定。脚本语法检查也必须先于容器创建。经授权在SLG包执行 `npm run test:recovery -- run --confirm isolated-slg-crash-test` 复测，逐项SQL对账与report判断，见[隔离范围与步骤](../../../TiangZ-Examples/packages/slg/docs/recovery-test.md)。该组不替代DBProxy故障、热更或长稳。

开发前按 [AI 技能开发约束](skill-development-contract.md) 检查适用规则；它是技能与项目文档的路由入口，不代替确定性插件检查或本文的失败案例。具体玩法数值和 Demo 简化不能变成通用框架规则。

维护或换机安装 Codex/Claude/Cindy 技能按 [三端交付说明](assistant-packages.md) 执行；改 tools/ai-assistants 源码后生成并检查，不继续修改上层旧 plugins 副本，也不把改源码当成安装成功。工作区目录、便携包与 Cindy 实际工具输出分别验证。

### 2026-09-17：宿主桥存在不等于数据库已配置

SLG 首次玩法 smoke（临时目录 tiangz-slg-smoke-Lipipu）报 `DBProxy is not configured for this Process`：夹具刻意删除数据库配置，但业务把 IsHostDbProxyAvailable 当成持久模式开关。该能力只代表桥已安装，不承诺配置或连通性。正确做法是读取进程 persistence.dbProxy 决定是否使用持久存储；有配置时存储失败必须暴露，禁止 catch 后悄悄改用内存或创建初始资产。修复后在 Examples/packages/slg 依次执行 `npm.cmd run test:gameplay`、`npm.cmd run build`、`npm.cmd run smoke`：15 条规则/假存储契约测试和内存模式真实 RPC 通过。假存储与内存 smoke 不代表真实数据库强杀恢复已验收，完整范围和接续入口见[基础玩法说明](../../../TiangZ-Examples/packages/slg/docs/gameplay-demo.md)。

三类可靠性测试的统一代码入口已整理到同级Examples：`npm run reliability`只读计划，`build/check/run --suite hotfix|dbproxy|game|all`分别负责构建、制品检查和显式演练。先读[操作与隔离说明](../../../TiangZ-Examples/tools/chaos/README.md)。修复迁移遗留的旧宿主/SDK路径、审计目录和未覆盖全部故障仍可能通过的问题；新增Gate及整组进程强杀。用户要求本轮整理后暂停，当前只做静态/纯工具验证，正式联合测试等指令。不要直接运行legacy入口，也不要把game组“故障阶段不停DB”误解为prepare不清理演练存储。

本节是换机或AI上下文丢失后的续接入口。以后遇到可复用的失败，必须同轮记录到本手册或链接的专题文档，并在`project-context.md`补充入口；不能只在聊天中解释。每项写清**现象 → 根因/分类 → 正确做法 → 禁止绕过 → 复测命令 → 证据与未验证边界**。未确定根因时标注待证，不把猜测变成规则。临时报告通常不随Git迁移，长期结论、命令和关键证据摘要必须保存在版本化Markdown中。

### 2026-09-17：客户端协议误用于进程间调用

- **现象**：热更双进程夹具用外部C协议发Inner RPC，被`validate_frame_access`拒绝；失败现场`temp/hotfix-load-fhTzKV`。
- **原因/分类**：测试夹具错误。descriptor携带协议身份，不只是payload形状；将客户端descriptor传给`scene.scenes.call`不会把它转换为内部协议。`audience: mixed`也不等于取消逐帧内外网访问校验。
- **正确做法**：客户端入口使用模块`Starter_C_40000.proto`生成的`StarterProtocol.Increment`；服务间调用另声明`Starter_S_22000.proto`的`S2S_Work/S2S_WorkResponse`，使用生成的`StarterProtocol.Work`。这是本轮夹具名称，其他模块使用自己的命名及生成锁，不照抄编号。
- **调用形状**：`scene.scenes.call(scene.scenes.byName("worker"), StarterProtocol.Work, { mode: 1 }, { timeoutMs: 30000 })`。业务处理可以复用领域方法，但外部和内部协议身份不能混用。协议新增后显式执行`node tools/game_project.mjs protocol-update --project <游戏工程路径>`，随后`build`并重启测试进程；脚本夹具已自动做这些步骤。
- **禁止绕过**：不手写opcode/codec，不改生成物，不删除或放宽访问校验，不因payload一致就共用客户端协议做内部RPC。
- **复测**：`node tools/hotfix_fault_matrix.mjs --rounds 1`，核对跨进程响应、暂停后完成通知及内部队列满后的恢复。仅本地同进程调用通过不足以证明跨进程正确。

### 其他必须保留的失败教训

| 现象与分类 | 根因及正确处理 | 防止再次误判 |
| --- | --- | --- |
| 断一次DB连接却没有业务报错；夹具预期错误，`hotfix-load-QrUOy5` | SDK会有界重连/重试。分别测试单次断连恢复、持续不可达明确失败、已提交写丢ACK后原ID重试 | 不关闭重试来迎合测试，不将成功/失败都算通过；丢ACK检查持久revision=1且重启不重复 |
| `/ready`已成功但连接指标不存在；夹具时序错误，`hotfix-load-bjX7wm` | 健康启动与指标快照发布不是同一时刻；有界等待初始连接数达到预期，再取基线 | 不能删除连接数断言，不能拿睡几秒当作就绪契约 |
| 非法TCP帧后连接不关闭；真实宿主缺陷，`hotfix-load-7VPROC`/`hotfix-load-VAWhXd` | 读循环`?`跳过统一清理；TCP/WebSocket先清理writer、通知断线并回收发送任务，再传播错误 | 坏连接及时终止；正常关闭保留消息排空。必须重建Rust并复测8条坏连接及正常请求 |
| 改了Rust但沿用旧长稳结论；证据风险 | 脚本可复用已有宿主，存在二进制不等于代码最新；先构建，记录报告`binarySha256` | 不能把旧版一小时通过算给新版；完整verify可能再次构建，最终制品变化后重跑针对性验收 |
| Windows构建受全局GCC变量或PowerShell策略影响；环境问题 | MSVC构建前检查`CC/CXX`，仅在当前会话清除错误的GCC覆盖；使用`npm.cmd` | 不更改全机工具链/执行策略来跑测试；原有LNK4098警告要披露，不伪称零警告 |
| 向`model.js`注入探针后宿主报`Hotfix/config release identity mismatch`；夹具错误，写法长稳首次smoke（2026-09-19） | 原子发布后`releaseId`绑定`modelFingerprint`等字段。注入后除重写指纹外，还要用`tools/atomic_release_identity.mjs`的`atomicReleaseId`重算`releaseId`及`bundleVersion`后缀 | 不关闭或绕过宿主身份校验。`module_dbproxy_migration_self_test.mjs`曾同时带有此问题和下一行问题（SLG的`dbproxy:smoke`会调用它）：2026-09-19对自有内存DBProxy逐一复现两个错误后已修正，迁移断言（值11、revision 2、旧写入者被拒）不变；复测需自起隔离DBProxy后运行`node tools/module_dbproxy_migration_self_test.mjs --endpoint <回环地址>`，禁止指向共享库 |
| 注入探针后报`unknown scene type ...; registered:`为空；夹具错误，同上 | 模块化后主工程`dist`不含游戏模块，没有场景类型。按`global_id_runtime_self_test.mjs`用`create_game_module/prepare_game_modules/build_runtime_bundles/build_game_config_data`构建夹具模块，再用`--runtime-root`启动 | 不借用MMORPG场景，也不往Core加测试场景；夹具由当前源码现场构建，不复用旧`dist` |
| 解析探针`console.log`输出一直超时；夹具错误，同上 | `console.log`经宿主日志层输出，前有时间戳和颜色码、后有属性，不在行首。按标记定位后做括号/字符串感知解析 | 不要为测试更改宿主日志格式；主动停止探针时宿主取消在途操作产生的`fatal`属预期，只在非主动停止时判失败 |
| 写法长稳前两次`run`在可靠Redis故障后排队写始终不恢复；产品容量问题，`write-modes-run-2026-09-19T06-45-28-717Z`、`07-21-13-224Z` | 单条Enqueue在每个DBProxy节点只有一条入队连接，持锁等待`everysec`的`WAITAOF`：空闲时平均约0.5秒，满载时约1次/秒/节点。请求超5秒后TS仓库重试3次、宿主客户端再重发1次（最多6倍），服务端仍执行已放弃的请求。节点指标显示故障后入队平均排队45–60秒、单节点连接累计1541次，但只有Redis停机期间的3次真正报错。平时只用约三分之一容量，35秒停机后的积压经放大仍超过容量，形成自我维持的过载。用新客户端且被杀时空闲的定向复现可恢复，说明服务端本身能重连 | 不能加大客户端超时或减少故障来掩盖。正确性长稳按最坏6倍放大计算排队写负载（间隔max(40秒,玩家数×9秒)），第三次`run`据此通过。之后经用户同意已实施：DBProxy入队组提交＋排队上限4096＋2秒排队期限，TiangZ排队写仓库不再重试；第四次`run`在原负载下通过 |
| 写法长稳AOF故障的“已确认排队写存活”核对是弱证据；自查发现（2026-09-19），第四次`run`的“80次全部落库”结论因此降级 | 核对用最终值对比强杀前快照，但探针持续写同一记录，后续更大的值必然满足“不低于快照”，即使强杀丢了确认也发现不了 | 改为Redis一应答就直接读恢复出的积压逐个核对，排除重启后新写入的条目（masked），缺失/低于要求即失败、零核对也失败。凡是“最终值不低于某时刻确认值”的核对，都要先确认之后的写入不会把丢失掩盖掉 |
| 写法长稳memory档位最终读取每个玩家排队值落后1–2个确认；`write-modes-run-2026-09-19T13-31-41-742Z` | DBProxy积压：落库中的记录再入队会回到pending，两个节点的worker可并发领取同一记录；PG拥塞时旧值的无条件写入后到，覆盖新值。aof档位负载低，之前没触发 | DBProxy `4bdde13`：领取跳过仍有有效租约的记录。以前的通过不能证明没有并发类缺陷；提高负载（memory档位约6倍排队写）才暴露 |
| 写法长稳memory档位AOF核对20个玩家全判masked；`write-modes-run-2026-09-19T13-22-09-909Z` | 控制器账本靠解析探针日志更新，高频时滞后，强杀时取的已尝试值偏旧 | 在Redis重启前再取已尝试值。依赖账本快照的核对要考虑日志解析滞后 |
| 500玩家过夜长稳第8轮在dbproxy-all后业务恢复超时；夹具问题，`write-modes-run-2026-09-19T17-03-32-149Z` | 探针出错退避固定30秒，全部DBProxy节点重启后数百玩家同时重试，反复压满每节点8条PG连接（2秒连接排队后快速失败），4个玩家连续失败凑不齐两次确认。失败时直接查PG，普通写与钱包全部一致 | 退避加50%–150%抖动。TiangZ业务仓库本来就是随机退避；写负载探针也必须如此。DBProxy的2秒快速失败是设计行为，不要靠加大超时掩盖 |
| 500玩家时探针恢复读取约2分钟、接近3分钟就绪上限；AOF核对把500个键放进一条redis-cli命令触发Windows命令行长度上限（2026-09-20） | 恢复读取逐个玩家串行；核对键在命令行传递 | 恢复读取按玩家并发（降到4秒），键改在Redis脚本内按`RedisSnapshotBacklog::member`规则生成。规模参数变化时要重算每一处的串行耗时与命令行长度 |
| 执行`core-api:update-lock`后锁里出现无关声明变化；证据风险，同上 | HEAD锁自`a16344c`/`1da8f58`起已落后源码（`GlobalIdConfig`、`GlobalIdSystem`、`EntryScene`、`Game`、`HotfixSystem`）。开发期`verify:core-api`跳过锁比对，锁在发布前统一更新 | 功能改动不要顺手吸收他人漂移；先确认漂移来源，发布时连同说明一次评审 |

上述错误的修正不得降低安全断言。预期拒绝/断线属于故障测试的一部分；必须验证拒绝原因、generation不变、恢复后请求仅执行一次，而不是要求所有故障路径都返回成功。

### 换机后的测试步骤

以下命令在TiangZ主工程根目录运行，Windows示例使用PowerShell。准备仓库依赖、Rust/MSVC和Node环境；首次机器按项目安装流程执行`npm.cmd ci`。这些是复跑说明，不是授权自动启动长稳或操作数据库。

1. 先读`AGENTS.md`、本节及[故障验收记录](../design/hotfix-fault-acceptance-20260917.md)，检查`git status --short`并保留已有修改。确认测试只操作自己创建的进程、回环端口和唯一测试namespace。
2. 构建当前源码：`npm.cmd run build`，再`cargo build --bin TiangZ`；每步退出0才继续。本轮夹具不含Native扩展，使用普通宿主；真实Native模块工程应走自己的组合宿主构建，不能拿普通宿主替代。不要与同工作区其他codegen/build并行。
3. 最小故障复现/回归：`node tools/hotfix_fault_matrix.mjs --rounds 1`。脚本生成独立工程、C/S协议、Luban配对及SDK，启动双进程和500连接；确认坏帧关闭、跨进程排空、队列满、断线、双边暂停超时和停机恢复。
4. 扩大无DB覆盖：`npm.cmd run test:hotfix-faults`（默认3轮）；需要更多重复时使用`node tools/hotfix_fault_matrix.mjs --rounds 20`。失败先定位夹具/环境/框架，保留失败报告，不只重跑直到偶然成功。
5. 生命周期/热更变更执行完整`npm.cmd run verify`。读取`dist/test-results/full.json`，所有子项成功才算整套通过；保留跳过项目和警告。该文件会被后续运行覆盖，及时把时间、结果、失败原因记入本轮验收文档。
6. 已获负载测试授权后，在最终二进制上执行：`node tools/hotfix_load_soak.mjs --seconds 180 --clients 500 --reload-seconds 6 --rpc-timeout-ms 30000`。本轮是3分钟、30次切换，含负载中错误候选、排空超时和最终联合回滚；不是一小时或24小时长稳。
7. 仅在用户授权且确认是本机测试DB后执行真实DB矩阵：`node tools/hotfix_fault_matrix.mjs --rounds 20 --dbproxy-endpoint 127.0.0.1:18700 --dbproxy-env-file ../TiangZ-Examples/packages/slg/infra/dbproxy/.env`。端口/文件以换机环境为准；不输出令牌，不重启既有容器、不清库。代理只延迟/断开本轮连接，保留独立测试记录。
8. 对照步骤6/7报告的`binarySha256`确认最终制品一致；不一致则说明原因并对最终制品重跑。检查自有进程退出0、没有强杀/遗留，写入文档后再交接。24小时测试需用户另行安排，不默认启动。

**如何判读**：负载报告为控制台输出路径的`report.json`；故障最终结论为`fault-report.json`，旁边`report.json`的`prepared`仅说明夹具生成完成。负载要求请求/响应一致、RPC错误/重复/混搭为0；故障矩阵要求预期失败原因正确、正常响应序号无缺失无重复、旧/新配对正确、所有进程正常退出。核对日志`main.log`、`worker.log`、重启日志或`server.log`。故障场景整段耗时含准备/恢复，不能直接当作暂停时长；`pauseMs`、RPC耗时和30秒RPC超时是不同指标。

可长期迁移的证据摘要见[2026-09-17验收](../design/hotfix-fault-acceptance-20260917.md)。临时目录不存在时按上述步骤重新生成，不将“找不到旧报告”写成测试失败，也不声称已复核旧现场。

热更故障回归使用 `npm run test:hotfix-faults`，默认双进程且不依赖DB；真实DB只在显式选择本机测试端点后注入故障，严禁隐式重启容器或清库。独立测试namespace保留用于复查，详见[复跑与判定](../design/hotfix-fault-acceptance-20260917.md)。24小时测试暂缓，等待用户另行安排。

网络生命周期回归新增非法TCP/WebSocket帧：读取/校验错误也必须清理writer并通知断线，不能因提前返回遗留发送任务；坏连接中止发送，正常关闭仍排空。此Rust修复必须重建并重启，先跑故障矩阵再完整verify，不能沿用旧二进制长稳结论。

本轮主动暂停与代码/配置联合加载的使用前提、测试条件及换机复测命令见[验收记录](../design/hotfix-pause-acceptance-20260917.md)。24小时验收需另行确认启动。

热更主动暂停默认 `process.lifecycle.hotfixReloadTimeoutMs: 3000`：独立预检后暂停新请求、Timer和固定帧触发，排空完成后帧间提交Hotfix/config整套；超时或内部请求暂存满恢复旧版本。RPC结果返回继续走，已有任务不得await时间；客户端超时不是服务端取消，业务仍需幂等。重建Rust/Model并重启后使用，显式配置优先。换机先 `npm run verify`，再按热更设计运行 `tools/hotfix_load_soak.mjs`；测试报告与是否满足24小时验收条件必须单独记录。

2026-09-17 新手延迟业务入口：按[延迟业务开发范式](../patterns/timer-update-and-action.md#延迟业务开发范式)拆成开始、到期、取消与恢复。插件错误处 `Ctrl+.` 可查看离线指南或生成 TypeScript 草稿；先选所有者，再将字段放 Model、方法合入已有 Hotfix System，手工完成幂等结算/持久恢复。草稿不修改原代码，新增稳定形状仍需 codegen/完整构建和重启；文档变动须同步插件 `extension/guides/`。

2026-09-17：**游戏业务禁止 await 时间，所有延迟、倒计时、到期、周期事件必须走所有者定时器。** `sleep/delay/TimerSystem.WaitAsync`、原生计时器、Promise 包装和 `.then` 变体都不能替代 `NewOnceTimer/NewRepeatedTimer` 方法名回调；短延迟与零延迟没有例外。Model 保存状态/截止时间，Hotfix 实现到期方法。数据库、RPC、锁的异步结果仍可 await。编辑器与模块构建以 `tiangz.timer.time-wait-forbidden` 报错，完整示例和迁移说明见[时间调度硬约束](../patterns/timer-update-and-action.md)。

> 2026-09-17：Hotfix 与 Luban 配置改为完整配对发布、帧间原子提交。`build:hotfix` / `build:game-config` 均输出联合候选；`reload` 和本机 `hotfix plan/apply/status/rollback` 操作整套，`reload-config` 仅作联合加载别名。Hotfix manifest 包含 gameConfigHash/releaseId，配置单改也改变 bundleVersion。现有 pendingAsync/pendingIngress 安全条件保留；等待期间仍推进主循环。Model/schema/冷数据变化仍重启，客户端和持久业务状态不随发布回滚。旧的两条独立在线切换说明已被取代；首次使用须重建宿主与 Model 并重启。详细流程以 docs/design/typescript-hot-reload.md 的联合发布章节为准。

交付脚本在 Examples/packages/slg 执行 npm run delivery -- check|local|container；--plan 只打印，--ci 要求三仓库已提交且干净。首次换机先准备同级 TiangZ/Examples/DBProxy、宿主 npm ci、battle:build，容器流程先显式 battle:k8s:setup。保持同工作区单流水线，不并行手工 codegen/build。故障保留本轮目录，通过报告指定 BATTLE_LAB_STATE_DIR 检查/受控清理；不使用默认集群。详细交接和未实现项以该包 docs/delivery-handoff.md 为准。

战斗发布与版本路由在 Examples/packages/slg 执行 battle:test → battle:build → battle:verify。区服调用统一管理器，提交 realmId/battleId/logicVersion/configVersion，不配置战斗池绑定；查询携带相同区服与战斗编号。版本来自制品 Model，proto/SDK 走正式生成器，旧请求不自动补版本。混合版本调度单测不等于混合制品 K8s 实跑；当前 realmId 仅为可信实验标签，正式服务必须绑定认证身份。架构与限制见该包 docs/battle-release-routing.md，不能把案例抽成 Core 战斗规则。

本地案例通过后，容器部署练习使用 Examples/packages/slg 的 battle:k8s:setup、battle:k8s:image，以及 battle:k8s -- up/status/verify/scale 2|3/down，详见 validation/battle/k8s/README.md。只操作独立 kubeconfig 和自有实验命名空间；缩容先由业务确认排空，再修改副本数，preStop 不能保证无限等待。不得直接复制内存管理器作为高可用，也不将本地 Pod 编号作为持久身份方案。Model/注册协议变化已要求重建，真实验收状态单独报告。

验证 Rust 后台工作与本地扩缩容可在 Examples/packages/slg 执行 battle:build / battle:verify。案例使用正式脚手架、Native/协议生成器；内部 RPC 与客户端协议分离，不绕过传输访问校验。任务状态属于模块 Component，通用本地控制器只管理自己创建的资源。超时不等于可重算，案例只标 unknown；持久幂等结算和故障恢复仍未实现。先本地验证，之后再讨论 Kubernetes。

需要 Rust 扩展壳时，在 project:create 或 modules:create 后追加 --with-rust。先读生成的 RUST.md：native/*.native、rust/src/native_data.rs 和 TS NativeExample 为手写输入，generated 目录不可手改。新工程使用 setup → host-build → build → smoke；check 包含 Rust 编译检查。dev 自动监听尚不支持 Native，不能用 TS 热更替代 Rust 重编译重启。此壳没有游戏业务或持久状态。

持久 ID 仍通过 GlobalIdSystem.Instance.Next() 取得，恢复/合服不重新发号。需要跨重启唯一性时部署显式选择 identity.allocation=dbproxy，由宿主在 Scene 构造前领取持久号段；没有号段时同步失败，不回退旧算法。模块不直接写高水位，不把 OriginServerId 用于当前路由。省略 allocation 仅保留有告警的旧开发模式；完整构建重启与恢复限制见[ID 号段](../design/global-id-ranges.md)。

租户由部署凭据映射到 DBProxy 后端，业务请求不自报租户。originServerId/GlobalId 是永久身份，realmId 是可迁移归属。合服目录与请求使用格式 v2；模块用独立纯 JSON 策略声明自己的领域动作，显式 --policy 传给只读计划工具。宿主不认识城池、地块或补偿，声明通过不等于策略可执行；见 [租户与区服边界](../design/tenant-realm-foundation.md)。

示例开发先选 Examples 中的包：packages/slg 或 packages/mmorpg。在 Examples 根用 npm run build -- --package slg（check/start/smoke 同理）；不要扫描整个 Examples 作为模块目录。包入口清单 tiangz.example.json 与业务模块清单 tiangz.module.json 分工不同。SLG 的 Cocos 工程是 packages/slg/client/cocos，MMORPG 的共享客户端仍在根 clients。

新游戏从引擎 project:create 创建独立工程，按生成 README 使用 doctor/build/smoke/dev；不在引擎 app 目录新增游戏。MMORPG 示例在同级 TiangZ-Examples/modules/mmorpg，ModuleGame 与 WoW335 通过显式直接依赖复用它，SLG 无需安装它。

阅读顺序：tiangz.module.json → src/model/index.ts 与 public.ts → 领域 Model → 对应 Hotfix/System/Handler。业务引用依赖的公开入口 #tiangz/modules/<id>，#tiangz/model 只提供宿主契约，不再混入 MMORPG。

手写协议/配置/Native 声明属于模块；generated 目录均不能手改。Examples 的 server:build 依次准备编辑器路径、生成协议/Luban/Native/System 声明并构建 TS；Native 改动追加 server:native-build，随后重启。配置候选由模块 validator 检验，冷表不能热更。插件负责呈现确定性错误，不能放宽规则。

游戏测试归 Examples：npm test、test:native、test:runtime、verify:server-assets。test:runtime 用随机本地端口和内存数据验证真实登录/进图/退出；不操作现有服务和数据库。主工程 verify:quick 只检查框架，test:unit:coverage 使用框架与游戏联合场景保持原门槛。旧固定拓扑验收归档为 legacy，不作为日常命令。

下文旧 Starter 操作和路径用于历史业务背景；具体执行入口以 [当前命令](../reference/commands.md) 与 [模块说明](../../../TiangZ-Examples/modules/mmorpg/README.md) 为准。

---

# TiangZ AI 业务开发手册

新增 Transport 驱动不能从公共帧头 BE 推断所有内部字段：现有 29998/6 字节过载信封的 rpcId 使用 LE；控制入站首次真实故障夹具误读 BE，将 69632 变成 1048832 后失败（`temp/hotfix-load-yYtUnM/fault-report.json`，两宿主正常退出）。查生产 build/parse 函数修读取，不改已有线上格式或忽略未知/重复响应；本次 full 失败保留，修正后重新执行 `TIANGZ_VERIFY_CARGO_FEATURES=kcp npm run verify`。

控制确认 TS 第二轮 **2 failed / 40 passed**，724ms，`temp/v0.7-control-ingress-ts-second.log`：新夹具误设跨 data/control 的执行顺序，且直接 Scene dispose 绕过 Host Root 注销。使用真实 `ProcessHost.despawnScene`、沿用既有公平调度顺序修正断言，不改生产调度或移除 Root 泄漏检查；复测原四个 TS 文件。此阶段与上一轮错误所有者接线分开记录。

控制确认实现的 TS 首轮 **12 failed / 30 passed**，818ms，`temp/v0.7-control-ingress-ts-initial.log`。真实原因是把 SceneCallContext 当作持有 Host 的对象，读取 `this.ctx.processHost` 为 undefined；应沿用 EntryScene 构造时保存的 `this.processHost`，不能可选调用或吞错以隐藏名额泄漏。复测 `npx vitest run tests/unit/control_ingress.test.ts tests/unit/process_shutdown_deadline.test.ts tests/unit/mailbox_lifetime.test.ts tests/unit/local_scene_capacity.test.ts`；该失败属于本轮实现接线，不能归因于原先框架。

新增 Native op 先按当前宏诊断验证参数形状：控制桥初次编译拒绝 `deno_core::OpState` 完整路径，`#[op2]` 要求显式导入 `OpState` 后使用短类型名；日志 `temp/v0.7-control-ingress-native-initial.log`，测试未运行。应修复宏参数再运行 `node tools/run_cargo.mjs test --bin TiangZ --features kcp control_ingress -- --nocapture`，不能移除生命周期所有者或用条件编译绕过。

控制通道必须验证跨轮积压：`node temp/v0.7-control-ingress-probe.mjs` 在真实 TS Runtime 的 ordered 断线钩子阻塞时，按 128 条/轮、520 轮累积 **66560** 条，放行后才排空（`temp/v0.7-control-ingress-audit.json`）。这不是 6 万真实连接容量测试。原因是 Native 每轮控制泵继续投递、TS 无共享总额度；正确修法在 Native 入队前准入并将所有权贯穿 V8 到 TS 未执行节点，完成通知另行保留。禁止丢弃断线通知、扩大单轮界限或只在搬入另一个忙碌 mailbox 时提前归还。见[冻结设计与验证计划](../design/v0.7-control-ingress.md)；实际网络、V8 与 TS 各层证据须分别记录。

0.7 慢写候选：`process.network.writeTimeoutMs` 为 1..300000 的正整数，默认 10000ms，包含出站批次排队与写入；关闭时全部批次另共用 stopTimeoutMs，先到期者生效。超时可能已发送部分字节，不等于操作取消或业务确认。KCP 此期限只覆盖可靠传输前的宿主队列；业务结果未知仍需原幂等号恢复。旧宿主不接受新字段，变更后重建/重启；见[具体契约](../design/v0.7-batch2-contracts.md)。

慢写首轮复测出现 Windows KCP 端口 bind 失败：148 通过、2 失败，证据 `temp/v0.7-write-budget-first.log`。真实原因是测试用 TCP 端口 0 选择的端口在 UDP 上不可绑定，并非 KCP 协议失败。夹具必须按真实协议申请端口；禁止修改系统保留端口或跳过失败。复测 `cargo test --bin TiangZ --features kcp --locked`。确定性 duplex 的生产 vectored writer 已确实写出 64 字节半帧后超时，证明资源基线回收；不能据此冒充操作系统 Socket 慢写通过。

2026-09-16 客户端开发入口迁移：先在 TiangZ 运行 npm run codegen，再到独立 TiangZ-Examples 执行 npm run sdk:sync、npm run check。Cocos/Pixi/Godot/Unity/UE 的手写业务位于该工程 clients/；不得在主工程重新创建 client_demo 或用联接伪装旧目录。SDK 同步命令只更新 tiangz.clients.json 声明的生成目标，--check 不写文件，编辑器 .meta 保留。服务端 MMORPG、Native 与 ModuleGame/WoW335 公共模块依赖迁移仍待完成，本次没有修改玩法或现有数据库。详见 [示例拆分状态](../design/example-extraction.md)。

2026-09-16 modelExports 的提前漏导出诊断只针对唯一直接顶层登记；未调用辅助函数不会覆盖登记结果。动态或多处分支登记不靠静态推测，仍需真实启动验证，不能为规避错误而把正常入口改成动态装配。

2026-09-16 开发模式的 [tiangz-dev-check] begin/end 只划分 Problems 检查轮次，失败也成对结束；不代表游戏就绪。确认服务可用应看 Runtime 就绪与真实请求，不能把该匹配器当作已实现自动附加调试器。

2026-09-16 独立模块在 Developer Tools 中使用模块导航、模块工程操作和新建模块 Component；不要使用主工程 verify:fast 或旧三件套脚手架。插件发现 tiangz.project.json 后会隔离旧 app/ 索引，避免入口 Scene 误报；源码检查仍运行宿主 check/build，通过任务 Problems 查看位置。旧索引未执行模块检查不是“检查通过”。0.7 配套候选已通过 Host worker 接入实时 Program；容量、信任与诊断定位边界见[实时检查](../design/v0.7-module-live-checks.md)，不能冒充完整生成/build 验收。

2026-09-16 边界检查只针对真实 Core 装饰器/模块登记函数；同名业务函数不应触发 Hotfix 字段或 modelExports 误报。诊断修复应保留符号来源和别名解析，不能以简单字符串匹配替代。

2026-09-16 观察在线修改：保持入门工程 npm run dev，另开终端 npm run request，看真实 count；该命令有业务写入，不是只读健康检查。原样保存 Model 不再误触发重启，内容变化仍须重建重启。SDK 连接关闭与超时须释放尚在握手的 WebSocket，不手工修改生成的客户端副本。game_project_soak 可在唯一临时工程持续检查热更、失败候选、重连、计数连续性和停机；报告中的内存样本不是容量或无泄漏证明。

2026-09-16 新增独立模块组件：从宿主调用 create_module_component --project <工程> --module <ID> --name Inventory --feature inventory，先 --dry-run 查看四个文件，确认后创建。插件“新建模块 Component”会展示同一预览并以 --expect-plan 拒绝过期计划。生成只完成状态/行为分层和入口登记，不代替业务选择 Scene/Entity 生命周期中的 AddComponent；新增 Model 要重启。动态装配入口不自动改写。构建的 Hotfix 字段/构造错误现在直接给出源位置，应把状态放回 Model，不能靠绕开插件检查解决。

2026-09-16 模块日常开发使用 npm run dev：共享 Watcher 自动提交兼容行为候选，编译失败保留旧版本；Model/协议/模块与启动配置变化只提示重启，不自动清空状态。需要修改协议时先退出 dev、显式 protocol-update，再重新 dev。dev:debug 只保证调试 Bundle，Inspector 需在 Process 配置启用。输入 shutdown/父输入 EOF 后优雅停止并释放工程锁；源码循环真实验收为 test:game-project-dev。

2026-09-16 新手路径：使用 project:create 创建计数器工程，按生成 README 执行 doctor/setup/host-build/build/smoke；普通 TS build 不重复 Cargo，首次或宿主变化才 host-build。计数在 Scene 的 Component 上，由 Hotfix System 修改；Handler 不保存状态。Model/Hotfix 以 counter 同名功能目录组织，显式入口负责登记/加载。新工程 tiangz.project.json 由通用 game_project.mjs 校验，插件只作为引导和导航入口。test:game-project 加入 full 验收；状态不持久化，模板不是生产发布配置。

2026-09-16 模块阅读入口：运行 `npm run modules:inspect -- --modules-dir <目录>` 查看 Model/Hotfix 入口、公开 API、状态类型、System/Handler 绑定和疑似漏加载。插件使用同一工具的 `--json` 结果做导航；本模块 modelExports 运行时桥与跨模块 publicApi 不同。静态可达只追踪相对值 import/export，动态注册需人工和运行时核对。通用工具拥有规则，插件拥有引导和呈现；终端开发不能依赖插件安装。

2026-09-15 优先完善 TiangZ 开发流程，不开发 SLG 玩法。独立游戏可在 create_game_module、prepare_game_modules、typecheck_game_modules、build_runtime_bundles 上统一传 `--host-profile modules`；build_game_config_data 从 Model 清单选择空内置表信封，支持显式 `--modules-dir`。业务配置仍经既有模块配置路径安装。Hotfix-only 必须同模式，默认 demo 不自动切换；依赖 MMORPG 类型的模块不适用于 modules 模式。test:module-host 是框架自有真实启停与隔离回归，已纳入 full。TS 模块 Watcher 一键流程已在 2026-09-16 接入，Rust 二进制裁剪仍未完成，不能宣称通用开发流程已经全部收敛。

2026-09-15 SLG 日常入口：首次 setup、dbproxy:up、build，之后 dev 与 client:open；提交前 check/smoke，数据库迁移和发布产物预览按需。protocol.generateGodot=false 可关闭 Godot 生成，旧模块默认不变；不会自动删除旧文件。dev 仍检查模块类型和协议产物，但不调用 Cargo，不生成/同步 SDK，不检查整个 Cocos 工程。过期产物先 setup；新协议显式 protocol:update；Rust/Native 改动或宿主升级必须 build。README 是 SLG 开发流程唯一入口，验收历史另存。

2026-09-15 SLG 环境流程：在独立游戏根目录执行 dbproxy:up，首次生成 Git 忽略的独立密钥并部署专属存储组；dbproxy:check 检查依赖，dbproxy:smoke 在独立库留下唯一验收记录，测试 SDK 写入及第二进程重读。dbproxy:stop 只停该组服务，不删除数据卷。Creator 3.8.8 首次导入后提供完整类型，工程覆盖 moduleResolution 为 Bundler 以兼容宿主 TypeScript；client:build/preview 分别构建与本机预览。

2026-09-15 SLG 开发入口：在独立 `TiangZ-SLG` 工作区使用 setup 同步模块协议 SDK 和编辑器路径，check 做只读一致性/类型检查，dev 生成构建并启动，smoke 用真实 WebSocket 验证只读地图后通过 stdin 控制正常停机。当前 dev 不提供自动监听/热更；新增协议显式运行 protocol:update，Model 变化重建重启。Cocos 未生成编辑器类型时只执行连接层类型检查与打包检查，不能替代编辑器画面验收。不要复制 Wasteland 的持久化配置或为 SLG 修改 Core 特例。

新增 Hotfix 值导入后运行 `modules:typecheck`，检查会定位 `modelExports` 漏登记；仅用于类型时使用显式 `import type`。目前提前检查覆盖入口中可识别的注册调用与命名导入。

2026-09-15 模块开发流程补充：新接入或切换宿主/依赖后执行 `npm run modules:prepare -- --modules-dir <模块父目录>`，同步模块 tsconfig 的编辑器解析；追加 `--check` 可用于 CI。配置文件当前要求严格 JSON，JSONC 会明确拒绝。协议改动先显式更新锁，再执行真正只读的 `codegen:module-protocol -- --modules-dir <目录> --check`；过期产物需要正常生成，不由检查命令修复。生成使用 manifest 自定义源/锁路径，所有模块生成与 opcode 校验完成后才发布，失败恢复旧产物。生成目录不得包含手写代码。dev 会监听模块 Luban 工程目录并过滤生成输出，schema 变化仍走重建重启。

2026-09-15 主线整合后，外置游戏应调用统一 TiangZ 主线的生成器、模块检查和构建入口，游戏的 Proto、配置、SDK 输出和 dist 仍由游戏目录拥有。切换宿主后先运行宿主 `codegen:scenes`，再用该宿主 `modules:typecheck -- --modules-dir <目录>` 检查；检查器会把生成方法声明与当前 Stable API 绑定，并保留模块自有声明。协议/Model/Native 变动必须完整构建和重启，不能复用旧分支二进制。验收记录见 `docs/design/mainline-integration-20260915.md`。

2026-09-14 诊断慢客户端时，`slow_client_disconnects` 只统计出站字节/帧/批队列容量拒绝；正常关闭接收端不计入该指标。传输层使用 `ConnectionQueueError` 保留关闭与容量原因，失败回滚本批队列计数，清理连接仍发送原 shutdown 信号。不得通过提高容量掩盖断线误分类。回归同时覆盖直接扇出和聚合批次，游戏模块无需改协议或存储。

2026-09-13 宿主升级 Deno 后，Native 模块需同步检查其 Cargo.toml。组合构建会先用 Cargo metadata 检查正常依赖中的 deno_core crate 身份，发现旧版本或不同来源直接拒绝并标明模块；仅开发测试依赖不参与此生产扩展检查。先调整模块声明并按既有 --check 流程解析组合锁，再进行 --locked 发布构建，不手工修改生成的桥接文件来强转 Extension。

2026-09-13 独立游戏启动建议传 `--runtime-root=<资源目录>`，配置文件的相对路径在该目录下解析。目录必须具有 dist/、configs/，无效路径报错，不能静默加载宿主或另一游戏的 Bundle。省略参数时保持原推断规则。不要把此运行选项塞入业务 Component；它属于部署启动。候选测试应核对日志中的 runtime_root 与 Hotfix 版本。未知启动参数或多个配置路径会被拒绝，完整版本查询仍为 `--version`。

2026-09-11 模块自有交易协议可调用 `PlayerTradeComponent.GetSnapshot/Request/Respond/UpdateOffer/Confirm/Cancel`。需要限制最终背包时，使用 `PlayerTradeEvents.BeforeCommit` 的同步只读否决监听器：事件在双方邮箱内、首次冻结持久化载荷前执行；返回非零错误码拒绝整笔交易，不可拆开保存双方记录。回执恢复不重复准入，计划失败会释放未触库的会话。模块必须确认货币所有权一致；荒原进度金币尚未迁入钱包，因此只允许零金币的物品交换。协议、Model 和事件注册变更需要完整构建重启。

2026-09-10 迁移源端存档保护：MapHost 在 Location 提交成功、安排延迟销毁时立即调用 PlayerPersistenceComponent.RetireTransferredSource。源 Actor 的排队定时存档/离线保存不再写库，业务事务拒绝；标记不进入 Transfer，目标仍可保存。不能仅依赖下一帧销毁来避免旧源快照与新宿主的 revision 冲突。

离线任务事件可用 Model 公开入口 `AdvanceQuestState` 预备 `QuestState`，与在线 `Quest.Advance` 共用目标上限、多目标完成和 revision 推进规则。该函数是纯计算，输入为已校验的任务状态；返回新快照不代表已落库。消费者验证持久接取实例与事件来源后，将 inbox 和任务进度放进同一 CommitRecords，再 ACK。NPC、前置、奖励、事件版本及业务实例 ID 由模块定义。模型/存档结构升级必须声明 Codec 迁移并重建重启，历史已完成任务不自动补发新增奖励。

公共分线回归入口为 `npm run test:public-maps`，已接入 `npm run verify` 的 full 矩阵。2026-09-10 实测 full 11/11、quick 25/25、check 15/15 通过。新增能力的真实 Runtime 验证不代替业务游戏的 DBProxy、怪物与任务链验收。

2026-09-10 开发公共地图时在 MapManagerScene 的模块装配器调用 ConfigurePublicMaps，在 MapHostScene 装配器调用 ConfigureCapacity；规则需完整构建重启。客户端通过生成的 Gate.EnterPublicMap 请求模板与偏好实例，Gate 提供已认证 CharacterId 并复用原传送事务。不要手拼宿主地址，也不要以玩家组件调用 MapComponent.TransferToMap 代替 Gate 屏障。公共分线元数据由宿主重报恢复，旧 staticMapIds 固定实例保持兼容；私人副本继续 DynamicMapProxy。玩法授权（等级、任务、入口距离）仍需游戏接入时校验，容量预留不能代替业务授权。验收包含并发超售、Prepare/回滚、两个真实 MapHost 的迁移与后续 Actor 请求，参见[实现与验证说明](../design/public-map-channels.md)。

2026-09-10 Godot 独立模块客户端只需同步生成的协议 `.gd`，读取器已内嵌，不要再从示例复制或手写 `TzProtoReader`。共享读取器源码是 `client_sdk/godot/proto_reader.gd`；修改后运行 codegen，生成清单会校验该输入。新工程验收必须实际 `load` 并进行编解码，`ResourceLoader.exists` 只能证明文件存在。配置 `GODOT_BIN` 后执行 `node tools/module_protocol_codegen_self_test.mjs` 可在无缓存项目验证两个 SDK，默认缺少 Godot 时仅做静态检查并明确提示跳过实跑。

模块安装/升级/删除先完整构建验证，再运行 `npm run release:package` 生成独立版本目录；此命令自动选择模块 Native 二进制并校验配置/Bundle 身份，不能混用旧二进制。Native 首次组合需先运行 `build:module-native -- --check` 解析并保存组合依赖锁，正式发布使用 `--locked`，制品携带该锁。`--debug` 可生成开发验收制品。命令不会自动切换现有服务；保留旧制品后按现有部署流程优雅重启。迁移写入后旧版 Codec 会拒绝更新已升级记录，数据回退必须单独设计。

模块扩展开发：通过 manifest 的 `publicApi` 暴露 Model 类型，依赖方只导入 `#tiangz/modules/<直接依赖ID>`；类型检查使用 `modules:typecheck` 自动解析，禁止深层或传递依赖导入。配置可声明 `gameConfig.client` 的 target 和两类输出目录；`codegen:module-config` 生成后完整构建固定 schema，数据更新复用 `build:game-config` 与 `reload`（提交完整 Hotfix + 配置），由 `ModuleConfigRegistry.Get(id)` 读取最新原始表快照。旧快照引用不自动刷新，领域适配必须选择重读时机。持久化升级在模块 Codec 的 `migrations` 中声明逐版本纯转换，不能附带 SQL/Shell；Repository 以 CAS 落库并对冲突重新读取。Native 模块执行 `codegen:module-native` 和 `build:module-native`，生成文件不得手改，二进制与 Model 变更必须配套重启。Model 在线重载仍禁止，配置 schema 变化通过版本部署处理。详细字段和限制见[外置游戏模块](../design/external-game-modules.md)。

2026-09-09 外置模块协议由模块自己拥有。模块在 `tiangz.module.json.protocol` 声明 `source`、`opcodeLock`、`schemaLock`、`serverOutput`、`typescriptOutput`、`godotOutput` 和 `godotClassName`；Proto 与两份锁提交在模块仓库，生成的服务端描述符放在模块 Model 源码根，TypeScript/Godot SDK 放在模块输出目录。开发时用 `npm run codegen:module-protocol:update-lock`（独立游戏工作区可用 `npm run protocol:generate`）更新锁，日常用 `npm run codegen:module-protocol` 或 `npm run protocol:check` 严格生成并校验；`--check` 不更新锁。模块 opcode 还要通过宿主和其他模块的全局冲突检查。不要手工编辑生成文件、把模块 Proto 复制到 `app/core`，或让宿主 tsc 直接把外部模块协议当作宿主生成入口；完整 Model bundle 会自动注册模块描述符。协议、锁或生成输出变化必须完整 codegen、构建并重启 Process。

2026-09-08 招架、格挡等否决后的奖励通过 CombatEvents.DamagePrevented 处理，禁止在 BeforeDamage 中修改单位。需要加速当前挥击时先检查活动阶段与剩余时间，再调用 ShortenAutoAttackSwing；方法不替业务决定加速比例，也不激活闲置攻击。

2026-09-08 需要攻击者与目标共同参与金额计算时，在目标工厂给 Combat 注册目标自己的 DamageCalculator。不要修改 BeforeDamage 只读请求，也不要在 DamageResolved 再打一笔伤害模拟暴击。计算器返回非负 uint64 金额及 critical，按调用时方法执行；保持纯计算，事件、吸收和死亡仍由既有 Combat 边界处理。验收应检查否决先于计算、非法结果不消耗吸收器、暴击只扣血一次以及周期来源。协议变化走完整 verify。

2026-09-08 模块读取公开角色名用 `PlayerUnit.DisplayName`，不要查询其他账号的私有角色目录或采信客户端提交的名字。Login 从选中角色携带名字，Gate 路由保持身份，Map 首次快照及迁移恢复使用该字段。验证使用账号与角色名不同的样本，并检查 Unicode、旧令牌兼容和跨地图保留；Model/内部协议修改走完整构建重启。

2026-09-08 现有技能、物品或交互协议无法表达的模块操作可使用 `Map.InvokeUnitAction`，不要伪造NPC交互或技能请求。装配玩家时取得或添加 `UnitActionComponent`，登记实现 `InvokeUnitAction(action, version, payload, operationId)` 的同玩家组件。登记组件引用，禁止捕获旧 Hotfix 实现；业务方法自己验证版本、字段、目标权限及事务回执。信封不允许选择调用者，仍经玩家 mailbox，转图拒绝。非游戏专属工作台测试覆盖组件拥有者隔离、异步结果、方法更新与64KiB边界。新增协议须 codegen、完整构建和进程重启。

2026-09-08 归属单位的资源属于其玩家所有者。不要把 CurrentMp/MaxMp 加入公开 AOI 白名单，也不要用召唤单位ID解析玩家 Location。进入快照在复用公开缓存后按当前拥有者生成私有视图；增量复用 Map `PublishOwnedUnitResources`，按现有召唤思考桶检测两项资源，失败保留待重试状态，未变化不重复发送。验证应包含共享缓存下拥有者/旁观者隔离、同时进入、消耗与恢复、上限变化、失败重试及所有者移除。此类 Model 语义变化需 codegen、完整构建和进程重启，不能作为在线 Hotfix 发布。

2026-09-08 成长奖励不得用当前等级的初始数值重置在线资源。`PlanExperienceReward` 与 `ApplyCommittedExperienceReward` 只在实际升级时应用等级档位；同级加经验和已完成回执重放保留后续伤害、施法及其他资源消耗。验收需同时检查待持久化数值和提交后在线值，覆盖真正升级、重复回执与旧回执，不只检查经验总数。

2026-09-08 停止移动时继续使用 `NativeData.ResetMovement`；该入口负责清理输入，并让活动移动在下一 Tick 通过既有批量通道发布一次最终停止状态。不要在业务侧手工广播另一份停止位置。验证需覆盖 Grid2D/NavMesh、同 Tick 重复停止保留通知，以及停止后空闲 Tick 不再产生移动记录；仅断言服务器 `moving=0` 无法证明观察者收到停止。

任务奖励操作号必须含稳定 CharacterId，不能只用账号加任务编号。多记录事务的幂等空间不能依赖玩家快照 key 自动隔离。新奖励使用 v2 角色键；已完成的历史任务可只读回退查询旧账号键，不对活动任务复用旧账号事务。真实回归应包含同账号第二角色领取同任务奖励。

2026-09-08 奖励投递约定：提交前在 `QuestEvents.BeforeReward` 中调用 `AddDelivery(ownerId, payload)`，保持同步且不执行副作用；每次奖励每个 owner 只能登记一条消息。队列上限 128 条、单 payload 8192 字符、总 payload 65536 字符，超限拒绝奖励提交；旧数据未登记的副作用不自动追溯。消费端持有玩家 ordered mailbox，先持久化目标端幂等效果，再调用 `AcknowledgeRewardDelivery`；失败保留队列，未知 owner 不丢弃。使用玩家生命周期管理重试，离线后等重登恢复，不宣称永久在线的 outbox worker。验证包括原奖励 ACK 丢失、恢复、确认 ACK 丢失、重复奖励及队列保留。部署外置内容时可读取 `/runtime-identity` 对照本地完整文件 SHA-256；该身份来自启动时实际加载字节，不能用磁盘新文件或 Hotfix 版本代替。

**当前验收状态（2026-09-07）：NVMe PG 下 r6 完整 30 分钟、五次故障及最终对账通过。** 206,742 次读取无旧读/缺失/不变量错误，AOF 64 条及事件/交易审计均完整；3 次恢复登录重试和暂时错误保留。业务继续遵循原幂等 ID、逐条 revision 和 CommitRecords 原子事务边界，不提高游戏超时或削弱持久化。机械盘 r4 仍失败，性能结论仅覆盖已验收配置；详情见[交接入口](../testing/handoff-2026-09-07.md)。以下同日失败/待验证条目是实施历史。

NVMe r5 因 Windows 10055 探针建连错误而非已完成游戏检查失败中断，仍不能记作完整通过。Windows 控制器现显式提供每轮/地图的 loopback 源地址，复用探针已有固定源端口功能；这属于压测连接隔离，不能复制到业务传输层掩盖连接频繁创建。所有业务超时和恢复判定保持原样。

最新验收：r4 约第 21 分钟正常阶段仍失败，不能宣称完整修复。周期快照在玩家 ordered mailbox 中执行，PG/SDK 等待可能影响后续消息；不要通过放宽游戏超时或改为不可靠保存绕过检查。当前先以相同候选和负载验证独立 NVMe PG 路径，详见[交接入口](../testing/handoff-2026-09-07.md)。

同日后续：DBProxy `SaveMulti` 现在通过一条同库连接提交整批，减少持久提交次数，仍按调用者顺序返回各条 CAS/幂等结果。业务继续分别推进成功领域的 revision，保留失败条目的原请求；不要把部分成功 API 当成 CommitRecords 的原子业务事务。批次修复后的 r3 约第 23 分钟因控制器等待 Redis AOF 重放仅 10 秒而失败，健康阶段没有失败。控制器改为复用既有 90 秒健康窗口，PG 刻意停机期间只等待 Redis；不修改业务预算或数据断言。事后各 64 条记录恢复证明不能替代重新执行完整 30 分钟及最终对账。

2026-09-07 后续修复：DBProxy 服务端已提交且缓存成功的写入不再等待 PG 修复行清理；现有维护 worker 有界批量确认，PG 持久修复目标负责丢失提示后的恢复。业务不需要新增重试或补偿，成功仍以原持久事务为依据。`cache_repair_ack` 现在是后台批量清理阶段，不能再与服务端 `committed_cache_sync` 当作父子阶段解释；完整游戏验收待执行，见[尾延迟归因](../testing/latency-attribution.md)。

2026-09-07 换机续接：PG 排队预算与失败重连冷却已实施，精确测试、提交结果未知边界及验证步骤见[交接入口](../testing/handoff-2026-09-07.md)。业务接口与协议不变，后续修复须以新候选的完整验收确认。

## DBProxy 尾延迟诊断

缓存故障降级现可单独配置 DBProxy `storage.cacheOperationTimeoutMs`（默认 200 ms）；PG 回源仍由 `cacheFallbackTimeoutMs`（默认 2,000 ms）控制。不要用缩短 PG 或 AOF 等待代替缓存降级；提交后缓存超时必须保留持久化修复目标，普通缓存的 TTL/SWR 不等于强一致。TiangZ 业务接口及重试幂等键不变。

先用 SDK 的 `connection_queue` / `connection_exchange` 区分连接排队和请求处理，再结合服务端 RPC、Scene/mailbox 和资源指标。exchange 不是 SQL 时间，各阶段 p99 不能相加减；不要在未归因时放宽业务超时、增加连接或放松一致性断言。指标边界和精准测试见[尾延迟归因](../testing/latency-attribution.md)。

存储侧继续对照 `postgres_connection_wait` 与 `postgres_operation`，以及缓存写入/修复 ACK、回源配额与锁等待。`committed_cache_sync` 已包含缓存写入与 ACK，不能重复相加。存储阶段 count 包括错误和取消，不是成功提交数；判断交易与存档正确性仍靠原回执/版本及最终对账。

相邻 DBProxy 请求分片的 PG 排队预算、重连失败冷却现默认分别为 2,000 ms 和 500 ms。排队失败返回原有 StorageUnavailable；复用原始请求与幂等标识，不能改成新事务重试。该预算不限制已发送 SQL，也不证明超时业务回滚。提交后的缓存修复 ACK 排队失败会保留持久化修复目标，业务层不因此反向补偿已提交资产。完整游戏故障验收仍需独立执行，不把存储精确回归当作游戏尾延迟结论。

提交后 100 玩家启动健康检查已经失败，正式 30 分钟计划未进入计时或故障注入。处理后续问题时须区分冒烟的 PG 排队超时与正式启动的 SDK 队列/Actor RPC 超时；保留失败记录、原请求标识和断言，先核对磁盘同步及各阶段等待，不通过放宽业务超时或减少负载制造通过。构建与诊断结果见[续接状态](../testing/handoff-2026-09-07.md)。

## 下线与路由恢复的交错

成功删除 Location 后，即使 Actor 延迟到下一帧销毁，已捕获的周期恢复快照也不能重新发布它。`RecoverOwner` 不是任意缺失记录的 upsert：首次 MapHost 代次可重建，已知同代的缺失记录保持缺失；新入场必须走显式 `Register`。不要通过缩短 Timer、忽略 ActorNotFound 或超时后无条件清理 Location 掩盖竞态。

保存失败、回执未知和旧代次必须失败关闭；已有离线回执仅对完整 Actor/角色/Gate 身份有效。故障测试必须使用故障前同一批账号重连并操作，不能只看 `/ready`，也不能用更换账号代次冒充恢复。本机演练显式许可、内存保护和版本冻结要求见[本机故障验证](../testing/local-fault-validation.md)。

## 通用提交与业务效果

普通玩家批量快照在超时后必须保留原始待确认请求，包括标识、时间、内容、期望版本；恢复时先用同一请求确认结果，再捕获新数据。`PlayerPersistenceComponent` 最多保留五条未确认领域，不把旧快照回执当作最新状态已保存；事务提交先确认这些快照，跨图不得丢弃它们。`PlayerDomainSaveWrite.snapshotRequest` 由标准实现处理，外置模块无需更改自身持久化扩展格式。自定义远程 Repository 如接受该元数据，必须保证跨调用幂等，不能每次创建新 ID。

需要把多记录变化、追加审计事实、通知意图一次保存时，使用 DBProxy CommitRecords。PlayerPersistenceComponent.ApplyMultiTransaction 的可选 effects 会随资产事务提交；事实内容、事件主题和状态迁移由领域生成，Core/DBProxy 只保证唯一性、CAS、幂等与原子性。不要在保存后另发一条 Outbox 写请求，也不要在不支持 CommitRecords 的旧 Host 上丢弃 effects 回退。

当前玩家交易在 MMORPG Hotfix 根据同一计划生成完整审计与事件；跨游戏重复语义经真实消费者验证后才抽到 domains，WoW 专属规则仍留外置模块。旧交易回执缺少事件时间时保持历史未知值，不在恢复时重算新时间。本地依赖、旧 SDK 兼容、发布顺序和验收限制见[通用持久化集成](../design/generic-persistence-integration.md)。

本文面向承担TiangZ业务需求的AI和开发者。目标是用已有Scene、Session、Unit、Component、协议、状态复制和Client SDK完成业务，不把普通需求升级成框架或Rust Runtime改造。

维护契约：任何架构、目录边界、数据所有权、协议语义或业务开发流程的设计变更，都必须同时更新本文和[AI项目上下文](project-context.md)。设计改动未同步这两份文档，视为尚未完成。

业务代码、教程、测试结果和工具脚本不得写死开发者的仓库目录、软件安装盘符或私网IP。仓库内文件使用相对路径；外部工具通过环境变量或命令行参数定位；性能报告由公共清洗器把仓库内路径转换为相对路径。提交前运行`npm run verify:no-local-traces`，不要通过新增宽泛白名单绕过门禁。

## 默认立场

不要把超时后的孤立 Gate 会话恢复当作主动登出成功：主动退出必须有保存回执。后台断线清理仅在连接已断、宿主明确报告旧 Actor 不存在、离线回执查询可达且 UnitId 匹配但无成功回执、Location 按角色确认无主时释放 Gate 本地路由；下一次登录重新读取持久化数据。查询超时、数据库失败、仍有所有者或尚在线时保留路由重试，不能凭错误字符串或一次网络故障释放角色。

显式退出不能绕过地图恢复：Gate 本地没有地图路由时仍检查 Location；如果角色仍有权威实例，客户端应先完成重连进图，再请求退出。只有确认无权威实例的未进图角色才允许直接释放 Gate 认证路由。

账号与角色分开创建时，调用公开注册协议并设置 `skip_initial_character=true`，不要伪造一个占位角色名。注册响应的 `character` 可缺省；空目录登录只证明密码有效，空令牌不能用于进 Gate。创建角色后重新登录并显式选择返回的稳定 CharacterId。未设置该选项的既有客户端仍创建同名初始角色。账号目录变更属于 MMORPG 登录领域，游戏名字规则留在外置适配器；禁止自动删除已有目录记录以掩盖兼容问题。

返回角色列表前必须等待 `Gate.LogoutCharacter` 的 `released=true` 与匹配的 CharacterId，不能以关闭 Socket 代替保存确认。请求失败不得清空客户端角色状态或立即切角；同一连接可重试。Actor 响应丢失后由 Gate 查询原 MapHost 的严格身份匹配回执；MapHost 玩家目录只在保存及 Location 移除成功后发布回执，最多保留 10000 条、10 分钟，查询不会延长寿命。没有回执不是成功，MapHost 重启、过期/驱逐和 Location.Remove 自身确认丢失仍是恢复边界。removing 路由断线后不能 Attach 复活，既有扫描器在账号锁内按 1/2/4/8/16/30 秒退避重试；旧路由重试不能释放新会话。超时退出同样不得在保存失败后无条件释放。真实断线重连仍单独验收，不能被显式退出测试替代。

收到“新增技能、背包、公会、地图、怪物、任务”等业务需求时，先按[能力归属表](../design/capability-ownership.md)判断是稳定契约还是MMORPG适配，默认修改范围是：

```text
app/model/domains/      跨游戏稳定状态形状、ChildEntity和Component容器
app/model/mmorpg/       MMORPG新增或改变状态、字段、构造、继承和稳定适配器时
app/hotfix/mmorpg/      MMORPG普通Handler与可热更领域行为
proto/
game_config/                 策划静态配置Excel；结构完整部署，纯数据可生成候选热更
../TiangZ-Examples/clients/cocos_client2D_3.8.6/assets/scripts/Demo/
../TiangZ-Examples/clients/cocos_client3D_3.8.8/assets/       3D客户端业务与灰盒；Generated/SDK禁止手改
../TiangZ-Examples/clients/ue_client3D_5.4.4/                 UE客户端业务与表现；插件ThirdParty SDK禁止手改
../TiangZ-Examples/clients/pixi_client_8.19.0/src/
configs/
tests或tools中的对应业务自测
```

### 先保护通用内核，再扩展领域

当前Starter是MMORPG领域样例，不要把它反向当作框架定义。AOI、MapHost、地图传送、NavMesh、怪物、NPC、目标选择、Combat、Skill、技能地图调度和掉落协议属于`app/model/mmorpg`、`app/hotfix/mmorpg`或`src/game/<domain>`；Process、Scene、Actor、Component、mailbox、协议路由、热更和宿主队列属于Core；Numeric、Action、Reward、Item、Quest、Buff的稳定状态契约位于`app/model/domains`。不要把当前MMORPG执行器为了目录好看强行搬进domains。

新业务优先沿用现有领域组件和Stable API。只有当现有API无法表达需求，并且需求不是单纯的MMORPG规则时，才申请Core扩展。不要为了“以后支持卡牌、SLG或MOBA”提前新增通用Manager、万能配置扩展或第二套Actor入口。第二个真实领域出现后，使用重复需求和验收结果反推边界。

修改分层入口后运行`npm run verify:domain-boundaries`。它检查Core、Model、Hotfix和Rust游戏模块的依赖方向；通过门禁不代表业务语义正确，仍需运行对应领域测试。

地图内容需要“若干刷点共享并发容量”时，复用MMORPG层的`SpawnSelectionContentProfileComponent`，不要在地图Handler中维护随机数组。实体候选可混合Monster与Interactable；层级候选引用子组。所有实体候选必须登记为`initialSpawn=false`，组层级必须是单父级无环图。外置模块负责把自己的概率、池表和活动规则投影为正整数相对权重；中立运行时只保证冷却槽不提前补位、到期逐槽重抽以及切换子组时停用整个旧子树。

### 配置怪物脱战对白与表情

周期性的环境对白和表情应配置在刷点级`MonsterContentSpawn.idleSequences`，不要在地图或怪物ID分支中启动定时器。`Emote`动作必须提供正的`presentationId`且不能带文本；`Say`动作必须提供至少一条非空`textChoices`且不能带`presentationId`。Core按稳定刷点、动作ID和执行轮次做确定性选择，只发布中立表现；来源事件枚举、本地化表、文本组以及具体客户端包由游戏模块在导入/协议边界处理。测试至少覆盖Schema生成后文本仍存在、战斗会中断序列，以及无效字段组合在内容封存前失败。

### 外置游戏模块

独立游戏或大型功能包优先使用`modules/<module>/tiangz.module.json`，不把源码复制进Core。模块Model使用`#tiangz/core`和必要的`#tiangz/model`稳定入口，通过`defineGameModule`登记本模块显式导出和必需System；模块Hotfix只使用`#tiangz/model`、`#tiangz/module`及本层相对导入。给现有Entity增加模块Component时，目标Factory在发布前调用一次`applyEntityExtensions`，模块用强类型`entityExtensionHandler`同步执行`AddComponent`；不得异步、保存Handler字段或创建第二套生命周期。MMORPG当前可组合`MapScene`、`PlayerUnit`、`MonsterUnit`、`NpcUnit`、`InteractableUnit`和`SummonedUnit`；NPC与可交互物必须先完成基础身份、位置、静态资料和内容增量，再执行扩展，成功后才加入领域索引与AOI，失败则回滚整个Unit。NPC的通用战斗组件由Core工厂依据冻结的`NpcCombatProfile`装配，模块扩展不得再次附加它们；模块私有组件仍走实体扩展。依赖图只确定构建顺序，不授权跨模块深层导入。

协议适配器完成外部校验后若需要触发内容表现，调用中立`TriggerNpcInteraction`即可；Core侧只做玩家/Unit/AOI/距离校验和`NpcContentInteractionTrigger`分发，不接受外部opcode、SmartAI编号或领域数据库ID。`GossipSelected`这类触发值必须作为内容包契约由适配器映射，规则没有匹配时返回安全的未接受结果，不能把协议失败伪装成业务成功。新增这类能力时要同时覆盖协议锁、Core handler、适配器编解码、内容导入器和无客户端测试。

NPC交互规则中的施法链使用中立`NpcContentInteractionActionType.ExecuteAbility`和`NpcEvents.InteractionActionRequested`。导入器可以把来源SmartAI CAST映射为模块命名空间下的不透明能力ID；Core只负责冻结规则、按延迟/概率调度并发布请求，不能读取或解释Spell/Opcode。模块收到请求后自行决定客户端表现、权威效果和未知能力的安全降级；测试必须同时断言内容包覆盖、Core事件边界和模块映射，不能把一次Extension表现冒充完整法术封包。

NPC脱战定时表的CAST行使用同一边界的`NpcContentIdleActionType.ExecuteAbility`和`NpcEvents.IdleActionRequested`。Core只负责序列调度、概率、延迟和同包稳定刷点目标；ACDB事件/动作/Spell ID及协议表现全部留在导入器和外置模块。新增来源目标类型时先补中立目标语义与导入器测试，再由模块选择真实封包或安全忽略，不能在Core增加SmartAI分支。

MMORPG地图和怪物内容使用同一装配边界，但资料写入有确定顺序。`MapHost`先用冷配置初始化`MapRuntimeProfileComponent`，同步扩展`MapScene`，然后才创建AOI和`MapComponent`；外置模块可为目标地图覆盖一次空间模式、尺寸、Cell大小与出生点。地图建立后，玩家移动与复活、NPC出生、怪物出生/追击/回巢都必须读取`MapComponent.SpatialProfile`，不能再次读取冷配置中的空间字段；朝向相对的方向输入在NavMesh3D保持连续移动，在Grid2D由同一入口量化为八方向。怪物工厂先用`MonsterAreaConfig`初始化`MonsterSpawnProfileComponent`，同步扩展`MonsterUnit`，然后写入位置和AOI；同一资料也是追击距离与Evade回巢的Home点。覆盖必须带稳定模块ID，第二个覆盖者会失败并触发现有Factory回滚，不允许依赖加载顺序。游戏地图编号、坐标、怪物名称和职业规则只能位于外置模块，TiangZ的资料组件保持中立。

外置数据包需要批量提供模板/刷点时，使用地图级`MonsterContentProfileComponent`，不要生成成千上万个`MonsterUnit`装配器，也不要把外部数据库表映射进Core。模块在`MapScene`同步装配阶段调用`Register(ownerId, { definitions, spawns })`；一次登记先完整校验ID、数值、同所有者引用和冲突，再原子发布。完整内容包可先调用`ReplaceColdContent(ownerId)`排除该地图的演示冷刷点；第二个替换所有者必须失败。`MapHost`在装配器返回后调用`Seal()`，此后不得动态写目录。共享模板只保存战斗/表现默认值，`respawnSeconds`保存在每个稳定刷点；冷`MonsterConfig.respawnSeconds`只在规范化旧配置时投影到刷点。创建Unit时必须把快照所需的中立展示资料一并传入；AOI、重连和初始快照不能用外部定义ID再次查询Luban，否则完整替换冷内容的模块会在发布实体时失败。具体来源库、坐标转换、阵营、名称和内容指纹仍属于外置游戏包。

普通击杀经验同样属于模板资料，不属于Core公式。模块可为`MonsterContentDefinition.rewardExperienceByPlayerLevel`提供完整的`playerLevel/experience`只读曲线；登记阶段要求等级唯一、正整数并排序冻结，经验为非负整数。`MonsterKillExperienceHandler`只消费已提交的`MonsterEvents.Killed`事实，按击杀时等级选值，以地图实例、刷点、Monster `InstanceId`和角色组成幂等operationId，再通过玩家mailbox调用`ProgressionComponent.GrantExperience`。不要只使用`AreaId`作为击杀代次：刷点复活后会复用该ID。来源游戏的等级差、精英倍率、灰名、无经验类别和客户端经验/升级封包均必须留在模块构建器或协议适配器。

来源数据库中的AI或路径脚本必须先由游戏适配器投影成中立内容，不能把来源枚举直接塞进`MonsterContentProfileComponent`。进入战斗说话/表情使用`behaviorRules`；路径到点后的持续动作、模型切换、临时游走和路线重启使用`waypoints[].actions`，其中`delayMs`相对到点时刻，`chancePermille`由服务端确定性判定。脱战周期互动使用刷点级`idleSequences`，声明初次/重复延迟区间和有序动作；引用另一个稳定刷点时必须属于同一内容所有者，目录登记负责在发布前校验引用。战斗开始会取消仍在执行的空闲序列、路径暂停和临时游走，Evade仍从现有怪物移动入口回到遭遇起点。改变模型或持续动作时要同时更新`MonsterUnit`的快照状态并调用`MapComponent.PublishUnitPresentation`，这样当前AOI观察者收到事件，后来进入视野者从`MapEntitySnapshot.presentationModelId/presentationStateId`得到当前状态。游戏客户端字段、消息包形状、模型和动画编号只能在协议适配器中解释。

怪物的状态型法术仍不能变成专用Monster字段。外置内容可以用`HealthRange`按包含边界的千分比血量触发规则，并用`ApplyBuff`选择自己或当前战斗目标；规则引用的定义必须先由同一地图上的`BuffDefinitionProfileComponent`登记。省略`repeatDelayMinMs/MaxMs`表示一次遭遇只判定一次；两项同时提供则表示可重复规则，地图固定更新帧只在怪物有战斗目标且血量匹配时检查其独立截止时间。不要为每只怪物或每条规则创建Timer，也不要只在受伤回调里推进重复规则。`MonsterComponent`负责遭遇重置、确定性概率、目标解析和重复截止时间，实际Buff生命周期继续交给`BuffComponent`。SmartAI事件号、动作号、链接行、Spell.dbc光环类型与持续时间只在导入器内解释，生成模块只能包含中立trigger/action/Buff数据。

模块自有技能使用地图级`SkillDefinitionProfileComponent`，并在`MapScene`同步装配阶段一次性登记只读`SkillDefinition`。模块ID拥有自己的定义集合；不得覆盖Luban `SkillConfig/SkillEffectConfig`、另一个模块或同ID冷配置，也不得在Hotfix模块变量中维护可变技能表。登记完成后仍由`SkillMapComponent`执行目标、距离、冷却、Action、Combat与AOI，协议适配器只能投影外部法术号。Buff Tick等延迟伤害命中`MonsterUnit`时必须复用`MonsterComponent.ApplyUnitDamage`，保证来源仍在线时继续处理仇恨、掉落与任务，来源离线时也会完成死亡、尸体和刷怪槽重生；禁止直接把怪物血量写到0后自行广播。

模块自有Buff使用地图级`BuffDefinitionProfileComponent`。模块要为每个定义分配与技能、客户端法术号相互独立的私有ID，先完整登记后再让技能、道具或怪物行为用`AddBuff`引用；不得复用冷`BuffConfig` ID、覆盖冷资料或把定义塞入模块级可变Map。外置定义只描述持续时间、Tick、冲突/刷新策略与中立Action，登记后复用既有`BuffComponent/BuffSystem`，不另建一套模块Buff状态机。`durationMs=0`表示由业务显式移除的长期状态；数值AddAction必须提供对应RemoveAction，持续伤害只写TickAction。地图发布前目录会被封存，运行时缺失引用应视为内容包错误而不是临时补注册。

模块需要挂接玩家行为时，先区分提交前校验与提交后事实。`SkillEvents.BeforeCast`等Veto只能同步读取目标、位置、Buff与模块Component并返回错误码，不得扣资源、加Buff或启动异步任务；`SkillEvents.EffectsResolved`在基础效果提交后按瞬发命中、弹道命中或每个引导Tick发布一次，`CombatEvents.DamageResolved`、`QuestEvents.Accepted`等事实也都已经完成权威写入。事实监听器可以追加职业联动、NPC对白和表现，但不能回滚原结果、改写伤害/冷却，也不得抛错或启动未受管异步写入。连击点、姿态窗口和具体宠物种类/指令等游戏规则应放模块自己的PlayerUnit/Unit Component，不得扩充Core实体字段；需要真实地图Unit、AOI、跟随和协战的临时所有物则调用中立`SummonComponent`，不要在模块里复制另一套Unit生命周期。追加伤害仍调用`MonsterComponent.ApplyUnitDamage`，追加Buff仍调用`BuffComponent`，物品变更仍经`ItemComponent`计划/提交与统一推送，避免模块自己复制死亡、掉落、任务和AOI流程。

使用`SummonComponent.SummonOwnedUnit(owner, request)`时，定义必须是模块拥有的冻结数值，只包含名称/模型、基础数值、移动、攻击与跟随参数；同一所有者和`ownershipSlot`的新Unit会原子替换旧Unit。所有者可以是`PlayerUnit`、`MonsterUnit`或`NpcUnit`，但`AssistOwnerAgainst`和跨图快照只适用于玩家：怪物和NPC拥有的召唤物默认只执行通用跟随，由模块以后通过新的中立敌对/协战契约扩展，不能把具体阵营、遭遇阶段或宠物AI塞入Core。没有`NumericComponent`的服务型NPC以1级作为召唤物等级兜底，不得为此伪造一套NPC战斗属性。玩家离图以及怪物、尸体或NPC移除都必须沿`OwnerLeaving`合并AOI Leave；非玩家所有者没有持久角色ID，其召唤快照使用`ownerUnitId`维持地图内关系。不得为每只召唤物创建Actor、mailbox或Timer，也不得在模块单例中缓存Unit。当前召唤物是地图内临时状态：若业务要求重登录或跨地图恢复，先设计可转移/可持久的中立快照与失败语义，再扩展Core；不能把宠物栏、恶魔或某协议字段塞入`SummonComponent`。

玩家主动接取且会发放物品的任务必须调用`QuestComponent.AcceptQuestDurable(questConfigId, sourceUnitId)`，不能先`AcceptQuest`再单独保存背包。该入口以稳定operationId原子提交`inventory + quest`，只在首次本地应用后发布`QuestEvents.Accepted`；ACK丢失和重复RPC会恢复同一回执且不会重复发物品。Handler把`inventoryChanges`放进`M2C_AcceptQuest`，协议网关按Item版本合并。法术制造物品使用`ActionType.GrantItem`，由技能结算统一发布`ItemChanged`，不要在模块事件监听器里直接创建Item或手写客户端Push。

模块增删、manifest、依赖、Model或Handler/Entity装配集合变化需要完整构建并重启；只有既有System/Handler的实现变化可以走Hotfix。每个模块必须提供独立`tsconfig.json`，设置`TIANGZ_MODULES_DIR`后构建、目录命令和开发宿主使用同一模块集合并监听模块Hotfix。模块不得提供自动执行的Shell、SQL或安装脚本，也不得用模块级单例保存业务状态。使用`npm run modules:validate`、`npm run modules:typecheck`和`npm run test:game-modules`验证，完整结构见[外置游戏模块](../design/external-game-modules.md)。

### 运行时数据包开发流程

区域、关卡、模板和活动资料如果只改变数据，不得为每个区域生成一个代码模块。代码模块用`tiangz.module.json`承载可执行行为与Model/Hotfix边界；运行时数据包用固定文件名`runtime.pack.json`承载该模块拥有的不透明JSON资料。推荐流程是：导入器先生成包含来源证据和覆盖报告的审计产物，再生成最小运行时信封；部署配置只把数据包目录加入`process.dataPacks.sources`，已有模块在Scene装配阶段读取`RuntimeDataPackRegistry.Instance.List(moduleId)`并按payload中的中立选择条件装配目标Scene。

运行时信封必须包含`formatVersion: 1`、稳定`id`、已安装的`ownerModuleId`、64位小写十六进制`contentHash`、非空`source`和纯JSON `payload`。`id`必须位于所有者命名空间；同一Process内重复ID、未知信封字段、符号链接、超限文件、非有限数值或非JSON对象都会阻止启动。Rust宿主追加的`fileHash`表示实际部署文件指纹，`contentHash`仍由模块定义其规范化业务内容身份。不要把私钥、数据库连接串或可执行脚本放进payload。

数据包目录在Process启动时一次性校验并深冻结，Scene创建后不能增删或修改；替换资料必须进行版本化部署并重启Process。模块应在装配时继续使用领域Profile的原子登记、跨表引用校验和`Seal`，不能把冻结的信封误当作“业务已经合法”。数据包只负责静态内容，玩家进度、活动状态和其他可变权威数据仍属于Scene/Component并通过通用Repository与DBProxy持久化。单元测试至少覆盖一个与目标游戏无关的资料包，以及真实模块的两个不同选择样本，证明增加区域只增加数据包而不增加代码模块。

### 领域契约与 MMORPG 适配

共享领域层只放不依赖生成配置、协议、地图或游戏Native句柄的稳定契约：

```text
app/model/domains/numeric/  Numeric字典和派生规则
app/model/domains/action/   ActionDefinition
app/model/domains/reward/   RewardPlan
app/model/domains/item/     Item ChildEntity和背包容器
app/model/domains/quest/    Quest ChildEntity和任务容器
app/model/domains/buff/     Buff生命周期容器
app/model/mmorpg/combat/    当前MMORPG的伤害、治疗、护盾和平A状态
app/model/mmorpg/skill/     当前MMORPG的读条、引导、冷却和技能定义
```

MMORPG适配层继续放：`ActionExecutor`、`RewardExecutor`、`CombatComponentSystem`、`SkillComponentSystem`、`SkillMapComponentSystem`、NPC/地图目标选择、Luban ActionType和协议投影。它们读取`PlayerUnit`、`MapComponent`、`GameConfigs`或`ItemSnapshot`，所以不能伪装为跨游戏Core。

`ActionDefinition`和`RewardPlan`的最小用法：

```ts
import { ActionType, type RewardPlan } from "#tiangz/model";

const reward: RewardPlan = {
  operationId: "quest:5001:character:1001",
  actions: [{ type: ActionType.GrantItem, parameters: [1101n, 5n] }],
};
```

`ActionDefinition`只描述效果和`bigint`参数，不选择目标、不调用RPC、不修改Entity；`RewardPlan`只描述有序奖励Action和可选幂等键。MMORPG执行链仍是`RewardPlan -> PlanTransactionalReward -> ItemComponent.PlanGrantItems -> DBProxy -> CommitGrantPlan`。规划阶段不能修改Entity，确认前不能回复成功。当前`RewardDefinition`是`RewardPlan`的兼容别名，新代码优先使用`RewardPlan`。

Numeric的`MoveSpeed`不属于通用Numeric字段。通用层只保留HP、攻击、等级等可复用数值；米/秒到Rust毫米/秒、移动位置同步和MoveSpeed默认值放`app/model/mmorpg/numeric/MovementNumeric.ts`及对应System。这样卡牌或模拟经营可以复用Numeric，而不会继承地图移动语义。需要前进、后退、横移采用不同速度时，给PlayerUnit配置`DirectionalMovementProfileComponent`的服务端倍率；客户端仍只提交`-1/0/1`方向，不新增或信任客户端速度字段。默认倍率为`1/1/1`，具体游戏常量应留在外置模块或游戏领域。

传统MMORPG需要主属性时，使用`AttributeNumeric.ts`中的`Strength/Agility/Stamina/Intellect/Spirit`及对应Base/Add/Pct编号。它们属于可选的MMORPG组合能力，不属于通用`domains/numeric`，也不会自动派生HP、MP、攻击、护甲或职业收益；这些关系必须由具体游戏的数据构建或领域规则明确实现。不采用五属性模型的项目无需初始化它们。

Grid2D中的玩家持续输入使用`NativeData.SetMovementInput`；怪物、NPC、召唤物等服务端AI移动到确定位置时必须使用`NativeData.SetGridMovementTarget`。后者接收最终目标Cell，由Rust逐格连续推进并在精确到达后停止，避免5Hz AI用持续输入跨过目标后反向折返。业务负责选择目标、速度、暂停和行为状态，不得按固定延时手工安排停止，也不得把具体游戏坐标写入Native接口。

NavMesh3D的服务端AI使用`NativeData.SetNavigationTarget`提交最终坐标。相同目标的更新只确认新的序号并复用当前Rust路径游标；只有目标变化、重置或导航障碍版本变化才允许重算路径，避免周期性AI调用让单位反复回到首个拐点。调用方仍负责目标选择、速度和行为节奏，Core不解释具体游戏巡逻规则。

只有协议网关已经从既有客户端取得真实场景碰撞结果、而服务端没有同源导航资源时，外置地图资料才可设置`externalMovementSnapshots.maxDeltaMeters`。启用后每个`C2M_NavigateInput`都必须带局部X/Y/Z快照；PlayerUnit先校验有限数值、Grid边界、单调序号和相对上一权威位置的最大位移，再调用`UnitApplyGridMovementSnapshot`一次性下沉。普通Grid2D和全部NavMesh3D地图不得发送这些字段。阈值和坐标转换属于外置模块/网关，TiangZ不认识具体客户端地图编号、原点或跑速。

同地图技能位移、脚本挪位和传送门落点使用`MapComponent.RelocateUnit(unit, { x, y, z, yaw })`。调用方负责目标、方向、距离、资源消耗和游戏限制；入口负责有限值、Unit地图归属、Grid2D Cell吸附或NavMesh3D表面投影，并原子停止旧移动、更新权威坐标和触发既有AOI/Movement发布。业务不得直接写`Position`、绕过Rust空间状态或自行广播一份位置。协议适配器收到无客户端确认序号的移动记录时，应释放冲突的本地预测并应用服务端权威位置；不要把它补成虚假的客户端序号。新增调用至少测试越界/非有限值拒绝、最终吸附或投影结果，以及协议侧不会将服务端位移误判成客户端ACK。

Item、Quest、Buff本轮只拆稳定Model契约；Combat、Skill仍完整留在`mmorpg`，因为当前实现含有平A、伤害学校、读条、引导和技能配置语义。第二个游戏真实使用后，再从两套实现中抽取已经重复的行为，不按目录名猜通用性。

### await 后的 Entity 存活检查

JavaScript 的 `await` continuation 不能被运行时抢占。ordered Actor 在等待外部 IO、Timer 或 RPC 时可能被销毁；框架会在 mailbox 结果结算时拒绝旧调用，但不能撤销业务已经执行的后续代码。业务在 `await` 后准备读取或修改 Entity/Component 前，应调用：

```ts
await externalCall();
player.AssertAlive();
player.GetComponent(InventoryComponent).Commit(...);
```

`AssertAlive()` 是协作式生命周期门禁，不是自动取消机制。需要强制串行边界时，应把后续工作拆成新的 Actor mailbox 消息或由 Entity Timer 重新投递，不要把长时间 Promise 当作锁。

默认不要修改：

```text
app/core/
src/
tools/codegen_*.mjs
app/generated/
src/generated/
客户端 Generated/
```

测试辅助代码同样不能放进`app/core`、`app/model`或`app/hotfix`。裸帧构造、压测Codec包装、Fake和Fixture应放到`tools/support`、`perf`或对应自测文件；普通业务不得依赖这些目录。客户端正式调用统一使用`client_sdk`生成的Client和Push Handler。

Unity业务客户端的默认边界是：

```text
client_sdk/csharp/                         C# SDK唯一源码；协议和网络Core
../TiangZ-Examples/clients/Unity2022.3.62f3c1_demo/Assets/TiangZClient/Runtime  生成副本，禁止手改
../TiangZ-Examples/clients/Unity2022.3.62f3c1_demo/Assets/TiangZClient/Demo     Unity场景、输入、相机和表现
```

协议变化后执行`npm run codegen:csharp-client-sdk`，然后用`dotnet build client_sdk/csharp/TiangZ.Client.csproj`做引擎无关验证。Unity业务不得自己编码protobuf、分配rpcId或直接访问`RpcSocket`的内部字典；只通过生成的`LoginMgrClient/LoginClient/GateClient/MapClient`和消息描述符调用。每帧在Unity主线程调用`RpcSocket.Update()`，网络回调线程不得触碰GameObject、Transform或其他Unity API。当前SDK只提供桌面WebSocket，TCP/KCP没有Adapter时必须报错。

需要在真人客户端中观察多人广播时，运行`npm run robot:walk -- <人数>`。这些机器人通过正式SDK进入游戏并遛弯，不是服务端业务Entity模板；业务Handler不得识别或特殊处理机器人账号。

地图HUD需要显示延迟时，读取`LoginFlow.latestGatePing.latencyMs`，不要另外创建Ping定时器。`serverTimeMs`和`clockOffsetMs`用于服务器时间换算；不要直接相减本地时间与服务器时间来冒充网络RTT。

基准Scene放在`app/model/bench`，压测专用Handler放在`app/hotfix/bench`，并通过`npm run build:bench`显式装配。正常`npm run build`不得包含Bench Scene/Handler；Cocos/Pixi分发SDK也不得携带Bench协议。

Bench Hotfix可以通过`#tiangz/model`调用真实业务API，但Demo不得引用Bench。正式、压测等装配分别写在`app/model/main*.ts`与`app/hotfix/main*.ts`；不要为了消除依赖诊断把Bench实现搬回Demo。

只有现有公共能力无法表达需求时才进入Core。只有明确的数据所有权或性能证据支持时才进入Rust或`native_data`。开始修改前必须能用一句话说明业务边界和权威状态归属。

## 云部署地址怎么填写

外网演示时，前端只需要配置一个LoginMgr公网IP和端口。后续地址由服务端逐级返回：LoginMgr返回Login的外网地址，Login返回Gate的外网地址。

```json
{
  "name": "gate_1",
  "sceneType": "Gate",
  "innerIp": "192.0.2.5",
  "bindIp": "0.0.0.0",
  "outerIp": "203.0.113.10",
  "port": 7201,
  "outerPort": 7201
}
```

- `bindIp`只控制本机监听；云服务器通常使用`0.0.0.0`。
- `innerIp`只给Login、Gate、Location、MapHost等服务间通信使用。
- `outerIp/outerPort`只给客户端登录链路使用；没有外网入口的MapHost、Location和Manager不填写。
- `0.0.0.0`绝不能写入`knownScenes`、MapHost Endpoint或任何返回客户端的地址。
- 同一个入口在`scenes`和共享`knownScenes`中重复时，`outerIp/outerPort`可以只写一边；如果两边都写，必须一致，否则 Runtime 会拒绝启动。
- 旧配置的`ip`仍能读取，但新配置使用`innerIp`，避免开发者误把监听地址当成路由地址。

Model业务代码只从`app/core/public.ts`导入Core能力。`app/model/main.ts`是Rust宿主启动桥接，允许使用Runtime Internal完成启动、更新、停止和二进制事件转发，但不是业务模块的参考写法；`app/model/bench`也必须使用Stable入口。Hotfix代码只能从`#tiangz/model`取得Model类型、协议和Stable Core API；禁止深层导入`app/model`或`app/core`。其他Core路径属于Internal，即使当前可以被TypeScript解析，也不能直接依赖。Stable API需要调整时，按[公共API与版本稳定性](../reference/api-stability.md)完成影响说明、迁移、显式API锁更新和验证。

ordered Scene mailbox的同步任务由Runtime循环排空，不依赖递归调用栈；业务Handler仍应保持短小，长耗时工作使用明确的RPC、Timer或有界`Scene.Tasks.Spawn`，不能用连续同步投递制造无限队列。配置索引、缓存等可变状态必须归属于Scene或Component；Hotfix模块不得使用模块级可变变量或全局单例。

## Starter MMORPG 开发目标

TiangZ的完整业务参考是一个小而完整的Starter MMORPG，不是把Demo扩展成商业游戏。开发主线固定为：登录/选角 -> 主城 -> 野外战斗 -> 掉落/背包 -> 任务/奖励 -> 动态副本/Boss -> 断线重连 -> 重启恢复。执行细节见[Starter MMORPG教程](../tutorials/20-starter-mmorpg.md)，验收标准见[Starter验收矩阵](../starter/acceptance-matrix.md)。

开发Starter时遵循四条硬规则：

- 框架案例可以很小，但Starter必须调用正式Stable API，不得绕过Mailbox、Component、协议生成或DBProxy边界。
- 一个业务状态只能有一个权威所有者；Handler只做协议适配，不能保存玩家状态、编排持久化或直接操作数据库。
- 配置、Model结构、协议和`.native`契约走生成链路；可热更规则放Hotfix，Model和存储结构不能在线修改。
- 新功能必须能在all-in-one和split-process运行，并有失败、重试、重连或重启后的明确结果；只有代码存在不能算Starter完成。

Starter阶段只保留一个职业、一个主城、一个野外地图、一个动态副本、三种普通怪、一个Boss和少量技能。组队、社交、商城、活动和大量客户端美术不是当前框架验收前提。

Starter的第一个动态副本使用MapConfig 200和MonsterConfig 3。客户端调用Gate的`C2G_EnterStarterDungeon`并提供稳定`operationId`；客户端不得指定MapHost或MapInstanceId。Gate以角色和operationId生成幂等请求，交给`DynamicMapProxy -> MapManager`选择动态Host，再复用正式进图流程。Boss死亡只发布通用`MonsterEvents.Killed`，经验规则由`app/hotfix/mmorpg/dungeon`监听，不把副本奖励写进Monster或Combat。

经验是`NumericType.Experience`累计值，等级由`50 * (level - 1) * level`计算，当前上限60。奖励先规划新的Numeric快照并以稳定operationId只提交`progression`记录，DBProxy确认后才更新在线Numeric和发送`G2C_ProgressionChanged`；网络重试必须恢复原事务回执，不能重复加经验。Map 200的试炼守卫奖励120经验，因此新角色从1级升到2级。动态实例无人5分钟后由现有回收逻辑销毁；副本Boss、仇恨和现场状态属于临时运行态，MapHost崩溃后不恢复。

本地入口固定为：`npm run starter:verify`检查目录和生成物，`npm run starter:dev`编译并启动all-in-one，`npm run starter:smoke`验证all-in-one与split-process，`npm run starter:character-smoke`验证创建角色、选角和稳定身份，`npm run starter:acceptance`运行不改数据库的完整Starter验收。三个Starter验收命令都会先重建Debug Rust runtime；`npm run starter:acceptance:persistent`会使用`tools-projects/TiangZ-DBProxy/deploy/local/.env`启动或连接本地DBProxy，写入测试账号、重启TiangZ并读取快照；`npm run starter:acceptance:faults`通过`test:tiangz-fault-matrix`运行交易故障切换、提交后响应丢失、双Endpoint不可用、MapHost接管和独立DBProxy故障矩阵，可能重启本地Redis/PostgreSQL容器，只能在测试环境运行。不要把长时间压测塞进Starter命令；压测必须使用`perf/`的独立入口，并在开始前确认机器资源。

### 账号、角色和运行时Unit

Starter中三种ID必须严格分开：

- `account`只用于登录认证和LoginMgr的稳定路由选择；不要用账号字符串在Map中查找玩家。
- `characterId`是角色长期身份，作为CharacterRepository、Player快照、Location和跨地图传送的稳定键。客户端通过`S2C_Login.characters`显示目录，并把用户选择的ID放进`C2S_Login`。
- 首次账号必须走`C2S_Register`，注册时把用户名作为初始角色名；普通Starter省略`playerConfigId`并继续使用模板1，外置协议适配器则应传入已经由`PlayerContentProfileComponent`登记的模块玩家模板ID。Login在写账号目录前执行与`C2S_CreateCharacter`相同的外置/冷配置校验，不能先产生Demo角色再由网关隐藏或篡改。具体种族、职业和客户端编号仍只属于模块。`C2S_Login`必须携带密码；账号不存在时返回“用户未注册”，服务端禁止用登录请求隐式创建游客账号。客户端确认密码只做表单校验，不发送到服务端。
- `CharacterCatalog`保存密码盐值和摘要，不保存明文；配置`process.persistence.dbProxy`时目录可跨TiangZ重启恢复，未配置时是进程内调试目录，不能用于上线或重启恢复验收。
- `unitId`是当前MapHost里的运行时Unit ID，只用于当前进程的Actor/mailbox/AOI路由；角色迁移或重建后它可能改变，禁止保存到数据库。
- `mapInstanceId`描述地图实例，静态地图和动态副本都通过同一个`TransferToMap`入口处理；业务不根据部署方式分叉。

创建和选角的客户端调用示例：

```ts
const created = await flow.createCharacter(account, "法师一号", 1);
await flow.enterGame(account, 1, () => {}, created.character.characterId);
```

`CharacterRepository`配置DBProxy时负责版本和幂等重试；未配置DBProxy时只是进程内Demo目录，不能宣称支持重启恢复。跨MapHost传送可以把角色快照交给目标内存仓库接管，但这不是把内存数据写回永久存储。业务Handler不得读取或记录密码，只能把认证结果交给LoginScene和后续Gate链路。

`ProcessHost`、`Singleton/SingletonRegistry`和`InstanceIdSystem`属于Core Internal，不从业务入口导出。动态地图等业务通过`EntryScene.SpawnChildScene/DespawnChildScene`管理子Scene；只有已经解析出的本地Actor操作才使用`RunLocalActorMailbox`，跨进程仍走Location与消息路由。业务不得任意查询整个Process Entity目录或取得进程销毁权；长期索引由所属Scene Component显式持有并在销毁时清理。配置JSON同样是强契约：未知根字段、Process字段和嵌套字段都会让Rust拒绝启动，不能依赖拼错字段被静默忽略。Native Store诊断使用Rust正式配置`process.observability.nativeData`，不得恢复旧的根级Demo扩展。

## 开始设计前

新增Item、Buff、Quest、Achievement、Numeric或其他业务系统前，先阅读[领域设计模式](../patterns/README.md)，按下面七个问题写清楚设计：

1. 谁拥有状态：PlayerUnit、MapScene、EntryScene还是Session。
2. 数据是普通值、Component、本地ChildEntity，还是需要跨Process寻址的Actor。
3. 谁创建、删除、保存，并负责清理Timer和外部句柄。
4. 谁能看到：自己、队伍、AOI还是全局。
5. 变化是Snapshot、可覆盖Latest、不可丢Event，还是无需网络同步。
6. 变化频率和持久化频率分别是多少。
7. TypeScript是否已经足够；只有明确性能或权威所有权收益时才进入Native。

安装TiangZ Developer Tools `v0.15.0`后，可执行“TiangZ：设计业务系统”、输入`@tiangz /design quest`，运行`tiangz-design`，或执行“TiangZ：运行 Runtime Foundation 自测”。CLI和向导使用确定性规则；聊天模型只负责解释。输出是设计起点，不会自动创建代码，也不能绕过目录依赖、Generated锁和验证命令。修改`docs/patterns`稳定规则时必须同步修改design-core并升级固定Tag；`npm run verify:design-rule-sync`只检查插件规则与文档登记是否同步，源码约束另外由`check:project`、`verify:hotfix-boundary`和各专项自测执行。

## Model与Hotfix怎么选

- 新增字段、默认值、构造参数、继承关系、Scene/Entity/Component类型：写`app/model`，完整构建并重启Process。
- 新增或修改Handler、校验、流程编排和领域方法实现：写`app/hotfix`，可使用Hotfix-only构建。
- Hotfix通过`@systemFor(ModelType)`提供生命周期和领域方法；System没有字段、构造函数或静态成员，也不会被实例化。
- Developer Tools 会把 `@systemFor`、`@hotfixFor`、网络 Handler 和 Scene Event Handler 中的字段、构造函数、静态块与静态方法直接标为错误（`tiangz.hotfix.instance-state`）。行为类只承载可热更方法；缓存、TimerId、索引和其他长期状态必须放到 Model 的 Entity/Component，日常修改先运行 `npm run verify:fast`。
- Model不手写“System未安装”的抛错空壳。codegen从System公开方法生成`app/generated/bootstrap/systems/*.d.ts`，调用方仍直接写`unit.Move()`或`component.UseItem()`。
- System公开方法必须显式写参数和返回类型。只改方法体可热更；修改公开签名会改变Model声明，必须完整构建并重启。
- `Awake/OnDestroy/Deserialize`都是可选能力。需要Hotfix承担某个生命周期时，Model使用`@lifecycle({ awake: true, destroy: true, deserialize: true })`只声明实际需要的项，System提供实现；未声明的钩子不要求空实现。`Awake/OnDestroy/Deserialize/CaptureTransfer/RestoreTransfer`都必须同步，既不能写`async`，也不能由普通函数返回Promise。`verify:runtime-contracts`在构建期检查，Hotfix提交在任何prototype或Handler变更前再次预检候选，运行时检查只是兜底。Reload不重跑现有对象的`Awake`；新对象使用新版本Awake，现有对象后续方法和销毁使用当前generation。
- `@transferable()`是迁移能力的唯一声明，同时要求Model自身或对应System提供同步`CaptureTransfer/RestoreTransfer`，不再重复写`transfer: true`。codegen缺方法会直接失败，Hotfix候选缺少Model已声明的方法会整包拒绝并保留旧generation。
- Model绝对不能在线热更，不设计字段migration。`npm run build:hotfix`拒绝时，说明这次改动已经越过行为边界，不能规避检查。
- `npm run build:hotfix`生成`dist/hotfix-candidates/<hash>`不可变候选，不覆盖当前Bundle。在Watcher终端输入`reload <候选目录>`才会触发每个Process独立校验和提交；禁止手工覆盖`dist/hotfix.js`。
- Hotfix候选必须重新注册当前generation的完整Handler集合；删除或重命名Handler必须完整构建并重启，不能通过“候选里省略”继续沿用旧入口。所有Scene/Session/Unit/Event Handler类都禁止字段、构造、静态初始化块和可变静态成员；状态写入目标Scene、Session、Unit或Component。

## 第一步：给需求分类

| 需求 | 默认落点 |
|---|---|
| 玩家能力、背包、技能、任务 | PlayerUnit上的业务Component |
| 地图规则、玩家集合、怪物刷新 | MapScene上的Component |
| 登录、Gate、排行榜、社交 | EntryScene和其Component |
| 一个网络入口 | 独立Handler文件 |
| 新请求或通知 | proto源文件，再codegen |
| 道具、地图、玩家模板等静态数值 | `game_config/Datas/*.xlsx`，再执行Luban codegen |
| 客户端收到Push后的行为 | 客户端独立Handler和领域Context |
| 可覆盖属性同步 | Delta/latest，通常FrameFlush |
| 不可丢事实 | Event，立即可靠排队 |
| 进入或重连 | Snapshot |
| 高频跨帧权威数据 | 先测量，再考虑`.native` |
| 网络、mailbox、背压 | Core/Rust维护任务，不是普通业务任务 |

## 怪物模块的最小做法

怪物业务默认采用“MapScene上的一个`MonsterComponent` + `UnitComponent`里的普通`MonsterUnit`”模型。`MonsterUnit extends Unit`，不声明`@actor`，不拥有mailbox；不要为每只怪物创建一个`MonsterActor`、Gate连接或独立V8，也不要在Handler收到请求后扫描所有地图找怪物。

```text
MonsterConfig                 怪物模板：模型、数值、攻击模式、复活时间
MonsterAreaConfig             固定刷怪槽：地图、坐标和初始是否生成
MapHost -> MapScene
  -> MonsterComponent          刷怪、AI、战斗、死亡和重生的唯一拥有者
      -> MonsterUnit            普通Unit，可被UnitComponent和AOI索引，无mailbox
```

开发流程：

1. 在`game_config/Datas`增加或修改模板、刷点，执行`npm run build:game-config`。
2. 需要新协议时先改`proto`，执行`npm run codegen:proto`，不要手写msgcode或Codec。
3. 稳定身份放`app/model/mmorpg/monster`，生命周期和行为放`app/hotfix/mmorpg/monster`。
4. Handler保持一层胶水，例如`C2M_AttackMonster -> PlayerUnit.AttackMonster -> MonsterComponent.Attack`。
5. 通过`MonsterComponent.Get/GetAll`取得怪物；死亡状态、AOI和重生只能由MonsterComponent完成。

当前最小模块的生命周期是“生成、主动索敌/仇恨追击、攻击、玩家攻击、死亡、刷怪槽重生、独立尸体清理”。死亡怪物先以`alive=false`保留原Unit和AOI身份，停止AI、移动和受击；有掉落的尸体保留5分钟，无掉落的尸体保留10秒，首个造成有效伤害的账号拥有普通掉落，归属账号领取完后可以提前清理。死亡时刷怪槽立即释放，`MonsterConfig.respawn_seconds`到期后在同一`AreaId`创建新的MonsterUnit和UnitId，不等待旧尸体窗口；旧尸体继续留在独立集合，清理时才执行`Detach`、AOI Leave和`Remove`。同一个掉落操作重试时由DBProxy回执恢复，不重新计算掉落。被动怪没有仇恨时不主动寻找玩家；平A和技能造成最终实际伤害后都必须通过`MonsterComponent.AddThreat`按1:1增加仇恨，5Hz桶按本地图最高仇恨者追击。12米只负责主动怪在无仇恨时索敌，不能过滤已有仇恨；脱战回出生点应另设冷配置，不能复用主动索敌距离。不能把“被攻击”直接等同于“追击”，也不能绕过`ApplyPlayerDamage`只调用Combat，否则会漏掉仇恨和死亡边界。掉落、技能、任务奖励和持久化是上层业务，应在这个闭环上追加Component或System，不要先改Core。

怪物只作为AOI Subject；进入视野用`MapEntitySnapshot(entityType=2, configId=MonsterConfig.id)`，死亡先通过`EntityState.alive=false`表现为尸体，尸体清理才通过AOI Leave移除旧Unit，复活通过AOI Enter发送新Unit的完整快照。需要不同观众看到不同字段时，新增Projection，不把权限判断写进通用AOI关系表。演示客户端可以读取冷配置中的`attack_mode`做非权威颜色提示：自己蓝色，其他玩家绿色，被动怪黄色，主动怪红色；业务逻辑仍必须以服务端配置和System为准。角色和怪物之间的动态阻挡、动态避障当前明确不做。

自动平A追加在玩家Unit上的`CombatComponent`，不新增`MonsterActor`、每玩家Timer或每玩家Update目标。固定桶分工如下：`Update()`为20Hz基础地图逻辑，`Update10Hz()`判定玩家平A是否开始/中断读条，`Update5Hz()`处理主动怪AI，`Update1Hz()`处理尸体清理和新Unit重生。业务不配置任意Hz；需要完整规则时参考[固定更新桶与自动平A设计](../design/auto-attack-and-fixed-update.md)。

玩家按`1`只是发送`C2M_ToggleAutoAttack`切换攻击意图。服务端要求目标存活、同一MapScene、距离不超过`PlayerConfig.attack_range`且处于角色前方120°，否则保持激活但把当前读条清零；再次满足条件必须从零开始。`G2C_AutoAttackState`只同步状态边界，并且是每个玩家本人频道上的`latest`可覆盖状态，不是不可丢失事件；客户端可以用服务器时间绘制读条，但不能自行结算命中。目标死亡、距离/朝向失效、玩家死亡或主动关闭会结束或重置平A，广播队列不会在固定次数后自动停止。攻击命中、道具消耗等不可逆事实仍使用`event`。目标、范围、朝向、伤害和仇恨都由Map的Hotfix System掌握；怪物攻击距离读取`MonsterConfig.attack_range`。

完整示例和文件位置见[怪物模块教程](../tutorials/16-monster-module.md)。

## 第二步：找到最接近的样例

- 玩家创建和组件装配：`app/model/mmorpg/map/MapComponent.ts::CreatePlayer`。
- 玩家Unit：`app/model/mmorpg/map/PlayerUnit.ts`。
- Unit RPC：`app/hotfix/mmorpg/mapHost/handlers/C2M_UseItemHandler.ts`。
- Unit Message：`app/hotfix/mmorpg/mapHost/handlers/C2M_MoveHandler.ts`。
- Session RPC：`app/hotfix/mmorpg/gate/handlers/C2G_LoginGateHandler.ts`。
- EntryScene RPC：`app/hotfix/mmorpg/mapHost/handlers/G2M_EnterMapHandler.ts`。
- Numeric字典Delta：`app/model/mmorpg/numeric/NumericComponent.ts`。
- Item即时Event：`app/model/mmorpg/item/ItemComponent.ts`、`app/hotfix/mmorpg/item/ItemComponentSystem.ts`和`C2M_UseItemHandler.ts`。
- 帧尾同步：`app/model/mmorpg/map/MapComponent.ts::FrameFlush`。
- 玩家下线保存：`app/model/mmorpg/persistence/PlayerPersistenceComponent.ts`。
- Model/System领域方法范例：`app/model/mmorpg/login/LoginComponent.ts`与`app/hotfix/mmorpg/login/LoginComponentSystem.ts`。
- 客户端Push：`../TiangZ-Examples/clients/cocos_client2D_3.8.6/assets/scripts/Demo/Map/Handlers`。
- Scene发现和调用：`app/core/process/SceneMessageHelper.ts`及`docs/guides/business-cookbook.md`。

先复用这些形状，不重新发明Manager、ServiceLocator或事件总线。

## 部署配置规则

日常本地开发只选择`configs/local/cluster/StartMachine.json`或`configs/local/all-in-one.json`。前者是支持Watcher与热更的多进程默认入口，后者在单一Process/V8中同时演示多Gate、静态地图和动态副本Host。新增独立Process时，在对应部署包目录中新增一个语义明确的JSON，并把文件名加入同目录的`StartMachine.json`。

`cluster/`中的`known-scenes.json`只保存多个Process共用、不可热更的稳定路由；`debug/`只保存Inspector等显式调试变体，不参与默认启动。不要在`local/`根目录再堆放临时Process JSON，不要在`all-in-one.json`中把本进程`scenes`重复写入`knownScenes`。压测、自测和传输实验分别进入`configs/bench`、`configs/tests`和`configs/experiments`。

## 游戏配置开发规则

静态策划配置统一维护在`game_config/Datas`，启动部署配置继续维护在`configs/<environment>`，两者不能混用。新增或修改配置时：

1. 在Excel中维护字段和值；新增整张表时同步登记`__tables__.xlsx`。
2. 用`##group`明确字段属于客户端`c`、服务端`s`或两端`c,s`；服务端秘密和校验数据不得为了省事发给客户端。
3. 跨表ID使用Luban `#ref`，让生成阶段拒绝悬空引用。
4. 纯数据变化如果准备重启服务器，执行完整 `npm run build` 并运行模块配置测试；如果要在线热更，执行`npm run build:game-config`并把候选目录交给 Watcher 的 `reload`（联合候选）；结构变化执行完整`npm run build`。
5. 服务端通过`GameConfigs`读取，客户端通过分发SDK中的同名入口读取；禁止直接读Excel/JSON、手改Generated或自行维护第二份配置缓存。

`PlayerConfig`表示创建玩家时的基础模板，不表示某个玩家升级后的等级、经验、当前生命或背包结果。运行时状态属于Entity/Component和持久化记录。配置对象与数组只读；`GetAll()`只用于低频初始化和管理流程，帧内热路径应按ID查询或预先建立明确索引。

技能业务统一调用`unit.GetComponent(SkillComponent).Cast({ skillId, targetUnitId })`；外网Handler应调用`PlayerUnit.CastSkill`，玩家Handler和怪物AI不得各写一套施法逻辑。SkillComponent只保存冷却deadline和一个ActiveCast；Cast不是Actor、Entity或Timer。地图唯一`SkillMapComponent`用10Hz桶推进活跃读条和弹道。施法期间`SkillComponent.IsCasting()`为真，平A只能保留攻击意图，不能继续推进读条；移动仍按技能配置决定是否中断。Demo中玩家受到一次没有被护盾吸收且没有被规避的有效攻击时，地图技能调度器把普通读条`finishAtMs`延后800ms；如果当前是引导，则把结束时间提前800ms，但不立即清除引导，二者都会广播新的`G2C_SkillCastState`。护盾完全吸收或`preventedReason`非零时，普通读条和引导时间都不调整。这不是通用Combat副作用，不能在Combat里查询Skill或Buff；攻击来源应使用`Combat.ApplyDamage`的结果决定是否调用施法惩罚边界。是否允许移动、何时重置平A均读取`SkillConfig`显式策略，不按技能名称或伤害类型猜测。目标选择、Cast时间线和Action效果必须分层：`SkillConfig.xlsx`描述施法规则，服务端`SkillEffectConfig.xlsx`描述有序Action，伤害/治疗进入Combat、Buff进入BuffComponent。`ChangeNumeric(CurrentHp, delta)`会被配置codegen、`ActionFromConfig`和运行时执行共同拒绝；HP增加必须使用`Heal`，HP减少必须使用`DealDamage`。配置Reload后，已接受的ActiveCast和Projectile继续使用冻结旧定义，新Cast读取新配置。第一阶段开放友方/敌方Unit目标和Instant/Cast，完整调用示例见[技能与施法系统设计](../design/skill-system.md)和[配置化技能教程](../tutorials/18-configured-skill.md)。

游戏配置的表名、字段、类型、分组、索引和引用关系属于 Model，改变后必须完整构建、重启相关 Process，并同步客户端 SDK。`build:game-config:startup` 执行完整构建；`build:game-config` 与 `build:hotfix` 相同，生成完整 Hotfix + 配置候选，通过 `reload` 在单个 Process 的现有帧间安全点一起提交或回滚。失败保留旧的整套版本。Reload 不重跑 Awake、不修改既有 Entity 状态；业务不要长期缓存配置行。客户端配置仍需独立发布，不能将服务端 Reload 当作客户端数据下发。详见[游戏配置教程](../tutorials/10-game-config.md)与[热更设计](../design/typescript-hot-reload.md)。

## 新增玩家Component

普通业务状态先写TS Component。生命周期声明属于不可热更Model，方法实现属于Hotfix System：

```ts
import { Component, component, lifecycle } from "../../core/public";

@component()
@lifecycle({ awake: true, destroy: true })
export class SkillComponent extends Component {
  protected readonly skills = new Set<number>();
}
```

对应`SkillComponentSystem`使用`@systemFor(SkillComponent)`实现`Awake/OnDestroy`和`AddSkill`等领域方法；Model只保留字段、继承与稳定声明。`@lifecycle`只写System必须实现的钩子，不要为了整齐把所有选项都设为`true`。

在玩家Factory中装配，而不是在Handler中临时添加：

```ts
player.AddComponent(SkillComponent);
```

使用时：

```ts
unit.GetComponent(SkillComponent).AddSkill(skillId);
```

约束：

- `Awake`只做同步初始化；声明了`awake`却缺少System实现时，生成失败。
- Component持有的定时器、订阅或句柄在`OnDestroy`释放。
- 纯数据组件不写空`OnDestroy`。
- `Deserialize`只在完整数据图恢复后重建Timer、索引和非序列化缓存；不读数据库，也不能返回Promise。
- `@transferable()`要求同步实现`ITransfer`；没有迁移需求的Component不要标记。
- 同类型组件只挂一个；可选依赖使用`TryGetComponent`。
- 不直接`new SkillComponent()`，必须走`AddComponent`，否则绕过生命周期和Update注册。

## Component下的多个业务对象

道具、任务和成就都遵循同一个所有权规则，但不强制使用相同的数据形状：

```text
PlayerUnit
├── ItemComponent          -> Item ChildEntity
├── BuffComponent          -> Buff ChildEntity
├── QuestComponent         -> 进行中的Quest ChildEntity + 已完成配置ID集合
└── AchievementComponent   -> AchievementState或动态Achievement ChildEntity
```

`XXXComponent`拥有集合并负责集合级操作。Core用`AddChild/GetChild/TryGetChild/GetChildren/RemoveChild`统一维护所有权、EntityRoot和销毁，不需要每个业务Component再写生命周期Map。`ChildEntity`带名义类型标记，编译期和Runtime都会拒绝把普通Unit传给`AddChild`。Entity不等于Actor：Item和Buff即使是Entity，也没有mailbox，不能作为跨Process消息目标。

```ts
const item = items.AddChild(Item, itemId, { configId, count });
const same = items.GetChild(Item, itemId);
const optional = items.TryGetChild(Item, itemId);
const snapshot = items.GetChildren(Item);
items.RemoveChild(Item, itemId);
```

`GetChildren`返回稳定数组快照，适合低频管理和持久化，不应在高频广播中每帧调用。高频路径由所属Component维护dirty集合或紧凑索引。

### 什么时候创建子Entity

满足以下任一条件时，优先使用有稳定实例ID的子Entity：

- 同一配置可能产生多个不同实例。
- 对象有强化、耐久、绑定、随机词条、锁定等独立状态。
- 对象有独立创建、销毁、持久化或计时生命周期。
- 其他领域需要稳定引用这个具体实例。

如果数据只由配置ID唯一确定，并且只有进度、状态或数量，优先使用普通State、Map、数组或Numeric。普通Quest和Achievement默认不创建Entity；可重复任务、动态任务实例或独立计时任务再升级。

### 查询对象，修改经过Component

读取一件道具时可以取得短期只读视图；当前Item实现本身就是ChildEntity，但调用者只依赖`ItemView`：

```ts
const items = unit.GetComponent(ItemComponent);
const item = items.GetItem(itemId);
if (item?.quality === 5) {
  // 只读取，不长期保存item。
}
```

集合操作必须经过拥有它的Component：

```ts
const changed = items.UseItem(itemId);
items.AddItem(itemId, 10);
items.RemoveItem(itemId, 2);
```

禁止：

```ts
// 错误：绕过数量校验、版本、持久化和客户端通知。
item.count -= 1;
```

道具自身的局部规则可以由Item方法实现，例如改变耐久或锁定状态；涉及集合所有权的新增、删除、拆分、合并、换格和转移始终由`ItemComponent`协调。跨Component业务由PlayerUnit领域方法或Handler协调，例如先让`ItemComponent`消费技能书，再调用`SkillComponent.AddSkill`，不要让SkillComponent直接删除背包数据。

`ItemView`只用于当前同步调用中的读取，不能跨`await`、Timer或玩家下线长期保存。协议和持久化边界分别复制为`ItemSnapshot`和`ItemRecord`；不要把运行时对象命名为`ItemDB`，也不要把可变Native句柄直接序列化。

前端背包只做快照投影：使用`ItemSnapshot.itemId`作为格子稳定键，使用`ItemConfig`补齐名称、说明和图标。上线、重连和进图使用`G2C_EnterMap.items`全量初始化，运行期间的使用、拾取、购买、出售和任务奖励都通过`G2C_ItemChanged`发送受影响的单行增量；拾取RPC的`M2C_LootMonster.items`也是本次增量，客户端按`ItemSnapshot.version`合并RPC与Push的重复到达。打开NPC商店时额外使用`M2C_OpenNpcShop.inventory`校正一次当前玩家的私有权威背包投影；这个快照只用于恢复客户端显示，不替代购买、出售时的服务端校验，也不把完整背包塞进普通拾取回包。快捷栏和完整背包必须复用同一个`C2M_UseItem(itemId, operationId)`入口；UI可以禁用按钮、显示冷却和排序，但不能本地扣数量、创建Item或伪造成功消息。移动端背包按钮和面板必须阻止触摸继续传给全屏镜头/寻路层。Cocos Creator 3.8.8 Web会错误降级`[...map.values()]`一类迭代器展开，集合展示必须使用`Array.from(...)`并通过`typecheck:cocos3d-demo`；出现“服务端有数据、UI为空”时必须检查构建后的`assets/main/index.js`，不能只看源码或网络回包。

当服务端判断请求使用、购买或出售的ItemId/数量已经过期时，业务错误响应可以携带可选`inventory_recovery`。该字段存在时，无论`items`是否为空，都代表一次权威整包替换；客户端应先应用快照再显示错误。只有状态冲突错误使用这个修复载荷，冷却、距离、金币不足等普通业务拒绝不应无条件发送整包。

## 编写Handler

Handler只负责协议适配、基础校验和调用领域能力。先按消息目标选择唯一对应的形状：

| 目标 | 装饰器 | Handler首个业务对象 |
|---|---|---|
| 配置Scene | `@rpcHandler/@messageHandler` | Scene |
| 客户端连接 | `@sessionRpcHandler/@sessionMessageHandler` | Scene、Session |
| 可直接寻址的玩家等ActorUnit | `@unitRpcHandler/@unitMessageHandler` | ActorUnit |

不要新增泛化`XxxActor`来承接普通业务请求。连接状态放Session，地图实体状态放Unit，全局业务状态放Scene或其Component。只有`ActorUnit + @actor`能注册Unit Handler并直接拿到目标Unit；普通MonsterUnit没有消息入口，客户端攻击请求先进入PlayerUnit，再调用地图`MonsterComponent`按UnitId取得怪物：

不要使用字符串`@handler`、`ProcessHost.call/send`或给Component动态注册网络入口；这些旧旁路已从Runtime移除。Scene间调用使用`SceneMessageHelper`，Session/Unit入口使用上表中的类型化Handler。

```ts
@unitRpcHandler(PlayerUnit, MapProtocol.UseItem)
export class C2M_UseItemHandler implements UnitRpcHandler<
  PlayerUnit,
  C2M_UseItem,
  M2C_UseItem
> {
  handle(unit: PlayerUnit, request: C2M_UseItem): Promise<M2C_UseItem> {
    return unit.GetComponent(ItemComponent).UseItemTransactional(
      request.itemId,
      request.operationId,
    );
  }
}
```

这里的Handler不发布Veto、不调用DBProxy、不解释Action，也不手工广播。`ItemComponent`拥有道具使用这一条领域用例，负责同步Veto、纯数据事务计划、持久化确认、Entity提交和领域通知；以后增加同类校验或效果时不要把编排重新堆回Handler。

不要这样做：

```ts
// 错误：已经得到Unit，又遍历所有地图查找玩家。
const unit = mapHost.findPlayer(request.account);
```

如果操作天然属于PlayerUnit，可增加简短领域方法协调多个Component：

```ts
UseSkillBook(itemId: number): void {
  const skillId = this.GetComponent(ItemComponent).UseSkillBook(itemId);
  this.GetComponent(SkillComponent).AddSkill(skillId);
}
```

不要增加只转发这一次调用的`UseItemSink`、`MapUnitEventSink`或Delegate。

## 新增协议

选择正确基类：

- 需要Response：`IRequest/IResponse`或`IActorLocationRequest/IActorLocationResponse`。
- 单向通知：`IMessage`、`IActorMessage`或`IActorLocationMessage`。
- 发给当前玩家Unit：优先ActorLocation类型。
- 服务端向客户端推送：`IMessage`，并声明`@ets.msg protocol=Client`。

示例：

```proto
//ResponseType M2C_UseSkill
// @ets.msg protocol=Map method=UseSkill
message C2M_UseSkill // IActorLocationRequest
{
  uint32 skill_id = 1;
}

message M2C_UseSkill // IActorLocationResponse
{
  uint32 skill_id = 1;
}
```

步骤：

1. 在正确proto源文件追加定义，不手工填写生成TS/Rust代码。
2. 评审消息类型、Response关联、字段编号和兼容性。
3. 新消息编号需要接受时，显式执行`npm run codegen:proto:update-lock`。
4. 执行`npm run codegen`。
5. 服务端只从`app/generated/model/server`导入；客户端、工具和压测客户端只从`client_sdk/typescript/Generated`导入。
6. C++/UE客户端只从`client_sdk/cpp/include/tiangz/generated`使用生成协议；UE插件中的ThirdParty副本由codegen覆盖，禁止手改msgcode、Codec或rpcId。
6. 执行`npm run test:protocol`和相关业务测试。
7. Godot客户端只通过`../TiangZ-Examples/clients/godot-3d-4.7.1/scripts/tiangz_client.gd`调用登录、RPC和Push；协议Codec由`npm run codegen:godot-client-sdk`生成到`scripts/generated/tiangz_proto.gd`，`main.gd`只做节点表现。Godot当前是WebSocket演示适配，不能自行补TCP/KCP或把Godot的`Vector3`写入协议。

不得手工修改`opcode.lock.json/schema.lock.json`来绕过生成器，也不得在业务代码中硬编码msgcode、rpcId或codec。

## EntryScene、动态Scene、Unit和ActorUnit怎么选

使用EntryScene的情况：

- 需要配置启动和跨进程寻址。
- 是独立的顶层业务域，例如Rank、Social、Gate、MapHost。
- 需要部署多个实例并由Directory或业务负载均衡。

使用动态Scene的情况：

- 地图实例、副本实例等进程内业务容器。
- 大量低负载实例需要共享一个Process/V8。

使用普通Unit的情况：

- 对象属于地图，需要UnitId、Component、AOI和完整生命周期。
- 它由地图Component批量更新，不需要其他Scene按InstanceId直接投递消息。
- 典型对象是MonsterUnit和批量NPC。

使用ActorUnit的情况：

- 消息需要以某个Entity为串行和生命周期边界。
- 其他Scene或Gate需要按InstanceId直接投递类型化Unit消息。
- 典型对象是`PlayerUnit extends ActorUnit`并声明`@actor({ mailbox: "ordered" })`。

使用Component的情况：

- 给Scene或Unit组合一项状态和领域能力。
- 它不需要成为独立部署和网络寻址边界。

不要为每张地图、每只怪物、每个组件创建EntryScene。

### 地图坐标与空间模式

服务端和公共客户端SDK只使用引擎无关的米制`x/y/z/yaw`：X/Z是地面平面，Y是高度，Yaw是绕Y轴弧度，Yaw=0朝+Z，前向量为`(sin(Yaw),0,cos(Yaw))`。任何位置都必须同时知道`MapInstanceId`；不得把Cocos `Vec3`、Unity `Vector3/float3`、UE `FVector/FRotator`或屏幕像素写进协议、Native数据或地图业务。UE业务变量必须明确保存TiangZ Yaw，只在Actor表现边界换算成`90°-TiangZYaw`，不得把`FRotator::Yaw`回传。

Grid2D业务使用`cellX/cellZ`和`inputX/inputZ`。Cocos 2D与Pixi在客户端边界将服务端X/Z映射为屏幕X/Y，服务端Y通常为零；3D客户端直接把普通数值转换为引擎向量。禁止再次引入`cellY/inputY`表示地面纵轴，否则2D与3D地图会产生相反语义。

Grid2D客户端只上报移动意图：按下、转向和松开立即发送，按住不变时每`500ms`发送一次保活，静止时不周期发送。窗口隐藏、浏览器失焦和地图销毁必须立即清除按键并发送停止。业务不得把这项`2Hz`输入心跳当成服务端模拟频率；权威移动仍由20Hz Game.Update推进，AOI下行和渲染平滑各自独立。`C2M_MapProbe`只用于测量完整Actor RPC链路延迟，容量基线默认每5秒一次；`C2G_Ping`是Gate存活探测，也固定每5秒一次，不能用二者替代移动或游戏Tick。

Cell是最小空间单位：Grid2D一步移动一个Cell，NavMesh3D允许在Cell内连续移动。AOI只按Grid边界重算，默认15×15 Cell组成一个Grid；Grid从地图最小Cell开始编号，地图宽高必须是Grid边长的整数倍。默认3×3既是Enter区域，也是20Hz高频区；已可见关系移到5×5外圈后降为5Hz，5×5同时是Detach迟滞边界，越界立即Leave。外圈不会让一个从未Enter的单位直接可见，不再保留7×7或1Hz档位。

Enter、Detach和同步频率不是代码常量。开发者在`AoiConfig.xlsx`配置Enter/Detach，在`AoiSyncTierConfig.xlsx`为同一`aoi_config_id`填写任意数量的奇数范围与同步Hz；最外层同步范围必须等于Detach。需要`7×7/1Hz`时，将Detach改为7并增加对应档位即可，不修改Rust或TS。两张表都是Cold配置，必须重新生成并重启，禁止热更。

Cell和AOI Grid尺寸同样属于Cold配置：`MapConfig.cell_size_meters`定义一个Cell的米制边长，`AoiConfig.grid_size_cells`定义每个Grid每条边包含多少Cell。地图制作决定物理宽深并导出为`width_cells/depth_cells`；Grid数量由宽深Cell数除以`grid_size_cells`推导，不另设可冲突的`grid_count`。宽深不能整除时必须调整Cell/Grid划分或在制作阶段显式补边。

容量验收不能只测单一地图密度。框架基线固定用`npm run perf:map-capacity:grid-matrix`比较3000人在10×10、15×15、20×20 Grid中的均匀分布，保持80% Grid内移动、20%每2秒跨Grid以及消息频率不变。业务新增地图时应按实际平均人数/Grid选择最接近的结果，不得把稀疏世界结果当作主城同屏容量。进图并发属于初始化压力，必须受控并与正式稳态窗口分开解读。

创建地图前先从`GameConfigs.MapConfig`读取`spatialMode`。`Grid2D`与`NavMesh3D` Map Runtime均已可创建；NavMesh3D业务通过`MapComponent.ProjectPosition/FindPath`查询，通过`PlayerUnit.NavigateTo`提交权威移动目标，不读取Detour句柄、不逐节点跨V8，也不能捕获导航错误后回退到Grid2D。空间模式、字段结构、Agent烘焙参数和导航资源身份属于Model发布边界；改变正在运行地图的空间实现需要重启Process并重建MapInstance。

动态障碍必须由Map业务使用稳定`ObstacleId`调用`MapComponent.UpsertNavigationBoxObstacle/RemoveNavigationObstacle`，并传入门或路障的真实物理尺寸；Rust会按导航资源烘焙的`agentRadius`自动扩大X/Z占用，业务禁止手工重复增加半径。这里的动态障碍只包括门、路障等业务物体，不包括玩家、怪物、NPC之间的动态阻挡和动态避让；角色之间可以在表现层重叠或由业务技能规则处理，但不进入权威NavMesh TileCache。客户端只能发送业务意图并根据服务端结果更新表现。Cocos、UE或其他引擎中的门模型和碰撞体都不是权威导航数据；禁止客户端先改门状态后补发请求，也禁止用引擎本地寻路结果替代Rust TileCache。Cocos可以为本地预测增加非权威的视觉约束，UE等只插值权威位置的客户端不需要复制碰撞。Cocos 3D与UE灰盒的`E`键动态门是这一调用边界的演示。

导航源网格由制作工具导出到`navigation/maps/<map>/source`，开发者只维护冷清单并执行`npm run navigation:bake`，不得在TS Handler、Game.Update或服务器启动流程中调用烘焙。`C2M_FindPath`是无副作用查询；`C2M_NavigateTo`的Handler只调用`unit.NavigateTo(request)`，方向移动的Handler只调用`unit.NavigateInput(request)`。点击移动由Rust保存路径走廊，在拐点先连续转身再消费剩余Tick时间移动；方向移动先在PlayerUnit mailbox中用`DirectionalMovementProfileComponent`选择服务端有效速度，再由Rust保存输入、1.5秒租约和polygon引用并在固定Tick调用`moveAlongSurface`。客户端的点击预测必须使用相同转向规则，方向输入每500ms续期，零方向输入必须立即停止，断续期也会自动停止。客户端表现层应分别保存权威、可视角色和本地相机朝向；活跃路径预测期间权威Push只能更新校正目标，不能直接覆盖可视朝向，预测结束后再平滑收敛。相机只能按最短角度追随，不能写回权威状态，也不能对角色两侧的摄像机目标位置直接做XYZ插值。客户端可以保存按键和预测路径，以`G2C_EntityNavigate`校正，但业务不得在TS复制权威路径进度或坐标。业务可通过`MapComponent.Raycast/SampleHeight`做NavMesh边界和地面查询，不能把Raycast当成角色物理碰撞。技能冲锋、AI移动等新意图应复用Unit入口或增加同层粗粒度操作，不能在Handler手写逐Tick位移。Demo灰盒是工具与客户端回归输入，不要求程序员手工制作正式3D地图。

门、升降桥和临时路障使用地图内稳定`ObstacleId`，业务调用`map.UpsertNavigationBoxObstacle(id, { center, halfExtents, yawRadians })`与`map.RemoveNavigationObstacle(id)`，不读取或保存Detour引用。相同ID代表同一个业务对象，重复提交相同最终状态必须依赖框架幂等，不要先Remove再Add模拟更新。框架在固定Tick限额提交命令和重建Tile，Handler只提交一次意图，禁止循环等待`upToDate`。完成后Rust会自动重算尚未结束的点击路径；方向输入直接使用新表面。障碍只属于当前MapInstance，同模板副本互不影响，Map销毁自动释放。障碍几何、稳定ID来源、权限、持久化和客户端门表现仍由业务Component负责；`C2M_ToggleDemoDoor`仅用于Cocos灰盒验收，不是正式通用协议。

动态障碍的客户端表现必须采用两步同步：地图进入完成后，`MapSnapshotReady`响应提供当前状态；状态变化后，Map再向该地图所有在线玩家发送状态事件。不能只把状态放在发起者的`M2C`响应中，否则第二个玩家可能看不到门，但服务端导航已经把门当作阻挡。客户端只更新模型显示，不复制Rust TileCache或本地权威碰撞；正式业务应把这套模式封装在自己的Map/Obstacle业务组件中。

详细字段、Rust所有权和客户端进入校验见[地图空间与3D坐标契约](../design/spatial-world.md)。

### 玩家地图传送

静态地图与动态副本都只调用：

```ts
await player.TransferToMap(targetMapInstanceId);
```

业务不得传MapHost、IP、端口或判断目标是否同进程。静态地图的`MapInstanceId == MapConfigId`；动态副本调用`DynamicMapProxy.Create(requestId, mapConfigId)`。`requestId`必须稳定标识一次业务尝试，例如`teamId + dungeonId + attemptId`；网络超时重试必须复用它，新一轮副本必须换新ID，同一ID不得改用其他MapConfig。MapManager选择宿主并返回全局实例号，业务随后只保存并传递实例号。Gate先打开Actor迁移屏障，再由源PlayerUnit mailbox解析实例路由，协调Location锁、目标Unit恢复、位置提交和源Actor清理。迁移保持UnitId，使用目标`MapConfig`出生点，Actor InstanceId与Location revision必须更新。客户端收到RPC和`MapReady`后销毁旧地图作用域Dispatcher，再用`G2C_EnterMap`全量快照重建视图。

MapHost配置静态地图：

```json
{
  "name": "map_1",
  "sceneType": "MapHost",
  "staticMapIds": [1, 3],
  "innerIp": "127.0.0.1",
  "port": 7301
}
```

启动时MapHost逐个调用统一`CreateMap`并向Location注册实际实例。只有`acceptDynamicMaps=true`的Host向单例MapManager注册自身地址、generation、负载和动态创建关系；`staticMapIds`与该开关可组合为静态专用、动态专用或混合承载。Manager与Location共享同一个MapHost generation和15秒租约，MapHost每5秒续租；超时Host不再获得新实例。单独重启Manager时，存活MapHost重发完整创建关系。Manager与动态MapHost双失时，Location删除过期动态路由和旧玩家Actor路由，Gate重连后进入PlayerConfig初始静态地图；同一旧requestId不能静默创建第二份副本。MapInstance与PlayerLocation响应携带MapHost Endpoint，业务不得再用`scenes.byName(dynamicHostName)`。连续无人五分钟自动销毁由MapHost本地`DynamicMapLifecycleComponent`提供，只是业务兜底策略。

地图停机和主动销毁有固定的清理顺序：`MapHostScene.onStop -> MapHostComponent.Shutdown/DisposeMap -> MapComponent.Shutdown/PrepareForDespawn`。静态、动态地图共用这套本地流程：先保存并移除玩家，再清理所有剩余Unit（包括怪物和等待进图的玩家）；每个仍在AOI中的Unit必须先`Detach`，然后通过`UnitComponent.Remove`销毁。该入口会为普通Unit清理本地所有权，为ActorUnit额外清理Actor路由和mailbox，最后才由Scene组件释放AOI。动态地图的Scene本地销毁成功后，MapHost再通过`MapHostControl.DynamicMapDisposed`通知MapManager减少动态实例负载；通知是幂等的，Manager暂时不可用时由MapHostRegistration重试。`ProcessHost`是通用运行时，不知道AOI，不要在业务中直接调用底层Scene销毁来绕过这个入口；`await map.Dispose()`也不会替业务把仍在地图中的玩家强制踢到别处。

稳定基础Scene集中写入共享`knownSceneFiles`；新增动态副本Host只引用该文件，禁止要求所有Gate/MapHost反向追加它。共享文件不可热更，只负责启动依赖；MapManager注册才负责动态发现。完整样例见`configs/local/cluster/known-scenes.json`和`configs/local/cluster/dungeon-1.json`。

完整开发步骤与代码示例见[地图实例与动态副本教程](../tutorials/11-map-instance-and-dungeon.md)。

Component迁移遵循显式选择：默认不迁移，只有稳定Model类型加`@transferable()`并实现同步`ITransfer<TState>`才会参加。`@transferable()`本身就是稳定能力声明，生成器会检查`CaptureTransfer/RestoreTransfer`是否位于Model或对应`@systemFor`实现中；运行时仍保留最后一道防线。`CaptureTransfer`必须返回脱离旧Entity和Native handle的值快照，`RestoreTransfer`写入目标Factory已经创建的同类型Component，两者都不能返回Promise。当前Numeric与Item迁移完整业务值；Position只迁移速度、朝向和存活，故意不迁移旧坐标与移动中间态；Gate绑定、Persistence和Native handle由目标Factory重建。临时仇恨、施法过程、副本局部状态等组件不加标记即可丢弃。

`RestoreTransfer`只恢复权威数据，不负责恢复后的运行时加工。需要重建Timer、派生字典、配置缓存或索引的Component，在Model声明`@lifecycle({ deserialize: true })`，并在Hotfix System实现同步`IDeserialize.Deserialize()`。Entity会先恢复所有可传送Component，再统一调用这些Component的`Deserialize`；持久化加载器以后也复用`CompleteDeserialize()`调用同一生命周期。以Buff为例：传送快照保存Buff及结束时间，`RestoreTransfer`重建Buff数据，`Deserialize`根据剩余时间移除过期Buff或重新注册Timer。框架只保证完整数据图之后、Entity发布之前调用一次，不包含任何Buff规则；`Deserialize`不得再次访问数据库、返回Promise或依赖尚未恢复的外部Entity。

Entity迁移快照只用于一次进程内迁移，不能长期缓存、写数据库或当作跨进程协议。跨MapHost使用稳定protobuf `PlayerTransferSnapshot`和`MapTransfer.Prepare/Commit/Abort`；Location以revision和operationId保护唯一权威地址，Gate的有界屏障按Proto `duringTransfer`处理并发Actor消息。必须执行一次的RPC标记`queue`，查询类可标记`reject`，可覆盖单向状态使用`drop/latest`。业务代码不得扫描所有MapHost、不得把本地`PlayerDirectoryComponent`当全局目录，也不得手写msgcode分支控制迁移。完整语义见[Entity地图迁移](../design/entity-transfer.md)和[Location路由](../design/location-routing.md)。

给PlayerUnit新增需要跨图保留的Component时，除了实现`CaptureTransfer/RestoreTransfer`，还必须扩展`PlayerTransferSnapshot`并升级`PLAYER_TRANSFER_SCHEMA_VERSION`。临时召唤物不是PlayerUnit持久Component，但若要随玩家跨图，必须使用只含中立数值的`OwnedSummonTransferSnapshot`；目标槽位为空，恢复批次失败必须撤销已创建Unit，并由目标候选Owner的回滚路径兜底。快照生成和目标校验只能引用这个共同常量，不得各写一个数字；验收至少包含Map1到Map2的真实跨MapHost传送，否则同进程内普通玩法测试发现不了版本不一致。重新登录仍不能复用该临时快照。

只知道UnitId的服务端业务使用`new MessageHelper(this.scenes).CallUnit/SendUnit`。已经持有PlayerUnit或明确Actor地址时直接调用；普通Gate转发使用连接路由缓存，不查询Location。公会等批量扇出先`ResolveUnits`，再按MapHost/Gate聚合，禁止循环调用单Unit Location RPC。

## Scene调用规则

```ts
// 全局恰好一个实例
await this.scenes.callOne("Rank", RankProtocol.Query, request);

// 多实例，业务选择具体目标
const gates = this.scenes.many("Gate");
const gate = chooseGate(gates, account);
await this.scenes.call(gate, GateProtocol.Bind, request);

// 已保存实例名
await this.scenes.send(
  this.scenes.byName(player.gateName),
  GateMessages.MapReady,
  message,
);
```

- 不在业务代码中判断目标是否同进程。
- `callOne`只用于配置上恰好一个实例的SceneType。
- 多实例必须先明确负载均衡、归属或Location结果。
- `send`成功只表示被本地mailbox接受或进入远程发送队列，不表示目标Handler执行完成。
- 框架自动分配并保留在途`rpcId`；业务不得写入、缓存或复用它。只有确实需要deadline时才传`{ timeoutMs }`，本地默认不为每次调用创建额外timer。
- Actor跨`await`后如果可能已下线或销毁，应检查`IsDisposed`或重新验证权威句柄；JavaScript Promise不能被框架强制终止。
- 账号重进若与旧实例销毁交叠，应重新查询账号目录，禁止继续使用先前缓存的Unit引用。

## 选择Snapshot、Delta或Event

先问一句：如果同一个key连续变化两次，只收到最终值是否仍然正确？

- 正确：Delta/latest，例如位置、朝向、HP最终值、速度。
- 不正确：Event，例如使用两次道具、两次技能命中、获得两份奖励。
- 新观察者需要完整当前状态：Snapshot。

### Numeric动态字典

适合开发者维护稳定整数枚举的数值。创建时也直接传`NumericType -> bigint`字典，不要为每个数值再设计一个参数字段：

```ts
const initial: NumericInitialValues = {};
initial[NumericType.MaxHpBase] = BigInt(config.maxHp);
initial[NumericType.CurrentHp] = BigInt(config.maxHp);
monster.AddComponent(NumericComponent, initial);

const numeric = unit.GetComponent(NumericComponent);
numeric[NumericType.CurrentHp] += 1n;
```

Rust自动维护`NumericType -> i64`值与dirty表，TS使用`bigint`，业务字面量应写`1n`。`NumericComponentSystem.Awake`只遍历创建者传入的初始化字典，未传入的普通属性保持Rust默认值`0`；因此玩家、怪物、NPC的默认值应写在各自的创建流程，而不是塞回通用Numeric系统。初始化字典的类型别名不会随着Numeric字段增长而修改；普通属性和Base/Add/Pct来源可以写，`MaxHp`、`Attack`等1000..9999派生结果不能写，错误的key或非`bigint`值会在创建时失败。`1..999`是普通属性；`1000..9999`是只读派生结果；结果编号乘10后加`1/2/3`分别表示Base/Add/Pct。Rust只识别编号关系，不重复维护业务枚举。当前`CurrentHp=1`、`CurrentMp=2`、`MaxHp=1000`、`Attack=2000`、`AttackSpeed=2001`、`MoveSpeed=3000`，对应来源按结果编号乘10加`1/2/3`生成，公式为`(Base+Add)*(100+Pct)/100`。`AttackSpeed`表示每次攻击间隔毫秒，`MoveSpeed`的Numeric单位是毫米/秒，配置表仍填写米/秒。写来源时Rust先计算后原子提交，来源和变化后的结果分别标脏；直接写派生结果会被拒绝。新增同类属性只改TS编号，复杂跨属性公式应写独立Rust领域op。Numeric协议使用`int64`，FrameFlush按`(unitId, numericType)`合并。复制可见性默认Owner-only；只有`NumericReplication.ts`白名单中的公开类型进入AOI受众，当前公开`CurrentHp/MaxHp/Level`。新增Numeric时必须先判断其他玩家是否确实需要它，不能为了省事把MP、经验、攻击或Base/Add/Pct来源加入公开列表。AOI进入快照与增量使用同一公开投影，Owner登录/重连快照保留全量值。

主属性结果编号为`1002..1006`，来源编号仍按上述约定生成，例如`StrengthBase=10021`。内容包应写Base而不是派生结果；Buff等临时效果写Add/Pct。主属性默认保持Owner-only，协议适配器需要展示时只投影本人的派生结果，不应把其他玩家的私有属性加入AOI白名单。

玩家初始魔法值由冷配置`PlayerConfig.initial_mp/max_mp`共同决定当前值和上限；当前演示模板两者均为`200`，因此新玩家进入地图时显示`200/200`，不要在创建逻辑中另写一套默认值。

用`npm run perf:numeric`评估派生计算本身。默认业务仍使用清晰的单字段写入；只有基准和真实业务Profile都证明同一逻辑点会集中修改多个来源时，才考虑新增一次提交多个来源的粗粒度op，不能为了微基准数字强迫所有业务使用批量API。

### 固定字段Dirty Mask

适合字段集合稳定且类型明确的状态，例如Unit速度、存活和显式传送坐标。在`.native`中使用`@replicated`和稳定`@memberId`，codegen生成setter置脏、强类型Delta和Peek/Ack。

普通业务不得仅为了少写TS就选择Native字段。只有权威状态确实需要Rust保存、批量计算或直接编码时才使用。

`.native`是生成器输入。普通业务Entity放在`native_data/<game>`；只有确实需要跨边界粗粒度批处理时，才在同目录新增`XxxOps.native`并实现对应Rust op。`native_data/core`属于框架ABI，业务不得修改。移动等确定性状态机的黄金数据放`tests/fixtures`，不能放进`native_data`伪装成模型定义。

### Rust业务模块目录

开发者明确选择Rust实现的稳定、高负载领域统一放在`src/game/<domain>/`，例如`src/game/buff/`、`src/game/combat/`。`.native`只描述Entity数据和op ABI；`src/game`实现规则、批处理和协议投影。`src/native_data.rs`拥有句柄目录、类型Pool、脏版本和受控存储访问，不再接收新的Buff、技能或战斗业务实现。若业务缺少必要的Store能力，应先增加窄而明确的框架访问函数，禁止把`NativeEntityStore`整体公开给业务模块。

Rust模块随Process编译，不能Hotfix。选择它必须同时满足：状态或算法有明确性能收益、规则相对稳定、能够接受重新构建和重启。活动、任务编排和频繁调整的规则仍优先使用TS Hotfix。

Actor消息不能因为Handler算法位于Rust就绕过TS。正式链路保持`TS定位ActorUnit/Session/Scene -> Actor mailbox -> Native op -> Rust领域模块`；薄适配层可以由codegen生成，但Location、传送屏障、RPC错误和mailbox顺序仍由TS框架拥有。普通MonsterUnit没有Actor入口，它由Map Handler或所属MonsterComponent进入Rust批处理。只有Ping、握手等不访问业务Actor的基础设施控制帧允许在Rust网络入口直接消费。

### Item等即时Event

库存、技能命中和奖励是不可覆盖事实。修改权威状态后立即发布event；如果同一次操作还改变可覆盖属性，例如速度，则该属性继续走帧尾Delta。

`ItemComponent`通过Core子Entity容器拥有`Item`；每个Item内部持有自己的`NativeItemRef`，其InstanceId与子Entity真实生命周期一致，不再由ItemComponent伪造ID。外部读取使用`GetItem`返回的`ItemView`，集合修改使用Component领域方法，Item局部状态修改使用Item领域方法；只有对应System可以直接操作可变Native句柄。

### Buff与AOI

Buff作为ChildEntity只解决身份、生命周期、热更方法和Timer归属，不负责选择网络接收者，也不使用通用dirty字段同步：

```text
创建Buff -> 给使用者回显M2C_UseItem.buff，并向当前AOI广播BuffAdded
Buff Tick -> 执行Action -> Numeric/Move/其他领域各自同步
删除Buff -> 向当前AOI广播BuffRemoved
进入AOI -> Buff列表随Unit整体Snapshot发送
离开AOI -> 移除Unit，不逐个发送BuffRemoved
```

- Buff创建和删除是不可覆盖的生命周期Event，分别广播一次Add/Remove。
- `BuffPublicView`只放外观、层数和结束时间；吸收量等受限数据放`BuffDetailView`，禁止用`0`伪装“无权限”。
- 公开事件发送给`AOI观察者 ∪ 队伍`，详情状态发送给`自己 ∪ 队伍`；`ClientAudience.Union`按UnitId去重，同一玩家不会收到两份。
- `G2C_BuffDetail`是以`(unitId,buffInstanceId)`为key的latest状态，同帧多次扣盾只保留最终吸收量；Add/Remove绝不能改成latest。
- Tick不修改或广播Buff本身，只执行Action；Action修改哪个领域，就复用哪个领域已有的同步机制。
- Buff冲突由`stack_group + stack_scope + sourceUnitId`形成稳定冲突键，再由`conflict_policy`决定Stack、Refresh、Replace、Reject或HigherWins。不要用`unique`布尔值或ConfigId大小硬编码。Refresh默认不重复执行AddAction；是否更新来源、Tick节奏和运行状态只读对应配置列。
- 客户端从BuffAdded或Unit Snapshot携带的开始/结束时间自行计算剩余时间，服务端不逐Tick同步倒计时。
- 进入AOI时Buff列表包含在Unit整体Snapshot中；离开AOI时Unit整体消失，不逐个发送BuffRemoved。
- 不扫描EntityRoot收集Buff，也不让每个Buff成为Actor。未来AOI直接从目标Unit的BuffComponent取得快照。
- 少量Buff允许使用`Buff.NewOnceTimer/NewRepeatedTimer`；大量Buff推荐在BuffComponent保存`nextTickAt/expireAt`，使用最小堆和一个最近到期Timer统一调度。持久化保存时间戳，不保存TimerId。

如果未来出现层数刷新、图标变化等确实需要客户端立即知道的Buff元数据变化，应新增明确的`BuffUpdated`事件，或者将旧Buff Remove后重新Add；不要为了少数需求让全部Buff每帧维护dirty和Delta。

### 战斗伤害与效果解耦

受到伤害不能反向调用`BuffComponent`。目标Unit统一挂载`CombatComponent`，攻击者只负责选择目标并提交`DamageRequest`：

```text
Monster / Skill / Action
  -> target.GetComponent(CombatComponent).ApplyDamage(request)
  -> 显式可规避请求先执行CombatEvents.BeforeDamage同步只读检查
  -> CombatComponent执行目标侧倍率与已注册护盾
  -> 剩余伤害修改Numeric.CurrentHp
  -> 返回DamageResult
```

`CombatComponent`负责目标本身的伤害、治疗、护盾消耗、死亡标记和结果；不负责找目标、距离、朝向、AI、重生、AOI或Gate。`MonsterComponent`、技能System和Action只负责攻击者侧规则，不能直接写`CurrentHp`。道具回血统一调用`ApplyHealing`，治疗上限和死亡限制由CombatComponent处理。

地图中任意 Unit 来源的玩家伤害应进入 `MapComponent.ApplyDamageToPlayer`。Monster/NPC 先处理自己的仇恨，再调用该入口；环境机关和外置模块可直接使用来源 Unit，但不能自行复制扣血后的施法打断、死亡清战斗、耐久损耗和私有结果广播。伤害数值、范围、周期和来源语义仍由领域配置拥有。

持续减伤优先使用Numeric的目标侧派生倍率，而不是为每个Buff注册一段伤害回调：`IncomingDamageMultiplier`作用于全部伤害，`PhysicalDamageMultiplier`只作用于物理伤害，二者按1000制相乘并在进入护盾前结算。玩家/怪物Profile应显式初始化两个Base为1000；仅为兼容旧Entity，Base/Add/Pct三项全0时才按1000处理。游戏模块可用Buff的`ChangeNumeric`动作增减Pct，但Core中禁止出现具体职业、法术、护甲曲线或光环范围判断。需要依赖单次命中上下文或消耗独立容量的机制，才注册明确的受伤处理器。

攻击来源只有在确实属于可规避的一次命中时才设置`canBePrevented: true`。Combat随后以`CombatEvents.BeforeDamage`发布只读的目标、冻结请求和Unit本地`attemptSequence`；模块返回`0`放行，返回非零不透明原因则在倍率、护盾和扣血前结束。Veto Handler不得消耗资源、修改Buff/Numeric或启动异步任务；具体命中率、朝向、装备与状态判定属于外置游戏模块。`DamageResult.preventedReason`及私有`G2C_CombatResult.preventedReason`只负责把结果交给协议适配器，Core不维护任何游戏的命中结果枚举。

护盾Buff添加时调用`RegisterDamageAbsorber`并保存返回的`modifierId`，Buff删除或过期时调用`RemoveDamageAbsorber`。伤害入口不查询Buff，也不调用`TryAbsorbDamage`。护盾剩余量以Combat注册处理器为权威，Buff不与Combat各维护一份会分叉的副本；需要持久化或投影时通过ID读取或更新。

```ts
const combat = unit.GetComponent(CombatComponent);
const modifierId = combat.RegisterDamageAbsorber(5_000n, 100);
const result = combat.ApplyDamage({
  amount: 300n,
  sourceUnitId: attacker.UnitId,
  canBePrevented: true,
});
combat.RemoveDamageAbsorber(modifierId);
```

Numeric HP是可覆盖状态：旁观者走1Hz帧尾latest；受击者和有效攻击者走只含参与者的私有`G2C_CombatResult`即时事件，收到精确CurrentHp、实际伤害/治疗和`serverTick`。技能命中、死亡、掉落和道具消耗是不可覆盖事实，走event。Combat不选择广播受众，Buff公开外观和受限详情继续沿用前面的AOI Projection规则。完整调用关系、生命周期和禁用示例见[战斗伤害与效果管线](../design/combat-damage-pipeline.md)。

### Quest生命周期与可见范围

任务系统区分“正在进行的实例”和“已经完成的事实”：

```text
QuestComponent
├── activeQuests: Quest ChildEntity集合
└── completedQuestConfigIds: Set/Bitmap
```

- 玩家没有进行中任务时，QuestComponent可以不包含任何Quest子Entity。
- 接受任务时通过`QuestComponent.AcceptQuest(questConfigId)`创建进行中实例；当前不可重复任务直接以`BigInt(questConfigId)`作为Child ID。
- 活动Quest状态只有`InProgress`和`ReadyToTurnIn`；达到要求只切换为待交付，领取奖励成功后才写完成集合并移除ChildEntity。`ReadyToTurnIn`不能从任务追踪面板直接领奖，必须在NPC交互范围内提交NPC实例ID，由服务端再次校验。
- 接取时冻结`objectiveId/current/required`。热配置切换只影响新接取任务，不能让进行中的要求数量漂移。
- 怪物、道具和地图只在事实成功提交后同步发布`QuestEvents.Progress`；稳定事件Handler负责调用`ApplyProgress`。`QuestComponent`按`(objectiveType,targetConfigId)`运行时索引定位目标，来源模块禁止遍历Quest或直接改进度。索引只保存稳定ID并在接取、领奖、Deserialize和RestoreTransfer时维护，不能进入持久化快照。
- 接取前统一执行同步`QuestEvents.BeforeAccept` Veto；前置任务和最低等级是配置最终不变量，阵营、职业、NPC关系等扩展条件注册独立监听器。Veto只能读内存和返回错误码，禁止Promise、RPC、数据库、修改Entity或Spawn后台任务。
- 进度变化通过owner-only `G2C_QuestProgress`通知拥有者客户端，并按QuestConfigId在同帧latest合并，不广播给普通地图观察者。
- 只有组队共享任务明确需要时，才向`PartyAudience`发送必要的进度摘要；不要把完整Quest对象发送给队友。
- 完成时由`QuestComponent.CompleteQuest`在PlayerUnit有序mailbox内等待一次关键事务：Inventory先生成纯数据计划，DBProxy提交奖励后的玩家记录和业务结果，成功后再写入Item/已完成Quest并`RemoveChild`；Handler只负责RPC与提交后的奖励同步，不能直接访问Repository或把步骤拆散。
- 登录或重连时向本人发送活动Quest和已完成摘要的全量快照。队友进入AOI时，可随Unit整体Snapshot取得允许共享的任务摘要；普通观察者的Unit快照不包含Quest。离开AOI时只移除Unit。

如果同一配置任务不会同时存在多个活动实例，可以直接用配置ID作为ChildEntity Id；可重复任务、限时活动任务等允许并存时，必须使用独立Quest实例ID，并单独保存`configId`。已完成集合始终记录稳定配置ID，不保存已经销毁的InstanceId。

当前配置入口为`QuestConfig.xlsx`和`QuestObjectiveConfig.xlsx`，奖励复用Action；`required_quest_ids`和`minimum_level`声明基础接取条件。演示目标覆盖击杀怪物、使用道具和进入地图；Starter任务链为5001击杀5只怪A，NPC交付后按`required_quest_ids=[5001]`解锁5005击杀5只怪B。5004继续验证“完成5001且达到2级”。`GrantItem(ItemConfigId, Count)`和`GrantItems(...)`必须通过Inventory，由Inventory填充已有堆叠并按`max_stack`拆分新Item。普通同步奖励仍可使用`ExecuteReward`；关键任务奖励使用`PlanTransactionalReward -> ItemComponent.PlanGrantItems -> PlayerPersistenceComponent.ApplyTransaction -> CommitGrantPlan`。规划阶段不能修改Entity，提交成功前不能响应客户端。当前事务Planner只支持GrantItem，新增其他Action必须先实现纯数据规划和恢复规则。组队任务需要Party与PartyAudience，当前不要在Quest里提前实现队员共享。完整代码和协议调用见[任务系统设计](../design/quest-system.md)。

### NPC接取任务

Starter第一版的任务使者遵循“普通Unit + QuestComponent”的最小边界：

```text
MapHostScene
  -> UnitComponent.Create(NpcUnit)
  -> NpcComponent维护地图内NPC索引
  -> MapAoiComponent.Attach(npc, observer=false, subject=true)
  -> 客户端收到MapEntitySnapshot(entityType=3)
  -> 玩家选择NPC
  -> C2M_AcceptQuest / C2M_CompleteQuest(questConfigId, npcUnitId)
  -> PlayerUnit ordered mailbox
  -> NpcComponent.ValidateQuestInteraction
  -> QuestComponent.AcceptQuest
```

客户端调用只使用可见快照中的NPC UnitId：

```ts
const npc = visibleEntities.find((entity) => entity.entityType === 3);
if (npc) {
  await mapClient.acceptQuest({
    questConfigId: 5001,
    npcUnitId: npc.unitId,
  });
  await mapClient.completeQuest({
    questConfigId: 5001,
    npcUnitId: npc.unitId,
  });
}
```

- NPC UnitId只是当前地图实例的运行时实体地址，不能保存为任务归属或玩家数据；任务保存的是`questConfigId`和Quest状态。
- Handler只转换协议，不能直接判断距离、修改Quest状态或绕过mailbox。服务端必须同时检查NPC仍在当前Map、确实提供该任务、玩家在交互范围内以及Quest自身的Veto/前置条件。
- Starter的Map 100固定创建`npcConfigId=9001`的紫色方块任务使者，交互范围为5米；Map 100使用Demo专用宽视野`AoiConfig=2`，7×7 Grid建立可见关系、9×9 Grid作为Detach边界，远端刷怪区放置三只被动黄色怪和两只主动红色怪，任务5001要求击败5只怪A，任务5005要求交付5001后击败5只怪B，避免新玩家出生即进入战斗。`MapEntitySnapshot.displayName`是服务端提供的公开名称：玩家使用角色名，NPC和怪物使用各自冷配置名称；客户端只负责显示，不能通过`configId`猜测或硬编码业务名称。Starter当前所有QuestConfig都关闭自动接取，任务只能由NPC/剧情等明确业务入口发起。Cocos3D的桌面端和移动端都遵循“靠近5米显示交互按钮 -> 打开NPC对话 -> 点击接取/交付任务”流程；选中NPC、看到NPC或打开对话框都不能直接改变任务状态。后续对话、多个NPC和可重复任务只扩展配置与领域行为，不复制第二套NPC网络系统。
- 完整任务链验收必须调用正式协议，禁止夹具直接写Quest或Inventory。`starter:acceptance`会在all-in-one与split-process中接取5001、击杀5A并交付、接取5005、击杀5B并交付、接取5006、逐尸体领取5个徽记并最终交付，再跨图核对完成集合与奖励快照。

## 广播给谁与如何广播

业务层只产生逻辑`ClientAudience`：AOI观察者、自己、队伍、公会在线成员等。`ClientBroadcast`在发送时批量解析UnitId到Gate；同地图成员同步直取Gate，跨地图关系成员通过Location批量查询并短期缓存。业务看不到`BroadcastAudience`、Gate route、连接或内网帧。Core的`BroadcastHub`处理编码、event队列、latest合并、single-flight和指标。Movement等已经由框架提供专用Rust热路径的状态，业务仍只修改权威数据或调用领域方法。

业务开发者不创建、不读取AOI的Audience签名，也不维护迟滞关系集合。Rust会为最终受众相同的状态共享编码；`tiangz_aoi_lingering_relations`和`tiangz_aoi_rejected_relations`只用于诊断。设计地图和移动速度时应让Grid尺寸明显大于单Tick移动距离；若大量Unit持续跨Grid，成本近似“跨Grid次数 × 附近候选人数”，这属于空间负载模型，不应通过在Handler中缓存观察者列表规避。

```ts
const map = player.DomainScene().GetComponent(MapComponent);
const nearby = map.Audience.ObserversOf(player); // 谁能看见player，不是player能看见谁
const party = ClientAudience.ForUnits(`party:${partyId}`, partyMemberUnitIds);

await Promise.all([
  map.Broadcast.Publish(
    ClientAudience.Union(nearby, party),
    ClientBroadcasts.BuffAdded,
    { buff: publicView },
  ),
  map.Broadcast.Publish(
    ClientAudience.Union(ClientAudience.Self(player.UnitId), party),
    ClientBroadcasts.BuffDetail,
    detailView,
    serverTick,
  ),
]);
```

规则：

- `ObserversOf(subject)`表示“谁能看见这个Subject”；`VisibleSubjectsOf(observer)`表示“这个Observer能看见谁”，命名方向不能互换。
- `ClientAudience`的key描述稳定业务身份，例如`party:42`；不能把当前成员列表拼入key，否则latest频道无法连续覆盖。
- 不在BroadcastHub中写地图AOI、队伍或公会查询；对应业务域只负责产生UnitId集合。
- 不为每种广播新增`M2G_Xxx`；业务只调用`map.Broadcast`。框架按数量自动选择内部单发或批发，业务不得直接构造内网广播协议。
- latest descriptor必须有稳定key。
- event队列满必须显式失败，不能静默丢弃。
- 业务不得把AOI Enter/Leave当作可随意丢弃的普通latest；关系变化先按`observer + subject`合并最终状态，再进入可靠发布。若未来增加关系快照重同步，必须由框架显式标记，不能只靠“丢旧Leave/Enter”猜最终视图。
- AOI已经接管Movement、Numeric和Unit固定字段的接收者选择；新增业务广播必须选择明确Audience，不能重新构造全地图玩家列表。

通用广播按`descriptor + audience + Gate`建立独立频道，不再让一个慢Gate成为跨Gate完成屏障。同一次逻辑发布跨Gate时复用一份不可变编码帧；只有某个Gate的pending latest与后续发布合并后才单独重编码最终项，业务和Transport都不得为了路由隔离重复编码相同payload。`event`是每Gate有界可靠FIFO，满载必须失败；`latest`是每Gate single-flight，未发送旧状态可被同key新状态覆盖。被覆盖的发布Promise表示“已由更新状态接管”并立即完成，只有当前最终版本继续等待Transport结果；业务不能把latest Promise理解为每个中间版本都实际到达客户端。框架对latest待发item、编码字节和等待年龄设有上限，`latest_capacity_rejections_total`非零意味着容量或链路故障，不能靠扩大上限掩盖。

`SceneBroadcastTransport`只合并相同Gate、相同投递类别的作业；内网`delivery_class=1`表示可靠事件，`2`表示可覆盖状态。Gate将客户端出站分成control response、reliable event和latest state三个队列，按该优先级在同一Update中交给Host批量写出，最终仍共享一个客户端TCP连接并保留每条客户端frame边界。Movement和Numeric的Rust route frame自带每Gate itemCount及latest类别；共享Numeric revision必须等待全部相关Gate成功后Ack，任一路失败都保留Dirty。业务不得分配routeId、调用任何`*AoiRouteFrames` Native op、调用`SceneMessageHelper.sendFrame`，或直接构造`S2G_ClientBroadcastBatch`。不能为了追求“一Tick一包”而延迟技能、Buff、道具、伤害等可靠事件，也不能把多个客户端msgcode拼成私有payload。

跨进程Transport的call与send流拥有独立保留容量和公平调度；目标Process入口也把`eventQueueCapacity`按1:3划分为控制流与数据流，内部RPC、断线和Host completion走控制流，内部单向帧走数据流，每连续32个控制事件至少调度一个数据事件。业务不应自行扩大队列或依赖重试风暴；收到`SystemErrCode.SceneOverloaded`时立即结束当前业务请求并向客户端返回明确业务错误，不能把它包装成普通超时。目标控制入口队满时Rust宿主会按原`rpcId`立即返回过载，来源进程不会继续占用pending waiter；单向广播本来就不占用RPC pending waiter。Disconnect可能先于旧数据帧到达TS，Core会用30秒有界墓碑丢弃该连接残留帧并增加`connection_ingress.dropped_frames_after_disconnect_total`；业务Handler不需要也不允许把这种宿主顺序修复成ActorLocation重试。排查过载或超时时查看按msgcode、source、target、traffic和queue stage细分的`/metrics`指标，并同时检查`queueStages.control_ingress/data_ingress`，不要只看聚合`frame`深度。

对“同一玩家较新的输入可以完全替代旧输入”的ActorLocation单向协议，可以声明`// @ets.msg ... forwarding=latest`。Core会在Gate按`connectionId + msgcode`合并20ms窗口，并按目标Scene批量跨进程转发；Map解包后仍逐条进入目标Unit mailbox。它适合移动意图，不适合RPC、技能释放、道具使用、背包变化、交易和伤害事件。代码生成会拒绝把该策略放到RPC或非ActorLocation协议上；业务不得手写Core批量msgcode。压测和线上诊断查看`actor_latest_forward`的输入、覆盖、转发、批次、失败和丢弃计数。

## 定时器和Update

Component拥有的周期任务使用组件定时器：

```ts
const numeric = player.GetComponent(NumericComponent);
const attack = numeric[NumericType.Attack]; // 玩家由AttackBase=5n推导得到
```

Numeric不再内置100ms回血Timer。需要回血、Buff或其他周期规则时，由对应业务Component显式创建Timer；玩家创建时设置`AttackBase`，怪物创建时根据配置设置`AttackBase`，普通攻击统一读取最终的`NumericType.Attack`。当前不增加Armor字段，伤害是多少就扣多少CurrentHp。

Component和Actor业务Timer必须传方法名字面量，不能传匿名闭包或运行时拼接的字符串。触发时框架从当前prototype解析方法，因此现有Timer会自然进入新Hotfix generation；Timer仍随owner销毁自动取消。`verify:runtime-contracts`会用TypeScript AST和类型信息检查目标方法存在、参数可赋值以及`onCancelled(args, context)`形状；Timer回调本身仍允许`MaybePromise<void>`，不要把同步生命周期约束误套到Timer。

需要区分正常结束与主动打断时，保存返回的`TimerId`并声明取消方法：

```ts
this.castTimerId = this.NewOnceTimer(
  3_000,
  "FinishCast",
  { skillId, targetId },
  { onCancelled: "CancelCast" },
);

this.CancelTimer(this.castTimerId, "player-moved");
```

正常到期只调用`FinishCast(args)`；主动取消只调用一次`CancelCast(args, context)`。Owner销毁属于生命周期清理，不回调业务取消方法。不要把`TimerId`写入数据库。

Developer Tools和仓库级`verify:runtime-contracts`会检查Timer方法名和取消回调是否存在、取消回调是否接收`(args, context)`、同步/Veto Event Handler及保留生命周期是否错误声明`async`或返回Promise，以及持久化Snapshot是否错误声明`InstanceId/TimerId`。命令面板可执行“TiangZ：运行 Runtime Foundation 自测”，其结果与`npm run test:runtime-foundation`一致。

逐固定帧逻辑实现同步`Update()`，帧末复制实现`FrameFlush()`。不要在Update中创建未等待的异步任务：

```ts
// 错误：每帧都可能堆积一个尚未完成的RPC。
Update(): void {
  void this.scenes.callOne("Rank", descriptor, request);
}
```

需要异步串行时，用Actor定时器或给Actor发送消息，使工作进入其mailbox。

## 业务Id、局部锁与Scene事件

- 玩家、Item、动态副本等长期实体保存稳定`Id`；`InstanceId`只用于当前Process中的EntityRoot和Actor路由，禁止持久化。
- 新Item由`GlobalIdSystem`生成ID；数据库恢复使用`CreateItemById`保留原ID并获得新的InstanceId。
- 同一Scene内按门派、队伍、交易单等业务键防重入时使用`await scene.Locks.RunExclusive(domain, key, callback)`。它不跨Process，不替代数据库事务。无竞争时回调会同步开始，因此需要阻止后续消息抢跑的标记必须放在回调第一个`await`之前。
- 同一Scene已经发生的功能通知使用`defineSyncEvent + scene.Events.Publish`；可扩展的操作前置条件使用`defineVetoEvent + scene.Events.Check`。两类Handler都必须同步，不能I/O或返回Promise。
- Veto Handler返回`0`放行，返回第一个非零业务错误码时立即停止。它只能读取上下文，不能在检查中扣道具、加Buff、改Numeric或启动任务。监听器在Hotfix中按稳定`id`注册，不为每个Unit动态保存闭包；模块是否激活由Handler读取Component/Native状态判断。
- 明确不等待结果且完成时间不影响当前业务的短任务使用`scene.Tasks.Spawn(name, body)`。框架捕获错误并纳入Hotfix排空；每个Scene最多256个在途任务，超过10秒记录告警。永久循环、事务、玩家有序状态修改、精确定时和需要响应的RPC禁止使用Spawn，任何Update/FrameFlush中也禁止逐帧Spawn。
- 跨Scene、跨Process、需要mailbox顺序或需要响应的交互仍使用生成的Message/RPC，不能拿Event代替。

详细API和错误边界见[运行时基础能力](../design/runtime-foundations.md)与[Veto Event和后台任务设计](../design/veto-events-and-spawn.md)。

## 玩家下线和持久化

玩家保存应封装在玩家内部的生命周期能力中。断线、踢下线和Process停机共用同一个幂等Promise：

```ts
await player.Offline(reason);
```

业务Handler不要直接调用Repository，否则会绕过幂等保存和统一移除流程。普通socket断开只销毁`GateSession`，不能直接调用玩家`Offline()`；`GatePlayerRoute`在Gate继续保留30秒等待重连。宽限期结束后只能由Gate调用`MapProtocol.PlayerOffline`，Map先完成保存和Location移除并返回Unit RPC，再由下一轮Map Timer执行`RemovePlayer`、AOI离开和Actor销毁。`PlayerOffline`运行在PlayerUnit自己的ordered mailbox时，禁止在当前调用中同步销毁这个Unit；否则RPC返回前Actor已经消失，运行时会报告`actor despawned during mailbox execution`。停机批量清理可在不占用Unit mailbox的地图清理阶段直接完成，但仍须遵守先保存、再脱离AOI、最后销毁Actor的顺序。

玩家Unit只保存`gateName + gateEpoch`，不得保存`connectionId`、`GateSessionId`或自行创建断线Timer。同Gate重连使用`SecondEnterMap`恢复客户端全量视图，不创建替代Unit、不触发AOI进入。跨Gate故障接管必须由PlayerUnit邮箱调用Location完整CAS，提交后原地更新UnitGate、Actor fence和AOI delivery route；业务不得直接改gateName或复用旧epoch。客户端空闲时每5秒调用`C2G_Ping -> G2C_Ping`；任何入站消息都会续期，服务端出站消息不会续期。Session默认unordered，Ping作为普通TS Handler直接返回`TimerSystem.ServerTime()`产生的Unix毫秒且不加锁。登录按连接与账号加锁；进图、重连、传送、快照确认和最终下线按账号加锁。业务只锁会修改共享状态的事务，禁止为了省事把整个Session改回ordered。

同一账号在同一Gate再次登录时属于“顶号”，不是一次普通断线重连。Gate必须在账号锁内先把旧`GateSession`失效，再发送`G2C_SessionReplaced`，最后关闭旧连接；旧连接的迟到断线、在途请求和旧Promise都不能影响新`GatePlayerRoute`。客户端只需要订阅SDK事件，不要把顶号当成普通网络错误自动重试：

```ts
const stop = loginFlow.onSessionReplaced((message) => {
  message.reasonCode; // 10040
  clearLocalGameState();
  showLoginPanel(`连接已被顶号：${message.reason}`);
});
```

`disconnectClient`的关闭请求随本Scene下一次出站排空交给宿主，排在此前`sendClient`入队的帧之后；宿主本轮先写出站帧再执行关闭，传输层关闭前再排空已交付的帧，因此健康传输下“先推送通知再断开”保持提交顺序；断网、发送失败或期限耗尽仍可能丢帧，即使调用发生在RPC续体等Scene更新之后的时点（0.6.3起；此前关闭可能抢在通知之前，业务曾需延迟断开绕过）。关闭最多晚一次更新生效，生效前已在途的入站帧仍可能到达，业务应先使Session失效再请求关闭。SDK的`RpcSocket`会保留关闭前已经收到、但尚未由游戏循环`update()`分发的单向消息。客户端仍必须持续驱动`update()`，不能只依赖网络回调。同Gate顶号使用连接代次；跨Gate故障接管使用Location gateEpoch与ActorLocation fencing。两者都不会迁移原Socket。

Gate候选排序统一复用`RankStickyScenes/SelectStickyGate`，业务不得另写取模、随机或自定义账号哈希。Login先保留Location记录的当前健康Gate；仅当它不可达时才依Rendezvous顺序探测其他Gate。恢复节点不自动回切现存玩家；绕过Login连接旧Gate也必须在旧所有者健康探测和Location CAS处被拒绝。

DBProxy独立仓库已发布`v0.5.0`：除PostgreSQL权威快照、Revision/CAS、幂等事务与回执查询、Redis缓存与持久Backlog、Rust客户端池和运行时无关TypeScript SDK外，还提供多Endpoint故障切换、两个共享存储的无状态对等实例，以及跨记录全量CAS原子事务。TiangZ主工程配置通过`endpoint + failoverEndpoints`声明地址，业务层不得复制协议或自行实现第二套故障切换。30秒周期快照、有限并发最终Flush、静态MapHost有界重启和双Gate强杀接管均已验收。Gate接管保留存活MapHost上的PlayerUnit，不依赖DBProxy重建；它不恢复原Socket、Gate本地队列、怪物/仇恨或动态副本现场。

跨玩家关键操作的固定写法是：领域Component先同步冻结会话，最终提交者保留自身PlayerUnit ordered mailbox，并通过地图宿主进入另一参与者的真实ordered mailbox；持有双方邮箱后，Planner再从权威快照生成全部`expectedRevision + nextPayload + result`，领域Repository按稳定顺序调用一次多记录事务，提交成功后各Participant无await应用结果。只锁会话对象不能阻止另一玩家在`await`期间使用道具或改金币。响应不确定时用同一`operationId`查询回执；业务冲突直接结束会话，不能换operationId重试。玩家交易参考`app/hotfix/mmorpg/trade`和[玩家交易设计](../design/player-trade.md)。Handler只转发到PlayerUnit ordered mailbox，不得直接调用DBProxy。

## AOI业务规则

完整的数据结构、生命周期、Movement直达Gate链路和函数调用图见[AOI完整设计与函数调用关系](../design/aoi-architecture.md)。本节只保留业务开发规则。

地图业务不再构造“全地图玩家列表”广播Movement、Numeric或Unit固定字段。`MapAoiComponent`拥有Rust推导的最终可见结果；Movement由Rust在帧尾直接生成按Gate路由的完整批帧，`MapComponent`只调用框架封装并提交结果，不把recipientId数组拉回TS。Rust内部使用扁平AOI Grid、紧凑`EntityIndex`、连续成员数组和双向可见位图；热点Grid会由框架自动增加成员位图。这些都是框架实现细节：业务不得读取或保存`EntityIndex/slotInGrid`，不得假设UnitId等于位图下标，不得配置热点阈值，也不得按Tick重建自己的空间索引。业务过滤仍通过`IAoiVisibilityFilter`和显式Invalidate改变最终可见位图。状态复制按Subject Grid合并相同受众，不按每名接收者复制记录索引。业务TS不得镜像全量关系表、管理delivery route、手工合并Grid受众或直接发送内网帧。开发普通移动、传送、上线或下线时不得手工调用底层Native AOI op；X/Z FastOP、`PlayerEntered`和`RemovePlayer`生命周期已经接管。

普通Unit进入/离开视野也不由业务逐个发送。框架把同一帧、相同受众的不可覆盖变化合成`G2C_AoiDelta`，客户端SDK的Handler负责遍历`enters/leaves`。新增Buff、任务摘要等领域可见事件时，应先判断它属于Unit整体Snapshot、独立不可覆盖Event还是可覆盖状态；不得把业务字段塞进通用AOI Delta，也不得恢复逐关系`Publish`。

同一批次内重复的`ObserverId + SubjectId`关系只发布最后状态，并保持首次出现顺序；Enter→Leave或Leave→Enter的中间状态会被丢弃。这个规则只适用于尚未发布的AOI空间关系，不能用于掉落、伤害、奖励、背包变化等不可覆盖事实；显式Invalidate的返回值仍必须交给`MapComponent.PublishVisibilityChanges`。

阵营、隐身、位面等规则实现同步过滤器：

```ts
class PhaseVisibilityFilter implements IAoiVisibilityFilter {
  CanObserve(observer: Unit, subject: Unit): boolean {
    return observer.GetComponent(PhaseComponent).PhaseId ===
      subject.GetComponent(PhaseComponent).PhaseId;
  }
}
```

`CanObserve`只能读取内存中的Component并立即返回`boolean`，禁止`async`、Promise、RPC、数据库、发消息和修改Entity；异常会按不可见处理。过滤器不会每帧运行。业务状态变化后，必须按影响方向显式通知地图：只影响“我能看见谁”调用`InvalidateObserver(unit)`；只影响“谁能看见我”调用`InvalidateSubject(unit)`；双向规则调用`Invalidate(unit)`。三个Invalidate方法只返回关系变化，不自行发消息；调用方必须继续调用`await map.PublishVisibilityChanges(changes)`，由地图统一合并并发布Enter/Leave。AOI当前只筛选接收者，技能命中、组队权限等业务权威判定仍由各自领域逻辑负责。

空间配置只通过Luban Cold表维护：`MapConfig.cellSizeMeters`定义米制Cell；`AoiConfig.gridSizeCells`定义一个AOI Grid包含多少个Cell；`enterRangeGrids`和`detachRangeGrids`分别控制建立与移除可见关系；`AoiSyncTierConfig`只控制已经可见关系的可覆盖状态频率。范围填写奇数边长，例如3表示3×3 Grid。同步范围可以大于Enter，但不会提前Enter；同步最大范围也可以小于Detach，迟滞外圈此时只保持可见，不接收周期可覆盖状态。Movement的开始、停止和转向不受节流；低频档由框架按Subject Grid稳定错峰。Numeric、技能、Buff等仍按自己的状态或事件语义发送。业务代码不得根据距离自行重复一套频率判断。

验收开放世界内容密度时，先从内容包统计刷点总数，再按`(rangeGrids - 1) / 2 × gridSizeCells × cellSizeMeters`核算近似可见半径，并在出生点统计半径内候选数。刷点足够而客户端显得稀疏时，应为地图选择或新增通用AOI Cold配置；不得重复刷点、修改导入边界或写区域专用生成代码。宽视野应采用近圈高频、外圈低频的分层同步，最外层档位覆盖Detach范围；修改后执行完整构建并冷重启Process。

`MapConfig`、`AoiConfig`、`AoiSyncTierConfig`是Cold表，任何值变化都必须完整构建并重启Process；`ItemConfig`和`PlayerConfig`当前是Hot表，可以在线替换数据。表结构始终属于Model。新增配置表时必须在`ConfigTablePolicy.xlsx`登记整表策略，不允许一张表内混合Hot与Cold字段。

### 地图入图节流

首次登录或`TransferToMap`到达目标地图时，业务不应直接调用底层AOI Attach，也不需要自己创建Loading队列。`MapComponent.PlayerEntered`会进入当前MapInstance的等待队列，地图每Tick最多按`MapConfig.entryPlayersPerTick`放行；`entryQueueCapacity`满时明确拒绝，防止无限积压。Gate保持连接并等待`EnterMap`或传送响应，客户端继续显示Loading。首次进图和传送链路由框架统一使用10分钟Admission事务上限，不继承普通Scene RPC的5秒默认值；业务不得自己套一层更短超时破坏队列语义。断线重连调用`SecondEnterMap`并复用原Unit，因此不进入该队列。

同一Tick放行的玩家会先统一完成AOI Attach，再准备初始实体快照。生产进入流程中，`EnterMap`只返回小型进入信息；客户端创建地图对象并注册`G2C_AoiDelta`监听后调用生成SDK中的`GateClient.mapSnapshotReady({ unitId })`，框架随后通过已有广播接口发送初始`AoiDelta`。业务不应手写Gate路由，也不应把初始实体数组重新塞回EnterMap。快照暂存由`MapComponent`管理，玩家移除和地图销毁自动清理。`player_entry_snapshot_items_total`是逻辑发送条数，不能拿它直接当成对象分配数；性能分析还要看`player_entry_snapshot_materialized_items_total`和复用命中指标。不要为了追求更高进图吞吐直接把`entryPlayersPerTick`调大，必须通过分批A/B同时观察Map CPU、初始AoiDelta下行队列和Loading时延。

当前Starter地图正式值是每Tick `2`人，其他地图以各自`MapConfig`为准。业务开发者不得在Hotfix中动态修改该值，也不得只根据平均Loading时间调整；修改Cold表后必须完整重启，并至少验证完整`full`语义、队列峰值、Location延迟、Gate下行、错误和长窗口稳态CPU。

这套机制只处理同一地图瞬时进入洪峰。它不检查区服总人数，不显示排队名次，不保证某张地图适合继续接收玩家，也不代替副本分配和MapHost容量规划。业务仍只调用统一传送入口，不为静态地图、动态副本、同进程或跨进程分别写节流代码。

业务不得使用`EntrySyncMode`跳过新玩家Snapshot或老玩家Enter；非Full模式只编入Bench Handler，用于`perf:map-entry-stages`拆分性能。排查进图慢时依次观察MapHost请求、Admission等待、Attach、Snapshot对象数、AOI Delta逻辑投递量和Gate下行，不得通过删减客户端必需状态制造虚假的容量结果。Prometheus标签中禁止加入account、UnitId和connectionId。

计划中的开发者语义只保留三种存储域：

持久化基础设施放在独立的[TiangZ-DBProxy](https://github.com/moulo1982Google/TiangZ-DBProxy)仓库中，不能成为`src/game`下的TiangZ Rust业务模块。DBProxy核心提供与游戏无关的`RecordKey`、快照Payload、Revision/CAS、幂等写入、普通批量Load/Save/Enqueue、单记录`TransactionalWrite`、多记录原子事务、Redis AOF backlog和独立网络服务；PostgreSQL是权威端，Redis只承载已提交快照缓存与可恢复的普通快照积压。TiangZ Rust Host通过连接池和有序多Endpoint接入DBProxy，业务层不得直接连接Redis/数据库。30秒周期快照、静态MapHost有界接管、双Gate接管和动态副本安全回退已验收；旧schema迁移、跨机器仲裁和跨地域容灾仍未收口。

- `transient`：连接、移动中间态等运行时数据，不保存。
- `snapshot`：位置、普通数值、任务进度等最终状态；业务保持普通属性写法，生成setter自动标脏，框架短窗口合并后批量写Redis并异步落永久DB。
- `transactional`：Wallet、Inventory、Trade等经济数据；不能直接赋值，只通过领域事务方法修改，永久DB提交成功后才更新Redis缓存和内存状态。

同一字段只能属于一个存储域。Redis中的事务字段只是永久DB结果的带版本缓存，不是第二个业务写入口；普通快照也不得覆盖Wallet、Inventory等事务域。未来由`.native`在Entity/Component级声明模式并由codegen生成约束，在该语法正式落地前不要自行发明`@redis`、`@mongodb`或每字段保存频率注解。

## 客户端业务

RPC使用生成Client：

```ts
const gate = new GateClient(socket);
const response = await gate.enterMap({ mapId: 1 });
```

服务端Push使用独立Handler：

```ts
@clientMessageHandler(MapMessageScope, ClientMessages.ItemChanged)
export class G2C_ItemChangedHandler implements ClientMessageHandler<
  MapEntityManager,
  G2C_ItemChanged
> {
  handle(entities: MapEntityManager, message: G2C_ItemChanged): void {
    entities.applyItem(message.item);
  }
}
```

- 不把所有`socket.on(...)`堆到Manager构造函数。
- Handler只调用领域Context，不持有Cocos Node等长生命周期对象。
- SDK Core不得导入`cc`、Pixi或Demo。
- 修改公共SDK后必须验证Cocos和Pixi分发副本一致。

## 什么时候允许改Core或Rust

满足以下条件之一，才考虑Core：

- 多个互不相关业务域都缺少同一种通用语义。
- 现有API无法保证mailbox、生命周期、背压或错误契约。
- 需求本身就是框架能力，而不是某个游戏功能。

外置模块无法发现、排序、冻结或安全装载属于Core能力；某个模块需要新的种族、技能、地图、任务或协议规则不属于Core能力。新增通用模块入口时必须用不含具体游戏概念的夹具证明，并保持Core不反向依赖模块。

外置模块的静态内容优先复用Luban，不允许因为来源是另一套服务端数据库就新增私有JSON加载体系。模块在自己的仓库维护`game_config/luban.conf`、Schema和源数据，并在`tiangz.module.json.gameConfig`声明`project/target/generatedCode/generatedData`；执行`npm run modules:codegen-config -- --module-root <目录>`生成强类型`Tables`、聚合数据与schema/data/source指纹，CI使用同命令追加`--check`拒绝陈旧产物。第三方数据库导入器只负责转换成这份源数据；运行时数据包只负责部署信封。模块Hotfix必须用自己生成的类型解码payload、完成跨表引用校验，再原子投影到现有中立Profile。Core生成器不得包含地图、NPC、职业或任何来源游戏专用校验；这些校验留在模块的Luban Schema、导入器或内容验证器。当前模块配置不支持运行期Reload，数据和schema变化都要重新构建并重启。

满足以下条件并取得用户确认，才考虑Rust/NativeData：

- 已有基准显示TS或V8边界是主要瓶颈。
- 数据需要跨热更长期存在，并明确由Rust作为唯一权威源。
- 可以设计粗粒度批量op，避免Rust处理后又回调TS取数据。
- 已定义生命周期、generation handle、错误和观测指标。
- 有TS方案或旧方案可进行同口径A/B验证。

不允许以“以后可能更快”为唯一理由修改Rust。

## 日志、错误与注释

- 使用`scene.logger`或领域Logger，附带`process/scene/mapId/unitId`等结构化字段。
- 系统错误码小于10000，业务错误码从10000开始。
- RPC框架错误需要日志和Response；单向Message没有Response，不额外推送无人订阅的通用ErrorResponse。
- 公共与生命周期函数写中英文对照注释，说明副作用、所有权、顺序和不应采用的调用方式。
- 不给简单getter和显然赋值写重复注释。

## 验证矩阵

`0.3.10`框架稳定化和`0.4.0` Phase 4.0空间契约已经完成，当前版本为 `0.6.3`（2026-09-28 发布），直接进入模块化开发预发布线，尚未完成 0.6 正式发布验收。升级宿主先逐个检查模块版本范围；旧 `<0.5.0` 上限必须经消费方验证后迁移，不自动放宽其他游戏声明。随后重新生成、完整构建并重启。Model/Hotfix双Bundle、`@systemFor`、兼容指纹、Watcher Reload、Rust有界投递屏障、超时拒绝、事务回滚、Prometheus指标、3000玩家1Hz Reload A/B、8秒慢RPC屏障、Timer跨generation和100代资源长稳均已完成。热更按整个Process原子提交Hotfix behavior，现有Entity/Component和Rust handle不重建。Model绝对不能热更；字段、构造、继承、公开System签名、协议、空间模式或Native schema变化必须完整部署并重启Process，不存在字段migration旁路。完整约束见[热更设计](../design/typescript-hot-reload.md)。

本地只修改Hotfix行为时，可运行`npm run dev -- configs/local/cluster/StartMachine.json`后直接保存TS文件；开发宿主会自动生成注册入口、类型检查、构建不可变候选并Reload。需要在VS Code断点调试中持续Reload时使用`npm run dev:debug`：初始和后续候选都带内联sourcemap，Process/V8/Inspector连接不重启，新脚本会重新绑定TS断点。若V8正停在断点必须先Resume；当前栈继续旧代码，后续调用才使用新generation。构建失败时旧generation继续运行。这个便利入口不适用于Model字段、Core、Proto或`.native`变化，也不用于正式部署。Developer Tools把Model长期状态中的显式`any`、可选字段、基本类型与`undefined`联合、跨基本类型联合、`delete`字段和`as any`写属性视为错误；请使用稳定默认值或明确的数据结构。对象`T | null`、判别联合、显式Map/Record和普通DTO仍可正常使用。

正式环境先把完整`dist/hotfix-candidates/<hash>`原子发布到目标机器，再执行`npm run hotfix -- plan`预览；确认后用`apply`提交，用`status`核对generation与active/previous候选，必要时用`rollback`重新提交previous候选。目标Process必须显式配置`process.lifecycle.hotfixOperations.authTokenEnv`，实际令牌只放环境变量。管理路由仅允许本机Bearer鉴权访问，不能加入公网反向代理。CLI可用重复`--target`选择Process，并在同机多目标部分失败时补偿回滚本次成功目标；跨机器尚无Prepare/Commit，不能宣称全局原子。每次操作必须保留operationId与`temp/hotfix-operations/audit.jsonl`审计，但禁止记录令牌。

`check`、`verify:quick`和`verify`由统一测试矩阵按顺序执行各隔离步骤，但某一步失败后仍继续运行后续步骤，终端最后汇总所有失败。每次运行都会写`dist/test-results/<profile>.json`和JUnit XML；CI应读取报告，而不是只截取第一个错误。40个纯TypeScript进程内自测均导出`main`并由Vitest一一包装，测试文件使用fork、模块隔离和文件并行；依赖`game_config/generated`的用例由`globalSetup`统一运行codegen。`test:unit:coverage`覆盖整个`app/core/**/*.ts`并执行仓库基线门槛；真实端口、子进程、codegen、Cargo、Runtime和故障注入继续使用各自隔离验收，不为了覆盖率数字塞进同一进程。

新增`tools/*_self_test.ts`必须同时添加同名`tests/legacy/*.test.ts`包装，`verify:runtime-contracts`会拒绝遗漏；`self_test_entry.ts`是共享入口辅助，不属于此命名集合。`globalSetup`在生成锁内校验输入与输出的SHA-256指纹：未变时复用，配置增删改、生成器或Luban工具链变化、输出缺失或损坏都会重新生成；缓存仅保存在`temp/vitest-game-config-cache.json`。显式`npm run codegen`仍完整执行。Core分支覆盖率门槛保持60%，增加代码时应同步补齐重要分支测试。内存紧张的开发机可在当前终端设置`VITEST_MAX_WORKERS=2`和`CARGO_BUILD_JOBS=2`后运行发布门禁；这只限制构建与测试并发，不关闭文件隔离或跳过验收。

| 修改类型 | 最少验证 |
|---|---|
| 纯TS业务Component/Handler | `npm run typecheck`和对应自测 |
| 只修改Hotfix行为 | `npm run build:hotfix`、`npm run test:hotfix`；涉及操作入口或调试重绑时追加`npm run test:hotfix-operations` |
| Model字段、类型、构造或继承 | `npm run build`、相关测试并重启Process；不得使用Hotfix-only |
| proto或客户端Push | `npm run codegen`、`npm run test:protocol`、对应Client测试 |
| 外置模块自有Proto、锁或客户端SDK | 模块工作区执行 `npm run protocol:generate` 更新锁，日常执行 `npm run protocol:check`、`npm run modules:typecheck` 和引擎完整构建；协议变化重启Process，并验证模块客户端SDK |
| Luban游戏配置 | 纯数据用`npm run build:game-config`、`npm run test:game-config`和Reload验收；结构变化追加完整构建、重启与客户端类型检查 |
| 外置模块自有Luban配置 | `npm run modules:codegen-config -- --module-root <目录>`；CI追加`--check`，并执行模块自己的内容校验、运行时投影测试与完整重启 |
| Native Entity/字段 | `npm run test:native-data`、`cargo test --all-targets` |
| 状态复制/广播 | `npm run test:map-broadcast`、相关性能基准 |
| 客户端SDK | `npm run test:client-sdk`、`npm run test:client-sdk-distribution`、Cocos/Pixi typecheck |
| Scene部署或跨进程调用 | `npm run test:runtime` |
| 生命周期或拥有者Timer契约 | `npm run verify:runtime-contracts`、`npm run test:runtime-contract-verifier`和完整`npm run verify` |
| mailbox、背压、生命周期 | 完整`npm run verify` |
| 外置游戏模块manifest、组合或边界 | `npm run modules:validate`、`npm run modules:typecheck`、`npm run test:game-modules`、`npm run verify:hotfix-boundary` |
| RPC、Actor路由或生命周期 | `npm run test:rpc-actor-correctness`和完整`npm run verify` |
| 异常恢复、连接清理或持久化失败 | `npm run test:fault-injection` |
| 一般合并前质量门 | `npm run verify:quick` |
| 框架热路径或Runtime优化 | `npm run verify:perf`，背压和长稳按改动风险另跑 |
| Release候选 | `npm run audit:dependencies`、`npm run verify`、`npm run release:package` |

性能结果必须注明机器、配置、玩家数、Gate数、频率、持续时间、是否AOI以及指标口径。不要把Probe基线或全地图可见Demo结果描述为正式业务容量。自动容量推荐延后到Phase 5，必须等Rust AOI和首版真实怪物、战斗、Buff、任务及持久化负载具备后，按负载模型分别校准；业务代码和配置当前不得读取测试报告自行生成准入人数、Gate数或Process数。

Native字段可用`@hot`和`@cold`表达Rust存储温度，但这属于Model/schema设计，不是业务Hotfix。`@hot`只用于每Tick确实会连续扫描的最小字段集；低频字段和未标记字段不应为了猜测性能全部标热。codegen负责生成类型池和冷热访问器；业务仍只通过`NativeXxxRef`与粗粒度op访问数据，不直接引用`XxxHotData`、`XxxColdData`、保存Rust池索引或管理Pool。修改冷热归属后运行`npm run perf:native-storage`与`npm run test:native-data`，并完整重启Process。

Cocos业务脚本提交前应在打开过工程的Cocos环境运行`typecheck:cocos-demo:engine`；CI中的`typecheck:cocos-demo`只保证入口及依赖可bundle，不伪造引擎类型。客户端SDK本身仍必须通过与引擎无关的`typecheck:cocos-net`。Web包只使用统一命令`npm run build:cocos3d:web`、`npm run build:cocos3d:mobile`或对应的2D命令；这些命令默认是Release，Debug只能使用带`:debug`后缀的命令。命令会匹配Creator版本、清除`ELECTRON_RUN_AS_NODE`、清理并检查标准输出；`npm run check:cocos-build`可在不启动编辑器时预检。Creator 3.8.x本机的`code=36`只有在`index.html`、`application.js`和`assets`均生成时才接受，其他非零码不得忽略。不要手工调用Creator CLI，不要提交`library/temp/build`缓存，也不要把Cocos Native误当成Web构建；Native必须先生成原生工程后再走CMake/Visual Studio。

## 后续Map同步策略

同步方式属于Map的玩法策略，不属于整个Process或Runtime。Phase 4后续允许普通大世界使用状态同步、竞技场等独立Map使用帧同步，以及少数高精度场景使用高频状态同步。同一个部署中可以同时存在这些Map，但玩家切换同步方式应通过退出旧Map、进入新Map完成。

当前业务继续使用已有状态同步链路，不要提前在Handler中散落同步模式判断，也不要自行建立另一套帧号、输入队列或广播接口。后续实现应由Map创建配置选择策略，并由对应Component承接输入、模拟和广播；Handler仍只表达移动、施法等领域意图。逻辑Tick、网络同步频率与客户端渲染频率必须分别配置，提升其中一项不能隐式提高其他两项。

## 怪物基础AI开发约束

当前怪物只支持固定刷点、主动追击、两米内普通攻击、Numeric扣血、死亡和重生。调用链保持为：

```text
C2M_AttackMonsterHandler
  -> PlayerUnit.AttackMonster
  -> MonsterComponent.Attack
```

固定刷点和实体身份必须分开：`MonsterAreaConfig.id`对应稳定的`AreaId`刷怪槽位，`MonsterUnit.UnitId`只对应一次实体生命周期。死亡时槽位清空当前活怪并启动`respawn_seconds`，旧Unit以`alive=false`进入独立尸体集合；重生截止时间到达后，同一`AreaId`创建新MonsterUnit并通过AOI Enter发送新快照，不等待旧尸体。尸体窗口结束或全部普通掉落领取完成后，旧Unit才Detach、发布AOI Leave并Remove。业务不得复用旧UnitId表示“新怪物”，也不能假设一个`AreaId`同一时刻只有一个Unit；客户端必须按UnitId区分新活怪和旧尸体。拾取响应丢失时，客户端必须用原`operationId`重试，由持久化回执返回第一次结果。

怪物主动行为由`MonsterComponent.Update`统一驱动，并在Hotfix内部调用局部`MonsterBehaviorTree`。行为树只负责从待机、追击、攻击和冷却停留中选择一个动作；它不能直接操作Native句柄、广播消息或修改其他地图的Unit。距离、伤害、死亡和Numeric变更仍由MonsterComponent负责。每个到期行为Tick在做这些动作前检查`MonsterEvents.BeforeBehavior`同步Veto；监听器只能读取怪物状态并返回模块私有数字原因，非零结果由MonsterComponent统一停止现有移动并跳过本Tick。不要让监听器直接停移动、清仇恨、加减Buff或攻击，也不要把眩晕、恐惧、凿击等具体语义写进Core。

不要为每只怪物创建Actor、长期Timer或独立V8。不要在Handler里扫描地图或绕过`MonsterComponent`查找怪物。技能和Buff已经接入统一Component/Action边界；复杂仇恨、巡逻路点和回出生点尚未接入，新增这些能力前先保持当前普通攻击、七技能和引导闭环可测试、可观测。

### 自动攻击与朝向

普通攻击不是客户端每次点击产生一条伤害消息，而是`CombatComponent`上的持续状态：`StartAutoAttack(targetId)`只激活状态并锁定目标。Map固定Tick先检查目标是否存活并仍属同一MapInstance；有效目标会持续推进武器计时，计时到点后才检查攻击距离与角色朝向，并在命中窗口有效时结算一次伤害。

距离过远或朝向不正确时，不能清除自动攻击状态，也不能反复重置完整武器间隔。武器计时继续推进；到点后若命中窗口仍无效，则保持就绪并由10Hz战斗桶重试，恢复有效距离和朝向后的首个战斗帧即可结算。只有成功命中、显式取消或技能策略等明确中断才能开启或清除一轮计时。移动Handler不得调用`StopAutoAttack`。Cocos3D右键加A/D的侧移正是为了保持Yaw、围绕目标移动；右键拖动必须同步改变角色的权威Yaw，不能只改变摄像机角度。

技能配置必须把以下维度分开：伤害类型（Physical/Magic/True）、执行方式（Instant/Cast/Channel）和对平A时间轴的影响（Keep/RestartAfterCast，后续可扩展PauseResume）。例如战士的压制是物理、瞬发且Keep，不得因为它是物理技能或瞬发技能就自动推断平A行为。

主动怪不要只写“靠近玩家”的表现逻辑：当前演示中`MonsterConfig.attack_mode=1`表示主动追击，进入攻击距离后由`MonsterComponentSystem`按最终`NumericType.Attack`扣玩家`CurrentHp`；`attack_mode=0`才是不主动寻找玩家的被动怪。因为玩家确实可能死亡，玩家创建时必须从`PlayerConfig.initial_hp/max_hp/initial_mp/max_mp`初始化Numeric，Cocos3D、UE、Unity和Godot的HUD只订阅进入快照与`G2C_EntityNumeric`，显示HP/MP，不能在客户端复制伤害规则。

客户端发现Gate连接已经关闭时必须退出旧世界并清除旧`UnitId`，不能让断线画面继续向Map发送请求。死亡恢复使用两个有序PlayerUnit动作：先调用`ReleaseDeadPlayer(optionalRecoveryPosition)`清理移动、战斗来源、平A和施法状态；调用方可以给出同地图恢复坐标，PlayerUnit负责有限值、地图边界与Grid/NavMesh有效性校验并保持玩家死亡/HP为0，未给坐标时才使用Map出生点。随后`RevivePlayer()`在当前位置恢复50% HP/MP且不再重定位；活玩家重复调用保持幂等。Core只拥有这套位置与生命周期契约，墓地选择、尸体、幽灵、回收等待、Buff去留、额外耐久惩罚和复活虚弱由游戏模块与协议适配器实现。持久化死亡角色在进图边界满血恢复仍是旧快照兜底，不是正式玩法。

持久化死亡角色的进图策略必须由外置玩家内容定义显式选择 `deadAdmissionPolicy`（`revive-at-spawn` 或 `preserve`）。Core 只校验并执行中立策略；`preserve` 不等于已经拥有尸体、幽灵或墓地实现，游戏模块仍须在登录阶段重建自己的适配器状态。配置包、生成模块和 profile validator 必须保持该字段一致，新增地图无需在 Core 添加分支。

若外置模块有需要跨重启保留的玩家私有状态，使用`PlayerPersistenceComponent.RegisterPersistenceExtension`注册同步`Capture/Restore`钩子。扩展只提供稳定命名空间、版本和不透明字节，Core负责runtime快照中的校验、复制、CAS及未知扩展保留；版本迁移、业务校验、跨地图`@transferable()`实现和协议投影由模块负责。不要为某个游戏把字段加入`PlayerRuntimeSaveData`，也不要让扩展钩子自行访问Repository或执行异步I/O。

## DBProxy持久化接入边界

独立DBProxy工作区已发布`v0.5.0`，提供Rust TCP服务、Protobuf版本/指纹握手、内部令牌、Rust客户端池、运行时无关TypeScript SDK、事务回执查询、双Endpoint故障切换、多记录原子事务和真实PostgreSQL/Redis适配。TiangZ主工程已经切换到`v0.5.0`，Rust Host Bridge和TypeScript Transport已接入多Endpoint配置及多记录API；业务开发者仍不能在Handler、Component或System中直接连接Redis/PostgreSQL，也不能引用`dbproxy-storage`。

正式接入后的固定调用层次应是：

```text
Handler
  -> PlayerUnit / DomainComponent
  -> 领域Repository
  -> @tiangz/dbproxy-sdk
  -> HostDbProxyTransport
  -> 独立DBProxy
```

接口必须按数据等级选择：

- `LoadSnapshot`：登录、恢复或接管时读取权威记录；`None`表示记录不存在。
- `SaveSnapshot`：调用方需要等待PostgreSQL提交的普通快照；只有`StorageUnavailable`允许有限重试，并保留原`request_id`。Repository使用25ms起步、200ms封顶的墙钟指数full jitter，Revision冲突和业务错误立即返回；不得在业务、SDK和Transport外层叠加另一套重试。`SaveMultiSnapshot`只批量独立记录，不提供跨记录业务原子性；DBProxy可以在同一连接分片内合并一次数据库commit和缓存往返，Revision/幂等冲突仍逐条返回。关键背包、货币和交易不能为了批量性能改走这个入口。
- `EnqueueSnapshot`：只用于位置、普通任务进度等允许小范围回退的数据；成功按部署的`backlog.enqueueAck`确认，默认`aof`等待Redis本地落盘，`memory`仅确认Redis内存，都不代表PostgreSQL已提交。测试`memory`存储后端不提供持久性。
- `ApplyTransaction`：用于Wallet、Inventory、Reward、Trade等关键单记录事务；必须携带原`operation_id`、期望Revision、提交后的完整Payload和可重试业务结果。

同一个`DbProxyClient`连接只允许一个在途RPC；高并发服务使用Rust`DbProxyClientPool`按RecordKey稳定分片。DBProxy网络工作运行在多线程Rust Host Runtime，业务V8只等待Promise；不得在TS中自行打开Socket或实现第二套连接池。业务不能为了躲开PlayerUnit ordered mailbox而改用`Spawn`异步确认关键经济操作：关键事务必须在可靠提交成功后才向客户端确认。普通快照可以合并并进入backlog，但不得把关键事务降级成“稍后保存”。

DBProxy服务层的集群边界已经冻结：Rust客户端接受多个有序内网Endpoint，按RecordKey选择首选实例，基础设施错误时携带原`request_id/operation_id`切换；部署两个共享同一套云Redis/PostgreSQL的对等DBProxy实例；通过故障注入验证请求中断、提交后丢响应和Backlog lease接管。业务拒绝、Revision冲突、协议指纹或鉴权错误不能触发换节点重试。DBProxy实例之间不选主、不复制业务状态，也不实现Redis/PostgreSQL高可用；存储高可用直接使用云厂商能力。TiangZ侧已经用真实商店、双玩家交易和首Endpoint中断完成端到端验收；这仍不等于存储HA或MapHost透明接管。

DBProxy观测端口与业务TCP端口分离，只提供`/live`、`/ready`和Prometheus`/metrics`，不得经过公网Nginx。服务端按固定操作名、固定错误码记录QPS、逻辑记录数、失败和延迟Histogram，Backlog记录提交/空轮询/失败；TiangZ Rust客户端Observer使用最多8个配置Endpoint的固定原子数组，Process `/metrics`导出连接尝试、请求失败、累计耗时和from/to切换。禁止把RecordKey、玩家ID、requestId或operationId放入Prometheus标签；单次请求只允许进入Debug结构化日志。Grafana是展示层，不替代Prometheus，也不冒充PostgreSQL/Redis内部监控。

当前`CreatePlayerRepository(process)`是MapHost选择实现的唯一入口：省略`process.persistence.dbProxy`时使用内存Repository，配置后使用`DbProxyPlayerRepository`。加载必须在玩家Unit发布到PlayerDirectory、Location和AOI之前完成。`PlayerPersistenceComponent`持有inventory、progression、quest、runtime、wallet五个Revision；Map每秒错峰扫描到期玩家，把捕获与一次批量保存送进PlayerUnit ordered mailbox，默认每30秒保存五域。批量结果逐领域应用，单域失败不会抹掉其他成功领域的新Revision；重试必须复用第一次生成的各域requestId。断线、踢下线和停机只调用`player.Offline(reason)`并复用同一个最终Flush Promise。Handler不得直接调用Repository。

普通、独立、按稳定Key整体读写的Entity不需要重复手写Codec和Repository。例如：

```native
@typeId(2)
@persistent(1)
entity Item extends Entity {
  readonly configId: u32;
  count: u32 = 1;
}
```

运行`npm run codegen:native-data`后，业务使用生成的`NativeItemPersistenceCodec`或`CreateNativeItemRepository(processName)`。`Entity.instanceId`已经标记`@transient`，恢复时必须由当前运行时重新分配，不能从数据库带回。当前Codec是严格当前版本读取，任何持久字段的增加、删除、改名或改类型都必须递增`@persistent(version)`；旧schema迁移注册尚未完成，因此做结构升级前必须先补迁移器。需要“按ownerId查询全部道具”、拍卖行索引、跨玩家交易等能力时，应建立Item/Trade领域Repository，不能把通用Payload表当作查询型ORM。

当前玩家记录已拆成五个一致性域：wallet=`gold`，inventory=`items`，progression=`numerics`，quest=`quests`，runtime=`map/position/alive/buffs/skill cooldowns`。任务GrantItem奖励和拾取提交inventory+quest；UseItem提交inventory+progression+runtime；NPC商店提交inventory+wallet；同地图交易一次提交双方inventory+wallet。每次事务只推进参与领域Revision。周期/退出快照按规范化编码后的领域Payload判脏，诊断`reason`变化不写库；首次未知基线仍保存全部领域，关键事务成功后同步该领域基线，批量部分失败不重复推进已经成功且未再变化的领域。该优化只减少普通快照写放大，不改变交易事务边界。`npm run test:player-domain-recovery`验证30秒周期快照、最终Flush、all-in-one强杀，以及静态MapHost强杀后的Watcher有界重启、Location代次接管和Gate新连接恢复；`npm run test:gate-failover`验证双Gate强杀后接管同一PlayerUnit、旧Gate重启不回切和绕过Login重入拒绝；`npm run test:player-trade:persistent`验证首选Endpoint接管、Debug模拟“DBProxy已提交但响应丢失”后的原始回执恢复，以及双Endpoint同时不可用时失败不改Entity、恢复后同一operationId只提交一次。普通状态允许最多一个周期窗口回退，已经确认的关键事务不得依赖周期快照。系统仍没有跨地图交易、邮件/拍卖行事务或动态地图现场恢复；Gate接管只覆盖同一已知拓扑，不代表跨地域租约HA。完整运行步骤见[DBProxy玩家快照持久化](../tutorials/19-dbproxy-player-persistence.md)。

## AI提交前自检

1. 是否只修改了需求真正涉及的目录？
2. 是否复用了现有Scene、Actor、Component和广播机制？
3. Handler是否保持薄，领域状态是否有明确所有者？
4. 是否错误遍历地图定位已知Actor？
5. Snapshot、Delta、Event是否选对？
6. 是否手工修改了Generated、msgcode、rpcId或codec？
7. 是否无依据进入Core或Rust？
8. 是否保留了用户原有脏文件？
9. 是否执行了与改动匹配的codegen和测试？
10. 是否在最终说明中列出验证过和未验证的部分？
11. 如果存在设计变更，是否同步更新了AI项目上下文和AI业务开发手册？
12. Model是否只从`app/core/public.ts`导入Core，Hotfix是否只从`#tiangz/model`导入稳定依赖？
13. System是否误加了字段、构造、静态成员或新的状态形状？公开方法是否显式标注参数和返回类型？
14. 故障测试是否使用确定性Fake或真实边界，而没有向生产配置加入随机故障开关？
15. 提交标题是否使用中文，并避免把无必要的英文Conventional Commit格式带入TiangZ及配套插件仓库？

## 外网演示部署

业务开发不应把公网IP、云主机密码或部署机器的内网地址写进业务代码。外网2C2G演示使用`configs/deploy/external-multiprocess/StartMachine.json`，由Watcher启动10个独立Process：LoginMgr、MapManager、两个Login、两个Gate、两个静态MapHost、一个动态副本MapHost和Location。MapManager与所有MapHost只走回环Inner TCP，外网入口仍只由LoginMgr、Login和Gate配置的`outerIp/outerPort`提供。Cocos3D编辑器预览自动读取`assets/resources/Config/tiangz-local.json`连接本机`127.0.0.1:7000`，只有非预览发布包读取`tiangz-external.json`；不要为了本机调试修改公网配置文件。
客户端只配置LoginMgr公网地址；LoginMgr再返回Login公网地址，Login再返回Gate公网地址。外网测试机由Nginx持有这些公网WebSocket端口，TiangZ入口只绑定`127.0.0.1`的独立内网端口：`17000→27000`、`17001→27001`、`17002→27002`、`17201→27201`、`17202→27202`。MapHost、Location和MapManager也只保持回环内网路由；它们没有公网入口。

这个端口分离不是业务路由逻辑，开发者不需要在Handler中处理。修改外网配置时必须同时检查`scenes`、共享`known-scenes.json`和`configs/deploy/cocos3d-nginx.conf.example`，保证`port`表示TiangZ实际监听端口，`outerPort`表示客户端连接端口；若把二者写成同一个端口，Nginx与Runtime会启动冲突。

当需要验证外网演示时，使用统一的“部署到外网测试机”流程：重新生成代码、构建后端和Cocos3D Web，确认是本次最新产物；后端先解压到`.next`目录，通过配置预检后在短维护窗口原子交换并保留上一目录，失败时立即回滚；两个Web目录仍按入口分别覆盖。Cocos3D前端使用`npm run build:cocos3d:external`一次生成两个入口：`build/external/desktop`部署到根路径`/`，`build/external/m`部署到`/m/`；根路径只能使用桌面`web-desktop`包，横屏`web-mobile`包只能放在`/m/`。
外网构建会在页面顶部显示`Build <版本>-<UTC构建时间>-<Git短提交号>`，Nginx对两个Demo入口发送`Cache-Control: no-cache, must-revalidate`。验收时应先确认Build标识已经变化，再检查Buff、快捷栏等业务表现；这样可以明确区分客户端缺陷和旧包缓存。
不要只看Nginx页面能打开就判断网络链路完成；云安全组必须放行实际的WebSocket入口端口。

后端正式发布使用本机Docker的Linux构建环境生成`linux-amd64` Release制品。外网机器只接收可执行文件、`dist`、`configs`、导航资源、版本信息和校验文件，不接收源码、Cargo工程、Node依赖或构建缓存。Runtime会从当前发布目录解析资源，因此制品可以从构建机复制到任意部署路径。

外网2C2G要验证账号和玩家数据重启恢复时，还要部署独立DBProxy。Ubuntu 24.04安装`docker.io`和`docker-compose-v2`后，使用DBProxy仓库的Compose文件启动Redis/PostgreSQL；两个容器只绑定`127.0.0.1`。DBProxy服务监听`127.0.0.1:7800/7801`，全部TiangZ Process的`persistence.dbProxy`都必须启用，令牌放进systemd环境文件。TiangZ的systemd单元必须用`Wants=`关联两个对等DBProxy，禁止用`Requires=`把任一候选故障传播成整组Runtime停机。不要把本机开发`.env`、数据库密码或公网凭据复制进仓库，也不要让业务Handler直接访问Redis/PostgreSQL。

日常Linux发布执行`npm run release:linux`。固定Builder镜像只保存Node、Rust、.NET Runtime、Luban和依赖，不保存业务源码；工具指纹未变化时不得重新下载工具链。每次发布仍必须重新执行Excel/Luban生成、全部codegen、TS构建和Rust Release编译，不能因为复用镜像而复用旧生成代码。只有修改`package-lock.json`、Cargo依赖/锁、Rust工具链、Luban版本或Builder Dockerfile时，才允许自动重建一次镜像。

## 进程部署环境与安全随机数（0.6.2）

- **部署环境**：进程配置 `process.environment` 取 `development | test | staging | production`，缺省 `development`，未知值拒绝启动。业务在任何位置（含 Hotfix、System、Component）通过 `ProcessRuntimeInfo.Instance.Environment` 读取；框架只报告取值，不替业务决定各环境的差异（例如是否允许开发账号）。宿主不接受 `--env` 一类命令行参数，业务 V8 也读不到环境变量，不要试图从 argv 或 env 推断环境。生产配置必须显式写 `production`，由部署工具核对。
- **安全随机数**：业务 V8 只有可预测的 `Math.random`，也没有 Web Crypto。凡是交给客户端、用于证明身份的值（登录凭证、重连凭证、邀请码、一次性令牌），必须用 `SecureRandom.Hex(n)` 或 `SecureRandom.Bytes(n)` 生成；GlobalId、时间戳、`Math.random` 都可预测，禁止替代。随机源不可用时 `SecureRandom` 抛错，不会退化；单次上限 65536 字节。

## Scene HTTP 入口（未发布）

用于工具、运维和简单查询接口（例如返回 Login 地址、GM 工具查询），不承载游戏玩法协议；游戏客户端仍走 TCP/WebSocket/KCP 与生成的协议描述符。需要纯 HTTP 游戏时另行设计，不要把本入口扩展成通用游戏网关。

- **配置**：在 Scene 配置加 `"http": { "port": 7080 }`，端口必须独立于 Scene 的 `port`。需要鉴权时用 `authTokenEnv` 指定环境变量，由 Rust 校验 `Authorization: Bearer`，令牌不进入 V8；浏览器工具跨域访问时配置 `corsAllowOrigins`。完整字段见[配置参考](../reference/config-and-protocol.md#scene-http-入口)。
- **写法**：一个接口一个 Hotfix Handler 文件，放在 `handlers` 目录；与 `rpcHandler` 一样不得声明字段、构造函数或 static 成员，状态放在 Scene 或其 Component。

```ts
import { httpHandler, jsonResponse, HttpError, type HttpRequest, type SceneHttpHandler } from "#tiangz/model";
import { LoginMgrScene } from "#tiangz/module";

@httpHandler(LoginMgrScene, "GET", "/login-nodes")
export class LoginNodesHttpHandler implements SceneHttpHandler<LoginMgrScene> {
  handle(scene: LoginMgrScene, request: HttpRequest) {
    const realm = request.query.get("realm");
    if (!realm) throw new HttpError(400, "realm is required");
    return jsonResponse({ nodes: scene.LoginNodes(realm) });
  }
}
```

- **语义**：路由按“方法 + 路径”精确匹配，没有路径参数和通配；请求进入该 Scene 的 mailbox，ordered Scene 中异步 Handler 会阻塞后续消息，耗时的查询放到 unordered Scene 或用明确的异步结果等待。`request.json()` 解析失败抛 400；`HttpError` 返回指定状态；其他异常返回 500 且只写日志。`jsonResponse` 把 bigint 输出为十进制字符串。
- **限制**：路由集合在第一代 Hotfix 后冻结，新增或删除接口需要重启 Process，修改已有 Handler 的实现可以热更。没有配置 `http` 的 Scene 注册了 Handler 时启动日志会告警，请求无法到达。当前不支持 HTTPS（交给 Nginx）、流式传输和 WebSocket 升级；出站 HTTP 调用（业务访问外部服务）尚未提供。

## 开发阶段与Release锁定

### 本机验证日志环境（2026-10-07）

`test:game-project-dev` 会等待宿主的 `Hotfix reload completed` 日志。若继承 `RUST_LOG=warn`，候选虽已提交，INFO 完成日志仍被过滤，测试会报 `behavior reload timed out`。运行此夹具时显式设置当前进程的 `RUST_LOG=info`，不修改系统配置、不放宽等待期限或删除完成断言。复测：`$env:RUST_LOG='info'; npm run test:game-project-dev`。本次首轮证据保留在 `target/http-verify-full-20261007.log`，独立复测在 `target/http-dev-retest-20261007.log`；以各次实际退出码判断结果。

当前主工程、两个VS Code插件和独立DBProxy都处于持续开发阶段。开发者可以迭代`package.json`/`package-lock.json`、`Cargo.toml`/`Cargo.lock`、插件版本和协议原型；日常使用`npm install`与普通Cargo命令，不要求版本副本、Stable API快照、opcode/schema锁或依赖解析完全冻结。生成物过期检查、类型检查、边界检查和运行时Protocol Fingerprint仍然有效，因为它们分别保护代码生成一致性、架构边界和在线连接兼容性。

准备正式发布时再开启冻结门禁：主工程运行`npm run verify:release`，它会设置`TIANGZ_LOCK_VERSIONS=1`并强制比较项目版本、`public-api.lock.json`和协议锁；开发阶段可运行`npm run verify:locks:warn`，它只报告漂移、不阻塞提交。插件与DBProxy由各自仓库执行发布前的版本、依赖锁、协议指纹和完整测试审查。除非明确进入Release，不要手工更新锁文件来“让检查变绿”，也不要把Release命令加入普通开发流程。

外置模块的协议生成工具默认严格检查 schema 锁：允许追加字段和删除字段（删除后锁保留该字段作为墓碑，编号永不复用），拒绝修改已有字段的类型、名称或编号。开发期确需修改这些时，在游戏工程执行 `node tools/tiangz.mjs protocol-update --dev-regen-schema-lock`（引擎侧为 `node tools/codegen_module_protocol.mjs --dev-regen-schema-lock`）。它按当前 proto 重写 schema 锁，同时保留旧锁中已删除字段与消息的墓碑，opcode 锁照常只追加；发布成功后逐条打印删除、改名、改类型、改请求响应关系等破坏性变化；在临时目录生成，失败时原锁不动；`TIANGZ_LOCK_VERSIONS=1` 的发布门禁下拒绝执行。重写属于破坏性协议变更，必须同时说明契约影响、重新生成客户端 SDK 并完整重启；不要为了绕开锁去改字段名。

## Action、Buff与Skill的当前规则

外部道具使用统一遵循`C2M_UseItemHandler -> ItemComponent.UseItemTransactional -> Planner -> DBProxy -> Commit`。`ItemConfig.use_effect=0`表示不可用，`1`表示添加Buff，`2`表示把`use_params`解释为`[ActionType, ...parameters]`。开发者优先改配置，不要为了不同药水复制Handler。`cooldown_ms`表示按ItemConfigId隔离的自身CD，`global_cooldown_ms`进入与技能共享的玩家GCD；Inventory、CD和效果必须先生成纯数据计划，DBProxy确认后才无await提交。当前事务Planner支持1001的`Heal(150)`和1002添加无AddAction的Stack Buff 2001；两者自身CD均为30秒、共享GCD均为1秒，2001后续Tick仍通过普通`ActionExecutor -> Heal(50)`执行。新增事务Action必须先定义操作后Payload和回执恢复，不能在执行副作用后再补保存。

`BuffComponent`拥有`Buff` ChildEntity；Component负责集合、实例ID、传送和AOI生命周期事件，BuffSystem负责Add/Tick/Remove和Timer。Buff传送只保存纯值及墙钟时间，目标重建Timer但不重复AddAction；不保存TimerId、闭包、Promise或Entity。Buff Tick只执行Action，Numeric和Combat沿用自身同步边界。一个Buff需要在同一生命周期阶段修改多项普通Numeric时，使用`ChangeNumericBatch([type, delta, ...])`；参数必须是一个或多个不重复的二元组，且全部通过非派生、非`CurrentHp`校验后才开始同步写入。模块需要按效果类别解除Buff时，在定义上登记唯一正整数`effectTags`，再使用`RemoveBuffsByEffectTags([tag, ...])`按任一标签同步移除；标签编号及其业务含义属于模块，Core/MMORPG层不得定义眩晕、恐惧、诱捕或某个游戏的驱散表。不要为这种组合效果复制Buff Handler，也不要把同步批量动作误当作DBProxy事务。

Combat不查询Buff。护盾类Buff在添加/移除边界注册/注销Combat modifier，伤害统一进入`CombatComponent.ApplyDamage`；禁止再设计`BuffComponent.TryAbsorbDamage`作为受伤入口。运行时Action和护盾剩余量会以纯值跨地图恢复。显式可规避命中可在扣血前进入`CombatEvents.BeforeDamage`只读Veto链，模块只返回不透明原因，不能在检查阶段制造副作用。七技能Cast与3006/3007持续效果已接入：3006瞬发添加恢复Buff，8次治疗由Buff Tick负责；无护盾吸收且未被规避的受击会让普通读条后移800毫秒、让引导提前800毫秒，护盾吸收或规避的攻击不产生这两种惩罚；移动仍会取消可移动中断的Cast，客户端只显示服务端状态。Cocos3D的引导连线仅是表现，不参与战斗判定；复杂地面目标、技能持久化和AOE仍不属于当前闭环。

技能只在`SkillConfig.xlsx`填写目标与时间线，在服务端专有的`SkillEffectConfig.xlsx`按顺序组合Action；客户端只生成SkillConfig用于名称、距离、读条和CD表现。若一个新技能可由现有Action与Buff组合完成，只改Excel并重新生成，禁止新增专用Handler或把伤害数值写回Hotfix目录。普通业务不得长期缓存`GetSkillDefinition()`结果；配置索引由`SkillCatalog.ts`按指纹统一维护。

## 道具出生与快捷栏

当前出生规则：新角色首次创建时获得`1001×3`小红和`1003×3`小蓝；读档、重连和跨地图不重复发放。快捷栏药品槽按配置ID引用`1001/1003`，数量以服务端进入快照和增量事件为准。

新角色出生时由`MapComponent`显式发放`1001×3`小红和`1003×3`小蓝；`ItemComponentSystem.Awake`不负责赠送道具。Starter任务奖励仍由任务事务单独追加；`RestoreTransfer`、重连和数据库恢复必须使用快照，不能在创建Unit时再次发放。快捷栏固定引用`1001/1003`的配置ID，数量从服务端快照读取；不能把快捷键映射误当作创建道具。

`ItemConfig.icon`放在客户端分组，填写相对`assets/resources`的Cocos资源键，例如`UI/Icons/Items/1001`，前端通过配置解析图标。Cocos3D Web的快捷栏固定约定为`1`切换平A、`2`发送1001使用请求、`3`发送1003使用请求；显示数量先读进图`G2C_EnterMap.items`，后续只接受`G2C_ItemChanged`更新。快捷栏是`ItemConfigId`的配置引用，不是某个永久`ItemId`的绑定：最后一件消耗后，服务端移除背包Item，客户端保留对应槽位并显示`×0`；同配置道具再次进入背包时，即使它拥有新的`ItemId`，槽位也会重新选择可用实例。按键或按钮不能直接修改本地数量，也不能把`itemId`写死；使用时应先按`configId`汇总服务端快照、选择一个数量大于0的具体Item实例，再调用生成的`MapClient.useItem`。

玩家3D模型必须挂在Unit表现根节点下，禁止直接用骨骼Prefab充当权威Unit节点。当前Cocos3D示例由`PlayerCharacterVisual3D`加载`BlueChibi`骨骼Prefab，模型原点在脚底，Unit根节点继续沿用身体中心和既有碰撞尺寸。业务只向表现控制器提交`moving/idle`等状态；`Idle/Walk/Attack`动画不能写坐标、参与寻路、决定命中或启用Root Motion。换模型时优先替换Visual资源，不复制或改写Map移动链路。

镜头环绕同样属于纯表现：Cocos3D左键拖动只维护本地`cameraYawOffset`，不能修改Unit朝向或发送移动协议。输入手势必须有拖动阈值；环绕手势结束后要消费鼠标抬起，避免一次操作同时触发地面寻路。短点击的怪物选择与寻路仍走原有射线入口。

Cocos3D的Buff栏从Unit快照的`buffs`或不可覆盖的`G2C_BuffAdded`创建图标，按`UI/Icons/Buff/<BuffId>`加载资源，文字读取`BuffConfig.name`显示中文名，不把BuffId暴露给玩家。倒计时使用服务端结束时间和客户端估算的服务器时钟，只显示`分钟:秒`，分钟不换算成小时；无限Buff显示`永久`。客户端显示到`00:00`后不得删除图标，删除只能由`G2C_BuffRemoved`驱动，不要把本地倒计时归零当成服务器已经移除。

## 条件内容与活动模块开发

需要让外部活动控制刷点时，先把全部候选登记到地图内容目录，并把非常驻候选设为 `initialSpawn=false`；不要在
活动开始时临时解析来源数据库或绕过目录创建 Unit。Monster、NPC、Interactable 的启停入口必须幂等，多个活动
共享同一候选时由游戏模块维护引用计数，只有首次取得所有权才激活、最后一次释放才停用。

Pool 一类候选集合应登记为 `SpawnSelectionGroup`。常驻根组默认启动，条件根组配置 `initialActive=false`，再由
模块调用 `ActivateGroup/DeactivateGroup`；不要直接启停子组，也不要让活动与父组同时拥有同一子树。活动规则、
日历、来源编号和正负关系属于外置游戏领域，TiangZ Core 只提供中立目录、幂等生命周期和定时器。

地图扩展发生在运行时组件装配之前。需要自动启动的模块组件用 `TimerSystem.TryGetInstance()` 判断完整进程运行时是否
存在，存在时安排下一轮回调；同时暴露接收注入时钟和激活控制器的测试入口。测试必须覆盖精确边界、重叠所有权、
先激活后停用和失败回滚，不能依赖等待真实节日或手工客户端观察。

## 多引擎客户端开发边界

当前Cocos3D、Unity、UE和Godot都可以作为技能、Buff、任务、道具和怪物协议的演示客户端。新增客户端表现时，先复用生成SDK的消息和配置，再实现该引擎的输入、状态缓存、HUD和视觉对象：Unity接入`LoginFlow`，UE接入`FTiangZLoginFlow`，Godot接入`TiangZClient`。不要在客户端重新计算伤害、Buff叠加、任务奖励、怪物死亡或技能距离；客户端只根据服务端的Cast、Impact、Buff、Quest、Numeric和EntityState消息更新表现。协议字段、msgcode和Codec变更必须回到Proto/codegen链路，不能直接改各引擎的Generated副本。

## 可观测性边界

业务代码使用 Scene/Actor 上下文 Logger 和框架已有自定义指标入口，不得创建 Observer Scene、定时 RPC 或业务内广播来汇总 Process 指标。每个 Process 的 `/metrics` 由 Rust Host 暴露，Prometheus 按 `StartMachine.json` 直接抓取。业务新增指标必须使用有限枚举标签，不能把玩家 ID、道具 ID、RPC ID 等无界值放入 Prometheus label。`CustomMetricSnapshot.labels` 只用于同一 Scene 内有限数量实例（例如静态 `map_id`），标签名必须是合法 Prometheus 名称，且不能覆盖 Host 固定的 `process/scene/scene_type/name/key`；实例身份不能继续伪装成 `values` 数值，否则同名快照会生成重复序列。`CustomMetricSnapshot.values` 默认按 Gauge 导出；只增不减、进程生命周期累计的字段必须在 `kinds` 中显式声明为 `counter`，不得仅靠 `_total` 命名猜测语义。修改观测契约后必须执行 `npm run verify:observability`。

跨Process追踪由Core自动建立和传播。业务Handler只使用`context.logger`和普通Scene/Actor调用，不得导入、构造或解析Trace Envelope，也不得把`traceId/spanId`作为业务幂等键。`requestId/operationId`负责业务身份和重试，`traceId`只负责诊断。日志中的`traceId/spanId`由框架注入；不要手工覆盖，也不要把玩家ID、请求ID、Trace ID放入Prometheus标签或Loki索引label。业务日志不得记录密码、Token、完整协议Payload或其他敏感数据。

修改Trace传播、采样、日志采集或Grafana数据源后，先执行`npm run verify:observability`，再用`npm run test:observability:faults`真实验证Gate故障和动态副本安全回退。后者会启动测试拓扑并停止测试进程，不能连接生产环境。

生产测试部署只允许Grafana经Nginx HTTPS开放；Prometheus、Alertmanager、Loki、Tempo、Alloy以及Node/PostgreSQL/Redis Exporter必须绑定回环或运维内网。告警Webhook、Grafana管理员密码和数据库Exporter连接串只能放在服务器`0600`密钥文件中。业务仓库不能保存这些秘密，也不能为了“方便看指标”把内部端口转发到公网。

Developer Tools 的“查看运行时指标”命令是只读的 `/metrics` 查看器，只能回答“这个 Process 当前有多忙”，不能回答某个 Unit、Actor 或组件的业务详情。不要为了调试临时增加业务 RPC、遍历全地图或暴露 V8 任意执行入口。按 UnitId、Scene、Gate 和 ActorLocation 查询的 Inspector 采用独立的、版本化的只读协议；当前只冻结了协议草案，正式接入前仍需完成 Runtime 控制通道、调试令牌、超时、限流、响应上限和快照一致性验收。

## 框架热路径与低分配约定

“0 GC”不是业务可以依赖的运行时承诺。开发目标是稳态下框架热路径少制造临时对象，并通过mailbox、队列和延迟指标验证收益；不要为了追求一个宣传数字把所有业务代码改成难以维护的手写循环。

### 业务开发者应遵守

1. 有结果要等待时使用RPC；无结果只通知时使用Message。不要为了“看起来统一”给单向消息增加`await`或人为回执。
2. 单向消息的Handler不能假设发送方知道处理完成时间。需要确认时改成RPC或显式业务事件，不要读取mailbox内部队列。
3. `SceneMessageHelper.send/sendActor/sendFrame`的返回类型是`MaybePromise<void>`。本地同步mailbox或远程入队通常直接返回`void`，`await`只为兼容确实异步的Transport；它永远不是目标Handler完成通知。
4. `LengthPrefixedFrameDecoder.pushEach`的回调只在当前调用内同步消费帧；不得缓存传入的帧视图、跨异步边界持有它，若要长期保存必须复制。
5. 广播状态选择`latest`或`event`必须先看语义：可覆盖状态用latest，不可逆事实用event。业务只提供Audience和数据，不维护Gate路由表。
6. 不在每个Unit、每个Cast或每条消息上创建框架Timer、Promise或长期闭包。高频状态使用已有Update桶、批量Snapshot和Component索引；真正需要等待结果的业务流程再使用Promise。
7. 不把`map/filter/spread`列为绝对禁用语法。只有性能报告证明它位于热路径时，才局部改为复用数组、循环或批处理，并补自测说明副作用。

### 框架已经提供

- ordered Actor/Scene mailbox忙时的队列节点回收与单向Message无完成Promise路径；RPC仍保留正常Promise语义。
- 协议流解码的回调消费路径，以及跨分片时才发生的必要复制。
- 编码latest广播的单批次路径和多批次空受众过滤。
- `/metrics`中的mailbox快路径、排队、异步、单向消息、当前深度和峰值指标。出现尾延迟时先比较这些指标、Handler耗时、Rust队列和网络下行，再决定是否优化。

### 压测前准备与低分配 A/B

框架热路径或Runtime改动后，先执行`npm run perf:hotpath:prepare`。它负责构建`build:bench`、`build:perf:full-chain`和Release Runtime，随后执行`verify:codegen`、`verify:comments`、`verify:hotfix-boundary`，检查生成物、Manifest哈希和本机测试端口；它不会启动服务、连接客户端或制造压测负载。

前后版本必须使用同一组参数，例如：

```powershell
npm run perf:full-chain -- --mode all --players 200,1000,3000 --move-rates 2 --warmup 10 --duration 60 --rounds 3 --output-prefix hotpath_before
npm run perf:full-chain -- --mode all --players 200,1000,3000 --move-rates 2 --warmup 10 --duration 60 --rounds 3 --output-prefix hotpath_after
npm run perf:hotpath:compare -- --before perf/results/hotpath_before_<时间>.json --after perf/results/hotpath_after_<时间>.json
```

`full-chain`报告中的Mailbox指标分为两类：Scene mailbox是所有Scene序列的聚合值，Actor mailbox是整个Process的单一汇总，不能把Actor总计复制到每个Scene后再次相加。单向消息排队应与尾延迟、Probe错误、Transport队列和业务错误一起判断；如果排队为零但p99上升，应继续看Handler耗时、编码、连接写出和客户端消费速度。`perf:hotpath:compare`要求参数、案例集合、轮数和资源字段完整一致；缺字段或存在stalled、Probe/传输错误、背压、内部超载时，比较结果无效。该流程还不能给出“每条消息分配多少字节”，精确分配量需要独立的V8 heap/profile实验，不能用GC次数替代。

### OP-05真实业务压测

Starter的真实业务容量必须使用同一场景做无业务/业务A/B。当前标准业务负载是每玩家每秒交替`UseItem`和`CastSkill`；公共CD、道具CD、距离或法力不足等规则拒绝计入`businessRejected`，只有超时、断连、RPC错配和协议解析失败计入`businessTransportErrors`。容量结论还必须同时检查`stalled`、Probe、Map frame/completion背压、Inner overload/timeout、慢连接和尾延迟。

容量工具还必须对比Runtime固定帧与Map业务Update频率。Map Update是同步回调；Runtime Pump先处理Scene mailbox和V8 microtask，再推进到期固定帧，高入站负载可能让Runtime固定帧与Map Update一起降频而CPU仍未达到目标。正式容量候选要求每轮Map Update都达到`1000 / fixedUpdateMs`的95%以上，并且所有正式窗口没有新增`skipped fixed updates`；否则即使Move输入、CPU和错误计数达标，也只能保存为失速诊断结果。

高入站负载还要检查Runtime Pump处理的Scene帧数与耗时。Runtime受`maxEventsPerUpdate`总量约束，并按轮转起点公平分配EntryScene。TS仍有入口积压时，Rust暂停新的data批次，但每轮最多注入128条control，为TS保留排空旧队列的能力；新事件继续留在有界宿主队列中接受明确背压。监控应同时查看`tiangz_scene_last_ingress_pump_frames`、`tiangz_scene_last_ingress_pump_cost_ms`、TS/Rust control/data队列和固定Tick。同步Handler仍不可抢占，业务Handler必须短小；修改批量或追帧参数后必须重新验证吞吐和p95/p99。

2026-08-21完成入站调度A/B后，Rust客户端在8 Gate、10x10 Grid、3000玩家、40人/秒进图下通过完整业务容量门：2Hz Move、0.2Hz Probe和0.1Hz技能/道具请求均达标，Map 20Hz且正式窗口零跳帧，Probe/业务传输错误、overload、timeout和backpressure均为0。该结果使用Map `maxCatchUpSteps=3`覆盖150ms内偶发尖峰，Probe p95/p99为190/234ms；它是当前机器与该负载画像的保守有效点，不是通用生产人数承诺。`DBProxy`商店、拾取、交易和跨玩家事务属于另一类持久化业务压力，不能被这组内存Repository的技能/道具结果代替。

## 怪物掉落与任务物品

任务掉落不能写成“怪物死亡时给附近所有玩家发一件物品”。开发者在`DropTableConfig`中用`quest_objective_id`声明它对应的`CollectItem`目标；`MonsterComponent`在尸体上保存掉落行，玩家调用`LootMonster`时再根据自己的Quest状态筛选。未接任务或已经达到要求数量时，拾取结果为无可用掉落，尸体行保留，不能删除或消耗别人的任务资格。普通掉落和任务掉落的领取范围不同，必须在配置/代码中明确，不能用一个全局`claimed`集合代替。

拾取属于一次关键玩家事务：先规划Inventory/Quest/Currency纯数据，再使用稳定`operationId`提交DBProxy，成功后才创建静态Item、推进任务、应用金币和广播。只有道具行时提交`inventory + quest`；包含金币行时原子提交`inventory + quest + wallet`，不能先加钱再保存。Handler只转发`monsterId + operationId`，不查询Quest、不扣库存、不手工发消息。动态词条、耐久、绑定等ItemInstance必须保存实例数据，不能把“拾取时生成静态ItemId”的Starter快捷路径误当成通用规则。完整流程见[`docs/design/loot-and-task-items.md`](../design/loot-and-task-items.md)。

### 尸体窗口调用约定

尸体拾取不是一次性按钮事件，而是一个可持续操作的窗口：

1. 点击尸体交互按钮只调用`inspectLootMonster`，打开服务端返回的掉落列表。
2. 点击某一行时调用`lootMonster({ monsterId, operationId, dropId, lootAll: false })`，只领取该行。
3. Shift+点击、鼠标右键、F键或移动端的“全部拾取”按钮调用`lootAll: true`。
4. 使用回执的`remainingDrops`重绘列表，并把本次获得的道具追加到窗口结果区；窗口由玩家主动关闭。

`LootDropSnapshot.gold > 0`表示铜币行，此时`itemConfigId/count`保持0；客户端显示铜币而不是尝试读取`ItemConfig(0)`。`M2C_LootMonster.gold`是提交后的权威余额，`gainedGold`是本次增量。

列表显示的是服务端资格筛选后的预览，不代表客户端已经拥有道具。不要在点击前修改背包数量，也不要用短暂Toast替代回执中的掉落结果。

尸体的显示时长和下一只怪物的重生间隔是两个独立时间轴：有掉落的尸体默认保留5分钟，无掉落的尸体保留10秒；全部普通掉落领取完成后可以立即清理尸体。`MonsterConfig.respawn_seconds`从死亡时刻计时，到期后刷怪槽直接创建新Unit，不等待旧尸体消失。任务掉落属于按账号判定的资格，不能因为一个玩家领取完成就删除尸体。客户端收到AOI Leave后关闭对应旧UnitId的拾取窗口，不能继续用旧UnitId发起新的拾取请求；丢响应重试仍复用原`operationId`读取持久化回执。

## Starter金币、NPC商店与法力恢复

Starter的普通掉落表1按每行独立概率判定：破旧布料1201为80%、小型生命药水1001为15%、大型生命药水1002为5%；三行可以同时掉落，也可以全部未命中。`ItemConfig.sell_price`分别为10、20、50铜币，Map 100的9002杂货商读取服务端商品目录出售红药和蓝药。NPC商店不是客户端配置价格表：客户端先调用`OpenNpcShop`拿目录和金币，再调用购买/出售RPC；服务端在PlayerUnit ordered mailbox中校验NPC、距离、商品、Item归属和金币，创建Inventory/Currency纯数据计划，最后使用DBProxy的稳定`operationId`事务提交。提交成功后才应用内存和发布ItemChanged；失败或重试不能由客户端预扣或重复发放。快捷栏只能引用ItemConfigId，不能绑定出售后失效的ItemId。

需要让箱子、采集点等地图可交互物产生普通随机物品时，在`InteractableContentDefinition`配置`lootTableId`，并通过地图的`LootContentProfileComponent`登记对应行；不要把随机结果预先写入固定`rewards`。普通行使用`chancePermille`，互斥候选共享正数`groupId`，数量使用`minCount/maxCount`。如果玩法需要“先判定整组是否出现，再从组内选一项”，同组所有行共享`groupGatePermille`；`0`或省略表示无门槛。组门槛、显式概率成员选择、显式成员全部未命中后的零概率成员等权兜底必须分别使用独立确定性抽样通道；显式概率总和超过1000或占满概率后仍声明等权成员必须在登记期失败。需要在某个候选命中后继续执行另一张表时使用`nestedDropTableId`，包装行本身不发奖励、不带任务资格且只执行一次；登记阶段必须让缺表、任务子表、循环或超过16层的内容图失败。固定`rewards`继续用于按活动收集目标裁剪的任务物品。`Use`会以稳定operationId确定性掷骰并在同一个`inventory + quest`事务提交，只有持久化成功后物体才离开AOI并开始`respawnDelayMs`。来源数据库编号、宝箱种类和客户端拾取表现由外置模块或协议适配器拥有。

只需进入场景表现、但当前没有安全玩法投影的地图物体，配置`interactionEnabled=false`。这类实体仍有稳定刷点、位置、AOI和`presentationModelId`，协议适配器应把它显示出来；服务端会拒绝`Use`，定义也不得声明`rewards`、`lootTableId`、任务目标或任务入口。不要因为尚未实现某种来源交互就丢弃整个刷点，也不要把来源GameObject类型加入Core枚举。导入器应分别报告“无法生成实体”和“实体已生成但交互待实现”，后者以后通过配置和模块能力升级为`interactionEnabled=true`。

采集类交互使用同一套定义的可选`proficiencyId`、`requiredProficiencyRank`和`proficiencyGain`，不要按地图或物体类型增加Handler分支。玩家熟练度由`SkillComponent`以`rank/maximumRank`持久化；训练师报价可用`requiredSkillLineId/requiredSkillRank`检查同一中立ID，并用`grantedProficiencyId/grantedProficiencyMinimumRank/grantedProficiencyMaximumRank`提高上限。若外部游戏用一个课程或包装技能教授其他实际技能，应配置`grantedSkillConfigIds`，不要在Handler里解释包装ID；省略该字段时默认授予报价技能本身。技能集合、钱包与熟练度必须写入同一事务回执。含熟练度成长的交互自动升级为`inventory + quest + runtime`事务。具体游戏的专业名称、ID、训练阶级和客户端技能栏投影必须留在外置模块/网关。

`CurrencyComponent`只负责非负`bigint`余额，不加入商店名词；`NpcShopComponent`负责编排，`ItemComponent`负责Item实体。玩家交易已经在同一边界上使用DBProxy多记录事务，不能把两个玩家的单人购买/出售请求在客户端拼起来。商店示例见[`docs/design/currency-and-npc-shop.md`](../design/currency-and-npc-shop.md)，玩家交易见[`docs/design/player-trade.md`](../design/player-trade.md)。

Starter Boss的表3固定掉落小红、大红、蓝药各5个和150铜币，用于验证同一尸体拾取事务同时修改Inventory与Wallet。进入Map 200则是另一条`progression`事务：个人10分钟CD归`ProgressionComponent`，先在当前PlayerUnit ordered mailbox持久化，再允许Gate创建/复用动态实例。Gate、MapManager和副本实例都不保存个人CD；跨MapHost传送通过`PlayerTransferSnapshot.starterDungeon`携带，登录/重连响应返回截止时间供客户端按钮倒计时。

技能费用当前暂由Hotfix的`SkillManaCost.ts`维护，服务端在创建ActiveCast前检查并扣除MP；法力不足直接拒绝，读条中断不返还。`CombatStateComponent`记录仍持有玩家仇恨的非玩家Unit集合：Monster或战斗型NPC死亡、回归出生点或清除仇恨时调用`RemoveHostile`；集合为空才脱战。旧`AddMonster/RemoveMonster`只是兼容别名，新生命周期统一使用`AddHostile/RemoveHostile`。战斗状态不恢复MP，脱战后按180秒从当前值恢复到MaxMp，固定更新桶用整数余数累积。该状态是地图临时运行态，传送时清空，不写入持久化快照。

### DBProxy就绪边界

外置模块需要保存普通单记录状态时，依赖 Core 公共入口的 `VersionedEntityRepository`，不要读取 `globalThis.__hostDbProxy`、自行拼 Host RPC 或把领域类型加入 DBProxy SDK。用稳定 codec 声明 namespace/schema/version，通过 `CreateVersionedEntityRepository` 获取实现；每次变更携带已读取的 revision，发生 `IsVersionedEntityRevisionConflict(error)` 时重新加载并重新计算，不能盲目覆盖最新状态。

工厂在没有 Host DBProxy bridge 的测试或本地进程中使用共享内存实现，它适合确定性单测与同进程重建测试，但进程退出即丢失。凡需求写明“重启恢复”，验收必须在启用 DBProxy 的真实 Process 上执行写入、停止、冷启动和读取；仅通过内存 Repository 测试不算完成。

启用DBProxy持久化后，Runtime会在`/ready`成功前建立连接池。业务Handler不需要也不允许自行预热连接；若全部Endpoint不可用，Process不会对外宣称ready。部署编排应以健康检查决定接流量，并由监督器负责重启失败进程。

### 配置随机游走节奏

需要表达“连续走若干路段后概率停顿”的随机游走时，在刷点的`wanderSchedule`中配置`initialDelayMinMs/MaxMs`、`pauseMinMs/MaxMs`、`firstLegPauseChancePermille`和`additionalLegPauseChancePermille`。运行时会在每次实际停顿后清零连续路段计数；省略该结构时保留每个随机目标到达后停顿的兼容语义。来源数据库规则应在外置导入器中转换为这些参数，不得写成通用MMORPG代码中的来源专用常量。

### 活动内容 patch

节日、赛季或世界状态需要临时改变NPC/交互物内容时，调用`NpcComponent.ApplyDefinitionContentPatch/ApplySpawnContentPatch`或`InteractableComponent.ApplyDefinitionContentPatch`，并使用`<模块ID>:<业务事件>:<目标>`一类稳定 owner key。停用时必须用同一 key Remove；不要直接改 Unit 字段，也不要用停用事件写一份反向数据。运行时会对所有 owner 做集合并集和服务能力合成，移除一个 owner 不会删除另一个活动仍需要的任务或商品。

定义级增量适用于同模板全部现有及未来刷点，刷点级增量适用于单个实例。模型和装束是单值覆盖，同一时刻两个 owner 给出不同值会明确失败；训练服务只有基础资料存在trainer目录时才可启用。命名空间扩展能力只供外置适配器解释。每次有效变化都会推进`runtimeProfileRevision`，完整最终状态随AOI快照发送；需要让已在线客户端立即更新时，外置模块还应发布自己的Extension表现。通用业务代码不得理解来源数据库的事件号、NPC flag、客户端模型或装备编号。

### 自定义任务事实

现有击杀、物品、进图和交互目标无法准确表达外部游戏的特殊任务事实时，可在模块侧把已确认结果发布为 `QuestObjectiveType.ContentSignal`。`targetConfigId` 必须由模块自己的 Luban 配置生成，Handler 只能在来源领域条件全部满足后发布 `QuestEvents.Progress`；不得把来源法术号、任务号、地图号或数据库 entry 加入 Core 枚举、配置或分支。验收至少包含一个不依赖具体游戏的 Core 进度测试，以及模块的正向、条件不满足负向和生成数据引用测试。

### 配置战斗周期动作

需要让怪物在进入战斗若干秒后执行动作，并按区间冷却重复时，使用 `MonsterContentBehaviorTrigger.CombatInterval`。四个计时字段 `initialDelayMinMs/MaxMs` 与 `repeatDelayMinMs/MaxMs` 必须成对给出且区间不能倒置；动作仍使用现有 `Say`、`Emote`、`ApplyBuff`、`ExecuteAbility` 或 `Evade` 中立契约。动作只应在目标缺少某个模块Buff时执行，可填写正整数`requiredAbsentBuffDefinitionId`；Core在执行动作前同步读取动作目标的`BuffComponent`并跳过已存在的情况，不推断法术、光环或来源flag。不要在 Core 中加入来源引擎的 `UPDATE_IC`、施法 flag 或法术表逻辑；这些只应由模块导入器转换并由模块处理不透明能力请求。

需要在怪物每个新运行实例创建后执行一次配置动作时，使用 `MonsterContentBehaviorTrigger.Spawned`。它同时覆盖首次生成和死亡后的新实例，不携带来源引擎事件号，也不接受生命、Buff或计时字段；概率与动作继续使用通用行为规则。模块导入器负责判断某个来源“出生/重生”事件能否安全转换，不能把具体游戏的刷新脚本写进 `MonsterComponent`。

外部客户端动作需要触发怪物配置行为时，使用 `MonsterContentBehaviorTrigger.ExternalSignal` 与 `C2M_TriggerMonsterSignal`，不要为某个 opcode 或游戏事件增加 Core 分支。规则必须配置正整数 `requiredSignalId` 以及成对的 `repeatDelayMinMs/repeatDelayMaxMs`；适配器负责把来源协议值转换成模块自有信号，并且只能提交当前玩家 AOI 内的存活怪物。Core 只做同地图、身份、可见性、确定性概率和冷却校验。协议回显、文本变量替换、来源枚举以及信号编号的业务含义仍留在外部模块或网关。

### 模块编排休眠怪物刷点

顺序挑战、波次或其他模块领域状态机应把每个参与者预注册为 `initialSpawn=false` 的稳定刷点。开始阶段调用 `MonsterComponent.ActivateSpawn`，需要指定玩家成为战斗目标时调用公开的 `AddThreat(monster, player, positiveAmount)`；结束、失败或超时时调用 `DeactivateSpawn`，由 Core 统一清理活体、尸体、AOI、召唤物与战斗仇恨。长延迟必须使用组件自有 `NewOnceTimer`，以方法名解析当前 Hotfix 实现并在组件销毁时自动取消；不要让数分钟倒计时占用 `Scene.Tasks` 短任务槽。具体游戏的阶段表、对白、任务条件和来源脚本编号全部放在外置模块 Luban 配置中。

### 给服务实体组合战斗状态

当来源数据中的同一个NPC同时承担任务、商店等服务并拥有战斗资料时，不要把它改造成`MonsterUnit`，也不要在Core中按来源flag或entry分支。模块应把自身Luban数据投影为`NpcContentDefinition.combatProfile`：生命、法力、伤害、移速、攻击范围与间隔、主动索敌范围、回巢范围，以及`attackablePlayerConfigIds/aggressivePlayerConfigIds`。主动资格必须是可攻击资格子集；空数组明确表示本地图没有符合资格的玩家，不能解释为“全部”。Core的NPC工厂会选择性装配`NumericComponent/CombatComponent/SkillComponent`，并由`NpcComponent`统一处理玩家平A/技能/延迟伤害、仇恨、NPC追击攻击、回巢满血、死亡、10秒尸体及刷点`respawnSeconds`重生。纯服务NPC不装配且不进入该循环。来源阵营、PvP、SmartAI事件和客户端敌对标记仍由模块导入器与协议适配器解释；模块不得直接写NPC血量或复制第二套生命周期。

需要让这类 NPC 执行配置行为时，在 `combatProfile.behaviorRules` 或刷点的 `combatBehaviorRules` 中使用中立触发器和动作。`Reset/Engage/CombatInterval/HealthRange/ResourceRange/TargetDistanceRange` 只描述运行态事实；`ExecuteAbility` 携带模块拥有的不透明能力 ID，模块监听 `NpcEvents.CombatActionRequested` 后调用公共 `SkillMapComponent.Cast`，不要在 NPC 循环中直接扣血或复制技能实现。`SetCombatMovement/SetState/ChangeState/Flee` 由 Core 执行，链接动作应保存在同一规则的有序 actions 数组中。资源恢复使用成组的 `resourceRegenAmount/resourceRegenIntervalMs/resourceRegenDelayAfterSpendMs`；任一字段缺失、没有资源上限或数值非正都会在内容登记时失败。恢复公式、施法时间、射程、弹道与资源费用仍应由模块 Luban 配置生成。

普通 Monster 模板也可声明相同的三项资源恢复字段。模块应把技能费用写入 `SkillDefinition.resourceCosts`，把恢复数值写入 `MonsterContentDefinition`；技能系统负责原子扣费，Monster 更新只观察扣费结果并推进延迟恢复。不要在行为 Handler 中再次扣资源，也不要把“mana”等来源游戏资源名称加入 Core。回巢会恢复生命和主资源，并清除本次恢复计时；重生实例重新从模板上限开始。

修改生命或资源上限时只写对应的 Base/Add/Pct 来源字段，不要在模块中复制封顶逻辑。`NumericComponent` 会在派生 `MaxHp/MaxMp` 降低后把超出的 `CurrentHp/CurrentMp` 向下夹紧；上限提高不会自动恢复当前值。需要提高当前值时必须显式走治疗、资源恢复或其他业务动作，不能借修改上限隐式实现。

### 配置内容生物等级区间

外部内容的怪物等级不是协议网关临时猜出的显示值。模块应把来源模板投影为`MonsterContentDefinition.minimumLevel/maximumLevel`闭区间，两项必须同时提供、均为正整数且最小值不能大于最大值；不需要等级范围的通用内容可以同时省略，运行时兼容为Level 1。`MonsterComponent`会按稳定刷点ID和成功创建代数选择等级，并在Unit进入AOI前写入`NumericType.Level`；死亡后的新实例会进入下一代并重新选择。生命、资源和伤害仍严格使用定义中的明确数值，Core不会因为Level自动套用某个游戏的成长、精英或职业公式。需要逐级属性变体时，应先在模块Luban构建阶段算出可审计的数据投影，再扩展中立配置契约，不要在Core读取来源表或加入具体游戏分支。

NPC使用`NpcContentDefinition`中的同名可选闭区间和同一个刷点代数选择规则。纯服务NPC显式配置等级后只增加Level及满足Position/Numeric同步不变量的既有正移动占位值，不会自动变成可攻击实体；只有`combatProfile`仍能装配生命、资源、攻击、Combat和Skill。模块不得为了显示等级伪造combatProfile。没有等级区间的NPC维持原来的无Numeric组件形状；创建失败不递增代数，成功重生或停用后重新激活才重新选择。

来源游戏需要随实例等级改变战斗数值时，应在模块Luban构建阶段输出`combatStatsByLevel`。该数组为空表示沿用顶层静态`maxHp/maxMp/attackDamage`；非空时必须包含闭区间内每一级且不能重复或越界，注册失败必须保持目录原子性。运行时选择Level后只取完全匹配的行，不做插值或公式计算；重生选择新等级时同步重建该级生命、资源和攻击值。Monster把曲线放在定义上，战斗NPC把曲线放在`combatProfile`内；纯服务NPC仍不得为显示等级伪造战斗曲线。

### 复用 Unit 数值脉冲恢复

Monster、战斗 NPC、PlayerUnit 或临时所有物需要“资源下降后等待，再按固定间隔恢复”时，给 Unit 组合 `NumericRegenerationComponent`，并由该实体所有者已有的固定更新桶调用 `Tick(nowMs)`。定义使用调用方拥有的 Numeric 当前值/上限编号及 `intervalMs/delayAfterDecreaseMs`，恢复量必须在固定 `amount` 与动态 `amountNumericType` 中二选一；后者适合把等级成长、装备或属性公式的最终结果预先写入 Numeric，使下次脉冲直接采用新值。不要在通用组件里写 mana、能量、职业或来源数据库枚举。资源被回巢、复活等领域流程直接重置后必须调用 `ResetSchedule()`，避免继承旧延迟。不要复制 `lastObservedResource/nextResourceRegenAtMs` 到 Monster、NPC、玩家或召唤物私有状态，也不要为每个 Unit 新建 Timer。外置模块通过自己的 Luban 表提供具体数值，并在生成/装配边界转换为这一中立定义。

### 给交互物接入模块动作

不产生物品、掉落或任务事务，但会触发位移、机关、表现等地图行为时，在中立定义中填写正整数 `interactionActionId`，并由模块监听 `InteractableEvents.ActionRequested`。Core 会先执行可用性、同地图、距离和熟练度校验；Handler 只接收已验证的玩家、交互物与不透明动作编号。动作定义不得与奖励、掉落表、任务入口/目标或熟练度增长混用；需要耐久事务的玩法应继续走原有 `Use` 事务链。模块选择目标点后调用 `MapComponent.RelocateUnit`，协议适配器再消费模块自己的表现键。不要把来源 GameObject type、opcode、坐姿或地图编号加入 Core。

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

## 外置模块的持久事件业务（2026-09-10）

### 独立地图接入检查

1. 在 MapHostScene 的同步扩展中登记 MapContentProfileComponent。空间、出生点、AOI 网格、频率层和准入预算由模块提供；发布后目录不可变，模块 ID 不能与主工程冷表冲突。主工程 MapConfig 不需要占位行。Grid2D 以地图中心为原点，宽深需整除 AOI 网格；客户端像素坐标必须显式转换。
2. MapScene 扩展登记玩家与内容配置，实际在线状态挂到 PlayerUnit。MapScene 没有 Entity Parent；需要部署身份时读取其 ProcessName。使用 PlayerPersistenceComponent.RegisterPersistenceExtension 让模块状态参与存档、同进程及跨进程迁移，不保留旧 Session 引用。
3. 模块 Gate 子类复用角色事务、位置路由和 EnterPublicMap/ListPublicMaps。显式转发内部 Probe、MapReady、ClientBroadcast/Batch、KickPlayers 绑定；不要假设装饰器继承。入口必须先验证真实账号和角色，再由服务器构造内部身份。
4. 换线与传送后签发新输入租约，重置客户端序号；重连按 Location 中的原地图及实例恢复。广播 generation 使用真实 MapInstanceId，客户端拒绝旧实例快照。AOI 附近人数与分线总人数不能混用。
5. 跨进程迁移信封现为 schemaVersion 11，新增模块状态字段；运行协议 codegen 并重建、重启全部参与进程。验收必须覆盖跨进程血量/死亡/冷却保留、任务 outbox/inbox、冷重启，以及**有玩家时**的正常停机。仅业务断言通过、进程异常退出不算完整通过。

宿主停机通过保留 Promise、排空完成事件、检查结果实现；停止业务 Tick 后仍要提交 Location RPC。不要用无限等待、强杀进程或忽略退出码掩盖生命周期问题。容量数字是配置预算，真实承载量必须另行压测。

独立游戏除构建外，还要运行 `verify_hotfix_boundary.mjs --modules-dir <目录>`。声明的协议生成目录有受限的 `binary/message/rpc` ABI 例外；不要修改生成文件或把手写代码放进生成目录规避 Stable 入口。运行时方法检查使用 `verify_runtime_contracts.mjs --project <模块 tsconfig> --scan-root <模块 src>`。

涉及“状态已写入但异步业务也必须最终执行”的流程，使用 `HostDbProxyRecords.CommitRecords` 一起提交业务回执和 `CreateOutboxEvent`。消费者以 `producer:event_id` 创建持久 inbox（CAS 0），与目标状态 CAS 同事务，成功后才 `HostStreamConsumer.Ack`。旧事件的业务适用条件应在事件产生时保存；不能用消费时的新状态反推死亡时是否已接任务。未知提交结果保留原请求或读取持久回执，失败不 ACK。

每个 Process 部署一个固定 Redis 消费目标、一个领域消费入口，轮询不可重入；业务不接收 Redis URL。补齐 backlog、重复投递、提交后 ACK 失败、重启回收和奖励幂等的真实存储验收，避免只测内存事件。接口与边界见[记录与事件闭环](../design/record-outbox-consumer.md)。

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
- 发布顺序：先给tiangz-native-language打`v0.17.0`，再升级TiangZ依赖；默认发布依赖仍为0.16.0，新标记不生效。0.7 独立工作树已用明确本地 tgz 联验 0.17 候选，不代表已更新正式依赖；见[候选联验](../design/v0.7-native-candidate-integration.md)。公共API锁的处理见[API稳定性迁移记录](../reference/api-stability.md#开发中)。

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


## v0.7.0-rc1 发布准备的环境记录

隔离目录首轮 check 为 7/8，模块宿主项因尚未构建 target/debug/TiangZ.exe 拒绝；不能复用旧二进制宣称通过。随后 Windows 首次构建因 Cargo 注册表位于 C 盘、target 位于 D 盘，V8 构建脚本创建跨卷目录链接时返回 Win32 1314（缺少符号链接权限）。保留两次原日志，使用与 Cargo 注册表同卷的本次专用 CARGO_TARGET_DIR 重建，不修改系统权限或依赖源码。新宿主复制回本次隔离目录后复验模块宿主；最终结果与 SHA256 记录在发布验证附件中，旧失败不改写。独立构建与复验尚未完成时不得标记通过。


## RC1 发布门禁的夹具修正（2026-10-08）

远端旧功能分支的完整 Windows/Linux CI 暴露两个夹具问题。V8 deadline 回归以 65,540 个串行 Promise 轮询挤入 5 秒，与回收语义无关的调度吞吐影响结果；保留全部创建/取消次数、容量、回收断言及原 5 秒期限，改成最多 256 项一批并逐批等待，本地 exact 回归 0.77 秒通过。控制入口满额后只观察共享 reserved/rejections，不能证明 TCP 尾批已进入 TS；现要求最后一个输入 RPC 的真实拒绝响应已返回，且目标 Scene 入队数为 65,536，才开始热更。默认额度和 3 秒热更期限不变。完整三轮 hotfix fault matrix 已通过，满额场景 pause=316.5384ms。修正只在测试/夹具，不改变生产调度或配额；旧失败日志保留，最终跨平台 CI 需重新核对。

### Scene HTTP 与 0.7 生命周期

HTTP 使用 Scene 的独立 `http.port` 和 `httpHandler(SceneCtor, method, path)` 精确路由，面向工具接口。入站复用 0.7 Host 事件字节预算，队列或预算不足立即返回 503。调用方超时不取消已开始的业务，也不提前归还执行名额；尚未开始的过期请求不进入 Handler，Scene 销毁会清理排队请求。业务需要自行保证修改操作的幂等性。共享 Developer Tools Hotfix 检查器必须包含 `httpHandler` 状态规则，宿主锁定提交为 `198afe8f040d1fc1e17d1a3250791cb62e25109b`。出站 HTTP 尚未提供。

HTTP 合入 0.7 的首次完整矩阵在 Rust 测试编译失败：`process_endpoint_tests.rs` 手工构造 `SceneConfig` 时缺少新增的 `http` 字段，quick 为 33/35。修正为 `http: None`，保持原端点断言；不能只用 `cargo check --bin` 代替全目标测试。原日志保留在 `target/http-rc1-verify-20261007.log`，完整复测另写日志，不覆盖失败证据。此前 0.6.2 基线的日志过滤与 Windows V8 构建路径失败也保留在 `target/http-verify-full-20261007.log`；本轮设置进程级 `RUST_LOG=info`，使用本机可编译的 Cargo 输出目录并把新宿主复制到测试实际读取的 `target/debug`。不能把旧宿主的通过结果算给新源码。

HTTP 合入 0.7 最终完整复测通过：Windows 默认功能集 full 9/9、quick 35/35、TS 234 项、Rust 全目标 284 项。先前夹具遗漏已修正，首次失败证据保留；实际宿主身份、范围和日志见 [0.7 发布记录](../../RELEASE-v0.7.0-rc1.md#rc1-标签之后的-07-集成)。HTTP 监听失败参与 Process 监督，读体/回复共享期限，停机按既有预算排空并 join 连接；运行中业务真实结束前不得归还执行许可。
