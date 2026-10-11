# v0.7.2

TiangZ 套件 0.7.2 正式版（GitHub Release）：Watcher 持续重启策略、两个宿主修正、deno_core 0.412。协议与 Stable API 不变；新配置字段 `process.lifecycle.restart.policy` 只有 0.7.2 宿主认识。需重建宿主并重启；游戏模块的 Native crate 须改为 `deno_core = "0.412"`（宿主校验版本一致）。之前的标签与附件保持不变。

## 套件内各仓库标签

| 仓库 | 标签 | 版本 | 相对 0.7.1 |
|---|---|---|---|
| TiangZ | `v0.7.2` | 0.7.2 | 下列改动 |
| TiangZ-Examples | `v0.7.2` | 0.7.2 | 模块 Native crate 改为 deno_core 0.412 并重新锁定 |
| TiangZ-DBProxy | `v0.7.1` | 0.7.1 | 无改动（宿主客户端仍用 `v0.7.0` 协议，与 0.7.1 服务端兼容） |
| tiangz-developer-tools | `v0.16.2` | Core 0.16.2 | 无改动 |
| tiangz-native-language | `v0.17.2` | Core 0.17.2 | 无改动 |
| TiangZ-AI-Plugins | `v0.7.1` | 插件 0.3.1 | 无改动 |

## 新增

- **Watcher 持续重启策略。** `restart.policy = "persistent"`：子进程意外退出后按 `backoffScheduleMs`（默认 1/5/30/120 秒）一直重试，稳定运行 `stableAfterMs`（默认 10 分钟）后计数清零；只隔离该进程，不停止整组。默认 `bounded` 与 0.7.1 相同。设计见 `docs/design/watcher-restart-policy.md`。

## 修正

- **异步续体访问 DBProxy 不再中止宿主。** 主循环补跑 V8 微任务时没有进入 Tokio 上下文，续体发起需要定时器的 DBProxy 请求即 panic 并中止进程（0.7.1 起存在；带数据库、在异步处理里访问存储时触发）。新增回归测试。
- **V8 GC 统计不再违反 Rust 引用规则**（0.6.4 起存在）：统计字段改为 `Cell`，回调只取共享引用。

## 依赖

- deno_core 0.411 → 0.412（deno_ops 0.288、serde_v8 0.321、deno_v8 0.4、deno_inspector_server 0.33），V8 仍为 150.4.0；0.412 主要是内存修正（source map 缓存有上限、op 表静态化、模块实例化后释放无用数据）。tokio 1.53.2 等补丁升级。

## 测试与工具

- 新增只在 Linux 测试中编译的 TCP 生命周期诊断探针与 GDB 监视脚本（默认不运行）。

## 验证

- 本地 Windows：Rust 273 项（含新增回归测试；去掉修复时复现同样的中止）、`test:module-native-runtime`、`test:module-host` 通过。
- 苟道三国（外置模块、组合宿主）：
  - rc2 上 8 小时带数据库长稳：1000 人、4 Gate + 2 Host，跳帧 0、非预期错误 0、心跳 p99 19 ms、DBProxy 积压排空且死信 0；PlayerHost 内存平稳。Gate 原生内存（V8 之外）前 5 小时有两个进程每小时增长约 7–8 MB，原因未定，后续单独评估。
  - 修正与 deno_core 0.412 合入后，连开发数据库的 land-demo smoke 53 项通过。
- PR 合入前 Windows/Linux CI 结果与干净消费者安装：见发布记录（待补）。
- 未在本次执行：0.412 上的长稳、性能对比、编辑器内验收。
