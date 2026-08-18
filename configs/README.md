# 启动配置

正式部署配置按环境分目录，例如 `configs/local`、`configs/dev-a`、`configs/prod`。同一份代码可以在不同机器采用不同进程布局。测试、压测和传输实验不属于某个部署环境，分别放在独立目录，避免 Watcher 或开发人员把互斥配置误认为同一套服：

```text
configs/local/          本地 Demo 部署；详见目录内 README
configs/bench/          性能与背压配置
configs/tests/          自动化测试专用配置
configs/experiments/    io_uring、KCP 等显式实验配置
```

## 单进程配置

```json
{
  "process": {
    "name": "login1",
    "debug": {
      "inspectorIp": "127.0.0.1",
      "inspectorPort": 9231,
      "breakOnStart": true
    }
  },
  "scenes": [
    { "name": "login_1", "sceneType": "Login", "innerIp": "127.0.0.1", "port": 7001 }
  ],
  "knownScenes": [
    { "name": "gate_1", "sceneType": "Gate", "innerIp": "127.0.0.1", "port": 7201 }
  ]
}
```

- 一个文件启动一个 OS Process、一个 V8、一个 TS 业务线程。
- `scenes` 可以有多个入口 Scene，每个 Scene 可有自己的 Listener 地址。
- `knownScenes` 是路由目录，不表示目标一定在本进程。
- `debug` 放在 `process` 下；一个 V8 只需要一个 Inspector 端口。

## 云服务器外网演示

云主机的公网 EIP 可能不会出现在 `ip addr` 中。入口 Scene 应按下面的方式填写：

```json
{
  "name": "gate_1",
  "sceneType": "Gate",
  "innerIp": "192.0.2.5",
  "bindIp": "0.0.0.0",
  "outerIp": "203.0.113.10",
  "port": 7201,
  "outerPort": 7201
}
```

`innerIp`写给其他服，`bindIp`只负责监听，`outerIp/outerPort`写给客户端。前端只配置LoginMgr公网地址；LoginMgr返回Login外网地址，Login返回Gate外网地址。`knownScenes`和MapHost路由只使用`innerIp`，不要写`0.0.0.0`。

`local/all-in-one.json` 把全部 Demo Scene 放在一个进程；`local/cluster/` 是一套可整体复制的多进程部署包，由其中的 `StartMachine.json` 统一启动。`npm run test:runtime` 会验证两种部署。

`experiments/all.io-uring.json` 是 Linux TCP 实验配置。它使用 `network.ioBackend=io-uring` 和 `scene.protocol=tcp`，需要通过 `cargo build --features io-uring` 构建；Cocos WebSocket 客户端不能连接该配置。

`experiments/all.kcp-native.json` 是 Cocos Native KCP 配置。LoginMgr、Login 和 Gate 使用 `protocol=kcp,audience=outer`，MapHost 保持内部 TCP。启动命令：

```powershell
cargo run --features kcp --bin TiangZ -- configs/experiments/all.kcp-native.json
```

KCP 暂不支持 `audience=inner`。Cocos Web 不能连接此配置；Web 客户端继续使用 `local/all-in-one.json` 的 WebSocket/auto Endpoint。

## StartMachine

`StartMachine.json` 按本机 IP 选择并启动 `processes` 中列出的配置文件，作用类似 ET Watcher。压测配置没有加入默认 StartMachine，需要显式启动。

子进程默认不自动重启。只有在对应Process配置中显式填写`process.lifecycle.restart`时，Watcher才会按`maxAttempts/windowMs/backoffMs`有界拉起该进程；预算耗尽仍关闭整组。该配置不能替代业务持久化和路由接管，当前只在`local/cluster-dbproxy/map-2.json`中作为静态MapHost恢复验收启用。

Inspector 默认只能监听回环地址。只有明确设置 `allowRemote: true` 才允许远程监听，并应由防火墙限制访问。
