# v0.7.6

TiangZ 套件 0.7.6 正式版：新增崩溃诊断。**默认关闭**；不开启时不安装任何钩子、不建日志缓冲、不注册 V8 回调，行为与 0.7.5 相同。运行时行为、协议、Stable API 导出与 TypeScript 类型不变；新增配置只在宿主内使用，不投影给业务 V8。

宿主 `--version` 取自 `Cargo.toml`，现为 0.7.6。`tools/game_project.mjs`、`dev_runtime.mjs` 等启动器会核对宿主版本与 `package.json`，因此用这些入口的工程升级后需要重建宿主。

## 套件内各仓库标签

| 仓库 | 标签 | 版本 | 相对 0.7.5 套件 |
|---|---|---|---|
| TiangZ | `v0.7.6` | 0.7.6 | 崩溃诊断 |
| TiangZ-DBProxy | `v0.7.4` | 0.7.4 | 同名的崩溃诊断（服务端），协议、SDK、迁移不变，见 DBProxy 的 `RELEASE-v0.7.4.md` |
| TiangZ-Examples | `v0.7.2` | 0.7.2 | 无改动 |
| tiangz-developer-tools | `v0.16.3` | Core 0.16.3 | 无改动（`process-config.schema` 暂未同步新字段） |
| tiangz-native-language | `v0.17.2` | Core 0.17.2 | 无改动 |

TiangZ 宿主仍固定依赖 DBProxy `v0.7.3`（Rust 客户端三个包与 TypeScript SDK）：DBProxy 0.7.4 没有改客户端、协议或 SDK，所以本版不更新这条依赖，`Cargo.lock` 与 `package-lock.json` 只改本包版本号。

## 崩溃诊断

目标：Process 以及 Watcher 监管的子进程崩溃后留下可查、可分析的材料，作用类似 C/C++ 的 core dump。设计、字段、报告格式与限制见 [崩溃诊断](docs/design/crash-diagnostics.md)。

### 怎么开

- 配置 `process.diagnostics.crash`（宿主专用）：`enabled`（默认 `false`）、`directory`（默认日志目录同级的 `crash`，相对路径以工程根目录为基准）、`recentLogLines`（默认 200，0–2000）、`miniDump`（仅 Windows，默认 `false`）、`coreDump`（仅 Linux，默认 `false`）、`maxReports`（默认 50）、`maxDumps`（默认 5）。未知字段与越界取值在加载配置时拒绝启动。
- 环境变量 `TIANGZ_CRASH_DIAGNOSTICS=on|off` 覆盖 `enabled`，优先于配置；空值视为未设置，其他取值启动失败。Watcher 没有自己的 Process 配置，它自身的 panic 报告只能由这个环境变量打开。
- 打开后崩溃目录在启动阶段创建，建不出来进程不启动。

### 能拿到什么

文件名 `crash-<进程名>-<pid>-<UTC 时间>.<txt|dmp>`，报告为 `format_version: 1` 的文本。

- **Rust panic**：同步写报告（强制回溯、最近日志），再交给原钩子；退出码和 catch_unwind 行为不变。可存活的 panic 每 10 秒最多一份，被限流的最后一份在运行线程或主线程致命退出时补写为 `deferred: true`。Process 运行线程（现命名为 `process-runtime`）致命 panic 时进程以退出码 1 结束，不是 101。
- **最近日志**：报告附带最近 N 行日志，补上异步日志在硬崩溃时丢失的尾部；内存有界（≤ 2000 行，每行 ≤ 4 KiB）。
- **V8**：内存耗尽（`v8-oom`）、接近堆上限（`v8-near-heap-limit`，只记录、不扩容）、致命错误（`v8-fatal-error`）各写报告。
- **Watcher 退出记录**（`child-exit`）：子进程意外退出时写，含退出码或 NTSTATUS、信号与 core 标志的解码、是否重启，并列出同 pid 的其他报告文件。
- **Windows 未处理异常**：写文本记录（异常码、地址、访问冲突详情），`miniDump` 开时另写 `.dmp`（不含完整堆；本机 debug 实测约 1 MB）；栈溢出也能写出，进程仍以原异常码结束。
- **Linux**：`coreDump` 开时启动期放开 `RLIMIT_CORE`；core 写到哪里由宿主机 `kernel.core_pattern` 决定，Docker 需要 `--ulimit core=-1`。
- **保留上限**：按进程名限制 `.txt` 与 `.dmp` 的数量，多个 Process 共用一个目录互不挤占；Unix 上目录 0700、文件 0600。
- **自测**：`TIANGZ_CRASH_SELF_TEST=panic|thread-panic|abort|access-violation|stack-overflow|oom`，只在配置里显式写了 `process.environment` 为 `development` 或 `test` 时生效；其他环境，包括省略 `environment`，设置它会直接启动失败。不要在生产设置。

