# 热更故障补测与复跑（2026-09-17）

用户要求：框架可靠性优先于游戏功能，继续补测；**24小时测试暂不进行，等用户另行安排**。前一轮一小时与100次切换证据见[主动暂停验收](hotfix-pause-acceptance-20260917.md)。本轮没有修改游戏玩法，也没有因为语言偏好改写Rust客户端。

## 测了什么

新增 `tools/hotfix_fault_matrix.mjs`，复用 `hotfix_load_soak.mjs --prepare-only 1` 生成正式脚手架、Luban配对、内外网协议与客户端SDK。只使用生成的descriptor/codec，不手写消息编号或编解码。创建两个真实Rust/V8进程和500个负载连接，另外使用控制连接观察、解除测试任务。

| 场景 | 必须成立的断言 |
| --- | --- |
| 非法TCP/WebSocket帧、截断TCP帧 | 8条坏连接及时关闭，连接数恢复基线；正常连接仍可请求 |
| 等跨进程RPC时暂停，积压500请求 | 远端完成通知仍返回；旧调用用旧代码/配置完成，500个新请求在切换后按新配对处理 |
| 暂停中再进入256个内部RPC | 128条暂存满时拒绝候选，generation不变；恢复后256条均处理一次 |
| 玩家在暂停中断线 | 新请求未执行；已断线连接排队帧不晚执行，后续连接仍可请求 |
| 两边同时暂停，任务依赖后续业务请求 | 两边都按排空超时放弃，不死锁、不提交半套；释放请求恢复执行 |
| 真DBProxy写成功、回复被代理暂存 | 在途任务结束前不换代，释放回包后成套提交 |
| 真DBProxy读回包迟于3秒窗口 | 拒绝候选、旧generation继续；释放后原请求及500条排队请求均返回 |
| DB连接断一次 | SDK有界重连/重试后旧调用完成，再允许热更；不把“一次断连必然业务失败”当作契约 |
| 本轮DB连接持续不可达 | 重试后明确失败，不永久阻止热更；代理恢复后读到原数据 |
| DB已保存但ACK丢失 | 原ID重试只提交一次；持久revision保持1，重启后仍为1 |
| 等待热更期间优雅停机 | 待提交候选不生效，自有进程正常退出、不强杀 |
| 再启动 | 加载部署的启动配对，持久数据保留；在线热更不偷偷改写启动制品 |

每段检查实际响应中的代码/配置标记及服务器执行序号：不混搭、不重复、不漏执行、不多执行。预期的断线/不可达错误必须发生，不能把“所有错误数都是0”当作故障测试通过条件。控制查询不参与正常执行序号。

## 如何复跑

