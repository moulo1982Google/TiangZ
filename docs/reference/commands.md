# 常用命令参考

## 开发阶段先看这里

日常业务开发通常只需要下面几条命令：

| 命令 | 什么时候使用 |
| --- | --- |
| `npm install` | 首次拉取工程或依赖变化后安装TS构建依赖 |
| `npm run dev -- configs/local/StartMachine.json` | 推荐的日常开发入口；首次完整构建并启动Watcher，之后保存Hotfix自动构建和Reload |
| `npm run build:hotfix` | 只修改`app/hotfix`行为时，手工构建不可变Hotfix候选 |
| `npm run build` | 修改Model、Core、Proto、`.native`或首次构建时，生成完整Model/Hotfix配对 |
| `npm run codegen` | 修改Proto、`.native`、Scene、System或Handler声明后，运行全部生成器 |
| `npm run typecheck` | 只检查服务端TS类型，不构建Rust和客户端 |
| `npm run check:project` | 检查目录依赖、配置、Handler与Generated完整性 |
| `cargo run --bin TiangZ -- configs/local/all.json` | 使用单Process、单V8启动本地全部Demo Scene |
| `npm run smoke:client` | 使用Node客户端验证登录、进图链路 |
| `npm run build:debug` | 需要调试TS源码时生成带内联sourcemap的完整Bundle |

只改Hotfix时，`npm run build:hotfix`会输出：

```text
dist/hotfix-candidates/<hash>/
```

Watcher运行期间，在其终端输入以下命令提交候选：

```text
reload E:\gitee\TiangZ\dist\hotfix-candidates\<hash>
```

如果`build:hotfix`提示Model、Core、协议或Native schema指纹变化，不要绕过检查；改用完整构建并重启Process。

## 按修改内容选择命令

| 修改内容 | 推荐命令 |
| --- | --- |
| 只修改Hotfix方法体或Handler | `npm run build:hotfix`，或直接使用`npm run dev -- configs/local/StartMachine.json` |
| 修改Model字段、构造、继承或System公开签名 | `npm run build`，然后重启Process |
| 修改Proto | `npm run codegen && npm run test:protocol` |
| 修改`.native` | `npm run codegen && npm run test:native-data`，然后重新编译Rust并重启Process |
| 修改Core | `npm run check && cargo test --all-targets`，再运行相关Runtime smoke |
| 修改Cocos/Pixi客户端 | 使用对应类型检查或构建命令 |

## 代码生成与客户端开发

| 命令 | 用途 |
| --- | --- |
| `npm run codegen:proto:update-lock` | 评审协议变化后显式更新opcode与schema发布锁 |
| `npm run codegen:client-sdk` | 生成正式协议指纹，并向Cocos/Pixi分发不含Bench的TypeScript SDK |
| `npm run codegen:client-handlers` | 只生成客户端Handler自动导入入口 |
| `npm run build:pixi` | 生成SDK并构建PixiJS/H5客户端 |
| `npm run serve:pixi` | 在`http://127.0.0.1:7460`启动Pixi静态服务器 |
| `npm run typecheck:cocos-demo` | 有Cocos编辑器类型时执行完整tsc；干净CI中自动退化为引擎无关bundle检查 |
| `npm run typecheck:cocos-demo:engine` | 强制使用Cocos编辑器生成类型执行完整Demo类型检查 |

## 提交前检查

| 命令 | 用途 |
| --- | --- |
| `npm run check` | TS、协议、Actor、客户端SDK和Cocos静态检查 |
| `npm run verify:quick` | 生成物、注释、架构规则、协议锁、TS与Rust快速质量门 |
| `npm run verify` | 在快速门上追加真实Runtime、拆分进程、mailbox、背压、Watcher和Hotfix屏障验收 |
| `npm run verify:comments` | 检查Core、Model、Hotfix与Rust手写函数的中英文注释 |
| `npm run verify:design-rules` | 检查Developer Tools设计规则与`docs/patterns`的规则ID和归属文档完全一致 |
| `npm run verify:hotfix-boundary` | 检查Model/Hotfix依赖方向及Hotfix类没有字段、构造和静态初始化 |
| `npm run verify:dependency-policy` | 校验依赖漏洞例外的负责人、原因和到期日期 |

## 功能与稳定性测试

这些命令主要用于框架开发、CI和问题定位，普通业务开发不需要每天运行。

