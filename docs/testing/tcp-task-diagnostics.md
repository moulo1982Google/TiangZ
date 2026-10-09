# TCP 原生任务隔离诊断（2026-09-30）

> 2026-10-09 合入 0.7.x：GC 统计 `Cell` 修正与回归测试移植到 0.7.1 代码（`src/process.rs`、`src/process/observability.rs`）。探针移到 `src/process/transport_diagnostics.rs`，改用正式 `create_io_backend().start_endpoint()` 启动端点（不再需要测试专用监听入口），只在 Linux 编译：Windows 回环上客户端快速复用端口时 `set_nodelay` 偶发 os error 10022，属于客户端环境问题，服务端计数一致。以下是 2026-09-30 的原始记录，其中的提交、构建与 220 结果均指当时的 0.6.4 工作树。原生崩溃原因仍未查明。

## 14:05 后续修正：GC 统计引用安全

**14:49 Linux release验证完成：** build2于14:48:20退出0/Pid0/OOMKilled=false，格式、release宿主与测试构建、真实V8 GC定向1/1、常规Rust120通过/2个diagnostics ignored、release Clippy `--bin TiangZ --tests -- -D warnings`均通过。源码695文件哈希在运行后再次一致，Cargo.lock未改。新ELF SHA256 `f7b8a035d922f69fd90f8c5e3ef00245f85eac2545ac5f54efc9abb92439eb17`，保存在220独立evidence/build2；原诊断ELF `246f0ffa…`不动。日志归档`temp/gc-linux-20260930/gc-results.tgz` SHA256 `1ba3451ba6b2efe0bc4b5b198fa9bc14ce545c7d8067952f1749e78a23a1f226`已本地/远端核对；build1离线依赖缺失的失败一起保留。此次不是Linux完整npm矩阵、CI、Miri或GC修复长稳，尚未发布/提交/同步副本，原TCP状态7原因未解决。

14:30 后续授权：在220新建独立目录/容器，以Rust1.97.1和当前Cargo.lock编译GC修正版Linux release，运行真实V8回归、Rust测试和Clippy；源码只读、独立输出，旧ELF不覆盖。完成后游戏侧另跑20分钟16CPU对照，但该对照继续使用原旧ELF，只检验配额影响，不算GC修复验收。共享机器其他服务不干预，构建与负载串行。本轮无提交、发布或副本同步。

14:43 Linux执行：游戏侧已先完成PC/220同Node业务内核基线，三项220中位耗时为PC的2.17–2.48倍，有共享负载慢样本，不能换算Host容量。框架当前源码695个文件打包/哈希核对后传至220独立目录`/data/goudao-login-diagnostics/20260930-linux-gc1/`。工具准备镜像从既有Rust1.97.1镜像派生，仅补同版本Clippy/rustfmt及官方V8 150.4.0预编译库；正式构建仍network none、4CPU/8GiB、源码只读、同Cargo.lock。

首次build1退出101：Windows Cargo缓存缺少Linux `errno 0.3.14`，offline明确拒绝下载，未运行测试。保留`evidence/build1.log`、exit及inspect；先在独立180秒准备容器按锁文件补Linux目标依赖，fetch退出0且源码清单再验证一致，再用新容器build2和独立输出目录离线重跑。不升级依赖或改锁，不把准备下载记作框架回归通过。此时构建进行中，16CPU游戏对照尚未启动。

220 原生 Linux 的同冻结输入、2000人55分钟对照已结束，无原生事件或非预期RPC错误，Host跳帧4/4/10/2，故整轮仍failed/exit1；四个GDB监视器exit0/activeAtExit0、外部观察器退出，自动续接PAUSED。该结果不证明WSL或本机硬件是原故障原因；原TCP非法状态写入者仍未知。游戏工作树的Host崩溃分析文档保留完整报告与本地归档哈希。

随后发现独立的框架缺陷：`flush_runtime_batch` 将普通 `&V8GcMetrics` 保持到调用V8之后，GC回调同时经持久裸指针构造 `&mut V8GcMetrics` 并写入。Rust引用规则要求传入函数的共享引用至少在本次调用期间有效，非UnsafeCell字段不得被修改；该约束即使只有一个线程也成立。v0.6.4与本地main均含此模式。稳定Box只保证地址和生命期，不提供内部可变性；不能仅凭Box存在便断言安全，也不能将这个独立缺陷直接当成原SIGSEGV原因。

