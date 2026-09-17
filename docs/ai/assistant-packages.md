# Codex、Claude 与 Cindy 技能交付

## 唯一维护入口

2026-09-17 起，版本化源码放在本仓库 `tools/ai-assistants/`：

- `skill/SKILL.md`：Codex 与 Claude 共用的技能源，不依赖 Cindy 或本机 MCP 命令。
- `docs/ai/skill-development-contract.md`：开发约束的权威文档，生成器附带为技能参考，改写相对链接以避免搬机器后断链。
- `cindy/main.js`、`cindy/ghost.json`：Cindy 只读设计工具源码；规则目录按上述契约维护，保留原有领域建议工具。规则变化需同时复核工具目录，不以 AI 文案替代 CLI/编译检查。
- `build.mjs`：生成便携目录，可选同步当前上层工作区技能。
- `check.mjs`：检查技能结构、随包约束、四个 Cindy 工具、六类建议、规则 ID 与权限边界。

旧上层 `plugins/tiangz-game-backend*` 是历史副本，本次没有删除它们，后续不要从那里重新打旧包。主工程 dist 为生成物，不提交；源码和本文需要随仓库保存。

## 生成与检查

在 TiangZ 主工程执行（Node.js 24.x）：

```powershell
node tools/ai-assistants/build.mjs
node tools/ai-assistants/check.mjs
node tools/ai-assistants/build.mjs --check
```

输出在 `dist/ai-assistants/`：codex、claude 两个技能目录及 cindy 插件源码。打包技能：

```powershell
Compress-Archive -LiteralPath dist/ai-assistants/codex/tiangz-game-backend -DestinationPath dist/ai-assistants/tiangz-game-backend-codex-0.2.0.zip -Force
Compress-Archive -LiteralPath dist/ai-assistants/claude/tiangz-game-backend -DestinationPath dist/ai-assistants/tiangz-game-backend-claude-0.2.0.zip -Force
```

`--workspace` 额外更新主工程上一级的 `.agents/skills/tiangz-game-backend` 和 `.claude/skills/tiangz-game-backend`。只在这个上级目录确实是目标工作区时使用；命令会覆盖该技能生成文件，先审查本地修改。当前 Claude 是指向 `.agents` 的 junction，生成器保留它；指向其他目录的 junction 拒绝写入，不删除任何已有链接。它不安装全局技能或操作 Marketplace。

## 换机器使用

- Codex：将 codex 包内 `tiangz-game-backend` 目录放到目标项目 `.agents/skills/`。打开新会话，明确调用 `$tiangz-game-backend` 做一次只读代码审查，检查是否读到随包约束。
- Claude Code：将 claude 包内同名目录放到目标项目 `.claude/skills/`。打开新会话，用 `/tiangz-game-backend` 调用。不依赖 Windows junction，整个目录（含 references）一起复制。
- Cindy：在具备 Forge 的会话中，明确要求打包或更新 `dist/ai-assistants/cindy`。只打包用 ghost_forge_pack；已授权安装/更新时使用 ghost_forge_install。它会校验、生成 `.cindy` 并原位更新同 id 插件，之后 ghost_info 与 list_design_rules 检查真实安装结果。不要直接写 Host 插件缓存目录。

独立技能即可满足本轮 Codex/Claude 使用需求，没有建立新的 Marketplace 或自动安装旧 Codex MCP 插件；本机未发现 Codex/Claude CLI，未启动独立客户端会话验证。当前工作区技能已经同步，不等于其他 IDE 的旧插件缓存已更新。新线程再试，避免旧上下文残留。

格式参考：[Codex Skills 官方入口](https://developers.openai.com/codex/skills)、[Claude Code Skills](https://code.claude.com/docs/en/skills)。Cindy 以当前宿主 ghost_forge_guide 为准；没有新增已停用的 skill.items，也没有猜测 Manual 首发版本号。

## 当前验证记录

0.2.0：便携生成、一致性检查、规则 ID 唯一性、四个工具/六类建议的沙箱接口测试通过。Cindy Forge 返回 `action: updated`，启用状态保留；安装后真实调用 list_design_rules 返回 32 条规则，包含时间禁令、C/S协议、DB故障不降级、原事务重试和原子热更。

没有触碰游戏运行进程、数据库或三类联合故障测试。技能结构检查不是模型行为完全正确的证明；换客户端后仍需一次实际调用确认。
