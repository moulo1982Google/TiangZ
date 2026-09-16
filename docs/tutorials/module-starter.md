# 从零读懂模块开发

## 可选 Rust 扩展壳

创建时追加 `--with-rust`：

```powershell
npm run project:create -- --path ../MyRustGame --id org.example.game --with-rust
```

新工程包含独立 Rust crate、`.native` 接口、生成桥和 `NativeExample` TS 入口，教学计数器实际调用 Rust 加法。手写与生成目录见模块 `RUST.md`。需要 Cargo/rustfmt；创建读取宿主依赖并生成代码，不编译、不启动服务、不修改宿主 Cargo.toml。

在新工程执行 `npm run setup` → `npm run host-build` → `npm run build` → `npm run smoke`。`host-build` 自动组合本工程的 Rust 模块，`start/smoke/doctor` 核验组合身份、源码指纹和二进制哈希，不回退普通宿主。`check` 额外执行 Cargo check（会更新构建缓存和组合工作区，不改手写源码）。

当前 Native 工程不支持 `npm run dev` 自动监听；Rust/Native/Model 改动后停止自己的进程，重新生成、编译、构建并启动。TS-only 默认不变。只要空模块时使用 `npm run modules:create -- --id org.example.native --path ../MyModules/native --with-rust`，再按生成的 RUST.md 接入；空模块不自带 Scene。

Developer Tools 的“新建模块入门工程”提供 TypeScript / TypeScript + Rust 扩展选项，仅传参给宿主脚手架，不维护另一套模板。

本教程面向已有基础 TypeScript 知识的新手。目标是完成一次真实请求并找到状态、行为和装配的位置，不是开发 SLG，也不要求先读完整架构文档。

## 创建并验证

先安装 TiangZ 主工程的开发依赖（`npm install`），再从主工程创建新目录：

```powershell
npm run project:create -- --path ../MyGame --id org.example.game
```

创建命令拒绝覆盖已有目录，生成模块自有协议锁与 TypeScript SDK，不修改宿主协议、不启动进程或数据库。默认游戏端口 19001、健康检查 19002，可在创建时用 `--port`、`--health-port` 指定。

切换到新工程：

```powershell
cd ../MyGame
npm run doctor
npm run setup
npm run host-build
npm run build
npm run smoke
```

doctor 是只读基础环境检查；host-build 首次或宿主/Rust 变化时执行，已有对应二进制可跳过。普通 TS 构建不运行 Cargo。smoke 启动自己的进程、使用生成 SDK 发两次 RPC，验证 count=1、2，再优雅停机；端口占用时拒绝，不连接旧服务或停止其他程序。教学状态重启归零，不是持久化存档。

首次 doctor 提示“缺少宿主可执行文件”属于环境待办，不代表模块业务代码出错；按后续 host-build 完成编译即可。若提示宿主依赖缺失，先回到 TiangZ 主工程安装依赖，不要在游戏目录复制引擎或另装一套工具链。

## 只记住两条轴线

代码组织：模块 Manifest → Model 状态与稳定方法 → Hotfix 行为与 Handler。部署组织：Process → Scene → Component。模块不是进程，多个场景实例也不意味着复制模块。

`npm run inspect` 列出阅读入口。Model 和 Hotfix 按相同功能目录 `counter` 对应；Handler 只转交请求，Component 保存 count，System 实现 Increment，SceneSystem 在 onStart 装配 Component。入口文件说明哪些类型登记、哪些行为被加载。

本模块 TS export、modelExports 运行时桥、跨模块 publicApi 是不同职责。模板没有对其他模块公开 API；跨模块协作时显式声明依赖与 publicApi，禁止深层导入实现。

## 接手别人的模块，先按这张地图找

下表路径相对于教学模块根目录。其他模块先以自己的 `tiangz.module.json` 声明为准；`counter` 是本例功能名，不是框架要求所有业务使用的目录。

