# cocos_client3D

这是 TiangZ 的 Cocos Creator 3.8.8 3D 导航、动态障碍和 TypeScript Client SDK 演示工程。

## 编辑器预览

用 Cocos Creator 3.8.8 打开本目录，打开 `assets/scene/main.scene` 后点击 Preview。
编辑器预览使用 `assets/resources/Config/tiangz-local.json`，只连接本机服务；发布包的
公网地址配置由构建资源单独管理，不要为了预览修改发布配置。

## Web 构建

必须在主工程 `E:\gitee\TiangZ` 根目录执行：

```powershell
# 桌面 Web Release
npm run build:cocos3d:web

# 手机横屏 Web Release
npm run build:cocos3d:mobile
```

输出分别是：

```text
build/standard-web/
build/standard-mobile/
```

Debug 构建只使用带 `:debug` 后缀的 npm 命令。统一脚本会固定 Creator 3.8.8、清除
`ELECTRON_RUN_AS_NODE`、清理自己的标准输出目录，并检查 `index.html`、`application.js`
和 `assets` 是否完整；不要手工拼接 `CocosCreator.exe --build`。

修改协议、游戏配置或 SDK 后，先在主工程执行 `npm run codegen`，再执行 Cocos 构建。
第一次迁移到新机器可先执行 `npm run check:cocos-build` 做无构建预检。Cocos Native
需要先生成原生工程，再用 CMake/Visual Studio 编译，不属于 Web 构建产物。
