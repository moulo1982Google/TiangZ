# __MODULE_ID__

这个模块只展示开发模式：请求使场景计数增加一次。计数属于场景上的 Component，所有连接共享；进程重启归零，不是玩家存档，不需要数据库。

## 固定阅读顺序

1. `tiangz.module.json`：模块身份、依赖、Model/Hotfix 入口。
2. `src/model/index.ts`：Model 登记、本模块运行时桥和必需 System。
3. `src/model/counter/CounterComponent.ts`：状态与稳定方法声明。
4. `src/hotfix/counter/CounterComponentSystem.ts`：方法实现。
5. `src/hotfix/counter/handlers/IncrementHandler.ts`：消息入口。
6. `src/hotfix/counter/CounterSceneSystem.ts`：组件装配位置。
7. `src/hotfix/index.ts`：哪些行为实际被加载。

Model 与 Hotfix 使用同名功能目录。`generated` 和协议锁由生成器维护，不能手改。新增目录不是自动加载，必须由入口静态导入。

`modelExports` 服务于本模块 Hotfix；跨模块公开接口需要单独声明 `publicApi`，本模板没有跨模块 API，也不鼓励其他模块深层导入内部实现。

模块不是进程，也不是 Scene：Manifest 定义代码组合，Scene 定义运行容器，Process 配置决定部署。更多实例应该改部署配置，不是复制模块代码。
