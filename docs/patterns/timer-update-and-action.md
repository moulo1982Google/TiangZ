# Timer、Update与Action

## 规则卡

| 规则ID | 推荐 |
|---|---|
| `execution.update` | 每个固定逻辑帧必须执行的连续逻辑使用Update |
| `execution.timer` | 延迟、到期、周期触发必须使用所有者Timer；业务禁止await时间 |
| `execution.coalesced-timer` | 同一所有者下大量定时对象使用最近到期Timer统一调度 |
| `execution.action-delegation` | Action修改哪个领域，就调用哪个领域能力并复用其同步机制 |

少量Buff可以各自持有Timer。数量较大时，BuffComponent保存`nextTickAt/expireAt`并通过最小堆维护一个最近到期Timer，减少常驻调度项。

Buff Tick不直接拼网络包：伤害Action修改Numeric，位移Action调用移动能力，添加Buff的Action调用目标BuffComponent。Action编排留在Hotfix，Timer、Entity和Component生命周期由Core保证。

## 时间调度硬约束（2026-09-17）

新手从下面的“延迟业务开发范式”开始：禁止等待时间之外，必须把开始、到期、取消和恢复写成明确入口。插件在错误处提供查看范式和生成草稿，不自动重写业务。

**游戏业务代码不得用 await 等待时间，无论几分钟、几毫秒还是零延迟。** 倒计时、建筑升级、技能延迟、定时重试、到期事件和周期触发必须走框架所有者定时器。不允许用 `.then`、后台 Tasks、`Promise.race/all`、自定义 sleep 包装或“底层也是 Timer”的理由绕过。

禁止 `await sleep(ms)`、`await delay(ms)`、`await TimerSystem.Instance.WaitAsync(ms)`、`await new Promise(resolve => setTimeout(resolve, ms))`；也禁止业务直接使用 `setTimeout/setInterval/setImmediate`，或将 `NewOnceTimer` 再包装成等待 Promise。正常数据库、RPC、锁与异步结果等待不在此禁令之内。固定帧运动等连续逻辑仍使用框架 Update，不为等待时间添加忙循环。

正确组织方式：

```ts
// Hotfix 方法中：登记后立即返回，不保留跨越倒计时的调用栈。
this.NewOnceTimer(durationMs, "OnUpgradeDue");
// OnUpgradeDue 是同一所有者的方法，届时解析当前 Hotfix 实现。
```

状态与截止时间放在 Model 的所属 Scene/Entity/Component，行为放在 Hotfix；取消走 `CancelTimer`，所有者销毁时自动清理。需要断线、重启恢复的任务持久化业务状态和墙钟截止时间，恢复时重建 Timer，不保存 TimerId、闭包或 Promise。大量任务可以复用一个最近到期 Timer，不要求每个对象常驻独立定时器。

Developer Tools 将可识别违规报告为错误 `tiangz.timer.time-wait-forbidden`，不是提示。主工程编辑器/CLI、模块已打开的标准 `src/model`/`src/hotfix` 文件，以及宿主 `modules:typecheck` 使用同一检查实现；宿主检查按 manifest 声明的 Model/Hotfix 根覆盖自定义目录，并阻止模块构建/开发模式发布。

静态检查覆盖常见 API、导入改名、局部函数别名、原生计时器及直接 Promise 包装；不宣称能证明任意跨文件封装、动态属性或第三方函数的真实语义。审查发现的间接时间等待同样禁止。Runtime 调度与关闭超时、测试/压测夹具、客户端和运维工具不作为游戏业务模板；本规则不修改它们的内部机制。

新工作机需要匹配版本的 Developer Tools core 与宿主。协作开发本地插件时，在同级 `tiangz-developer-tools` 执行 `npm run prepare`，在 TiangZ 使用本地开发依赖（例如 `npm install --no-save --package-lock=false ../tiangz-developer-tools`）；不要手改 lock 或将本机绝对路径提交进依赖。正式团队分发应发布并锁定包含本检查 API 的工具版本。

## 延迟业务开发范式

以建筑升级为例：**登记任务，现在返回，到期再处理**。这只是业务组织方式，不表示 SLG 已实现建筑升级。

