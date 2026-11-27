# Luban

本目录固定收录Luban官方CLI，用于从Excel生成TiangZ游戏配置。

- 版本：`4.10.2`
- 上游提交：`332018b42be100dfc3e2bc77b7647e79851bb861`
- 上游仓库：<https://github.com/focus-creative-games/luban>
- 许可证：MIT
- 运行要求：.NET SDK/Runtime 8.0或更高版本

生成器统一通过`dotnet tools/third_party/luban/4.10.2/Luban.dll`运行。不要单独替换目录中的DLL；升级时必须整体替换、记录新版本和提交，并重新执行游戏配置生成、客户端SDK检查和Runtime冒烟。


## 去注释模板与输出上限

Luban 4.10.2 自带的 Scriban 7 对单个模板的渲染结果有 `TemplateContext.LimitToString` 上限（默认 1,048,576 字符，Luban 没有覆盖）。`typescript-json` 目标把全部枚举、结构和表写进一个 `schema.ts`，渲染结果超过上限时会被静默截成前 1,048,576 字符再接 `...`，而 Luban 仍以 0 退出。

- `server-templates/typescript-json/schema.sbn` 由 4.10.2 官方 `Templates/typescript-json/schema.sbn` 删除全部 `comment` 注释块得到，其余逐字相同（MIT 许可同上）。`tools/codegen_module_game_config.mjs` 给服务端与客户端目标都传 `--customTemplateDir server-templates`（0.7.10 只给服务端，0.7.11 起客户端也用；目录名为兼容下游脚本保留不改），两端生成物都不带注释块，字段含义以表格定义为准。
- 生成器在发布前检查每个 `schema.ts`：以 `...` 结尾或 TypeScript 语法诊断不为零即失败，不覆盖已有产物；长度达到上限的 90% 时在标准错误输出告警并给出剩余字符数。
- 升级 Luban 时，用新版官方模板重新删除注释块生成这份副本，并重新执行 `node tools/module_game_config_limit_self_test.mjs`；若新版本已解除或改变上限，同步修改生成器里的上限常量与本说明。
