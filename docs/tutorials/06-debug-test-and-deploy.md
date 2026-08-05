# 调试、测试与部署

## 调试一个 Process

```powershell
npm run build:debug
cargo run --bin TiangZ -- configs/local/debug/login-1.json
```

`debug` 位于 `process` 下。一个 OS Process 只有一个 V8 和一个 Inspector，进程中的全部 EntryScene 都可在同一调试会话中断点。`breakOnStart` 会在业务 bundle 执行前等待调试器。

VS Code 连接 `127.0.0.1:9231` 后，可直接在 `app/**/*.ts` 设置断点。详细配置见 `docs/typescript_debugging.md`。

## 测试矩阵

```powershell
npm run check
cargo test --all-targets
npm run test:runtime
npm run test:mailbox-parity
npm run test:backpressure
```

## 从单进程拆到多进程

拆分时为每个进程创建独立 JSON，只把属于该进程的 Scene 放入 `scenes`；所有调用方的 `knownScenes` 仍保留目标地址。Handler、`this.scenes.call/send`、protobuf 和 rpcId 处理都不修改。

必须保证 Scene name 唯一、地址一致、Inner Token 一致、目标端口可达。

## 可观测性

Rust 定期输出每个 EntryScene 的处理数、失败数、队列和 Handler 耗时；Process 共享队列的背压与慢连接指标；Inner transport 的连接、pending RPC、timeout 和 late response。

排查顺序：目标是否存在于 `knownScenes`，端口是否监听，队列是否过载，Handler 是否过慢，响应 msgcode/rpcId 是否匹配。不要用无限增大 timeout 掩盖错误。

## 外网测试机部署约定

外网演示使用独立的部署配置，不修改`configs/local`中的开发地址。2C2G机器使用
`configs/deploy/external-2process/StartMachine.json`，由一个Watcher启动两个Process：登录与Gate进程承载LoginMgr、两个Login和两个Gate；世界进程承载Map、MapManager、Location和动态副本MapHost。旧的`external-all-in-one.json`只保留为单Process回归配置。
入口监听使用`0.0.0.0`，返回客户端的地址使用`outerIp/outerPort`。由于登录与Gate还要接收世界Process的内部调用，拆分部署中这些入口使用`protocol: auto`和`audience: mixed`，同一端口按握手类型区分浏览器WebSocket与内部TCP；地图世界仍使用纯内部TCP。

Cocos3D的外网地址放在资源文件`client_demo/cocos_client3D_3.8.8/assets/resources/Config/tiangz-external.json`，只保存LoginMgr的公网主机和端口；
不要把云服务器内网地址写进前端，也不要把密码写入仓库。构建Web包后由Nginx托管，入口通常是：

```text
http://<公网IP>/
```

除HTTP 80外，云安全组还必须放行客户端实际连接的WebSocket入口端口。当前外网模板默认是：

```text
17000  LoginMgr
17001  Login 1
17002  Login 2
17201  Gate 1
17202  Gate 2
```

Map、MapManager、Location和副本MapHost只使用内网地址，不应对公网开放。确认安全组放行后，先验证页面，再验证LoginMgr WebSocket握手，最后验证Login返回的Gate地址；只验证80端口不能证明游戏链路可用。

后续当用户说“部署到外网测试机”时，固定执行：重新生成协议与场景代码、重新构建后端Release、重新构建Cocos3D Web、上传后端和Web包、更新Nginx资源、重启`tiangz-external`并复验上述入口。部署凭据只通过运行环境提供，不进入配置文件、日志或Git。

后端Release应在本机Docker的Ubuntu 24.04环境中构建，外网服务器只运行发布制品。发布包不包含`src/`、`Cargo.toml`、`node_modules/`和`target/`；桌面Web资源部署到`desktop/`，移动Web资源部署到`m/`，分别对应根路径和`/m/`路径。

Linux发布统一使用固定Builder：

```powershell
# 日常发布；镜像不存在或工具依赖变化时会自动构建一次。
npm run release:linux

# 只准备/检查工具镜像，不编译业务代码。
npm run release:linux:image

# 工具镜像损坏时显式重建。
npm run release:linux:rebuild-image
```

`tiangz-linux-builder:ubuntu-24.04`只包含Node、Rust、.NET Runtime、Luban、npm依赖和Cargo下载缓存，不包含TiangZ业务源码。日常构建把当前工作树复制到临时目录，过滤`node_modules`、`target`和各引擎缓存，然后完整执行`npm run build`、Rust Release编译和制品smoke。也就是说，工具不重复下载，但Excel/Luban、协议、Native Data、Scene、客户端SDK和业务代码每次都会重新生成、编译。