| 命令 | 用途 |
| --- | --- |
| `npm run test:protocol-locks` | 验证协议锁能拦截字段增删、改号、改型、继承和RPC关联变化 |
| `npm run test:runtime` | 单Process与拆分Process真实Runtime smoke |
| `npm run test:rpc-actor-correctness` | RPC回绕、timeout、停机取消和Actor生命周期专项测试 |
| `npm run test:fault-injection` | Process退出、Inner断线、慢客户端、过载、异常、非法帧、重连和保存失败矩阵 |
| `npm run test:fault-injection:core` | 只执行Handler、非法帧、重连和保存失败等快速确定性夹具 |
| `npm run test:fault-injection:runtime` | 执行真实TCP、Runtime背压和Watcher子进程故障注入 |
| `npm run test:backpressure` | 验证队列有界和背压语义 |
| `npm run test:inspector` | TS Inspector与sourcemap验收 |
| `npm run test:hotfix` | 验证现有实例补丁、Handler槽、失败回滚与Hotfix-only构建边界 |
| `npm run test:hotfix-reload` | 启动5个Process，切换正常/反转generation并验证损坏候选不会生效 |
| `npm run test:hotfix-barrier` | 用8秒慢异步RPC验证Reload等待在途任务排空且RPC不错配 |
| `npm run test:hotfix-soak` | 连续Reload 100次并检查Timer、Native实体、pending、V8 Heap与RSS趋势 |
| `npm run test:dev-runtime` | 验证源码开发宿主只接受不可变候选目录，不启动真实服务器 |
| `npm run test:native-data` | 验证生成句柄、Arena、移动状态机和Entity生命周期 |
| `npm run test:client-message` | 验证引擎无关客户端Handler、异步错误和作用域释放 |
| `npm run test:client-sdk` | 验证Client SDK RPC、Update队列、超时、断线、未知消息和背压 |
| `npm run test:client-sdk-distribution` | 验证Cocos/Pixi SDK副本与公共源码逐文件一致 |
| `npm run smoke:pixi` | Windows Edge自动完成Pixi登录、进图和canvas验收 |
| `cargo test --all-targets` | 执行Rust全部目标测试 |
| `npm run test:phase1.9` | 执行历史Phase 1.9完整验收 |

## Bench与性能测试

| 命令 | 用途 |
| --- | --- |
| `npm run build:bench` | 构建显式包含Bench Scene/Handler的Model/Hotfix配对 |
| `npm run build:hotfix:bench` | 在已有且匹配的Bench Model上只构建Bench Hotfix |
| `npm run verify:perf` | 执行三轮框架性能门并与当前机器基线比较 |
| `npm run perf:gate:update -- --profile <name> --reason "原因"` | 显式建立或更新当前机器性能基线 |
| `npm run perf:bridge` | Rust/V8 bridge微基准 |
| `npm run perf:protocol` | Codec/Handler协议微基准 |
| `npm run perf:native-storage` | Handle Arena、Unit/Item类型分池和Unit冷热分池的纯Rust布局基准；不包含AOI与网络 |
| `npm run perf:child-entity -- --children 100000 --lookups 1000000` | ChildEntity创建、O(1)查询、稳定遍历、销毁与V8保留内存微基准；不包含Native、Timer、AOI和网络 |
| `npm run perf:runtime:rust` | Rust客户端Runtime基准 |
| `npm run perf:rpc-baseline` | Windows/Linux通用RPC Payload基线与报告 |
| `npm run perf:kcp-loginmgr -- 127.0.0.1:7000 256 5 20` | KCP LoginMgr RPC基准：地址、连接数、预热秒数、测试秒数 |
| `npm run perf:full-chain` | 单Process/拆分Process完整登录、进图、移动和Push矩阵 |
| `npm run perf:map-capacity -- --gates 8 --players 200 --rounds 3` | 单MapHost全员可见广播、批量下行Bridge和Probe容量测试 |
| `npm run perf:soak -- --minutes 10 --mode split --players 200 --move-rate 5` | 运行指定分钟的完整链路长稳；正式10小时使用`--minutes 600` |

## 清理、监控与发布

| 命令 | 用途 |
| --- | --- |
| `npm run clean` | 删除Rust、TS、Cocos编译产物和引擎缓存 |
| `npm run clean:copy` | 进一步删除依赖和旧报告，得到适合跨机器复制的源码目录 |
| `npm run clean:copy:dry-run` | 预览`clean:copy`将删除的路径和体积 |
| `npm run observability:up` | 按Watcher拆分配置生成Target并启动Prometheus与Grafana |
| `npm run observability:up:single` | 按`all.json`单Process配置启动本地监控栈 |
| `npm run observability:update-targets` | 重新生成Watcher拆分部署的Prometheus Target |
| `npm run observability:dashboard` | 重新生成TiangZ Runtime Grafana Dashboard JSON |
| `npm run verify:observability` | 验收Target、Dashboard、告警、Runtime心跳、Histogram与Native Counter |
| `npm run observability:down` | 停止Prometheus与Grafana容器 |
| `npm run observability:down:clean` | 停止监控容器并清理数据卷 |
| `npm run observability:reset` | 清理监控环境并移除服务端点 |
| `npm run audit:dependencies` | 在线审计npm高危漏洞和Cargo advisory；需安装`cargo-audit` |
| `npm run release:package` | 构建Release制品、生成版本与SHA-256，并在制品目录运行smoke |

`verify:quick`会执行无需Docker的观测资产检查；修改Prometheus配置后，还应使用固定镜像运行`promtool check config`。
