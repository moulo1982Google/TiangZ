# PixiJS/H5 客户端

这个工程用于验证 TiangZ TypeScript Client SDK 不依赖 Cocos。它与 Cocos 客户端消费同一份 SDK、同一份协议指纹和同一套强类型 RPC Client。

## 启动

先在项目根目录启动服务器：

```powershell
npm run build
cargo run --bin TiangZ -- configs/local/all-in-one.json
```

再构建并启动 Pixi 客户端：

```powershell
npm run build:pixi
npm run serve:pixi
```

浏览器打开 `http://127.0.0.1:7460`，点击“进入游戏”。进入地图后使用 `WASD` 或方向键移动。

## 目录

```text
src/Generated/SDK/       公共 SDK 的生成副本，禁止手工修改
src/Generated/Hotfix/    客户端 Push Handler 自动导入入口
src/Map/Handlers/        Pixi 表现层的 Push Handler
src/Map/                 地图表现、输入和实体视图
```

修改协议或公共 SDK 后只执行根目录的 `npm run codegen`，不要在本目录复制代码。Windows 上可在后端和静态服务器运行时执行 `npm run smoke:pixi`，它会用 Edge 自动登录并确认 HUD 与 canvas 已进入地图状态。
