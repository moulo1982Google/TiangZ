# 模块接入、合并与执行验证

本页规则由 TiangZ 文档、Developer Tools 的确定性目录与 AI 插件共同引用。规则提出检查要求；只有实际运行的命令和制品证据才能回答是否通过。

| 规则 ID | 判断与执行位置 |
| --- | --- |
| `model.export-shape` | 当前真实 Model 判定允许函数值（含构造函数）、原始值、数组与普通对象。冻结 Set/Map 不改变形状；Component 实例字段可保存集合。函数是否适合该业务导出另行判断。用声明宿主真实导出预检，Native 声明桥不能证明运算。 |
| `protocol.post-merge` | Git 无文本冲突也要在最终树执行协议 `--check`，以及工程声明的 SDK/配置同步检查。锁 ownership 撞号必须失败，不自动重分配已发布编号。 |
| `persistence.no-change-identity` | 先恢复 pending，再检查当前操作的指纹与历史回执契约；no-op 不抹掉身份，是否持久化回执由具体操作契约决定，不强制所有无变化请求写库。 |
| `persistence.domain-integration` | 新增领域必须接齐加载、codec、验证、规划、写入、回执、恢复、视图及副作用。用游戏封闭类型映射与反例检查漏接；不把登记完整当作经济规则或事务正确。 |
| `validation.target-execution` | 跨端推算以双方共享参数和真实服务端样本验证；Node 源测试与编译成功不能代替真实目标客户端执行。记录实际宿主、SDK、配置和构建身份。 |

独立工程的 `check --json` 区分每个生成/类型/Model/Native 编译阶段，失败或中止后剩余项为 skipped；Native 运算、服务、数据库和客户端保持未验证。命令入口见[命令说明](../reference/commands.md)。预检会执行受信任模块的顶层登记代码，不作为安全沙箱或实时 IDE 静态诊断。

规则边界及评估场景见[AI 开发约束](../ai/skill-development-contract.md)与[开发判断场景](../ai/development-guardrails-scenarios.md)。重试身份与恢复行为需在具体游戏事务测试中证明；不能用建议工具替代当前源码、锁和测试。
