# 外网部署配置

## 2C2G 多进程演示

`external-multiprocess/StartMachine.json` 是当前外网演示的推荐入口，由一个 Watcher 启动 8 个 TiangZ Process：

- 一个 `LoginMgr`。
- 两个 `Login`。
- 两个 `Gate`。
- 两个静态 `MapHost`，Map1 和 Map2 各自独立进程。
- 一个 `Location`。

动态副本节点和 `MapManager` 暂时不启动；两个 MapHost 使用 `acceptDynamicMaps=false`，只承载各自配置的静态地图。旧的 `external-2process/StartMachine.json` 保留为回退和对照配置，旧的 `external-all-in-one.json` 保留为单 Process 回归配置。

8 个 TiangZ Process 都显式连接 DBProxy 首选地址 `127.0.0.1:7800`，并把 `127.0.0.1:7801` 作为故障切换地址。外网部署同时启动两个无状态 DBProxy 对等实例：

```text
DBProxy 1: 127.0.0.1:7800 ─┐
                           ├─ 同一 Redis + PostgreSQL
DBProxy 2: 127.0.0.1:7801 ─┘
```

两个 DBProxy 不做 Leader 选举、实例间同步或内部 RPC；它们共享同一套存储，客户端在基础设施连接失败时按 Endpoint 切换，并保留原 `requestId/operationId`。DBProxy下面的 Redis/PostgreSQL 只绑定 `127.0.0.1`，不应直接开放公网端口。

8 个 Process 共享 `known-scenes.json`，但每个 Process 只有一个 V8。所有服务都只绑定本机回环地址并使用 `127.0.0.1` 通讯；地图和 Location 只使用内网 TCP。LoginMgr、Login 和 Gate 的公网 `outerPort` 由 Nginx 接管，Nginx 再转发到独立的回环监听端口，客户端仍然使用原来的 `outerIp/outerPort`，业务代码不需要感知代理。

外网 2C2G 的入口映射固定为：`17000 -> 27000`（LoginMgr）、`17001 -> 27001`（Login 1）、`17002 -> 27002`（Login 2）、`17201 -> 27201`（Gate 1）、`17202 -> 27202`（Gate 2）。完整站点配置见 `configs/deploy/cocos3d-nginx.conf.example`。不能让 Nginx 和 TiangZ 同时监听同一个端口，否则会发生端口抢占；因此 `port` 是内网监听端口，`outerPort` 才是公网端口。

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

Redis和PostgreSQL只绑定`127.0.0.1`，不要在安全组开放`5432`或`6379`。DBProxy使用`tools-projects/TiangZ-DBProxy/configs/external-1.json`和`external-2.json`，分别监听`127.0.0.1:7800`与`127.0.0.1:7801`；systemd模板和双实例启动命令见`tools-projects/TiangZ-DBProxy/deploy/external/README.md`。认证令牌通过systemd环境文件注入。只启动数据库容器而不启动两个DBProxy，游戏仍不会使用持久化。