先按[AI手册：失败教训与复测流程](../ai/business-development-manual.md#失败教训与复测流程)准备、重建、跑短回归和完整verify，再对最终制品做负载/真实DB验证。该手册记录客户端协议误用于Inner RPC等失败原因与禁止绕过方式；下面是命令速查，不代表已授权自动执行所有测试。

在TiangZ主工程根目录执行，先准备匹配的宿主二进制。Windows用`npm.cmd`可避开PowerShell的npm.ps1执行限制。

```powershell
# 无数据库短矩阵；已纳入完整verify，默认重复3轮核心场景
npm.cmd run test:hotfix-faults

# 更多重复，不需要数据库
node tools/hotfix_fault_matrix.mjs --rounds 20

# 显式选择已有的本机测试DBProxy；只影响本轮代理连接
node tools/hotfix_fault_matrix.mjs --rounds 20 --dbproxy-endpoint 127.0.0.1:18700 --dbproxy-env-file ../TiangZ-Examples/packages/slg/infra/dbproxy/.env

# 也可由环境注入TIANGZ_DBPROXY_AUTH_TOKEN，省略env-file
# 修复后短持续负载：500客户端，3分钟，每6秒切换一次；不是24小时验收
node tools/hotfix_load_soak.mjs --seconds 180 --clients 500 --reload-seconds 6 --rpc-timeout-ms 30000

# 完整回归（包含无DB故障矩阵，不会隐式启动真实数据库测试）
npm.cmd run verify
```

真实存储测试必须显式传`--dbproxy-endpoint`，仅接受回环地址。文件内支持`DBPROXY_AUTH_TOKEN`或`SLG_DBPROXY_AUTH_TOKEN`，不会将值写入报告、配置或日志。游戏进程仍经Repository、Host Transport和Rust SDK访问DBProxy；代理只暂存或断开透明TCP数据，不访问Redis/PostgreSQL。

不重启/暂停现有DBProxy、Redis、PostgreSQL容器，不清库、不读写玩家记录。每次运行创建自己的唯一 `hotfix-fault-hotfix-load-*` namespace，最多保留`probe`与`ack-loss`两条快照及对应存储回执/缓存；**测试记录不自动删除**，用于核验。报告的`storageRecords`列出本轮namespace/keys，失败运行也可能留下已提交记录。

现场位于控制台打印的 `temp/hotfix-load-*/fault-report.json`，同目录有`main.log`、`worker.log`及重启日志。`report.json`的`prepared`仅表示夹具准备完成，最终结果要看**fault-report.json**。只有`status=passed`、所有自有进程退出0且没有强杀才通过。支持Ctrl+C中止并尝试正常停止自有进程；被中止不能记为通过。

## 本轮证据

- 第一轮无DB场景通过：`temp/hotfix-load-7RlWnZ/fault-report.json`。
- 3轮含真实DBProxy故障：`temp/hotfix-load-sXtcum/fault-report.json`，16个场景通过，2,785条响应逐条核验，两个进程及重启进程均退出0。
- 20轮含真实DBProxy故障：`temp/hotfix-load-y70Qq4/fault-report.json`，北京时间07:26:09至07:26:46，67个场景通过，15,705条响应逐条核验。10,000条暂停期外部排队请求、5,120条内部转发请求均核验；20次内部暂存满、20次暂停期断线均符合预期。
- Rust清理修复后，新增坏帧和双进程同时暂停的最终20轮真实DB复测：`temp/hotfix-load-kITk3E/fault-report.json`，北京时间07:41:31至07:42:16，69个场景、15,708条响应全部通过；8条坏连接关闭，三个进程实例均退出0、无强杀。成功暂停最大239.2056ms，驱动CPU3531ms／墙钟45300ms。
- 修复后完整回归：`npm.cmd run verify`，北京时间07:42:49至07:52:26，**8/8通过**，内含基础矩阵31/31、TS单测29文件56测试、Rust测试/Clippy及真实模块宿主。报告`dist/test-results/full.json`（复跑会更新）。无DB故障子项`hotfix-load-RQUCqM/fault-report.json`为13场景、2,283条响应通过。
- 500客户端持续负载：`temp/hotfix-load-NUXdOU/report.json`，北京时间07:53:11至07:56:12，180.706秒、30次热更、175,425条请求/响应，零RPC错误、零重复、零代码/配置混搭；最终联合回滚通过，进程退出0且未强杀。RPC超时显式30秒，包含排空超时注入的最大RPC耗时2929.84ms；成功热更最大暂停1.8554ms。该数字来自短时回环测试，不承诺生产环境耗时。
- 对完整回归重建出的同一最终二进制再次跑20轮真实DB矩阵：`temp/hotfix-load-hydXdp/fault-report.json`，北京时间07:56:45至07:57:30，69场景、15,708条响应全部通过，成功暂停最大238.0961ms；三个进程实例退出0、无强杀。收尾检查无遗留TiangZ测试进程。

修复后69场景运行的二进制SHA-256：`7ea71c1368f7f9092017c832ac55406ae861d48b2b7f76ebebca220cc49bbaa6`。与旧版结果分开记录；历史一小时结果不会自动成为这个新二进制的一小时验收。

完整回归重新构建后的二进制SHA-256为`1664e9853d2e3fd8e0791099d04f17091843243e83aeea0307380d0592ccc527`，源码修复相同；后续持续负载以各自报告的哈希为准。构建仍出现原有Windows `LNK4098 libcmt.lib`链接警告，不宣称零警告。Godot运行时检查因未设置`GODOT_BIN`跳过，不属于本轮热更后端验收范围。

上述16/67场景运行使用的服务二进制SHA-256与前一轮一致：`0e190debfde457ee5b4a68a3c6b517ed04b1862988107e7b841d89e1bc081983`，尚未覆盖随后新增的坏帧检查，不能作为修复后宿主的验证结果。

随后新增非法网络帧检查，`hotfix-load-7VPROC`、`hotfix-load-VAWhXd`均复现TCP错误后连接不关闭。`src/transport_backend/epoll.rs`的TCP/WebSocket读循环原来通过`?`提前返回，跳过writer移除、断线通知及发送任务收尾。现在统一收尾后再传播原始错误；坏连接中止发送任务，正常关闭仍保留消息排空。此修改属于Rust网络生命周期修复，部署必须重新构建并重启Process，不可通过Hotfix加载。Windows本轮验证的是epoll命名的Tokio后端，不代表io_uring/KCP验收。

第一次完整回归为7/8：新增坏帧检查在旧二进制失败，其他7项通过；保留该失败，不记作全绿。重建后的首次夹具遇到指标尚未发布，已改为等待初始连接指标，而非取消基线检查。修正后`hotfix-load-q1c4PF/fault-report.json`通过坏帧与双进程暂停检查。

20轮矩阵中，包含人为延迟的成功暂停最大237.8249ms；超时拒绝场景整段约3233.55ms（包括准备、排队恢复及检查，不能当作纯暂停时长）。DB写回包丢失后revision=1，停止重启再读仍不重复提交。JS负载驱动耗CPU约3547ms／墙钟37051ms，约0.096个CPU核；采样RSS峰值135,274,496字节，结束92,090,368字节。本轮没有证据表明驱动成为瓶颈，暂不重写Rust；这是故障矩阵数据，不是高吞吐容量结论。

保留的失败现场：`hotfix-load-fhTzKV`误用外部协议做内部RPC，被访问边界正确拒绝，后改用正式生成的S协议；`hotfix-load-QrUOy5`原先假定断一次DB连接必然业务失败，经代码与日志确认SDK会重连并重放后，拆为断一次恢复、持续不可达失败两个明确测试，并增加丢ACK幂等校验。未降低安全检查或放宽为“成功失败都算通过”。

## 边界

本轮是回环网络双进程与真实DBProxy存储链路验证。延迟由透明代理施加在响应路径上，**不是实际让PostgreSQL慢查询/锁等待，也不是Redis/PostgreSQL掉电或磁盘故障测试**。经济业务事务、跨机器网络分区、Kubernetes灰度、多节点同时崩溃与24小时资源趋势仍未验收。真实DB部分不接入默认CI，避免误用开发者数据库。
