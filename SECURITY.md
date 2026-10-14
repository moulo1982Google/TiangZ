# 安全政策 / Security Policy

## 报告漏洞 / Reporting a vulnerability

请**不要**在公开 Issue 里贴漏洞细节。请用本仓库 **Security** 标签页的 **Report a vulnerability**（GitHub 私密漏洞报告）提交，只有维护者能看到。

Please do **not** open a public issue for a vulnerability. Use **Security → Report a vulnerability** (GitHub private vulnerability reporting) on this repository; only the maintainers can see it.

报告里请尽量写清：

- 影响的版本或提交；
- 复现步骤或最小示例；
- 影响范围（例如越权、崩溃、数据损坏、远程触发）；
- 你是否已经公开过细节。

## 支持的版本 / Supported versions

| 版本 | 状态 |
|---|---|
| 最新的 0.7.x 正式版（见 Releases） | 接收安全修复 |
| 更早版本、候选版（`-rc`） | 不再维护，请先升级 |

## 处理流程 / What to expect

这是一个小团队维护的项目，没有固定的响应时限承诺。我们的做法是：先确认并复现，再在私密分支里修复，随新的补丁版本发布，并在该版本的 `RELEASE-v*.md` 和 Release 页面说明修复内容。依赖漏洞由 CI 里的 `npm audit` 与 `cargo audit` 持续检查，没有为通过检查而放宽的公告清单（例外都登记在 `security/dependency-exceptions.json`，并写明原因）。