| 想知道什么 | 先打开哪里 |
| --- | --- |
| 这是哪个模块，依赖谁，入口在哪？ | `tiangz.module.json` |
| 哪些稳定类型登记了，哪些 System 必须存在？ | `src/model/index.ts` 的 `modelExports` 和 `requiredSystems` |
| 状态属于谁，重启是否保留？ | `src/model/counter/CounterComponent.ts` 定义状态；本例挂在 Scene，未接入持久化。 |
| 方法具体怎么做？ | 同功能目录的 `src/hotfix/counter/CounterComponentSystem.ts` |
| 请求从哪里进来？ | `src/hotfix/counter/handlers/IncrementHandler.ts`；消息契约看 `proto/` 源文件。 |
| 谁创建并挂载组件？ | `src/hotfix/counter/CounterSceneSystem.ts` 的 `onStart`；其他模块按实际 Factory/生命周期查找，不假定都在这里。 |
| 文件是否真的加载了？ | `src/hotfix/index.ts` 的显式导入，再用 `npm run inspect` 核对静态可达关系。 |

接手时先回答五件事：模块入口、状态所有者、行为位置、装配位置、公开接口。答不出来就补模块 README 或修正代码组织，不要求读者先研究业务算法。跨模块接口必须以声明和实现为准；导航无法确定的动态关系仍需人工核对。

提交一个新功能时，同时交代改变的是 Model 还是 Hotfix、是否新增协议、如何加载、怎么验证。这样评审者能直接判断是否需要重启和 codegen，而不是根据文件名猜测。`inspect` 帮助阅读结构，`check` 检查静态约束，真实请求测试才验证运行行为，三者不能互相替代。

## 工具职责

`tiangz.project.json` 是开发工具配置（formatVersion 1），记录宿主路径、modules 模式、模块集合与本地启动配置；不是新增 Runtime 配置。游戏里的小启动桥只调用 TiangZ `tools/game_project.mjs`，不复制生成、检查和构建实现。

现有工具动作：doctor/setup/check/build/host-build/start/dev/smoke/request/inspect/protocol-update。setup 生成和准备；check 只核对；build 复用生成器和模块 Bundle 检查，不重复类型编译；protocol-update 才显式更新协议锁。互斥锁防止同一工程并行命令覆盖产物，异常遗留锁需要确认旧 PID 停止后人工清理，不自动抢占。

当前工作流针对 TS 模块；发现 Native 模块会明确拒绝普通二进制回退，须走现有 Native 组合构建/发布流程。start 只启动已构建代码。日常 `npm run dev` 复用共享 Watcher 循环，初次构建不做 Cargo，保存已有 Hotfix 行为后构建不可变候选并提交 Reload；失败保持旧版本。Model、协议、模块声明或启动配置变化会提示重启，不自动重置状态。`dev:debug` 生成调试 Bundle，Inspector 仍需在 Process 配置中显式启用。

输入 shutdown 或关闭父控制输入后，开发会话请求 Watcher 优雅停止，关闭监听器并释放工程锁。候选路径使用 JSON 构建结果，支持带空格的工程目录，只接受当前工程候选目录下的不可变产物；不会把日志截断路径或其他工程产物提交给 Watcher。

另开终端运行 `npm run request`，向已启动的本机教学服务发一次真实递增请求，观察修改行为后 count 的变化。它会修改临时计数，不是只读检查；不启动/停止服务，不取得构建锁，也不写入 dist。smoke 仍是启动全新测试进程的独立验收。稳定源码监听按内容比较，原样保存 Model 或编辑器原子替换同内容文件不会误提示重启。

Developer Tools 的模块导航可以读取工程声明，调用同一宿主检查/解析；没有插件也可完整使用命令。导航与 AI 解释不是热更许可，实际发布仍由构建指纹和 Runtime 决定。

## 出错时先看哪一层？

