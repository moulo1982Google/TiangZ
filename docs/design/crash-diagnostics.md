# 崩溃诊断 / Crash diagnostics

2026-10-16 新增，未发布。目标是让 Process（以及 Watcher 监管的子进程）崩溃后留下可查、可分析的材料，作用类似 C/C++ 的 core dump。**默认关闭**：不改配置、不设环境变量时，不安装任何钩子、不创建日志环形缓冲、不注册 V8 回调，行为与 0.7.5 相同。

DBProxy 在另一个仓库实现同一套能力（`TiangZ-DBProxy/docs/crash-diagnostics.md`），两边代码各自独立，配置字段、文件命名、报告格式、环境变量取值按下文“与 DBProxy 的对外约定”保持一致。

## 目标与不做什么

- 做：Rust panic 报告（含强制回溯与最近日志）；V8 内存耗尽、接近堆上限、V8 致命错误报告；Windows 未处理异常的文本记录与可选 MiniDump；Linux 启动期放开 core 文件大小上限；Watcher 记录子进程意外退出；崩溃目录按上限清理；默认不可用的自测入口。
- 不做：不改 `[profile.release]` 的调试信息设置（见“限制”）；不安装 Linux 信号处理器；不扩大 V8 堆；不改变 panic、catch_unwind 和进程退出码的原有语义；不上传、不聚合崩溃材料。

## 配置

`process.diagnostics.crash`（宿主专用，`skip_serializing`，不投影给业务 V8 的 `ProcessConfig`）：

```json
{
  "process": {
    "name": "map1",
    "diagnostics": {
      "crash": {
        "enabled": true,
        "directory": "crash",
        "recentLogLines": 200,
        "miniDump": false,
        "coreDump": false,
        "maxReports": 50,
        "maxDumps": 5
      }
    }
  }
}
```

| 字段 | 默认 | 取值 | 作用 |
|---|---|---|---|
| `enabled` | `false` | 布尔 | 总开关。 |
| `directory` | 日志目录同级的 `crash` | 非空，前后不能有空白（与 DBProxy 一致） | 报告与转储目录。启用时启动阶段创建，**建不出来进程不启动**（与 DBProxy 一致）。相对路径以**工程根目录**为基准，与 `logging.file.directory` 的规则相同。省略时取日志目录（`logging.file.directory`，未配置文件日志时按默认 `logs`）的父目录下的 `crash`，例如 `logs` → `<根>/crash`、`var/log/game` → `<根>/var/log/crash`。 |
| `recentLogLines` | 200 | 0–2000 | 报告附带的最近日志行数；0 表示不建缓冲，但仍写报告。 |
| `miniDump` | `false` | 布尔 | 仅 Windows：未处理异常时写 `.dmp`。其他平台忽略并记一条 info。 |
| `coreDump` | `false` | 布尔 | 仅 Linux/Unix：启动时放开 `RLIMIT_CORE`。Windows 忽略并记一条 info。 |
| `maxReports` | 50 | 1–10000 | 每个进程名最多保留的 `.txt`（panic、原生异常、V8、子进程退出记录都算）。 |
| `maxDumps` | 5 | 1–1000 | 每个进程名最多保留的 `.dmp`；目录中的 core 文件另按目录整体受同一上限约束。 |

未知字段、越界取值和空目录在加载配置时拒绝启动，与其他配置项一致；即使 `enabled=false` 也校验，避免应急打开时才发现配置错误。

### 环境变量与优先级

- `TIANGZ_CRASH_DIAGNOSTICS=on|off`：覆盖配置中的 `enabled`，不区分大小写、忽略首尾空白；未设置或为空时以配置为准；**其他取值启动失败**（与 DBProxy 一致）。
- 优先级：环境变量 > `process.diagnostics.crash.enabled` > 默认关闭。其余字段只能在配置文件里设置；用环境变量打开时，其余字段取配置值，没写就取默认值。
- 启动日志 `crash diagnostics enabled` 的 `enabled_by` 字段为 `Config` 或 `Environment`，另有与 DBProxy 同名的布尔字段 `environment_override`（由环境变量打开时为 true）。
- Watcher 没有自己的 Process 配置：它自身的 panic 报告只能由环境变量 `on` 打开（进程名 `watcher`，目录 `<根>/crash`）。Watcher 为子进程写退出记录时，按子进程配置加同一环境变量判断（子进程继承 Watcher 的环境）。

## 会产生什么

所有文件都在崩溃目录下，文件名 `crash-<进程名>-<pid>-<UTC>.<txt|dmp>`，时间形如 `20261016T031500.123Z`。进程名中的 `<>:"/\|?*` 替换为 `_`（与日志文件相同）。同名已存在时依次加 `-2` … `-16` 后缀，不覆盖。