### 平台差异与限制

- **Linux 以 CI 为准**：Linux/Unix 部分本机未编译、未运行。Linux 上原生崩溃不写文本记录（不装信号处理器），core 文件加 Watcher 退出记录就是材料。
- **release 回溯没有行号**：本版没有改 `[profile.release]`，release 构建的回溯只有函数名；需要行号可设 `debug = "line-tables-only"`，会增大二进制，需另行决定。Windows 分析 `.dmp` 需要与 exe 匹配的 `.pdb`。
- **V8 OOM 在 Windows 以 `0x80000003` 结束**，不经过未处理异常过滤器；V8 自己的回调已写 `v8-oom` / `v8-fatal-error` 报告。`abort()` 与 `__fastfail` 同样捕获不到。需要这类转储时在系统层配置 WER LocalDumps 兜底（注册表 `HKLM\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\TiangZ.exe`，设置 `DumpFolder`、`DumpCount`、`DumpType`），它与本功能不冲突。
- Windows 生产服务器若允许 WER 弹窗，崩溃进程会停在对话框上，Watcher 不会重启它；部署时应关闭 WER UI。
- 被调试器附加时过滤器不被调用；`SIGKILL`、OOM killer、断电、任务管理器结束进程不产生任何材料（Watcher 退出记录仍会写）。
- `.dmp` 与 core 含进程内存，可能包括令牌、连接串和玩家数据，崩溃目录要限制访问。
- 过滤器在写入线程卡住时最多延迟 120 秒退出。

### 与 DBProxy 0.7.4 的对外约定

配置字段名、默认值与范围、文件名规则、`format_version: 1` 报告的公共头与 `panic` / `native-exception` 键顺序、`recent_logs` 段、开关取值 `on|off`、panic 限流与补写规则、MiniDump 类型、Unix 文件权限、崩溃目录建不出来时启动失败，两边保持一致。有意的差异：环境变量名（本仓库 `TIANGZ_CRASH_DIAGNOSTICS`，DBProxy 带 `DBPROXY_`）、相对目录基准与默认目录（本仓库工程根目录与日志目录同级 `crash`；DBProxy 为配置文件所在目录下的 `logs/crash`）、进程名、保留范围，以及本仓库独有的 V8 与 `child-exit` 报告。完整对照表见设计文档。

## 依赖

- 直接依赖新增 `windows-sys` 0.61.2（仅 Windows，Win32 调试、线程、文件特性）与 `libc` 0.2.189（仅 Unix）。两者原本已在依赖树中，`Cargo.lock` 只增加两条依赖边，没有新包。
- DBProxy 仍为 `v0.7.3`，rustls 等其他依赖不变。

## 验证

- 本地（Windows，debug 构建，2026-10-16，开发分支上的结果）：
  - `cargo test --locked --bin TiangZ -- crash_diagnostics:: config::tests::crash` 33 项通过；集成测试 `cargo test --locked --test crash_diagnostics -- --test-threads=1` 8 项通过，启动真实 `TiangZ.exe`，覆盖 panic、`thread-panic` 限流、环境变量开关、`oom`（`v8-oom` 等三份报告）、Windows `access-violation` 与 `.dmp`、Watcher 子进程退出记录；
  - `cargo test --locked --bin TiangZ --lib` 315 项通过，`cargo clippy --all-targets --locked -- -D warnings`、`cargo fmt --check` 通过；
  - 发布提交上：`verify:version`（含 `TIANGZ_LOCK_VERSIONS=1`）、`verify:codegen`、`verify:bilingual-comments`、`verify:no-local-traces` 与 `cargo metadata --locked` 通过。
- GitHub CI 结果以发布 PR 与 Release 页面为准，本文不重复记录。
- 未验证：Linux/Unix 部分（权限位、信号解码、core 文件）、`abort` 自测在真实进程中的结果、release 构建的回溯与 `.pdb`、MiniDump 在 release 与业务负载下的大小、业务负载下最近日志的开销、真实 Process 中运行线程 panic 补写的端到端链路（只有同函数同线程名的子进程用例与代码评审）。
- 本次未执行：外置游戏工程试同步、长稳与性能测量。
