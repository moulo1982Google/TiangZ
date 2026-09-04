# TiangZ 外置游戏模块

每个直接子目录是一个独立模块，并必须包含 `tiangz.module.json`。模块可以是普通目录，也可以是指向独立仓库工作区的目录链接；第三方模块默认不进入 TiangZ 主仓库。

模块在构建期发现并合入同一 Model/Hotfix 双 Bundle：增删模块、修改 manifest 或 Model 必须完整构建并重启 Process；只修改已有 Hotfix 行为时仍可使用 TiangZ 的事务热更。模块不能携带自动执行的 Shell、SQL 或安装脚本。

每个模块必须有独立`tsconfig.json`。设置`TIANGZ_MODULES_DIR`后，构建、目录命令和`npm run dev`会使用同一模块集合；开发宿主同时监听模块Hotfix源码。现有Entity的模块Component通过强类型`entityExtensionHandler/applyEntityExtensions`装配，不能用无类型全局Hook绕过Factory和生命周期。

可以使用 `npm run modules:create -- --id org.example.game --path modules/example-game` 生成不会覆盖现有目录的最小骨架。

完整契约见 [外置游戏模块设计](../docs/design/external-game-modules.md)。
