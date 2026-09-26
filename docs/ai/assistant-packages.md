# Codex、Claude 与 Cindy 技能交付

## 唯一维护入口

2026-09-17 起，版本化源码放在本仓库 `tools/ai-assistants/`：

- `skill/SKILL.md`：Codex 与 Claude 共用的技能源，不依赖 Cindy 或本机 MCP 命令。
- `docs/ai/skill-development-contract.md`：开发约束的权威文档，生成器附带为技能参考，改写相对链接以避免搬机器后断链。
- `cindy/main.js`、`cindy/ghost.json`：Cindy 只读设计工具源码；规则目录按上述契约维护，保留原有领域建议工具。规则变化需同时复核工具目录，不以 AI 文案替代 CLI/编译检查。
- `build.mjs`：生成便携目录，可选同步当前上层工作区技能。
- `check.mjs`：检查技能结构、随包约束、四个 Cindy 工具、六类建议、规则 ID 与权限边界。

分发产物仓库是同级的 `TiangZ-AI-Plugins`（远程仓库，需保持最新）：`build.mjs` 生成 dist 后，把 Codex 技能、Claude 技能、Cindy 源码同步过去，并重打 `tiangz-game-backend-cindy/tiangz-game-backend-<版本>.cindy`，否则分发包里仍是旧内容。旧上层 `plugins/tiangz-game-backend*` 已作废，不再维护、不要从那里打包或安装。主工程 dist 为生成物，不提交；源码和本文需要随仓库保存。

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

模块实时检查轮已同步受信任工作区、已保存 Host 声明、未保存 TS overlay 与明确不可用边界；不把实时检查当成生成锁/完整 build。Cindy 仍为 40 条规则、清单 0.2.0。本轮实际归档 SHA256 `e946e577af1c9ca80989009fdbfc880ee6bc8cf8417ec51c8a4384f08a5155c8`；CRC、7 文件清单哈希、与生成输入逐字节一致、提取后四工具/六建议及两个技能校验均通过。证据为 `temp/v0.7-ai-live-{build,check,distribute,distribution-check,artifact-check}.log` 和 `temp/v0.7-ai-live-artifact-identity.json`。工作区已装技能与客户端安装状态没有改变。

0.7 开发 worktree 更新（AI 清单仍为 0.2.0，发行号独立冻结）：技能/随包契约补入操作预算、在途回调、可选逻辑目录与独立版本身份；G2/G3 轮继续补充共享 Program 检查、模块部署、资源预算范围及只读容量/消费幂等。Cindy 环境工具停止把旧 0.6.0/main 作为当前版本；返回 `versionStatus: not-probed`、空工作版本和应核对的清单。四个只读工具与六类领域建议保持，当前规则为 40 条。

G2/G3 轮已实际生成和分发至 AI Plugins 0.7 worktree，7 个受清单记录文件 SHA256、Cindy 归档 CRC 和归档内容与源码一致性通过。提取实际归档后四工具/六建议检查通过，Codex/Claude 两个技能经独立 venv quick_validate 通过；日志 `temp/v0.7-ai-g2-{build,check,distribute,distribution-check,artifact-check}.log`，身份 `temp/v0.7-ai-g2-artifact-identity.json`。没有改工作区已装技能、Forge 或客户端安装状态。

分发须显式指定目标 worktree，避免把开发分支内容写回原仓库：

```powershell
node tools/ai-assistants/build.mjs
node tools/ai-assistants/check.mjs
python tools/ai-assistants/distribute.py --repository ../TiangZ-AI-Plugins-0.7
python tools/ai-assistants/distribute.py --repository ../TiangZ-AI-Plugins-0.7 --check
```

分发脚本在写入前核对两个插件清单与 Cindy 版本，保存 SHA256 身份清单，并按既有归档结构生成确定性 `.cindy`（根目录 ghost.json/main.js）。当前环境没有 Cindy Forge 工具：已从实际归档提取内容，用 `check.mjs --root <提取夹具>` 执行四个工具与六类建议，并校验 CRC/逐文件哈希；这是本地制品验证，不能冒充 Forge 校验、客户端安装或新会话效果。已有插件清单、MCP 配置、工作区技能与用户插件缓存没有自动覆盖。

技能 quick_validate 已在独立临时 venv 通过。当前 python 来自 MSYS2 UCRT，venv 的解释器在 bin 下；不是通常的 Scripts 路径。该环境缺少 PyYAML，默认 C 扩展构建失败，设置进程级 `PYYAML_FORCE_LIBYAML=0` 安装纯 Python 依赖后通过，不改整机 Python/编译器。原失败与依赖记录保留在 `temp/v0.7-skill-validation-*`，后续先查询解释器和 venv 布局再运行，不能据路径差异宣称 Python 未安装。

0.2.0：便携生成、一致性检查、规则 ID 唯一性、四个工具/六类建议的沙箱接口测试通过。Cindy Forge 返回 `action: updated`，启用状态保留；安装后真实调用 list_design_rules 返回 32 条规则，包含时间禁令、C/S协议、DB故障不降级、原事务重试和原子热更。

没有触碰游戏运行进程、数据库或三类联合故障测试。技能结构检查不是模型行为完全正确的证明；换客户端后仍需一次实际调用确认。
