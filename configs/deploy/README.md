# 外网部署配置

## 2C2G 单机演示

`external-2process/StartMachine.json` 是当前外网 2C2G 演示的推荐入口，由一个 Watcher 启动两个 Process：

- `login-gate.json`：LoginMgr、两个 Login、两个 Gate。
- `world.json`：MapManager、两个静态 MapHost、Location 和动态副本 MapHost。

两份 Process 配置都显式连接本机 `127.0.0.1:7800` 的 DBProxy，因此外网演示的注册账号、角色和玩家快照可以跨进程、跨重启恢复。DBProxy下面的 Redis/PostgreSQL 只绑定 `127.0.0.1`，不应直接开放公网端口。

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

## 外网数据库

需要账号和玩家数据跨重启恢复时，外网机器还需要启动独立DBProxy。Ubuntu 24.04可以安装系统Docker和Compose插件：

```bash
apt-get update
apt-get install -y docker.io docker-compose-v2
systemctl enable --now docker
```

将`tools-projects/TiangZ-DBProxy/deploy/local/docker-compose.yml`复制到服务器的DBProxy部署目录，创建只允许root读取的`.env`，至少填写PostgreSQL、Redis密码和对应连接串，然后启动：

```bash
docker compose --env-file /opt/tiangz-dbproxy/.env \
  -f /opt/tiangz-dbproxy/docker-compose.yml up -d
```

Redis和PostgreSQL只绑定`127.0.0.1`，不要在安全组开放`5432`或`6379`。DBProxy服务监听`127.0.0.1:7800`，两个外网Process的`process.persistence.dbProxy`都指向这个地址，认证令牌通过systemd环境文件注入。只启动数据库容器而不启动DBProxy，游戏仍不会使用持久化。
