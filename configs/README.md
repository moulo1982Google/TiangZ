# 部署配置归游戏工程

主工程不再内置 Login、Gate、MapHost 或 Bench 的部署实例。原有配置已迁至 `../TiangZ-Examples/configs`；这里仅保留目录，满足宿主资源根约定。

新游戏请运行 `npm run project:create -- --path ../MyGame --id org.example.game`，在新工程使用自己的配置启动。MMORPG 示例在 TiangZ-Examples 运行 `npm run hello`。
