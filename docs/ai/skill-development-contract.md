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
8. **证据分层与失败留档**：纯规则、假存储、真实 RPC、真实数据库恢复、UI、长稳分别报告，不能互相冒充。首次失败也记录原因、正确修法、禁止绕过与复测命令，更新 project-context 与 business-development-manual。Rust 改动重建后旧二进制测试结果不能复用。故障注入/清库/长稳只在用户授权范围运行。
9. **区分框架目标、插件版本与已装依赖**：worktree/分支的 0.7 不是 Native、Developer Tools 或 AI 插件的版本号；分别核对 Core、VSIX、插件清单和宿主真正解析到的包。新 API 先确认目标 checkout 是否存在；本地候选联调与默认已发布依赖分开记录，临时 path/包覆盖不进入正式依赖锁。宿主类型身份以该项目的声明为准，同名类/装饰器不能冒充当前 Core。
10. **预算与所有权覆盖整个操作**：存储排队、读取、迁移、编码、退避和重试共用上层期限，重试保持原 ID 与同一字节载荷；支持预算的 SDK/Host 才能宣称 I/O 有界，Promise.race 不代表后台任务已取消。Timer 取消或所有者销毁不代表已触发的异步回调结束，热更需等待其真实收敛；回调中新建的到期任务按当前版本的执行轮次契约验证。句柄移除不代表 Socket/任务已经释放，限额测试检查实际资源回到基线。
11. **保持通用后端与克制拆分**：已经持有 Actor 地址就直接路由；LocationDirectory 是按需选用的逻辑所有者目录，不是地图坐标、MMORPG 必装服务或每条消息的必经查询。MapHost/AOI 等留在领域模块。按独立职责拆分大型文件，避免每个函数一份文件、只转发的抽象层及把搬移与语义修改混在一个提交；原顺序、所有权与错误行为需可核对。

## 相关能力被修改时再核对

- **类型规则**：生命周期/方法名 Timer 复用 Developer Tools 的 Program 规则，调用者传与该 Program 配套的 TS API、当前 Core 和生成声明。普通 tsc 不自动接入。默认参数允许 undefined；动态名称/any 等未证明情况保留 warning。模块实时 LSP 仅在受信任工作区使用已保存声明指定的 Host worker；既有 TS 可内存覆盖，配置未保存/环境缺失/超限须显示不可用。检查复用 CLI 入口，不代替生成锁或完整构建。详见 [Program 契约](../design/v0.7-program-contracts.md)。
- **跨 worktree 身份**：TS Core、SDK 和 Native Cargo 依赖均须来自选定版本；同版本号不代表同一源码。模块 Cargo 路径显式对齐并重新生成，Native 与 Model 指纹不匹配时完整重建，不篡改哈希。无需为了读取单例暴露内部 SingletonRegistry；使用已有 Stable API。详见 [消费方迁移](../design/v0.7-map-deployment.md)。
- **部署归属**：地图实例部署属于 MMORPG 模块，复用 dataPacks 通用信封和模块自己的强类型校验，文件名为 runtime.pack.json。部署不是玩法表或任意 Scene 字典；声明包漏实例、显式新旧值冲突必须失败，修改后重建重启。简单房间可采用一个直接连接的 Scene 与 Component，无需目录服务；演示重连快照不代表生产鉴权或持久恢复。详见 [房间消费方](../design/v0.7-room-consumer.md)。
- **资源边界**：ConnectionWriter payload 与主动 Inner Host 整包共享出站预算；复制前准入，最后引用释放，writer 排队不能重置操作/写出期限。独立入站预算只接管已解码 Rust 帧，等待空位/热更延后仍持有；控制通知不占帧额度，超限 Inner RPC 明确过载、外部/单向来源关闭。两者都不等同于整个进程内存、RPC 响应、解码器、Host/V8 副本、TS mailbox 或 KCP 未确认队列上限。每项新增额度均需保留在途占用和失败释放证据，标签不带用户/连接 ID。详见 [传输契约](../reference/transport-backend.md)。
- **KCP 可靠缓存**：另有进程共享额度与每 Session 上限，C 缓存/ACK 扩容峰值在分配前预留，纯 ACK 满额度仍可回收，输出 Bytes 最后引用归还。callback 返回负值并不让 C 自动终止，包装器须返回错误并关闭对应 Session，不能丢可靠数据后只记日志。接收/UDP 封包副本与 Rust 容器等仍在范围之外；见 [KCP 预算](../design/v0.7-kcp-buffers.md)。
- **存储观测与恢复**：dbproxy_capacity 默认只读固定表的 catalog/分区字节，可选服务器时间扫描有独立期限；未知估算、缺表、RLS 和超时不能报告为零，业务时间不能作为回执 TTL。Outbox 重投允许重复投递，消费 inbox 与投影在同一事务后再 ACK；短时隔离恢复验证不等于断电、备份恢复或长稳。容量诊断不自动迁移、删除回执/事实或清理未确认事件。实际范围见 [实施进度](../design/v0.7-progress.md)。

## 哪些放技能，哪些交给工具

| 位置 | 内容 |
| --- | --- |
| AI 技能 | 上述开发决策、不可绕过的边界，以及必须读取的文档入口 |
| AGENTS 与 AI 手册 | 版本化权威规则、故障案例、命令、接续说明 |
| Developer Tools / CLI / 测试 | 能确定检测的约束：时间等待、Model/Hotfix 边界、协议锁、构建指纹等；AI 建议不能代替机器检查 |
| 游戏包文档 | 玩法规则、具体存档键、简化限制及当次验收，不泛化为引擎规则 |

版本化技能和 Cindy 插件源码已迁入本仓库 `tools/ai-assistants/`，上层 `.agents/skills` 与 `.claude/skills` 是工作区入口，旧上层 `plugins/` 已作废，分发以同级 `TiangZ-AI-Plugins` 仓库为准。生成与换机操作见 [三端交付说明](assistant-packages.md)。发布独立插件时需重新打包并验证安装后的工具输出，不能只改源码就宣称安装包已更新。