需求方恢复写权限并要求继续后，在当前框架工作树作最小修正：三个统计字段改用Cell，回调只构造共享引用，指标读取用get；Box仍先于isolate声明，在正常返回及提前失败时后于isolate销毁。保持回调注销顺序、指标名称、协议和网络行为，未修改依赖或游戏内框架副本。新增真实V8回归：保持共享引用时调用low_memory_notification，验证计数增长、计时收尾、重复GC和注销后不再写入。该用例验证回调集成，不宣称是Miri内存模型证明或原生故障复现。

验证顺序：真实GC定向测试与游戏采样纯逻辑回归，再运行Rust/Clippy和完整框架矩阵。保持失败日志、独立新二进制和原core/ELF；新构建不得覆盖冻结诊断产物。本轮不提交/合并/推送、不自动追加长负载。

验证过程（保留首次失败）：真实V8 GC定向测试1/1通过；完整矩阵中的quick 32/32通过，包含格式、Clippy、TS与Rust测试，主宿主120项通过、2个诊断探针默认ignored。首次full为4/8、exit1：开发热更与故障矩阵依赖INFO日志，但继承的`RUST_LOG=warn`过滤了完成/暂停消息；另两个Native组合构建因Windows跨盘符号链接特权不足（1314）失败。前者仅在复测命令中设`RUST_LOG=info`，两项已分别通过，未修改断言或正式日志配置。

Native构建的实际原因：Cargo清单路径在C盘，而缓存目录实际联接到D盘；生成器按realpath判断源与输出同盘，没有预建`gn_root`，V8 build.rs却按逻辑C盘清单路径判断为跨盘。仅在本工作树被忽略的`temp/module-native-target/debug/gn_root`创建指向同版本实际V8源码的目录联接，保持库版本、断言和正式工具源码不变，再复测两个Native项。可复用工具对逻辑/实际路径的处理仍是独立遗留，不借本轮扩大正式修复范围。首次full日志与四项复测各自保存在`temp/gc-metrics-20260930/`，不能抹去首次full失败。

**14:18最终验证：四个失败项独立复测均exit0。** `test:game-project-dev`覆盖同进程Hotfix/配置切换、回滚及退出；`test:hotfix-faults`三轮覆盖暂停、排空、断连与安全中止；`test:module-native-runtime`覆盖两个真实Native模块、V8及版本拒绝；`test:module-native-scaffold-runtime`覆盖实际Rust RPC和正常停机。加上首轮通过的quick、module-host、game-project、15秒hotfix-load，完整矩阵所列8个步骤均有本次成功执行记录；首轮`npm run verify`本身仍为exit1，不写成一次全绿。因只更正局部测试环境，未重跑已通过项。

游戏侧70项定向回归、完整`host-load.ts`严格类型检查及无落盘打包通过；冻结日志样本回归证明100帧对应5.001秒、19.996Hz。框架验证自动执行codegen，无新增协议/生成物漂移；GC不涉及公开API或协议变化。新Windows debug宿主SHA256为`0df31d73431d479f54a2ac47ed87cff36fb970997586e6d566b90b6b79af8f72`，与原Linux ELF分开。编译中的LNK4098警告保留，未通过链接参数屏蔽。

尚未执行：本次GC修正的Linux release回归、GitHub CI、Miri、修正后长稳；未发布、同步副本或提交。原TCP状态7写入者仍待定位，旧失败不变。后续应先整合独立修正并完成跨平台验证，再另定有界诊断的单一变量、覆盖与截止时间；不能直接续跑已结束的220轮次。

## 目的与限制

定位异步 TCP 连接任务的原生异常时，先保留原 ELF、core、源码版本、工具链和依赖锁，再使用带调试信息的构建。下述 TCP 探针仅在 `cfg(test)` 中，没有修改正式连接处理行为；后续独立的 GC 统计修正见上节，尚不能称为原生崩溃修复。

