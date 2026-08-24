# 外网部署配置

## 2C2G 多进程演示

`external-multiprocess/StartMachine.json` 是当前外网演示的推荐入口，由一个 Watcher 启动 10 个 TiangZ Process：

- 一个 `LoginMgr`。
- 两个 `Login`。
- 两个 `Gate`。
- 两个静态 `MapHost`，Map1 和 Map2 各自独立进程。
- 一个 `MapManager`。
- 一个只承载动态副本的 `MapHost`。
- 一个 `Location`。

两个静态MapHost继续使用`acceptDynamicMaps=false`；`dungeon_1`使用`acceptDynamicMaps=true`并通过内网`MapManager`创建Map 200副本。二者都不增加公网入口。旧的`external-2process/StartMachine.json`保留为回退和对照配置，旧的`external-all-in-one.json`保留为单Process回归配置。

10 个TiangZ Process都显式连接DBProxy首选地址`127.0.0.1:7800`，并把`127.0.0.1:7801`作为故障切换地址。外网部署同时启动两个无状态DBProxy对等实例：

```text
DBProxy 1: 127.0.0.1:7800 ─┐
                           ├─ 同一 Redis + PostgreSQL
DBProxy 2: 127.0.0.1:7801 ─┘
```

两个 DBProxy 不做 Leader 选举、实例间同步或内部 RPC；它们共享同一套存储，客户端在基础设施连接失败时按 Endpoint 切换，并保留原 `requestId/operationId`。DBProxy下面的 Redis/PostgreSQL 只绑定 `127.0.0.1`，不应直接开放公网端口。

10个Process共享`known-scenes.json`，但每个Process只有一个V8。所有服务都只绑定本机回环地址并使用`127.0.0.1`通讯；MapManager、地图和Location只使用内网TCP。LoginMgr、Login和Gate的公网`outerPort`由Nginx接管，Nginx再转发到独立的回环监听端口，客户端仍然使用原来的`outerIp/outerPort`，业务代码不需要感知代理。

外网2C2G的WSS入口映射固定为：`17000 -> 27000`（LoginMgr）、`17001 -> 27001`（Login 1）、`17002 -> 27002`（Login 2）、`17201 -> 27201`（Gate 1）、`17202 -> 27202`（Gate 2）。完整站点配置见`configs/deploy/cocos3d-nginx.conf.example`，公共WebSocket参数片段见`configs/deploy/tiangz-websocket.conf.example`。不能让Nginx和TiangZ同时监听同一个端口；`port`是回环监听端口，`outerPort`是公网TLS端口。

## TLS与证书续期

公网页面和五个游戏入口都由Nginx终止TLS，TiangZ内部仍使用回环TCP/WebSocket。当前IP证书使用支持IP地址证书的Certbot 5.4或更新版本申请：

```bash
mkdir -p /var/www/letsencrypt
certbot certonly --preferred-profile shortlived --webroot \
  --webroot-path /var/www/letsencrypt --ip-address 14.103.24.32
install -m 0644 configs/deploy/tiangz-websocket.conf.example \
  /etc/nginx/snippets/tiangz-websocket.conf
```

证书只保存在`/etc/letsencrypt/live/14.103.24.32`，不得提交到Git。IP证书有效期较短，必须启用`certbot.timer`，并安装续期部署钩子，在证书更新后执行`nginx -t && systemctl reload nginx`。先保留80端口的ACME challenge，再把其他HTTP请求重定向到HTTPS。配置完成后执行`npm run verify:production-deploy`和`nginx -t`。

## 外网可观测性

10个外网Process使用JSON滚动日志，并按`1/10`向本机Tempo导出跨进程Trace。Linux单机观测部署包位于`tools/observability/production`，同时抓取10个TiangZ健康端口、两个DBProxy、宿主机、PostgreSQL和Redis。生产测试机建议至少4核、8GB内存、80GB磁盘和2GB Swap；该包将Prometheus/Loki/Tempo保留期限制为7天并为每个容器设置内存上限。

Grafana只通过本HTTPS站点的`/grafana/`访问并要求登录；`13001`、Prometheus、Alertmanager、Loki、Tempo、Alloy和Exporter全部只绑定`127.0.0.1`，不得加入公网安全组。部署、密钥和故障验收步骤见[生产测试观测栈](../../tools/observability/production/README.md)。

旧的 `external-all-in-one.json` 保留为单 Process 回归配置，不作为 2C2G 外网默认部署。

部署后可从服务器本机验证`MapManager -> dungeon_1`的创建、幂等重试和销毁闭环：

```bash
node dist/smoke_client.cjs --dynamic-map-single-host-only --map-manager-port 17100
```

该探针只访问内网`MapManager`，不会创建玩家账号，也不会修改玩家持久化数据。

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
