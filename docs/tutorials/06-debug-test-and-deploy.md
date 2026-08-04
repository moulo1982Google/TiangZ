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

手机演示使用Cocos Creator的`web-mobile`目标，默认横屏并部署到`/m/`：

```powershell
$env:ELECTRON_RUN_AS_NODE=$null
& "E:\cocos_editer\Creator\3.8.8\CocosCreator.exe" --project E:\gitee\TiangZ\client_demo/cocos_client3D_3.8.8 --build "platform=web-mobile;debug=false;orientation=landscape;buildPath=E:\gitee\TiangZ\client_demo/cocos_client3D_3.8.8\build\external-mobile"
```

手机端当前控制方式是左下虚拟摇杆、右侧单指环视、双指捏合缩放、点击地面寻路和动态门按钮；桌面端仍使用键鼠。手机 Web和桌面 Web共用同一份协议、SDK和公网LoginMgr配置。