`process::transport_diagnostics::native_tcp_lifecycle_probe` 经随机回环端口调用实际 `run_scene_listener → handle_connection → handle_raw_tcp_connection`，使用真实内网握手、控制/数据队列、背压重试和输出队列。独立线程消费 `ProcessEventReceiver`，不创建 V8、Scene 或游戏模块。仍链接正式依赖和默认分配器，因此只能称为“不初始化 V8 的 TCP 路径”，不能称为完全去除了所有依赖。

探针先暂停消费，确认背压计数增加，再恢复并逐字节核对全部回包；之后反复发送小包、32KiB 包、控制 RPC，覆盖客户端正常关闭、服务端排空后关闭、非法帧长、截断包体。分段写可能被 TCP 合并，不声称每次底层 read 都发生分段。正常关闭必须 EOF；损坏输入只接受 EOF 或连接复位。每轮先成功收发才计入关闭覆盖。

所有客户端任务错误必须向上返回。结束时核对接收/发送/消费帧数、连接数、每连接恰好一次 Disconnect、writer 回收与队列深度。正式监听循环分离生成连接任务；探针没有改成另一套带任务跟踪的监听器。连接完成由这些可观察结果验证，不声称逐一 join 正式监听器内部的所有任务。

## 显式执行

测试默认 `ignored`，普通 `cargo test` 不启动它。环境参数严格限制：

| 参数 | 默认 | 合法范围 |
| --- | --- | --- |
| `TIANGZ_TCP_DIAGNOSTIC_SECONDS` | 5 秒 | 1–60 秒 |
| `TIANGZ_TCP_DIAGNOSTIC_CONNECTIONS` | 8 | 1–16 |

持续收发计时不含最初背压验证及清理；测试另有 `seconds + 15` 秒上限，单轮连接 5 秒上限。运行器还应设进程级上限，避免原生崩溃或运行时卡死绕过异步计时器。Linux 示例（本仓库默认 Rust 工具链，依赖锁不变）：

```sh
cargo build --offline --locked --release --bin TiangZ --config 'profile.release.package.TiangZ.debug=2'
cargo test --offline --locked --release --bin TiangZ --no-run --config 'profile.release.package.TiangZ.debug=2'
timeout 45s cargo test --offline --locked --release --bin TiangZ \
  --config 'profile.release.package.TiangZ.debug=2' \
  process::transport_diagnostics::native_tcp_lifecycle_probe -- --exact --ignored --nocapture
```

首次编译应独立完成，不能将编译时间计入 45 秒执行限额。调试覆盖只作用于 TiangZ 包，保留 release 优化和默认分配器；依赖沿用 release 构建。新的 ELF 必须另存并计算哈希，不能拿它替代原 ELF 解读旧 core。测试输出 `TCP_DIAGNOSTIC` JSON 仍须结合测试最终结果、进程退出码、容器 OOM 和清理结果判断。

## 证据和后续

容器使用独立输出/缓存、只读源码、禁用外网、不发布端口并设置 CPU/内存限制；原构建卷只读。源码或参数变化后单列新记录，保留失败输出。用于测试 fixture 的人工信号必须明确标注，不能计为自发复现。

短测通过只表示这组条件下未复现。若怀疑异步状态被破坏，调试器按**当前 ELF**重新确认状态字段与生命周期，禁止把旧构建偏移写死成正式 `unsafe` 自检，也不能捕获 SIGSEGV 后继续运行业务。进一步长时复现需先固定截止时间；分配器、工具链或内存检查对照每次只改变一个因素。只有取得具体缺陷证据后才设计最小修复及完整运行时回归。

## 生命周期自动监视（9 月 30 日后续）

**watch1 最新结果：因 WSL 内核 panic 中断，未通过，自动续接已暂停。** 北京时间 11:13:54 的系统报告包含 `Kernel panic - not syncing: Fatal exception in interrupt`、内核 RIP=0 和 TCP/write 栈片段；Docker backend 同时断开并停止 WSL engine，容器 11:14:06 记录 exit 255、Pid 0。未捕获原非法状态写入，不能把这次系统故障直接认定为 night1 同源。下面的启动及巡检段落保留为历史过程。

