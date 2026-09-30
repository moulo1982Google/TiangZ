# 模块 Native 专用计算线程

2026-09-30：模块同步 Native op 不变。新增显式 `native.workers` 清单，每项声明 name、capacity（含运行中的任务）、maxInputBytes、maxOutputBytes。每项在一个 Process 中拥有一个专用 FIFO 线程；模块导出 `native_data::worker_<name>(String) -> Result<String, String>`，禁止访问 V8 或回调 TS。此阶段仅提供字符串粗粒度边界，不修改独立 Native 语言的语法。

生成的 Model facade 返回 Promise，并提供 stats 与不可逆 drain。超时/丢弃 Promise 不取消已准入计算，也不提前释放容量。过载、输入过大、停止接单显式拒绝；计算错误和 panic 返回失败，不能冒充业务结果。输出上限限制跨 V8 返回的数据，并不限制计算函数内部内存。

Runtime 拥有 worker 与在途计数；Hotfix 提交额外等待所有 Native 计算完成，停止时先关闭 Native 准入并继续驱动 Promise 直至排空。业务必须 await，不能用 detached Promise 绕过 Scene.Tasks；运行时计数仍覆盖请求超时后的计算。停机超时沿用宿主失败退出，不声称可以安全强制取消任意 Rust 函数。

模块名、worker 清单、Rust 源码进入已有 Native 构建指纹。worker 名称不能改变在线 Hotfix 身份。业务 Scene 的 drain 只停止其 worker，不退出整个进程。独立多进程扩容仍通过 Scene RPC，框架不含战斗规则。

每个 worker 是 Process 级资源；多个 Scene 共用同名 worker 时也共用容量与不可逆 drain，业务必须明确唯一所有者。交付计数依赖 Deno op metrics 的 V8 交付事件，Rust Future 完成不能释放屏障；宿主泵与微任务检查点后才允许提交。

已验证：交付修复后的 `npm run verify:release` 完整矩阵 8/8（quick 32/32），Rust 123/123；另跑新加入矩阵的 `node tools/native_worker_lifecycle_self_test.mjs`，真实进程的活跃 worker 阻止 Hotfix 提交，释放后完成；停机先完成已接收计算再退出，worker-only 模块也真实编译通过。真实游戏单进程 8 份冻结报告、8 个并发计算、其他 Scene RPC、业务 drain/stop 和 Process 正常退出通过。提交 528203f 的 Windows/Linux verify（含新增生命周期用例和发布打包）、starter、security 均通过，CI 证据见 native-workers-ci.json；发布元数据只更新文档。没有运行容量长稳，不将这些测试称为生产吞吐验证。

生命周期夹具初次用 2.5 秒轮询判断 worker 准入，但宿主指标固定 5 秒采样，因此误判；清理关闭连接又暴露了夹具未立即接住 pending Promise 的问题。修正为 Rust 线程写入专用临时 started/done 标记，确认真正进入计算后才发送热更/停机；不改变生产采样间隔或屏障。三轮日志和首次失败保留在证据归档，最终输出为 native worker lifecycle passed。
