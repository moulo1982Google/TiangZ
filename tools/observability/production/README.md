# 生产测试观测栈

本目录用于Linux单机外网测试环境，把10个TiangZ Process、两个DBProxy、宿主机、PostgreSQL和Redis统一接入Prometheus、Alertmanager、Loki、Tempo与Grafana。它使用`network_mode: host`读取现有回环健康端口，但所有管理HTTP和OTLP端口仍显式绑定`127.0.0.1`；只有Grafana通过Nginx `/grafana/`和现有HTTPS证书对外开放。

这套部署是资源受控的单机观测闭环，不是观测系统HA：Prometheus、Loki和Tempo都使用14天本地卷；机器整体损坏时观测数据也会丢失。

## 资源基线

- 4 CPU、8GB内存、80GB系统盘、2GB Swap。
- Compose为每个服务设置内存上限；Prometheus最多保留14天或12GB，Loki与Tempo同样保留14天，使七日演练结束后仍有完整复盘窗口。
- TiangZ日志写入`/var/log/tiangz-chaos/runtime`，Alloy同时读取 TiangZ、两个DBProxy和三项演练负载的systemd journal。

## 部署

把整个`tools/observability`复制到`/opt/tiangz-observability`，然后在`production`目录创建权限为`0600`的`.env`。变量结构参考`.env.example`；PostgreSQL与Redis凭据只能从服务器现有密钥文件读取，不得写入Git。

```bash
cd /opt/tiangz-observability/production
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d
```

Grafana管理员密码必须使用强随机值。`GRAFANA_ROOT_URL`填写实际HTTPS入口并保留末尾`/grafana/`。Nginx使用`configs/deploy/cocos3d-nginx.conf.example`中的反向代理段；`13001`以及Prometheus、Loki、Tempo、Alertmanager和Exporter端口不能加入公网安全组。

`POSTGRES_EXPORTER_DSN`是Exporter自己的连接串。本机PostgreSQL未启用TLS时必须显式追加`sslmode=disable`，例如`postgresql://.../database?sslmode=disable`；这不会修改DBProxy的权威连接串。Redis Exporter可以直接复用完整的回环`redis://`连接串。

Loki以host network单进程运行时，HTTP和gRPC都只监听回环地址；`frontend.address/port`也必须显式通告`127.0.0.1:19095`。否则Query Scheduler会把Docker私有网卡地址返回给Querier，日志能够写入但查询结果无法回传。

默认`alertmanager.yml`只保留、分组和抑制告警，不向第三方发送秘密。接入Webhook时，在`alertmanager/secrets/webhook-url`写入完整URL并设置`0600`，再把`.env`中的`ALERTMANAGER_CONFIG`改为`alertmanager-webhook.yml`后重建Alertmanager。Webhook URL不能出现在Compose、日志或Git中。

## 验收

```bash
curl -fsS http://127.0.0.1:19090/-/ready
curl -fsS http://127.0.0.1:19093/-/ready
curl -fsS http://127.0.0.1:13100/ready
curl -fsS http://127.0.0.1:13200/ready
curl -fsS http://127.0.0.1:13001/api/health
curl -fsS 'http://127.0.0.1:19090/api/v1/query?query=count(up%20%3D%3D%201)'
```

两个DBProxy是对等候选，不区分固定主备。真实故障验收应先通过`tiangz_dbproxy_endpoint_request_attempts_total`确认当前流量，再停止其中一个实例至少40秒，确认Prometheus产生`TiangZDBProxyDown`、Alertmanager收到告警且真实业务切到另一Endpoint；恢复服务后还要确认Target重新Up且告警Resolved。不要通过删除数据库或数据卷制造观测故障。