| 情况 | Windows | Linux |
|---|---|---|
| Rust panic（任意线程） | `.txt`（kind `panic`） | 同左 |
| V8 堆接近上限（每个 Isolate 一次） | `.txt`（kind `v8-near-heap-limit`） | 同左 |
| V8 内存耗尽 | `.txt`（kind `v8-oom`），随后通常还有 `v8-fatal-error` | 同左 |
| V8 CHECK 失败等致命错误 | `.txt`（kind `v8-fatal-error`） | 同左 |
| 访问违规、栈溢出等未处理异常（Rust 代码，或 JS 调用的 op 中、栈上有 JS 帧时均已实测可达） | `.txt`（kind `native-exception`）；`miniDump` 开时另有同主干的 `.dmp` | `coreDump` 开时由内核按 `core_pattern` 写 core；不写文本记录 |
| `abort()`、`__fastfail`、V8 OOM/致命错误之后的终止（Windows 实测以 `0x80000003` 结束，未经过过滤器） | 过滤器捕获不到；有 V8 报告时以报告为准，否则只有 Watcher 退出记录；兜底用 WER LocalDumps（见“部署建议”） | `coreDump` 开时写 core |
| 子进程意外退出（Watcher 监管） | `.txt`（kind `child-exit`），由 Watcher 写 | 同左 |

### panic 报告

panic 钩子先同步写报告，再调用原钩子：stderr 照常打印 `thread '…' panicked at …`，主线程 panic 仍以退出码 101 结束，tokio 任务、Native worker、KCP 回调、HTTP 监听等处的 catch_unwind 照常兜住。写报告失败只往 stderr 打一行。**钩子路径必须无 panic**：Rust 1.97.1 的 std 在钩子执行期间再发生任何 panic 都会直接 abort，不会再次进入钩子；实现里所有 I/O 错误都被吞掉，锁只用 try_lock。线程本地标志只用于线程本地存储已销毁等无法判断的情形，此时跳过报告。

钩子在栈展开之前运行，**无法判断该 panic 之后是否会被 catch_unwind 拦截**，因此被兜住的 panic 也会写报告；若报告之后进程仍在运行，说明已被拦截。

**限流与补写**：被兜住的 panic 可能高频发生，而每份报告都要同步符号化回溯、写盘、fsync。因此 panic 报告每 10 秒最多 1 份（常量 `PANIC_REPORT_INTERVAL`，不可配置）；间隔内的 panic 不写报告，往 stderr 打一行 `crash report suppressed by the rate limit` 并计数，下一份报告在 `location` 之后写 `suppressed_since_last: N`。

限流只门控“符号化 + 写盘 + fsync”：每次 panic 钩子都会廉价采集 message、location、线程名和**未符号化**的回溯（`Backtrace::force_capture` 只遍历栈帧），被限流时把它存进一个只保留最后一份的槽（钩子里只 try_lock，拿不到就放弃，内存有界）。在致命退出路径把槽里的那份补写成报告，kind 仍为 `panic`，`suppressed_since_last` 之后多两行 `deferred: true` 与 `deferred_reason`：

- **Process 运行线程 panic**：TiangZ Process 的业务 V8、Scene 更新、deno op、KCP 回调都在 `process.rs` 起的运行线程上（现命名为 `process-runtime`，只为报告与日志可读，不改调度语义；改用 `thread::Builder` 后，线程创建失败从 panic（退出码 101）变为返回错误（退出码 1）），它 panic 后主线程 join 到错误、以 anyhow 错误退出，**退出码是 1，不是 101**。主线程拿到 join 结果后、任何错误出口之前（包括停机期间监管错误的提前返回）调用 `report_deferred_panic` 补写。
- 缓存分两格：运行线程一格、其他线程一格，各只保留最后一份。运行线程的那份不会被其他线程（tokio、KCP、Native worker）的 panic 覆盖，也不会因为其他线程的报告被放行而清除；运行线程致命退出路径只补写运行线程那一格，避免把别的线程的 panic 标成运行线程。
- **主线程 panic** 与 std 的不能展开的 panic（消息以 `panic in a function that cannot unwind`、`panic in a destructor during cleanup` 开头，之后必然 abort）：钩子先补写两格里的缓存（运行线程在前），再无条件写本份报告，不受限流。

所以“10 秒内先有一次被兜住的 panic、随后运行线程致命 panic”时，致命那份也有报告（已有子进程用例覆盖）。报告被放行时，先清本线程所属那一格再符号化、写盘：槽里那份一定早于本份报告、已计入 `suppressed_since_last`，而写盘期间新进槽的被限流 panic 会保留给致命路径补写（与 DBProxy 相同）。剩余缺口：在不能展开的 V8 回调里 panic 时，若 std 的消息不在上述前缀内，仍可能只有前一份报告与 stderr。DBProxy 同样有主线程与不能展开 panic 的补写；TiangZ 多出运行线程一格及其补写入口。限流只管 panic 报告；Windows 原生异常本来就只处理一次。

### 最近日志

