# 启动配置

配置按环境分目录，例如 `configs/local`、`configs/dev-a`、`configs/prod`。同一份代码可以在不同机器采用不同进程布局。

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
    { "name": "login_1", "sceneType": "Login", "ip": "127.0.0.1", "port": 7001 }
  ],
  "knownScenes": [
    { "name": "log", "sceneType": "Log", "ip": "127.0.0.1", "port": 7100 },
    { "name": "gate_1", "sceneType": "Gate", "ip": "127.0.0.1", "port": 7201 }
  ]
}
```

- 一个文件启动一个 OS Process、一个 V8、一个 TS 业务线程。
- `scenes` 可以有多个入口 Scene，每个 Scene 可有自己的 Listener 地址。
- `knownScenes` 是路由目录，不表示目标一定在本进程。
- `debug` 放在 `process` 下；一个 V8 只需要一个 Inspector 端口。

`all.json` 把全部 Demo Scene 放在一个进程；`log.json`、`mgr.json`、`login1.json` 等把它们拆成多个进程。`npm run test:runtime` 会验证两种部署。

## StartMachine

`StartMachine.json` 按本机 IP 选择并启动 `processes` 中列出的配置文件，作用类似 ET Watcher。压测配置没有加入默认 StartMachine，需要显式启动。

Inspector 默认只能监听回环地址。只有明确设置 `allowRemote: true` 才允许远程监听，并应由防火墙限制访问。