需求方已授权持续推进，并认可先做一次最多 1 小时的真实 Host 隔离复现。新增 `tools/diagnostics/watch_tcp_state.py`，只在 GDB 外围读取 inferior：按当前 ELF DWARF 求连接 future 和状态位置，每个 Host 最多四个硬件写监视点；正常返回/异常结束时撤销，取消路径在内层 future 的 drop glue 首指令撤销，再允许析构继续。Linux x86-64 参数寄存器假设显式检查，不支持的构建必须报错。地址不能从原始 core 硬编码，也不能把软件监视退化当作硬件覆盖。

满额时暂停新连接采样；报告保留附加、完成、取消、最大同时监视数及未覆盖策略。仅在正常退出前没有活动监视点时判定清理完成。有限监视覆盖不代表检查了进程里的每个连接。非法状态或原生致命信号时保存栈、寄存器、映射和可用转储，然后终止；不会从 SIGSEGV 恢复继续游戏。

复现沿用原 night1/diag1 的游戏配置、Model/Hotfix/manifest 哈希和 0.6.4 运行时源码；只换成独立的同优化级别调试 ELF，不更新依赖或正式网络行为。实际负载启动前固定绝对截止时间，诊断结果不能用作正式容量验收。

预检证据：`temp/tcp-diagnostics-20260930/watch-probe*`。probe1 因 PIE 地址在启动前尚未重定位而无法插入绝对析构断点，退出 1；修正为 starti 后求地址，probe2 成功观察 93 个连接、186 次状态写入，93 个正常回收、退出时活动数 0。游戏 watch-quick1 在尚无入站连接的 ready 阶段要求“已监视连接”而误判夹具失败；改为先建立四个有界空闲 TCP 探针，再验证监视覆盖。watch-quick2 的 32 人/60 秒真实 4 Gate/4 Host 预检通过，四个 Host 各 6 个监视连接均完成回收；cgroup oom/oom_kill 均为 0。原失败记录保留，不改成通过。

新增默认 ignored 的 `native_tcp_cancelled_connection_probe`：先用真实连接确认一帧回包，保持对端打开再 drop Runtime，独立验证取消清理。`watch-cancel1` 已通过：attached=1、completed=0、dropped=1、activeAtExit=0，退出 0；监视点在内层 future 的析构首指令撤销。新的测试专用 ELF 为 `TiangZ.cancel-probe`，SHA-256 `f72350f3c458b0b7d8eb74216345aaad957dda4389ff2e8ca22758034f66582b`，不代替原 core/ELF 或正式运行时。普通 Rust 回归再次 119 项通过、2 个诊断测试默认 ignored，release bin/tests Clippy `-D warnings` 通过。首次构建被格式检查拦截，第二次因遗漏原构建使用的 `RUSTY_V8_ARCHIVE` 及只读缓存挂载，离线容器试图下载 V8 而失败；未开启网络或更换 V8 版本，恢复原构建参数后成功，全部失败日志保留。

真实 Host 轮次 `goudao-login-soak-20260930-watch1` 已于北京时间 10:47:54 启动，使用原冻结游戏产物与独立调试运行时 `246f0ffa27d3cd64cba3be2d560297323853eca851e0652958f4922d7b266340`。2000 人在 3.236 秒加入，4 Gate/4 Host；负载截止 **11:43:12.759**，外围控制截止 **11:47:51**，另有 55 秒最终收尾兜底。无网络/发布端口，8 CPU/8GiB。10:52 时无异常状态写入和 OOM 计数，每 Host 四条活动监视、五条现有连接，有限覆盖不能排除未监视连接上的故障。本轮仍运行中，不能提前判断通过；正式网络逻辑未改，未做完整框架矩阵、CI、发布或游戏副本同步。

外部事件采集还遇到 PowerShell 将 JSON 时间自动转成 DateTime、拼接本地化参数后导致 Docker 拒绝命令的问题。第一版错误输出保留；修正为明确 ISO 字符串并从容器创建前回放事件，核验新进程完整参数与 stderr。事件文件为空本身不能证明没有 OOM，必须先确认采集器成功启动并结合 cgroup 计数。

10:59 续检仍在运行：四个 Host 均 watching，attached=6、completed=2、dropped=0、active=4，哈希一致；23 个负载样本连续，固定更新跳过计数无新增，cgroup OOM 计数 0。未捕获非法写入，也没有新重启；保留四点覆盖限制，不改变截止或正式源码。