启用且 `recentLogLines > 0` 时，在 tracing subscriber 上增加一个 `RecentLogLayer`：每条**通过过滤**的事件格式化为一行 `UTC时间 级别 target: 消息 字段=值`，存入固定容量的环形缓冲，崩溃时写进报告。这解决的是 `tracing_appender::non_blocking` 异步写日志时，硬崩溃前最后几行还在队列里没落盘的问题。

- 选择单独 Layer 而不是像 DBProxy 那样包一层“复制写入器”：TiangZ 的日志有 `pretty`/`json` 两种格式、控制台与文件两路非阻塞写入器，复制写入器需要对每一路分别包装且会把 JSON 原样复制；Layer 只在一处接入，并独立于格式与输出目标。
- 内存有界：最多 2000 行，每行最多保留 4096 字节（超出按字符边界截断并标 ` …[truncated]`），最坏约 8 MiB。
- 热路径开销：格式化在线程本地缓冲中完成，锁只覆盖一次入队，满时复用最旧一行的分配，不额外分配。关闭时不创建缓冲、不挂 Layer（`Option<Layer>` 为 `None`），日志路径与以前相同。
- 崩溃路径最多等待约 100 ms 拿锁（与 DBProxy 一致），拿不到就写 `recent_logs: unavailable (buffer busy at crash time)`。

### V8

在 Process 的主 V8 Isolate 创建后（`process.rs`，紧接 GC 回调注册）调用 `register_isolate`，启用时注册下列回调。只注册在主 Isolate 上：启动预检与热更预检（`hotfix-preflight` 线程）另建的临时 Isolate 不注册 OOM 与接近堆上限回调，它们内存耗尽时按 V8 默认行为打印并中止；但进程级的致命错误回调对它们同样生效，会写 `v8-fatal-error` 报告。

- `Isolate::set_oom_error_handler`：写 `v8-oom` 报告（位置、`oom_type: heap|process`、详情、最近一次堆统计），往 stderr 打一行，然后返回（字符串复制也在 catch_unwind 内，防止其中的 Rust panic 越过 V8 回调；Rust 分配失败走 `handle_alloc_error` 直接 abort，不会被 catch_unwind 拦住）；V8 随后按原逻辑终止进程。注册了 OOM 回调后 V8 不再打印它自己的 `Fatal JavaScript out of memory` 一行，所以本回调代为打印。
- `Isolate::add_near_heap_limit_callback`：每个 Isolate 只写一次 `v8-near-heap-limit` 报告（当前与初始上限、当场读取的堆统计），**返回当前上限，不扩容**。
- `V8::set_fatal_error_handler`（进程级，只注册一次）：写 `v8-fatal-error` 报告后返回，V8 随后中止进程。
- OOM 回调拿不到 Isolate，报告里的堆统计来自最近一次采样：接近堆上限回调当场采样，或周期性的 `[process-metrics]` 采样（启用时把同一份统计存入原子变量，关闭时立即返回）。

核实结果（deno_core 0.412 / v8 150.4.0）：上述三个 API 均可用，签名分别为 `unsafe extern "C" fn(*const c_char, &OomDetails)`、`unsafe extern "C" fn(*mut c_void, usize, usize) -> usize`、`Fn(&str, i32, &str)`。v8 crate 没有暴露 Isolate 级的 `SetFatalErrorHandler`（API 误用类错误），未实现。

### Windows 原生异常与 MiniDump

启用时安装 `SetUnhandledExceptionFilter`（JS 调用的 op 里写非法地址、栈上有 JS 与 V8 帧时同样能到达过滤器，已实测）。过滤器只做原子写入、`SetEvent` 与有界等待（最多 120 秒；超时时往 stderr 打一行 `crash dump timed out`，此时转储和文本记录可能缺失或不完整），不分配、不拿锁；文本记录与转储由启动时预先创建的 `tiangz-crash-writer` 线程完成，所以栈溢出这类崩溃线程剩余栈很小的情况也能写出来（已实测，见“验证”）。写完后交给安装前的过滤器或系统默认处理，进程照常以原异常码结束（例如 `0xC0000005`），WER 照常工作。只处理第一次未处理异常。

选择未处理异常过滤器而不是向量化异常处理器：后者在“第一次机会”就被调用，会把之后会被正常处理的异常（如 C++ 异常）误当崩溃。

`miniDump` 开时用 `MiniDumpWriteDump` 写 `.dmp`，类型与 DBProxy 相同：Normal + ThreadInfo + IndirectlyReferencedMemory + UnloadedModules + HandleData，包含所有线程的栈、栈上指针间接引用的内存、句柄与模块列表，**不含完整堆**。本机实测（debug 宿主、已创建 V8）约 1.0 MB；release 与业务负载下会随线程数和栈深变化，量级为数 MB。分析时用 WinDbg 或 Visual Studio 打开，需要同一版本的 `TiangZ.exe` 与 `.pdb`。`.txt` 与 `.dmp` 使用同一文件名主干，`.txt` 的 `minidump:` 字段写 `.dmp` 文件名；`miniDump` 关时写 `not requested (diagnostics.crash.miniDump = false)`。

