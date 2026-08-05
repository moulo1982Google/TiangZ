# 外网部署配置

## 2C2G 单机演示

`external-2process/StartMachine.json` 是当前外网 2C2G 演示的推荐入口，由一个 Watcher 启动两个 Process：

- `login-gate.json`：LoginMgr、两个 Login、两个 Gate。
- `world.json`：MapManager、两个静态 MapHost、Location 和动态副本 MapHost。

两个 Process 共享 `known-scenes.json`，但各自只有一个 V8。所有服务仍在同一台机器上使用 `127.0.0.1` 通讯；LoginMgr、Login 和 Gate 使用`auto + mixed`端点，同时接受浏览器 WebSocket和世界Process的内部TCP，并对客户端返回`outerIp/outerPort`。

旧的 `external-all-in-one.json` 保留为单 Process 回归配置，不作为 2C2G 外网默认部署。

systemd 托管 Watcher 时，必须保持顶层标准输入打开；Watcher 将标准输入 EOF 解释为“父进程已消失”并主动停机。外网服务使用`tail -f /dev/null | exec ... StartMachine.json`作为启动包装，并设置`KillMode=control-group`，保证停止服务时Watcher及两个子Process一起退出。

## Cocos3D双入口

外网前端必须把桌面版和手机横屏版当作两个独立入口。推荐在主工程根目录执行：

```powershell
npm run build:cocos3d:external
```

命令会重新构建两个目标，并整理为：

```text
client_demo/cocos_client3D_3.8.8/build/external/desktop/  -> Nginx根路径 /
client_demo/cocos_client3D_3.8.8/build/external/m/        -> Nginx路径 /m/
```

根路径只能部署`desktop`，`/m/`只能部署`m`。前者的产物平台是`web-desktop`，后者的产物平台是
`web-mobile`并固定横屏；命令还会生成`manifest.json`，用于上传前检查映射是否正确。
