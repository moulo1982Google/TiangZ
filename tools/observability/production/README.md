# 生产测试观测栈

本目录用于Linux单机外网测试环境，把10个TiangZ Process、两个DBProxy、宿主机、PostgreSQL和Redis统一接入Prometheus、Alertmanager、Loki、Tempo与Grafana。它使用`network_mode: host`读取现有回环健康端口，但所有管理HTTP和OTLP端口仍显式绑定`127.0.0.1`；只有Grafana通过Nginx `/grafana/`和现有HTTPS证书对外开放。

这套部署是资源受控的单机观测闭环，不是观测系统HA：Prometheus、Loki和Tempo都使用7天本地卷；机器整体损坏时观测数据也会丢失。

## 资源基线

- 4 CPU、8GB内存、80GB系统盘、2GB Swap。
- Compose为每个服务设置内存上限，Prometheus最多保留7天或12GB。
- TiangZ日志写入`/opt/tiangz-external/logs`，Alloy同时读取两个DBProxy的systemd journal。

## 部署

把整个`tools/observability`复制到`/opt/tiangz-observability`，然后在`production`目录创建权限为`0600`的`.env`。变量结构参考`.env.example`；PostgreSQL与Redis凭据只能从服务器现有密钥文件读取，不得写入Git。

```bash
cd /opt/tiangz-observability/production
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d
```

Grafana管理员密码必须使用强随机值。`GRAFANA_ROOT_URL`填写实际HTTPS入口并保留末尾`/grafana/`。Nginx使用`configs/deploy/cocos3d-nginx.conf.example`中的反向代理段；`13001`以及Prometheus、Loki、Tempo、Alertmanager和Exporter端口不能加入公网安全组。

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

真实故障验收优先停止备用`tiangz-dbproxy@2.service`至少40秒，确认Prometheus产生`TiangZDBProxyDown`、Alertmanager收到告警且游戏继续通过DBProxy 1工作，再恢复服务并确认告警Resolved。不要通过删除数据库或数据卷制造观测故障。