自测和测试会以 `SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX)` 启动子进程，避免 WER 弹窗把测试卡住。**生产服务器若允许 WER 弹窗，崩溃进程会停在对话框上不退出，Watcher 也就不会重启它**；这是 Windows 的原有行为，本功能不改变，部署时应关闭 WER UI（组策略或 `DontShowUI`）。

**部署建议（Windows）**：过滤器覆盖不到 `abort()`/快速失败、V8 OOM/致命错误之后的终止和调试器附加的情况，需要这类转储时在系统层配置 WER LocalDumps（注册表 `HKLM\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\TiangZ.exe`，设置 `DumpFolder`、`DumpCount`、`DumpType`）作兜底；它与本功能互不冲突，转储数量由 `DumpCount` 限制。

### Linux core dump

`coreDump` 开时启动阶段先尝试 `setrlimit(RLIMIT_CORE, 无限/无限)`；没有权限时退一步把软上限提到硬上限。启动日志记录结果与读到的 `/proc/sys/kernel/core_pattern`。

**core 写到哪里不由 TiangZ 决定**，而由宿主机内核参数 `kernel.core_pattern` 决定，它在容器里只读、所有容器共用：

- `core_pattern` 是管道（如 `|/usr/lib/systemd/systemd-coredump …`）时，core 交给宿主机收集程序，用 `coredumpctl list`、`coredumpctl gdb <pid>` 查看。
- `core_pattern` 是路径时，容器里必须存在且可写该目录，通常要挂载出来；若该路径就是崩溃目录，名为 `core`、`core.*`、`core-*` 的文件按 `maxDumps` 整体清理（无法归属进程名）。
- Docker 需要 `--ulimit core=-1`（Compose：`ulimits: { core: -1 }`），否则容器硬上限可能为 0；systemd 服务需要 `LimitCORE=infinity`。

Linux 上原生崩溃不写文本记录：信号处理函数中能安全做的事太少，且 V8 也会安装信号处理器，链接两者风险高；core 文件本身就是记录。退出原因由 Watcher 退出记录给出（信号名与是否 core dumped）。

### Watcher 退出记录

子进程配置启用了崩溃诊断时，Watcher 在其崩溃目录写 `kind: child-exit` 报告（文件名用**子进程**的进程名与 pid，计入子进程的 `maxReports`），触发点：

- 运行中意外退出（含退出码 0）：`restart` 写 `scheduled (<策略>, in <毫秒>ms)`、`no (restart not configured; group stops)` 或 `no (restart budget exhausted; group stops)`；
- 停机阶段以非 0 状态退出：`no (exited during shutdown)`。停机超时被 Watcher 强制结束的不写。

退出状态解码 `exit_decoded`：Windows 不小于 `0x80000000` 的值按 NTSTATUS 十六进制并识别常见值（`0xC0000005` 访问违规、`0xC00000FD` 栈溢出、`0xC0000409` 快速失败、`0xC0000374` 堆损坏、`0x80000003` 断点——Windows 上 V8 OOM/致命错误实测以它结束等）；Unix 解码信号名（按 Linux 编号）与是否 core dumped。退出码 101 标注为“主线程 panic”；**退出码 1 标注为“进程返回错误，TiangZ Process 多为运行线程 panic 或启动、运行错误，见 related_files”**——真实 Process 的致命 panic 多发生在运行线程，以 1 退出，对应的 panic 报告（含补写的 `deferred: true`）列在 `related_files` 里。Watcher 在重启子进程时会按磁盘上的配置重新解析其崩溃诊断设置，读不到时沿用旧设置。`related_files` 列出崩溃目录中同进程名、同 pid 的其他文件（文件名必须是 `crash-<进程名>-<pid>-<8 位日期>T…`，`map` 与 `map-1` 不会互相认领）。

### 保留上限

按修改时间删除最旧的，使**每个进程名**的 `.txt` 不超过 `maxReports`、`.dmp` 不超过 `maxDumps`；目录中的 core 文件整体不超过 `maxDumps`。多个 Process（Gate、Host、Login 等）共用目录时互不挤占，一个进程不会删掉另一个进程的报告；其他文件一律不动。

清理时机：安装时扫描一次并记下现有数量；之后进程内维护估计值，写入后只有估计超过上限时才扫描目录，避免每次写入都整目录扫描。Watcher 写退出记录时每次扫描（频率低）。并发删除同一文件的失败被忽略。

### 文件权限

Unix 上新建的崩溃目录权限 `0o700`、报告与转储文件 `0o600`（已存在的目录不改权限）；Windows 继承父目录 ACL。`.dmp` 与 core 含进程内存，**可能包含认证令牌、DBProxy 令牌、连接串和玩家数据**，崩溃目录要限制访问，转交分析前按敏感数据处理。文本报告只含日志本来就有的内容与回溯。

