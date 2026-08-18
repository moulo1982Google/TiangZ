# TypeScript 调试

## 调试模型

一个配置文件启动一个 OS Process、一个 V8 和一个 Inspector。该进程内所有 EntryScene 共用这次调试会话，因此不再为每个 Scene 分配 Inspector 端口。

## 启动

```powershell
npm run build:debug
cargo run --bin TiangZ -- configs/local/debug/login-1.json
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

## 调试期间热重载

```powershell
npm run dev:debug
```

该入口通过`configs/local/debug/StartMachine.json`启动all-in-one Watcher。初始Bundle和保存后生成的每个Hotfix候选都包含内联sourcemap与源码内容，因此Process、V8和Inspector连接不重启时，VS Code仍会把原TS断点绑定到新脚本。当前已经进入调用栈的方法继续执行旧实现，新调用才使用新generation；若调试器正暂停，先Resume让Reload屏障得到执行机会。

Model字段、Core、Proto、`.native`和System公开签名变化仍必须完整构建并重启，不能通过这个入口热更。

## 安全

Inspector 默认只允许回环地址。非回环监听必须显式 `allowRemote: true`，并通过防火墙或隧道限制访问。不要在生产公网暴露 Inspector。

自动验收：

```powershell
npm run test:inspector
npm run test:hotfix-operations
```
