# Luban

本目录固定收录Luban官方CLI，用于从Excel生成TiangZ游戏配置。

- 版本：`4.10.2`
- 上游提交：`332018b42be100dfc3e2bc77b7647e79851bb861`
- 上游仓库：<https://github.com/focus-creative-games/luban>
- 许可证：MIT
- 运行要求：.NET SDK/Runtime 8.0或更高版本

生成器统一通过`dotnet tools/third_party/luban/4.10.2/Luban.dll`运行。不要单独替换目录中的DLL；升级时必须整体替换、记录新版本和提交，并重新执行游戏配置生成、客户端SDK检查和Runtime冒烟。