先看终端的第一条具体错误和文件位置，不要只看最后的“命令失败”。插件任务可把宿主诊断定位到 Problems；没有插件也能按文件、行列直接打开。

| 提示或现象 | 下一步 |
| --- | --- |
| 宿主缺失或版本不匹配 | 运行 `host-build`，不是修改业务类型；同版本源码变更也需按实际情况重建。 |
| 编辑器路径或生成物过期 | 运行 `setup` 再 `check`；若确实改变协议契约，审查后显式 `protocol-update`。不要手改生成文件或盲目更新锁。 |
| `tiangz.hotfix.instance-state` | 将实例状态放到 Model；检查 System/Handler 中的字段、构造函数和静态成员。Model 变化后重建重启。 |
| `tiangz.module.bridge-missing` | 核对模块 Model 入口的 TS 导出和 `modelExports`，不要靠深层导入绕过桥接。 |
| 新行为没有生效 | 运行 `inspect`，核对 Hotfix 入口是否实际导入该文件；type-only 导入不会加载行为。再看候选构建/发布是否成功。 |
| 提示需要重启 | 先停止 `dev`，再启动；不要以重复保存 Hotfix 代替 Model/协议/配置的重建。教学计数会归零。 |
| `.tiangz-dev.lock` 占用 | 等待或停止自己已打开的开发命令。异常退出后先查看锁记录并确认旧 PID 已停止，才人工清理，不直接抢锁。 |
| 端口占用、请求失败 | 区分 `request` 连接现有服务与 `smoke` 启动新服务；确认本工程服务就绪及端口配置，不终止不明进程。 |

独立模块工程不使用旧主工程的 `verify:fast` 或三件套 Component 生成器。插件发现根目录 `tiangz.project.json` 后会提示模块入口；旧 LSP 未执行模块检查不代表模块已通过验证，仍需宿主 `check`。

## 验收

新增配套组件可从 TiangZ 宿主执行：

```powershell
node tools/create_module_component.mjs --project ../MyGame --module org.example.game --name Inventory --feature inventory --dry-run
node tools/create_module_component.mjs --project ../MyGame --module org.example.game --name Inventory --feature inventory
```

命令在同名 Model/Hotfix 功能目录生成 Component/System，补齐 Model TS 导出、modelExports、requiredSystems 与 Hotfix 入口导入，不创建跨模块 publicApi，不自动选择 Scene/Entity 所有者。随后由业务在明确生命周期中 AddComponent，再 check/build 并重启。已有文件、生成目录、链接路径和无法安全修改的动态入口会拒绝。常规失败按内容检查回滚；并发编辑或进程崩溃可能需要按保留的恢复副本人工处理，不宣称跨文件崩溃原子性。

`--dry-run --json` 返回完整内容与 planHash，调用者可将该值传入 `--expect-plan` 防止执行过期预览。Developer Tools 的“新建模块 Component”使用此流程；插件不维护另一套源码模板。

`npm run test:game-project` 在唯一临时目录创建教学工程，覆盖带空格路径、编辑器准备、生成物与类型检查、modules 构建、真实 RPC、正常停机、拒绝覆盖和工程互斥锁。模板仅绑定回环地址，不含生产鉴权、登录、持久化或公开部署配置。

`npm run test:game-project-dev` 额外验证同一运行进程中的真实行为热更、状态保留、语法错误拒绝、Model 变化提示重启以及正常停机与锁释放。

持续运行验收可显式执行 `node tools/game_project_soak.mjs --duration 90 --reload-every 5 --restart-every 45`（单位秒）。只创建唯一临时教学工程，周期性检查真实请求、状态保留、错误候选拒绝、客户端重连和受控重启，报告保留在输出的临时目录。成功后移除该次教学工程，失败保留用于排查；不使用既有 SLG 服务或数据库。Windows 上不要同时重新链接正在运行的宿主二进制。内存采样不是容量压测或无泄漏证明。
