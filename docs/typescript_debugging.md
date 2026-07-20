# TypeScript 调试

## 调试模型

一个配置文件启动一个 OS Process、一个 V8 和一个 Inspector。该进程内所有 EntryScene 共用这次调试会话，因此不再为每个 Scene 分配 Inspector 端口。

## 启动

```powershell
npm run build:debug
cargo run --bin TiangZ -- configs/local/login1.debug.json
```

示例业务端口为 `17001`，Inspector 为 `127.0.0.1:9231`。`breakOnStart: true` 会在 bundle 业务代码执行前等待调试器。

VS Code 附加配置：

```json
{
  "type": "node",
  "request": "attach",
  "name": "附加 TiangZ Process",
  "address": "127.0.0.1",
  "port": 9231,
  "sourceMaps": true,
  "sourceMapPathOverrides": {
    "*": "${workspaceFolder}/TiangZ/*"
  }
}
```

连接后在 `app/**/*.ts` 设置断点。一个 all-in-one Process 中可同时调试 Login、Gate、MapHost 等 Scene。

## 安全

Inspector 默认只允许回环地址。非回环监听必须显式 `allowRemote: true`，并通过防火墙或隧道限制访问。不要在生产公网暴露 Inspector。

自动验收：

```powershell
npm run test:inspector
```