## 报告格式（format_version 1）

开头一行 `TiangZ crash report`，随后每行 `键: 值`，值中有换行时续行以两个空格开头：

1. 公共头：`format_version`、`process`、`version`（Cargo 版本号，如 `0.7.5`）、`pid`、`platform`（`<os>-<arch>`）、`time_utc`（ISO 8601、毫秒、`Z`）、`kind`。
2. 按 kind：
   - `panic`：`thread`、`message`、`location`、`suppressed_since_last`（上一份报告之后被限流跳过的个数），补写时再接 `deferred: true` 与 `deferred_reason`（TiangZ 新增），空行，`backtrace:` 与回溯正文。
   - `native-exception`：`thread_id`、`exception_code`（`0x%08X` 加可选名称，名称表与 DBProxy 相同）、`exception_address`、可选 `access_violation`（`read|write|execute|unknown access at 0x…`）、`minidump`。
   - `v8-oom`（TiangZ 新增）：`location`、`oom_type`、`detail`、堆统计键。
   - `v8-near-heap-limit`（TiangZ 新增）：`current_heap_limit`、`initial_heap_limit`、堆统计键。
   - `v8-fatal-error`（TiangZ 新增）：`location`、`message`、堆统计键。
   - 堆统计键：`heap_sampled_utc`（或 `none`），之后 `used_heap_size`、`total_heap_size`、`heap_size_limit`、`external_memory`、`malloced_memory`（字节）。
   - `child-exit`（TiangZ 新增，头部 `pid`、`time_utc` 指子进程及其退出时间）：`reporter`（Watcher pid）、`started_utc`、`exited_utc`、`uptime_ms`、`exit_status`、`exit_decoded`、`restart`、`related_files`（多个文件用续行）。
3. 末尾空行加 `recent_logs: <行数> of <容量>` 与日志行，或 `recent_logs: disabled (recentLogLines = 0)`、`recent_logs: unavailable (…)`。`child-exit` 固定为 `unavailable`（子进程的最近日志在它自己的报告里）。

## 自测（只用于验证）

设置 `TIANGZ_CRASH_SELF_TEST` 且崩溃诊断已启用时，Process 在日志与崩溃诊断安装完成后（读取 dist、创建业务 V8 之前）**主动崩溃**：

| 取值 | 行为 | 预期 |
|---|---|---|
| `panic` | 主线程 panic | `panic` 报告，退出码 101 |
| `thread-panic` | 3 个后台线程依次 panic，被 join 吸收 | 只写 1 份 `panic` 报告（`suppressed_since_last: 0`），另 2 次被限流并各打一行 stderr；进程继续启动 |
| `abort` | `std::process::abort()` | Windows：只有 Watcher 退出记录（`0xC0000409`）；Linux：SIGABRT，`coreDump` 开时有 core |
| `access-violation` | 先创建一个已注册回调的 V8，再写地址 `0x10` | Windows：`native-exception` 记录，`miniDump` 开时有 `.dmp`，退出码 `0xC0000005`；Linux：SIGSEGV |
| `stack-overflow` | 256 KiB 栈的线程无限递归 | Windows：`native-exception`（`0xC00000FD`）与可选 `.dmp`；Linux：Rust 打印栈溢出后 SIGSEGV |
| `oom` | 独立 V8（堆上限 32 MiB）无限分配 | `v8-near-heap-limit`、`v8-oom`、`v8-fatal-error` 三份报告 |

- 诊断关闭时设置该变量只记一条 warn，不崩溃，进程照常启动。
- 取值不在上表时启动失败。
- **只在配置文件显式写了 `process.environment` 且值为 `development` 或 `test` 时生效**；其他环境（`staging`、`production`）或**省略** `environment`（缺省值虽为 development，但生产漏写时不能因此失去保护）时设置了该变量，直接报错退出。原因：生产残留的自测变量会让每次启动都崩溃，Watcher 自动重启会变成崩溃循环；报错退出至少不会写满崩溃目录，且错误信息直接指出变量名。宿主在加载配置时记录 `environment` 是否显式给出（`ProcessConfig.environment_declared`，宿主内部字段，不投影给 TS）。
- **不要在生产或连着真实数据的实例上设置它。**

## 平台差异汇总

| 能力 | Windows | Linux |
|---|---|---|
| panic 报告、最近日志、V8 回调、退出记录、保留上限 | 支持 | 支持（本机未运行，见“验证”） |
| 原生崩溃文本记录 | 支持（未处理异常过滤器 + 写入线程） | 不支持（不装信号处理器） |
| 转储 | MiniDump（`miniDump`） | core（`coreDump` + 宿主机 `core_pattern`） |
| abort / 快速失败 | 捕获不到；可用 WER LocalDumps（注册表 `HKLM\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\TiangZ.exe`） | 有 core |
| 文件权限 | 继承父目录 ACL | 目录 0o700、文件 0o600 |

