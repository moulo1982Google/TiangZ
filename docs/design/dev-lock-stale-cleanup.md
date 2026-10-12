# 开发锁残留清理

`tools/game_project.mjs`（setup/check/build/host-build/start/smoke/protocol-update）、`tools/dev_runtime.mjs`（dev）和 `tools/create_module_component.mjs` 通过游戏工程根目录下的 `.tiangz-dev.lock` 互斥，防止两个命令同时改写生成物和 `dist`。实现见 `tools/game_project_lock.mjs`。

## 为什么要自动清理

原设计发现锁就拒绝，要求人工确认旧 PID 已停止后删除锁，目的是绝不从仍在运行的命令手里抢锁。但命令被直接终止时（例如 Windows 上点控制台窗口的关闭按钮，Node 进程不会执行 `finally`），锁一定残留，下一次构建每次都需要人工处理。

调整后的原则不变：**只有能证明记录的进程已经退出时才清除；任何无法证明的情况都按“仍在运行”拒绝。**

## 锁内容

```json
{ "pid": 1234, "action": "dev", "startedAt": "2026-10-11T08:00:00.000Z", "hostname": "dev-pc", "token": "<uuid>", "processIdentity": "linux:<boot_id>:<starttime>" }
```

- `pid`、`action`、`startedAt` 是原有字段，含义不变。
- `hostname`：写锁的主机名。工程目录在网络盘或容器共享卷上时，其他主机无法核对该 PID。
- `token`：每次加锁的随机值。释放时只删除仍带自己 token 的锁，避免误删别人的锁。
- `processIdentity`：只在 Linux 写入，是 `/proc/sys/kernel/random/boot_id` 加 `/proc/self/stat` 第 22 个字段（启动 tick），可精确判断 PID 是否仍是同一个进程，不受墙钟调整影响。
- 旧格式（只有前三个字段）仍可识别：缺少 `hostname` 按本机处理，缺少 `processIdentity` 按启动时间判断。

## 判断规则

依次检查，第一条命中即得出结论：

1. 锁内容不是 JSON、`pid` 不是正整数或 `startedAt` 不是合法时间 → **占用**。空文件也在此列：另一命令可能刚创建锁、尚未写完内容。
2. `hostname` 存在且不是本机 → **占用**。
3. `process.kill(pid, 0)`：`ESRCH` → **残留**（进程不存在）；`EPERM` → 进程存在；其他错误 → **占用**。
4. 进程存在时读取其启动信息：
   - 锁和当前进程都有 `processIdentity`：相同 → **占用**；不同 → **残留**（PID 被复用）。
   - 取得进程启动时间：晚于 `startedAt` 超过 2 秒 → **残留**（PID 被复用：持锁进程一定在写锁之前启动）；否则 → **占用**。
   - 取不到启动信息：再查一次进程是否存在，已不存在 → **残留**；否则 → **占用**。

判定残留时打印一行（stderr）：

```text
[dev-lock] 已清除残留开发锁 <路径>（PID 72004，action=dev，startedAt=...）：记录的进程已不存在；继续执行 build。
```

判定占用时与原来一样以错误退出，错误信息附带原锁记录和判断原因。原来的“等待/拒绝”语义是立即拒绝，现在仍是立即拒绝，不增加轮询等待。

判定残留但没能接管时，也立即报错、不继续执行，且不放宽任何判断：

| 情况 | 报错 |
| --- | --- |
| 接管文件已存在 | “另一命令正在接管残留开发锁”，附接管文件里的 PID、action、startedAt、host（读不到时说明原因），供用户判断接管者是否还在后手动删除 |
| 删除残留锁或创建接管文件返回 `EACCES`/`EPERM` | “无权限删除残留开发锁”，附文件路径、原锁记录、判断原因和错误码；锁保留，接管文件已释放 |
| 连续 3 次清除后重新建锁都被其他命令抢先 | “多次尝试取得开发锁均被其他命令抢先，请稍后重试”；不再报成“已有开发命令占用” |

### 各平台读取进程启动时间

| 平台 | 存在性 | 启动信息 |
| --- | --- | --- |
| Windows | `process.kill(pid, 0)`（OpenProcess + 退出码） | `powershell.exe` 查询 `Win32_Process.CreationDate`（CIM），约 0.3 秒；只在锁存在且进程存在时执行 |
| Linux | 同上 | `/proc` 启动身份；旧格式锁另用 `/proc/stat` 的 `btime` 加启动 tick / `getconf CLK_TCK` 算启动时间（`btime` 截到秒，只会偏早），取不到时退回 `ps -o lstart=`。精简镜像没有 `ps` 也能工作 |
| macOS 等 | 同上 | `ps -o lstart=`（`LC_ALL=C`、`TZ=UTC`） |

命令不存在、超时（15 秒）、无权限或输出格式不符时一律视为“取不到”，回到保守判断。`ps` 使用 UTC 输出，避免夏令时回拨那一小时的歧义。

### 为什么这样是安全的

- 持锁进程一定在写锁之前启动，所以它的启动时间不会晚于 `startedAt`。Windows 的 `CreationDate` 与 macOS 的 `lstart` 是进程创建时记录的绝对时间，`lstart` 截到秒只会让启动时间显得更早；Linux 新锁按启动身份精确比较。因此仍在运行的持锁进程不会被判为残留。
- 2 秒容差吸收时钟微调。代价是：PID 在锁写入后 2 秒内就被复用的情况会被保守判为占用，需要人工处理。
- 墙钟大幅向前调整只影响 Linux 上的旧格式锁（启动时间由开机时间 `btime` 推算，`btime` 随墙钟调整）；新锁按启动身份比较，不受影响。

