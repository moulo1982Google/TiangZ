# AI 技能开发约束入口

技能保留会改变开发决策的规则，并按需指向权威文档；具体玩法数值、临时目录、测试结果不升级为跨游戏规则。本文件随主工程版本管理，供工作区技能和独立插件引用。换机器须同时迁移/安装技能入口，不能假定聊天记录或已安装旧插件会自动更新。

## 开发前必须判断

1. **先确定工程和所有者**：TiangZ 是宿主，游戏在 Examples 或外部模块；不要把 SLG/MMORPG 业务塞回 Core。模块自己的 Model 放状态，Hotfix 放方法，Handler 只适配。先读目标工程 AGENTS.md 和模块说明。
2. **先确定驱动方式**：请求驱动、稀疏到期 Timer、连续模拟 Update 分开选。Runtime Pump 不等于固定模拟帧；存在帧尾出站队列不代表业务已经实现状态广播。查看实际注册的 System/Component/协议再作判断，不照搬 MMORPG 的 AOI、移动和同步循环。
3. **禁止业务等待时间**：包括短延迟、零延迟、Promise 包装和原生定时器绕过。使用所有者 NewOnceTimer/NewRepeatedTimer 与方法名；Model 保存任务及截止时间，到期检查状态/代次并幂等结算，恢复后重建调度。数据库/RPC 结果 await 仍合法。完整范式见 [时间调度](../patterns/timer-update-and-action.md)。
4. **选择同步语义**：快照用于恢复；latest 只能覆盖相同业务 key 的可替代当前状态；抽卡结果、扣费、结算等事实不得静默覆盖。网络可靠排队不是持久业务 exactly-once，需事务/幂等与必要的重连恢复。倒计时可同步截止时间由客户端显示，不必每帧广播秒数。见 [状态同步](../patterns/state-replication.md)。
5. **区分外部与内部协议**：C 协议不能用作 Inner RPC，字段相同也要生成 S descriptor；不得关闭访问校验。Proto、锁、SDK 走目标模块官方生成入口，不手改生成物。见 [失败教训](business-development-manual.md#失败教训与复测流程)。
6. **持久化先设计失败语义**：DBProxy 桥存在不代表已配置或可用；有数据库配置时故障不能降级内存。结果未知保留原操作号和完整事务重试，多记录一致性使用事务而非假定批量保存全成功；随机结果一旦成为待确认事务就不能在重试时重抽。恢复不重新扣费，schema 不兼容不重置资产。
7. **保持热更方案边界**：按当前设计保留一个 Hotfix 发布包，Hotfix 与配置作为进程内一致版本切换。沿用帧间切换与现有主动暂停入口、默认 3000ms 窗口；不为新业务再造额外屏障或无限等待全局空闲。帧间没有同步代码执行不代表跨 await 任务不存在；超时按现有恢复旧版路径处理。该窗口不保证任意已等待的 30 秒 RPC 都不会超时，也不代表所有 Pod 同时切换。Model/协议/Native 指纹变化走重建重启。见 [热更设计](../design/typescript-hot-reload.md)。
8. **证据分层与失败留档**：纯规则、假存储、真实 RPC、真实数据库恢复、UI、长稳分别报告，不能互相冒充。首次失败也记录原因、正确修法、禁止绕过与复测命令，更新 project-context 与 business-development-manual。Rust 改动重建后旧二进制测试结果不能复用。矩阵须有每步期限和子进程树所有权；超时/中止/未回收不能算通过，中止后未运行项记 skipped。明确 Cargo features 与实际运行宿主身份；编译路径失败须重新触发编译验证，不能只靠缓存命中。故障注入/清库/长稳只在用户授权范围运行。
9. **区分框架目标、插件版本与已装依赖**：worktree/分支的 0.7 不是 Native、Developer Tools 或 AI 插件的版本号；分别核对 Core、VSIX、插件清单和宿主真正解析到的包。新 API 先确认目标 checkout 是否存在；本地候选联调与默认已发布依赖分开记录，临时 path/包覆盖不进入正式依赖锁。宿主类型身份以该项目的声明为准，同名类/装饰器不能冒充当前 Core。
10. **预算与所有权覆盖整个操作**：存储排队、读取、迁移、编码、退避和重试共用上层期限，重试保持原 ID 与同一字节载荷；支持预算的 SDK/Host 才能宣称 I/O 有界，Promise.race 不代表后台任务已取消。Timer 取消或所有者销毁不代表已触发的异步回调结束，热更需等待其真实收敛；本地 Actor 与 unordered Scene 调用也需独立计入屏障，不能依赖网络或 Spawn 间接计数。注销 Scene 后仍计入未结束的 Spawn，最后真实完成主动移除持有引用；watchdog 等句柄绑定原服务实例，迟到清理不能操作重启后的同号资源。销毁只能立即终结未执行节点，运行中的调用直到实际完成才归还；出队槽和空闲池要验证引用释放，池容量不等于任务/字节额度。回调中新建的到期任务按当前版本的执行轮次契约验证。句柄移除不代表 Socket/任务已经释放，限额测试检查实际资源回到基线。
11. **保持通用后端与克制拆分**：已经持有 Actor 地址就直接路由；LocationDirectory 是按需选用的逻辑所有者目录，不是地图坐标、MMORPG 必装服务或每条消息的必经查询。MapHost/AOI 等留在领域模块。按独立职责拆分大型文件，避免每个函数一份文件、只转发的抽象层及把搬移与语义修改混在一个提交；原顺序、所有权与错误行为需可核对。

## 相关能力被修改时再核对

- **Host 驻留准入**：数据/回复在执行前预留，批次任一失败必须在执行前回滚；已执行回复不能在打包时重新竞争容量。成功结果确定实际长度后缩减，守卫随混合批次移动至 V8，最后 Native/V8 引用释放才归还，GC 待回收继续计费；不以保留原 Bytes 代替守卫转移。Disconnect backing 使用独立额度并沿用原清理期限，开始执行的数量确认不是 backing 释放。新调用满额返回 1011，既有完成与停机继续进展；不强制 GC、不重放事实，不将固定驻留成本称作任意业务堆或 RSS。新增入口检查要求测试夹具也显式取得守卫，不能在测试构建关闭保护。见[字节契约](../design/v0.7-host-event-budget.md)。

- **排队确认档位**：`@queued` 不选择持久性。DBProxy postgresRedis 后端的 `backlog.enqueueAck` 默认 aof 等本地 AOF 落盘，memory 仅确认 Redis 内存，均非 PG 提交；成功响应不携带档位，须核对部署契约。测试 memory 后端另为易失存储。同一记录保持一种写法，变更需停写/积压/数据迁移方案，不能以清库或只排空积压替代生产迁移。编辑器、生成注释与业务指引不得无条件承诺 AOF，见[确认契约](../design/v0.7-queued-ack-contract.md)。

- **V8 构造上下文**：创建 JsRuntime 前进入由调用者持有、启用 timer 的 Tokio runtime，并让 runtime 活过 isolate 销毁。当前 deno_core 的延迟前台任务需要构造时登记的 handle，缺失可在偶发 GC 时主动 abort；Host 入口应在构造前明确报错，测试/临时 Rust 验收同样遵守。当前 handle 检查不证明 timer 能力或未来寿命；不能禁用 GC、丢延迟任务、另起隐藏全局 runtime 或用全局串行掩盖。原生崩溃须保留实际 ELF/core 与失败，不以重跑通过判断修复，也不将无共同栈的历史异常认定同源。见[构造契约](../design/v0.7-v8-runtime-context.md)。

- **Host backing store 观测**：packed 字节通过原 Process 的 Arc 账本随 Box 安全转交 V8；小子视图仍保留整块存储，计数至最后 Native/V8 所有者释放，GC 尚未回收也继续计。指标不是子视图长度之和、总堆、泄漏判定或硬额度，不含显式业务复制/其他 op；不按请求完成、控制确认或入站出队提前减计数。满额策略必须另行保证完成通路进展，不能伪装已执行请求为准入拒绝。实际 V8/API、原 Process 正常/停机交付与自然 GC 分层验证，不为指标强制 GC；当前安全 API 不适用于 V8 sandbox 构建。见[backing store](../design/v0.7-host-backing-store.md)。

- **控制入站数量**：每 Process 共享 65536 项未开始 Inner RPC/Disconnect，Native 入队前准入并将守卫转交批次与实际 isolate；TS 真正开始或销毁未执行节点才单次确认，搬入忙碌 mailbox 不释放。RPC 复用 1011，断线等待留在原连接清理，Host completion/Shutdown 不占额度。聚合确认先验证再原子归还，只适用于同质数量槽；旧 Model 缺少必需确认入口应启动失败。接收器/isolate 退出唤醒等待并回收原所有者；不能丢 Disconnect、使用当前 Runtime 释放旧节点，或将数量上限称为 TS 对象/字节上限。见[控制入站](../design/v0.7-control-ingress.md)。

- **io-uring 实际所有权**：Future drop 不代表内核 I/O/FD 已释放；握手关闭守卫成功后转交 writer，错误/取消 shutdown，正常写入先排空。listener 保留 pending accept，收割连接不得丢弃它；停止在原总预算内 shutdown/消费 accept 结果并排空连接，不能遗弃成功返回的 Socket。验收要在 listener/测试 Runtime 仍存活时检查超时 Socket、恢复连接及控制通知堵塞，计数归零、条件编译或仅创建 ring 均不能代替实际后端验证。见[Linux 原生验收](../design/v0.7-linux-native-validation.md)。

- **连接编号宽度**：TCP/Auto/WebSocket、io-uring 与 KCP 在共享原子入口只分配 1..u32::MAX，不复用 Process 生命周期内旧号。最后合法号仍可传输；耗尽在握手/登记/发布前明确失败并走既有 endpoint 监督，不能取低位、回绕或放宽 Host/TS 的 uint32 桥。KCP local_conn 另有线上避碰，不能替代 Host 编号检查。有限边界注入与真实海量连接、完整 Process 故障转移分别报告，见[连接编号](../design/v0.7-connection-id-admission.md)。

- **Native 批次元数据**：每 Process 的 Scene 批次共用 65536 个保留槽，复制/分配前整批准入，直到整批调度 Future 与容器销毁才归还；部分完成不能提前减去仍保留的容器容量，取消/失败释放原所有者。满额明确拒绝新增批次，完成通道仍保持背压，不能丢旧完成或自动重放单向事实。固定指标区分保留槽、峰值、容量与拒绝批次；此上限不等于活跃 RPC、物理传输总量或 RSS，本地/停机期限与入站控制通路独立。见[批次元数据](../design/v0.7-native-scene-batches.md)。

- **内部期限句柄**：由原 isolate 专属表持有，不消耗 Deno 通用资源编号；桥接使用不复用的安全整数 Number，不能截断成 uint32、持久化或跨 isolate 传递。普通与停机的编号空间及存活额度独立；编号耗尽明确拒绝并归还本次预留，不能回绕覆盖旧句柄。关闭/OpState 清理只请求取消，原 waiter 最后引用才归还预算。分别验证真实 V8、超 uint32/最后安全整数、旧句柄、非法 Native 参数与实际 Runtime 清理，不能仅凭 live=0 推断编号可长期使用。见[句柄契约](../design/v0.7-deadline-handles.md)。

- **远程排队期限**：从 HostSceneTransport 接受已编码帧起使用 Host 共享单调毫秒，批次采样时刻与剩余时间一起跨 TS 打包、原生复制/解码、排队和传输，保留 uint32 转换与共享准入。未开始 call/send 按原绝对期限处理，不等执行槽；Host sleep 不占网络槽。过期或非法本项不能破坏其他接受项；物理传输继续持有原数据直到真正终结，不将停止等待当作撤回或业务取消。控制通道背压和 TS 忙碌仍可延迟完成通知，不宣称严格实时响应；内部时钟/sleep 不供游戏定时，桥接变化须重建重启。见[排队期限](../design/v0.7-remote-operation-deadlines.md)。

- **停机专用期限**：每 isolate 独立预留 1 项，不竞争普通本地调用期限或远程批次/回复名额；并发 stop 共用清理和结果。快速结束同步关闭，已启动原生等待真正退出后返回。创建期限异常仍执行/观察清理，必要时保留创建与钩子两项错误，该异常回退只由既有 Rust 外层 drain 期限兜底。超时不代表取消业务，onStop 发起的 RPC 仍遵循普通准入，不把停机预留用于业务。见[停机期限](../design/v0.7-shutdown-deadline.md)。

- **远程 Host 共享准入**：0.7 候选 call/send/sleep 的未提交队列共用 65536 项、含批头与元数据的 64 MiB 上限，call/send 帧遵循既有 Rust 2..1048576 字节格式。先验证再注册路由/等待者，容量拒绝保留 1011，只拒绝新增项；回复名额另计且跨提交保留。帧是借用引用，交付后不得修改，flush 检出长度变化只终结本项；不声称识别同长度内容修改。排队成本、待回复和原生包各有释放点与固定 Process 指标，send 接受不代表可靠送达或允许重放。不是全部远程在途、V8 内存或原生批次排队期限上限，见[共享准入](../design/v0.7-host-operation-admission.md)。

- **本地 Scene 准入**：0.7 候选每 EntryScene 4096、原 ProcessHost 16384 项本地 call/send，排队与真实运行一起计数；先检查存活，再检查 Scene/Process，公开 call/send 保留 1011。busy void 返回并不代表完成，名额附着实际节点；销毁只立即释放未执行工作，运行任务与旧 Runtime 回调释放原所有者。网络入站、Disconnect 和 Host completion 使用各自路径，不能占用这份本地配额来完成释放，也不能越过 ordered 顺序。嵌套 Actor 调用可同时持有两类名额，指标不能相加冒充唯一请求或堆字节，见[本地容量](../design/v0.7-local-scene-capacity.md)。

- **调用期限资源**：显式本地 RPC 先预留当前 isolate 的原生绝对期限，再启动目标；宿主刷新时仍未完成才启动原生 waiter，此前完成则同步关闭资源，已有 waiter 的调用等真实退出。延后注册失败不能撤销已开始业务。期限届满不取消 callee，不能释放实际 mailbox 名额、破坏 ordered 或提前允许热更；保留桥接前的参数/错误转换。该内部资源不供游戏定时使用；不能将准入失败不执行的包装器直接套到 stop，见[期限契约](../design/v0.7-host-deadlines.md)。

- **Actor 准入**：0.7 候选每 Actor 4096、原 ProcessHost 16384 项排队加实际运行任务，RPC/void 与 ordered/unordered 共用；先检查 Actor 再检查 Process，超限在业务执行前同步 1011。销毁只立即释放未执行队列，运行中的原任务完成后归还原所有者，不能误减新 Actor/Host。单向错误保留类型与失败指标：网络关闭仍有效的原物理来源、本地同步准入返回；异步错误携带原来源状态，不能关闭同号新连接。Trace/Actor 外壳不误报坏包，部分批次继续观察已接受项。send 返回不是最终送达或事务完成，不自动重放；固定 Process 指标区分两级拒绝，本项不界定 Scene mailbox、DTO/backing buffer 或 RSS，见[Actor 容量](../design/v0.7-actor-mailbox-capacity.md)。

- **迟到响应**：来源断开而 Scene 仍存活时，原业务 Promise 仍需真实排空，但完成后不能再排队响应或重新填入连接缓存。异步等待绑定断线状态，不能依赖 30 秒墓碑一直存在；最后释放需核对状态身份，不能删除同号新连接等待或其他来源。业务已执行与网络未回包分别判断，不自动重放事实；指标区分连接来源数与实际任务数，见[迟到响应](../design/v0.7-late-responses.md)。

- **Spawn 总量**：0.7 候选保留每 Scope 256 项，原 ProcessHost 总计最多 4096 项，超限同步 SceneOverloaded，不创建无限等待/自动重试。未开始、取消及 owner 已销毁但未真正完成的任务继续占用；同步失败回滚，成功后才更新高水位，释放绑定原 Host。固定 Process 指标中的拒绝数只包括总额度拒绝。它不是全部 mailbox、业务 Promise 或堆字节预算，见[任务容量](../design/v0.7-scene-task-capacity.md)。

- **任务准入回滚**：Spawn 同步失败不能留下尚未启动却永远在途的 record；只撤回本次接受过程，保持其他 Scope 的任务。watchdog 成功创建后才一起保存原 Timer owner/句柄并增加成功高水位，body 不执行、原异常仍抛出，同 Scope 可重试。不要吞错、关闭监控或清空全部任务，见 [任务准入](../design/v0.7-scene-task-admission.md)。

- **依赖方向**：Model/Hotfix/Stable 使用 Developer Tools dependency ruleset 1，CLI/LSP/模块 Host worker 与宿主边界命令共用。包含 import-type/import-equals 和字面量动态导入，计算目标 warning 不证明安全；当前 Program 解析别名，路径比较遵循平台身份而非直接比较字符串。Model 走 Core public，启动和生成 ABI 只保留精确例外，不忽略整目录。跨模块公共 API 须证明直接依赖。正式生成锁/指纹仍单独验证，纯 AST 不代替实际安装 LSP；详见 [依赖方向](../design/v0.7-dependency-rules.md)。

- **类型规则**：生命周期/方法名 Timer/Hotfix 成员禁令复用 Developer Tools 的 Program ruleset 2，调用者传配套 TS API、当前 Core 和生成声明。Hotfix 装饰器须有当前 Core 声明证据，同名业务函数和旧宿主不能冒充；缺环境的稳定入口候选只给未证明 warning，确定违反仍为 error。模块 Host 按声明指定 Hotfix 范围。普通 tsc 不自动接入。默认参数允许 undefined；动态名称/any 等未证明情况保留 warning。模块实时 LSP 仅在受信任工作区使用已保存声明指定的 Host worker；既有 TS 可内存覆盖，配置未保存/环境缺失/超限须显示不可用。检查复用 CLI 入口，不代替生成锁或完整构建。详见 [Program 契约](../design/v0.7-program-contracts.md)。
- **跨 worktree 身份**：TS Core、SDK 和 Native Cargo 依赖均须来自选定版本；同版本号不代表同一源码。模块 Cargo 路径显式对齐并重新生成，Native 与 Model 指纹不匹配时完整重建，不篡改哈希。无需为了读取单例暴露内部 SingletonRegistry；使用已有 Stable API。详见 [消费方迁移](../design/v0.7-map-deployment.md)。
- **部署归属**：地图实例部署属于 MMORPG 模块，复用 dataPacks 通用信封和模块自己的强类型校验，文件名为 runtime.pack.json。部署不是玩法表或任意 Scene 字典；声明包漏实例、显式新旧值冲突必须失败，修改后重建重启。简单房间可采用一个直接连接的 Scene 与 Component，无需目录服务；演示重连快照不代表生产鉴权或持久恢复。详见 [房间消费方](../design/v0.7-room-consumer.md)。
- **资源边界**：ConnectionWriter payload 与主动 Inner Host 整包共享出站预算；复制前准入，最后引用释放，writer 排队不能重置操作/写出期限。独立入站预算只接管已解码 Rust 帧，等待空位/热更延后仍持有；控制通知不占帧额度，超限 Inner RPC 明确过载、外部/单向来源关闭。两者都不等同于整个进程内存、RPC 响应、解码器、Host/V8 副本、TS mailbox 或 KCP 未确认队列上限。每项新增额度均需保留在途占用和失败释放证据，标签不带用户/连接 ID。详见 [传输契约](../reference/transport-backend.md)。
- **KCP 可靠缓存**：另有进程共享额度与每 Session 上限，C 缓存/ACK 扩容峰值在分配前预留，纯 ACK 满额度仍可回收，输出 Bytes 最后引用归还。callback 返回负值并不让 C 自动终止，包装器须返回错误并关闭对应 Session，不能丢可靠数据后只记日志。接收/UDP 封包副本与 Rust 容器等仍在范围之外；见 [KCP 预算](../design/v0.7-kcp-buffers.md)。
- **存储观测与恢复**：dbproxy_capacity 默认只读固定表的 catalog/分区字节，可选服务器时间扫描有独立期限；未知估算、缺表、RLS 和超时不能报告为零，业务时间不能作为回执 TTL。Outbox 重投允许重复投递，消费 inbox 与投影在同一事务后再 ACK；短时隔离恢复验证不等于断电、备份恢复或长稳。容量诊断不自动迁移、删除回执/事实或清理未确认事件。实际范围见 [实施进度](../design/v0.7-progress.md)。

- **Host 批次**：入站另有含头部的 64 MiB 单批上限，普通/停机路径均在复制前检查；满批先 Update，控制/数据各保留最多一条原事件，同通道 FIFO、原 ingress 守卫和公平计数保持。拆批不截断结果或伪造业务拒绝；非法单事件复制前明确失败。不要将单批界限宣称为 V8/TS 存活 backing buffer、completion 总量或 RSS 上限，真实 Process/V8 与纯编码验证分开，见 [Host 批次](../design/v0.7-host-event-batches.md)。

## 哪些放技能，哪些交给工具

| 位置 | 内容 |
| --- | --- |
| AI 技能 | 上述开发决策、不可绕过的边界，以及必须读取的文档入口 |
| AGENTS 与 AI 手册 | 版本化权威规则、故障案例、命令、接续说明 |
| Developer Tools / CLI / 测试 | 能确定检测的约束：时间等待、Model/Hotfix 边界、协议锁、构建指纹等；AI 建议不能代替机器检查 |
| 游戏包文档 | 玩法规则、具体存档键、简化限制及当次验收，不泛化为引擎规则 |

版本化技能和 Cindy 插件源码已迁入本仓库 `tools/ai-assistants/`，上层 `.agents/skills` 与 `.claude/skills` 是工作区入口，旧上层 `plugins/` 已作废，分发以同级 `TiangZ-AI-Plugins` 仓库为准。生成与换机操作见 [三端交付说明](assistant-packages.md)。发布独立插件时需重新打包并验证安装后的工具输出，不能只改源码就宣称安装包已更新。
