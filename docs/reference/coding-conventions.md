# 代码注释约定

TiangZ 的注释用于保存调用契约和设计原因，不用于逐行翻译代码。手写的 `Core`、`Demo` 与 Rust 宿主代码遵循本约定；`Generated` 目录由 codegen 负责，不手工补注释。

面向开发者的函数注释采用中英文对照，中文在前、英文在后。中文是项目内部阅读与评审的主要语言；英文保留术语对照，并方便后续公开文档与外部贡献者阅读。新增或修改公共边界时，不得只写英文注释。

## TypeScript

- 公共函数、公共或受保护的方法使用 TSDoc `/** ... */`。
- 注释优先说明作用、副作用、生命周期、并发或 mailbox 语义、可否覆盖/丢弃，以及不应采用的调用方式。
- `Awake`、`OnDestroy`、`onStart`、`onStop` 等生命周期函数需要说明它拥有和释放什么资源。
- Handler 注释说明它修改哪个权威对象，以及广播、持久化或错误响应由哪一层负责。
- 简单 getter、局部纯函数和代码已经完全表达清楚的转换不强制写注释。

示例：

```ts
/**
 * 保存玩家一次。断线、踢下线和进程停机共用同一个 Promise。
 * 业务 Handler 不应直接调用 Repository，否则会绕过幂等边界。
 *
 * Saves the player once. Disconnect, kick, and process shutdown share one Promise.
 * Business handlers must not call the Repository directly because that bypasses idempotency.
 */
SaveOnOffline(reason: string): Promise<void>;
```

## Rust

- 模块使用 `//!` 描述职责边界。
- 对外或跨模块 API 使用 Rustdoc `///`，说明所有权、阻塞/异步行为、失败语义和平台差异。
- 复杂私有热路径使用普通 `//` 解释不变量；不要给显然的赋值、循环和生成代码增加噪声。
- 注释必须随行为修改。公共 API、配置字段或运行时不变量变化时，代码、测试和文档在同一提交更新。

## 克制拆分

- 按职责、状态所有权和依赖方向决定拆分；行数只用于发现候选，不设强制上限。
- 配置与类型契约、运行时执行、指标格式化等有独立修改原因时可以分开；紧密耦合的状态机、生命周期和错误清理保持在一起。
- 小型辅助函数随使用者保留，不采用“一函数一文件”，也不为缩短文件引入只转发调用的 Manager、Delegate、基类或通用 utils。
- 优先保留同一层级的少量明确文件；内部调用直接导入实现，业务继续使用 Stable 入口。只需类型时使用 `import type`，避免引入运行时循环依赖。
- 每批只处理一个清晰边界；搬移与行为修复分别验证。复用现有行为测试，不用只验证文件布局的测试替代行为回归。
- 搬移 Stable API 的内部定义也可能改变完整声明图和构建指纹。开发期记录差异，发布前经兼容性复核按正式命令更新锁并完整构建、重启；不能把开发模式跳过锁比较当作发布门禁通过。

## 验收

`npm run verify:comments`会扫描手写的`app/core`、`app/model`、`app/hotfix`与`src`，要求每个TSDoc/Rustdoc注释块同时包含中文和英文；生成目录不参与检查。日常修改执行`npm run verify:quick`。准备合并阶段或运行时边界有变化时执行完整的`npm run verify`，其中包含拆分进程、mailbox、背压和Watcher优雅停机验收。