残余风险（不在“仍在运行的持锁进程不会被判为残留”的保证之内）：

- **Windows、macOS**：如果墙钟在持锁进程**创建之后、写锁之前**向后步进超过 2 秒，`startedAt` 会早于进程创建时间 2 秒以上，仍在运行的持锁进程会被误判为 PID 复用而被清锁。该窗口是 Node 启动到取锁的一小段时间（通常不到 1 秒）；写锁之后再调整时钟不影响判断。
- **Linux 旧格式锁**：与上一条对称，墙钟在持锁进程启动后向前步进超过 2 秒，由 `btime` 推算出的启动时间会晚于 `startedAt`，同样可能误判；新格式锁不受影响。

## 并发接管

两个命令可能同时判定同一把锁残留。直接“删除再创建”会出现：A 删除旧锁并创建新锁后，B 再删除 A 的新锁。因此清除通过接管文件 `.tiangz-dev.lock.takeover` 串行化：

1. 以独占创建（`wx`）打开接管文件；已存在说明另一命令正在接管，本命令立即报错退出，不等待。
2. 持有接管文件时重新读取锁，与判定时读到的内容**逐字节比较**，仍相同才删除；已不存在或内容已变则不删除。
3. 释放接管文件，然后回到正常的独占创建锁流程；创建失败（被别的命令抢先）就按新锁重新判断。

持锁命令正常释放锁时不需要接管文件，只删除仍带自己 token 的锁。

接管文件只在“读取、比较、删除”的几毫秒内存在。如果进程恰好在这段时间被终止，接管文件会残留，之后遇到残留锁时会提示“另一命令正在接管”；确认没有开发命令在运行后手动删除 `.tiangz-dev.lock.takeover`。接管文件不做自动清理，否则需要再一层互斥。`project:create` 生成的 `.gitignore` 同时忽略锁和接管文件；已有工程可自行补上 `.tiangz-dev.lock.takeover`。

## 不做的事

- 只判断锁里记录的进程（运行 `game_project.mjs`、`dev_runtime.mjs` 等的 Node 进程），不检查也不停止它启动的子进程。控制台被关闭后 Watcher/宿主子进程若仍在运行，清除锁后新的 `start`/`dev` 会因端口被占用而失败，按端口提示处理。
- 不检查进程名：同名进程不能证明它就是持锁者，不同名也已由启动时间规则覆盖。
- 不在其他主机上清除锁。主机按 `os.hostname()` 区分，**不保证识别**下列情况，不在支持范围内：
  - 两台主机名相同的机器共用同一工程目录（网络盘、共享卷）；
  - 主机名相同但 PID 命名空间不同的容器与宿主机或其他容器共用工程目录（例如容器显式设成与宿主同名，或 `--uts=host` 而不共享 PID 命名空间）。这些容器共用内核，`boot_id` 也相同，启动身份无法区分。

  这些情况下另一侧的 PID 在本机看来不存在或属于别的进程，可能把仍在运行的锁当成残留。共用工程目录的每台机器、每个容器应使用不同的主机名，或不要在共用目录上同时运行开发命令。

## 验证

```powershell
node --test tools/game_project_lock.test.mjs   # 已列入 verify:quick
node tools/module_component_scaffold_self_test.mjs
node tools/game_project_self_test.mjs          # 完整矩阵用 --runtime
```

`game_project_lock.test.mjs` 覆盖：
- 新锁格式与释放；释放不删除别人的锁；
- 进程已退出时清除并继续（旧格式锁）；持锁子进程被强制终止后清除其新格式锁（终止前照旧拒绝）；
- 进程仍在运行且启动早于锁时拒绝且不改锁；PID 复用（进程启动晚于锁）时清除；启动身份相同视为占用、不同视为复用；
- 读不到进程信息、锁内容无法识别、其他主机的锁都拒绝；
- 同一进程内和四个进程同时接管时只有一个成功；
- 接管文件已存在时报错附带接管者信息；无权限删除残留锁时友好报错且锁保留；连续被抢先时报“多次被抢先”；
- `ps lstart` 解析。

实测记录：

- 2026-10-11 首版（12 项）：Windows 10 本机 12/12（连续 3 次）；Linux `node:22-bookworm-slim` 容器（无 `ps`）12/12（连续 3 次）；Linux 实际 `ps -o lstart=` 输出可被正确解析。macOS 未实测。
- 2026-10-11 评审修改后（15 项）：Windows 10 本机 15/15（连续 3 次）；Linux 同一容器 15/15（连续 3 次）。

### 修复前对比的复现方法

修复前的 v0.7.2 没有 `tools/game_project_lock.mjs`，测试文件无法直接加载。对比时临时放回旧实现，再用一个只做转发的过渡模块让测试能够加载：

```bash
git show v0.7.2:tools/game_project_build.mjs > tools/game_project_build.mjs
printf 'export { acquireGameProjectLock } from "./game_project_build.mjs";\nexport function parsePsStartTime() {}\n' > tools/game_project_lock.mjs
node --test tools/game_project_lock.test.mjs   # 记录结果
git checkout -- tools/game_project_build.mjs tools/game_project_lock.mjs   # 恢复
```

首版 12 项在旧实现上 3 通过、9 失败；通过的 3 项都是“保守拒绝”类（仍在运行、读不到进程信息、锁内容无法识别或来自其他主机），旧实现本来就一律拒绝。评审修改新增的 3 项，用首版提交 `78e559b6` 的 `tools/game_project_lock.mjs` 运行时全部失败，其余 12 项通过。