## 与 DBProxy 的对外约定及差异

一致（以 DBProxy `docs/crash-diagnostics.md` 的“对外约定”为准）：

- 配置字段名、默认值与范围；文件名规则；`format_version: 1` 报告的公共头、`panic`/`native-exception` 的键顺序、`recent_logs` 段与续行规则。
- panic 报告：`thread`、`message`、`location`、`suppressed_since_last`，补写时**可选**的 `deferred: true` 与 `deferred_reason`（`format_version` 仍为 1）。
- panic 限流：可存活的 panic 每 10 秒最多一份；主线程与不能展开的 panic 不受限流，并先补写缓存的被限流 panic；限流只门控符号化、写盘与 fsync，每次 panic 都廉价采集；放行后**先清缓存槽再写报告**，写盘期间新进槽的保留给致命路径补写。
- MiniDump 类型；未处理异常过滤器 + 预建写入线程的做法；截断标记；stderr 提示 `crash report suppressed by the rate limit`、`crash dump timed out`；Unix 目录 0o700、文件 0o600；崩溃目录建不出来时启动失败；崩溃路径等最近日志缓冲锁约 100 ms；`directory` 拒绝前后空白；启动日志字段 `environment_override`。
- 开关环境变量取值 `on|off`（其他值启动失败、空值视为未设置）；共同的自测取值 `panic|thread-panic|abort|access-violation|stack-overflow`。

差异（有意为之）：

| 项 | TiangZ | DBProxy | 理由 |
|---|---|---|---|
| 环境变量名 | `TIANGZ_CRASH_DIAGNOSTICS`、`TIANGZ_CRASH_SELF_TEST` | `TIANGZ_DBPROXY_CRASH_DIAGNOSTICS`、`TIANGZ_DBPROXY_CRASH_SELF_TEST` | 同机部署时互不影响 |
| 相对目录基准 | 工程根目录（沿用现有日志目录规则） | 配置文件所在目录 | 各自沿用本仓库唯一的相对路径规则 |
| 默认目录 | 日志目录同级的 `crash` | `logs/crash` | 同上 |
| 进程名 | `process.name`（多进程） | 固定 `dbproxy` | TiangZ 一机多 Process |
| 保留范围 | 按进程名计，另含目录级 core 文件 | 只处理 `crash-dbproxy-` 文件 | 多 Process 共用目录 |
| 最近日志接入 | 独立 tracing Layer | fmt 外层复制写入器 | 见“最近日志” |
| 新增 kind | `v8-oom`、`v8-near-heap-limit`、`v8-fatal-error`、`child-exit` | 无 | V8 与 Watcher 只在 TiangZ |
| 补写缓存与触发点 | 运行线程、其他线程各一格；除主线程与不能展开的 panic 外，Process 运行线程（`process-runtime`）panic 后主线程 join 到错误时也补写运行线程那一格 | 单格；只在主线程与不能展开的 panic 时补写 | TiangZ 的致命 panic 多在运行线程上，进程以退出码 1 结束而不是在钩子里 |
| `deferred_reason` 取值 | 说明句子，如 `process runtime thread panicked`、`a fatal panic followed on the main thread or a non-unwinding frame` | 枚举 `main-thread-panic`、`non-unwinding-panic` | 各自文档写明；解析方只应依赖 `deferred: true` |
| 自测取值 | 共同取值加 `oom` | 共同取值加 `panic-after-thread-panic` | V8 只在 TiangZ；TiangZ 的补写由子进程单测验证 |
| 自测防误设 | 只在 `process.environment` **显式**为 development/test 时生效，否则启动失败 | 只允许内存存储后端，否则启动失败 | 各自用本仓库已有的“非生产”标志 |
| 启动日志字段 | `enabled_by`（Config/Environment）与同名的 `environment_override` | `environment_override` | 已对齐 `environment_override`，`enabled_by` 为 TiangZ 额外字段 |

已按 DBProxy 对齐（原先不同）：崩溃目录建不出来时启动失败（原先只 warn）；崩溃路径等最近日志缓冲锁约 100 ms（原先约 50 ms）；`directory` 拒绝前后空白（原先只拒全空白）；放行报告后先清缓存槽再写报告（原先写完才清，会清掉写盘期间新进槽的 panic）。

## 限制

