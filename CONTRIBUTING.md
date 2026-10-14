# 参与贡献 / Contributing

感谢你愿意改进 TiangZ。这份文件只讲提交改动前最需要知道的事，细则在 [AGENTS.md](AGENTS.md) 和 [docs/](docs/README.md)。

## 先谈再写

- 小修复（错别字、明显的缺陷、补测试）可以直接提 PR。
- 新功能、改协议、改 Stable API、改框架边界：请先开 Issue 说明动机和方案，再动手。TiangZ 的原则是 Core 不放具体游戏的规则，具体玩法放在外置模块里（见[能力归属](docs/design/capability-ownership.md)与[外置游戏模块](docs/design/external-game-modules.md)）。

## 本地准备

```powershell
npm ci
npm run verify:quick
```

`verify:quick` 是提交前的最低检查。它会用到本机构建的宿主（`TiangZ.exe`），首次构建需要 Rust 工具链，步骤见 [README](README.md)。涉及某个子系统的改动，请再跑对应的 `test:*` 脚本（脚本清单见 [docs/reference/commands.md](docs/reference/commands.md)）。

## 提交规则

- 一个 PR 做一件事，说明里写清动机、做了什么、怎么验证的、哪些没有验证。
- 不要手改生成代码和协议锁；改了协议、配置或脚手架后，重新运行对应的 `codegen` 命令并提交结果。
- 新增或改动的代码注释要中英双语，`npm run verify:comments` 会检查。
- 文件里不得出现本机绝对路径、内网地址等个人痕迹，`npm run verify:no-local-traces` 会检查。
- 行为变化要同步更新文档，用户可见的变化写进 [CHANGELOG.md](CHANGELOG.md)。
- 新增依赖要说明理由；依赖策略检查是 `npm run verify:dependency-policy`。
- 不要提交 `target/`、`node_modules/` 等构建产物。

## 评审与合并

`main` 受保护：合并需要至少一位维护者批准，并且 `framework (ubuntu-latest)` 与 `framework (windows-latest)` 两项检查通过。评审出的问题请直接在 PR 里改，不要另开新 PR。

## 报告问题

- 缺陷和功能建议：用 Issue 模板。
- 安全问题：不要开公开 Issue，见 [SECURITY.md](SECURITY.md)。

参与本项目即表示你同意遵守[行为准则](CODE_OF_CONDUCT.md)，并同意你的贡献按本仓库的 [Apache-2.0 许可证](LICENSE)授权。