Cargo的Linux中间产物保存在Docker命名卷`tiangz-linux-builder-target`中；最终制品仍输出到`dist/release/TiangZ-<version>-linux-x64`。普通TS、Rust和Excel改动不会重建工具镜像；`package-lock.json`、`Cargo.toml/Cargo.lock`、`rust-toolchain.toml`、Luban目录或Builder Dockerfile变化会让工具指纹改变并自动重建一次。`docker:linux:ubuntu/debian`仍是跨发行版smoke，不是正式发布入口。

## Cocos Web构建约定

Cocos Creator命令行构建统一使用主工程的npm脚本。构建前关闭正在打开同一工程的
Cocos Creator编辑器，避免编辑器锁住`library`或`temp`。脚本会选择与工程匹配的
Creator版本、显式设置Debug/Release、清除`ELECTRON_RUN_AS_NODE`、只清理自己的标准输出目录，并在进程成功后
检查`index.html`是否真的生成。Creator 3.8.x 在本机完成构建后可能返回`36`；脚本只在
`index.html`、`application.js`和`assets`都存在时接受这个已知退出码，其他非零码仍然失败。
不要复制下面的旧式临时命令，也不要只根据进程退出码判断构建成功。

如果修改了Proto、Luban数据或客户端SDK，先执行`npm run codegen`；Cocos构建命令只负责
把当前工程资源编译成Web包，不替代协议和配置生成。

桌面Web：

```powershell
npm run build:cocos3d:web
```

上面的固定命令是Release构建；产物位于
`client_demo/cocos_client3D_3.8.8/build/standard-web/`，发布到网站根路径。
需要在编辑器中调试时才使用：

```powershell
npm run build:cocos3d:web:debug
```

手机演示使用Cocos Creator的`web-mobile`目标，默认横屏并部署到`/m/`：

```powershell
npm run build:cocos3d:mobile
```

上面的固定命令是横屏Release构建；产物位于
`client_demo/cocos_client3D_3.8.8/build/standard-mobile/`，部署到Nginx的`/m/`路径。
Mobile Debug构建对应`npm run build:cocos3d:mobile:debug`。
手机端当前控制方式是左下虚拟摇杆、右侧单指环视、双指捏合缩放、点击地面寻路和动态门按钮；
桌面端仍使用键鼠。手机Web和桌面Web共用同一份协议、SDK和公网LoginMgr配置。

正式外网发布推荐使用下面的一次性命令：

```powershell
npm run build:cocos3d:external
```

命令会重新构建两个目标并整理为：

```text
client_demo/cocos_client3D_3.8.8/build/external/desktop/  -> Nginx网站根路径 /
client_demo/cocos_client3D_3.8.8/build/external/m/        -> Nginx网站 /m/
```

不要把`m`目录部署到根路径；根路径必须使用桌面`web-desktop`包，只有`/m/`使用
`web-mobile + landscape`横屏包。`manifest.json`记录这两个固定映射，可作为上传前检查依据。

Cocos 2D使用同样的规则：`npm run build:cocos2d:web`或`npm run build:cocos2d:mobile`。
对应的Debug命令是`build:cocos2d:web:debug`和`build:cocos2d:mobile:debug`。
编辑器内预览仍直接打开对应工程并点击Preview；预览使用`tiangz-local.json`，发布包使用
`tiangz-external.json`，不能通过修改发布构建命令在两种环境之间切换。

首次迁移到另一台Windows机器时，先执行下面的无构建预检。它只验证工程目录、Creator版本
和最终命令，不启动编辑器，也不会删除旧产物：

```powershell
npm run check:cocos-build
```

如果本机Creator安装路径不同，可通过`COCOS_CREATOR_386`、`COCOS_CREATOR_388`环境变量
指定对应版本，或直接传`--creator`。不要把`ELECTRON_RUN_AS_NODE=1`带给Creator；统一脚本
已经在子进程环境中删除这个变量。输出目录只能放在对应工程的`build/`目录下，便于脚本
清理旧包，也避免误删源码目录。

Cocos Native不是这条Web构建命令的一部分：先在Cocos Creator中生成原生工程，再使用生成工程
的CMake/Visual Studio配置编译。这样可以区分“Creator资源构建失败”和“原生C++工程编译失败”。