11:09 续检：42 个负载样本连续、2520 个累计登录循环且非预期错误为 0；监视覆盖和状态不变，没有非法写入、重启或 OOM 证据，固定更新跳过计数无新增。当前仍为有界诊断过程，原失败未修复。

11:18 发现本轮提前结束，实际可见负载约 25 分 40 秒，保留 52 个资源样本、312 个内存样本、3060 个累计登录循环；截至最后采样无跳帧增量、无已报告 RPC 错误、cgroup OOM 计数为 0。最终稳定负载报告和监视器回收证明缺失，原 status/watch JSON 保持中断前状态；不能按旧 running 或零错误检查点宣称通过。Docker/WSL 整体故障时，容器内 finally 与宿主 Docker events 都可能中断，需要外部观察者结合系统日志另写明确来源的失败报告。

原内核报告 SHA-256 `01272c932cf9c32063ca00ad85ff5b662194d750ea87c8fefe8dd715b951eb3c`，其 DR0–DR3 与本轮 Host-1 监视地址一致；这是关联证据，不能证明监视点引发 panic。文件从栈中部开始，缺初始异常头；当前 WSL 2.7.14.0 / kernel 6.18.33.2，未更新或重置。游戏工作树 `dist/login-soak/20260930-watch1/host-closeout-20260930T0319/` 保留内核/引擎日志、Docker 状态、版本、23 个文件哈希及 `observed-result.json`，结果为 `failed-external-interruption`。已确认容器 Pid 0、事件采集器 PID 6348 退出，没有新开测试、提交或发布。下一步先离线核对内核/调试环境，不在当前 WSL 自动重复长负载；原用户态状态损坏原因仍未查明。

## 本轮结果

2026-09-30 在 Linux 隔离容器中使用 rustc 1.97.1、相同 Cargo.lock 和默认 mimalloc，完成以下验证：

| 检查 | 实际结果 |
| --- | --- |
| 普通 5 秒、8 并发探针 | 7,751 个连接、25,318 帧；读/写/消费均 25,318，Disconnect 7,751；触发背压 1 次；退出时入口深度 0、writer 清空 |
| 现有 Rust 测试 | 119 通过，诊断探针默认 ignored；无失败 |
| Clippy | release、bin/tests、`-D warnings` 通过 |
| 格式、双语注释、diff | 通过 |
| 调试信息 | 运行时 ELF 和探针 ELF 均包含 `.debug_info` / `.debug_line`，各自留存 SHA-256 |
| GDB 结构定位 | 从当前运行时 ELF 的 DWARF 独立解析出外层状态及内层连接状态，合法内层枚举值为 0–5 |
| 硬件监视点 | 在真实连接中捕获外层 0→3、内层 5→1；完成后立即撤销监视点，避免把内存重用当成状态损坏 |
| 人工信号捕获 | 在独立探针进程注入 SIGSEGV，验证 GDB 停住并保存线程栈/寄存器，随后结束该进程。明确标记 injected；没有生成额外 core，不算自发复现或完整探针通过 |

证据在本工作树 `temp/tcp-diagnostics-20260930/`，不随 Git 保存；交接/清理前须保全。四次 GDB 调整分别用于源码定位、Stage 取址、首次挂起、完成写入捕获；不是四轮容量验收。release 优化下部分局部变量无法求值，不能将 GDB 的 `<optimized out>` 或变量地址求值失败解释为新的内存损坏。

运行时 ELF SHA-256：`246f0ffa27d3cd64cba3be2d560297323853eca851e0652958f4922d7b266340`；探针 ELF：`3f5d39e9351b5f86ba6dce5577935241bc2d403a702160c487f433668094957e`。`runtime-state-map.json` 与运行时哈希绑定，包含从 DWARF 算出的字段位置，不得跨构建套用。

本轮容器均已退出、PID 0、OOM false。**尚未自发复现原生异常，也未找到异常写入者。** 下一步需将监视点接入有明确时限的实际宿主复现，处理连接取消/完成后的撤销和硬件监视点数量限制，再捕获首次非法写入。未恢复原游戏长稳、未执行完整框架验证矩阵或 CI、未提交/发布/同步业务副本。