- **release 回溯只有函数名、没有行号**：本功能没有改 `[profile.release]`（改动会改变宿主二进制身份，影响游戏仓库的冻结证据）。Linux release 默认保留符号表、剥离调试信息；Windows 函数名依赖与 exe 匹配的 `.pdb`，`.dmp` 分析同样需要 `.pdb`。需要行号时可设 `[profile.release] debug = "line-tables-only"`（或 `CARGO_PROFILE_RELEASE_DEBUG=line-tables-only`），代价是二进制变大，**需另行决定**。
- Windows 上 `abort()`、`__fastfail`（`0xC0000409`）不经过未处理异常过滤器；Windows 上 V8 OOM/致命错误实测以 `0x80000003` 结束，也没有触发过滤器（V8 自己的回调已写报告；为何不经过过滤器未深究）。需要这类转储时用 WER LocalDumps 兜底，见“部署建议”。
- 极端情况下（写入线程卡在磁盘 I/O 上），崩溃进程最多延迟 120 秒退出，之后照常交给系统处理；Watcher 的重启也随之推迟。
- 进程被调试器附加时 Windows 不调用未处理异常过滤器。
- `SIGKILL`、OOM killer、断电、Windows 任务管理器结束进程不会产生任何材料；Watcher 退出记录仍会写（信号 9 或退出码 1）。
- panic 发生在持有最近日志缓冲锁的地方时，最近日志一栏写 `unavailable`，报告照写。
- panic 受 10 秒限流，被限流的只在致命退出路径补写最后一份；中间被限流且非致命的 panic 只有计数与 stderr，见“panic 报告”。
- V8 OOM 与接近堆上限回调只注册在主 Isolate；预检 Isolate 内存耗尽只有 `v8-fatal-error` 报告。
- 崩溃前未落盘的异步日志不会被补写到日志文件，只出现在报告的最近日志段。

## 未实现与原因

- Linux 原生崩溃文本记录：需要异步信号安全的处理器并与 V8 信号处理器链接，风险高于收益；用 core 与 Watcher 退出记录代替。
- V8 Isolate 级致命错误回调（API 误用）：v8 150.4.0 未暴露该绑定。
- 在 near-heap-limit 时生成堆快照或扩容：需求只要求记录，不擅自扩容。
- 在 Windows 上把 abort 也纳入：需要系统级 WER LocalDumps，属部署配置，不在宿主内实现。
- 开发者工具 `process-config.schema` 同步：在另一个仓库（`tiangz-developer-tools`），本次不改，见变更说明。

## 验证

2026-10-16，Windows 10 本机，debug 构建（`cargo test`，Rust 1.97.1）：

- 单元测试 `cargo test --locked --bin TiangZ -- crash_diagnostics:: config::tests::crash`：33 项通过（`crash_diagnostics::tests` 31 项、`config::tests` 2 项）。覆盖配置默认值与越界（含目录前后空白）、环境变量优先级、自测取值与环境限制（含省略 environment 时拒绝）、报告格式逐行（含 `deferred` 键）、UTC 换算、环形缓冲上限与截断、Layer 过滤与字段格式、同名不覆盖、按进程名保留与 core 清理、估计计数、限流、补写缓存两格的覆盖与清除规则、放行后先清槽（写盘期间进槽的那份不会被清）、崩溃目录建不出来时安装失败、退出状态解码（Windows/Unix 两套纯函数，各自平台另有 `ExitStatus` 用例，含退出码 1 与 101 的说明）、退出记录格式与同 pid 文件。其中 8 项在重新执行的子进程里装真实钩子：
  - panic（报告含回溯与最近日志、原钩子输出仍在）；
  - 被 catch_unwind 兜住的 panic（写报告、进程继续、退出码 0）；
  - **运行线程先兜住一次 panic、再致命 panic**（线程名 `process-runtime`，join 出错后补写，退出码 1；共 2 份报告，致命那份含 `deferred: true`、`deferred_reason: process runtime thread panicked` 与回溯，stderr 有限流提示）；
  - **运行线程致命 panic 被缓存后，停机窗口里其他线程再 panic**（其他线程先写出一份报告开启限流窗口；最终 2 份报告，补写的是 `process-runtime` 线程那份，停机窗口里的其他线程 panic 只被限流，没有冒充运行线程）；
  - V8 OOM（`v8-oom` 与 `v8-near-heap-limit` 各 1 份）；
  - **Windows 访问违规**（退出码 `0xC0000005`，`.dmp` 以 `MDMP` 开头，文本记录含异常码、`access_violation: write at 0x0000000000000010`、转储文件名与最近日志）；
  - **Windows 栈上有 JS 帧时的访问违规**（JS 函数调用 op 写 `0x10`，退出码 `0xC0000005`，`native-exception` 记录与 `.dmp` 各 1 份）；
  - **Windows 栈溢出**（退出码 `0xC00000FD`，写入线程写出 `native-exception` 与 `.dmp`）。