| 入口 | 放在哪里 | 负责什么 |
|---|---|---|
| 任务状态 | Model 的所属 Component/Entity/Scene | 任务ID、参数、状态、代次、墙钟截止时间；TimerId 仅运行时保存 |
| 开始升级 | Hotfix 领域方法 | 校验、幂等受理和必要的持久化，登记 Timer；Handler 返回已受理和截止时间 |
| 升级到期 | 同一所有者的 Hotfix 方法 | 检查状态、代次、截止时间，幂等结算并通知玩家 |
| 取消/改期 | Hotfix 领域方法 | 先让旧任务代次失效，再取消 Timer；退款与结算竞争另定业务规则 |
| 恢复任务 | 显式恢复入口 | 加载持久状态后，按剩余时间重建 Timer；已过期也进入同一结算入口 |

一次性触发的核心写法（字段先声明在 Model，方法放 Hotfix）：

```ts
this.delayTimerId = this.NewOnceTimer(
  Math.max(1, this.delayDueAtMs - TimeSystem.Instance.ServerNow),
  "OnDelayDue",
  this.delayRevision,
);
// 当前方法到此返回；OnDelayDue(revision: number) 是同一所有者的方法。
```

`TimeSystem` 从 `#tiangz/model` 稳定入口导入；模块自己的所有者从模块入口导入，沿用工程已有的 System 绑定方式。不要把 Timer 放在协议 Handler 上，也不要在 Hotfix 类里声明字段。

### 到期方法不是把 await 后面的代码原样搬过去

1. 先检查 pending 状态与代次。旧 Timer 即使已排队，也不能完成新任务。
2. 再检查服务器墙钟截止时间；尚未到期则重挂剩余时间，避免时钟校正导致早结算。
3. 用任务ID幂等结算。Timer 本身不保证持久业务 exactly-once；奖励、扣费和状态提交需领域事务或幂等记录。
4. 如果结算 await DB/RPC，返回后重新核对任务状态/代次，并设计与取消的冲突语义。不能靠 CancelTimer 撤回已经发生的效果。
5. 失败保留明确可恢复状态；重试用 Timer，不用 sleep，设置重试上限，并单独处理结果未知。

不要跨倒计时捕获请求、Session 或旧函数。需要保留的业务参数明确存入任务状态，回调仅携带任务ID/代次等小参数。取消后递增代次，清空运行时 Timer 引用；所有者销毁自动清理 Timer，不自动退款、持久取消或完成业务。

### 恢复与配置变化

重启恢复保存业务任务和墙钟截止时间，不保存 TimerId、Promise、闭包或跨进程不可复用的单调时钟值。离线销毁所有者时，必须决定重登补结算还是独立离线调度；重建 Timer 不能再次扣费或重新计算整段工期。

受理时明确固化工期、价格等哪些参数，到期时读取哪些当前配置。Hotfix/config 原子加载不等于已经受理任务的数据迁移。新增 Model 字段或稳定方法形状须 codegen、完整构建并重启，不能当行为热更发布。

周期触发使用 `NewRepeatedTimer`；含异步结果等待且要求不重叠时，可在完成后重挂一次性 Timer。多任务应保存任务集合，大量任务用最近到期 Timer 合并调度，不要把单任务字段反复覆盖。

### 插件操作与维护

在 `tiangz.timer.time-wait-forbidden` 错误处按 `Ctrl+.`：

- **查看延迟业务范式**：打开 VSIX 内置中文离线指南。
- **生成定时器方法骨架**：打开未保存的 TypeScript 草稿，含 Model 字段说明和开始/登记/到期/取消方法。不会修改源文件、搬动扣费逻辑或清除错误。替换所有者与导入，将方法合入已有 System，处理命名冲突；不能直接复制第二个 System 绑定。

命令面板也提供这两个入口。到期方法故意保留 TODO 异常，补齐结算、失败恢复后才可使用。草稿的代次检查不是持久幂等实现。

插件资源在 `tiangz-developer-tools/extension/guides/`；修改本范式时同步该离线指南和骨架，并运行插件 `npm run check`、`npm run package:extension`。新机器安装生成的 VSIX 后重载窗口。此功能不修改现有帧间热更机制，不增加 Reload 屏障，也不声称消除了 DB/RPC 在途等待。
