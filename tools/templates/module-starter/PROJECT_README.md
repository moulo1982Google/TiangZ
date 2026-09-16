# __MODULE_ID__ 入门工程

这是 TiangZ 框架自有教学工程，不是 SLG。你只需要基础 TypeScript 知识，先不用学习 Rust、数据库或完整游戏架构。

## 第一次跑通

在本目录执行：

```powershell
npm run doctor
npm run setup
npm run host-build
npm run build
npm run smoke
```

`host-build` 首次或修改 Rust/Native/宿主源码后才需要执行；首次 Rust 编译可能耗时较长。已有对应宿主可执行文件时可以跳过这一项，但版本号相同不保证源码相同。普通 TS 修改使用 `build`，不会重复 Cargo 或客户端全量检查。

第一次 doctor 提示“缺少宿主可执行文件”是待办项，继续执行 host-build，不需要修改业务代码。依赖缺失则按提示在 TiangZ 主工程安装；本工程使用声明的宿主，不复制引擎。

`smoke` 启动本工程的临时测试进程，发出两次真实 WebSocket RPC，预期返回 1、2，然后优雅停止。它不会连接已经运行的游戏，也不会停止占用端口的其他程序。端口冲突时修改 `configs/local/counter.json` 的游戏与健康检查端口。

## 我该看哪里？

运行 `npm run inspect`，再打开 `modules/starter/README.md`，按其中七个位置阅读。`tiangz.project.json` 只记录开发工程路径，不是 Runtime 或模块 Manifest 的替代品。

## 三个练习

1. **改行为**：打开 `CounterComponentSystem.ts`，把增加 1 改为增加 2。重新 build；smoke 会发现预期不符，更新你有意改变的断言为 2、4 后再次验证。不要为了通过测试而改其他逻辑。
2. **改状态**：在 `CounterComponent.ts` 增加字段。Model 变化必须完整构建并重启，不能伪装成在线热更；此模板状态不持久化，重启后归零。
3. **改协议**：在模块 proto 中新增消息，明确契约变化后运行 `npm run protocol-update`。使用生成类型编写 Handler，并从 Hotfix 入口导入；再构建验证。不要手写 opcode、Codec 或修改生成 SDK。

## 日常命令

日常使用 `npm run dev`：初次构建 TS，之后保存已有 Hotfix 行为时自动生成候选并提交 Watcher。构建失败继续运行旧版本；Model、协议、模块声明或启动配置变化会提示你停止后重启，不会自动清空计数。输入 `shutdown` 后回车停止。运行 smoke 前应先退出 dev，避免端口冲突。

保持 dev 运行，在另一个终端执行 `npm run request`，会向配置中的本机教学服务发送一次递增请求并显示 count。修改 System 的增量后再次请求，可以看到新行为保留了之前的计数。request 会修改临时状态，不是只读检查；不会启动或停止服务器，也不写构建产物。服务未就绪、端口不正确或请求超时会明确失败。

- `doctor`：只读环境检查，定位宿主与依赖缺失。
- `setup`：同步编辑器路径并生成模块自有协议/配置/Native 输出；不自动改协议锁。
- `check`：检查编辑器路径、生成物与模块类型，不自动修复。
- `build`：准备并构建 Model/Hotfix 和配置到本工程 dist，不调用 Cargo。
- `start`：启动已构建服务，输入 `shutdown` 后回车停止。
- `dev`：源码开发循环；不调用 Cargo，只自动发布兼容的已有行为。
- `dev:debug`：生成带源码映射的调试 Bundle；Inspector 需在 Process 配置中显式启用。
- `smoke`：运行教学工程的真实请求验收，不是任意业务模块的通用验收。
- `request`：向已经运行的教学服务发一次递增请求，用于观察行为修改；会改变 count。
- `inspect`：只读结构导航，不执行模块源码。
- `protocol-update`：显式更新本工程模块协议锁和 SDK，变更需重建重启。

在 VS Code Developer Tools 中执行“TiangZ：读取模块结构”，插件会读取本项目 tiangz.project.json，无需重复配置宿主。插件只是入口；不安装插件也能执行全部命令。

本模板仅绑定本机回环地址，没有登录、鉴权、限流、持久化或生产部署配置，不能直接公开到互联网。