- 集成测试 `cargo test --locked --test crash_diagnostics -- --test-threads=1`：8 项通过（按文件计数，0 项被过滤），启动真实 `TiangZ.exe`（临时根目录，无 dist）：关闭时自测被忽略且无文件；`thread-panic` 自测（只写 1 份报告、stderr 两行限流提示、进程继续启动）；`panic` 自测（退出码 101、报告含 `trigger_self_test` 回溯帧与启动日志）；环境变量 `on` 打开、`off` 覆盖配置、非法取值启动失败；`production` 环境与省略 environment 时设置自测都拒绝启动；`oom` 自测（退出码 `0x80000003`，三份报告 `v8-near-heap-limit`、`v8-oom`、`v8-fatal-error`）；Windows `access-violation` 自测（`.dmp` 约 1.05 MB）；Watcher 启动子进程 panic 后写 `child-exit` 记录（`exit code 101`、`restart: no (restart not configured…`、列出子进程的 panic 报告文件名、pid 一致）。
- 回归：`cargo test --locked --bin TiangZ --lib` 共 315 项通过（bin 306、lib 9）；`cargo clippy --all-targets --locked -- -D warnings` 通过；`cargo fmt --check` 通过。
- 门禁：`verify:comments`、`verify:no-local-traces`、`verify:dependency-policy`、`verify:version`（版本保持 0.7.5）通过。

未验证：

- Linux/Unix 部分（`unix.rs`、权限位、信号解码在真实进程中的结果、core 文件）本机未编译、未运行，由 CI 的 Linux 任务覆盖；首次 CI 结果出来前不能称已验证。
- `abort` 自测未在真实进程中运行（Windows 上只会得到 WER 处理与退出码，Linux 需 CI）。
- release 构建下的回溯内容、MiniDump 大小与 `.pdb` 可用性未验证。
- 业务负载下的 Layer 开销未测量（按要求不做压测）。
- 真实 Process 中“运行线程 panic → 补写”的完整链路（`process.rs` 的 join 分支，包括停机期间监管错误提前返回之前的补写）没有端到端运行：需要 dist、业务 V8，且要在停机窗口内同时制造监管错误与运行线程 panic，现有生命周期夹具不支持；子进程用例按同一函数和同一线程名复刻该路径，`process.rs` 的补写放在所有错误出口之前，由代码评审保证。“其他线程 panic 被放行时不清除运行线程那一格”只有纯逻辑单测（放行需要等满 10 秒窗口）。主线程 panic 前先补写、不能展开的 panic 前缀判定也只有代码与单元层面的覆盖。

## English summary

Crash diagnostics are **off by default**; nothing is installed unless `process.diagnostics.crash.enabled` is true or `TIANGZ_CRASH_DIAGNOSTICS=on` (the variable wins; `off` disables; empty means unset; other values fail startup). Fields: `directory` (default: a `crash` sibling of the log directory, relative to the project root like `logging.file.directory`), `recentLogLines` 200 (0–2000), `miniDump` (Windows), `coreDump` (Linux/Unix), `maxReports` 50 (1–10000) and `maxDumps` 5 (1–1000). The section is host-only and never projected into business V8.

- Files are `crash-<process>-<pid>-<UTC>.<txt|dmp>` in the shared `format_version: 1` layout used by DBProxy, with TiangZ-only kinds `v8-oom`, `v8-near-heap-limit`, `v8-fatal-error`, `child-exit` and the panic key `suppressed_since_last`.
- Panic hook writes synchronously (forced backtrace plus recent logs) and then calls the previous hook, so exit codes and catch_unwind behavior are unchanged. Reports are limited to one per 10 seconds (skips are counted, printed to stderr and reported as `suppressed_since_last`); each skipped panic is still captured cheaply (unsymbolized backtrace) and the latest one is written as a `deferred: true` report on fatal exit paths: a panic on the `process-runtime` thread (the Process then exits with code 1), a main-thread panic or a non-unwinding panic, the latter two never being rate limited. The hook path never panics, because std aborts on a panic inside the hook.
- A `RecentLogLayer` keeps the last N formatted events (≤ 2000 × 4 KiB) so reports keep the tail that non-blocking writers may lose.
- V8: OOM, near-heap-limit (reported once, limit never raised) and process-wide fatal-error callbacks write reports.
- Windows: an unhandled-exception filter hands work to a pre-spawned writer thread (stack overflow verified) that writes a text record and, with `miniDump`, a MiniDump (~1 MB in the debug test); abort/fast-fail cannot be caught.
- Linux: `coreDump` raises `RLIMIT_CORE`; the host's `kernel.core_pattern` decides where cores go; Docker needs `--ulimit core=-1`.
- The Watcher writes `child-exit` records with decoded NTSTATUS or signal/core flags, restart decision and related files.
- Retention is per process label (cores per directory), scanning only when the in-process estimate exceeds a limit; Unix files are 0o600 in a 0o700 directory.
- Self-test `TIANGZ_CRASH_SELF_TEST=panic|thread-panic|abort|access-violation|stack-overflow|oom` runs only when `process.environment` is explicitly development or test; otherwise (including an omitted environment) startup fails. A crash directory that cannot be created also fails startup.
- The release profile is unchanged: release backtraces have function names but no line numbers; `debug = "line-tables-only"` needs a separate decision.
